use clap::Parser;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use utoipa::ToSchema;

/// Agent health status
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema, PartialEq)]
#[serde(rename_all = "lowercase")]
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

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AgentConfig {
    #[serde(default)]
    pub instance_id: Option<String>,
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

impl AgentConfig {
    /// Convert AgentConfig to AgentDetails with current timestamp
    pub fn to_agent_details(&self) -> AgentDetails {
        let current_time = AppState::current_timestamp();
        AgentDetails {
            last_seen: current_time,
            instance_id: self.instance_id.clone(),
            capability_codes: self.capability_codes.clone(),
            jurisdiction: self.jurisdiction.clone(),
            data_center: self.data_center.clone(),
            compliance: self.compliance.clone(),
            reliability: self.reliability,
            version: self.version.clone(),
            timestamp: self.timestamp.clone(),
            tags: self.tags.clone(),
            endpoints: self.endpoints.clone(),
            resource_limits: self.resource_limits.clone(),
            health_status: self.health_status.clone(),
            registration_time: Some(current_time),
            uptime_percentage: self.uptime_percentage,
            geographic_location: self.geographic_location.clone(),
            dependencies: self.dependencies.clone(),
        }
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
        }
    }
}

impl Config {
    pub fn load(path: &str) -> Result<Self, Box<dyn std::error::Error>> {
        let content = std::fs::read_to_string(path)?;
        let config: Config = serde_yaml::from_str(&content)?;
        config.agent.validate()?;
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
    #[arg(short, long, default_value = "config.yaml")]
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
}

pub struct AppState {
    pub registry: Registry,
    pub is_bootstrap: bool,
    pub bootstrap_urls: BootstrapUrls,
    pub local_address: String,
    pub max_ttl: u64,
    pub agent_config: AgentConfig,
}

impl AppState {
    pub fn current_timestamp() -> Timestamp {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("System time before UNIX epoch")
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
    /// Address in format "IP:PORT"
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
    /// List of all known addresses in the registry
    pub known_addresses: Vec<String>,
    /// List of all known bootstrap server URLs
    pub bootstrap_urls: Vec<String>,
}

/// Address information with last seen timestamp and agent details
#[derive(Serialize, Deserialize, ToSchema)]
pub struct AddressInfo {
    /// Address in format "IP:PORT"
    pub address: String,
    /// Seconds since last registration (0 for local address)
    pub last_seen_seconds: u64,
    /// Unique instance identifier
    pub instance_id: Option<String>,
    /// List of capability codes
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
    /// Registration time (seconds since UNIX epoch)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registration_time: Option<u64>,
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
