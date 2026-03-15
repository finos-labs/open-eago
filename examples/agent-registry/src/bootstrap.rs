use crate::models::{AddressInfo, AgentDetails, BootstrapUrls, Config, RegisterRequest, RegisterResponse, Registry, SpireConfig};
use crate::registry::{learn_bootstrap_urls, merge_addresses};
use crate::tls::build_mtls_client;
use std::collections::{HashMap, HashSet};
use std::time::Duration;
use tracing::{error, info};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

pub async fn register_with_bootstrap(
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

pub async fn sync_from_bootstrap(
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
        learn_bootstrap_urls(&bootstrap_urls, &Some(urls.into_iter().collect()));
    }
}

async fn sync_with_all_bootstraps(
    urls: &[String],
    local_address: &str,
    agent: &AgentDetails,
    spire: &SpireConfig,
) -> (Vec<AddressInfo>, HashSet<String>) {
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

pub async fn initialize_registry(
    config: &Config,
    local_address: &str,
    allow_insecure: bool,
) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    if config.server.bootstrap {
        return init_as_bootstrap(local_address, &config.agent, &config.spire, allow_insecure);
    }

    init_as_node(config, local_address).await
}

fn init_as_bootstrap(
    local_address: &str,
    agent: &AgentDetails,
    spire: &SpireConfig,
    allow_insecure: bool,
) -> (HashMap<String, AgentDetails>, HashSet<String>) {
    let mut addresses = HashMap::new();
    addresses.insert(
        local_address.to_string(),
        agent.clone().stamp_now(),
    );

    let scheme = if allow_insecure && !std::path::Path::new(&spire.cert_path).exists() {
        "http"
    } else {
        "https"
    };
    let mut bootstrap_urls = HashSet::new();
    bootstrap_urls.insert(format!("{}://{}", scheme, local_address));

    info!("Initialized as bootstrap with local address: {}", local_address);
    (addresses, bootstrap_urls)
}

async fn init_as_node(
    config: &Config,
    local_address: &str,
) -> (HashMap<String, AgentDetails>, HashSet<String>) {
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
