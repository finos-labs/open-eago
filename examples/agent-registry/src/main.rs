mod bootstrap;
mod handlers;
mod models;
mod proxy;
mod registry;
mod server;
mod tls;

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use actix_web::web;
use clap::Parser;
use tracing::info;
use tracing_subscriber::{fmt, layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

use bootstrap::{initialize_registry, sync_from_bootstrap};
use models::{AgentDetails, AppState, Args, Config, Registry};
use registry::evict_stale_entries;
use server::{start_server, start_swagger_server};

const DEFAULT_LOCAL_IP: &str = "127.0.0.1";

fn get_local_ip() -> String {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .unwrap_or_else(|_| DEFAULT_LOCAL_IP.to_string())
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
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
    spawn_eviction_task(
        app_state.registry.clone(),
        local_address.clone(),
        config.server.max_ttl,
        config.server.removal_ttl,
    );

    let api_https_url = format!("https://127.0.0.1:{}", config.server.port);
    let swagger_port = config.server.swagger_port;

    info!("Starting {} mode on {}", 
        if config.server.bootstrap { "BOOTSTRAP" } else { "NODE" }, 
        local_address
    );

    let ((), ()) = tokio::try_join!(
        start_server(config.server.port, app_state.clone()),
        start_swagger_server(swagger_port, api_https_url, app_state),
    )?;
    Ok(())
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

    web::Data::new(AppState {
        registry: Arc::new(Mutex::new(addresses)),
        is_bootstrap: config.server.bootstrap,
        bootstrap_urls: Arc::new(Mutex::new(urls)),
        local_address,
        agent: config.agent,
        spire: config.spire,
        allow_insecure,
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

fn spawn_eviction_task(registry: Registry, local_address: String, quarantine_ttl: u64, removal_ttl: u64) {
    let interval_secs = (quarantine_ttl.min(removal_ttl) / 2).max(1);
    let interval = Duration::from_secs(interval_secs);
    tokio::spawn(async move {
        loop {
            let current_ts = AppState::current_timestamp();
            evict_stale_entries(&registry, &local_address, current_ts, quarantine_ttl, removal_ttl);
            tokio::time::sleep(interval).await;
        }
    });
}

