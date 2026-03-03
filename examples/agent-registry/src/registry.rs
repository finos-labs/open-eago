use crate::models::{AddressInfo, AgentDetails, AppState, BootstrapUrls, RegisterRequest, Registry, Timestamp};
use actix_web::{HttpRequest, HttpResponse};
use tracing::{info, warn};

// ─── Input validation limits ──────────────────────────────────────────────────

pub const MAX_BOOTSTRAP_URLS: usize = 32;
pub const MAX_REGISTRY_ENTRIES: usize = 10_000;
pub const MAX_TAGS_COUNT: usize = 50;
pub const MAX_LIST_FIELD_LEN: usize = 100; // capability_codes, compliance, dependencies
pub const MAX_STRING_VALUE_LEN: usize = 512; // per string in tags / version / etc.
pub const ALLOWED_BOOTSTRAP_SCHEMES: &[&str] = &["http", "https"];

// ─── Registry update result ───────────────────────────────────────────────────

#[derive(PartialEq)]
pub enum RegistryUpdate {
    New,
    Updated,
    CapExceeded,
}

// ─── Core registry operations ─────────────────────────────────────────────────

pub fn update_registry(registry: &Registry, address: &str, mut agent_details: AgentDetails) -> RegistryUpdate {
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

pub fn learn_bootstrap_urls(bootstrap_urls: &BootstrapUrls, new_urls: &Option<Vec<String>>) {
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

pub fn validate_register_request(req: &RegisterRequest) -> Option<HttpResponse> {
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
pub fn is_valid_host_port(addr: &str) -> bool {
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

pub fn cleanup_and_build_list(
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
pub fn evict_stale_entries(
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
pub async fn verify_caller_owns_address(http_req: &HttpRequest, address: &str) -> std::result::Result<(), String> {
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

pub fn merge_addresses(registry: &Registry, addresses: Vec<AddressInfo>) {
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

// ─── Unit Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

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
            d.version = Some("0.1.0".to_string());
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
