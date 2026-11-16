//! HTTP routes for sign-in, sign-out, password change, reauthentication,
//! account provisioning/reset (ports of the HRMS auth-* and admin-users Edge
//! Functions) and the generic RPC gateway.
//!
//! Every database step goes through the same `internal_*` SQL functions the
//! Edge Functions used, so authorisation, rate limits, audit and the
//! credential saga stay in SQL. Passwords are hashed here (argon2id) and only
//! the PHC string reaches the database.

use axum::{
    body::Bytes,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use super::{password, session::Session, token};
use crate::{
    app::{AppState, CLIENT_IP_HEADER, JsonBody, ok, request_id},
    db::{self, Caller, Claims},
    error::{ApiError, ApiResult},
    rpc,
};

const GENERIC_LOGIN_ERROR: &str = "Employee ID or password is incorrect.";
/// Absolute session lifetime (the cookie lives exactly as long).
pub const SESSION_SECONDS: i64 = 30 * 24 * 3600;

/// Actions that can be unlocked with a fresh password check (auth-reauth).
pub const REAUTH_ACTIONS: [&str; 6] = [
    "role.elevate",
    "archive.cleanup",
    "export.bulk_salary",
    "export.annual",
    "credentials.reset_admin",
    "mfa.reset",
];

fn login_failed(rid: Uuid) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "AUTH_FAILED", GENERIC_LOGIN_ERROR)
        .with_request_id(Some(rid.to_string()))
}

pub(super) async fn service(pool: &PgPool, rid: Uuid) -> ApiResult<Transaction<'static, Postgres>> {
    db::begin_as(pool, Caller::Service, rid).await
}

pub fn client_ip(headers: &HeaderMap) -> &str {
    headers
        .get(CLIENT_IP_HEADER)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
}

fn user_agent(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(200).collect())
}

fn str_field(v: &Option<String>, max_chars: usize) -> String {
    v.as_deref()
        .unwrap_or("")
        .trim()
        .chars()
        .take(max_chars)
        .collect()
}

fn require_uuid(v: Option<Uuid>, field: &str) -> ApiResult<Uuid> {
    v.ok_or_else(|| {
        ApiError::validation_field(field, "required", format!("Missing value: {field}."))
    })
}

/// Password hash stored for an alias, if the login exists.
pub(super) async fn stored_password(
    tx: &mut Transaction<'static, Postgres>,
    alias: &str,
) -> ApiResult<Option<(Uuid, Option<String>)>> {
    Ok(
        sqlx::query_as("select user_id, encrypted_password from iam.password_for_alias($1)")
            .bind(alias)
            .fetch_optional(&mut **tx)
            .await?,
    )
}

/// Creates a session row and returns the Set-Cookie value. Must run in its own
/// transaction AFTER any credentials barrier commits (the barrier compares
/// against the session's creation time).
pub(super) async fn issue_session(
    state: &AppState,
    rid: Uuid,
    user_id: Uuid,
    headers: &HeaderMap,
) -> ApiResult<header::HeaderValue> {
    let db = state.db()?;
    let (tok, hash) = token::new_session_token();
    let ip = token::ip_hash(&state.config.app_secret, client_ip(headers));
    let mut tx = service(&db.pool, rid).await?;
    sqlx::query("select iam.create_session($1, $2, $3, $4, make_interval(secs => $5))")
        .bind(user_id)
        .bind(&hash[..])
        .bind(user_agent(headers))
        .bind(ip)
        .bind(SESSION_SECONDS as f64)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(state.cookie.set(&tok, SESSION_SECONDS))
}

pub(super) fn with_cookie(body: impl IntoResponse, cookie: header::HeaderValue) -> Response {
    let mut res = body.into_response();
    res.headers_mut().append(header::SET_COOKIE, cookie);
    res
}

// ------------------------------------------------------------------ login

#[derive(Deserialize)]
pub struct LoginBody {
    org_code: Option<String>,
    employee_code: Option<String>,
    password: Option<String>,
}

pub async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    JsonBody(body): JsonBody<LoginBody>,
) -> ApiResult<Response> {
    let rid = request_id(&headers);
    let db = state.db()?;
    let code = str_field(&body.employee_code, 64);
    let org = str_field(&body.org_code, 32);
    let pw = body.password.unwrap_or_default();
    if code.is_empty() || pw.is_empty() || pw.chars().count() > 256 {
        return Err(login_failed(rid));
    }
    let ip = token::ip_hash(&state.config.app_secret, client_ip(&headers));

    // 1. Rate limits + alias lookup (committed even when the login fails).
    let mut tx = service(&db.pool, rid).await?;
    let lookup: Value = sqlx::query_scalar(
        "select public.internal_login_lookup(p_org_code => $1, p_employee_code => $2, p_ip_hash => $3)",
    )
    .bind(&org)
    .bind(&code)
    .bind(&ip)
    .fetch_one(&mut *tx)
    .await?;
    if lookup["allowed"] != json!(true) {
        tx.commit().await?;
        return Err(ApiError::rate_limited().with_request_id(Some(rid.to_string())));
    }
    let alias = lookup["alias"].as_str().map(str::to_owned);
    let stored = match &alias {
        Some(a) => stored_password(&mut tx, a).await?,
        None => None,
    };
    tx.commit().await?;

    // 2. Verify off the async runtime. Unknown IDs still pay the full cost.
    let phc = stored.as_ref().and_then(|(_, p)| p.clone());
    let verified = password::verify_async(pw, phc).await;
    let user_id = stored.as_ref().map(|(id, _)| *id);
    let success = verified && alias.is_some() && user_id.is_some();

    // 3. Record the outcome (failure counters, audit, alias anomaly check).
    let mut tx = service(&db.pool, rid).await?;
    let result: Value = sqlx::query_scalar(
        "select public.internal_login_result(p_org_code => $1, p_employee_code => $2, p_ip_hash => $3,
                                             p_success => $4, p_auth_user_id => $5)",
    )
    .bind(&org)
    .bind(&code)
    .bind(&ip)
    .bind(success)
    .bind(if success { user_id } else { None })
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    if !success || result["ok"] != json!(true) {
        return Err(login_failed(rid));
    }

    let user_id = user_id.expect("checked");
    let data = json!({
        "must_change_password": result["must_change_password"].as_bool().unwrap_or(false),
        "credential_hold": result["credential_hold"].as_bool().unwrap_or(false),
    });
    // Two-step sign-in: no session until the code is right.
    if let Some(challenge) =
        super::two_step::challenge_if_enabled(&state, rid, user_id, &data).await?
    {
        return Ok(ok(
            json!({ "two_step_required": true, "challenge": challenge }),
            rid,
        )
        .into_response());
    }
    let cookie = issue_session(&state, rid, user_id, &headers).await?;
    Ok(with_cookie(ok(data, rid), cookie))
}

// ----------------------------------------------------------------- logout

/// Always succeeds and always clears the cookie (idempotent).
pub async fn logout(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<Response> {
    let rid = request_id(&headers);
    if let (Some(hash), Ok(db)) = (
        state.cookie.read(&headers).and_then(token::hash_presented),
        state.db(),
    ) {
        let mut tx = service(&db.pool, rid).await?;
        sqlx::query("select iam.delete_session(session_id) from iam.resolve_session($1)")
            .bind(&hash[..])
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
    }
    Ok(with_cookie(
        ok(json!({ "signed_out": true }), rid),
        state.cookie.clear(),
    ))
}

// ------------------------------------------------------------ shared actor

pub(super) struct Actor {
    pub(super) employee_id: Uuid,
    pub(super) employee_code: String,
    pub(super) auth_alias: String,
}

pub(super) async fn resolve_actor(
    tx: &mut Transaction<'static, Postgres>,
    c: &Claims,
    mode: &str,
) -> ApiResult<Actor> {
    let v: Value = sqlx::query_scalar(
        "select public.internal_resolve_actor(p_auth_user_id => $1, p_session_id => $2, p_email => $3, p_mode => $4)",
    )
    .bind(c.sub)
    .bind(c.session_id)
    .bind(&c.email)
    .bind(mode)
    .fetch_one(&mut **tx)
    .await?;
    let employee_id = v["employee_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(ApiError::auth_required)?;
    Ok(Actor {
        employee_id,
        employee_code: v["employee_code"].as_str().unwrap_or_default().to_owned(),
        auth_alias: v["auth_alias"].as_str().unwrap_or_default().to_owned(),
    })
}

pub(super) async fn rate_limit(
    tx: &mut Transaction<'static, Postgres>,
    bucket: &str,
    window_seconds: i32,
    max: i32,
) -> ApiResult<bool> {
    Ok(sqlx::query_scalar(
        "select public.internal_rate_limit(p_bucket => $1, p_window_seconds => $2, p_max => $3)",
    )
    .bind(bucket)
    .bind(window_seconds)
    .bind(max)
    .fetch_one(&mut **tx)
    .await?)
}

struct Begin {
    stage: String,
    target_auth_user_id: Uuid,
    target_alias: String,
    employee_code: String,
}

async fn credential_begin(
    tx: &mut Transaction<'static, Postgres>,
    c: &Claims,
    operation_id: Uuid,
    kind: &str,
    target: Option<Uuid>,
) -> ApiResult<Begin> {
    let v: Value = sqlx::query_scalar(
        "select public.internal_credential_begin(p_auth_user_id => $1, p_session_id => $2, p_email => $3,
                 p_operation_id => $4, p_kind => $5, p_target_employee_id => $6)",
    )
    .bind(c.sub)
    .bind(c.session_id)
    .bind(&c.email)
    .bind(operation_id)
    .bind(kind)
    .bind(target)
    .fetch_one(&mut **tx)
    .await?;
    Ok(Begin {
        stage: v["stage"].as_str().unwrap_or_default().to_owned(),
        target_auth_user_id: v["target_auth_user_id"]
            .as_str()
            .and_then(|s| Uuid::parse_str(s).ok())
            .ok_or_else(ApiError::internal)?,
        target_alias: v["target_alias"].as_str().unwrap_or_default().to_owned(),
        employee_code: v["employee_code"].as_str().unwrap_or_default().to_owned(),
    })
}

async fn credential_fail(
    pool: &PgPool,
    rid: Uuid,
    operation_id: Uuid,
    actor: Uuid,
    error: &str,
) -> ApiResult<()> {
    let mut tx = service(pool, rid).await?;
    sqlx::query(
        "select public.internal_credential_fail(p_operation_id => $1, p_actor_employee_id => $2,
                 p_auth_unchanged => true, p_error => $3)",
    )
    .bind(operation_id)
    .bind(actor)
    .bind(error)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

/// Sets the new hash, closes the saga and signs the account out everywhere —
/// in ONE transaction, so the password and the barrier never disagree.
async fn apply_password(
    pool: &PgPool,
    rid: Uuid,
    user_id: Uuid,
    phc: &str,
    operation_id: Uuid,
    actor: Uuid,
) -> ApiResult<()> {
    let mut tx = service(pool, rid).await?;
    let found: bool = sqlx::query_scalar("select iam.set_password($1, $2)")
        .bind(user_id)
        .bind(phc)
        .fetch_one(&mut *tx)
        .await?;
    if !found {
        tracing::error!(%user_id, "credential target has no login row");
        return Err(ApiError::internal());
    }
    sqlx::query(
        "select public.internal_credential_finalize(p_operation_id => $1, p_actor_employee_id => $2)",
    )
    .bind(operation_id)
    .bind(actor)
    .execute(&mut *tx)
    .await?;
    sqlx::query("select iam.delete_user_sessions($1, null)")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

// --------------------------------------------------------- password change

#[derive(Deserialize)]
pub struct PasswordBody {
    operation_id: Option<Uuid>,
    current_password: Option<String>,
    new_password: Option<String>,
}

pub async fn change_password(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    JsonBody(body): JsonBody<PasswordBody>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    let operation_id = require_uuid(body.operation_id, "operation_id").map_err(tag)?;
    let current = body.current_password.unwrap_or_default();
    if current.is_empty() || current.chars().count() > 256 {
        return Err(tag(ApiError::validation_field(
            "current_password",
            "Required",
            "Enter your current password.",
        )));
    }
    let next = body.new_password.unwrap_or_default();

    let mut tx = service(&db.pool, rid).await?;
    let actor = resolve_actor(&mut tx, &session.claims, "restricted")
        .await
        .map_err(tag)?;
    password::validate_new(&next, Some(&actor.employee_code)).map_err(tag)?;
    if next == current {
        return Err(tag(ApiError::validation_field(
            "new_password",
            "Must differ from current password",
            "Choose a password different from the current one.",
        )));
    }
    if !rate_limit(&mut tx, &format!("pwchange:{}", actor.employee_id), 900, 10).await? {
        tx.commit().await?;
        return Err(tag(ApiError::rate_limited()));
    }
    let begin = credential_begin(&mut tx, &session.claims, operation_id, "self_change", None)
        .await
        .map_err(tag)?;
    let stored = stored_password(&mut tx, &begin.target_alias).await?;
    tx.commit().await?;
    if begin.stage == "finalized" {
        return Ok(ok(json!({ "status": "completed" }), rid).into_response());
    }
    let phc = stored.and_then(|(_, p)| p);

    if !password::verify_async(current, phc).await {
        credential_fail(
            &db.pool,
            rid,
            operation_id,
            actor.employee_id,
            "current password rejected",
        )
        .await?;
        return Err(tag(ApiError::validation_field(
            "current_password",
            "Incorrect",
            "Your current password is incorrect.",
        )));
    }

    let new_phc = password::hash_async(next).await?;
    apply_password(
        &db.pool,
        rid,
        begin.target_auth_user_id,
        &new_phc,
        operation_id,
        actor.employee_id,
    )
    .await
    .map_err(tag)?;
    // Every older session (including this one) is gone; hand out a fresh one.
    let cookie = issue_session(&state, rid, begin.target_auth_user_id, &headers).await?;
    Ok(with_cookie(
        ok(json!({ "status": "completed" }), rid),
        cookie,
    ))
}

// ------------------------------------------------------------ reauthenticate

#[derive(Deserialize)]
pub struct ReauthBody {
    password: Option<String>,
    action: Option<String>,
    target_id: Option<String>,
}

pub async fn reauth(
    State(state): State<AppState>,
    session: Session,
    JsonBody(body): JsonBody<ReauthBody>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    let action = body.action.unwrap_or_default();
    if !REAUTH_ACTIONS.contains(&action.as_str()) {
        return Err(tag(ApiError::validation_field(
            "action",
            "unknown",
            "Unknown action.",
        )));
    }
    let pw = body.password.unwrap_or_default();
    if pw.is_empty() || pw.chars().count() > 256 {
        return Err(tag(ApiError::validation_field(
            "password",
            "Required",
            "Enter your password.",
        )));
    }
    let target = body
        .target_id
        .as_deref()
        .and_then(|s| Uuid::parse_str(s).ok());

    let mut tx = service(&db.pool, rid).await?;
    let actor = resolve_actor(&mut tx, &session.claims, "business")
        .await
        .map_err(tag)?;
    if !rate_limit(&mut tx, &format!("reauth:{}", actor.employee_id), 900, 5).await? {
        tx.commit().await?;
        return Err(tag(ApiError::rate_limited()));
    }
    let stored = stored_password(&mut tx, &actor.auth_alias).await?;
    tx.commit().await?;
    let phc = stored
        .filter(|(id, _)| *id == session.claims.sub)
        .and_then(|(_, p)| p);
    if !password::verify_async(pw, phc).await {
        let mut e = ApiError::new(
            StatusCode::FORBIDDEN,
            "REAUTH_REQUIRED",
            "Password is incorrect.",
        );
        e.field_errors = json!({ "password": "Incorrect" });
        return Err(tag(e));
    }

    let mut tx = service(&db.pool, rid).await?;
    let c = &session.claims;
    let grant: Value = sqlx::query_scalar(
        "select public.internal_issue_reauth_grant(p_auth_user_id => $1, p_session_id => $2, p_email => $3,
                 p_action => $4, p_target => $5)",
    )
    .bind(c.sub)
    .bind(c.session_id)
    .bind(&c.email)
    .bind(&action)
    .bind(target)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| tag(e.into()))?;
    tx.commit().await?;
    Ok(ok(grant, rid).into_response())
}

// ------------------------------------------------------- admin: new account

#[derive(Deserialize)]
pub struct ProvisionBody {
    operation_id: Option<Uuid>,
    fields: Option<Value>,
    /// Optional eSSL machine user (PIN) to give the new hire.
    device_pin: Option<String>,
    device_serial: Option<String>,
}

pub async fn provision_user(
    State(state): State<AppState>,
    session: Session,
    JsonBody(body): JsonBody<ProvisionBody>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    let operation_id = require_uuid(body.operation_id, "operation_id").map_err(tag)?;
    let fields = match body.fields {
        Some(f @ Value::Object(_)) => f,
        _ => return Err(tag(ApiError::validation("Missing fields."))),
    };
    let c = &session.claims;

    let mut tx = service(&db.pool, rid).await?;
    let begin: Value = sqlx::query_scalar(
        "select public.internal_provision_begin(p_auth_user_id => $1, p_session_id => $2, p_email => $3,
                 p_operation_id => $4, p_fields => $5, p_alias_domain => $6)",
    )
    .bind(c.sub)
    .bind(c.session_id)
    .bind(&c.email)
    .bind(operation_id)
    .bind(&fields)
    .bind(&state.config.alias_domain)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| tag(e.into()))?;
    tx.commit().await?;
    let employee_id = begin["employee_id"]
        .as_str()
        .and_then(|s| Uuid::parse_str(s).ok());
    let alias = begin["auth_alias"].as_str().unwrap_or_default().to_owned();
    let (Some(employee_id), false) = (employee_id, alias.is_empty()) else {
        return Err(tag(ApiError::internal()));
    };
    if begin["provisioning_state"] == json!("complete") {
        return Ok(ok(
            json!({ "employee_id": employee_id, "already": true, "temporary_password": null }),
            rid,
        )
        .into_response());
    }

    // Optional machine PIN, claimed as the HR/Admin user (their permissions).
    let mut device = Value::Null;
    if let Some(pin) = body.device_pin.filter(|p| !p.trim().is_empty()) {
        let mut tx = db::begin_as(&db.pool, Caller::User(c), rid).await?;
        device = sqlx::query_scalar(
            "select public.claim_device_pin_for_hire(p_employee_id => $1, p_serial => $2, p_pin => $3)",
        )
        .bind(employee_id)
        .bind(body.device_serial.unwrap_or_default())
        .bind(pin)
        .fetch_one(&mut *tx)
        .await
        .map_err(|e| tag(e.into()))?;
        tx.commit().await?;
        device = device.get("data").cloned().unwrap_or(device);
    }

    let temp = password::temporary();
    let phc = password::hash_async(temp.clone()).await?;
    let mut tx = service(&db.pool, rid).await?;
    // A retry after a crash finds the login row from the first attempt.
    let user_id = match stored_password(&mut tx, &alias).await? {
        Some((id, _)) => {
            sqlx::query("select iam.set_password($1, $2)")
                .bind(id)
                .bind(&phc)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            sqlx::query_scalar("select iam.create_user($1, $2)")
                .bind(&alias)
                .bind(&phc)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    let link: Value = sqlx::query_scalar(
        "select public.internal_provision_link(p_auth_user_id => $1, p_session_id => $2, p_email => $3,
                 p_operation_id => $4, p_new_auth_user_id => $5)",
    )
    .bind(c.sub)
    .bind(c.session_id)
    .bind(&c.email)
    .bind(operation_id)
    .bind(user_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|e| tag(e.into()))?;
    tx.commit().await?;
    Ok(ok(
        json!({
            "employee_id": link["employee_id"],
            "employee_code": link["employee_code"],
            "temporary_password": temp,
            "already": false,
            "device": device,
        }),
        rid,
    )
    .into_response())
}

// ----------------------------------------------------- admin: reset password

#[derive(Deserialize)]
pub struct ResetBody {
    operation_id: Option<Uuid>,
}

pub async fn reset_password(
    State(state): State<AppState>,
    session: Session,
    Path(employee_id): Path<String>,
    JsonBody(body): JsonBody<ResetBody>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    let employee_id = Uuid::parse_str(&employee_id).map_err(|_| tag(ApiError::not_found()))?;
    let operation_id = require_uuid(body.operation_id, "operation_id").map_err(tag)?;

    let mut tx = service(&db.pool, rid).await?;
    let actor = resolve_actor(&mut tx, &session.claims, "business")
        .await
        .map_err(tag)?;
    let begin = credential_begin(
        &mut tx,
        &session.claims,
        operation_id,
        "admin_reset",
        Some(employee_id),
    )
    .await
    .map_err(tag)?;
    tx.commit().await?;
    if begin.stage == "finalized" {
        return Err(tag(ApiError::new(
            StatusCode::CONFLICT,
            "CONFLICT",
            "This reset already finished. Start a new reset to get a new password.",
        )));
    }
    let temp = password::temporary();
    let phc = password::hash_async(temp.clone()).await?;
    apply_password(
        &db.pool,
        rid,
        begin.target_auth_user_id,
        &phc,
        operation_id,
        actor.employee_id,
    )
    .await
    .map_err(tag)?;
    Ok(ok(
        json!({ "employee_id": employee_id, "employee_code": begin.employee_code, "temporary_password": temp }),
        rid,
    )
    .into_response())
}

// ---------------------------------------------------------------- RPC gateway

/// Function names are plain identifiers; `internal_*` never reaches the catalog
/// lookup (it would 404 there anyway, this just keeps the intent explicit).
pub fn rpc_name_ok(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && !name.starts_with("internal_")
        && !name.starts_with('_')
}

pub async fn rpc(
    State(state): State<AppState>,
    session: Session,
    Path(name): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    if !rpc_name_ok(&name) {
        return Err(tag(ApiError::not_found()));
    }
    let args: Value = if body.iter().all(u8::is_ascii_whitespace) {
        Value::Null
    } else {
        let is_json = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| {
                v.split(';')
                    .next()
                    .is_some_and(|m| m.trim() == "application/json")
            });
        if !is_json {
            return Err(tag(ApiError::new(
                StatusCode::UNSUPPORTED_MEDIA_TYPE,
                "UNSUPPORTED_MEDIA_TYPE",
                "Send JSON (Content-Type: application/json).",
            )));
        }
        serde_json::from_slice(&body).map_err(|_| {
            tag(ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_JSON",
                "The request body is not valid JSON.",
            ))
        })?
    };
    let db = state.db()?;
    let out = rpc::call_public(&db.pool, &db.catalog, &session.claims, &name, args, rid)
        .await
        .map_err(tag)?;
    Ok(axum::Json(out).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rpc_names() {
        assert!(rpc_name_ok("get_session_context"));
        assert!(rpc_name_ok("list_my_sessions"));
        assert!(!rpc_name_ok("internal_login_lookup"));
        assert!(!rpc_name_ok("_hidden"));
        assert!(!rpc_name_ok(""));
        assert!(!rpc_name_ok("Get_Session"));
        assert!(!rpc_name_ok("a;drop"));
        assert!(!rpc_name_ok("a\"b"));
        assert!(!rpc_name_ok("hrms.ok"));
        assert!(!rpc_name_ok(&"a".repeat(64)));
        assert!(rpc_name_ok(&"a".repeat(63)));
    }

    #[test]
    fn reauth_allowlist_matches_sql() {
        // The newest definition of the grants table's action check.
        let sql = include_str!("../../migrations/20261114180000_web_two_step.sql");
        let start = sql
            .find("reauthentication_grants_action_check check (action in (")
            .expect("constraint");
        let list = &sql[start..start + sql[start..].find("))").unwrap()];
        let in_sql: Vec<&str> = list.split('\'').skip(1).step_by(2).collect();
        assert_eq!(in_sql, REAUTH_ACTIONS.to_vec());
        assert!(!REAUTH_ACTIONS.contains(&"role.elevate "));
    }

    #[test]
    fn field_trimming() {
        assert_eq!(str_field(&Some("  emp001  ".into()), 64), "emp001");
        assert_eq!(str_field(&None, 64), "");
        assert_eq!(str_field(&Some("é".repeat(100)), 64).chars().count(), 64);
    }
}
