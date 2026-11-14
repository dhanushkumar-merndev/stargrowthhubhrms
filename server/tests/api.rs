//! End-to-end API tests: real router, real Postgres (Supabase image), real
//! migrations run through sqlx exactly as in production.
//!
//!   tools/db_test.sh --empty
//!   HRMS_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:54330/postgres cargo test --test api
//!
//! Without HRMS_TEST_DATABASE_URL every test is skipped (prints SKIP).

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{HeaderMap, Method, Request, StatusCode, header},
};
use hrms_server::{
    app::{AppState, Db, PROXY_SECRET_HEADER, router},
    bootstrap,
    config::Config,
    db, rpc,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

const PROXY: &str = "test-proxy-secret-0123456789abcdef";
const ORIGIN: &str = "https://web-hrms.vercel.app";
const ADMIN_PW: &str = "Initial-Admin-Pass-42";
const NEW_PW: &str = "Brand-New-Secret-2026";
const INGEST: &str = "test-device-ingest-secret-0123456789abcdef";
const RELAY: &str = "test-device-relay-secret-fedcba9876543210";

static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

struct T {
    app: Router,
    pool: PgPool,
    ip: String,
    org: String,
    admin_code: String,
}

struct Resp {
    status: StatusCode,
    headers: HeaderMap,
    body: Value,
}

impl Resp {
    fn code(&self) -> &str {
        self.body["error"]["code"].as_str().unwrap_or("")
    }
    /// The session token from Set-Cookie (None if the cookie was cleared).
    fn session_cookie(&self) -> Option<String> {
        self.headers
            .get_all(header::SET_COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .find(|v| v.starts_with("__Host-hrms_session="))
            .and_then(|v| v.split(';').next())
            .map(str::to_owned)
            .filter(|c| c != "__Host-hrms_session=")
    }
    fn set_cookie(&self) -> String {
        self.headers
            .get(header::SET_COOKIE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_owned()
    }
}

macro_rules! setup {
    () => {
        match setup().await {
            Some(t) => t,
            None => {
                eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
                return;
            }
        }
    };
}

async fn setup() -> Option<T> {
    setup_with(None).await
}

async fn setup_with(store: Option<hrms_server::storage::Store>) -> Option<T> {
    let url = std::env::var("HRMS_TEST_DATABASE_URL").ok()?;
    let pool = db::connect(&url, 4).await.expect("connect");
    MIGRATED
        .get_or_init(|| async {
            db::migrate(&pool)
                .await
                .expect("migrations apply through sqlx")
        })
        .await;
    let catalog = Arc::new(rpc::Catalog::load(&pool).await.expect("catalog"));
    let config = Config::from_lookup(|k| match k {
        "APP_ORIGIN" => Some(ORIGIN.into()),
        "PROXY_SECRET" => Some(PROXY.into()),
        "APP_SECRET" => Some("test-app-secret-fedcba9876543210fedcba".into()),
        "DEVICE_INGEST_SECRET" => Some(INGEST.into()),
        "DEVICE_RELAY_SECRET" => Some(RELAY.into()),
        _ => None,
    })
    .unwrap();
    hrms_server::iclock::routes::configure(&pool, INGEST)
        .await
        .expect("device ingest configured");
    let app = router(
        AppState::new(
            config,
            Some(Db {
                pool: pool.clone(),
                catalog,
            }),
        )
        .with_store(store),
    );
    let tag = Uuid::new_v4().simple().to_string()[..8].to_uppercase();
    let t = T {
        app,
        pool,
        ip: format!("10.{}.{}.{}", rand_u8(), rand_u8(), rand_u8()),
        org: format!("T{tag}"),
        admin_code: "ADMIN1".into(),
    };
    bootstrap::run(
        &t.pool,
        &bootstrap::Input {
            org_code: t.org.clone(),
            org_name: "Test Org".into(),
            timezone: "Asia/Kolkata".into(),
            admin_code: t.admin_code.clone(),
            admin_name: "Test Admin".into(),
            admin_password: ADMIN_PW.into(),
            alias_domain: "staff.hrms.invalid".into(),
        },
    )
    .await
    .expect("bootstrap");
    Some(t)
}

fn rand_u8() -> u8 {
    Uuid::new_v4().as_bytes()[0]
}

impl T {
    fn base(&self, method: Method, path: &str) -> axum::http::request::Builder {
        Request::builder()
            .method(method)
            .uri(path)
            .header(PROXY_SECRET_HEADER, PROXY)
            .header(header::ORIGIN, ORIGIN)
            .header("x-client-ip", &self.ip)
            .header(header::USER_AGENT, "api-test")
    }

    async fn send(&self, req: Request<Body>) -> Resp {
        let res = self.app.clone().oneshot(req).await.unwrap();
        let status = res.status();
        let headers = res.headers().clone();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        let body = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        Resp {
            status,
            headers,
            body,
        }
    }

    async fn post(&self, path: &str, body: Value, cookie: Option<&str>) -> Resp {
        let mut b = self
            .base(Method::POST, path)
            .header(header::CONTENT_TYPE, "application/json");
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        self.send(b.body(Body::from(body.to_string())).unwrap())
            .await
    }

    async fn login(&self, code: &str, pw: &str) -> Resp {
        self.post(
            "/v1/auth/login",
            json!({ "org_code": self.org, "employee_code": code, "password": pw }),
            None,
        )
        .await
    }

    async fn rpc(&self, name: &str, args: Value, cookie: &str) -> Resp {
        self.post(&format!("/v1/rpc/{name}"), args, Some(cookie))
            .await
    }

    async fn change_password(&self, cookie: &str, current: &str, next: &str) -> Resp {
        self.post(
            "/v1/auth/password",
            json!({ "operation_id": Uuid::new_v4(), "current_password": current, "new_password": next }),
            Some(cookie),
        )
        .await
    }

    /// Admin signed in with a permanent password (business mode).
    async fn admin(&self) -> String {
        let r = self.login(&self.admin_code, ADMIN_PW).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let c = r.session_cookie().unwrap();
        let r = self.change_password(&c, ADMIN_PW, NEW_PW).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.session_cookie().unwrap()
    }

    async fn org_ids(&self) -> (Uuid, Uuid, Uuid, Uuid) {
        let org: Uuid = sqlx::query_scalar("select id from hrms.organizations where code = $1")
            .bind(&self.org)
            .fetch_one(&self.pool)
            .await
            .unwrap();
        let team: Uuid = sqlx::query_scalar("select id from hrms.teams where org_id = $1 limit 1")
            .bind(org)
            .fetch_one(&self.pool)
            .await
            .unwrap();
        let shift: Uuid =
            sqlx::query_scalar("select id from hrms.shifts where org_id = $1 limit 1")
                .bind(org)
                .fetch_one(&self.pool)
                .await
                .unwrap();
        let office: Uuid = sqlx::query_scalar(
            "with ins as (
               insert into hrms.offices (org_id, name, timezone, location)
               values ($1, 'HQ', 'Asia/Kolkata', 'SRID=4326;POINT(77.6 12.9)'::extensions.geography)
               on conflict (org_id, name) do nothing returning id)
             select id from ins union all select id from hrms.offices where org_id = $1 and name = 'HQ' limit 1",
        )
        .bind(org)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        (org, team, shift, office)
    }

    /// Admin provisions an employee; returns (employee_id, temporary password).
    async fn hire(&self, admin: &str, code: &str, role: Option<&str>) -> (Uuid, String) {
        let (_, team, shift, office) = self.org_ids().await;
        let r = self
            .post(
                "/v1/admin/users",
                json!({
                    "operation_id": Uuid::new_v4(),
                    "fields": {
                        "employee_code": code, "full_name": format!("Person {code}"), "join_date": "2026-01-05",
                        "team_id": team, "office_id": office, "shift_id": shift, "role": role,
                    }
                }),
                Some(admin),
            )
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        (
            r.body["data"]["employee_id"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            r.body["data"]["temporary_password"]
                .as_str()
                .unwrap()
                .to_owned(),
        )
    }
}

// ============================================================== login

#[tokio::test]
async fn login_sets_hardened_cookie_and_flags_temporary_password() {
    let t = setup!();
    let r = t.login(&t.admin_code, ADMIN_PW).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let sc = r.set_cookie();
    assert!(sc.starts_with("__Host-hrms_session="), "{sc}");
    for flag in [
        "Path=/",
        "HttpOnly",
        "SameSite=Lax",
        "Secure",
        "Max-Age=2592000",
    ] {
        assert!(sc.contains(flag), "missing {flag} in {sc}");
    }
    assert!(!sc.contains("Domain"), "{sc}");
    assert_eq!(r.body["data"]["must_change_password"], true);
    assert_eq!(r.body["data"]["credential_hold"], false);
    assert!(r.body["request_id"].is_string());
    // The token never appears in the body.
    let token = r.session_cookie().unwrap();
    assert!(
        !r.body
            .to_string()
            .contains(token.split('=').nth(1).unwrap())
    );
}

#[tokio::test]
async fn login_is_case_and_space_insensitive_for_codes() {
    let t = setup!();
    let r = t
        .post(
            "/v1/auth/login",
            json!({ "org_code": t.org.to_lowercase(), "employee_code": "  admin1 ", "password": ADMIN_PW }),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

#[tokio::test]
async fn login_failures_are_generic() {
    let t = setup!();
    let cases = [
        json!({ "org_code": t.org, "employee_code": t.admin_code, "password": "wrong-password-123" }),
        json!({ "org_code": t.org, "employee_code": "NOBODY9", "password": ADMIN_PW }),
        json!({ "org_code": "NOORG", "employee_code": t.admin_code, "password": ADMIN_PW }),
        json!({ "org_code": t.org, "employee_code": "", "password": ADMIN_PW }),
        json!({ "org_code": t.org, "employee_code": t.admin_code, "password": "" }),
        json!({ "org_code": t.org, "employee_code": t.admin_code }),
        json!({ "org_code": t.org, "employee_code": t.admin_code, "password": "x".repeat(257) }),
        json!({}),
    ];
    for body in cases {
        let r = t.post("/v1/auth/login", body.clone(), None).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{body} -> {}", r.body);
        assert_eq!(r.code(), "AUTH_FAILED");
        assert_eq!(
            r.body["error"]["message"],
            "Employee ID or password is incorrect."
        );
        assert!(r.session_cookie().is_none());
    }
}

#[tokio::test]
async fn login_wrong_types_and_bad_json() {
    let t = setup!();
    let r = t
        .post(
            "/v1/auth/login",
            json!({ "employee_code": 123, "password": true }),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let req = t
        .base(Method::POST, "/v1/auth/login")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{not json"))
        .unwrap();
    let r = t.send(req).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "INVALID_JSON")
    );
    let req = t
        .base(Method::POST, "/v1/auth/login")
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("{}"))
        .unwrap();
    let r = t.send(req).await;
    assert_eq!(r.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
}

#[tokio::test]
async fn login_body_over_64kb_is_rejected() {
    let t = setup!();
    let big = json!({ "employee_code": "ADMIN1", "password": "x".repeat(70_000) });
    let r = t.post("/v1/auth/login", big, None).await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE, "{}", r.body);
}

#[tokio::test]
async fn five_failures_lock_the_account_even_for_the_right_password() {
    let t = setup!();
    for _ in 0..5 {
        let r = t.login(&t.admin_code, "wrong-password-123").await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let r = t.login(&t.admin_code, ADMIN_PW).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);
    assert_eq!(r.code(), "RATE_LIMITED");
    assert_eq!(r.headers["retry-after"], "30");
    assert!(r.session_cookie().is_none());
    let failures: i64 = sqlx::query_scalar(
        "select count(*) from hrms.security_events s join hrms.organizations o on o.id = s.org_id
         where o.code = $1 and s.kind = 'auth.login_failed'",
    )
    .bind(&t.org)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(failures, 5, "each failure is a security event");
}

#[tokio::test]
async fn one_ip_is_limited_across_accounts() {
    let t = setup!();
    for i in 0..30 {
        let r = t.login(&format!("NOBODY{i}"), "wrong-password-123").await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    }
    let r = t.login(&t.admin_code, ADMIN_PW).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS);
}

// ============================================================== sessions

#[tokio::test]
async fn missing_malformed_or_foreign_cookies_are_401() {
    let t = setup!();
    let r = t.rpc("get_session_context", json!({}), "").await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::UNAUTHORIZED, "AUTH_REQUIRED")
    );
    for c in [
        "__Host-hrms_session=short".to_string(),
        format!("__Host-hrms_session={}", "A".repeat(43)),
        format!("__Host-hrms_session={}'", "A".repeat(42)),
    ] {
        let r = t.rpc("get_session_context", json!({}), &c).await;
        assert_eq!(r.status, StatusCode::UNAUTHORIZED, "{c}");
    }
    // A real token under the non-prefixed name is ignored on https.
    let good = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let plain = good.replace("__Host-hrms_session", "hrms_session");
    let r = t.rpc("get_session_context", json!({}), &plain).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn temporary_password_session_is_restricted() {
    let t = setup!();
    let c = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let r = t.rpc("get_session_context", json!({}), &c).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["must_change_password"], true, "{}", r.body);
    let r = t.rpc("get_my_profile", json!({}), &c).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "PASSWORD_CHANGE_REQUIRED")
    );
    // Restricted users may still manage their own devices.
    let r = t.rpc("list_my_sessions", json!({}), &c).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
}

#[tokio::test]
async fn logout_kills_the_session_and_is_idempotent() {
    let t = setup!();
    let c = t.admin().await;
    let r = t.post("/v1/auth/logout", json!({}), Some(&c)).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.set_cookie().contains("Max-Age=0"));
    let r = t.rpc("get_session_context", json!({}), &c).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // Again, and with no cookie at all: still 200 and still clears.
    assert_eq!(
        t.post("/v1/auth/logout", json!({}), Some(&c)).await.status,
        StatusCode::OK
    );
    let r = t.post("/v1/auth/logout", json!({}), None).await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(r.set_cookie().contains("Max-Age=0"));
}

#[tokio::test]
async fn expired_or_idle_sessions_are_401_and_removed() {
    let t = setup!();
    let c = t.admin().await;
    sqlx::query(
        "update iam.sessions set not_after = now() - interval '1 second'
         where user_id = (select auth_user_id from hrms.employees e join hrms.organizations o on o.id = e.org_id
                          where o.code = $1 and e.employee_code = 'ADMIN1')",
    )
    .bind(&t.org)
    .execute(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &c).await.status,
        StatusCode::UNAUTHORIZED
    );

    let c = t
        .login(&t.admin_code, NEW_PW)
        .await
        .session_cookie()
        .unwrap();
    sqlx::query(
        "update iam.sessions set last_seen_at = now() - interval '15 days'
         where user_id = (select auth_user_id from hrms.employees e join hrms.organizations o on o.id = e.org_id
                          where o.code = $1 and e.employee_code = 'ADMIN1')",
    )
    .bind(&t.org)
    .execute(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &c).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn ending_other_sessions_signs_out_other_devices_only() {
    let t = setup!();
    let a = t.admin().await;
    let b = t
        .login(&t.admin_code, NEW_PW)
        .await
        .session_cookie()
        .unwrap();
    let r = t.rpc("list_my_sessions", json!({}), &a).await;
    assert_eq!(r.body["data"].as_array().unwrap().len(), 2);
    let r = t.rpc("end_my_other_sessions", json!({}), &a).await;
    assert_eq!(r.body["data"]["ended"], 1, "{}", r.body);
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &a).await.status,
        StatusCode::OK
    );
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &b).await.status,
        StatusCode::UNAUTHORIZED
    );
}

// ============================================================== CSRF / proxy

#[tokio::test]
async fn cross_site_and_unproxied_requests_are_refused() {
    let t = setup!();
    let body = json!({ "org_code": t.org, "employee_code": t.admin_code, "password": ADMIN_PW })
        .to_string();
    let post = |origin: Option<&str>, extra: Option<(&'static str, &'static str)>| {
        let mut b = Request::post("/v1/auth/login")
            .header(PROXY_SECRET_HEADER, PROXY)
            .header(header::CONTENT_TYPE, "application/json")
            .header("x-client-ip", &t.ip);
        if let Some(o) = origin {
            b = b.header(header::ORIGIN, o);
        }
        if let Some((k, v)) = extra {
            b = b.header(k, v);
        }
        b.body(Body::from(body.clone())).unwrap()
    };
    let r = t.send(post(Some("https://evil.example"), None)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "ORIGIN_REJECTED")
    );
    let r = t.send(post(None, None)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .send(post(Some(ORIGIN), Some(("sec-fetch-site", "cross-site"))))
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .send(post(None, Some(("x-requested-with", "hrms-web"))))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    let req = Request::post("/v1/auth/login")
        .header(header::ORIGIN, ORIGIN)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.clone()))
        .unwrap();
    assert_eq!(
        t.send(req).await.status,
        StatusCode::NOT_FOUND,
        "no proxy secret: hidden"
    );
}

// ============================================================== RPC gateway

#[tokio::test]
async fn rpc_gateway_edges() {
    let t = setup!();
    let c = t.admin().await;
    for name in [
        "internal_login_lookup",
        "internal_rate_limit",
        "nope_not_a_function",
        "Get_My_Profile",
    ] {
        let r = t.rpc(name, json!({}), &c).await;
        assert_eq!(r.status, StatusCode::NOT_FOUND, "{name}");
    }
    let r = t.rpc("get_my_profile", json!({ "p_bogus": 1 }), &c).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(r.body["error"]["field_errors"]["p_bogus"], "unknown");
    let r = t.rpc("end_my_session", json!({}), &c).await;
    assert_eq!(
        r.body["error"]["field_errors"]["p_session_id"], "required",
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "end_my_session",
            json!({ "p_session_id": "not-a-uuid" }),
            &c,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    let r = t.rpc("get_my_profile", json!([1, 2]), &c).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Empty body is allowed for no-argument functions.
    let req = t
        .base(Method::POST, "/v1/rpc/get_my_profile")
        .header(header::COOKIE, &c)
        .body(Body::empty())
        .unwrap();
    let r = t.send(req).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["data"].is_object());
    let req = t
        .base(Method::POST, "/v1/rpc/get_my_profile")
        .header(header::COOKIE, &c)
        .header(header::CONTENT_TYPE, "text/plain")
        .body(Body::from("{}"))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let req = t
        .base(Method::POST, "/v1/rpc/get_my_profile")
        .header(header::COOKIE, &c)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{"))
        .unwrap();
    assert_eq!(t.send(req).await.status, StatusCode::BAD_REQUEST);
    // SQL text in values is just data.
    let r = t
        .rpc(
            "end_my_session",
            json!({ "p_session_id": "00000000-0000-0000-0000-000000000000'; drop table x;--" }),
            &c,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &c).await.status,
        StatusCode::OK
    );
}

// ============================================================== password change

#[tokio::test]
async fn password_change_rules() {
    let t = setup!();
    let c = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let cases = [
        (
            json!({ "current_password": ADMIN_PW, "new_password": NEW_PW }),
            "operation_id",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "new_password": NEW_PW }),
            "current_password",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "current_password": ADMIN_PW, "new_password": "short" }),
            "new_password",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "current_password": ADMIN_PW, "new_password": "my-admin1-password" }),
            "new_password",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "current_password": ADMIN_PW, "new_password": "zzzzzzzzzzzzzzzz" }),
            "new_password",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "current_password": ADMIN_PW, "new_password": ADMIN_PW }),
            "new_password",
        ),
        (
            json!({ "operation_id": Uuid::new_v4(), "current_password": "not-my-password", "new_password": NEW_PW }),
            "current_password",
        ),
    ];
    for (body, field) in cases {
        let r = t.post("/v1/auth/password", body.clone(), Some(&c)).await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{body} -> {}",
            r.body
        );
        assert!(
            r.body["error"]["field_errors"][field].is_string(),
            "{body} -> {}",
            r.body
        );
    }
    // A wrong current password released the hold, so a real change still works.
    let r = t.change_password(&c, ADMIN_PW, NEW_PW).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["status"], "completed");
    let fresh = r.session_cookie().expect("a fresh session");
    assert_ne!(fresh, c);
    assert_eq!(
        t.rpc("get_session_context", json!({}), &c).await.status,
        StatusCode::UNAUTHORIZED,
        "old session is dead"
    );
    assert_eq!(
        t.rpc("get_my_profile", json!({}), &fresh).await.status,
        StatusCode::OK,
        "now business mode"
    );
    assert_eq!(
        t.login(&t.admin_code, ADMIN_PW).await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = t.login(&t.admin_code, NEW_PW).await;
    assert_eq!(r.body["data"]["must_change_password"], false);
}

#[tokio::test]
async fn password_change_signs_out_every_other_device() {
    let t = setup!();
    let phone = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let laptop = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let r = t.change_password(&laptop, ADMIN_PW, NEW_PW).await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        t.rpc("get_session_context", json!({}), &phone).await.status,
        StatusCode::UNAUTHORIZED
    );
}

#[tokio::test]
async fn password_change_needs_a_session() {
    let t = setup!();
    let r = t
        .post(
            "/v1/auth/password",
            json!({ "operation_id": Uuid::new_v4(), "current_password": ADMIN_PW, "new_password": NEW_PW }),
            None,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

// ============================================================== reauth

#[tokio::test]
async fn reauth_edges() {
    let t = setup!();
    let c = t.admin().await;
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "password": NEW_PW, "action": "delete.everything" }),
            Some(&c),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::UNPROCESSABLE_ENTITY, "VALIDATION_FAILED")
    );
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "action": "export.annual" }),
            Some(&c),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "password": NEW_PW, "action": "export.annual" }),
            Some(&c),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["data"]["grant_id"].is_string());
    for _ in 0..4 {
        let r = t
            .post(
                "/v1/auth/reauth",
                json!({ "password": "wrong-password-1", "action": "export.annual" }),
                Some(&c),
            )
            .await;
        assert_eq!(
            (r.status, r.code()),
            (StatusCode::FORBIDDEN, "REAUTH_REQUIRED")
        );
    }
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "password": NEW_PW, "action": "export.annual" }),
            Some(&c),
        )
        .await;
    assert_eq!(
        r.status,
        StatusCode::TOO_MANY_REQUESTS,
        "6th attempt in 15 min: {}",
        r.body
    );
}

#[tokio::test]
async fn reauth_needs_business_mode() {
    let t = setup!();
    let c = t
        .login(&t.admin_code, ADMIN_PW)
        .await
        .session_cookie()
        .unwrap();
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "password": ADMIN_PW, "action": "export.annual" }),
            Some(&c),
        )
        .await;
    assert_eq!(r.code(), "PASSWORD_CHANGE_REQUIRED", "{}", r.body);
}

// ============================================================== provisioning

#[tokio::test]
async fn admin_provisions_an_employee_who_must_change_password() {
    let t = setup!();
    let admin = t.admin().await;
    let (_, temp) = t.hire(&admin, "EMP100", None).await;
    assert_eq!(temp.len(), 16);
    let r = t.login("EMP100", &temp).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["must_change_password"], true);
    let emp = r.session_cookie().unwrap();
    let r = t.change_password(&emp, &temp, "Employee-Own-Pass-77").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // An Employee cannot provision or reset anyone.
    let emp = r.session_cookie().unwrap();
    let (_, team, shift, office) = t.org_ids().await;
    let r = t
        .post(
            "/v1/admin/users",
            json!({ "operation_id": Uuid::new_v4(), "fields": {
                "employee_code": "EMP101", "full_name": "X", "join_date": "2026-01-05",
                "team_id": team, "office_id": office, "shift_id": shift } }),
            Some(&emp),
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "ACCESS_DENIED"),
        "{}",
        r.body
    );
}

#[tokio::test]
async fn provisioning_is_idempotent_per_operation() {
    let t = setup!();
    let admin = t.admin().await;
    let (_, team, shift, office) = t.org_ids().await;
    let op = Uuid::new_v4();
    let body = json!({ "operation_id": op, "fields": {
        "employee_code": "EMP200", "full_name": "Retry Person", "join_date": "2026-01-05",
        "team_id": team, "office_id": office, "shift_id": shift } });
    let first = t.post("/v1/admin/users", body.clone(), Some(&admin)).await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.body);
    let again = t.post("/v1/admin/users", body, Some(&admin)).await;
    assert_eq!(again.status, StatusCode::OK, "{}", again.body);
    assert_eq!(again.body["data"]["already"], true);
    assert!(
        again.body["data"]["temporary_password"].is_null(),
        "the password is shown once"
    );
    assert_eq!(
        again.body["data"]["employee_id"],
        first.body["data"]["employee_id"]
    );
}

#[tokio::test]
async fn provisioning_validation() {
    let t = setup!();
    let admin = t.admin().await;
    let r = t
        .post("/v1/admin/users", json!({ "fields": {} }), Some(&admin))
        .await;
    assert_eq!(r.body["error"]["field_errors"]["operation_id"], "required");
    let r = t
        .post(
            "/v1/admin/users",
            json!({ "operation_id": Uuid::new_v4(), "fields": "nope" }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t
        .post(
            "/v1/admin/users",
            json!({ "operation_id": Uuid::new_v4(), "fields": {} }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert!(
        r.body["error"]["field_errors"]
            .as_object()
            .is_some_and(|m| !m.is_empty()),
        "{}",
        r.body
    );
    // Duplicate employee code.
    t.hire(&admin, "EMP300", None).await;
    let (_, team, shift, office) = t.org_ids().await;
    let r = t
        .post(
            "/v1/admin/users",
            json!({ "operation_id": Uuid::new_v4(), "fields": {
                "employee_code": "emp300", "full_name": "Dup", "join_date": "2026-01-05",
                "team_id": team, "office_id": office, "shift_id": shift } }),
            Some(&admin),
        )
        .await;
    assert!(r.status.is_client_error(), "{}", r.body);
}

#[tokio::test]
async fn hr_cannot_create_admins() {
    let t = setup!();
    let admin = t.admin().await;
    let (_, temp) = t.hire(&admin, "HR0001", Some("hr")).await;
    let c = t.login("HR0001", &temp).await.session_cookie().unwrap();
    let hr = t
        .change_password(&c, &temp, "Hr-Person-Pass-2026")
        .await
        .session_cookie()
        .unwrap();
    let (_, team, shift, office) = t.org_ids().await;
    let r = t
        .post(
            "/v1/admin/users",
            json!({ "operation_id": Uuid::new_v4(), "fields": {
                "employee_code": "ADM002", "full_name": "Sneaky", "join_date": "2026-01-05",
                "team_id": team, "office_id": office, "shift_id": shift, "role": "admin" } }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.code(), "ACCESS_DENIED", "{}", r.body);
    // HR can create a regular employee.
    let (_, temp2) = t.hire(&hr, "EMP400", None).await;
    assert_eq!(temp2.len(), 16);
}

// ============================================================== admin reset

#[tokio::test]
async fn admin_reset_replaces_password_and_signs_the_person_out() {
    let t = setup!();
    let admin = t.admin().await;
    let (emp_id, temp) = t.hire(&admin, "EMP500", None).await;
    let c = t.login("EMP500", &temp).await.session_cookie().unwrap();
    let emp = t
        .change_password(&c, &temp, "Employee-Own-Pass-77")
        .await
        .session_cookie()
        .unwrap();

    let op = Uuid::new_v4();
    let path = format!("/v1/admin/users/{emp_id}/reset-password");
    let r = t
        .post(&path, json!({ "operation_id": op }), Some(&admin))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let reset_pw = r.body["data"]["temporary_password"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        t.rpc("get_session_context", json!({}), &emp).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.login("EMP500", "Employee-Own-Pass-77").await.status,
        StatusCode::UNAUTHORIZED
    );
    let r = t.login("EMP500", &reset_pw).await;
    assert_eq!(r.body["data"]["must_change_password"], true, "{}", r.body);
    // Same operation again: refused, never a second password.
    let r = t
        .post(&path, json!({ "operation_id": op }), Some(&admin))
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    // The person got an inbox notification.
    let n: i64 = sqlx::query_scalar("select count(*) from hrms.notifications where recipient_id = $1 and kind = 'credentials.reset'")
        .bind(emp_id)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
}

#[tokio::test]
async fn reset_edges() {
    let t = setup!();
    let admin = t.admin().await;
    let admin_id: Uuid = sqlx::query_scalar(
        "select e.id from hrms.employees e join hrms.organizations o on o.id = e.org_id where o.code = $1 and e.employee_code = 'ADMIN1'",
    )
    .bind(&t.org)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    let r = t
        .post(
            &format!("/v1/admin/users/{admin_id}/reset-password"),
            json!({ "operation_id": Uuid::new_v4() }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.code(), "ACCESS_DENIED", "no self reset: {}", r.body);
    let r = t
        .post(
            "/v1/admin/users/not-a-uuid/reset-password",
            json!({ "operation_id": Uuid::new_v4() }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .post(
            &format!("/v1/admin/users/{}/reset-password", Uuid::new_v4()),
            json!({ "operation_id": Uuid::new_v4() }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.code(), "ACCESS_DENIED", "unknown person: {}", r.body);
    let r = t
        .post(
            &format!("/v1/admin/users/{admin_id}/reset-password"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert_eq!(r.body["error"]["field_errors"]["operation_id"], "required");
}

#[tokio::test]
async fn deactivated_people_are_signed_out() {
    let t = setup!();
    let admin = t.admin().await;
    let (emp_id, temp) = t.hire(&admin, "EMP600", None).await;
    let c = t.login("EMP600", &temp).await.session_cookie().unwrap();
    sqlx::query(
        "update hrms.employees set status = 'inactive', end_date = current_date where id = $1",
    )
    .bind(emp_id)
    .execute(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        t.rpc("get_session_context", json!({}), &c).await.status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.login("EMP600", &temp).await.status,
        StatusCode::UNAUTHORIZED
    );
}

// ============================================================== bootstrap

#[tokio::test]
async fn bootstrap_is_idempotent_and_never_resets_the_admin() {
    let t = setup!();
    let input = bootstrap::Input {
        org_code: t.org.clone(),
        org_name: "Test Org".into(),
        timezone: "Asia/Kolkata".into(),
        admin_code: t.admin_code.clone(),
        admin_name: "Test Admin".into(),
        admin_password: "A-Different-Password-1".into(),
        alias_domain: "staff.hrms.invalid".into(),
    };
    let v = bootstrap::run(&t.pool, &input).await.unwrap();
    assert_eq!(v["already"], true);
    assert_eq!(
        t.login(&t.admin_code, ADMIN_PW).await.status,
        StatusCode::OK,
        "old password still works"
    );
    let weak = bootstrap::Input {
        admin_password: "short".into(),
        ..input.clone()
    };
    assert!(bootstrap::run(&t.pool, &weak).await.is_err());
    let second = bootstrap::Input {
        admin_code: "ADMIN2".into(),
        ..input
    };
    assert!(
        bootstrap::run(&t.pool, &second).await.is_err(),
        "one bootstrap Admin per org"
    );
}

// ============================================================== jobs

#[tokio::test]
async fn background_jobs_run_once_per_interval() {
    let t = setup!();
    sqlx::query("delete from hrms.job_runs")
        .execute(&t.pool)
        .await
        .unwrap();
    let first = hrms_server::jobs::run_due(&t.pool).await;
    for name in ["maintenance.tick", "live_events.purge", "sessions.purge"] {
        assert!(
            first.contains(&name),
            "{name} should run on start: {first:?}"
        );
    }
    let second = hrms_server::jobs::run_due(&t.pool).await;
    assert!(
        second.is_empty(),
        "nothing is due a second time: {second:?}"
    );
    let failed: i64 =
        sqlx::query_scalar("select coalesce(sum(failures), 0)::bigint from hrms.job_runs")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(failed, 0, "every job succeeded against the real schema");
    let ok: i64 =
        sqlx::query_scalar("select count(*) from hrms.job_runs where last_ok_at is not null")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(ok as usize, first.len());
}

// ============================================================== web punching

use hrms_server::webauthn::{self, testkit::Authenticator};

struct Puncher {
    cookie: String,
    employee_id: Uuid,
    instance: Uuid,
    office: Uuid,
}

impl T {
    /// A hired employee with a changed password and a shift instance around now.
    async fn puncher(&self, admin: &str, code: &str) -> Puncher {
        let (employee_id, temp) = self.hire(admin, code, None).await;
        let r = self.login(code, &temp).await;
        let c = r.session_cookie().unwrap();
        let r = self.change_password(&c, &temp, NEW_PW).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let cookie = r.session_cookie().unwrap();
        let (org, _, _, office) = self.org_ids().await;
        let instance: Uuid = sqlx::query_scalar(
            "insert into hrms.work_schedule_instances (org_id, employee_id, shift_date, kind, is_required, office_id,
               shift_version_id, timezone, start_at, end_at, lunch_paid, grace_seconds, early_entry_seconds, early_credit,
               checkout_extension_seconds, expected_seconds, half_split_at)
             select $1, $2, date '2031-01-01', 'workday', true, $3, sv.id, 'Asia/Kolkata', now() - interval '1 hour',
                    now() + interval '8 hours', true, 1800, 1800, false, 7200, 32400, now() + interval '3 hours'
             from hrms.shift_versions sv where sv.org_id = $1 limit 1 returning id",
        )
        .bind(org)
        .bind(employee_id)
        .bind(office)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        Puncher {
            cookie,
            employee_id,
            instance,
            office,
        }
    }

    async fn register_passkey(&self, p: &Puncher, a: &Authenticator) -> Resp {
        let ch = self
            .rpc("create_device_challenge", json!({}), &p.cookie)
            .await;
        assert_eq!(ch.status, StatusCode::OK, "{}", ch.body);
        let (id, nonce) = (
            ch.body["data"]["challenge_id"].as_str().unwrap(),
            ch.body["data"]["nonce"].as_str().unwrap(),
        );
        let (cd, ad) = a.register(&webauthn::registration_challenge(id, nonce));
        self.post(
            "/v1/punch/device",
            json!({
                "challenge_id": id, "nonce": nonce, "credential_id": webauthn::b64url(&a.credential_id),
                "client_data_json": webauthn::b64url(&cd), "authenticator_data": webauthn::b64url(&ad),
                "device_label": "Test browser",
            }),
            Some(&p.cookie),
        )
        .await
    }

    /// Builds a signed punch body (fresh challenge, location at the HQ point).
    async fn punch_body(
        &self,
        p: &Puncher,
        a: &mut Authenticator,
        device: &str,
        action: &str,
        target: Uuid,
    ) -> Value {
        let ch = self
            .rpc(
                "create_punch_challenge",
                json!({ "p_action": action, "p_target_id": target, "p_device_id": device }),
                &p.cookie,
            )
            .await;
        assert_eq!(ch.status, StatusCode::OK, "{}", ch.body);
        let mut body = json!({
            "operation_key": Uuid::new_v4(),
            "challenge_id": ch.body["data"]["challenge_id"],
            "nonce": ch.body["data"]["nonce"],
            "action": action,
            "target_id": target,
            "device_id": device,
            "office_id": p.office,
            "employee_id": p.employee_id,
            "latitude": "12.9000000",
            "longitude": "77.6000000",
            "accuracy": "5.00",
            "sample_at_ms": (chrono::Utc::now().timestamp_millis() - 1000).to_string(),
            "credential_id": webauthn::b64url(&a.credential_id),
            "client_data_json": "", "authenticator_data": "", "signature": "",
        });
        sign(&mut body, a);
        body
    }
}

fn payload_of(b: &Value) -> String {
    let s = |k: &str| b[k].as_str().unwrap().to_owned();
    [
        "hrms-punch-v1".to_owned(),
        s("challenge_id").to_lowercase(),
        s("nonce"),
        b["operation_key"].as_str().unwrap().to_lowercase(),
        b["employee_id"].as_str().unwrap().to_lowercase(),
        s("device_id").to_lowercase(),
        s("action"),
        b["target_id"].as_str().unwrap().to_lowercase(),
        b["office_id"].as_str().unwrap().to_lowercase(),
        s("latitude"),
        s("longitude"),
        s("accuracy"),
        s("sample_at_ms"),
    ]
    .join("\n")
}

fn sign(body: &mut Value, a: &mut Authenticator) {
    let (cd, ad, sig) = a.assert(&webauthn::punch_challenge(&payload_of(body)));
    body["client_data_json"] = json!(webauthn::b64url(&cd));
    body["authenticator_data"] = json!(webauthn::b64url(&ad));
    body["signature"] = json!(webauthn::b64url(&sig));
}

#[tokio::test]
async fn passkey_registration_edges() {
    let t = setup!();
    let admin = t.admin().await;
    let p = t.puncher(&admin, "WEB001").await;

    // no user verification (no screen lock) is refused with a useful message
    let mut no_uv = Authenticator::new(ORIGIN);
    no_uv.flags = webauthn::FLAG_UP;
    let r = t.register_passkey(&p, &no_uv).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "VERIFICATION_FAILED")
    );
    assert!(
        r.body["error"]["message"]
            .as_str()
            .unwrap()
            .contains("screen lock")
    );

    // a passkey created on another site (phishing origin / RP id)
    let evil = Authenticator::new("https://evil.example");
    assert_eq!(
        t.register_passkey(&p, &evil).await.status,
        StatusCode::FORBIDDEN
    );

    // malformed base64 is a validation error, not a crash
    let r = t
        .post(
            "/v1/punch/device",
            json!({ "challenge_id": Uuid::new_v4(), "nonce": "x", "credential_id": "x",
               "client_data_json": "***", "authenticator_data": "" }),
            Some(&p.cookie),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    // happy path, then the same challenge cannot be used twice
    let a = Authenticator::new(ORIGIN);
    let ch = t.rpc("create_device_challenge", json!({}), &p.cookie).await;
    let (id, nonce) = (
        ch.body["data"]["challenge_id"].as_str().unwrap(),
        ch.body["data"]["nonce"].as_str().unwrap(),
    );
    let (cd, ad) = a.register(&webauthn::registration_challenge(id, nonce));
    let body = json!({ "challenge_id": id, "nonce": nonce, "credential_id": webauthn::b64url(&a.credential_id),
                       "client_data_json": webauthn::b64url(&cd), "authenticator_data": webauthn::b64url(&ad) });
    let r = t
        .post("/v1/punch/device", body.clone(), Some(&p.cookie))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["data"]["device_id"].is_string());
    let r2 = t.post("/v1/punch/device", body, Some(&p.cookie)).await;
    assert_eq!(
        (r2.status, r2.code()),
        (StatusCode::FORBIDDEN, "VERIFICATION_FAILED"),
        "{}",
        r2.body
    );

    // the label falls back to the user agent; the stored key is a P-256 SPKI
    let (label, spki): (String, String) = sqlx::query_as(
        "select device_label, public_key_spki from hrms.devices where id = $1::uuid",
    )
    .bind(r.body["data"]["device_id"].as_str().unwrap())
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(label, "api-test");
    assert_eq!(spki.len(), 124);

    // my device is visible to me for allowCredentials
    let mine = t.rpc("get_my_web_device", json!({}), &p.cookie).await;
    assert_eq!(
        mine.body["data"]["credential_id"],
        json!(webauthn::b64url(&a.credential_id))
    );

    // no session, no registration
    let r = t.post("/v1/punch/device", json!({}), None).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn signed_web_punch_flow_and_edges() {
    let t = setup!();
    let admin = t.admin().await;
    let p = t.puncher(&admin, "WEB002").await;
    let mut a = Authenticator::new(ORIGIN);
    let reg = t.register_passkey(&p, &a).await;
    assert_eq!(reg.status, StatusCode::OK, "{}", reg.body);
    let device = reg.body["data"]["device_id"].as_str().unwrap().to_owned();

    // malformed location: 400 with field errors, logged as a rejection
    let mut bad = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    bad["latitude"] = json!("12.9");
    let r = t.post("/v1/punch", bad, Some(&p.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::BAD_REQUEST, "LOCATION_REQUIRED")
    );
    assert!(r.body["error"]["field_errors"]["latitude"].is_string());

    // the signature must cover exactly what is sent (tampered latitude)
    let mut tampered = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    tampered["latitude"] = json!("12.9000001");
    let r = t.post("/v1/punch", tampered, Some(&p.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "VERIFICATION_FAILED"),
        "{}",
        r.body
    );

    // a signature by another passkey is refused
    let mut other = Authenticator::new(ORIGIN);
    other.credential_id = a.credential_id.clone();
    let mut forged = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    sign(&mut forged, &mut other);
    let r = t.post("/v1/punch", forged, Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // a different passkey id than the registered one is refused up front
    let mut wrong_cred = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    wrong_cred["credential_id"] = json!(webauthn::b64url(b"some-other-credential-id"));
    let r = t.post("/v1/punch", wrong_cred, Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);

    // happy path
    let body = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    let r = t.post("/v1/punch", body.clone(), Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["ok"], json!(true));
    let event = r.body["data"]["event_id"].clone();
    let session = r.body["data"]["session"]["session_id"]
        .as_str()
        .unwrap()
        .parse::<Uuid>()
        .unwrap();

    // the event never stores the client IP
    let integrity: Value =
        sqlx::query_scalar("select integrity from hrms.attendance_events where id = $1::uuid")
            .bind(event.as_str().unwrap())
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(integrity["platform"], json!("web"));
    assert!(integrity.get("client_ip").is_none(), "{integrity}");
    assert!(!integrity.to_string().contains(&t.ip));

    // exact replay returns the original result, even though challenge and counter are spent
    let r = t.post("/v1/punch", body.clone(), Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["event_id"], event);

    // same operation key with different details is a conflict
    let mut changed = body.clone();
    changed["accuracy"] = json!("6.00");
    sign(&mut changed, &mut a);
    let r = t.post("/v1/punch", changed, Some(&p.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "IDEMPOTENCY_CONFLICT")
    );

    // a new operation reusing the spent challenge fails in the commit
    let mut reuse = body.clone();
    reuse["operation_key"] = json!(Uuid::new_v4());
    sign(&mut reuse, &mut a);
    let r = t.post("/v1/punch", reuse, Some(&p.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::UNPROCESSABLE_ENTITY, "VERIFICATION_FAILED"),
        "{}",
        r.body
    );

    // a cloned passkey (counter going backwards) is refused
    let mut clone_body = t.punch_body(&p, &mut a, &device, "OUT", session).await;
    a.counter = 1;
    sign(&mut clone_body, &mut a);
    let r = t.post("/v1/punch", clone_body, Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    a.counter = 100;

    // office networks: outside the range is refused, inside is accepted
    let r = t
        .rpc(
            "set_office_networks",
            json!({ "p_office_id": p.office, "p_cidrs": ["198.51.100.0/24"] }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let out = t.punch_body(&p, &mut a, &device, "OUT", session).await;
    let r = t.post("/v1/punch", out, Some(&p.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::UNPROCESSABLE_ENTITY, "NETWORK_REQUIRED"),
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "set_office_networks",
            json!({ "p_office_id": p.office, "p_cidrs": ["10.0.0.0/8"] }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let out = t.punch_body(&p, &mut a, &device, "OUT", session).await;
    let r = t.post("/v1/punch", out, Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["action"], json!("OUT"));
    let r = t
        .rpc(
            "set_office_networks",
            json!({ "p_office_id": p.office, "p_cidrs": [] }),
            &admin,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);

    // rejections are logged with a keyed IP hash only
    let (n, leaked): (i64, bool) = sqlx::query_as(
        "select count(*), coalesce(bool_or(detail::text like '%' || $2 || '%'), false)
         from hrms.punch_rejections where employee_id = $1",
    )
    .bind(p.employee_id)
    .bind(&t.ip)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert!(n >= 4, "{n}");
    assert!(!leaked);
}

#[tokio::test]
async fn someone_elses_passkey_cannot_punch_for_me() {
    let t = setup!();
    let admin = t.admin().await;
    let owner = t.puncher(&admin, "WEB003").await;
    let thief = t.puncher(&admin, "WEB004").await;
    let mut a = Authenticator::new(ORIGIN);
    let reg = t.register_passkey(&owner, &a).await;
    let device = reg.body["data"]["device_id"].as_str().unwrap().to_owned();

    // the thief cannot even get a challenge for the owner's device
    let ch = t
        .rpc(
            "create_punch_challenge",
            json!({ "p_action": "IN", "p_target_id": thief.instance, "p_device_id": device }),
            &thief.cookie,
        )
        .await;
    assert_eq!(ch.code(), "VERIFICATION_FAILED");

    // nor submit a punch signed by it with the owner's ids
    let mut body = t
        .punch_body(&owner, &mut a, &device, "IN", owner.instance)
        .await;
    body["employee_id"] = json!(thief.employee_id);
    sign(&mut body, &mut a);
    let r = t.post("/v1/punch", body, Some(&thief.cookie)).await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::FORBIDDEN, "VERIFICATION_FAILED")
    );

    // an Android-style device row is not accepted on the web route
    let android: Uuid = sqlx::query_scalar(
        "update hrms.devices set revoked_at = now() where id = $1::uuid returning employee_id",
    )
    .bind(&device)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    let android_dev: Uuid = sqlx::query_scalar(
        "insert into hrms.devices (org_id, employee_id, installation_id, platform, public_key_spki, attestation_level, biometric_bound)
         select org_id, id, gen_random_uuid(), 'android', repeat('A', 91), 'hardware', true from hrms.employees where id = $1
         returning id")
        .bind(android).fetch_one(&t.pool).await.unwrap();
    let mut body = t
        .punch_body(
            &owner,
            &mut a,
            &android_dev.to_string(),
            "IN",
            owner.instance,
        )
        .await;
    sign(&mut body, &mut a);
    let r = t.post("/v1/punch", body, Some(&owner.cookie)).await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
}

// ============================================================== iclock (eSSL)

struct Dev {
    status: StatusCode,
    text: String,
}

impl T {
    async fn device(
        &self,
        method: Method,
        path: &str,
        body: Vec<u8>,
        extra: &[(&str, &str)],
    ) -> Dev {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header("x-forwarded-for", &self.ip)
            .header(header::USER_AGENT, "iClock Proxy/1.09");
        for (k, v) in extra {
            b = b.header(*k, *v);
        }
        let res = self
            .app
            .clone()
            .oneshot(b.body(Body::from(body)).unwrap())
            .await
            .unwrap();
        let status = res.status();
        let bytes = res.into_body().collect().await.unwrap().to_bytes();
        Dev {
            status,
            text: String::from_utf8_lossy(&bytes).into_owned(),
        }
    }

    async fn dget(&self, path: &str) -> Dev {
        self.device(Method::GET, path, vec![], &[]).await
    }

    async fn dpost(&self, path: &str, body: &str) -> Dev {
        self.device(Method::POST, path, body.as_bytes().to_vec(), &[])
            .await
    }

    /// Admin registers a machine; returns its serial.
    async fn machine(&self, admin: &str, extra: Value) -> String {
        let serial = format!(
            "SN{}",
            Uuid::new_v4().simple().to_string()[..10].to_uppercase()
        );
        let mut d = json!({ "serial": serial, "label": "Front door" });
        if let (Value::Object(m), Value::Object(e)) = (&mut d, extra) {
            m.extend(e);
        }
        let r = self
            .rpc("save_attendance_device", json!({ "p_device": d }), admin)
            .await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        serial
    }

    async fn rejections(&self, serial: &str, code: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*) from hrms.device_ingest_rejections where serial = $1 and code = $2",
        )
        .bind(serial)
        .bind(code)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

fn local_now(minus_minutes: i64) -> String {
    (chrono::Utc::now() + chrono::Duration::minutes(330 - minus_minutes))
        .format("%Y-%m-%d %H:%M:%S")
        .to_string()
}

#[tokio::test]
async fn iclock_handshake_and_gate_edges() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;

    let r = t.dget(&format!("/iclock/cdata?SN={sn}&options=all")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert!(r.text.starts_with(&format!("GET OPTION FROM: {sn}\n")));
    assert!(r.text.contains("TransFlag=1110101000\n") && r.text.contains("ATTLOGStamp=0\n"));
    let r = t
        .dget(&format!("/iclock/cdata.aspx?SN={sn}&pushver=2.4.1"))
        .await;
    assert!(
        r.text
            .contains("TransFlag=TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser"),
        "{}",
        r.text
    );
    let r = t.dget(&format!("/api/iclock/CDATA.aspx?sn={sn}")).await;
    assert_eq!(r.status, StatusCode::OK, "rewrite path + lowercase sn");

    // the machine's firmware is learned from getrequest INFO
    let r = t
        .dget(&format!(
            "/iclock/getrequest?SN={sn}&INFO=Ver%208.0.4.2-SIM,5,0,42"
        ))
        .await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (StatusCode::OK, "OK"),
        "idle: commands off"
    );
    let fw: Option<String> =
        sqlx::query_scalar("select firmware from hrms.attendance_devices where serial = $1")
            .bind(&sn)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(fw.as_deref(), Some("Ver 8.0.4.2-SIM"));
    assert_eq!(t.dget(&format!("/iclock/ping?SN={sn}")).await.text, "OK");

    // bland 404s for everything unauthorised or unknown
    for path in [
        "/iclock/cdata".to_owned(),
        "/iclock/cdata?SN=".to_owned(),
        "/iclock/cdata?SN=NOPE12345".to_owned(),
        "/iclock/cdata?SN=bad%20serial%3B".to_owned(),
        format!("/iclock/admin?SN={sn}"),
        format!("/iclock/cdata.php?SN={sn}"),
    ] {
        let r = t.dget(&path).await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (StatusCode::NOT_FOUND, "Not Found"),
            "{path}"
        );
    }
    assert!(t.rejections("NOPE12345", "unknown_serial").await >= 1);
    let r = t
        .device(Method::PUT, &format!("/iclock/cdata?SN={sn}"), vec![], &[])
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
    let r = t
        .device(
            Method::DELETE,
            &format!("/iclock/cdata?SN={sn}"),
            vec![],
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // device tokens: query or header, never missing or wrong
    let tok = "device-token-0123456789";
    let sn2 = t.machine(&admin, json!({ "token": tok })).await;
    assert_eq!(
        t.dget(&format!("/iclock/cdata?SN={sn2}")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.dget(&format!("/iclock/cdata?SN={sn2}&token=wrong-token-0000000"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        t.dget(&format!("/iclock/cdata?SN={sn2}&token={tok}"))
            .await
            .status,
        StatusCode::OK
    );
    let r = t
        .device(
            Method::GET,
            &format!("/iclock/cdata?SN={sn2}"),
            vec![],
            &[("x-device-token", tok)],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert!(t.rejections(&sn2, "bad_token").await >= 2);

    // an inactive machine is refused
    let sn3 = t.machine(&admin, json!({ "active": false })).await;
    assert_eq!(
        t.dget(&format!("/iclock/cdata?SN={sn3}")).await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(t.rejections(&sn3, "inactive_device").await, 1);

    // the relay's device IP is believed only with the relay secret
    let ip = "198.51.100.77";
    t.device(
        Method::GET,
        &format!("/iclock/ping?SN={sn}"),
        vec![],
        &[("x-relay-secret", RELAY), ("x-device-ip", ip)],
    )
    .await;
    let seen: Option<String> =
        sqlx::query_scalar("select last_ip_hash from hrms.attendance_devices where serial = $1")
            .bind(&sn)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(seen, Some(hrms_server::iclock::routes::ip_hash(INGEST, ip)));
    t.device(
        Method::GET,
        &format!("/iclock/ping?SN={sn}"),
        vec![],
        &[("x-relay-secret", "forged"), ("x-device-ip", "9.9.9.9")],
    )
    .await;
    let seen: Option<String> =
        sqlx::query_scalar("select last_ip_hash from hrms.attendance_devices where serial = $1")
            .bind(&sn)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(
        seen,
        Some(hrms_server::iclock::routes::ip_hash(INGEST, &t.ip)),
        "forged relay ignored"
    );
}

#[tokio::test]
async fn iclock_attlog_ingest_dedupes_and_acks_everything() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    let body = format!(
        "7\t{}\t0\t1\t0\t0\t0\n8\t{}\t1\t15\t0\ngarbage line\n';x\t{}\t0\t1\n\n",
        local_now(30),
        local_now(20),
        local_now(10)
    );
    let path = format!("/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=9001");
    let r = t.dpost(&path, &body).await;
    assert_eq!(
        (r.status, r.text.as_str()),
        (StatusCode::OK, "OK: 4"),
        "every line consumed once"
    );
    let count = || async {
        sqlx::query_scalar::<_, i64>(
            "select count(*) from hrms.device_punch_events where serial = $1",
        )
        .bind(&sn)
        .fetch_one(&t.pool)
        .await
        .unwrap()
    };
    assert_eq!(count().await, 2);
    assert!(t.rejections(&sn, "malformed_line").await + t.rejections(&sn, "bad_pin").await >= 2);

    // a resend is acknowledged again and never duplicated
    assert_eq!(t.dpost(&path, &body).await.text, "OK: 4");
    assert_eq!(count().await, 2);

    // the cursor moves forward and is offered on the next handshake
    let r = t.dget(&format!("/iclock/cdata?SN={sn}")).await;
    assert!(r.text.contains("ATTLOGStamp=9001\n"), "{}", r.text);
    // a lower stamp never moves it back
    t.dpost(
        &format!("/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=5"),
        &format!("7\t{}\n", local_now(5)),
    )
    .await;
    assert!(
        t.dget(&format!("/iclock/cdata?SN={sn}"))
            .await
            .text
            .contains("ATTLOGStamp=9001\n")
    );

    // empty batch, far-future time and an unknown machine
    assert_eq!(t.dpost(&path, "\n\n").await.text, "OK: 0");
    let future = (chrono::Utc::now() + chrono::Duration::days(3)).format("%Y-%m-%d %H:%M:%S");
    assert_eq!(
        t.dpost(&path, &format!("7\t{future}\n")).await.text,
        "OK: 1"
    );
    assert_eq!(count().await, 3, "only the stamp=5 punch was added");
    let r = t
        .dpost("/iclock/cdata?SN=NOPE12345&table=ATTLOG", &body)
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn iclock_roster_keeps_no_secrets_and_biometrics_are_discarded() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    let operlog = "OPLOG 4\t0\t2026-11-11 10:00:00\t0\t0\t0\t0\n\
        USER PIN=7\tName=Priya M\tPri=0\tPasswd=1234\tCard=[0012345678]\n\
        FP PIN=7\tFID=6\tSize=1336\tValid=1\tTMP=SECRETTEMPLATE\n\
        USER PIN=1\tName=Boss\tPri=14\tPasswd=\tCard=\n";
    let r = t
        .dpost(
            &format!("/iclock/cdata?SN={sn}&table=OPERLOG&Stamp=44"),
            operlog,
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "OK: 4"));
    let rows: Vec<(String, Option<String>, bool)> = sqlx::query_as(
        "select pin, name, is_device_admin from hrms.device_users where serial = $1 order by pin",
    )
    .bind(&sn)
    .fetch_all(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        rows,
        vec![
            ("1".into(), Some("Boss".into()), true),
            ("7".into(), Some("Priya M".into()), false)
        ]
    );
    let dump: String = sqlx::query_scalar(
        "select coalesce(jsonb_agg(u)::text, '') from hrms.device_users u where serial = $1",
    )
    .bind(&sn)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert!(!dump.contains("1234") && !dump.contains("0012345678") && !dump.contains("SECRET"));
    assert!(
        t.dget(&format!("/iclock/cdata?SN={sn}"))
            .await
            .text
            .contains("OPERLOGStamp=44\n")
    );

    // OPERLOG with no users still advances the cursor
    let r = t
        .dpost(
            &format!("/iclock/cdata?SN={sn}&table=OPERLOG&Stamp=50"),
            "OPLOG 4\t0\t2026-11-11 10:00:00\n",
        )
        .await;
    assert_eq!(r.text, "OK: 1");
    assert!(
        t.dget(&format!("/iclock/cdata?SN={sn}"))
            .await
            .text
            .contains("OPERLOGStamp=50\n")
    );
    let r = t
        .dpost(
            &format!("/iclock/cdata?SN={sn}&table=USERINFO"),
            "PIN=3\tName=Meera\tPri=0\tPasswd=9\n",
        )
        .await;
    assert_eq!(r.text, "OK: 1");

    // biometric tables: acknowledged, logged, never stored
    for table in ["BIODATA", "FINGERTMP", "FACE"] {
        let r = t
            .dpost(
                &format!("/iclock/cdata?SN={sn}&table={table}"),
                "PIN=7\tTMP=AAAA\nPIN=8\tTMP=BBBB\n",
            )
            .await;
        assert_eq!(
            (r.status, r.text.as_str()),
            (StatusCode::OK, "OK: 2"),
            "{table}"
        );
    }
    assert_eq!(t.rejections(&sn, "biometric_discarded").await, 3);
    let leaked: i64 = sqlx::query_scalar(
        "select count(*) from hrms.device_ingest_rejections where detail::text like '%AAAA%'",
    )
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(leaked, 0);
    // an unknown table is acknowledged but not logged as biometric
    assert_eq!(
        t.dpost(&format!("/iclock/cdata?SN={sn}&table=WHATEVER"), "x\n")
            .await
            .text,
        "OK: 1"
    );
    assert_eq!(
        t.dpost(&format!("/iclock/cdata?SN={sn}"), "x\ny\n")
            .await
            .text,
        "OK: 2"
    );
}

#[tokio::test]
async fn iclock_photos_commands_and_limits() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    let jpeg: [u8; 12] = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ];

    // raw ATTPHOTO body: acknowledged; until storage exists only a fingerprint is logged
    let mut body = b"PIN=20261111100203-7.jpg\nSN=X\nsize=12\nCMD=uploadphoto\0".to_vec();
    body.extend_from_slice(&jpeg);
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/cdata?SN={sn}&table=ATTPHOTO"),
            body,
            &[],
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "OK"));
    assert_eq!(t.rejections(&sn, "photo_storage_off").await, 1);

    // multipart fdata
    let mut mp = b"--B0und\r\nContent-Disposition: form-data; name=\"SN\"\r\n\r\nX\r\n--B0und\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"20261111100203-7.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".to_vec();
    mp.extend_from_slice(&jpeg);
    mp.extend_from_slice(b"\r\n--B0und--\r\n");
    let ct = [("content-type", "multipart/form-data; boundary=B0und")];
    let r = t
        .device(Method::POST, &format!("/iclock/fdata?SN={sn}"), mp, &ct)
        .await;
    assert_eq!(r.text, "OK");
    assert_eq!(t.rejections(&sn, "photo_storage_off").await, 2);

    // unusable photos are acknowledged (never resent forever) and logged
    let r = t
        .dpost(
            &format!("/iclock/fdata?SN={sn}"),
            "PIN=20261111100203-7.jpg\0not a jpeg",
        )
        .await;
    assert_eq!(r.text, "OK");
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/fdata?SN={sn}"),
            b"--B0und\r\nbroken".to_vec(),
            &ct,
        )
        .await;
    assert_eq!(r.text, "OK");
    assert_eq!(t.rejections(&sn, "bad_photo").await, 2);
    // unknown machine sending a photo
    let r = t
        .dpost("/iclock/fdata?SN=NOPE12345", "PIN=20261111100203-7.jpg\0x")
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND);

    // devicecmd results for commands it never got: OK, nothing changes
    let r = t
        .dpost(
            &format!("/iclock/devicecmd?SN={sn}"),
            "ID=999999&Return=0&CMD=DATA\nID=x&Return=0\n",
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "OK"));
    assert_eq!(
        t.dpost(&format!("/iclock/push?SN={sn}"), "anything")
            .await
            .text,
        "OK"
    );
    assert_eq!(
        t.dpost(&format!("/iclock/registry?SN={sn}"), "").await.text,
        "OK"
    );

    // bodies over 4 MB: 413 + logged, both declared and streamed
    let big = vec![b'a'; hrms_server::iclock::routes::MAX_BODY_BYTES + 1];
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/cdata?SN={sn}&table=ATTLOG"),
            big.clone(),
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/devicecmd?SN={sn}"),
            big,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(t.rejections(&sn, "body_too_large").await, 2);
}

#[tokio::test]
async fn iclock_is_off_without_a_secret_and_503_without_a_database() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    let base = |secret: bool| {
        Config::from_lookup(move |k| match k {
            "APP_ORIGIN" => Some(ORIGIN.into()),
            "PROXY_SECRET" => Some(PROXY.into()),
            "APP_SECRET" => Some("test-app-secret-fedcba9876543210fedcba".into()),
            "DEVICE_INGEST_SECRET" if secret => Some(INGEST.into()),
            _ => None,
        })
        .unwrap()
    };
    let catalog = Arc::new(rpc::Catalog::load(&t.pool).await.unwrap());
    let off = router(AppState::new(
        base(false),
        Some(Db {
            pool: t.pool.clone(),
            catalog,
        }),
    ));
    let req = || {
        Request::get(format!("/iclock/cdata?SN={sn}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(
        off.oneshot(req()).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );
    let no_db = router(AppState::new(base(true), None));
    assert_eq!(
        no_db.oneshot(req()).await.unwrap().status(),
        StatusCode::SERVICE_UNAVAILABLE
    );

    // the database refuses a wrong ingest secret (the hash is checked in SQL)
    let wrong = hrms_server::db::service_call(
        &t.pool,
        "internal_device_gate",
        json!({ "p_secret": "x".repeat(40), "p_serial": sn, "p_token": null, "p_ip_hash": "h", "p_endpoint": "handshake" }),
    )
    .await
    .unwrap();
    assert_eq!(wrong["code"], "bad_secret");
}

// ============================================================== live (SSE)

async fn first_frames(app: &Router, req: Request<Body>, wait_ms: u64) -> (StatusCode, String) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let mut body = res.into_body();
    let mut out = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(wait_ms);
    while let Ok(Some(Ok(frame))) = tokio::time::timeout_at(deadline, body.frame()).await {
        if let Ok(data) = frame.into_data() {
            out.push_str(&String::from_utf8_lossy(&data));
        }
    }
    (status, out)
}

#[tokio::test]
async fn live_stream_is_private_per_audience_and_replays() {
    let t = setup!();
    let admin = t.admin().await;
    let (_, temp) = t.hire(&admin, "EMP900", None).await;
    let emp = t.login("EMP900", &temp).await.session_cookie().unwrap();
    let emp = {
        let r = t.change_password(&emp, &temp, NEW_PW).await;
        r.session_cookie().unwrap()
    };
    let before: i64 = sqlx::query_scalar("select coalesce(max(id), 0) from hrms.live_events")
        .fetch_one(&t.pool)
        .await
        .unwrap();

    // a machine punch: HR/Admin audience
    let sn = t.machine(&admin, json!({})).await;
    let r = t
        .dpost(
            &format!("/iclock/cdata?SN={sn}&table=ATTLOG"),
            &format!("77\t{}\n", local_now(1)),
        )
        .await;
    assert_eq!(r.text, "OK: 1");

    let live = |cookie: Option<&str>, last: Option<i64>| {
        let mut b = t.base(
            Method::GET,
            &format!(
                "/v1/live{}",
                last.map(|v| format!("?after={v}")).unwrap_or_default()
            ),
        );
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        b.body(Body::empty()).unwrap()
    };
    let (status, text) = first_frames(&t.app, live(Some(&admin), Some(before)), 400).await;
    assert_eq!(status, StatusCode::OK);
    assert!(text.contains("event: device.punch"), "{text}");
    assert!(text.contains("id: "), "{text}");

    // the employee never sees HR/Admin events
    let (status, text) = first_frames(&t.app, live(Some(&emp), Some(before)), 400).await;
    assert_eq!(status, StatusCode::OK);
    assert!(!text.contains("device.punch"), "{text}");

    // Last-Event-ID header wins and skips what was already delivered
    let newest: i64 = sqlx::query_scalar("select max(id) from hrms.live_events")
        .fetch_one(&t.pool)
        .await
        .unwrap();
    let req = t
        .base(Method::GET, &format!("/v1/live?after={before}"))
        .header(header::COOKIE, &admin)
        .header("last-event-id", newest.to_string())
        .body(Body::empty())
        .unwrap();
    let (_, text) = first_frames(&t.app, req, 300).await;
    assert!(!text.contains("device.punch"), "{text}");

    // a live (not replayed) event reaches an open stream
    let res = t
        .app
        .clone()
        .oneshot(live(Some(&admin), None))
        .await
        .unwrap();
    assert_eq!(
        res.headers().get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream"
    );
    let mut body = res.into_body();
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    t.dpost(
        &format!("/iclock/cdata?SN={sn}&table=ATTLOG"),
        &format!("78\t{}\n", local_now(1)),
    )
    .await;
    let mut got = String::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(20);
    while !got.contains("device.punch") {
        match tokio::time::timeout_at(deadline, body.frame()).await {
            Ok(Some(Ok(f))) => {
                got.push_str(&String::from_utf8_lossy(&f.into_data().unwrap_or_default()))
            }
            _ => break,
        }
    }
    assert!(got.contains("event: device.punch"), "{got}");

    // signed out / unproxied
    assert_eq!(
        first_frames(&t.app, live(None, None), 100).await.0,
        StatusCode::UNAUTHORIZED
    );
    let req = Request::get("/v1/live")
        .header(header::COOKIE, &admin)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        first_frames(&t.app, req, 100).await.0,
        StatusCode::NOT_FOUND
    );
}

// ------------------------------------------------------------------ files

fn temp_store() -> (hrms_server::storage::Store, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("hrms-api-files-{}", Uuid::new_v4()));
    (hrms_server::storage::Store::Dir(dir.clone()), dir)
}

fn count_files(dir: &std::path::Path) -> usize {
    fn walk(d: &std::path::Path) -> usize {
        std::fs::read_dir(d)
            .map(|it| {
                it.flatten()
                    .map(|e| {
                        if e.path().is_dir() {
                            walk(&e.path())
                        } else {
                            1
                        }
                    })
                    .sum()
            })
            .unwrap_or(0)
    }
    walk(dir)
}

fn test_pdf(body: &str) -> Vec<u8> {
    format!("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n2 0 obj << /Type /Page >> endobj\n{body}\n%%EOF\n").into_bytes()
}

impl T {
    async fn employee(&self, admin: &str, code: &str) -> (Uuid, String) {
        let (id, temp) = self.hire(admin, code, None).await;
        let r = self.login(code, &temp).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        let c = r.session_cookie().unwrap();
        let r = self.change_password(&c, &temp, NEW_PW).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        (id, r.session_cookie().unwrap())
    }

    async fn upload(&self, cookie: Option<&str>, query: &str, mime: &str, bytes: Vec<u8>) -> Resp {
        let mut b = self
            .base(Method::POST, &format!("/v1/files?{query}"))
            .header(header::CONTENT_TYPE, mime);
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        self.send(b.body(Body::from(bytes)).unwrap()).await
    }

    async fn fetch(&self, cookie: &str, path: &str) -> (StatusCode, HeaderMap, Vec<u8>) {
        let req = self
            .base(Method::GET, path)
            .header(header::COOKIE, cookie)
            .body(Body::empty())
            .unwrap();
        let res = self.app.clone().oneshot(req).await.unwrap();
        let (status, headers) = (res.status(), res.headers().clone());
        let bytes = res.into_body().collect().await.unwrap().to_bytes().to_vec();
        (status, headers, bytes)
    }
}

#[tokio::test]
async fn files_upload_validate_store_and_download() {
    let (store, dir) = temp_store();
    let Some(t) = setup_with(Some(store)).await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "F001").await;
    let (ravi, other) = t.employee(&admin, "F002").await;
    let own = format!(
        "class=employee_document&filename=..%2F..%2FOffer%20letter.pdf&owner_employee_id={asha}&title=Offer"
    );
    let pdf = test_pdf("");

    // happy path: stored once, hashed, downloadable by the owner
    let r = t
        .upload(Some(&emp), &own, "application/pdf", pdf.clone())
        .await;
    assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
    let version = r.body["data"]["file_version_id"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(count_files(&dir), 1);
    let (sha, size, state, name): (String, i64, String, String) = sqlx::query_as(
        "select fv.sha256, fv.size_bytes, fv.state, fv.original_filename from hrms.file_versions fv where fv.id = $1::uuid",
    )
    .bind(&version)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(sha, hrms_server::storage::sigv4::sha256_hex(&pdf));
    assert_eq!(size as usize, pdf.len());
    assert!(state == "validated" || state == "published", "{state}");
    assert_eq!(
        name, "Offer letter.pdf",
        "path parts stripped from the name"
    );

    let (st, h, body) = t.fetch(&emp, &format!("/v1/files/{version}")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(body, pdf);
    assert_eq!(h[header::CONTENT_TYPE], "application/pdf");
    assert_eq!(h[header::CACHE_CONTROL], "private, no-store, max-age=0");
    assert!(
        h[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("inline;")
    );
    assert!(
        h.get("x-file-grant").is_some(),
        "grant id for report_file_opened"
    );
    let (_, h, _) = t
        .fetch(&emp, &format!("/v1/files/{version}?purpose=download"))
        .await;
    assert!(
        h[header::CONTENT_DISPOSITION]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    let audits: i64 = sqlx::query_scalar(
        "select count(*) from hrms.file_access_grants where file_version_id = $1::uuid",
    )
    .bind(&version)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert!(audits >= 2, "every read is authorised and recorded");

    // another employee cannot read it; an unknown id is not leaked
    let (st, _, _) = t.fetch(&other, &format!("/v1/files/{version}")).await;
    assert!(
        matches!(st, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
        "{st}"
    );
    let (st, _, _) = t
        .fetch(&other, &format!("/v1/files/{}", Uuid::new_v4()))
        .await;
    assert!(
        matches!(st, StatusCode::FORBIDDEN | StatusCode::NOT_FOUND),
        "{st}"
    );
    let (st, _, _) = t.fetch(&emp, "/v1/files/not-a-uuid").await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // rights: payslips are payroll-only; documents only for yourself
    let r = t
        .upload(
            Some(&emp),
            &format!(
                "class=payslip&filename=p.pdf&owner_employee_id={asha}&salary_month=2026-10-01"
            ),
            "application/pdf",
            pdf.clone(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t
        .upload(
            Some(&emp),
            &format!("class=employee_document&filename=x.pdf&owner_employee_id={ravi}"),
            "application/pdf",
            pdf.clone(),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    assert_eq!(count_files(&dir), 1, "nothing stored for refused uploads");

    // bad bytes are recorded as rejected and never stored
    let png = [
        0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, b'I', b'H', b'D', b'R', 0,
        0, 0, 9, 0, 0, 0, 9,
    ];
    let r = t
        .upload(Some(&emp), &own, "application/pdf", png.to_vec())
        .await;
    assert_eq!(
        (r.status, r.body["error"]["code"].as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, Some("INVALID_FILE_TYPE")),
        "{}",
        r.body
    );
    let r = t
        .upload(
            Some(&emp),
            &own,
            "application/pdf",
            test_pdf("/OpenAction << /S /JavaScript /JS (app.alert(1)) >>"),
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        r.body["error"]["field_errors"]["file"]
            .as_str()
            .unwrap()
            .contains("scripts")
    );
    assert_eq!(count_files(&dir), 1);

    // request-level edges
    let r = t
        .upload(Some(&emp), &own, "text/plain", b"hello".to_vec())
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t.upload(Some(&emp), &own, "application/pdf", vec![]).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
    let r = t
        .upload(Some(&emp), &own, "application/pdf", vec![b'%'; 5_000_001])
        .await;
    assert_eq!(
        (r.status, r.body["error"]["code"].as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, Some("FILE_TOO_LARGE"))
    );
    let r = t.upload(None, &own, "application/pdf", pdf.clone()).await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    let r = t
        .upload(Some(&emp), "filename=a.pdf", "application/pdf", pdf.clone())
        .await;
    assert_eq!(r.status, StatusCode::BAD_REQUEST, "class is required");
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn files_are_off_without_storage() {
    let t = setup!();
    let admin = t.admin().await;
    let r = t
        .upload(
            Some(&admin),
            "class=company_policy&filename=p.pdf",
            "application/pdf",
            test_pdf(""),
        )
        .await;
    assert_eq!(
        (r.status, r.body["error"]["code"].as_str()),
        (StatusCode::SERVICE_UNAVAILABLE, Some("UPLOAD_UNAVAILABLE"))
    );
    assert_eq!(r.body["error"]["retryable"], true);
    let (st, _, _) = t
        .fetch(&admin, &format!("/v1/files/{}", Uuid::new_v4()))
        .await;
    assert_eq!(st, StatusCode::SERVICE_UNAVAILABLE);
}

#[tokio::test]
async fn machine_photos_are_stored_and_only_hr_can_view_them() {
    let (store, dir) = temp_store();
    let Some(t) = setup_with(Some(store)).await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (_, emp) = t.employee(&admin, "P001").await;
    let sn = t.machine(&admin, json!({})).await;
    let when = local_now(3);
    let compact: String = when.chars().filter(char::is_ascii_digit).collect();
    let r = t
        .dpost(
            &format!("/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=1"),
            &format!("7\t{when}\t0\t1\t0\n"),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);

    let jpeg: [u8; 12] = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ];
    let mut body = format!("PIN={compact}-7.jpg\nSN={sn}\nsize=12\nCMD=uploadphoto\0").into_bytes();
    body.extend_from_slice(&jpeg);
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/cdata?SN={sn}&table=ATTPHOTO&Stamp=2"),
            body.clone(),
            &[],
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "OK"));
    assert_eq!(count_files(&dir), 1);
    assert_eq!(t.rejections(&sn, "photo_storage_off").await, 0);
    // a resend is a duplicate: still one object, still OK
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/cdata?SN={sn}&table=ATTPHOTO&Stamp=2"),
            body,
            &[],
        )
        .await;
    assert_eq!(r.text, "OK");
    assert_eq!(count_files(&dir), 1);

    let punch: Uuid = sqlx::query_scalar(
        "select id from hrms.device_punch_events where serial = $1 and photo_path is not null",
    )
    .bind(&sn)
    .fetch_one(&t.pool)
    .await
    .expect("photo joined to its punch");
    let (st, h, bytes) = t.fetch(&admin, &format!("/v1/device-photos/{punch}")).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(bytes, jpeg);
    assert_eq!(h[header::CONTENT_TYPE], "image/jpeg");
    assert_eq!(h[header::CACHE_CONTROL], "private, no-store, max-age=0");
    let (st, _, _) = t.fetch(&emp, &format!("/v1/device-photos/{punch}")).await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, _, _) = t
        .fetch(&admin, &format!("/v1/device-photos/{}", Uuid::new_v4()))
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);

    // a photo far outside the window is refused and its object removed again
    let old = "20200101090000";
    let mut body = format!("PIN={old}-7.jpg\nSN={sn}\nsize=12\nCMD=uploadphoto\0").into_bytes();
    body.extend_from_slice(&jpeg);
    let r = t
        .device(
            Method::POST,
            &format!("/iclock/cdata?SN={sn}&table=ATTPHOTO&Stamp=3"),
            body,
            &[],
        )
        .await;
    assert_eq!(r.status, StatusCode::OK);
    assert_eq!(
        count_files(&dir),
        1,
        "refused photos do not stay in storage"
    );
    assert_eq!(t.rejections(&sn, "photo_out_of_window").await, 1);
    let _ = std::fs::remove_dir_all(dir);
}

#[tokio::test]
async fn bank_proof_upload_lets_the_bank_request_through() {
    let (store, _dir) = temp_store();
    let Some(t) = setup_with(Some(store)).await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "B001").await;
    let (_ravi, other) = t.employee(&admin, "B002").await;
    let up = |c: String| {
        let t = &t;
        async move {
            let r = t
                .upload(
                    Some(&c),
                    "class=correction_attachment&filename=cheque.pdf",
                    "application/pdf",
                    test_pdf(""),
                )
                .await;
            assert_eq!(r.status, StatusCode::CREATED, "{}", r.body);
            r.body["data"]["file_version_id"]
                .as_str()
                .unwrap()
                .to_owned()
        }
    };
    let args = |proof: &str| {
        json!({ "p_request_id": null, "p_bank_name": "HDFC Bank", "p_account_holder": "Asha Rao",
                "p_account_number": "123456789012", "p_ifsc": "HDFC0001234", "p_reason": null,
                "p_attachment_file_version_id": proof, "p_expected_version": null,
                "p_operation_key": Uuid::new_v4() })
    };

    // the validated proof is the record's current version
    let proof = up(emp.clone()).await;
    let current: bool = sqlx::query_scalar(
        "select r.current_version_id = v.id and r.owner_employee_id = $2 from hrms.file_versions v
           join hrms.file_records r on r.id = v.file_record_id where v.id = $1::uuid",
    )
    .bind(&proof)
    .bind(asha)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert!(current);

    // someone else's proof is refused; your own goes through
    let foreign = up(other.clone()).await;
    let r = t
        .rpc("save_bank_details_request", args(&foreign), &emp)
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(
        r.body["error"]["field_errors"]["attachment"],
        "Upload the proof again"
    );
    let r = t.rpc("save_bank_details_request", args(&proof), &emp).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["state"], "submitted", "{}", r.body);

    // a second pending request is locked
    let again = up(emp.clone()).await;
    let r = t.rpc("save_bank_details_request", args(&again), &emp).await;
    assert_eq!(r.body["error"]["code"], "REQUEST_LOCKED", "{}", r.body);
}
