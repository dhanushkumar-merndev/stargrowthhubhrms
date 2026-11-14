use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use hrms_server::{
    app::{AppState, PROXY_SECRET_HEADER, router},
    config::Config,
};
use http_body_util::BodyExt;
use tower::ServiceExt;

const SECRET: &str = "test-proxy-secret-0123456789abcdef";

fn app() -> axum::Router {
    let config = Config::from_lookup(|k| match k {
        "APP_ORIGIN" => Some("https://web-hrms.vercel.app".into()),
        "PROXY_SECRET" => Some(SECRET.into()),
        "APP_SECRET" => Some("test-app-secret-fedcba9876543210fedcba".into()),
        _ => None,
    })
    .unwrap();
    router(AppState::new(config, None))
}

async fn send(req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, String) {
    let res = app().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes();
    (status, headers, String::from_utf8(body.to_vec()).unwrap())
}

#[tokio::test]
async fn healthz_is_public_and_cheap() {
    let (status, headers, body) = send(Request::get("/healthz").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, "ok");
    assert_eq!(headers["x-content-type-options"], "nosniff");
    assert_eq!(headers["cache-control"], "no-store");
    assert!(headers.contains_key("x-request-id"));
}

#[tokio::test]
async fn v1_without_proxy_secret_is_hidden() {
    let (status, _, _) = send(Request::get("/v1/ping").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn v1_with_wrong_proxy_secret_is_hidden() {
    let req = Request::get("/v1/ping")
        .header(PROXY_SECRET_HEADER, "test-proxy-secret-0123456789abcdeX")
        .body(Body::empty())
        .unwrap();
    let (status, _, _) = send(req).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn v1_with_proxy_secret_works() {
    let req = Request::get("/v1/ping")
        .header(PROXY_SECRET_HEADER, SECRET)
        .body(Body::empty())
        .unwrap();
    let (status, _, body) = send(req).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.contains("\"ok\":true"));
}

#[tokio::test]
async fn unknown_route_is_404() {
    let (status, _, _) = send(Request::get("/nope").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}
