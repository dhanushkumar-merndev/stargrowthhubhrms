//! Router, shared state and cross-cutting middleware.

use std::{sync::Arc, time::Duration};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, FromRequest, Request, State, rejection::JsonRejection},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{any, get, post},
};
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sqlx::PgPool;
use subtle::ConstantTimeEq;
use tower_http::{
    catch_panic::CatchPanicLayer,
    compression::CompressionLayer,
    request_id::{MakeRequestUuid, PropagateRequestIdLayer, SetRequestIdLayer},
    set_header::SetResponseHeaderLayer,
    timeout::TimeoutLayer,
    trace::TraceLayer,
};
use uuid::Uuid;

use crate::{
    auth::{self, token::CookieSpec},
    config::Config,
    error::{ApiError, ApiResult},
    rpc::Catalog,
};

pub const PROXY_SECRET_HEADER: &str = "x-proxy-secret";
pub const CLIENT_IP_HEADER: &str = "x-client-ip";
pub const REQUESTED_WITH_HEADER: &str = "x-requested-with";
const REQUEST_ID_HEADER: HeaderName = HeaderName::from_static("x-request-id");

/// Auth bodies are tiny; RPC bodies may carry bulk imports.
pub const AUTH_BODY_LIMIT: usize = 64 * 1024;
pub const RPC_BODY_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone)]
pub struct Db {
    pub pool: PgPool,
    pub catalog: Arc<Catalog>,
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub cookie: CookieSpec,
    /// None only in tests that exercise routing without a database.
    pub db: Option<Db>,
    /// Started on first use, on the serving runtime.
    live: Arc<tokio::sync::OnceCell<crate::live::Hub>>,
    /// Private object storage (R2 or a local folder). None = files are off.
    pub store: Option<Arc<crate::storage::Store>>,
}

impl AppState {
    pub fn new(config: Config, db: Option<Db>) -> Self {
        let cookie = CookieSpec::for_origin(&config.app_origin);
        Self {
            config: Arc::new(config),
            cookie,
            db,
            live: Arc::default(),
            store: None,
        }
    }

    pub fn with_store(mut self, store: Option<crate::storage::Store>) -> Self {
        self.store = store.map(Arc::new);
        self
    }

    pub async fn live_hub(&self) -> ApiResult<&crate::live::Hub> {
        let pool = self.db()?.pool.clone();
        Ok(self
            .live
            .get_or_init(|| async move { crate::live::Hub::spawn(pool) })
            .await)
    }

    pub fn db(&self) -> ApiResult<&Db> {
        self.db
            .as_ref()
            .ok_or_else(|| ApiError::unavailable("The service is starting. Please try again."))
    }
}

pub fn router(state: AppState) -> Router {
    let auth_routes = Router::new()
        .route("/auth/login", post(auth::routes::login))
        .route("/auth/logout", post(auth::routes::logout))
        .route("/auth/password", post(auth::routes::change_password))
        .route("/auth/reauth", post(auth::routes::reauth))
        .route("/admin/users", post(auth::routes::provision_user))
        .route(
            "/admin/users/{employee_id}/reset-password",
            post(auth::routes::reset_password),
        )
        .route("/punch", post(crate::punch::punch))
        .route("/punch/device", post(crate::punch::register_device))
        .layer(DefaultBodyLimit::max(AUTH_BODY_LIMIT));

    // Files carry their own 5 MB limit (checked while reading the body).
    let file_routes = Router::new()
        .route("/files", post(crate::files::upload))
        .route("/files/{version}", get(crate::files::download))
        .route("/device-photos/{punch}", get(crate::files::device_photo))
        .layer(DefaultBodyLimit::disable());

    let rpc_routes = Router::new()
        .route("/rpc/{name}", post(auth::routes::rpc))
        .layer(DefaultBodyLimit::max(RPC_BODY_LIMIT));

    // Everything under /v1 is reachable only through the Vercel proxy, and
    // state-changing requests must come from our own web origin (CSRF).
    let v1 = Router::new()
        .route("/ping", get(ping))
        .route("/live", get(crate::live::live))
        .merge(auth_routes)
        .merge(rpc_routes)
        .merge(file_routes)
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_same_origin,
        ))
        .route_layer(middleware::from_fn_with_state(state.clone(), require_proxy));

    Router::new()
        // Liveness for UptimeRobot / Render. No database, no secrets, cheap.
        .route("/healthz", get(healthz))
        .nest("/v1", v1)
        // Attendance machines call these directly (no proxy, no cookies).
        .route("/iclock/{endpoint}", any(crate::iclock::routes::handle))
        .route("/api/iclock/{endpoint}", any(crate::iclock::routes::handle))
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

async fn ping() -> Json<Value> {
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

/// CSRF defence for cookie auth, on top of SameSite=Lax: unsafe methods need
/// `Origin` equal to our web origin, or (when no Origin is sent) our custom
/// header, which cross-site forms cannot set. `Sec-Fetch-Site: cross-site` is
/// always refused.
async fn require_same_origin(State(state): State<AppState>, req: Request, next: Next) -> Response {
    if is_safe(req.method()) || origin_ok(req.headers(), &state.config.app_origin) {
        next.run(req).await
    } else {
        ApiError::new(
            StatusCode::FORBIDDEN,
            "ORIGIN_REJECTED",
            "This request did not come from the HRMS app.",
        )
        .into_response()
    }
}

fn is_safe(m: &Method) -> bool {
    matches!(*m, Method::GET | Method::HEAD | Method::OPTIONS)
}

pub fn origin_ok(headers: &HeaderMap, app_origin: &str) -> bool {
    if headers
        .get("sec-fetch-site")
        .is_some_and(|v| v.as_bytes() == b"cross-site")
    {
        return false;
    }
    match headers.get(header::ORIGIN) {
        Some(o) => o.as_bytes() == app_origin.as_bytes(),
        None => headers
            .get(REQUESTED_WITH_HEADER)
            .is_some_and(|v| v.as_bytes() == b"hrms-web"),
    }
}

/// The request id set by SetRequestIdLayer (a UUID unless a client sent junk).
pub fn request_id(headers: &HeaderMap) -> Uuid {
    headers
        .get(REQUEST_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| Uuid::parse_str(v).ok())
        .unwrap_or_else(Uuid::new_v4)
}

/// JSON body extractor whose failures use our error shape and status codes.
pub struct JsonBody<T>(pub T);

impl<S: Send + Sync, T: DeserializeOwned> FromRequest<S> for JsonBody<T> {
    type Rejection = ApiError;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        match Json::<T>::from_request(req, state).await {
            Ok(Json(v)) => Ok(Self(v)),
            Err(e) => Err(json_rejection(e)),
        }
    }
}

fn json_rejection(e: JsonRejection) -> ApiError {
    match e {
        JsonRejection::MissingJsonContentType(_) => ApiError::new(
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "UNSUPPORTED_MEDIA_TYPE",
            "Send JSON (Content-Type: application/json).",
        ),
        JsonRejection::BytesRejection(_) => ApiError::new(
            StatusCode::PAYLOAD_TOO_LARGE,
            "REQUEST_TOO_LARGE",
            "The request is too large.",
        ),
        JsonRejection::JsonSyntaxError(_) => ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_JSON",
            "The request body is not valid JSON.",
        ),
        _ => ApiError::validation("Some values are missing or have the wrong type."),
    }
}

/// `{"data": .., "version": null, "request_id": ..}` like the HRMS Edge Functions.
pub fn ok(data: Value, request_id: Uuid) -> Json<Value> {
    Json(json!({ "data": data, "version": null, "request_id": request_id }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(pairs: &[(&'static str, &'static str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(*k, HeaderValue::from_static(v));
        }
        m
    }

    const O: &str = "https://web-hrms.vercel.app";

    #[test]
    fn origin_rules() {
        assert!(origin_ok(&h(&[("origin", O)]), O));
        assert!(!origin_ok(&h(&[("origin", "https://evil.example")]), O));
        assert!(!origin_ok(
            &h(&[("origin", "https://web-hrms.vercel.app.evil.example")]),
            O
        ));
        assert!(!origin_ok(&h(&[("origin", "null")]), O));
        assert!(!origin_ok(&h(&[]), O), "no origin and no custom header");
        assert!(origin_ok(&h(&[("x-requested-with", "hrms-web")]), O));
        assert!(!origin_ok(&h(&[("x-requested-with", "XMLHttpRequest")]), O));
        assert!(!origin_ok(
            &h(&[("origin", O), ("sec-fetch-site", "cross-site")]),
            O
        ));
        assert!(origin_ok(
            &h(&[("origin", O), ("sec-fetch-site", "same-origin")]),
            O
        ));
        assert!(!origin_ok(
            &h(&[
                ("origin", "https://evil.example"),
                ("x-requested-with", "hrms-web")
            ]),
            O
        ));
    }

    #[test]
    fn request_id_falls_back_to_new_uuid() {
        let id = Uuid::new_v4();
        let mut m = HeaderMap::new();
        m.insert(
            "x-request-id",
            HeaderValue::from_str(&id.to_string()).unwrap(),
        );
        assert_eq!(request_id(&m), id);
        assert_ne!(
            request_id(&h(&[("x-request-id", "junk")])).to_string(),
            "junk"
        );
    }
}
