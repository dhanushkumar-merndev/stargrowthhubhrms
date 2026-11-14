//! Browser punching: passkey registration and signed punches (ports of the
//! HRMS `device-register` and `punch` Edge Functions for WebAuthn).
//!
//! Punch order mirrors the Edge Function (architecture §5.1): trusted receipt
//! time -> authenticate -> committed-replay lookup (original result before any
//! freshness or signature check) -> passkey assertion over the server-rebuilt
//! canonical payload -> counter -> transactional commit in SQL, where the
//! challenge, shift window, office, location and network rules are enforced.

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, TimeZone, Utc};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Instant;
use uuid::Uuid;

use crate::{
    app::{AppState, JsonBody, ok},
    auth::{routes::client_ip, session::Session, token},
    db,
    error::{ApiError, ApiResult},
    webauthn::{self, Fail},
};

const DEADLINE_SECS: u64 = 30;

fn verification_failed(message: &str, retryable: bool) -> ApiError {
    let mut e = ApiError::new(StatusCode::FORBIDDEN, "VERIFICATION_FAILED", message);
    e.retryable = retryable;
    e
}

fn actor(c: &db::Claims) -> serde_json::Map<String, Value> {
    let mut m = serde_json::Map::new();
    m.insert("p_auth_user_id".into(), json!(c.sub));
    m.insert("p_session_id".into(), json!(c.session_id));
    m.insert("p_email".into(), json!(c.email));
    m
}

fn with(mut m: serde_json::Map<String, Value>, extra: Value) -> Value {
    if let Value::Object(e) = extra {
        m.extend(e);
    }
    Value::Object(m)
}

fn b64(s: &str, field: &str) -> ApiResult<Vec<u8>> {
    webauthn::from_b64url(s).ok_or_else(|| {
        ApiError::validation_field(field, "invalid", "The passkey response is malformed.")
    })
}

// ---------------------------------------------------------------- register

#[derive(Deserialize)]
pub struct RegisterBody {
    challenge_id: Uuid,
    nonce: String,
    credential_id: String,
    client_data_json: String,
    authenticator_data: String,
    installation_id: Option<Uuid>,
    device_label: Option<String>,
}

pub async fn register_device(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    JsonBody(b): JsonBody<RegisterBody>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    if b.nonce.len() > 128 || b.credential_id.len() > 1400 {
        return Err(tag(ApiError::validation(
            "The passkey response is malformed.",
        )));
    }
    let cd = b64(&b.client_data_json, "client_data_json").map_err(tag)?;
    let ad = b64(&b.authenticator_data, "authenticator_data").map_err(tag)?;
    let origin = &state.config.app_origin;
    let challenge = webauthn::registration_challenge(&b.challenge_id.to_string(), &b.nonce);
    let reg = webauthn::verify_registration(
        &cd,
        &ad,
        &b.credential_id,
        &challenge,
        origin,
        &webauthn::rp_id(origin),
    )
    .map_err(|f| {
        tracing::info!(reason = f.reason(), "passkey registration refused");
        tag(match f {
            Fail::UserVerification => verification_failed(
                "Turn on a screen lock (fingerprint, face or PIN) on this device, then try again.",
                false,
            ),
            _ => verification_failed(
                "This passkey could not be verified. Please try again.",
                true,
            ),
        })
    })?;
    let label = b
        .device_label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect::<String>())
        .or_else(|| {
            headers
                .get(header::USER_AGENT)
                .and_then(|v| v.to_str().ok())
                .map(|ua| ua.chars().take(120).collect())
        });
    let out = db::service_call(
        &db.pool,
        "internal_register_web_device",
        with(
            actor(&session.claims),
            json!({
                "p_challenge_id": b.challenge_id,
                "p_nonce": b.nonce,
                "p_installation_id": b.installation_id,
                "p_public_key_spki": reg.spki_b64,
                "p_credential_id": reg.credential_id,
                "p_sign_count": reg.sign_count,
                "p_device_label": label,
            }),
        ),
    )
    .await
    .map_err(tag)?;
    Ok(ok(out.get("data").cloned().unwrap_or(Value::Null), rid).into_response())
}

// ---------------------------------------------------------------- punch

#[derive(Deserialize)]
pub struct PunchBody {
    operation_key: Uuid,
    challenge_id: Uuid,
    nonce: String,
    action: String,
    target_id: Uuid,
    device_id: Uuid,
    office_id: Uuid,
    employee_id: Uuid,
    latitude: String,
    longitude: String,
    accuracy: String,
    sample_at_ms: String,
    client_data_json: String,
    authenticator_data: String,
    signature: String,
    #[serde(default)]
    credential_id: Option<String>,
}

/// The canonical punch payload v1, byte-identical to HRMS
/// `canonicalPayloadV1` / `hrms.punch_payload_v1` / Dart `PunchPayload`.
pub fn canonical_payload_v1(b: &PunchBody) -> String {
    [
        "hrms-punch-v1".to_owned(),
        b.challenge_id.to_string(),
        b.nonce.clone(),
        b.operation_key.to_string(),
        b.employee_id.to_string(),
        b.device_id.to_string(),
        b.action.clone(),
        b.target_id.to_string(),
        b.office_id.to_string(),
        b.latitude.clone(),
        b.longitude.clone(),
        b.accuracy.clone(),
        b.sample_at_ms.clone(),
    ]
    .join("\n")
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|c| c.is_ascii_digit())
}

/// `-?\d{1,int}\.\d{frac}`
fn decimal(s: &str, int: usize, frac: usize, signed: bool) -> bool {
    let s = if signed {
        s.strip_prefix('-').unwrap_or(s)
    } else {
        s
    };
    match s.split_once('.') {
        Some((i, f)) => digits(i) && i.len() <= int && digits(f) && f.len() == frac,
        None => false,
    }
}

/// Field rules of the Edge Function (`validatePunchFields`).
pub fn punch_field_errors(b: &PunchBody) -> serde_json::Map<String, Value> {
    let mut e = serde_json::Map::new();
    let bad = json!("Invalid");
    if b.action != "IN" && b.action != "OUT" {
        e.insert("action".into(), json!("IN or OUT"));
    }
    let lat_ok = decimal(&b.latitude, 2, 7, true)
        && b.latitude.parse::<f64>().is_ok_and(|v| v.abs() <= 90.0);
    if !lat_ok {
        e.insert("latitude".into(), bad.clone());
    }
    let lng_ok = decimal(&b.longitude, 3, 7, true)
        && b.longitude.parse::<f64>().is_ok_and(|v| v.abs() <= 180.0);
    if !lng_ok {
        e.insert("longitude".into(), bad.clone());
    }
    if !decimal(&b.accuracy, 4, 2, false) {
        e.insert("accuracy".into(), bad.clone());
    }
    if !(digits(&b.sample_at_ms) && b.sample_at_ms.len() == 13) {
        e.insert("sample_at_ms".into(), bad.clone());
    }
    let nonce_ok = (16..=128).contains(&b.nonce.len())
        && b.nonce
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_');
    if !nonce_ok {
        e.insert("nonce".into(), bad);
    }
    e
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

pub async fn punch(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    JsonBody(b): JsonBody<PunchBody>,
) -> ApiResult<Response> {
    let receipt_at: DateTime<Utc> = Utc::now();
    let started = Instant::now();
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let db = state.db()?;
    let pool = &db.pool;
    let ip = client_ip(&headers).trim().to_owned();
    let claims = &session.claims;

    let log_reject = |code: &'static str, reason: &'static str| {
        let args = json!({
            "p_auth_user_id": claims.sub,
            "p_code": code,
            "p_detail": { "reason": reason },
            "p_ip_hash": token::ip_hash(&state.config.app_secret, &ip),
        });
        async move {
            if let Err(e) = db::service_call(pool, "internal_log_punch_rejection", args).await {
                tracing::warn!(error = ?e, "could not log punch rejection");
            }
        }
    };

    let errors = punch_field_errors(&b);
    if !errors.is_empty() {
        log_reject("MALFORMED", "payload").await;
        let mut e = ApiError::new(
            StatusCode::BAD_REQUEST,
            "LOCATION_REQUIRED",
            "A valid location reading is required.",
        );
        e.field_errors = Value::Object(errors);
        return Err(tag(e));
    }
    let payload = canonical_payload_v1(&b);
    let payload_hash = sha256_hex(&payload);

    // 1. Committed replay: original result even if the challenge expired since.
    let lookup = db::service_call(
        pool,
        "internal_punch_lookup",
        with(
            actor(claims),
            json!({ "p_operation_key": b.operation_key, "p_payload_hash": payload_hash }),
        ),
    )
    .await
    .map_err(tag)?;
    if lookup["found"] == json!(true) {
        if lookup["conflict"] == json!(true) {
            return Err(tag(ApiError::new(
                StatusCode::CONFLICT,
                "IDEMPOTENCY_CONFLICT",
                "This punch was already recorded with different details.",
            )));
        }
        return Ok(envelope(lookup["result"].clone()));
    }

    // 2. The passkey belongs to the caller and signed exactly this payload.
    let device = db::service_call(
        pool,
        "internal_device_key",
        with(actor(claims), json!({ "p_device_id": b.device_id })),
    )
    .await
    .map_err(tag)?;
    let own = device["found"] == json!(true)
        && device["employee_id"].as_str() == Some(b.employee_id.to_string().as_str())
        && device["platform"] == json!("web");
    if !own {
        log_reject("DEVICE", "unregistered").await;
        return Err(tag(verification_failed(
            "This device is not registered for punching.",
            false,
        )));
    }
    if let (Some(sent), Some(stored)) =
        (b.credential_id.as_deref(), device["credential_id"].as_str())
        && webauthn::from_b64url(sent) != webauthn::from_b64url(stored)
    {
        log_reject("DEVICE", "credential").await;
        return Err(tag(verification_failed(
            "Use the passkey registered for punching on this device.",
            false,
        )));
    }
    let origin = &state.config.app_origin;
    let verified = (|| {
        let cd = webauthn::from_b64url(&b.client_data_json).ok_or(Fail::Malformed)?;
        let ad = webauthn::from_b64url(&b.authenticator_data).ok_or(Fail::Malformed)?;
        let sig = webauthn::from_b64url(&b.signature).ok_or(Fail::Malformed)?;
        webauthn::verify_assertion(
            device["public_key_spki"].as_str().unwrap_or_default(),
            &cd,
            &ad,
            &sig,
            &webauthn::punch_challenge(&payload),
            origin,
            &webauthn::rp_id(origin),
        )
    })();
    let sign_count = match verified {
        Ok(n) => n,
        Err(f) => {
            log_reject("SIGNATURE", f.reason()).await;
            return Err(tag(if f == Fail::UserVerification {
                verification_failed("Confirm with your fingerprint, face or device PIN.", true)
            } else {
                verification_failed("Verification failed. Please try again.", true)
            }));
        }
    };
    let counter_ok = db::service_call(
        pool,
        "internal_web_device_counter",
        json!({ "p_device_id": b.device_id, "p_sign_count": sign_count }),
    )
    .await
    .map_err(tag)?;
    if counter_ok != json!(true) {
        log_reject("SIGNATURE", "counter").await;
        return Err(tag(verification_failed(
            "This passkey could not be trusted. Register this device again.",
            false,
        )));
    }

    // 3. Bounded request deadline measured from trusted receipt time.
    if started.elapsed().as_secs() > DEADLINE_SECS {
        let mut e = verification_failed("Verification took too long. Please try again.", true);
        e.status = StatusCode::REQUEST_TIMEOUT;
        return Err(tag(e));
    }

    let sample_ms: i64 = b.sample_at_ms.parse().unwrap_or_default();
    let sample_at = Utc
        .timestamp_millis_opt(sample_ms)
        .single()
        .ok_or_else(|| {
            tag(ApiError::validation_field(
                "sample_at_ms",
                "invalid",
                "Invalid time.",
            ))
        })?;
    let result = db::service_call(
        pool,
        "internal_commit_punch",
        with(
            actor(claims),
            json!({
                "p_operation_key": b.operation_key,
                "p_payload_hash": payload_hash,
                "p_challenge_id": b.challenge_id,
                "p_action": b.action,
                "p_target_id": b.target_id,
                "p_device_id": b.device_id,
                "p_office_id": b.office_id,
                "p_latitude": b.latitude.parse::<f64>().unwrap_or(f64::NAN),
                "p_longitude": b.longitude.parse::<f64>().unwrap_or(f64::NAN),
                "p_accuracy": b.accuracy.parse::<f64>().unwrap_or(f64::NAN),
                "p_sample_at": sample_at,
                "p_receipt_at": receipt_at,
                "p_integrity": {
                    "level": "software",
                    "mock_location": false,
                    "client_ip": if ip.is_empty() { Value::Null } else { json!(ip) },
                    "signature_verified": true,
                    "user_verified": true,
                    "request_id": rid,
                },
            }),
        ),
    )
    .await
    .map_err(tag)?;
    Ok(envelope(result))
}

/// SQL returns `{ok:true,data}` or `{ok:false,error}`; failures are 422 like
/// the Edge Function, with our error shape.
fn envelope(result: Value) -> Response {
    let status = if result["ok"] == json!(false) {
        StatusCode::UNPROCESSABLE_ENTITY
    } else {
        StatusCode::OK
    };
    (status, axum::Json(result)).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn body() -> PunchBody {
        serde_json::from_value(json!({
            "operation_key": "6F1C1B5E-0000-4000-8000-000000000001",
            "challenge_id": "6f1c1b5e-0000-4000-8000-000000000002",
            "nonce": "abcdefghijklmnop",
            "action": "IN",
            "target_id": "6f1c1b5e-0000-4000-8000-000000000003",
            "device_id": "6f1c1b5e-0000-4000-8000-000000000004",
            "office_id": "6f1c1b5e-0000-4000-8000-000000000005",
            "employee_id": "6f1c1b5e-0000-4000-8000-000000000006",
            "latitude": "12.9716000",
            "longitude": "-77.5946000",
            "accuracy": "5.00",
            "sample_at_ms": "1763100000000",
            "client_data_json": "", "authenticator_data": "", "signature": ""
        }))
        .unwrap()
    }

    #[test]
    fn canonical_payload_matches_hrms_v1() {
        let p = canonical_payload_v1(&body());
        assert_eq!(
            p,
            "hrms-punch-v1\n6f1c1b5e-0000-4000-8000-000000000002\nabcdefghijklmnop\n\
             6f1c1b5e-0000-4000-8000-000000000001\n6f1c1b5e-0000-4000-8000-000000000006\n\
             6f1c1b5e-0000-4000-8000-000000000004\nIN\n6f1c1b5e-0000-4000-8000-000000000003\n\
             6f1c1b5e-0000-4000-8000-000000000005\n12.9716000\n-77.5946000\n5.00\n1763100000000"
        );
        assert!(!p.ends_with('\n'));
        // Golden value shared with web/test/punch.test.ts (cross-language check).
        assert_eq!(
            crate::webauthn::punch_challenge(&p),
            "9kisx0wwW07R3mlitQDtsWr62EvIZKfU6tMbVZxbo6k"
        );
        assert_eq!(
            crate::webauthn::registration_challenge("ABC", "n1"),
            "cw0rtAMvrNXDiOUYeCgMqt_Spm3pH5PwLyl5KG4X_Bc"
        );
    }

    #[test]
    fn field_rules() {
        assert!(punch_field_errors(&body()).is_empty());
        let check = |f: &dyn Fn(&mut PunchBody), field: &str| {
            let mut b = body();
            f(&mut b);
            assert!(
                punch_field_errors(&b).contains_key(field),
                "{field} should fail"
            );
        };
        check(&|b| b.action = "in".into(), "action");
        check(&|b| b.action = "BREAK".into(), "action");
        check(&|b| b.latitude = "12.97".into(), "latitude");
        check(&|b| b.latitude = "91.0000000".into(), "latitude");
        check(&|b| b.latitude = "123.0000000".into(), "latitude");
        check(&|b| b.latitude = "1e1".into(), "latitude");
        check(&|b| b.latitude = "NaN".into(), "latitude");
        check(&|b| b.longitude = "180.0000001".into(), "longitude");
        check(&|b| b.longitude = "+77.5946000".into(), "longitude");
        check(&|b| b.accuracy = "-1.00".into(), "accuracy");
        check(&|b| b.accuracy = "5".into(), "accuracy");
        check(&|b| b.accuracy = "12345.00".into(), "accuracy");
        check(&|b| b.sample_at_ms = "176310000000".into(), "sample_at_ms");
        check(
            &|b| b.sample_at_ms = "1763100000000.5".into(),
            "sample_at_ms",
        );
        check(&|b| b.nonce = "short".into(), "nonce");
        check(&|b| b.nonce = "abcdefghijklmnop!".into(), "nonce");
        check(&|b| b.nonce = "a".repeat(129), "nonce");
        let mut b = body();
        b.latitude = "-90.0000000".into();
        b.longitude = "180.0000000".into();
        assert!(
            punch_field_errors(&b).is_empty(),
            "the poles and the antimeridian are valid"
        );
    }
}
