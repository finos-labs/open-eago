use crate::handlers::{health, list, register, update_status, ApiDoc};
use crate::models::AppState;
use crate::proxy::proxy_handler;
use crate::tls::load_spire_tls_config;
use actix_web::{web, App, HttpServer};
use tracing::{error, info, warn};
use utoipa::OpenApi;
use utoipa::openapi::server::Server;
use utoipa_swagger_ui::SwaggerUi;

pub async fn start_server(port: u16, app_state: web::Data<AppState>) -> std::io::Result<()> {
    let bind_addr = format!("0.0.0.0:{}", port);
    let is_bootstrap = app_state.is_bootstrap;
    let allow_insecure = app_state.allow_insecure;
    let spire = app_state.spire.clone();

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
            info!("Starting HTTPS server with SPIRE mTLS on {}", bind_addr);
            HttpServer::new(factory)
                .bind_openssl(&bind_addr, tls_acceptor)?
                .run()
                .await
        }
        Err(e) if allow_insecure => {
            warn!("SPIRE certificates unavailable: {}", e);
            warn!("--allow-insecure is set: starting HTTP server (development/testing only)");
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

pub async fn start_swagger_server(
    swagger_port: u16,
    api_https_url: String,
    app_state: web::Data<AppState>,
) -> std::io::Result<()> {
    let bind_addr = format!("127.0.0.1:{}", swagger_port);
    info!("Swagger UI  : http://{}/swagger-ui/", bind_addr);
    info!("mTLS proxy  : http://{}/* → {}", bind_addr, api_https_url);

    let mut openapi = ApiDoc::openapi();
    openapi.servers = Some(vec![Server::new("/")]);

    let api_https_url = web::Data::new(api_https_url);

    HttpServer::new(move || {
        App::new()
            .app_data(api_https_url.clone())
            .app_data(app_state.clone())
            .service(
                SwaggerUi::new("/swagger-ui/{_:.*}")
                    .urls(vec![("/api-docs/openapi.json".into(), openapi.clone())]),
            )
            .default_service(web::route().to(proxy_handler))
    })
    .bind(&bind_addr)?
    .run()
    .await
}
