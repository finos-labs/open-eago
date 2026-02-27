mod models;

use models::{
    AddressInfo, AgentDetails, AppState, Args, BootstrapUrls, Config,
    HealthResponse, ListResponse, RegisterRequest, RegisterResponse, Registry, SpireConfig, Timestamp,
    UpdateStatusRequest, UpdateStatusResponse,
};
use actix_web::{get, post, put, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use clap::Parser;
use openssl::ssl::{SslAcceptor, SslMethod, SslFiletype, SslVerifyMode};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tracing::{debug, error, info, warn, instrument};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use utoipa::OpenApi;
use utoipa::openapi::server::Server;
use utoipa_swagger_ui::SwaggerUi;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const DEFAULT_LOCAL_IP: &str = "127.0.0.1";

// Input validation limits
const MAX_BOOTSTRAP_URLS: usize = 32;
const MAX_REGISTRY_ENTRIES: usize = 10_000;
const MAX_TAGS_COUNT: usize = 50;
const MAX_LIST_FIELD_LEN: usize = 100; // capability_codes, compliance, dependencies
const MAX_STRING_VALUE_LEN: usize = 512; // per string in tags / version / etc.
const ALLOWED_BOOTSTRAP_SCHEMES: &[&str] = &["http", "https"];

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, description = "Service is healthy", body = HealthResponse)),
    tag = "Health"
)]
#[get("/health")]
async fn health() -> impl Responder {
    HttpResponse::Ok().json(HealthResponse { status: "ok" })
}

#[utoipa::path(
    post,
    path = "/register",
    request_body = RegisterRequest,
    responses(
        (status = 200, description = "Successfully registered", body = RegisterResponse),
        (status = 403, description = "Not a bootstrap server")
    ),
    tag = "Registry"
)]
#[post("/register")]
#[instrument(skip(data))]
async fn register(data: web::Data<AppState>, req: web::Json<RegisterRequest>) -> impl Responder {
    if !data.is_bootstrap {
        return HttpResponse::Forbidden().json(serde_json::json!({ "error": "Not a bootstrap server" }));
    }

    if let Some(err_resp) = validate_register_request(&req) {
        return err_resp;
    }

    let agent_details = req.agent_details.clone()
        .unwrap_or_else(AgentDetails::now);

    let update = update_registry(&data.registry, &req.address, agent_details);
    if update == RegistryUpdate::CapExceeded {
        return HttpResponse::TooManyRequests()
            .json(serde_json::json!({"error": format!("registry is full (max {} entries)", MAX_REGISTRY_ENTRIES)}));
    }
    learn_bootstrap_urls(&data.bootstrap_urls, &req.known_bootstrap_urls);

    info!("{} address: {}", if update == RegistryUpdate::New { "New" } else { "Updated" }, req.address);

    HttpResponse::Ok().json(RegisterResponse {
        success: true,
        message: format!("Address {}", if update == RegistryUpdate::New { "registered" } else { "updated" }),
        known_addresses: {
            let reg = data.registry.lock().unwrap();
            let current_ts = AppState::current_timestamp();
            reg.iter()
                .map(|(addr, details)| AddressInfo {
                    address: addr.clone(),
                    last_seen_seconds: current_ts.saturating_sub(details.last_seen),
                    details: details.clone(),
                })
                .collect()
        },
        bootstrap_urls: data.bootstrap_urls.lock().unwrap().iter().cloned().collect(),
    })
}

#[derive(PartialEq)]
enum RegistryUpdate { New, Updated, CapExceeded }

fn update_registry(registry: &Registry, address: &str, mut agent_details: AgentDetails) -> RegistryUpdate {
    let mut reg = registry.lock().unwrap();
    let is_new = !reg.contains_key(address);

    // Atomic cap check: both the check and insert happen under the same lock,
    // eliminating the TOCTOU race that existed when they used separate acquisitions.
    if is_new && reg.len() >= MAX_REGISTRY_ENTRIES {
        return RegistryUpdate::CapExceeded;
    }

    // Preserve fields that can only be updated via PUT /status endpoint
    if let Some(existing_details) = reg.get(address) {
        agent_details.reliability = existing_details.reliability;
        agent_details.health_status = existing_details.health_status.clone();
        agent_details.uptime_percentage = existing_details.uptime_percentage;
        // Always preserve registration_time once it's set (only /status can update it)
        if existing_details.registration_time.is_some() {
            agent_details.registration_time = existing_details.registration_time;
        }
    }

    agent_details.last_seen = AppState::current_timestamp();
    reg.insert(address.to_string(), agent_details);
    if is_new { RegistryUpdate::New } else { RegistryUpdate::Updated }
}

fn learn_bootstrap_urls(bootstrap_urls: &BootstrapUrls, new_urls: &Option<Vec<String>>) {
    if let Some(urls) = new_urls {
        let mut bs_urls = bootstrap_urls.lock().unwrap();
        let count_before = bs_urls.len();
        for url_str in urls {
            if bs_urls.len() >= MAX_BOOTSTRAP_URLS {
                warn!("Bootstrap URL set at capacity ({}), dropping remaining URLs", MAX_BOOTSTRAP_URLS);
                break;
            }
            match url::Url::parse(url_str) {
                Ok(parsed) if ALLOWED_BOOTSTRAP_SCHEMES.contains(&parsed.scheme())
                    && parsed.host().is_some() =>
                {
                    bs_urls.insert(url_str.clone());
                }
                _ => warn!("Rejected invalid or non-http(s) bootstrap URL: {}", url_str),
            }
        }
        let added = bs_urls.len() - count_before;
        if added > 0 {
            info!("Learned {} new bootstrap URLs", added);
        }
    }
}

fn validate_register_request(req: &RegisterRequest) -> Option<HttpResponse> {
    if req.address.len() > 64 {
        return Some(HttpResponse::BadRequest()
            .json(serde_json::json!({"error": "address exceeds maximum length"})));
    }
    // Accept either a numeric IP:PORT socket address or a hostname:port.
    // Split on the last ':' so IPv6 addresses like [::1]:9001 work too.
    if !is_valid_host_port(&req.address) {
        return Some(HttpResponse::BadRequest()
            .json(serde_json::json!({"error": "address must be a valid host:port (e.g. 192.168.1.1:9001 or myhost.example.com:9001)"})));
    }
    if let Some(ref urls) = req.known_bootstrap_urls {
        if urls.len() > MAX_BOOTSTRAP_URLS {
            return Some(HttpResponse::BadRequest()
                .json(serde_json::json!({"error": format!("too many bootstrap URLs (max {})", MAX_BOOTSTRAP_URLS)})));
        }
    }
    if let Some(ref details) = req.agent_details {
        // List field element count limits
        if details.capability_codes.len() > MAX_LIST_FIELD_LEN
            || details.compliance.len() > MAX_LIST_FIELD_LEN
            || details.dependencies.len() > MAX_LIST_FIELD_LEN
        {
            return Some(HttpResponse::BadRequest()
                .json(serde_json::json!({"error": format!("list field exceeds maximum length (max {})", MAX_LIST_FIELD_LEN)})));
        }
        // Per-element length in list fields
        for s in details.capability_codes.iter()
            .chain(&details.compliance)
            .chain(&details.dependencies)
        {
            if s.len() > MAX_STRING_VALUE_LEN {
                return Some(HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": "list element exceeds maximum length"})));
            }
        }
        // Tag count and per-key/value limits
        if details.tags.len() > MAX_TAGS_COUNT {
            return Some(HttpResponse::BadRequest()
                .json(serde_json::json!({"error": format!("too many tags (max {})", MAX_TAGS_COUNT)})));
        }
        for (k, v) in &details.tags {
            if k.len() > MAX_STRING_VALUE_LEN || v.len() > MAX_STRING_VALUE_LEN {
                return Some(HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": "tag key or value exceeds maximum length"})));
            }
        }
        // Scalar string field lengths
        for opt in [
            &details.version, &details.instance_id, &details.jurisdiction,
            &details.data_center, &details.timestamp,
            &details.endpoints.http, &details.endpoints.https,
            &details.endpoints.grpc, &details.endpoints.websocket,
        ] {
            if opt.as_deref().is_some_and(|s| s.len() > MAX_STRING_VALUE_LEN) {
                return Some(HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": "string field exceeds maximum length"})));
            }
        }
        // Custom endpoint map limits
        if details.endpoints.custom.len() > MAX_TAGS_COUNT {
            return Some(HttpResponse::BadRequest()
                .json(serde_json::json!({"error": format!("too many custom endpoints (max {})", MAX_TAGS_COUNT)})));
        }
        for (k, v) in &details.endpoints.custom {
            if k.len() > MAX_STRING_VALUE_LEN || v.len() > MAX_STRING_VALUE_LEN {
                return Some(HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": "custom endpoint key or value exceeds maximum length"})));
            }
        }
        // Geographic coordinate range validation
        if let Some(ref geo) = details.geographic_location {
            if !(-90.0..=90.0).contains(&geo.latitude) || !(-180.0..=180.0).contains(&geo.longitude) {
                return Some(HttpResponse::BadRequest()
                    .json(serde_json::json!({"error": "latitude must be in [-90,90] and longitude in [-180,180]"})));
            }
        }
    }
    None
}

/// Return true if `addr` is a valid `host:port` or `[IPv6]:port` string with a non-zero port.
/// Accepts numeric IPs, bracketed IPv6, and DNS hostnames (does not resolve, only validates form).
fn is_valid_host_port(addr: &str) -> bool {
    // Fast path: parses directly as a SocketAddr (numeric IP:port)
    if addr.parse::<std::net::SocketAddr>().is_ok() {
        return true;
    }
    // General path: split on the last ':' to separate host and port
    if let Some((host, port_str)) = addr.rsplit_once(':') {
        let host = host.trim_start_matches('[').trim_end_matches(']');
        if host.is_empty() {
            return false;
        }
        if let Ok(port) = port_str.parse::<u16>() {
            // Port 0 is reserved and not usable for registry entries
            return port > 0;
        }
    }
    false
}

#[utoipa::path(
    get,
    path = "/list",
    responses((status = 200, description = "List all registered addresses", body = ListResponse)),
    tag = "Registry"
)]
#[get("/list")]
#[instrument(skip(data))]
async fn list(data: web::Data<AppState>) -> impl Responder {
    let current_ts = AppState::current_timestamp();
    let addresses = cleanup_and_build_list(&data.registry, &data.local_address, current_ts, data.is_bootstrap);
    let bootstrap_urls = data.is_bootstrap
        .then(|| data.bootstrap_urls.lock().unwrap().iter().cloned().collect());

    HttpResponse::Ok().json(ListResponse {
        count: addresses.len(),
        addresses,
        bootstrap_urls,
    })
}

fn cleanup_and_build_list(
    registry: &Registry,
    local_address: &str,
    current_ts: Timestamp,
    is_bootstrap: bool,
) -> Vec<AddressInfo> {
    // Pure read — stale entries are evicted by the background task, not here.
    let reg = registry.lock().unwrap();
    reg.iter()
        .filter(|(addr, _)| !is_bootstrap || *addr != local_address)
        .map(|(addr, details)| AddressInfo {
            address: addr.clone(),
            last_seen_seconds: if addr == local_address { 0 } else { current_ts.saturating_sub(details.last_seen) },
            details: details.clone(),
        })
        .collect()
}

/// Remove registry entries whose `last_seen` timestamp is older than `max_ttl` seconds.
/// The local address is always retained regardless of TTL.
fn evict_stale_entries(
    registry: &Registry,
    local_address: &str,
    current_ts: Timestamp,
    max_ttl: u64,
) {
    let mut reg = registry.lock().unwrap();
    let before = reg.len();
    reg.retain(|addr, details| addr == local_address || current_ts.saturating_sub(details.last_seen) <= max_ttl);
    let evicted = before.saturating_sub(reg.len());
    if evicted > 0 {
        info!("Evicted {} stale registry entries (TTL={}s)", evicted, max_ttl);
    }
}

/// Returns Ok if the HTTP caller's peer IP matches the IP portion of `address`.
/// Accepts both numeric IPs and hostnames; hostnames are resolved asynchronously
/// via `tokio::net::lookup_host` so that `localhost:9001` works alongside
/// `127.0.0.1:9001` without blocking a Tokio worker thread.
/// Allows loopback-to-loopback (127.x / ::1) so local testing works without special-casing.
async fn verify_caller_owns_address(http_req: &HttpRequest, address: &str) -> std::result::Result<(), String> {
    use std::net::IpAddr;

    let peer_ip: IpAddr = http_req
        .peer_addr()
        .ok_or("Cannot determine peer address")?
        .ip();

    // Strip port: take everything before the last ':'
    let addr_host = address
        .rsplit_once(':')
        .map(|(host, _)| host)
        .unwrap_or(address);

    // Handle bracketed IPv6 addresses like [::1]
    let addr_host = addr_host
        .trim_start_matches('[')
        .trim_end_matches(']');

    // Try numeric IP first; fall back to async DNS resolution for hostnames.
    // Using tokio::net::lookup_host avoids blocking a Tokio worker thread during
    // DNS resolution, which std::net::ToSocketAddrs would do.
    let registered_ips: Vec<IpAddr> = if let Ok(ip) = addr_host.parse::<IpAddr>() {
        vec![ip]
    } else {
        // Resolve hostname → collect all returned IP addresses.
        // lookup_host requires host:port form; use port 0 as a placeholder.
        tokio::net::lookup_host(format!("{}:0", addr_host))
            .await
            .map_err(|e| format!("Cannot resolve hostname '{}': {}", addr_host, e))?
            .map(|sa| sa.ip())
            .collect()
    };

    if registered_ips.is_empty() {
        return Err(format!("'{}' resolved to no addresses", addr_host));
    }

    // Both loopback → allow (same-machine agents and local testing)
    if peer_ip.is_loopback() && registered_ips.iter().all(|ip| ip.is_loopback()) {
        return Ok(());
    }

    if registered_ips.contains(&peer_ip) {
        Ok(())
    } else {
        Err(format!("peer IP {} does not match registered address '{}' (resolved: {:?})", peer_ip, addr_host, registered_ips))
    }
}

#[utoipa::path(
    put,
    path = "/status",
    request_body = UpdateStatusRequest,
    responses(
        (status = 200, description = "Agent status updated successfully", body = UpdateStatusResponse),
        (status = 403, description = "Caller IP does not match the registered address"),
        (status = 404, description = "Address not found"),
        (status = 400, description = "Invalid field value")
    ),
    tag = "Registry"
)]
#[put("/status")]
#[instrument(skip(data, http_req))]
async fn update_status(
    data: web::Data<AppState>,
    http_req: HttpRequest,
    req: web::Json<UpdateStatusRequest>,
) -> impl Responder {
    // Only the agent whose peer IP matches req.address may update its own entry.
    if let Err(e) = verify_caller_owns_address(&http_req, &req.address).await {
        warn!("Ownership check failed for {}: {}", req.address, e);
        return HttpResponse::Forbidden()
            .json(serde_json::json!({"error": format!("Forbidden: {}", e)}));
    }
    if let Some(reliability) = req.reliability {
        if !(0.0..=1.0).contains(&reliability) {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": "Reliability must be between 0.0 and 1.0"
            }));
        }
    }
    if let Some(uptime) = req.uptime_percentage {
        if !(0.0..=100.0).contains(&uptime) {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": "Uptime percentage must be between 0.0 and 100.0"
            }));
        }
    }

    let mut registry = data.registry.lock().unwrap();
    if let Some(agent_details) = registry.get_mut(&req.address) {
        let mut updates = Vec::new();
        
        if let Some(reliability) = req.reliability {
            agent_details.reliability = Some(reliability);
            updates.push(format!("reliability: {}", reliability));
        }
        
        if let Some(ref health_status) = req.health_status {
            agent_details.health_status = health_status.clone();
            updates.push(format!("health_status: {:?}", health_status));
        }
        
        if let Some(uptime_percentage) = req.uptime_percentage {
            agent_details.uptime_percentage = Some(uptime_percentage);
            updates.push(format!("uptime_percentage: {}%", uptime_percentage));
        }
        // registration_time is intentionally not updatable via this endpoint:
        // it is an immutable record of when the agent first registered.

        // Renew TTL: an agent signalling liveness via PUT /status should not get
        // evicted while it is actively reporting. Update last_seen regardless of
        // whether any status fields changed.
        agent_details.last_seen = AppState::current_timestamp();
        
        let message = if updates.is_empty() {
            "No fields updated".to_string()
        } else {
            format!("Updated: {}", updates.join(", "))
        };
        
        info!("Updated status for {}: {}", req.address, message);
        
        // Read back the stored values so the response reflects the authoritative post-update state,
        // not just the request fields (some fields may have been preserved from existing data).
        HttpResponse::Ok().json(UpdateStatusResponse {
            success: true,
            message,
            address: req.address.clone(),
            reliability: agent_details.reliability,
            health_status: Some(agent_details.health_status.clone()),
            registration_time: agent_details.registration_time, // read-back only; not writable via this endpoint
            uptime_percentage: agent_details.uptime_percentage,
        })
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Address {} not found in registry", req.address)
        }))
    }
}

fn get_local_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| DEFAULT_LOCAL_IP.to_string())
}

async fn register_with_bootstrap(
    client: &reqwest::Client,
    bootstrap_url: &str,
    local_address: &str,
    known_urls: Option<Vec<String>>,
    agent: &AgentDetails,
) -> Result<(Vec<AddressInfo>, Vec<String>)> {
    let url = format!("{}/register", bootstrap_url.trim_end_matches('/'));
    let agent_details = agent.clone().stamp_now();
    
    let response: RegisterResponse = client
        .post(&url)
        .json(&RegisterRequest { 
            address: local_address.to_string(), 
            known_bootstrap_urls: known_urls,
            agent_details: Some(agent_details),
        })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    
    Ok((response.known_addresses, response.bootstrap_urls))
}

async fn sync_from_bootstrap(
    registry: Registry,
    bootstrap_urls: BootstrapUrls,
    agent: AgentDetails,
    spire: SpireConfig,
    interval: Duration,
    local_address: String,
) {
    loop {
        tokio::time::sleep(interval).await;
        
        let known_urls: Vec<String> = bootstrap_urls.lock().unwrap().iter().cloned().collect();
        if known_urls.is_empty() {
            continue;
        }
        
        let (addresses, urls) = sync_with_all_bootstraps(&known_urls, &local_address, &agent, &spire).await;
        
        merge_addresses(&registry, addresses);
        // Route learned URLs through the capped helper so a malicious bootstrap
        // peer cannot grow the set beyond MAX_BOOTSTRAP_URLS.
        learn_bootstrap_urls(&bootstrap_urls, &Some(urls.into_iter().collect()));
    }
}

async fn sync_with_all_bootstraps(urls: &[String], local_address: &str, agent: &AgentDetails, spire: &SpireConfig) -> (Vec<AddressInfo>, HashSet<String>) {
    let client = match build_mtls_client(spire) {
        Ok(c) => c,
        Err(e) => {
            error!("Cannot build mTLS client for sync: {}", e);
            return (Vec::new(), HashSet::new());
        }
    };

    let mut all_addresses: Vec<AddressInfo> = Vec::new();
    let mut all_bootstrap_urls = HashSet::new();
    
    for url in urls {
        match register_with_bootstrap(&client, url, local_address, Some(urls.to_vec()), agent).await {
            Ok((addrs, bs_urls)) => {
                all_addresses.extend(addrs);
                all_bootstrap_urls.extend(bs_urls);
            }
            Err(e) => error!("Sync failed with {}: {}", url, e),
        }
    }
    
    (all_addresses, all_bootstrap_urls)
}

fn merge_addresses(registry: &Registry, addresses: Vec<AddressInfo>) {
    let mut reg = registry.lock().unwrap();
    for info in addresses {
        let address = info.address.clone();
        let details = info.into_details();
        match reg.entry(address) {
            std::collections::hash_map::Entry::Occupied(mut e) => {
                let existing = e.get_mut();
                // Always refresh TTL — receiving a gossip entry means the peer is still live.
                existing.last_seen = details.last_seen;
                // Propagate capability / identity updates from the gossip peer.
                // Intentionally leave reliability, health_status, and uptime_percentage
                // untouched — those fields are owned exclusively by PUT /status.
                if let Some(v) = details.version { existing.version = Some(v); }
                if !details.capability_codes.is_empty() {
                    existing.capability_codes = details.capability_codes;
                }
                if details.jurisdiction.is_some() { existing.jurisdiction = details.jurisdiction; }
                if details.data_center.is_some() { existing.data_center = details.data_center; }
                if !details.compliance.is_empty() { existing.compliance = details.compliance; }
                if !details.dependencies.is_empty() { existing.dependencies = details.dependencies; }
                if details.instance_id.is_some() { existing.instance_id = details.instance_id; }
                if details.geographic_location.is_some() {
                    existing.geographic_location = details.geographic_location;
                }
                existing.endpoints = details.endpoints;
                existing.resource_limits = details.resource_limits;
            }
            std::collections::hash_map::Entry::Vacant(e) => {
                e.insert(details);
            }
        }
    }
}

async fn initialize_registry(config: &Config, local_address: &str, allow_insecure: bool) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    if config.server.bootstrap {
        return init_as_bootstrap(local_address, &config.agent, &config.spire, allow_insecure);
    }
    
    init_as_node(config, local_address).await
}

fn init_as_bootstrap(local_address: &str, agent: &AgentDetails, spire: &SpireConfig, allow_insecure: bool) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    let mut addresses = HashMap::new();
    addresses.insert(
        local_address.to_string(),
        agent.clone().stamp_now(),
    );

    // Advertise https:// unless running in explicit insecure/dev mode without SPIRE certs present
    let scheme = if allow_insecure && !std::path::Path::new(&spire.cert_path).exists() {
        "http"
    } else {
        "https"
    };
    let mut bootstrap_urls = HashSet::new();
    bootstrap_urls.insert(format!("{}://{}", scheme, local_address));
    
    (addresses, bootstrap_urls)
}

async fn init_as_node(config: &Config, local_address: &str) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    let mut addresses = HashMap::new();
    let mut bootstrap_urls: HashSet<String> = config.bootstrap.urls.iter().cloned().collect();

    let client = match build_mtls_client(&config.spire) {
        Ok(c) => c,
        Err(e) => {
            error!("Cannot build mTLS client for initial registration: {}", e);
            return (addresses, bootstrap_urls);
        }
    };

    for url in &config.bootstrap.urls {
        match register_with_bootstrap(&client, url, local_address, Some(bootstrap_urls.iter().cloned().collect()), &config.agent).await {
            Ok((addrs, urls)) => {
                for info in addrs {
                    addresses.entry(info.address.clone()).or_insert_with(|| info.into_details());
                }
                bootstrap_urls.extend(urls);
            }
            Err(e) => error!("Failed to register with {}: {}", url, e),
        }
    }
    
    if addresses.is_empty() {
        addresses.insert(
            local_address.to_string(),
            config.agent.clone().stamp_now(),
        );
    }
    
    (addresses, bootstrap_urls)
}

#[derive(OpenApi)]
#[openapi(
    paths(health, register, list, update_status),
    components(schemas(HealthResponse, RegisterRequest, RegisterResponse, ListResponse, AddressInfo, AgentDetails, UpdateStatusRequest, UpdateStatusResponse)),
    tags(
        (name = "Health", description = "Health check endpoints"),
        (name = "Registry", description = "Address registry management")
    ),
    info(
        title = "OpenEMCP Registry API",
        version = "0.1.0",
        description = "A distributed registry service for managing and discovering network addresses with bootstrap server support.",
    )
)]
struct ApiDoc;

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    // Install the ring CryptoProvider for rustls before any TLS is used.
    rustls::crypto::ring::default_provider()
        .install_default()
        .map_err(|_| std::io::Error::other("Failed to install rustls CryptoProvider"))?;

    let args = Args::parse();
    let config = load_config(&args);
    init_logging();
    
    let local_address = format!("{}:{}", get_local_ip(), config.server.port);
    let (addresses, urls) = initialize_registry(&config, &local_address, args.allow_insecure).await;
    
    let app_state = create_app_state(config.clone(), addresses, urls, local_address.clone(), args.allow_insecure);
    
    spawn_sync_task_if_needed(&config, &app_state, &local_address);
    spawn_eviction_task(app_state.registry.clone(), local_address.clone(), config.server.max_ttl);

    // api_https_url is the mTLS proxy target; use loopback so the proxy hits the
    // local server directly without traversing the network.
    let api_https_url = format!("https://127.0.0.1:{}", config.server.port);
    let swagger_port = config.server.swagger_port;

    info!("Starting {} mode on {}", 
        if config.server.bootstrap { "BOOTSTRAP" } else { "NODE" }, 
        local_address
    );

    // Run the HTTPS API server and the HTTP Swagger UI server concurrently
    tokio::try_join!(
        start_server(config.server.port, app_state.clone()),
        start_swagger_server(swagger_port, api_https_url, app_state),
    ).map(|_| ())
}

fn load_config(args: &Args) -> Config {
    Config::load(&args.config)
        .map(|cfg| cfg.merge_with_args(args))
        .unwrap_or_else(|e| {
            eprintln!("Config load failed: {}. Using defaults.", e);
            Config::default().merge_with_args(args)
        })
}

fn init_logging() {
    tracing_subscriber::registry()
        .with(fmt::layer())
        .with(EnvFilter::from_default_env().add_directive(tracing::Level::INFO.into()))
        .init();
}

fn create_app_state(
    config: Config,
    addresses: HashMap<String, AgentDetails>,
    urls: HashSet<String>,
    local_address: String,
    allow_insecure: bool,
) -> web::Data<AppState> {
    use std::sync::{Arc, Mutex};

    // Build a cached proxy client at startup. Failure is non-fatal: if SPIRE certs
    // are not yet present the proxy will fall back to per-request building.
    let proxy_client = match build_mtls_client(&config.spire) {
        Ok(c) => {
            info!("Swagger proxy mTLS client cached at startup");
            Some(c)
        }
        Err(e) => {
            warn!("Cannot pre-build proxy mTLS client (SPIRE certs missing?): {}", e);
            None
        }
    };
    
    web::Data::new(AppState {
        registry: Arc::new(Mutex::new(addresses)),
        is_bootstrap: config.server.bootstrap,
        bootstrap_urls: Arc::new(Mutex::new(urls)),
        local_address,
        agent: config.agent,
        spire: config.spire,
        allow_insecure,
        proxy_client,
    })
}

fn spawn_sync_task_if_needed(config: &Config, app_state: &web::Data<AppState>, local_address: &str) {
    if !config.server.bootstrap {
        tokio::spawn(sync_from_bootstrap(
            app_state.registry.clone(),
            app_state.bootstrap_urls.clone(),
            app_state.agent.clone(),
            app_state.spire.clone(),
            Duration::from_secs(config.bootstrap.sync_interval),
            local_address.to_string(),
        ));
    }
}

/// Spawn a background task that evicts stale registry entries on a fixed timer.
/// Running eviction independently of request handlers ensures TTL is enforced
/// even when `GET /list` is never called (e.g. bootstrap-only or write-heavy load).
fn spawn_eviction_task(registry: Registry, local_address: String, max_ttl: u64) {
    let interval = Duration::from_secs(max_ttl.max(1));
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            let current_ts = AppState::current_timestamp();
            evict_stale_entries(&registry, &local_address, current_ts, max_ttl);
        }
    });
}

/// Build a reqwest client that presents the SPIRE SVID as a client certificate.
/// Uses rustls so cert-chain trust is enforced without disabling hostname checks globally.
/// SPIFFE URI SANs (spiffe://...) are validated via CA-bundle trust, not DNS hostname matching.
/// Called per sync-round so SPIRE cert rotation is picked up at the next interval.
fn build_mtls_client(spire: &SpireConfig) -> Result<reqwest::Client> {
    use rustls::pki_types::CertificateDer;
    use rustls::{ClientConfig, RootCertStore};

    let cert_pem = std::fs::read(&spire.cert_path)
        .map_err(|e| format!("Cannot read SVID cert {}: {}", spire.cert_path, e))?;
    let key_pem = std::fs::read(&spire.key_path)
        .map_err(|e| format!("Cannot read SVID key {}: {}", spire.key_path, e))?;
    let ca_pem = std::fs::read(&spire.bundle_path)
        .map_err(|e| format!("Cannot read CA bundle {}: {}", spire.bundle_path, e))?;

    // Build trusted CA root store from SPIRE CA bundle
    let mut roots = RootCertStore::empty();
    for cert in rustls_pemfile::certs(&mut ca_pem.as_slice()) {
        roots.add(cert.map_err(|e| format!("Invalid CA cert in bundle: {}", e))?)
            .map_err(|e| format!("Cannot add CA cert to store: {}", e))?;
    }

    // Parse client certificate chain (presented during mTLS handshake)
    let certs: Vec<CertificateDer<'static>> =
        rustls_pemfile::certs(&mut cert_pem.as_slice())
            .collect::<std::result::Result<_, _>>()
            .map_err(|e| format!("Invalid client cert: {}", e))?;

    // SPIRE issues PKCS#8 keys (BEGIN PRIVATE KEY)
    let key = rustls_pemfile::private_key(&mut key_pem.as_slice())
        .map_err(|e| format!("Cannot parse private key: {}", e))?
        .ok_or("No private key found in SVID key file")?;

    let tls_config = ClientConfig::builder()
        .with_root_certificates(roots)
        .with_client_auth_cert(certs, key)
        .map_err(|e| format!("Invalid client cert/key pair: {}", e))?;

    reqwest::Client::builder()
        .use_preconfigured_tls(tls_config)
        // No danger_accept_invalid_hostnames: rustls enforces CA-chain trust.
        // SPIFFE URI SAN identity is validated through the SPIRE CA bundle.
        .build()
        .map_err(|e| format!("Failed to build mTLS reqwest client: {}", e).into())
}

/// Actix-web handler that proxies the request to the mTLS HTTPS API backend.
/// Attached as `default_service` on the Swagger/dev HTTP server so every API
/// path that SwaggerUI calls is transparently forwarded with SPIRE certs.
async fn proxy_handler(
    req: HttpRequest,
    body: web::Bytes,
    api_https_url: web::Data<String>,
    app_state: web::Data<AppState>,
) -> HttpResponse {
    match forward_request(&req, body, api_https_url.get_ref(), &app_state).await {
        Ok(resp) => resp,
        Err(e) => {
            error!("mTLS proxy error: {}", e);
            HttpResponse::BadGateway()
                .json(serde_json::json!({"error": format!("mTLS proxy error: {}", e)}))
        }
    }
}

async fn forward_request(
    req: &HttpRequest,
    body: web::Bytes,
    api_https_url: &str,
    state: &AppState,
) -> Result<HttpResponse> {
    let path_and_query = req.uri().path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", api_https_url.trim_end_matches('/'), path_and_query);

    // Prefer the pre-built cached client; fall back to building a fresh one if
    // the cache was not populated at startup (e.g. SPIRE certs arrived later).
    let owned;
    let client: &reqwest::Client = if let Some(ref c) = state.proxy_client {
        c
    } else {
        owned = build_mtls_client(&state.spire)?;
        &owned
    };
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .map_err(|e| format!("Unsupported HTTP method '{}': {}", req.method(), e))?;

    let mut fwd = client.request(method, &target_url);

    // Forward headers; skip hop-by-hop headers managed by reqwest
    for (name, value) in req.headers() {
        let n = name.as_str();
        if !matches!(n, "host" | "content-length" | "transfer-encoding" | "connection") {
            if let Ok(v) = value.to_str() {
                fwd = fwd.header(n, v);
            }
        }
    }
    if !body.is_empty() {
        fwd = fwd.body(body.to_vec());
    }

    let backend_resp = fwd.send().await
        .map_err(|e| format!("Backend request failed: {}", e))?;

    let status = actix_web::http::StatusCode::from_u16(backend_resp.status().as_u16())
        .unwrap_or(actix_web::http::StatusCode::BAD_GATEWAY);
    let mut resp = HttpResponse::build(status);

    // Forward headers; skip hop-by-hop headers
    for (name, value) in backend_resp.headers() {
        let n = name.as_str();
        if !matches!(n, "transfer-encoding" | "connection") {
            resp.insert_header((n, value.as_bytes()));
        }
    }

    let resp_body = backend_resp.bytes().await
        .map_err(|e| format!("Failed to read backend response: {}", e))?;
    Ok(resp.body(resp_body))
}

fn load_spire_tls_config(spire: &SpireConfig) -> Result<openssl::ssl::SslAcceptorBuilder> {
    info!("Loading SPIRE certificates for mTLS...");

    if !Path::new(&spire.cert_path).exists() {
        return Err(format!("SPIRE certificate not found at {}", spire.cert_path).into());
    }
    if !Path::new(&spire.key_path).exists() {
        return Err(format!("SPIRE key not found at {}", spire.key_path).into());
    }
    if !Path::new(&spire.bundle_path).exists() {
        return Err(format!("SPIRE CA bundle not found at {}", spire.bundle_path).into());
    }

    let mut builder = SslAcceptor::mozilla_intermediate_v5(SslMethod::tls())?;
    builder.set_certificate_chain_file(&spire.cert_path)?;
    builder.set_private_key_file(&spire.key_path, SslFiletype::PEM)?;
    builder.set_ca_file(&spire.bundle_path)?;
    builder.set_verify(SslVerifyMode::PEER | SslVerifyMode::FAIL_IF_NO_PEER_CERT);

    info!("✓ SPIRE certificates loaded");
    debug!("  cert={} key={} CA={}", spire.cert_path, spire.key_path, spire.bundle_path);
    
    Ok(builder)
}

async fn start_swagger_server(swagger_port: u16, api_https_url: String, app_state: web::Data<AppState>) -> std::io::Result<()> {
    let bind_addr = format!("127.0.0.1:{}", swagger_port);
    info!("📖 Swagger UI  : http://{}/swagger-ui/", bind_addr);
    info!("🔀 mTLS proxy  : http://{}/* → {}", bind_addr, api_https_url);
    info!("   (SPIRE client cert cached at startup; sync task rebuilds per interval for rotation)");

    // OpenAPI server URL is "/" (relative) so Swagger Try-it-out calls resolve
    // to the same HTTP port as the UI — which is the mTLS proxy, not the backend
    // directly. This works regardless of devcontainer port-forwarding hostname.
    let mut openapi = ApiDoc::openapi();
    openapi.servers = Some(vec![Server::new("/")]);
    let openapi = openapi;

    let api_https_url = web::Data::new(api_https_url);

    HttpServer::new(move || {
        App::new()
            .app_data(api_https_url.clone())
            .app_data(app_state.clone())
            .service(SwaggerUi::new("/swagger-ui/{_:.*}")
                .urls(vec![("/api-docs/openapi.json".into(), openapi.clone())]))
            // Catch-all: any path not served by SwaggerUi is proxied to the
            // mTLS HTTPS backend with the SPIRE client certificate attached
            .default_service(web::route().to(proxy_handler))
    })
    .bind(&bind_addr)?
    .run()
    .await
}

async fn start_server(port: u16, app_state: web::Data<AppState>) -> std::io::Result<()> {
    let bind_addr = format!("0.0.0.0:{}", port);
    let is_bootstrap = app_state.is_bootstrap;
    let allow_insecure = app_state.allow_insecure;
    let spire = app_state.spire.clone();

    // Build the app factory once; both TLS and insecure paths share the same factory.
    let factory = move || {
        let mut app = App::new()
            .app_data(app_state.clone())
            .wrap(tracing_actix_web::TracingLogger::default())
            .service(health)
            .service(list)
            .service(update_status);
        if is_bootstrap {
            app = app.service(register);
        }
        app
    };

    match load_spire_tls_config(&spire) {
        Ok(tls_acceptor) => {
            info!("🔒 Starting HTTPS server with SPIRE mTLS on {}", bind_addr);
            HttpServer::new(factory)
                .bind_openssl(&bind_addr, tls_acceptor)?
                .run()
                .await
        }
        Err(e) if allow_insecure => {
            warn!("⚠️  SPIRE certificates unavailable: {}", e);
            warn!("⚠️  --allow-insecure is set: starting HTTP server (development/testing only)");
            HttpServer::new(factory)
                .bind(&bind_addr)?
                .run()
                .await
        }
        Err(e) => {
            error!("SPIRE certificates unavailable: {}", e);
            error!("Cannot start without mTLS. Pass --allow-insecure for development use only.");
            Err(std::io::Error::other(e.to_string()))
        }
    }
}

// ─── Unit Tests ──────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── is_valid_host_port ────────────────────────────────────────────────────

    #[test]
    fn valid_ipv4_port() {
        assert!(is_valid_host_port("127.0.0.1:9001"));
        assert!(is_valid_host_port("10.0.0.1:8443"));
    }

    #[test]
    fn valid_hostname_port() {
        assert!(is_valid_host_port("localhost:8080"));
        assert!(is_valid_host_port("my-agent.internal:9001"));
    }

    #[test]
    fn valid_ipv6_port() {
        assert!(is_valid_host_port("[::1]:9001"));
    }

    #[test]
    fn rejects_missing_port() {
        assert!(!is_valid_host_port("localhost"));
        assert!(!is_valid_host_port("127.0.0.1"));
    }

    #[test]
    fn rejects_port_zero() {
        assert!(!is_valid_host_port("localhost:0"));
    }

    #[test]
    fn rejects_empty_host() {
        assert!(!is_valid_host_port(":9001"));
    }

    #[test]
    fn rejects_port_too_high() {
        assert!(!is_valid_host_port("localhost:65536"));
        assert!(!is_valid_host_port("127.0.0.1:99999"));
    }

    #[test]
    fn rejects_non_numeric_port() {
        assert!(!is_valid_host_port("localhost:abc"));
    }

    // ── evict_stale_entries ───────────────────────────────────────────────────

    #[test]
    fn evicts_old_entries() {
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert("10.0.0.1:9001".to_string(), AgentDetails::new(0));
        }
        // current_ts=1000, max_ttl=60  →  age=1000 > 60 → should be evicted
        evict_stale_entries(&registry, "127.0.0.1:8443", 1000, 60);
        assert!(registry.lock().unwrap().is_empty(), "stale entry must be evicted");
    }

    #[test]
    fn retains_local_address_despite_stale_last_seen() {
        let local_addr = "127.0.0.1:8443";
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert(local_addr.to_string(), AgentDetails::new(0)); // last_seen=0, would normally evict
        }
        evict_stale_entries(&registry, local_addr, 1000, 60);
        assert!(
            registry.lock().unwrap().contains_key(local_addr),
            "local address must never be evicted by TTL"
        );
    }

    #[test]
    fn retains_fresh_entries() {
        let now = AppState::current_timestamp();
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        {
            let mut reg = registry.lock().unwrap();
            reg.insert("10.0.0.2:9001".to_string(), AgentDetails::new(now));
        }
        evict_stale_entries(&registry, "127.0.0.1:8443", now, 300);
        assert!(!registry.lock().unwrap().is_empty(), "fresh entry must be retained");
    }

    // ── merge_addresses ───────────────────────────────────────────────────────

    #[test]
    fn merge_inserts_new_address() {
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let info = AddressInfo {
            address: "10.0.0.3:9001".to_string(),
            last_seen_seconds: 0,
            details: AgentDetails {
                capability_codes: vec!["CODE_A".to_string()],
                ..AgentDetails::new(AppState::current_timestamp())
            },
        };
        merge_addresses(&registry, vec![info]);
        let reg = registry.lock().unwrap();
        assert!(reg.contains_key("10.0.0.3:9001"), "new address should be inserted");
        assert_eq!(reg["10.0.0.3:9001"].capability_codes, vec!["CODE_A"]);
    }

    #[test]
    fn merge_propagates_version_update() {
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let addr = "10.0.0.4:9001".to_string();
        let now = AppState::current_timestamp();
        {
            let mut reg = registry.lock().unwrap();
            let mut d = AgentDetails::new(now);
            d.version = Some("1.0.0".to_string());
            reg.insert(addr.clone(), d);
        }
        let info = AddressInfo {
            address: addr.clone(),
            last_seen_seconds: 0,
            details: AgentDetails {
                version: Some("2.0.0".to_string()),
                ..AgentDetails::new(now)
            },
        };
        merge_addresses(&registry, vec![info]);
        let reg = registry.lock().unwrap();
        assert_eq!(
            reg[&addr].version.as_deref(),
            Some("2.0.0"),
            "gossip must propagate version updates to existing entries"
        );
    }

    #[test]
    fn merge_preserves_reliability_set_by_status() {
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let addr = "10.0.0.5:9001".to_string();
        let now = AppState::current_timestamp();
        {
            let mut reg = registry.lock().unwrap();
            let mut d = AgentDetails::new(now);
            d.reliability = Some(0.99); // set via PUT /status
            reg.insert(addr.clone(), d);
        }
        // Gossip peer doesn't include reliability (None)
        let info = AddressInfo {
            address: addr.clone(),
            last_seen_seconds: 0,
            details: AgentDetails::new(now),
        };
        merge_addresses(&registry, vec![info]);
        let reg = registry.lock().unwrap();
        assert_eq!(
            reg[&addr].reliability,
            Some(0.99),
            "gossip must not overwrite reliability owned by PUT /status"
        );
    }

    #[test]
    fn merge_refreshes_last_seen() {
        let registry: Registry = std::sync::Arc::new(std::sync::Mutex::new(HashMap::new()));
        let addr = "10.0.0.6:9001".to_string();
        {
            let mut reg = registry.lock().unwrap();
            reg.insert(addr.clone(), AgentDetails::new(0)); // stale
        }
        let info = AddressInfo {
            address: addr.clone(),
            last_seen_seconds: 0,
            details: AgentDetails::new(AppState::current_timestamp()),
        };
        merge_addresses(&registry, vec![info]);
        let reg = registry.lock().unwrap();
        assert!(
            reg[&addr].last_seen > 0,
            "merge must refresh last_seen to prevent premature TTL eviction"
        );
    }
}
