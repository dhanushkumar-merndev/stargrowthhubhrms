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

#[tokio::test]
async fn archive_routes_are_admin_only_and_never_leak_files() {
    let (store, _dir) = temp_store();
    let Some(t) = setup_with(Some(store)).await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (_asha, emp) = t.employee(&admin, "A001").await;
    let (job, ver) = (Uuid::new_v4(), Uuid::new_v4());
    let path = format!("/v1/archive/{job}/files/{ver}");

    // no session
    let r = t
        .send(t.base(Method::GET, &path).body(Body::empty()).unwrap())
        .await;
    assert_eq!(r.status, StatusCode::UNAUTHORIZED);
    // an employee cannot read export files or drive a cleanup
    let (st, h, _) = t.fetch(&emp, &path).await;
    assert!(
        st == StatusCode::FORBIDDEN || st == StatusCode::NOT_FOUND,
        "{st}"
    );
    assert!(h.get("x-sha256").is_none());
    let r = t
        .post(&format!("/v1/archive/cleanup/{job}"), json!({}), Some(&emp))
        .await;
    assert!(
        r.status == StatusCode::FORBIDDEN || r.status == StatusCode::NOT_FOUND,
        "{}",
        r.body
    );
    // an Admin gets a clean error for an unknown job, never bytes
    let (st, _, _) = t.fetch(&admin, &path).await;
    assert!(st.is_client_error(), "{st}");
    let r = t
        .post(
            &format!("/v1/archive/cleanup/{job}?reconcile_only=true"),
            json!({}),
            Some(&admin),
        )
        .await;
    assert!(r.status.is_client_error(), "{}", r.body);
    // malformed ids are rejected by the router
    let (st, _, _) = t.fetch(&admin, "/v1/archive/not-a-uuid/files/x").await;
    assert!(st.is_client_error(), "{st}");
}

#[tokio::test]
async fn notification_prefs_quiet_hours_and_push_outbox() {
    let Some(t) = setup().await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "N001").await;
    // other workers' leftovers never block this test
    sqlx::query("update hrms.outbox set status = 'skipped' where status in ('pending','sending')")
        .execute(&t.pool)
        .await
        .unwrap();

    // push config is visible to signed-in users only; off in tests
    let (st, _, body) = t.fetch(&emp, "/v1/push/config").await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["data"]["public_key"],
        Value::Null
    );

    // defaults, validation, round trip
    let r = t.rpc("get_notification_prefs", json!({}), &emp).await;
    assert_eq!(r.body["data"]["muted"], json!([]), "{}", r.body);
    for (args, field) in [
        (
            json!({ "p_muted": ["salary"], "p_quiet_start": null, "p_quiet_end": null }),
            "muted",
        ),
        (
            json!({ "p_muted": [], "p_quiet_start": "22:00", "p_quiet_end": null }),
            "quiet_end",
        ),
        (
            json!({ "p_muted": [], "p_quiet_start": "22:00", "p_quiet_end": "22:00" }),
            "quiet_end",
        ),
    ] {
        let r = t.rpc("set_notification_prefs", args, &emp).await;
        assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
        assert!(
            r.body["error"]["field_errors"][field].is_string(),
            "{}",
            r.body
        );
    }
    let r = t
        .rpc("set_notification_prefs", json!({ "p_muted": ["pay", "pay", "announcements"], "p_quiet_start": null, "p_quiet_end": null }), &emp)
        .await;
    assert_eq!(
        r.body["data"]["muted"],
        json!(["announcements", "pay"]),
        "{}",
        r.body
    );

    let suppressed = |kind: &'static str, at: &'static str| {
        let t = &t;
        async move {
            sqlx::query_scalar::<_, bool>("select hrms.push_suppressed($1, $2, $3::timestamptz)")
                .bind(asha)
                .bind(kind)
                .bind(at)
                .fetch_one(&t.pool)
                .await
                .unwrap()
        }
    };
    assert!(suppressed("payslip.published", "2026-11-14T06:00:00Z").await);
    assert!(!suppressed("request.submitted", "2026-11-14T06:00:00Z").await);
    assert!(!suppressed("credentials.reset", "2026-11-14T06:00:00Z").await); // account notices are never muted

    // quiet hours 22:00–07:00 IST wrap midnight
    t.rpc(
        "set_notification_prefs",
        json!({ "p_muted": [], "p_quiet_start": "22:00", "p_quiet_end": "07:00" }),
        &emp,
    )
    .await;
    assert!(suppressed("request.submitted", "2026-11-14T17:00:00Z").await); // 22:30 IST
    assert!(suppressed("request.submitted", "2026-11-14T01:00:00Z").await); // 06:30 IST
    assert!(!suppressed("request.submitted", "2026-11-14T01:30:00Z").await); // 07:00 IST: over
    assert!(!suppressed("request.submitted", "2026-11-14T06:00:00Z").await); // 11:30 IST
    assert!(!suppressed("access.role_changed", "2026-11-14T17:00:00Z").await);
    t.rpc(
        "set_notification_prefs",
        json!({ "p_muted": [], "p_quiet_start": null, "p_quiet_end": null }),
        &emp,
    )
    .await;

    // test push lands in the inbox; with push off the outbox job is skipped
    let r = t.rpc("send_test_notification", json!({}), &emp).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let http = hrms_server::push::client();
    let n = hrms_server::push::run_outbox(&t.pool, None, &http)
        .await
        .unwrap();
    assert!(n >= 1);
    let (status, err): (String, Option<String>) = sqlx::query_as(
        "select o.status, o.last_error from hrms.outbox o join hrms.notifications n on n.id = o.notification_id
          where n.recipient_id = $1 and n.kind = 'account.test' order by o.id desc limit 1",
    )
    .bind(asha)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), err.as_deref()),
        ("skipped", Some("push not configured"))
    );
    let r = t.rpc("list_notifications", json!({}), &emp).await;
    assert_eq!(
        r.body["data"]["rows"][0]["kind"], "account.test",
        "{}",
        r.body
    );
    assert_eq!(r.body["data"]["unread"], 1);

    // a subscription on a host that is not a push service is never called and is revoked
    let sub = json!({ "endpoint": "https://internal.example/hook", "keys": { "p256dh": format!("B{}", "A".repeat(86)), "auth": "A".repeat(22) } });
    let r = t
        .rpc("register_push_token", json!({ "p_installation_id": Uuid::new_v4(), "p_token": sub.to_string(), "p_platform": "web" }), &emp)
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    t.rpc("send_test_notification", json!({}), &emp).await;
    let vapid = hrms_server::push::Vapid::from_secret(
        p256::SecretKey::from_slice(&[9u8; 32]).unwrap(),
        "mailto:ops@example.com".into(),
    );
    hrms_server::push::run_outbox(&t.pool, Some(&vapid), &http)
        .await
        .unwrap();
    let live: i64 = sqlx::query_scalar(
        "select count(*) from hrms.push_tokens where employee_id = $1 and revoked_at is null",
    )
    .bind(asha)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(live, 0);
    let status: String = sqlx::query_scalar(
        "select o.status from hrms.outbox o join hrms.notifications n on n.id = o.notification_id
          where n.recipient_id = $1 order by o.id desc limit 1",
    )
    .bind(asha)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(status, "failed");

    // test pushes are rate limited
    t.rpc("send_test_notification", json!({}), &emp).await;
    let r = t.rpc("send_test_notification", json!({}), &emp).await;
    assert_eq!(r.status, StatusCode::TOO_MANY_REQUESTS, "{}", r.body);

    // read state
    let r = t
        .rpc("mark_notifications_read", json!({ "p_ids": null }), &emp)
        .await;
    assert!(
        r.body["data"]["marked"].as_i64().unwrap() >= 3,
        "{}",
        r.body
    );
    let r = t.rpc("list_notifications", json!({}), &emp).await;
    assert_eq!(r.body["data"]["unread"], 0);
}

#[tokio::test]
async fn calendar_feed_is_private_revocable_and_valid_ics() {
    let Some(t) = setup().await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "C001").await;
    let (other, _) = t.employee(&admin, "C002").await;
    let (org, _, _, office) = t.org_ids().await;
    let today: chrono::NaiveDate =
        sqlx::query_scalar("select (now() at time zone 'Asia/Kolkata')::date")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    let d = |n: i64| today + chrono::Duration::days(n);
    let other_office: Uuid = sqlx::query_scalar(
        "insert into hrms.offices (org_id, name, timezone, location)
         values ($1, 'Branch', 'Asia/Kolkata', 'SRID=4326;POINT(77.7 13.0)'::extensions.geography) returning id",
    )
    .bind(org)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    for (date, name, state, office_id) in [
        (d(10), "Founders, Day; \"one\"", "published", None),
        (d(11), "Draft day", "draft", None),
        (d(12), "HQ day", "published", Some(office)),
        (d(13), "Branch day", "published", Some(other_office)),
        (d(500), "Too far", "published", None),
    ] {
        sqlx::query("insert into hrms.holidays (org_id, office_id, holiday_date, name, state) values ($1, $2, $3, $4, $5)")
            .bind(org)
            .bind(office_id)
            .bind(date)
            .bind(name)
            .bind(state)
            .execute(&t.pool)
            .await
            .unwrap();
    }
    sqlx::query("insert into hrms.leave_types (org_id, code, name) values ($1, 'CL', 'Casual leave') on conflict do nothing")
        .bind(org)
        .execute(&t.pool)
        .await
        .unwrap();
    // Approved leave for Asha (one half day) and for someone else.
    for (who, slot, state) in [
        (asha, "AM", "approved"),
        (asha, "FULL", "released"),
        (other, "FULL", "approved"),
    ] {
        let day = if state == "released" { d(21) } else { d(20) };
        sqlx::query(
            "with r as (
               insert into hrms.requests (org_id, employee_id, kind, state, leave_type_id, start_date, end_date)
               values ($1, $2, 'leave', 'approved', (select id from hrms.leave_types where org_id = $1 and code = 'CL'), $3, $3)
               returning id)
             insert into hrms.leave_day_slots (org_id, employee_id, request_id, revision_no, day, slot, slot_range, state)
             select $1, $2, r.id, 1, $3, $4, hrms.slot_range($4), $5 from r",
        )
        .bind(org)
        .bind(who)
        .bind(day)
        .bind(slot)
        .bind(state)
        .execute(&t.pool)
        .await
        .unwrap();
    }

    let r = t.rpc("get_calendar_feed", json!({}), &emp).await;
    assert_eq!(r.body["data"]["enabled"], json!(false), "{}", r.body);
    let r = t.rpc("create_calendar_feed", json!({}), &emp).await;
    let token = r.body["data"]["token"].as_str().unwrap().to_owned();
    assert_eq!(token.len(), 43, "{}", r.body);
    let stored: Vec<u8> =
        sqlx::query_scalar("select token_hash from hrms.calendar_feeds where employee_id = $1")
            .bind(asha)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_ne!(stored, token.as_bytes(), "only the hash is stored");
    let r = t.rpc("get_calendar_feed", json!({}), &emp).await;
    assert_eq!(r.body["data"]["enabled"], json!(true));
    assert!(
        r.body["data"].get("token").is_none(),
        "token is shown only once"
    );

    // No cookie needed; still only through the proxy.
    let get = |path: String| {
        let t = &t;
        async move {
            let req = t.base(Method::GET, &path).body(Body::empty()).unwrap();
            let res = t.app.clone().oneshot(req).await.unwrap();
            let (st, h) = (res.status(), res.headers().clone());
            let b = res.into_body().collect().await.unwrap().to_bytes().to_vec();
            (st, h, String::from_utf8(b).unwrap())
        }
    };
    let (st, h, ics) = get(format!("/v1/calendar/{token}.ics")).await;
    assert_eq!(st, StatusCode::OK, "{ics}");
    assert_eq!(h[header::CONTENT_TYPE], "text/calendar; charset=utf-8");
    assert_eq!(h[header::CACHE_CONTROL], "private, max-age=900");
    assert!(ics.starts_with("BEGIN:VCALENDAR\r\n") && ics.ends_with("END:VCALENDAR\r\n"));
    assert!(ics.contains(r#"SUMMARY:Founders\, Day\; "one""#), "{ics}");
    assert!(ics.contains("SUMMARY:HQ day"));
    assert!(!ics.contains("Branch day"), "another office's holiday");
    assert!(!ics.contains("Draft day") && !ics.contains("Too far"));
    assert_eq!(ics.matches("SUMMARY:On leave:").count(), 1, "{ics}");
    assert!(
        ics.contains("SUMMARY:On leave: Casual leave (morning)"),
        "{ics}"
    );
    assert!(ics.contains(&format!("DTSTART;VALUE=DATE:{}", d(20).format("%Y%m%d"))));
    let used: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("select last_used_at from hrms.calendar_feeds where employee_id = $1")
            .bind(asha)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert!(used.is_some());

    // Wrong shapes and unknown tokens look the same.
    for bad in [
        format!("/v1/calendar/{token}"),
        format!("/v1/calendar/{token}.ICS"),
        format!("/v1/calendar/{}.ics", "A".repeat(43)),
        "/v1/calendar/short.ics".to_string(),
        format!("/v1/calendar/{}x.ics", &token[..42]),
    ] {
        let (st, _, _) = get(bad.clone()).await;
        assert_eq!(st, StatusCode::NOT_FOUND, "{bad}");
    }
    // Not reachable without the proxy secret.
    let req = Request::builder()
        .uri(format!("/v1/calendar/{token}.ics"))
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        t.app.clone().oneshot(req).await.unwrap().status(),
        StatusCode::NOT_FOUND
    );

    // A new link replaces the old one.
    let r = t.rpc("create_calendar_feed", json!({}), &emp).await;
    let token2 = r.body["data"]["token"].as_str().unwrap().to_owned();
    assert_ne!(token, token2);
    assert_eq!(
        get(format!("/v1/calendar/{token}.ics")).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        get(format!("/v1/calendar/{token2}.ics")).await.0,
        StatusCode::OK
    );

    // Deactivation stops it; reactivation brings it back.
    sqlx::query("update hrms.employees set status = 'inactive' where id = $1")
        .bind(asha)
        .execute(&t.pool)
        .await
        .unwrap();
    assert_eq!(
        get(format!("/v1/calendar/{token2}.ics")).await.0,
        StatusCode::NOT_FOUND
    );
    sqlx::query("update hrms.employees set status = 'active' where id = $1")
        .bind(asha)
        .execute(&t.pool)
        .await
        .unwrap();
    assert_eq!(
        get(format!("/v1/calendar/{token2}.ics")).await.0,
        StatusCode::OK
    );

    // Deactivation signed Asha out; sign in again.
    let r = t.login("C001", NEW_PW).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let emp = r.session_cookie().unwrap();
    // Turning it off revokes at once and is idempotent; both are audited.
    for _ in 0..2 {
        let r = t.rpc("revoke_calendar_feed", json!({}), &emp).await;
        assert_eq!(r.body["data"]["enabled"], json!(false), "{}", r.body);
    }
    assert_eq!(
        get(format!("/v1/calendar/{token2}.ics")).await.0,
        StatusCode::NOT_FOUND
    );
    let audits: i64 = sqlx::query_scalar("select count(*) from hrms.audit_logs where target_id = $1 and action like 'calendar_feed.%'")
        .bind(asha)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(audits, 3, "two creates and one revoke");

    // The internal function is not callable from the browser.
    let r = t
        .rpc(
            "internal_calendar_feed",
            json!({ "p_token_sha256": "00" }),
            &emp,
        )
        .await;
    assert_eq!(r.status, StatusCode::NOT_FOUND, "{}", r.body);
}

#[tokio::test]
async fn celebrations_respect_opt_in_and_never_leak_birth_year() {
    let Some(t) = setup().await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "B001").await;
    let (ravi, _) = t.employee(&admin, "B002").await;
    let (gone, _) = t.employee(&admin, "B003").await;
    let (org, _, _, _) = t.org_ids().await;
    let today: chrono::NaiveDate =
        sqlx::query_scalar("select (now() at time zone 'Asia/Kolkata')::date")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    let years_ago = |y: i32, plus_days: i64| {
        let d = today + chrono::Duration::days(plus_days);
        chrono::NaiveDate::from_ymd_opt(
            chrono::Datelike::year(&d) - y,
            chrono::Datelike::month(&d),
            chrono::Datelike::day(&d).min(28),
        )
        .unwrap()
    };
    // Join dates: Asha 3 years ago today, Ravi 1 year ago in 2 days, B003 inactive.
    for (id, join) in [
        (asha, years_ago(3, 0)),
        (ravi, years_ago(1, 2)),
        (gone, years_ago(2, 0)),
    ] {
        sqlx::query("update hrms.employees set join_date = $2 where id = $1")
            .bind(id)
            .bind(join)
            .execute(&t.pool)
            .await
            .unwrap();
    }
    sqlx::query("update hrms.employees set status = 'inactive' where id = $1")
        .bind(gone)
        .execute(&t.pool)
        .await
        .unwrap();
    // Birthdays: Asha (today), Ravi (tomorrow).
    for (id, dob) in [(asha, years_ago(30, 0)), (ravi, years_ago(25, 1))] {
        sqlx::query(
            "insert into hrms.employee_private_details (employee_id, org_id, date_of_birth) values ($1, $2, $3)
             on conflict (employee_id) do update set date_of_birth = excluded.date_of_birth",
        )
        .bind(id)
        .bind(org)
        .bind(dob)
        .execute(&t.pool)
        .await
        .unwrap();
    }

    let list = |days: i64| {
        let t = &t;
        let emp = emp.clone();
        async move {
            t.rpc("list_celebrations", json!({ "p_days": days }), &emp)
                .await
                .body["data"]["rows"]
                .clone()
        }
    };
    let rows = list(7).await;
    let kinds: Vec<(String, String)> = rows
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            (
                r["name"].as_str().unwrap().to_owned(),
                r["kind"].as_str().unwrap().to_owned(),
            )
        })
        .collect();
    assert_eq!(
        kinds,
        vec![
            ("Person B001".into(), "anniversary".into()),
            ("Person B002".into(), "anniversary".into())
        ],
        "{rows}"
    );
    assert_eq!(rows[0]["years"], json!(3));
    assert_eq!(rows[0]["is_today"], json!(true));
    assert_eq!(rows[0]["is_me"], json!(true));
    assert_eq!(rows[1]["years"], json!(1));
    assert!(!rows.to_string().contains("date_of_birth"));

    // Opt in to birthdays: shows day only, never the birth year.
    let r = t.rpc("get_celebration_prefs", json!({}), &emp).await;
    assert_eq!(
        r.body["data"],
        json!({ "share_birthday": false, "share_anniversary": true, "has_birthday": true }),
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "set_celebration_prefs",
            json!({ "p_share_birthday": true, "p_share_anniversary": false }),
            &emp,
        )
        .await;
    assert_eq!(r.body["data"]["share_birthday"], json!(true), "{}", r.body);
    let rows = list(7).await;
    let mine: Vec<&Value> = rows
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["employee_id"] == json!(asha))
        .collect();
    assert_eq!(mine.len(), 1, "{rows}");
    assert_eq!(mine[0]["kind"], json!("birthday"));
    assert_eq!(mine[0]["years"], Value::Null, "age is never shown");
    assert_eq!(mine[0]["date"], json!(today.to_string()));
    let birth_year = years_ago(30, 0).format("%Y").to_string();
    assert!(
        !rows.to_string().contains(&format!("{birth_year}-")),
        "{rows}"
    );
    // Ravi did not opt in: no birthday for him.
    assert!(
        !rows
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["employee_id"] == json!(ravi) && r["kind"] == json!("birthday"))
    );

    // Window edges: 0 days = today only; out-of-range values are clamped.
    assert!(
        list(0)
            .await
            .as_array()
            .unwrap()
            .iter()
            .all(|r| r["is_today"] == json!(true))
    );
    assert_eq!(list(-5).await, list(0).await);
    assert!(
        t.rpc("list_celebrations", json!({ "p_days": 400 }), &emp)
            .await
            .status
            .is_success()
    );

    // Validation.
    let r = t
        .rpc(
            "set_celebration_prefs",
            json!({ "p_share_birthday": null, "p_share_anniversary": true }),
            &emp,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    // Leap-day birthdays fall on 28 February in other years.
    let leap: chrono::NaiveDate =
        sqlx::query_scalar("select hrms.next_yearly('2000-02-29', '2027-01-10')")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(leap.to_string(), "2027-02-28");
    let leap: chrono::NaiveDate =
        sqlx::query_scalar("select hrms.next_yearly('2000-02-29', '2028-01-10')")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(leap.to_string(), "2028-02-29");
    let wrap: chrono::NaiveDate =
        sqlx::query_scalar("select hrms.next_yearly('1990-01-02', '2026-12-30')")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(wrap.to_string(), "2027-01-02");
}

#[tokio::test]
async fn comp_off_for_a_day_off_is_reviewed_and_credited_once() {
    let Some(t) = setup().await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (asha, emp) = t.employee(&admin, "K001").await;
    let (_, hr) = {
        let (id, temp) = t.hire(&admin, "K002", Some("hr")).await;
        let r = t.login("K002", &temp).await;
        let c = r.session_cookie().unwrap();
        let r = t.change_password(&c, &temp, NEW_PW).await;
        (id, r.session_cookie().unwrap())
    };
    let (org, _, _, _) = t.org_ids().await;
    let today: chrono::NaiveDate =
        sqlx::query_scalar("select (now() at time zone 'Asia/Kolkata')::date")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    let d = |n: i64| today - chrono::Duration::days(n);
    // Days: 2 ago = day off with 7h, 3 ago = day off with 4h, 4 ago = day off with 2h,
    // 5 ago = working day with 8h, 40 ago = day off with 8h (too old).
    sqlx::query("update hrms.employees set join_date = $2 where id = $1")
        .bind(asha)
        .bind(d(60))
        .execute(&t.pool)
        .await
        .unwrap();
    let (_, _, _, office) = t.org_ids().await;
    for (n, hours, required) in [
        (2, 7, false),
        (3, 4, false),
        (4, 2, false),
        (5, 8, true),
        (40, 8, false),
    ] {
        let inst: Uuid = sqlx::query_scalar(
            "insert into hrms.work_schedule_instances (org_id, employee_id, shift_date, kind, is_required, office_id,
               shift_version_id, timezone, start_at, end_at, lunch_paid, grace_seconds, early_entry_seconds, early_credit,
               checkout_extension_seconds, expected_seconds, half_split_at)
             select $1, $2, $3, case when $4 then 'workday' else 'weekly_off' end, $4, $5, sv.id, 'Asia/Kolkata',
                    ($3::date + time '09:00') at time zone 'Asia/Kolkata', ($3::date + time '18:00') at time zone 'Asia/Kolkata',
                    true, 1800, 1800, false, 7200, 32400, ($3::date + time '13:30') at time zone 'Asia/Kolkata'
             from hrms.shift_versions sv where sv.org_id = $1 limit 1 returning id",
        )
        .bind(org)
        .bind(asha)
        .bind(d(n))
        .bind(required)
        .bind(office)
        .fetch_one(&t.pool)
        .await
        .unwrap();
        sqlx::query(
            "insert into hrms.attendance_sessions (org_id, employee_id, schedule_instance_id, shift_date, state, effective_in_at, effective_out_at, effective_source)
             values ($1, $2, $3, $4, 'closed', ($4::date + time '09:00') at time zone 'Asia/Kolkata',
                     ($4::date + time '09:00' + make_interval(hours => $5)) at time zone 'Asia/Kolkata', 'manual')",
        )
        .bind(org)
        .bind(asha)
        .bind(inst)
        .bind(d(n))
        .bind(hours)
        .execute(&t.pool)
        .await
        .unwrap();
    }
    let save = |day: chrono::NaiveDate, reason: &'static str| {
        let t = &t;
        let emp = emp.clone();
        async move {
            t.rpc(
                "save_attendance_request",
                json!({ "p_kind": "comp_off", "p_request_id": null, "p_start_date": day, "p_end_date": null,
                        "p_reason": reason, "p_submit": true, "p_expected_version": null, "p_operation_key": Uuid::new_v4() }),
                &emp,
            )
            .await
        }
    };
    // Rejections, each with the field message.
    for (day, needle) in [
        (today + chrono::Duration::days(1), "already worked"),
        (d(40), "within 30 days"),
        (d(5), "working day"),
        (d(4), "at least 3 hours"),
    ] {
        let r = save(day, "Worked the stock count").await;
        assert_eq!(
            r.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{day}: {}",
            r.body
        );
        assert!(
            r.body["error"]["field_errors"]["start_date"]
                .as_str()
                .unwrap()
                .contains(needle),
            "{}",
            r.body
        );
    }
    let r = save(d(2), "no").await;
    assert_eq!(
        r.status,
        StatusCode::UNPROCESSABLE_ENTITY,
        "reason required: {}",
        r.body
    );

    // 7 hours -> full day; 4 hours -> half day.
    let r = save(d(2), "Worked the stock count").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let full: Uuid = r.body["data"]["id"].as_str().unwrap().parse().unwrap();
    let r = save(d(3), "Client go-live support").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let half: Uuid = r.body["data"]["id"].as_str().unwrap().parse().unwrap();
    let r = save(d(2), "Again").await;
    assert!(
        r.body["error"]["field_errors"]["start_date"]
            .as_str()
            .unwrap()
            .contains("already asked"),
        "{}",
        r.body
    );
    let units: Vec<i32> = sqlx::query_scalar(
        "select units from hrms.requests where id = any($1) order by target_shift_date desc",
    )
    .bind(vec![full, half])
    .fetch_all(&t.pool)
    .await
    .unwrap();
    assert_eq!(units, vec![2, 1]);
    // HR was told.
    let told: i64 = sqlx::query_scalar("select count(*) from hrms.notifications where title = 'Comp-off request' and body like '%asked for comp-off for working%'")
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert!(told >= 1);

    // The requester cannot approve their own; HR opens and approves.
    let decide = |id: Uuid, cookie: String, decision: &'static str| {
        let t = &t;
        async move {
            let r = t
                .rpc(
                    "open_request_for_review",
                    json!({ "p_request_id": id, "p_reason": null }),
                    &cookie,
                )
                .await;
            let v = r.body["version"]
                .as_i64()
                .or_else(|| r.body["data"]["version"].as_i64());
            t.rpc(
                "decide_request",
                json!({ "p_request_id": id, "p_decision": decision, "p_reason": "ok", "p_expected_version": v, "p_operation_key": Uuid::new_v4() }),
                &cookie,
            )
            .await
        }
    };
    let r = decide(full, emp.clone(), "approve").await;
    assert_ne!(r.status, StatusCode::OK, "{}", r.body);
    let r = decide(full, hr.clone(), "approve").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = decide(half, hr.clone(), "reject").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    // Balance: one full day (2 units) of "Comp off", valid 90 days from the worked day.
    let (code, units, source, valid_to): (String, i64, String, chrono::NaiveDate) = sqlx::query_as(
        "select t.code, sum(l.units)::bigint, min(a.source), min(a.valid_to)
         from hrms.leave_ledger l join hrms.leave_accounts ac on ac.id = l.account_id
         join hrms.leave_types t on t.id = ac.leave_type_id join hrms.leave_allocations a on a.id = l.allocation_id
         where ac.employee_id = $1 group by t.code",
    )
    .bind(asha)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(
        (code.as_str(), units, source.as_str()),
        ("COMP_OFF", 2, "comp_off")
    );
    assert!(valid_to <= d(2) + chrono::Duration::days(91));
    let r = t.rpc("get_leave_balances", json!({}), &emp).await;
    assert!(r.body.to_string().contains("Comp off"), "{}", r.body);
    let notice: String = sqlx::query_scalar("select body from hrms.notifications where recipient_id = $1 and kind = 'request.approved' order by created_at desc limit 1")
        .bind(asha)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert!(
        notice.contains("added to your leave balance (1 day)"),
        "{notice}"
    );

    // Crediting twice is impossible (idempotent apply).
    let req: (Uuid,) = (full,);
    sqlx::query("select hrms.credit_comp_off(r, (select payload from hrms.request_revisions where request_id = r.id and revision_no = r.current_revision), null) from hrms.requests r where r.id = $1")
        .bind(req.0)
        .execute(&t.pool)
        .await
        .unwrap();
    let n: i64 = sqlx::query_scalar("select count(*) from hrms.leave_ledger where request_id = $1")
        .bind(full)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);

    // A rejected day can be asked again; an approved one cannot.
    let r = save(d(3), "Client go-live support, again").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = save(d(2), "Worked the stock count").await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY);
}

fn b32_decode(s: &str) -> Vec<u8> {
    let (mut buf, mut bits, mut out) = (0u32, 0u32, Vec::new());
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'2'..=b'7' => c - b'2' + 26,
            _ => panic!("bad base32"),
        } as u32;
        buf = (buf << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    out
}

#[tokio::test]
async fn two_step_sign_in_end_to_end() {
    use hrms_server::auth::two_step::{STEP, hotp};
    let Some(t) = setup().await else {
        eprintln!("SKIP: HRMS_TEST_DATABASE_URL not set");
        return;
    };
    let admin = t.admin().await;
    let (hr_id, temp) = t.hire(&admin, "M001", Some("hr")).await;
    let r = t.login("M001", &temp).await;
    let r = t
        .change_password(&r.session_cookie().unwrap(), &temp, NEW_PW)
        .await;
    let hr = r.session_cookie().unwrap();
    let now_step = || {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs()
            / STEP
    };

    let r = t.rpc("get_two_step_status", json!({}), &hr).await;
    assert_eq!(r.body["data"]["enabled"], json!(false), "{}", r.body);
    assert_eq!(r.body["data"]["recommended"], json!(true));

    // Setup needs the password.
    let r = t
        .post(
            "/v1/auth/two-step/setup",
            json!({ "password": "wrong" }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN, "{}", r.body);
    let r = t
        .post(
            "/v1/auth/two-step/setup",
            json!({ "password": NEW_PW }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let secret_b32 = r.body["data"]["secret"].as_str().unwrap().to_owned();
    assert!(
        r.body["data"]["uri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/HRMS:M001?secret=")
    );
    assert!(r.body["data"]["qr_svg"].as_str().unwrap().contains("<svg"));
    let secret = b32_decode(&secret_b32);
    let stored: Vec<u8> = sqlx::query_scalar("select secret_enc from iam.totp_factors f join hrms.employees e on e.auth_user_id = f.user_id where e.id = $1")
        .bind(hr_id)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert!(
        !stored.windows(secret.len()).any(|w| w == secret.as_slice()),
        "secret is sealed"
    );
    let code = |step: u64| format!("{:06}", hotp(&secret, step));

    // Not on until a right code is entered; password alone still signs in.
    let r = t
        .post(
            "/v1/auth/two-step/enable",
            json!({ "code": "000000" }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.code(), "INVALID_CODE", "{}", r.body);
    let r = t.login("M001", NEW_PW).await;
    assert!(r.session_cookie().is_some());
    let r = t
        .post(
            "/v1/auth/two-step/enable",
            json!({ "code": code(now_step() - 1) }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let recovery: Vec<String> =
        serde_json::from_value(r.body["data"]["recovery_codes"].clone()).unwrap();
    assert_eq!(recovery.len(), 10);
    let r = t
        .post(
            "/v1/auth/two-step/setup",
            json!({ "password": NEW_PW }),
            Some(&hr),
        )
        .await;
    assert_eq!(
        r.code(),
        "ALREADY_ON",
        "cannot silently replace: {}",
        r.body
    );

    // Password now yields a challenge, not a session.
    let r = t.login("M001", NEW_PW).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.session_cookie().is_none(), "no session before the code");
    assert_eq!(r.body["data"]["two_step_required"], json!(true));
    let challenge = r.body["data"]["challenge"].as_str().unwrap().to_owned();
    // Wrong password still fails the same generic way.
    assert_eq!(
        t.login("M001", "nope-nope-nope").await.code(),
        "AUTH_FAILED"
    );

    let step2 = |ch: &str, c: &str| {
        t.post(
            "/v1/auth/login/two-step",
            json!({ "challenge": ch, "code": c }),
            None,
        )
    };
    assert_eq!(step2(&challenge, "123456").await.code(), "INVALID_CODE");
    assert_eq!(
        step2("not-a-token", &code(now_step())).await.code(),
        "CHALLENGE_EXPIRED"
    );
    // The code used to enable cannot be replayed.
    assert_eq!(
        step2(&challenge, &code(now_step() - 1)).await.code(),
        "INVALID_CODE"
    );
    let r = step2(&challenge, &code(now_step())).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let signed_in = r.session_cookie().expect("session after the code");
    assert_eq!(r.body["data"]["must_change_password"], json!(false));
    assert_eq!(
        t.rpc("get_session_context", json!({}), &signed_in)
            .await
            .status,
        StatusCode::OK
    );
    // A challenge works once.
    assert_eq!(
        step2(&challenge, &code(now_step() + 1)).await.code(),
        "CHALLENGE_EXPIRED"
    );

    // Five wrong tries end the challenge even for the right code.
    let ch = t.login("M001", NEW_PW).await.body["data"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    for _ in 0..5 {
        assert_ne!(step2(&ch, "999999").await.status, StatusCode::OK);
    }
    assert_eq!(
        step2(&ch, &code(now_step() + 1)).await.code(),
        "CHALLENGE_EXPIRED"
    );

    // Expired challenges are refused.
    let ch = t.login("M001", NEW_PW).await.body["data"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    sqlx::query("update iam.login_challenges set expires_at = now() - interval '1 second' where consumed_at is null")
        .execute(&t.pool)
        .await
        .unwrap();
    assert_eq!(
        step2(&ch, &code(now_step() + 1)).await.code(),
        "CHALLENGE_EXPIRED"
    );

    // A recovery code works once (any case/spacing) and tells the owner.
    let ch = t.login("M001", NEW_PW).await.body["data"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    let r = step2(&ch, &recovery[0].to_lowercase().replace('-', " ")).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let ch = t.login("M001", NEW_PW).await.body["data"]["challenge"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(step2(&ch, &recovery[0]).await.code(), "INVALID_CODE");
    let told: i64 = sqlx::query_scalar("select count(*) from hrms.notifications where recipient_id = $1 and kind = 'account.two_step_recovery_used'")
        .bind(hr_id)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(told, 1);
    let r = t.rpc("get_two_step_status", json!({}), &hr).await;
    assert_eq!(r.body["data"]["recovery_left"], json!(9), "{}", r.body);

    // New recovery codes need password + code; old ones stop working.
    let r = t
        .post(
            "/v1/auth/two-step/recovery",
            json!({ "password": NEW_PW, "code": recovery[1] }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let fresh: Vec<String> =
        serde_json::from_value(r.body["data"]["recovery_codes"].clone()).unwrap();
    assert!(fresh.iter().all(|c| !recovery.contains(c)));
    let r = t.rpc("get_two_step_status", json!({}), &hr).await;
    assert_eq!(r.body["data"]["recovery_left"], json!(10));

    // Admin reset: needs the Admin's password grant, cannot target self, audited.
    let (emp_id, _) = t.employee(&admin, "M002").await;
    let r = t
        .rpc("reset_two_step", json!({ "p_employee_id": hr_id }), &admin)
        .await;
    assert_eq!(r.code(), "REAUTH_REQUIRED", "{}", r.body);
    let r = t
        .post(
            "/v1/auth/reauth",
            json!({ "action": "mfa.reset", "password": NEW_PW, "target_id": hr_id }),
            Some(&admin),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t
        .rpc(
            "get_employee_two_step",
            json!({ "p_employee_id": hr_id }),
            &admin,
        )
        .await;
    assert_eq!(r.body["data"]["enabled"], json!(true));
    let r = t
        .rpc("reset_two_step", json!({ "p_employee_id": hr_id }), &admin)
        .await;
    assert_eq!(r.body["data"]["reset"], json!(true), "{}", r.body);
    let r = t.login("M001", NEW_PW).await;
    assert!(
        r.session_cookie().is_some(),
        "password alone works again: {}",
        r.body
    );
    let r = t
        .rpc("reset_two_step", json!({ "p_employee_id": emp_id }), &hr)
        .await;
    assert_eq!(
        r.status,
        StatusCode::FORBIDDEN,
        "HR cannot reset: {}",
        r.body
    );
    let audits: Vec<String> = sqlx::query_scalar("select action from hrms.audit_logs where target_id = $1 and action like 'two_step.%' order by created_at, id")
        .bind(hr_id)
        .fetch_all(&t.pool)
        .await
        .unwrap();
    // The second recovery_used is the code spent to get new codes.
    assert_eq!(
        audits,
        vec![
            "two_step.enabled",
            "two_step.recovery_used",
            "two_step.recovery_used",
            "two_step.codes_replaced",
            "two_step.reset"
        ]
    );

    // Turn on again, then off by the owner (password + code). The password
    // check allows 5 tries per 15 minutes; start this part with a fresh window.
    sqlx::query("delete from hrms.rate_limit_buckets where bucket like 'reauth:%'")
        .execute(&t.pool)
        .await
        .unwrap();
    let r = t
        .post(
            "/v1/auth/two-step/setup",
            json!({ "password": NEW_PW }),
            Some(&hr),
        )
        .await;
    let secret = b32_decode(r.body["data"]["secret"].as_str().unwrap());
    let code = |step: u64| format!("{:06}", hotp(&secret, step));
    let r = t
        .post(
            "/v1/auth/two-step/enable",
            json!({ "code": code(now_step()) }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t
        .post(
            "/v1/auth/two-step/disable",
            json!({ "password": NEW_PW, "code": code(now_step()) }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.code(), "INVALID_CODE", "same step twice: {}", r.body);
    let r = t
        .post(
            "/v1/auth/two-step/disable",
            json!({ "password": NEW_PW, "code": code(now_step() + 1) }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t
        .post(
            "/v1/auth/two-step/disable",
            json!({ "password": NEW_PW, "code": "123456" }),
            Some(&hr),
        )
        .await;
    assert_eq!(r.code(), "NOT_ON");

    // Management needs a session; internal functions are not RPCs.
    assert_eq!(
        t.post(
            "/v1/auth/two-step/setup",
            json!({ "password": NEW_PW }),
            None
        )
        .await
        .status,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        t.rpc(
            "internal_two_step_event",
            json!({ "p_auth_user_id": Uuid::nil(), "p_event": "enabled" }),
            &hr
        )
        .await
        .status,
        StatusCode::NOT_FOUND
    );
}

// ============================================================ automatic IDs, PINs, machine fetch

impl T {
    /// Provision without an employee code; returns the response data.
    async fn hire_auto(&self, admin: &str, role: Option<&str>, extra: Value) -> Value {
        let (_, team, shift, office) = self.org_ids().await;
        let mut body = json!({
            "operation_id": Uuid::new_v4(),
            "fields": { "full_name": "Auto Person", "join_date": "2026-01-05",
                        "team_id": team, "office_id": office, "shift_id": shift, "role": role }
        });
        if let (Value::Object(m), Value::Object(e)) = (&mut body, extra) {
            m.extend(e);
        }
        let r = self.post("/v1/admin/users", body, Some(admin)).await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        r.body["data"].clone()
    }

    async fn pins_of(&self, employee: &str) -> Vec<(Option<String>, String)> {
        sqlx::query_as(
            "select serial, pin from hrms.device_user_links where employee_id = $1::uuid and unlinked_at is null order by pin",
        )
        .bind(employee)
        .fetch_all(&self.pool)
        .await
        .unwrap()
    }
}

#[tokio::test]
async fn employee_ids_are_generated_per_role() {
    let t = setup!();
    let admin = t.admin().await;
    let preview = t.rpc("preview_employee_code", json!({}), &admin).await;
    assert_eq!(preview.status, StatusCode::OK, "{}", preview.body);
    let e1 = t.hire_auto(&admin, None, json!({})).await;
    assert_eq!(e1["employee_code"], preview.body["data"]["employee_code"]);
    let c1 = e1["employee_code"].as_str().unwrap().to_owned();
    assert!(c1.starts_with("EMP") && c1.len() == 7, "{c1}");
    let e2 = t.hire_auto(&admin, None, json!({})).await;
    let n = |c: &str, p: &str| c[p.len()..].parse::<u32>().unwrap();
    assert_eq!(
        n(e2["employee_code"].as_str().unwrap(), "EMP"),
        n(&c1, "EMP") + 1
    );
    // A typed code with the same prefix moves the counter on; numbers never go back.
    t.hire(&admin, "EMP0950", None).await;
    let e3 = t.hire_auto(&admin, Some("member"), json!({})).await;
    assert_eq!(e3["employee_code"], "EMP0951");
    let hr = t.hire_auto(&admin, Some("hr"), json!({})).await;
    assert!(
        hr["employee_code"].as_str().unwrap().starts_with("HR"),
        "{hr}"
    );
    let ad = t.hire_auto(&admin, Some("admin"), json!({})).await;
    assert!(
        ad["employee_code"].as_str().unwrap().starts_with("ADM"),
        "{ad}"
    );
    let p = t
        .rpc("preview_employee_code", json!({ "p_role": "hr" }), &admin)
        .await;
    let next_hr = n(hr["employee_code"].as_str().unwrap(), "HR") + 1;
    assert_eq!(p.body["data"]["employee_code"], format!("HR{next_hr:04}"));
    // The generated person can sign in with the generated ID.
    let r = t
        .login(
            e1["employee_code"].as_str().unwrap(),
            e1["temporary_password"].as_str().unwrap(),
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    // Employees cannot preview codes.
    let emp = r.session_cookie().unwrap();
    let emp = t
        .change_password(
            &emp,
            e1["temporary_password"].as_str().unwrap(),
            "Auto-Person-Pass-77",
        )
        .await
        .session_cookie()
        .unwrap();
    let r = t.rpc("preview_employee_code", json!({}), &emp).await;
    assert_eq!(r.code(), "ACCESS_DENIED", "{}", r.body);
}

#[tokio::test]
async fn new_hires_get_a_machine_pin_automatically() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    sqlx::query("update hrms.attendance_devices set commands_enabled = true where serial = $1")
        .bind(&sn)
        .execute(&t.pool)
        .await
        .unwrap();
    let a = t.hire_auto(&admin, None, json!({})).await;
    let b = t.hire_auto(&admin, None, json!({})).await;
    let pa = t.pins_of(a["employee_id"].as_str().unwrap()).await;
    let pb = t.pins_of(b["employee_id"].as_str().unwrap()).await;
    assert_eq!(pa.len(), 1, "{pa:?}");
    assert_eq!(pb.len(), 1, "{pb:?}");
    assert!(pa[0].0.is_none(), "an automatic PIN works on every machine");
    assert_eq!(
        pb[0].1.parse::<u64>().unwrap(),
        pa[0].1.parse::<u64>().unwrap() + 1
    );
    // ... and each is queued to the machine.
    let queued: i64 = sqlx::query_scalar(
        "select count(*) from hrms.device_commands where serial = $1 and kind = 'user_upsert' and status = 'queued'",
    )
    .bind(&sn)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(queued, 2);
    // Someone hired with a PIN that already exists on the machine keeps that one only.
    t.dpost(
        &format!("/iclock/cdata?SN={sn}&table=OPERLOG&Stamp=5"),
        "USER PIN=900\tName=Machine Only\tPri=0\n",
    )
    .await;
    let c = t
        .hire_auto(
            &admin,
            None,
            json!({ "device_pin": "900", "device_serial": sn }),
        )
        .await;
    let pc = t.pins_of(c["employee_id"].as_str().unwrap()).await;
    assert_eq!(pc, vec![(Some(sn.clone()), "900".to_owned())]);
    // The next automatic PIN skips numbers the machine already uses.
    let d = t.hire_auto(&admin, None, json!({})).await;
    let pd = t.pins_of(d["employee_id"].as_str().unwrap()).await;
    assert_eq!(pd[0].1, "901");
}

#[tokio::test]
async fn hr_fetches_people_from_machines() {
    let t = setup!();
    let admin = t.admin().await;
    let sn = t.machine(&admin, json!({})).await;
    sqlx::query("update hrms.attendance_devices set commands_enabled = true, oplog_stamp = 99 where serial = $1")
        .bind(&sn)
        .execute(&t.pool)
        .await
        .unwrap();
    let r = t.rpc("fetch_device_users", json!({}), &admin).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["data"]["machines"].as_i64().unwrap() >= 1);
    let stamp: Option<i64> =
        sqlx::query_scalar("select oplog_stamp from hrms.attendance_devices where serial = $1")
            .bind(&sn)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(stamp, Some(0), "the next handshake re-sends the user list");
    // Asking twice does not stack commands.
    t.rpc("fetch_device_users", json!({}), &admin).await;
    let open: i64 = sqlx::query_scalar(
        "select count(*) from hrms.device_commands where serial = $1 and kind = 'user_query' and status in ('queued','sent')",
    )
    .bind(&sn)
    .fetch_one(&t.pool)
    .await
    .unwrap();
    assert_eq!(open, 1);
    let poll = t.dget(&format!("/iclock/getrequest?SN={sn}")).await;
    assert!(poll.text.contains(":DATA QUERY USERINFO"), "{}", poll.text);
    // The machine answers on /iclock/querydata.
    let r = t
        .dpost(
            &format!("/iclock/querydata?SN={sn}&type=tabledata&tablename=user&count=2&packcnt=1&packidx=1"),
            "user uid=1\tcardno=\tpin=31\tpassword=999\tgroup=1\tname=Ravi K\tprivilege=0\nuser uid=2\tpin=32\tname=Meena\tprivilege=14\n",
        )
        .await;
    assert_eq!((r.status, r.text.as_str()), (StatusCode::OK, "OK"));
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
            ("31".into(), Some("Ravi K".into()), false),
            ("32".into(), Some("Meena".into()), true)
        ]
    );
    // They show under "New from machine" until someone is hired with their PIN.
    let pins = |r: &Resp| -> Vec<String> {
        r.body["data"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["serial"] == json!(sn))
            .map(|p| p["pin"].as_str().unwrap().to_owned())
            .collect()
    };
    let list = t.rpc("list_machine_people", json!({}), &admin).await;
    assert_eq!(list.status, StatusCode::OK, "{}", list.body);
    assert_eq!(pins(&list), vec!["31", "32"]);
    let hired = t
        .hire_auto(
            &admin,
            None,
            json!({ "device_pin": "31", "device_serial": sn }),
        )
        .await;
    assert_eq!(
        t.pins_of(hired["employee_id"].as_str().unwrap()).await,
        vec![(Some(sn.clone()), "31".to_owned())]
    );
    assert_eq!(
        pins(&t.rpc("list_machine_people", json!({}), &admin).await),
        vec!["32"]
    );
    // Other query tables are acknowledged and ignored.
    let r = t
        .dpost(
            &format!("/iclock/querydata?SN={sn}&tablename=fingertmp"),
            "pin=31\ttmp=SECRET\n",
        )
        .await;
    assert_eq!(r.text, "OK");
    // Employees cannot ask; an unknown machine id is refused.
    let e = t.hire_auto(&admin, None, json!({})).await;
    let c = t
        .login(
            e["employee_code"].as_str().unwrap(),
            e["temporary_password"].as_str().unwrap(),
        )
        .await
        .session_cookie()
        .unwrap();
    let c = t
        .change_password(
            &c,
            e["temporary_password"].as_str().unwrap(),
            "Fetch-Person-Pass-77",
        )
        .await
        .session_cookie()
        .unwrap();
    assert_eq!(
        t.rpc("fetch_device_users", json!({}), &c).await.code(),
        "ACCESS_DENIED"
    );
    let r = t
        .rpc(
            "fetch_device_users",
            json!({ "p_device_id": Uuid::new_v4() }),
            &admin,
        )
        .await;
    assert_eq!(r.code(), "VALIDATION_FAILED", "{}", r.body);
}

// ============================================================ tasks and daily work reports

struct Who {
    id: String,
    cookie: String,
}

impl T {
    /// Hires someone with a generated ID and signs them in with a permanent password.
    async fn person(&self, admin: &str, role: Option<&str>) -> Who {
        let d = self.hire_auto(admin, role, json!({})).await;
        let temp = d["temporary_password"].as_str().unwrap();
        let c = self
            .login(d["employee_code"].as_str().unwrap(), temp)
            .await
            .session_cookie()
            .unwrap();
        let r = self.change_password(&c, temp, "Person-Own-Pass-2026").await;
        assert_eq!(r.status, StatusCode::OK, "{}", r.body);
        Who {
            id: d["employee_id"].as_str().unwrap().to_owned(),
            cookie: r.session_cookie().unwrap(),
        }
    }

    async fn sql(&self, q: &str, args: &[&str]) {
        let mut x = sqlx::query(q);
        for a in args {
            x = x.bind(*a);
        }
        x.execute(&self.pool).await.unwrap();
    }

    /// lead leads the default team; member is in it; other is in a second team.
    async fn reporting_lines(&self, admin: &str) -> (Who, Who, Who, Who) {
        let (org, team, _, _) = self.org_ids().await;
        let lead = self.person(admin, None).await;
        let member = self.person(admin, None).await;
        let other = self.person(admin, None).await;
        let hr = self.person(admin, Some("hr")).await;
        self.sql(
            "delete from hrms.team_managers where team_id = $1::uuid",
            &[&team.to_string()],
        )
        .await;
        self.sql(
            "insert into hrms.team_managers (org_id, team_id, manager_id, effective_from) values ($1::uuid, $2::uuid, $3::uuid, '2026-01-02')",
            &[&org.to_string(), &team.to_string(), &lead.id],
        )
        .await;
        self.sql(
            "with t as (insert into hrms.teams (org_id, name) values ($1::uuid, 'Second ' || gen_random_uuid()) returning id)
             update hrms.team_memberships set team_id = (select id from t) where employee_id = $2::uuid",
            &[&org.to_string(), &other.id],
        )
        .await;
        (lead, member, other, hr)
    }
}

#[tokio::test]
async fn tasks_follow_the_reporting_lines() {
    let t = setup!();
    let admin = t.admin().await;
    let (lead, member, other, hr) = t.reporting_lines(&admin).await;
    let give = |by: String, to: String, title: &'static str| {
        let t = &t;
        async move {
            t.rpc(
                "create_task",
                json!({ "p_assigned_to": to, "p_title": title, "p_priority": "high" }),
                &by,
            )
            .await
        }
    };
    // Who may give tasks to whom.
    let r = give(lead.cookie.clone(), member.id.clone(), "Fix the report").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let task = r.body["data"].clone();
    assert_eq!(task["status"], "todo");
    for (by, to) in [(&lead, &other), (&lead, &hr), (&member, &other), (&hr, &hr)] {
        if by.id == to.id {
            continue;
        }
        assert_eq!(
            give(by.cookie.clone(), to.id.clone(), "Nope").await.code(),
            "ACCESS_DENIED"
        );
    }
    let admin_id: String =
        sqlx::query_scalar("select id::text from hrms.employees where employee_code = $1")
            .bind(&t.admin_code)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(
        give(hr.cookie.clone(), admin_id.clone(), "Nope")
            .await
            .code(),
        "ACCESS_DENIED"
    );
    assert_eq!(
        give(hr.cookie.clone(), lead.id.clone(), "Plan the week")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        give(member.cookie.clone(), member.id.clone(), "My own to-do")
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        give(admin.clone(), hr.id.clone(), "Audit").await.status,
        StatusCode::OK
    );
    // Validation.
    let r = t.rpc("create_task", json!({ "p_assigned_to": member.id, "p_title": " ", "p_due_date": "2020-01-01", "p_priority": "urgent" }), &lead.cookie).await;
    assert_eq!(r.code(), "VALIDATION_FAILED");
    let f = &r.body["error"]["field_errors"];
    assert!(
        f["title"].is_string() && f["due_date"].is_string() && f["priority"].is_string(),
        "{}",
        r.body
    );
    // The assignee was told.
    let n: i64 = sqlx::query_scalar("select count(*) from hrms.notifications where recipient_id = $1::uuid and kind = 'task.assigned'")
        .bind(&member.id)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(n, 1, "no notification for a personal to-do");
    // Assignee: status only.
    let id = task["id"].as_str().unwrap();
    let r = t
        .rpc(
            "update_task",
            json!({ "p_task_id": id, "p_patch": { "title": "Mine now" }, "p_expected_version": 1 }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.code(), "ACCESS_DENIED");
    let r = t.rpc("update_task", json!({ "p_task_id": id, "p_patch": { "status": "cancelled" }, "p_expected_version": 1 }), &member.cookie).await;
    assert_eq!(r.code(), "ACCESS_DENIED");
    let r = t
        .rpc(
            "update_task",
            json!({ "p_task_id": id, "p_patch": { "status": "done" }, "p_expected_version": 1 }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert!(r.body["data"]["completed_at"].is_string());
    let n: i64 = sqlx::query_scalar("select count(*) from hrms.notifications where recipient_id = $1::uuid and kind = 'task.done'")
        .bind(&lead.id)
        .fetch_one(&t.pool)
        .await
        .unwrap();
    assert_eq!(n, 1);
    // Stale version; unknown field.
    let r = t
        .rpc(
            "update_task",
            json!({ "p_task_id": id, "p_patch": { "status": "todo" }, "p_expected_version": 1 }),
            &member.cookie,
        )
        .await;
    assert_eq!(
        (r.status, r.code()),
        (StatusCode::CONFLICT, "STALE_VERSION")
    );
    let r = t.rpc("update_task", json!({ "p_task_id": id, "p_patch": { "assigned_to": other.id }, "p_expected_version": 2 }), &lead.cookie).await;
    assert_eq!(r.code(), "VALIDATION_FAILED");
    // Reopened (completed_at cleared), then the giver changes details and cancels.
    let r = t.rpc("update_task", json!({ "p_task_id": id, "p_patch": { "status": "in_progress" }, "p_expected_version": 2 }), &member.cookie).await;
    assert!(r.body["data"]["completed_at"].is_null(), "{}", r.body);
    let r = t.rpc("update_task", json!({ "p_task_id": id, "p_patch": { "title": "Fix the monthly report", "priority": "low" }, "p_expected_version": 3 }), &lead.cookie).await;
    assert_eq!(
        r.body["data"]["title"], "Fix the monthly report",
        "{}",
        r.body
    );
    let r = t.rpc("update_task", json!({ "p_task_id": id, "p_patch": { "status": "cancelled" }, "p_expected_version": 4 }), &lead.cookie).await;
    assert_eq!(r.body["data"]["status"], "cancelled", "{}", r.body);
    let r = t
        .rpc(
            "update_task",
            json!({ "p_task_id": id, "p_patch": { "status": "todo" }, "p_expected_version": 5 }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.code(), "VALIDATION_FAILED");
    // Who can see it.
    assert_eq!(
        t.rpc("get_task", json!({ "p_task_id": id }), &other.cookie)
            .await
            .code(),
        "NOT_FOUND"
    );
    assert_eq!(
        t.rpc("get_task", json!({ "p_task_id": id }), &hr.cookie)
            .await
            .status,
        StatusCode::OK
    );
    let lists = |scope: &'static str, c: String| {
        let t = &t;
        async move {
            let r = t
                .rpc(
                    "list_tasks",
                    json!({ "p_scope": scope, "p_status": "all" }),
                    &c,
                )
                .await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
            r.body["data"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x["title"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    assert!(
        lists("team", lead.cookie.clone())
            .await
            .contains(&"Fix the monthly report".to_owned())
    );
    assert!(
        lists("given", lead.cookie.clone())
            .await
            .contains(&"Fix the monthly report".to_owned())
    );
    assert!(
        lists("mine", member.cookie.clone())
            .await
            .contains(&"My own to-do".to_owned())
    );
    assert!(lists("team", other.cookie.clone()).await.is_empty());
    // HR sees the lead's task, but not their own HR colleague's; the lead cannot see HR's.
    assert!(
        lists("team", hr.cookie.clone())
            .await
            .contains(&"Plan the week".to_owned())
    );
    assert!(
        !lists("team", hr.cookie.clone())
            .await
            .contains(&"Audit".to_owned())
    );
    assert!(
        lists("team", admin.clone())
            .await
            .contains(&"Audit".to_owned())
    );
    // The picker lists only people the caller may give tasks to.
    let r = t.rpc("list_task_assignees", json!({}), &lead.cookie).await;
    let ids: Vec<&str> = r.body["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&member.id.as_str()) && ids.contains(&lead.id.as_str()));
    assert!(!ids.contains(&other.id.as_str()) && !ids.contains(&hr.id.as_str()));
    let acc = |c: String| {
        let t = &t;
        async move { t.rpc("get_work_access", json!({}), &c).await.body["data"].clone() }
    };
    let a = acc(lead.cookie.clone()).await;
    assert_eq!(
        (
            a["can_view_team"].clone(),
            a["leads_teams"].clone(),
            a["can_assign_others"].clone()
        ),
        (json!(true), json!(1), json!(true))
    );
    let a = acc(member.cookie.clone()).await;
    assert_eq!(
        (a["can_view_team"].clone(), a["can_assign_others"].clone()),
        (json!(false), json!(false))
    );
    assert_eq!(acc(hr.cookie.clone()).await["can_view_team"], true);
    assert_eq!(
        t.rpc("list_tasks", json!({ "p_scope": "everyone" }), &lead.cookie)
            .await
            .code(),
        "VALIDATION_FAILED"
    );
    assert_eq!(
        t.rpc(
            "list_tasks",
            json!({ "p_employee_id": hr.id }),
            &lead.cookie
        )
        .await
        .code(),
        "ACCESS_DENIED"
    );
}

#[tokio::test]
async fn daily_work_reports_are_seen_up_the_line_only() {
    let t = setup!();
    let admin = t.admin().await;
    let (lead, member, other, hr) = t.reporting_lines(&admin).await;
    let today: String =
        sqlx::query_scalar("select ((now() at time zone 'Asia/Kolkata')::date)::text")
            .fetch_one(&t.pool)
            .await
            .unwrap();
    let log = |c: String, title: &'static str, minutes: Option<i64>| {
        let t = &t;
        let today = today.clone();
        async move {
            t.rpc(
                "save_work_log",
                json!({ "p_id": null, "p_work_date": today, "p_title": title,
                "p_details": "Wrote the full details of what was done.", "p_minutes": minutes }),
                &c,
            )
            .await
        }
    };
    let r = log(member.cookie.clone(), "Customer calls", Some(90)).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let entry = r.body["data"].clone();
    assert_eq!(entry["can_edit"], true);
    log(lead.cookie.clone(), "Team planning", Some(60)).await;
    log(hr.cookie.clone(), "Payroll checks", None).await;
    let sees = |viewer: &str, whose: &str| {
        let t = &t;
        let (v, w) = (viewer.to_owned(), whose.to_owned());
        async move {
            t.rpc("list_work_logs", json!({ "p_employee_id": w }), &v)
                .await
                .status
                == StatusCode::OK
        }
    };
    // Employee -> self, lead, HR, Admin.
    assert!(sees(&member.cookie, &member.id).await);
    assert!(sees(&lead.cookie, &member.id).await);
    assert!(sees(&hr.cookie, &member.id).await);
    assert!(sees(&admin, &member.id).await);
    assert!(!sees(&other.cookie, &member.id).await);
    // Lead -> HR, Admin; not their own team members.
    assert!(sees(&hr.cookie, &lead.id).await);
    assert!(sees(&admin, &lead.id).await);
    assert!(!sees(&member.cookie, &lead.id).await);
    // HR -> Admin only.
    assert!(sees(&admin, &hr.id).await);
    assert!(!sees(&lead.cookie, &hr.id).await);
    assert!(!sees(&member.cookie, &hr.id).await);
    // The lead cannot read someone in another team.
    assert!(!sees(&lead.cookie, &other.id).await);

    // Team view for the day.
    let names = |c: String| {
        let t = &t;
        async move {
            let r = t.rpc("list_team_work", json!({}), &c).await;
            assert_eq!(r.status, StatusCode::OK, "{}", r.body);
            r.body["data"]["rows"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x["employee"]["id"].as_str().unwrap().to_owned())
                .collect::<Vec<_>>()
        }
    };
    assert_eq!(names(lead.cookie.clone()).await, vec![member.id.clone()]);
    let hr_view = names(hr.cookie.clone()).await;
    assert!(
        hr_view.contains(&lead.id) && hr_view.contains(&member.id) && hr_view.contains(&other.id)
    );
    assert!(!hr_view.contains(&hr.id));
    assert!(names(admin.clone()).await.contains(&hr.id));
    assert_eq!(
        t.rpc("list_team_work", json!({}), &member.cookie)
            .await
            .code(),
        "ACCESS_DENIED"
    );
    let r = t.rpc("list_team_work", json!({}), &lead.cookie).await;
    assert_eq!(r.body["data"]["rows"][0]["total_minutes"], 90);

    // Rules: the last 7 days only, 24 h a day, own tasks only, own entries only.
    let bad_day = |days: i64| {
        let t = &t;
        let c = member.cookie.clone();
        async move {
            let d: String = sqlx::query_scalar(
                "select (((now() at time zone 'Asia/Kolkata')::date) + $1::int)::text",
            )
            .bind(days as i32)
            .fetch_one(&t.pool)
            .await
            .unwrap();
            t.rpc("save_work_log", json!({ "p_id": null, "p_work_date": d, "p_title": "Old", "p_details": "Details here" }), &c).await
        }
    };
    assert_eq!(bad_day(-8).await.code(), "VALIDATION_FAILED");
    assert_eq!(bad_day(1).await.code(), "VALIDATION_FAILED");
    assert_eq!(bad_day(-7).await.status, StatusCode::OK);
    let r = log(member.cookie.clone(), "Too long", Some(1400)).await;
    assert_eq!(r.code(), "VALIDATION_FAILED", "{}", r.body);
    let r = t
        .rpc(
            "save_work_log",
            json!({ "p_id": null, "p_work_date": today, "p_title": "x", "p_details": "" }),
            &member.cookie,
        )
        .await;
    assert!(
        r.body["error"]["field_errors"]["title"].is_string()
            && r.body["error"]["field_errors"]["details"].is_string(),
        "{}",
        r.body
    );
    let leads_task = t
        .rpc(
            "create_task",
            json!({ "p_assigned_to": lead.id, "p_title": "Lead only" }),
            &hr.cookie,
        )
        .await
        .body["data"]["id"]
        .clone();
    let r = t.rpc("save_work_log", json!({ "p_id": null, "p_work_date": today, "p_title": "Sneaky", "p_details": "On someone else's task", "p_task_id": leads_task }), &member.cookie).await;
    assert!(
        r.body["error"]["field_errors"]["task_id"].is_string(),
        "{}",
        r.body
    );
    // Logged against own task: the task shows the time.
    let mine = t
        .rpc(
            "create_task",
            json!({ "p_assigned_to": member.id, "p_title": "Write docs" }),
            &lead.cookie,
        )
        .await
        .body["data"]["id"]
        .clone();
    t.rpc("save_work_log", json!({ "p_id": null, "p_work_date": today, "p_title": "Docs", "p_details": "Wrote the setup guide", "p_minutes": 30, "p_task_id": mine }), &member.cookie).await;
    let g = t
        .rpc("get_task", json!({ "p_task_id": mine }), &lead.cookie)
        .await;
    assert_eq!(g.body["data"]["logged_minutes"], 30, "{}", g.body);
    assert_eq!(g.body["data"]["logs"].as_array().unwrap().len(), 1);
    // Editing: own entry, right version; others cannot touch it.
    let id = entry["id"].as_str().unwrap();
    let r = t.rpc("save_work_log", json!({ "p_id": id, "p_work_date": today, "p_title": "Customer calls (3)", "p_details": "Called three customers about renewals.", "p_minutes": 75, "p_expected_version": 1 }), &member.cookie).await;
    assert_eq!(r.body["data"]["version"], 2, "{}", r.body);
    let r = t.rpc("save_work_log", json!({ "p_id": id, "p_work_date": today, "p_title": "Again", "p_details": "Stale edit here", "p_expected_version": 1 }), &member.cookie).await;
    assert_eq!(r.code(), "STALE_VERSION");
    assert_eq!(
        t.rpc("delete_work_log", json!({ "p_id": id }), &lead.cookie)
            .await
            .code(),
        "NOT_FOUND"
    );
    assert_eq!(
        t.rpc("delete_work_log", json!({ "p_id": id }), &member.cookie)
            .await
            .status,
        StatusCode::OK
    );
    assert_eq!(
        t.rpc(
            "list_work_logs",
            json!({ "p_from": "2026-01-01", "p_to": "2026-06-01" }),
            &member.cookie
        )
        .await
        .code(),
        "VALIDATION_FAILED"
    );
}

// ------------------------------------------------------------ punch flow

impl T {
    async fn notified(&self, who: &str, kind: &str) -> i64 {
        sqlx::query_scalar(
            "select count(*) from hrms.notifications where recipient_id = $1::uuid and kind = $2",
        )
        .bind(who)
        .bind(kind)
        .fetch_one(&self.pool)
        .await
        .unwrap()
    }
}

fn hhmm(minus_minutes: i64) -> String {
    local_now(minus_minutes)[11..16].to_owned()
}

#[tokio::test]
async fn machine_punch_in_then_app_punch_out_and_fix_requests() {
    let t = setup!();
    let admin = t.admin().await;
    let (_lead, member, _other, hr) = t.reporting_lines(&admin).await;
    let sn = t.machine(&admin, json!({})).await;
    let pin = t.pins_of(&member.id).await[0].1.clone();

    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(day.status, StatusCode::OK, "{}", day.body);
    assert_eq!(day.body["data"]["has_machines"], true);
    assert_eq!(day.body["data"]["day"], Value::Null);
    assert_eq!(day.body["data"]["can_outdoor_in"], true);
    assert_eq!(day.body["data"]["can_app_out"], false);

    // Punch in at the machine: the person is told at once.
    let path = format!("/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=1");
    let r = t
        .dpost(&path, &format!("{pin}\t{}\t0\t1\t0\t0\t0\n", local_now(90)))
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.text);
    assert_eq!(t.notified(&member.id, "attendance.device_in").await, 1);
    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    let d = &day.body["data"];
    assert!(d["day"]["first_in_at"].is_string(), "{d}");
    assert_eq!(d["day"]["machine"], "Front door");
    assert_eq!(
        (
            d["can_app_out"].clone(),
            d["can_outdoor_in"].clone(),
            d["can_request_fix"].clone()
        ),
        (json!(true), json!(false), json!(true))
    );

    // No outdoor punch-in once in at the machine.
    let r = t
        .rpc(
            "outdoor_punch_in",
            json!({ "p_reason": "Client visit", "p_photo_file_version_id": Uuid::new_v4() }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);

    // App punch-out: not before the punch-in, an earlier time needs a reason.
    let r = t
        .rpc(
            "app_punch_out",
            json!({ "p_out_time": hhmm(120), "p_reason": "left" }),
            &member.cookie,
        )
        .await;
    assert_eq!(
        r.body["error"]["field_errors"]["out_time"], "before_in",
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "app_punch_out",
            json!({ "p_out_time": hhmm(40) }),
            &member.cookie,
        )
        .await;
    assert_eq!(
        r.body["error"]["field_errors"]["reason"], "required",
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "app_punch_out",
            json!({ "p_date": "2020-01-01" }),
            &member.cookie,
        )
        .await;
    assert_eq!(
        r.body["error"]["field_errors"]["date"], "too_old",
        "{}",
        r.body
    );
    let r = t.rpc("app_punch_out", json!({}), &member.cookie).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.rpc("app_punch_out", json!({}), &member.cookie).await;
    assert_eq!(r.status, StatusCode::CONFLICT, "{}", r.body);
    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(day.body["data"]["day"]["out_source"], "app");
    assert!(day.body["data"]["day"]["worked_minutes"].as_i64().unwrap() >= 89);
    assert_eq!(day.body["data"]["can_app_out"], false);
    let board = t.rpc("list_attendance_day", json!({}), &hr.cookie).await;
    let row = board.body["data"]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["employee"]["id"] == json!(member.id))
        .unwrap()
        .clone();
    assert_eq!(row["status"], "app_checkout", "{row}");
    // A punch-out at the machine later still wins.
    let r = t
        .dpost(&path, &format!("{pin}\t{}\t1\t1\t0\t0\t0\n", local_now(0)))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(day.body["data"]["day"]["out_source"], "device");

    // Wrong time: ask HR to fix it.
    let ask = |inn: Value, reason: &'static str| {
        let (t, c) = (&t, member.cookie.clone());
        async move {
            t.rpc(
                "request_punch_fix",
                json!({ "p_date": null, "p_in_time": inn, "p_out_time": null, "p_reason": reason }),
                &c,
            )
            .await
        }
    };
    assert_eq!(
        ask(json!(null), "machine was slow").await.body["error"]["field_errors"]["in_time"],
        "required"
    );
    assert_eq!(
        ask(json!("25:99"), "machine was slow").await.body["error"]["field_errors"]["in_time"],
        "invalid"
    );
    let fix = ask(json!(hhmm(100)), "Machine queue at the door").await;
    assert_eq!(fix.status, StatusCode::OK, "{}", fix.body);
    assert_eq!(
        ask(json!(hhmm(100)), "Machine queue again").await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(t.notified(&hr.id, "attendance.fix_requested").await, 1);
    let id = fix.body["data"]["id"].as_str().unwrap().to_owned();
    let mine = t.rpc("list_punch_fixes", json!({}), &member.cookie).await;
    assert_eq!(mine.body["data"][0]["can_withdraw"], true);
    assert_eq!(mine.body["data"][0]["can_review"], false);
    let r = t
        .rpc(
            "review_punch_fix",
            json!({ "p_id": id, "p_approve": true }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::FORBIDDEN);
    let r = t
        .rpc(
            "review_punch_fix",
            json!({ "p_id": id, "p_approve": false }),
            &hr.cookie,
        )
        .await;
    assert_eq!(r.body["error"]["field_errors"]["note"], "required");
    let before = t
        .rpc("get_my_punch_day", json!({}), &member.cookie)
        .await
        .body["data"]["day"]["worked_minutes"]
        .as_i64()
        .unwrap();
    let r = t
        .rpc(
            "review_punch_fix",
            json!({ "p_id": id, "p_approve": true }),
            &hr.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["status"], "approved");
    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(day.body["data"]["day"]["in_corrected"], true);
    assert!(
        day.body["data"]["day"]["worked_minutes"].as_i64().unwrap() > before,
        "{}",
        day.body
    );
    assert_eq!(t.notified(&member.id, "attendance.fix_approved").await, 1);
    let r = t
        .rpc(
            "review_punch_fix",
            json!({ "p_id": id, "p_approve": true }),
            &hr.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);
}

fn tiny_jpeg() -> Vec<u8> {
    let mut b = vec![
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08,
    ];
    b.extend(480u16.to_be_bytes());
    b.extend(640u16.to_be_bytes());
    b.extend([3, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    b
}

#[tokio::test]
async fn outdoor_punch_in_with_a_photo_counts_and_the_leader_can_reject_it() {
    let (store, _dir) = temp_store();
    let Some(t) = setup_with(Some(store)).await else {
        return;
    };
    let admin = t.admin().await;
    let (lead, member, other, hr) = t.reporting_lines(&admin).await;
    let photo = t
        .upload(
            Some(&member.cookie),
            "class=correction_attachment&filename=site.jpg",
            "image/jpeg",
            tiny_jpeg(),
        )
        .await;
    assert_eq!(photo.status, StatusCode::CREATED, "{}", photo.body);
    let ver = photo.body["data"]["file_version_id"]
        .as_str()
        .unwrap()
        .to_owned();

    let r = t
        .rpc(
            "outdoor_punch_in",
            json!({ "p_reason": "x", "p_photo_file_version_id": null }),
            &member.cookie,
        )
        .await;
    assert!(
        r.body["error"]["field_errors"]["reason"].is_string(),
        "{}",
        r.body
    );
    assert_eq!(
        r.body["error"]["field_errors"]["photo"],
        "Take a photo as proof"
    );
    // Someone else's photo is refused.
    let r = t
        .rpc(
            "outdoor_punch_in",
            json!({ "p_reason": "Client visit at Anna Nagar", "p_photo_file_version_id": ver }),
            &other.cookie,
        )
        .await;
    assert_eq!(
        r.body["error"]["field_errors"]["photo"], "Take the photo again",
        "{}",
        r.body
    );
    let r = t
        .rpc(
            "outdoor_punch_in",
            json!({ "p_reason": "Client visit at Anna Nagar", "p_photo_file_version_id": ver,
        "p_latitude": 13.08, "p_longitude": 80.27 }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["status"], "counted");
    let id = r.body["data"]["id"].as_str().unwrap().to_owned();
    let r = t
        .rpc(
            "outdoor_punch_in",
            json!({ "p_reason": "Client visit again", "p_photo_file_version_id": ver }),
            &member.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::CONFLICT);

    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(
        day.body["data"]["outdoor"]["status"], "counted",
        "{}",
        day.body
    );
    assert_eq!(
        (
            day.body["data"]["can_outdoor_in"].clone(),
            day.body["data"]["can_app_out"].clone()
        ),
        (json!(false), json!(true))
    );

    // The leader and HR are told and can see it (and the photo); others cannot.
    assert_eq!(t.notified(&lead.id, "attendance.outdoor_in").await, 1);
    assert_eq!(t.notified(&hr.id, "attendance.outdoor_in").await, 1);
    assert_eq!(t.notified(&other.id, "attendance.outdoor_in").await, 0);
    let l = t.rpc("list_outdoor_punches", json!({}), &lead.cookie).await;
    assert_eq!(
        l.body["data"]["rows"].as_array().unwrap().len(),
        1,
        "{}",
        l.body
    );
    assert_eq!(l.body["data"]["rows"][0]["can_reject"], true);
    let o = t
        .rpc("list_outdoor_punches", json!({}), &other.cookie)
        .await;
    assert_eq!(o.body["data"]["rows"], json!([]));
    let (s, _, _) = t
        .fetch(&lead.cookie, &format!("/v1/files/{ver}?purpose=review"))
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _, _) = t
        .fetch(&other.cookie, &format!("/v1/files/{ver}?purpose=review"))
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);

    // Punch out from the app, then the leader rejects it.
    let r = t.rpc("app_punch_out", json!({}), &member.cookie).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let rej = |c: String, reason: &'static str| {
        let (t, id) = (&t, id.clone());
        async move {
            t.rpc(
                "reject_outdoor_punch",
                json!({ "p_id": id, "p_reason": reason }),
                &c,
            )
            .await
        }
    };
    assert_eq!(
        rej(other.cookie.clone(), "No").await.status,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        rej(member.cookie.clone(), "No").await.status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        rej(lead.cookie.clone(), "").await.body["error"]["field_errors"]["reason"],
        "required"
    );
    let r = rej(lead.cookie.clone(), "Not on the visit plan").await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    assert_eq!(r.body["data"]["status"], "rejected");
    assert_eq!(
        rej(hr.cookie.clone(), "Again").await.status,
        StatusCode::CONFLICT
    );
    assert_eq!(
        t.notified(&member.id, "attendance.outdoor_rejected").await,
        1
    );
    let day = t.rpc("get_my_punch_day", json!({}), &member.cookie).await;
    assert_eq!(day.body["data"]["outdoor"]["status"], "rejected");
    assert_eq!(
        day.body["data"]["outdoor"]["reject_reason"],
        "Not on the visit plan"
    );
}

#[tokio::test]
async fn with_a_machine_the_app_cannot_punch_in() {
    let t = setup!();
    let admin = t.admin().await;
    let p = t.puncher(&admin, "WEB009").await;
    let mut a = Authenticator::new(ORIGIN);
    let reg = t.register_passkey(&p, &a).await;
    let device = reg.body["data"]["device_id"].as_str().unwrap().to_owned();
    t.machine(&admin, json!({})).await;
    let body = t.punch_body(&p, &mut a, &device, "IN", p.instance).await;
    let r = t.post("/v1/punch", body, Some(&p.cookie)).await;
    assert_eq!(r.status, StatusCode::UNPROCESSABLE_ENTITY, "{}", r.body);
    assert_eq!(
        r.body["error"]["field_errors"]["action"], "punch_in_at_machine",
        "{}",
        r.body
    );
    let n: i64 =
        sqlx::query_scalar("select count(*) from hrms.attendance_sessions where employee_id = $1")
            .bind(p.employee_id)
            .fetch_one(&t.pool)
            .await
            .unwrap();
    assert_eq!(n, 0);
}

#[tokio::test]
async fn dashboard_is_scoped_per_role() {
    let t = setup!();
    let admin = t.admin().await;
    let (lead, member, other, hr) = t.reporting_lines(&admin).await;
    let sn = t.machine(&admin, json!({})).await;
    let pin = t.pins_of(&member.id).await[0].1.clone();
    let path = format!("/iclock/cdata?SN={sn}&table=ATTLOG&Stamp=1");
    let r = t
        .dpost(&path, &format!("{pin}\t{}\t0\t1\t0\t0\t0\n", local_now(60)))
        .await;
    assert_eq!(r.status, StatusCode::OK);
    let r = t
        .rpc(
            "create_task",
            json!({ "p_assigned_to": member.id, "p_title": "Ship it" }),
            &lead.cookie,
        )
        .await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);
    let r = t.rpc("save_work_log", json!({ "p_id": null, "p_work_date": local_now(0)[..10], "p_title": "Calls",
        "p_details": "Called customers", "p_minutes": 45, "p_task_id": null, "p_expected_version": null }), &member.cookie).await;
    assert_eq!(r.status, StatusCode::OK, "{}", r.body);

    let m = t.rpc("get_dashboard", json!({}), &member.cookie).await;
    assert_eq!(m.status, StatusCode::OK, "{}", m.body);
    let me = &m.body["data"]["me"];
    assert!(me["today"]["first_in_at"].is_string(), "{me}");
    assert_eq!(me["month"]["days"], 1);
    assert_eq!(me["tasks"]["open"], 1);
    assert_eq!(
        (
            me["report_entries_today"].clone(),
            me["report_minutes_today"].clone()
        ),
        (json!(1), json!(45))
    );
    assert_eq!(me["week"].as_array().unwrap().len(), 7);
    assert_eq!(me["week"][6]["in"], true);
    assert_eq!(
        (
            m.body["data"]["team"].clone(),
            m.body["data"]["org"].clone()
        ),
        (Value::Null, Value::Null)
    );

    let l = t.rpc("get_dashboard", json!({}), &lead.cookie).await;
    let team = &l.body["data"]["team"];
    assert_eq!(
        (
            team["total"].clone(),
            team["punched_in"].clone(),
            team["in_now"].clone()
        ),
        (json!(1), json!(1), json!(1)),
        "{team}"
    );
    assert_eq!(
        (team["reports"].clone(), team["open_tasks"].clone()),
        (json!(1), json!(1))
    );
    assert_eq!(l.body["data"]["org"], Value::Null);
    let o = t.rpc("get_dashboard", json!({}), &other.cookie).await;
    assert_eq!(o.body["data"]["team"], Value::Null);

    let h = t.rpc("get_dashboard", json!({}), &hr.cookie).await;
    let org = &h.body["data"]["org"];
    assert!(org["total"].as_i64().unwrap() >= 5, "{org}");
    assert_eq!(org["punched_in"], 1);
    assert_eq!(org["week"].as_array().unwrap().len(), 7);
    assert_eq!(org["week"][6]["punched_in"], 1);
    assert_eq!(org["waiting"]["punch_fixes"], 0);
}
