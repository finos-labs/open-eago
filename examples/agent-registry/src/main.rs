mod models;

use models::{
    AddressInfo, AgentConfig, AgentDetails, AppState, Args, BootstrapUrls, Config, 
    HealthResponse, ListResponse, RegisterRequest, RegisterResponse, Registry, Timestamp,
    UpdateStatusRequest, UpdateStatusResponse,
};
use actix_web::{get, post, put, web, App, HttpRequest, HttpResponse, HttpServer, Responder};
use clap::Parser;
use openssl::ssl::{SslAcceptor, SslMethod, SslFiletype, SslVerifyMode};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Duration;
use tracing::{error, info, warn, instrument};
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};
use utoipa::OpenApi;
use utoipa::openapi::server::Server;
use utoipa_swagger_ui::SwaggerUi;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

// Constants
const DEFAULT_LOCAL_IP: &str = "127.0.0.1";
const SPIRE_CERT_PATH: &str = "/tmp/svid.0.pem";
const SPIRE_KEY_PATH: &str = "/tmp/svid.0.key";
const SPIRE_BUNDLE_PATH: &str = "/tmp/bundle.0.pem";

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

    let agent_details = req.agent_details.clone()
        .unwrap_or_else(AgentDetails::now);

    let is_new = update_registry(&data.registry, &req.address, agent_details);
    learn_bootstrap_urls(&data.bootstrap_urls, &req.known_bootstrap_urls);

    info!("{} address: {}", if is_new { "New" } else { "Updated" }, req.address);

    HttpResponse::Ok().json(RegisterResponse {
        success: true,
        message: format!("Address {}", if is_new { "registered" } else { "updated" }),
        known_addresses: data.registry.lock().unwrap().keys().cloned().collect(),
        bootstrap_urls: data.bootstrap_urls.lock().unwrap().iter().cloned().collect(),
    })
}

fn update_registry(registry: &Registry, address: &str, mut agent_details: AgentDetails) -> bool {
    let mut reg = registry.lock().unwrap();
    let is_new = !reg.contains_key(address);
    
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
    is_new
}

fn learn_bootstrap_urls(bootstrap_urls: &BootstrapUrls, new_urls: &Option<Vec<String>>) {
    if let Some(urls) = new_urls {
        let mut bs_urls = bootstrap_urls.lock().unwrap();
        let count_before = bs_urls.len();
        bs_urls.extend(urls.iter().cloned());
        let added = bs_urls.len() - count_before;
        if added > 0 {
            info!("Learned {} new bootstrap URLs", added);
        }
    }
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
    let addresses = cleanup_and_build_list(&data.registry, &data.local_address, current_ts, data.max_ttl, data.is_bootstrap);
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
    max_ttl: u64,
    is_bootstrap: bool,
) -> Vec<AddressInfo> {
    let mut reg = registry.lock().unwrap();
    reg.retain(|addr, details| addr == local_address || current_ts - details.last_seen <= max_ttl);
    
    reg.iter()
        .filter(|(addr, _)| !is_bootstrap || *addr != local_address)
        .map(|(addr, details)| AddressInfo {
            address: addr.clone(),
            last_seen_seconds: if addr == local_address { 0 } else { current_ts - details.last_seen },
            instance_id: details.instance_id.clone(),
            capability_codes: details.capability_codes.clone(),
            jurisdiction: details.jurisdiction.clone(),
            data_center: details.data_center.clone(),
            compliance: details.compliance.clone(),
            reliability: details.reliability,
            version: details.version.clone(),
            timestamp: details.timestamp.clone(),
            tags: details.tags.clone(),
            endpoints: details.endpoints.clone(),
            resource_limits: details.resource_limits.clone(),
            health_status: details.health_status.clone(),
            registration_time: details.registration_time,
            uptime_percentage: details.uptime_percentage,
            geographic_location: details.geographic_location.clone(),
            dependencies: details.dependencies.clone(),
        })
        .collect()
}

#[utoipa::path(
    put,
    path = "/status",
    request_body = UpdateStatusRequest,
    responses(
        (status = 200, description = "Agent status updated successfully", body = UpdateStatusResponse),
        (status = 404, description = "Address not found"),
        (status = 400, description = "Invalid field value")
    ),
    tag = "Registry"
)]
#[put("/status")]
#[instrument(skip(data))]
async fn update_status(data: web::Data<AppState>, req: web::Json<UpdateStatusRequest>) -> impl Responder {
    // Validate reliability is within valid range
    if let Some(reliability) = req.reliability {
        if reliability < 0.0 || reliability > 1.0 {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": "Reliability must be between 0.0 and 1.0"
            }));
        }
    }
    
    // Validate uptime_percentage is within valid range
    if let Some(uptime) = req.uptime_percentage {
        if uptime < 0.0 || uptime > 100.0 {
            return HttpResponse::BadRequest().json(serde_json::json!({
                "error": "Uptime percentage must be between 0.0 and 100.0"
            }));
        }
    }

    let mut registry = data.registry.lock().unwrap();
    
    // Check if the address exists in the registry
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
        
        if let Some(registration_time) = req.registration_time {
            agent_details.registration_time = Some(registration_time);
            updates.push(format!("registration_time: {}", registration_time));
        }
        
        if let Some(uptime_percentage) = req.uptime_percentage {
            agent_details.uptime_percentage = Some(uptime_percentage);
            updates.push(format!("uptime_percentage: {}%", uptime_percentage));
        }
        
        let message = if updates.is_empty() {
            "No fields updated".to_string()
        } else {
            format!("Updated: {}", updates.join(", "))
        };
        
        info!("Updated status for {}: {}", req.address, message);
        
        HttpResponse::Ok().json(UpdateStatusResponse {
            success: true,
            message,
            address: req.address.clone(),
            reliability: req.reliability,
            health_status: req.health_status.clone(),
            registration_time: req.registration_time,
            uptime_percentage: req.uptime_percentage,
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
    bootstrap_url: &str,
    local_address: &str,
    known_urls: Option<Vec<String>>,
    agent_config: &AgentConfig,
) -> Result<(Vec<String>, Vec<String>)> {
    let url = format!("{}/register", bootstrap_url.trim_end_matches('/'));
    let agent_details = agent_config.to_agent_details();
    
    let response: RegisterResponse = reqwest::Client::new()
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
    agent_config: AgentConfig,
    interval: Duration,
    local_address: String,
) {
    loop {
        tokio::time::sleep(interval).await;
        
        let known_urls: Vec<String> = bootstrap_urls.lock().unwrap().iter().cloned().collect();
        if known_urls.is_empty() {
            continue;
        }
        
        let (addresses, urls) = sync_with_all_bootstraps(&known_urls, &local_address, &agent_config).await;
        
        merge_addresses(&registry, addresses);
        bootstrap_urls.lock().unwrap().extend(urls);
    }
}

async fn sync_with_all_bootstraps(urls: &[String], local_address: &str, agent_config: &AgentConfig) -> (HashSet<String>, HashSet<String>) {
    let mut all_addresses = HashSet::new();
    let mut all_bootstrap_urls = HashSet::new();
    
    for url in urls {
        match register_with_bootstrap(url, local_address, Some(urls.to_vec()), agent_config).await {
            Ok((addrs, bs_urls)) => {
                all_addresses.extend(addrs);
                all_bootstrap_urls.extend(bs_urls);
            }
            Err(e) => error!("Sync failed with {}: {}", url, e),
        }
    }
    
    (all_addresses, all_bootstrap_urls)
}

fn merge_addresses(registry: &Registry, addresses: HashSet<String>) {
    let mut reg = registry.lock().unwrap();
    for addr in addresses {
        reg.entry(addr).or_insert_with(|| AgentDetails::new(0));
    }
}

async fn initialize_registry(config: &Config, local_address: &str) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    if config.server.bootstrap {
        return init_as_bootstrap(local_address, &config.agent);
    }
    
    init_as_node(config, local_address).await
}

fn init_as_bootstrap(local_address: &str, agent_config: &AgentConfig) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    let mut addresses = HashMap::new();
    addresses.insert(
        local_address.to_string(), 
        agent_config.to_agent_details(),
    );
    
    let mut bootstrap_urls = HashSet::new();
    bootstrap_urls.insert(format!("http://{}", local_address));
    
    (addresses, bootstrap_urls)
}

async fn init_as_node(config: &Config, local_address: &str) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    let mut addresses = HashMap::new();
    let mut bootstrap_urls: HashSet<String> = config.bootstrap.urls.iter().cloned().collect();
    
    for url in &config.bootstrap.urls {
        match register_with_bootstrap(url, local_address, Some(bootstrap_urls.iter().cloned().collect()), &config.agent).await {
            Ok((addrs, urls)) => {
                for addr in addrs {
                    addresses.entry(addr).or_insert_with(|| AgentDetails::new(0));
                }
                bootstrap_urls.extend(urls);
            }
            Err(e) => error!("Failed to register with {}: {}", url, e),
        }
    }
    
    if addresses.is_empty() {
        addresses.insert(
            local_address.to_string(), 
            config.agent.to_agent_details(),
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
    let args = Args::parse();
    let config = load_config(&args);
    init_logging();
    
    let local_address = format!("{}:{}", get_local_ip(), config.server.port);
    let (addresses, urls) = initialize_registry(&config, &local_address).await;
    
    let app_state = create_app_state(config.clone(), addresses, urls, local_address.clone());
    
    spawn_sync_task_if_needed(&config, &app_state, &local_address);
    
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
        start_server(config.server.port, app_state),
        start_swagger_server(swagger_port, api_https_url),
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
) -> web::Data<AppState> {
    use std::sync::{Arc, Mutex};
    
    web::Data::new(AppState {
        registry: Arc::new(Mutex::new(addresses)),
        is_bootstrap: config.server.bootstrap,
        bootstrap_urls: Arc::new(Mutex::new(urls)),
        local_address,
        max_ttl: config.server.max_ttl,
        agent_config: config.agent,
    })
}

fn spawn_sync_task_if_needed(config: &Config, app_state: &web::Data<AppState>, local_address: &str) {
    if !config.server.bootstrap {
        tokio::spawn(sync_from_bootstrap(
            app_state.registry.clone(),
            app_state.bootstrap_urls.clone(),
            app_state.agent_config.clone(),
            Duration::from_secs(config.bootstrap.sync_interval),
            local_address.to_string(),
        ));
    }
}

/// Build a reqwest client that presents the SPIRE SVID as a client certificate.
/// Called per-request so cert rotation by SPIRE is picked up automatically.
fn build_mtls_client() -> Result<reqwest::Client> {
    let cert_pem = std::fs::read(SPIRE_CERT_PATH)
        .map_err(|e| format!("Cannot read SVID cert {}: {}", SPIRE_CERT_PATH, e))?;
    let key_pem = std::fs::read(SPIRE_KEY_PATH)
        .map_err(|e| format!("Cannot read SVID key {}: {}", SPIRE_KEY_PATH, e))?;
    let ca_pem = std::fs::read(SPIRE_BUNDLE_PATH)
        .map_err(|e| format!("Cannot read CA bundle {}: {}", SPIRE_BUNDLE_PATH, e))?;

    // SPIRE issues PKCS#8 keys (BEGIN PRIVATE KEY), supported by native-tls
    let identity = reqwest::Identity::from_pkcs8_pem(&cert_pem, &key_pem)
        .map_err(|e| format!("Invalid SVID identity: {}", e))?;
    let ca_cert = reqwest::Certificate::from_pem(&ca_pem)
        .map_err(|e| format!("Invalid CA certificate: {}", e))?;

    reqwest::Client::builder()
        .identity(identity)
        .add_root_certificate(ca_cert)
        // SPIRE SVIDs carry a SPIFFE URI SAN, not a DNS/IP SAN.
        // Identity is verified via the cert chain (CA bundle), not hostname matching.
        .danger_accept_invalid_hostnames(true)
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
) -> HttpResponse {
    match forward_request(&req, body, api_https_url.get_ref()).await {
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
) -> Result<HttpResponse> {
    let path_and_query = req.uri().path_and_query()
        .map(|pq| pq.as_str())
        .unwrap_or("/");
    let target_url = format!("{}{}", api_https_url.trim_end_matches('/'), path_and_query);

    let client = build_mtls_client()?;
    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .unwrap_or(reqwest::Method::GET);

    let mut fwd = client.request(method, &target_url);

    // Forward request headers; skip hop-by-hop headers that reqwest manages itself
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

    // Forward response headers; drop hop-by-hop headers
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

fn load_spire_tls_config() -> Result<openssl::ssl::SslAcceptorBuilder> {
    info!("Loading SPIRE certificates for mTLS...");
    
    // Check if certificate files exist
    if !Path::new(SPIRE_CERT_PATH).exists() {
        return Err(format!("SPIRE certificate not found at {}", SPIRE_CERT_PATH).into());
    }
    if !Path::new(SPIRE_KEY_PATH).exists() {
        return Err(format!("SPIRE key not found at {}", SPIRE_KEY_PATH).into());
    }
    if !Path::new(SPIRE_BUNDLE_PATH).exists() {
        return Err(format!("SPIRE CA bundle not found at {}", SPIRE_BUNDLE_PATH).into());
    }
    
    let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls())?;
    
    // Load server certificate and private key
    builder.set_certificate_chain_file(SPIRE_CERT_PATH)?;
    builder.set_private_key_file(SPIRE_KEY_PATH, SslFiletype::PEM)?;
    
    // Load CA bundle for client certificate verification
    builder.set_ca_file(SPIRE_BUNDLE_PATH)?;
    
    // Require and verify client certificates
    builder.set_verify(SslVerifyMode::PEER | SslVerifyMode::FAIL_IF_NO_PEER_CERT);
    
    info!("✓ SPIRE certificates loaded successfully");
    info!("  - Server cert: {}", SPIRE_CERT_PATH);
    info!("  - Server key: {}", SPIRE_KEY_PATH);
    info!("  - CA bundle: {}", SPIRE_BUNDLE_PATH);
    info!("  - Client certificate verification: ENABLED");
    
    Ok(builder)
}

async fn start_swagger_server(swagger_port: u16, api_https_url: String) -> std::io::Result<()> {
    let bind_addr = format!("0.0.0.0:{}", swagger_port);
    info!("📖 Swagger UI  : http://{}/swagger-ui/", bind_addr);
    info!("🔀 mTLS proxy  : http://{}/* → {}", bind_addr, api_https_url);
    info!("   (SPIRE certs attached automatically; cert rotation handled per-request)");

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
    
    // Try to load SPIRE TLS configuration
    match load_spire_tls_config() {
        Ok(tls_acceptor) => {
            info!("🔒 Starting HTTPS server with SPIRE mTLS on {}", bind_addr);
            
            HttpServer::new(move || {
                let mut app = App::new()
                    .app_data(app_state.clone())
                    .wrap(tracing_actix_web::TracingLogger::default())
                    .service(health)
                    .service(list)
                    .service(update_status);
                
                if app_state.is_bootstrap {
                    app = app.service(register);
                }
                app
            })
            .bind_openssl(&bind_addr, tls_acceptor)?
            .run()
            .await
        }
        Err(e) => {
            warn!("⚠️  Failed to load SPIRE certificates: {}", e);
            warn!("⚠️  Falling back to HTTP (insecure) on {}", bind_addr);
            
            HttpServer::new(move || {
                let mut app = App::new()
                    .app_data(app_state.clone())
                    .wrap(tracing_actix_web::TracingLogger::default())
                    .service(health)
                    .service(list)
                    .service(update_status);
                
                if app_state.is_bootstrap {
                    app = app.service(register);
                }
                app
            })
            .bind(&bind_addr)?
            .run()
            .await
        }
    }
}
