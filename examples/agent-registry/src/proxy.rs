use crate::models::AppState;
use crate::tls::build_mtls_client_for_proxy;
use actix_web::{web, HttpRequest, HttpResponse};
use tracing::error;

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const REQUEST_SKIP_HEADERS: &[&str] = &["host", "content-length", "transfer-encoding", "connection"];
const RESPONSE_SKIP_HEADERS: &[&str] = &["transfer-encoding", "connection"];

fn error_chain(e: &dyn std::error::Error) -> String {
    std::iter::successors(Some(e), |e| e.source())
        .map(|e| e.to_string())
        .collect::<Vec<_>>()
        .join("; ")
}

pub async fn proxy_handler(
    req: HttpRequest,
    body: web::Bytes,
    api_https_url: web::Data<String>,
    app_state: web::Data<AppState>,
) -> HttpResponse {
    match forward_request(&req, body, api_https_url.get_ref(), &app_state).await {
        Ok(resp) => resp,
        Err(e) => {
            error!("mTLS proxy error: {}", error_chain(&*e));
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
    let client = build_mtls_client_for_proxy(&state.spire)?;

    let method = reqwest::Method::from_bytes(req.method().as_str().as_bytes())
        .map_err(|e| format!("Unsupported HTTP method '{}': {}", req.method(), e))?;

    let mut fwd = client.request(method, &target_url);

    for (name, value) in req.headers() {
        let n = name.as_str();
        if !REQUEST_SKIP_HEADERS.contains(&n) {
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

    for (name, value) in backend_resp.headers() {
        let n = name.as_str();
        if !RESPONSE_SKIP_HEADERS.contains(&n) {
            resp.insert_header((n, value.as_bytes()));
        }
    }

    let resp_body = backend_resp.bytes().await
        .map_err(|e| format!("Failed to read backend response: {}", e))?;
    Ok(resp.body(resp_body))
}
