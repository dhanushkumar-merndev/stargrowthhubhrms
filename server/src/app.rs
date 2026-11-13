//! Router and cross-cutting middleware.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{Request, State},
    http::{HeaderName, HeaderValue, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::json;
use subtle::ConstantTimeEq;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};

use crate::config::Config;

pub const PROXY_SECRET_HEADER: &str = "x-proxy-secret";
const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
}

pub fn router(config: Config) -> Router {
    let state = AppState {
        config: Arc::new(config),
    };

    // Everything under /v1 is reachable only through the Vercel proxy.
    let v1 = Router::new()
        .route("/ping", get(ping))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_proxy));

    Router::new()
        // Liveness for UptimeRobot / Render. No database, no secrets, cheap.
        .route("/healthz", get(healthz))
        .nest("/v1", v1)
        .fallback(not_found)
        .with_state(state)
        .layer(CompressionLayer::new())
        .layer(SetResponseHeaderLayer::overriding(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::X_FRAME_OPTIONS,
            HeaderValue::from_static("DENY"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::REFERRER_POLICY,
            HeaderValue::from_static("no-referrer"),
        ))
        .layer(SetResponseHeaderLayer::overriding(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=63072000"),
        ))
        // API JSON is private; never let a browser or CDN cache it.
        .layer(SetResponseHeaderLayer::if_not_present(
            header::CACHE_CONTROL,
            HeaderValue::from_static("no-store"),
        ))
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(30),
        ))
        .layer(PropagateRequestIdLayer::new(REQUEST_ID_HEADER))
        .layer(TraceLayer::new_for_http())
        .layer(SetRequestIdLayer::new(REQUEST_ID_HEADER, MakeRequestUuid))
        .layer(CatchPanicLayer::new())
}

async fn healthz() -> &'static str {
    "ok"
}

async fn ping() -> Json<serde_json::Value> {
    Json(json!({ "ok": true, "version": env!("CARGO_PKG_VERSION") }))
}

async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

/// Rejects requests that did not come through our Vercel proxy.
/// Answers 404 (not 401) so the API surface is not advertised on onrender.com.
async fn require_proxy(State(state): State<AppState>, req: Request, next: Next) -> Response {
    let presented = req
        .headers()
        .get(PROXY_SECRET_HEADER)
        .map(|v| v.as_bytes())
        .unwrap_or_default();
    let expected = state.config.proxy_secret.as_bytes();
    if presented.ct_eq(expected).into() {
        next.run(req).await
    } else {
        not_found().await
    }
}
