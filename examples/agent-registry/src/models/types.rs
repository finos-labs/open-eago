use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use utoipa::ToSchema;

/// Agent health status
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum AgentStatus {
    /// Agent is healthy and operational
    Healthy,
    /// Agent is degraded but still operational
    Degraded,
    /// Agent is unhealthy
    Unhealthy,
    /// Agent status is unknown
    Unknown,
}

impl Default for AgentStatus {
    fn default() -> Self {
        AgentStatus::Unknown
    }
}

/// Service endpoints for service discovery
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct ServiceEndpoints {
    /// HTTP endpoint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
    /// HTTPS endpoint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https: Option<String>,
    /// gRPC endpoint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grpc: Option<String>,
    /// WebSocket endpoint
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket: Option<String>,
    /// Custom endpoints
    #[serde(default)]
    pub custom: HashMap<String, String>,
}

/// Resource limits for capacity planning
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct ResourceLimits {
    /// Maximum CPU cores available
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cpu_cores: Option<u32>,
    /// Maximum memory in MB
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_mb: Option<u64>,
    /// Maximum concurrent connections
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<u32>,
    /// Maximum requests per second
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_requests_per_second: Option<u32>,
    /// Maximum storage in GB
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_storage_gb: Option<u64>,
}

/// Geographic location information
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GeoLocation {
    /// Latitude coordinate
    pub latitude: f64,
    /// Longitude coordinate
    pub longitude: f64,
    /// Country code (ISO 3166-1 alpha-2)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    /// City name
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    /// Region or state
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

/// Details about an agent including capabilities and metadata
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentDetails {
    /// Timestamp when last seen (seconds since UNIX epoch)
    pub last_seen: u64,
    /// Unique instance identifier
    pub instance_id: Option<String>,
    /// List of capability codes that this agent supports
    #[serde(default)]
    pub capability_codes: Vec<String>,
    /// Jurisdiction where the agent operates
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jurisdiction: Option<String>,
    /// Data center identifier or location
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_center: Option<String>,
    /// Compliance certifications or standards
    #[serde(default)]
    pub compliance: Vec<String>,
    /// Reliability score (0.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    /// Software version
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// Optional timestamp for additional metadata in YYYY-MM-DD HH:MM:SS with timezone format
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    /// Flexible metadata tags
    #[serde(default)]
    pub tags: HashMap<String, String>,
    /// Service endpoints for service discovery
    #[serde(default)]
    pub endpoints: ServiceEndpoints,
    /// Resource limits for capacity planning
    #[serde(default)]
    pub resource_limits: ResourceLimits,
    /// Current health status
    #[serde(default)]
    pub health_status: AgentStatus,
    /// Registration time (seconds since UNIX epoch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_time: Option<u64>,
    /// Historical reliability (uptime percentage)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
    /// Geographic location
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geographic_location: Option<GeoLocation>,
    /// Required services or dependencies
    #[serde(default)]
    pub dependencies: Vec<String>,
}

impl AgentDetails {
    /// Create a new AgentDetails with minimal information
    pub fn new(last_seen: u64) -> Self {
        Self {
            last_seen,
            instance_id: None,
            capability_codes: vec![],
            jurisdiction: None,
            data_center: None,
            compliance: vec![],
            reliability: None,
            version: None,
            timestamp: None,
            tags: HashMap::new(),
            endpoints: ServiceEndpoints::default(),
            resource_limits: ResourceLimits::default(),
            health_status: AgentStatus::Unknown,
            registration_time: Some(last_seen),
            uptime_percentage: None,
            geographic_location: None,
            dependencies: vec![],
        }
    }
    
    /// Create AgentDetails with current timestamp
    pub fn now() -> Self {
        Self::new(AppState::current_timestamp())
    }
}

/// In-memory registry of agent addresses → details.
///
/// `std::sync::Mutex` is used intentionally here rather than `tokio::sync::Mutex`.
/// All critical sections are short (HashMap insertions / iterations — no I/O, no `.await`),
/// so blocking the thread for a fraction of a microsecond is acceptable and eliminates the
/// risk of accidentally holding the guard across an `.await` point, which would be unsound
/// with `tokio::sync::Mutex` and a multi-threaded runtime anyway.
/// If a critical section ever needs to perform I/O, migrate that section to a dedicated
/// async task with a channel rather than switching to `tokio::sync::Mutex`.
pub type Registry = Arc<Mutex<HashMap<String, AgentDetails>>>;
pub type BootstrapUrls = Arc<Mutex<HashSet<String>>>;
pub type Timestamp = u64;

const DEFAULT_PORT: u16 = 8443;
const DEFAULT_SWAGGER_PORT: u16 = 8080;
const DEFAULT_SYNC_INTERVAL: u64 = 30;
const DEFAULT_MAX_TTL: u64 = 60;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    pub server: ServerConfig,
    pub bootstrap: BootstrapConfig,
    #[serde(default)]
    pub agent: AgentConfig,
    #[serde(default)]
    pub spire: SpireConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    pub port: u16,
    /// Separate HTTP port for Swagger UI (keeps docs accessible without mTLS)
    #[serde(default = "default_swagger_port")]
    pub swagger_port: u16,
    pub bootstrap: bool,
    pub max_ttl: u64,
}

fn default_swagger_port() -> u16 { DEFAULT_SWAGGER_PORT }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BootstrapConfig {
    #[serde(default)]
    pub urls: Vec<String>,
    pub sync_interval: u64,
}

/// SPIRE workload API certificate paths.
/// Each field falls back to its `SPIRE_*` environment variable, then to the
/// SPIRE agent default under `/tmp/`, when not explicitly set in the config file.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SpireConfig {
    /// Path to the SPIRE SVID certificate (PEM)
    #[serde(default = "default_spire_cert_path")]
    pub cert_path: String,
    /// Path to the SPIRE SVID private key (PEM)
    #[serde(default = "default_spire_key_path")]
    pub key_path: String,
    /// Path to the SPIRE CA bundle (PEM)
    #[serde(default = "default_spire_bundle_path")]
    pub bundle_path: String,
}

fn default_spire_cert_path()   -> String { std::env::var("SPIRE_CERT_PATH").unwrap_or_else(|_|   "/tmp/svid.0.pem".to_string()) }
fn default_spire_key_path()    -> String { std::env::var("SPIRE_KEY_PATH").unwrap_or_else(|_|    "/tmp/svid.0.key".to_string()) }
fn default_spire_bundle_path() -> String { std::env::var("SPIRE_BUNDLE_PATH").unwrap_or_else(|_| "/tmp/bundle.0.pem".to_string()) }

impl Default for SpireConfig {
    fn default() -> Self {
        Self {
            cert_path:   default_spire_cert_path(),
            key_path:    default_spire_key_path(),
            bundle_path: default_spire_bundle_path(),
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AgentConfig {
    #[serde(default)]
    pub instance_id: Option<String>,
    #[serde(default)]
    pub capability_codes: Vec<String>,
    pub jurisdiction: Option<String>,
    pub data_center: Option<String>,
    #[serde(default)]
    pub compliance: Vec<String>,
    pub reliability: Option<f64>,
    pub version: Option<String>,
    pub timestamp: Option<String>,
    #[serde(default)]
    pub tags: HashMap<String, String>,
    #[serde(default)]
    pub endpoints: ServiceEndpoints,
    #[serde(default)]
    pub resource_limits: ResourceLimits,
    #[serde(default)]
    pub health_status: AgentStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geographic_location: Option<GeoLocation>,
    #[serde(default)]
    pub dependencies: Vec<String>,
}

impl From<AgentConfig> for AgentDetails {
    fn from(cfg: AgentConfig) -> Self {
        let current_time = AppState::current_timestamp();
        AgentDetails {
            last_seen: current_time,
            instance_id: cfg.instance_id,
            capability_codes: cfg.capability_codes,
            jurisdiction: cfg.jurisdiction,
            data_center: cfg.data_center,
            compliance: cfg.compliance,
            reliability: cfg.reliability,
            version: cfg.version,
            timestamp: cfg.timestamp,
            tags: cfg.tags,
            endpoints: cfg.endpoints,
            resource_limits: cfg.resource_limits,
            health_status: cfg.health_status,
            registration_time: Some(current_time),
            uptime_percentage: cfg.uptime_percentage,
            geographic_location: cfg.geographic_location,
            dependencies: cfg.dependencies,
        }
    }
}

impl AgentConfig {
    /// Convert AgentConfig to AgentDetails with current timestamp.
    pub fn to_agent_details(&self) -> AgentDetails {
        AgentDetails::from(self.clone())
    }
    
    /// Validate reliability is within valid range (0.0 to 1.0)
    pub fn validate(&self) -> Result<(), String> {
        if let Some(reliability) = self.reliability {
            if !(0.0..=1.0).contains(&reliability) {
                return Err(format!("Reliability must be between 0.0 and 1.0, got {}", reliability));
            }
        }
        if let Some(uptime) = self.uptime_percentage {
            if !(0.0..=100.0).contains(&uptime) {
                return Err(format!("Uptime percentage must be between 0.0 and 100.0, got {}", uptime));
            }
        }
        if let Some(ref geo) = self.geographic_location {
            if !(-90.0..=90.0).contains(&geo.latitude) {
                return Err(format!("Latitude must be between -90 and 90, got {}", geo.latitude));
            }
            if !(-180.0..=180.0).contains(&geo.longitude) {
                return Err(format!("Longitude must be between -180 and 180, got {}", geo.longitude));
            }
        }
        Ok(())
    }
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            instance_id: None,
            capability_codes: vec![],
            jurisdiction: None,
            data_center: None,
            compliance: vec![],
            reliability: None,
            version: None,
            timestamp: None,
            tags: HashMap::new(),
            endpoints: ServiceEndpoints::default(),
            resource_limits: ResourceLimits::default(),
            health_status: AgentStatus::Unknown,
            uptime_percentage: None,
            geographic_location: None,
            dependencies: vec![],
        }
    }
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                port: DEFAULT_PORT,
                swagger_port: DEFAULT_SWAGGER_PORT,
                bootstrap: false,
                max_ttl: DEFAULT_MAX_TTL,
            },
            bootstrap: BootstrapConfig {
                urls: vec![],
                sync_interval: DEFAULT_SYNC_INTERVAL,
            },
            agent: AgentConfig::default(),
            spire: SpireConfig::default(),
        }
    }
}

impl Config {
    pub fn load(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = serde_yml::from_str(&content)?;
        config.agent.validate()?;
        if config.server.max_ttl == 0 {
            return Err("server.max_ttl must be greater than 0".into());
        }
        Ok(config)
    }
    
    pub fn merge_with_args(mut self, args: &Args) -> Self {
        if let Some(port) = args.port {
            self.server.port = port;
        }
        if let Some(swagger_port) = args.swagger_port {
            self.server.swagger_port = swagger_port;
        }
        if let Some(bootstrap) = args.bootstrap {
            self.server.bootstrap = bootstrap;
        }
        for url in &args.bootstrap_url {
            if !self.bootstrap.urls.contains(url) {
                self.bootstrap.urls.push(url.clone());
            }
        }
        if let Some(interval) = args.sync_interval {
            self.bootstrap.sync_interval = interval;
        }
        self
    }
}

#[derive(Parser, Debug, Clone)]
#[command(author, version, about, long_about = None)]
pub struct Args {
    /// Path to config file
    #[arg(short, long, default_value = "config.bootstrap.yaml")]
    pub config: String,

    /// Run as bootstrap server (overrides config)
    #[arg(long)]
    pub bootstrap: Option<bool>,

    /// HTTPS port to run on (overrides config)
    #[arg(long)]
    pub port: Option<u16>,

    /// HTTP port for Swagger UI (overrides config)
    #[arg(long)]
    pub swagger_port: Option<u16>,

    /// Bootstrap server URL (overrides config)
    #[arg(long)]
    pub bootstrap_url: Vec<String>,

    /// Sync interval in seconds (overrides config)
    #[arg(long)]
    pub sync_interval: Option<u64>,

    /// Allow falling back to plain HTTP when SPIRE certificates are unavailable.
    /// For development/testing ONLY. Must never be set in production.
    #[arg(long, default_value_t = false)]
    pub allow_insecure: bool,
}

pub struct AppState {
    pub registry: Registry,
    pub is_bootstrap: bool,
    pub bootstrap_urls: BootstrapUrls,
    pub local_address: String,
    pub agent_config: AgentConfig,
    /// SPIRE certificate paths used for mTLS (inbound TLS + outbound client cert).
    pub spire: SpireConfig,
    /// When true, falls back to plaintext HTTP if SPIRE certs are missing.
    /// Development/testing only — never set in production.
    pub allow_insecure: bool,
    /// Cached mTLS client for the Swagger-UI proxy (`forward_request`).
    /// Built once at startup; the sync task uses its own per-round client so
    /// cert rotation is always picked up there without affecting this cache.
    pub proxy_client: Option<reqwest::Client>,
}

impl AppState {
    /// Returns seconds since UNIX epoch. Returns 0 on the (practically impossible)
    /// event that the system clock is set before 1970-01-01 rather than panicking.
    pub fn current_timestamp() -> Timestamp {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

/// Health check response
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    /// Service status
    pub status: &'static str,
}

/// Request to register or update a node address
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct RegisterRequest {
    /// Address in format "IP:PORT" or "hostname:PORT" (e.g. 192.168.1.1:9001 or myhost.example.com:9001)
    pub address: String,
    /// Known bootstrap URLs for peer discovery
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_bootstrap_urls: Option<Vec<String>>,
    /// Agent details including capabilities and metadata
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_details: Option<AgentDetails>,
}

/// Response from registration request
#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterResponse {
    /// Whether the registration was successful
    pub success: bool,
    /// Human-readable message
    pub message: String,
    /// List of all known addresses in the registry with full agent details
    pub known_addresses: Vec<AddressInfo>,
    /// List of all known bootstrap server URLs
    pub bootstrap_urls: Vec<String>,
}

/// Address information with last seen timestamp and full agent details.
/// Uses `#[serde(flatten)]` to inline all `AgentDetails` fields at the same JSON level,
/// keeping the wire format identical while eliminating the per-field duplication.
#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddressInfo {
    /// Address in format "IP:PORT" or "hostname:PORT"
    pub address: String,
    /// Seconds since last seen (0 for the local address)
    pub last_seen_seconds: u64,
    /// Full agent details inlined into the same JSON object
    #[serde(flatten)]
    pub details: AgentDetails,
}

impl AddressInfo {
    /// Convert into the inner `AgentDetails`, always stamping `last_seen` with
    /// the current time. Peer-supplied timestamps are untrusted — a value set far
    /// in the future would prevent TTL eviction indefinitely. We record the time
    /// *we* first learned about this peer, not what the peer claims.
    pub fn into_details(mut self) -> AgentDetails {
        self.details.last_seen = AppState::current_timestamp();
        self.details
    }
}

/// Response containing list of registered addresses
#[derive(Serialize, Deserialize, ToSchema)]
pub struct ListResponse {
    /// Total number of registered addresses
    pub count: usize,
    /// List of addresses in format "IP:PORT"
    pub addresses: Vec<AddressInfo>,
    /// List of all known bootstrap server URLs
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_urls: Option<Vec<String>>,
}

/// Request to update the status of an agent
#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct UpdateStatusRequest {
    /// Address in format "IP:PORT"
    pub address: String,
    /// New reliability value (0.0 to 1.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    /// New health status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_status: Option<AgentStatus>,
    /// Historical reliability (uptime percentage 0.0 to 100.0)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
}

/// Response from updating agent status
#[derive(Serialize, Deserialize, ToSchema)]
pub struct UpdateStatusResponse {
    /// Whether the update was successful
    pub success: bool,
    /// Human-readable message
    pub message: String,
    /// Address that was updated
    pub address: String,
    /// Updated reliability value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    /// Updated health status
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_status: Option<AgentStatus>,
    /// Updated registration time
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_time: Option<u64>,
    /// Updated uptime percentage
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
}
