use crate::models::{
    AddressInfo, AgentDetails, AppState, DiscoverRequest, DiscoverResponse, HealthResponse,
    ListResponse, RegisterRequest, RegisterResponse, UpdateStatusRequest, UpdateStatusResponse,
};
use crate::registry::{
    cleanup_and_build_list, discover_agents, learn_bootstrap_urls, update_registry,
    validate_register_request, verify_caller_owns_address, RegistryUpdate, MAX_REGISTRY_ENTRIES,
};
use actix_web::{get, post, put, web, HttpRequest, HttpResponse, Responder};
use tracing::{info, instrument, warn};
use utoipa::OpenApi;

#[derive(OpenApi)]
#[openapi(
    paths(health, register, list, discover, update_status),
    components(schemas(
        HealthResponse, RegisterRequest, RegisterResponse, ListResponse,
        DiscoverRequest, DiscoverResponse,
        AddressInfo, AgentDetails, UpdateStatusRequest, UpdateStatusResponse
    )),
    tags(
        (name = "Health", description = "Health check endpoints"),
        (name = "Registry", description = "Address registry management")
    ),
    info(title = "OpenEAGO Registry API", version = "0.1.0")
)]
pub struct ApiDoc;

#[utoipa::path(
    get,
    path = "/health",
    responses((status = 200, description = "Service is healthy", body = HealthResponse)),
    tag = "Health"
)]
#[get("/health")]
pub async fn health() -> impl Responder {
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
pub async fn register(data: web::Data<AppState>, req: web::Json<RegisterRequest>) -> impl Responder {
    if !data.is_bootstrap {
        return HttpResponse::Forbidden().json(serde_json::json!({ "error": "Not a bootstrap server" }));
    }

    if let Some(err_resp) = validate_register_request(&req) {
        return err_resp;
    }

    let agent_details = req.agent_details.clone()
        .unwrap_or_else(AgentDetails::now);

    if let Err(e) = agent_details.validate() {
        return HttpResponse::BadRequest().json(serde_json::json!({"error": e}));
    }

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

#[utoipa::path(
    get,
    path = "/list",
    responses((status = 200, description = "List all registered addresses", body = ListResponse)),
    tag = "Registry"
)]
#[get("/list")]
#[instrument(skip(data))]
pub async fn list(data: web::Data<AppState>) -> impl Responder {
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

#[utoipa::path(
    post,
    path = "/discover",
    request_body = DiscoverRequest,
    responses(
        (status = 200, description = "Agents matching all filters", body = DiscoverResponse),
        (status = 400, description = "Invalid filter values")
    ),
    tag = "Registry"
)]
#[post("/discover")]
#[instrument(skip(data))]
pub async fn discover(data: web::Data<AppState>, req: web::Json<DiscoverRequest>) -> impl Responder {
    if let Some(rel) = req.min_reliability {
        if !(0.0..=1.0).contains(&rel) {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "min_reliability must be between 0.0 and 1.0"}));
        }
    }
    if let Some(up) = req.min_uptime_pct {
        if !(0.0..=100.0).contains(&up) {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "min_uptime_pct must be between 0.0 and 100.0"}));
        }
    }
    if let Some(lat) = req.max_latency_p99_ms {
        if lat < 0.0 {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({"error": "max_latency_p99_ms must not be negative"}));
        }
    }

    let current_ts = AppState::current_timestamp();
    let (agents, filtered_out) =
        discover_agents(&data.registry, &req, &data.local_address, current_ts);

    HttpResponse::Ok().json(DiscoverResponse {
        count: agents.len(),
        agents,
        filtered_out,
    })
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
pub async fn update_status(
    data: web::Data<AppState>,
    http_req: HttpRequest,
    req: web::Json<UpdateStatusRequest>,
) -> impl Responder {
    if let Err(e) = verify_caller_owns_address(&http_req, &req.address).await {
        warn!("Ownership check failed for {}: {}", req.address, e);
        return HttpResponse::Forbidden()
            .json(serde_json::json!({"error": format!("Forbidden: {}", e)}));
    }
    let mut validation_dummy = AgentDetails::default();
    validation_dummy.reliability = req.reliability;
    validation_dummy.uptime_percentage = req.uptime_percentage;
    if let Err(e) = validation_dummy.validate() {
        return HttpResponse::BadRequest().json(serde_json::json!({"error": e}));
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
        agent_details.last_seen = AppState::current_timestamp();

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
            reliability: agent_details.reliability,
            health_status: Some(agent_details.health_status.clone()),
            registration_time: agent_details.registration_time,
            uptime_percentage: agent_details.uptime_percentage,
        })
    } else {
        HttpResponse::NotFound().json(serde_json::json!({
            "error": format!("Address {} not found in registry", req.address)
        }))
    }
}
