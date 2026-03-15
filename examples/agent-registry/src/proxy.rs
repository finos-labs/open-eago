use crate::models::AppState;
use crate::tls::build_mtls_client_for_proxy;
use actix_web::{web, HttpRequest, HttpResponse};
use tracing::error;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

/// Actix-web handler that proxies the request to the mTLS HTTPS API backend.
/// Attached as `default_service` on the Swagger/dev HTTP server so every API
/// path that SwaggerUI calls is transparently forwarded with SPIRE certs.
pub async fn proxy_handler(
    req: HttpRequest,
    body: web::Bytes,
    api_https_url: web::Data<String>,
    app_state: web::Data<AppState>,
) -> HttpResponse {
    match forward_request(&req, body, api_https_url.get_ref(), &app_state).await {
        Ok(resp) => resp,
        Err(e) => {
            let mut msg = e.to_string();
            let mut src = e.source();
            while let Some(s) = src {
                msg.push_str("; ");
                msg.push_str(&s.to_string());
                src = s.source();
            }
            error!("mTLS proxy error: {}", msg);
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

    // Build a fresh mTLS client per request so we never reuse a connection to the backend.
    // The backend (actix OpenSSL) often closes the connection after each response; reusing
    // causes "error sending request" on the second call (e.g. /list after /health).
    let client = build_mtls_client_for_proxy(&state.spire)?;

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
