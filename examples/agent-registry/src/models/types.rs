use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq, Default)]
#[serde(rename_all = "lowercase")]
#[non_exhaustive]
pub enum AgentStatus {
    Healthy,
    Degraded,
    Unhealthy,
    Quarantine,
    #[default]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct ServiceEndpoints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub https: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grpc: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub websocket: Option<String>,
    #[serde(default)]
    pub custom: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, Default)]
pub struct ResourceLimits {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cpu_cores: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_memory_mb: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_connections: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_requests_per_second: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_storage_gb: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct GeoLocation {
    pub latitude: f64,
    pub longitude: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub country_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub city: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub region: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct AgentDetails {
    #[serde(default)]
    pub last_seen: u64,
    pub instance_id: Option<String>,
    #[serde(default)]
    pub capability_codes: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jurisdiction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data_center: Option<String>,
    #[serde(default)]
    pub compliance: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
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
    pub registration_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub geographic_location: Option<GeoLocation>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quarantined_at: Option<u64>,
}

impl AgentDetails {
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
            quarantined_at: None,
        }
    }

    pub fn now() -> Self {
        Self::new(AppState::current_timestamp())
    }

    pub fn stamp_now(mut self) -> Self {
        let ts = AppState::current_timestamp();
        self.last_seen = ts;
        if self.registration_time.is_none() {
            self.registration_time = Some(ts);
        }
        self
    }

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

impl Default for AgentDetails {
    fn default() -> Self {
        Self::new(0)
    }
}

pub type Registry = Arc<Mutex<HashMap<String, AgentDetails>>>;
pub type BootstrapUrls = Arc<Mutex<HashSet<String>>>;
pub type Timestamp = u64;

const DEFAULT_PORT: u16 = 8443;
const DEFAULT_SWAGGER_PORT: u16 = 8080;
const DEFAULT_SYNC_INTERVAL: u64 = 30;
const DEFAULT_MAX_TTL: u64 = 60;
const DEFAULT_REMOVAL_TTL: u64 = 300;

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Config {
    pub server: ServerConfig,
    pub bootstrap: BootstrapConfig,
    #[serde(default)]
    pub agent: AgentDetails,
    #[serde(default)]
    pub spire: SpireConfig,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ServerConfig {
    pub port: u16,
    #[serde(default = "default_swagger_port")]
    pub swagger_port: u16,
    pub bootstrap: bool,
    #[serde(alias = "quarantine_ttl")]
    pub max_ttl: u64,
    #[serde(default = "default_removal_ttl")]
    pub removal_ttl: u64,
}

fn default_swagger_port() -> u16 { DEFAULT_SWAGGER_PORT }
fn default_removal_ttl() -> u64 { DEFAULT_REMOVAL_TTL }

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct BootstrapConfig {
    #[serde(default)]
    pub urls: Vec<String>,
    pub sync_interval: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct SpireConfig {
    #[serde(default = "default_spire_cert_path")]
    pub cert_path: String,
    #[serde(default = "default_spire_key_path")]
    pub key_path: String,
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

impl Default for Config {
    fn default() -> Self {
        Self {
            server: ServerConfig {
                port: DEFAULT_PORT,
                swagger_port: DEFAULT_SWAGGER_PORT,
                bootstrap: false,
                max_ttl: DEFAULT_MAX_TTL,
                removal_ttl: DEFAULT_REMOVAL_TTL,
            },
            bootstrap: BootstrapConfig {
                urls: vec![],
                sync_interval: DEFAULT_SYNC_INTERVAL,
            },
            agent: AgentDetails::default(),
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
        if config.server.removal_ttl == 0 {
            return Err("server.removal_ttl must be greater than 0".into());
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
    #[arg(short, long, default_value = "config.bootstrap.yaml")]
    pub config: String,
    #[arg(long)]
    pub bootstrap: Option<bool>,
    #[arg(long)]
    pub port: Option<u16>,
    #[arg(long)]
    pub swagger_port: Option<u16>,
    #[arg(long)]
    pub bootstrap_url: Vec<String>,
    #[arg(long)]
    pub sync_interval: Option<u64>,
    #[arg(long, default_value_t = false)]
    pub allow_insecure: bool,
}

pub struct AppState {
    pub registry: Registry,
    pub is_bootstrap: bool,
    pub bootstrap_urls: BootstrapUrls,
    pub local_address: String,
    pub agent: AgentDetails,
    pub spire: SpireConfig,
    pub allow_insecure: bool,
}

impl AppState {
    pub fn current_timestamp() -> Timestamp {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct HealthResponse {
    pub status: &'static str,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct RegisterRequest {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub known_bootstrap_urls: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub agent_details: Option<AgentDetails>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct RegisterResponse {
    pub success: bool,
    pub message: String,
    pub known_addresses: Vec<AddressInfo>,
    pub bootstrap_urls: Vec<String>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddressInfo {
    pub address: String,
    pub last_seen_seconds: u64,
    #[serde(flatten)]
    pub details: AgentDetails,
}

impl AddressInfo {
    pub fn into_details(mut self) -> AgentDetails {
        self.details.last_seen = AppState::current_timestamp();
        self.details
    }
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct ListResponse {
    pub count: usize,
    pub addresses: Vec<AddressInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bootstrap_urls: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct UpdateStatusRequest {
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_status: Option<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct UpdateStatusResponse {
    pub success: bool,
    pub message: String,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reliability: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_status: Option<AgentStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_time: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uptime_percentage: Option<f64>,
}
