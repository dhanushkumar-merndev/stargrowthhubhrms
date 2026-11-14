//! Two-step sign-in with an authenticator app (TOTP, RFC 6238 / RFC 4226).
//!
//!   POST /v1/auth/login/two-step        {challenge, code}      -> session
//!   POST /v1/auth/two-step/setup        {password}             -> secret, QR
//!   POST /v1/auth/two-step/enable       {code}                 -> recovery codes
//!   POST /v1/auth/two-step/disable      {password, code}
//!   POST /v1/auth/two-step/recovery     {password, code}       -> new codes
//!
//! The secret is sealed with AES-256-GCM under a key derived from APP_SECRET
//! (bound to the account id), so a database dump alone cannot mint codes.

use aes_gcm::{
    Aes256Gcm, Key, Nonce,
    aead::{Aead, KeyInit, Payload},
};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use serde_json::{Value, json};
use sha1::Sha1;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use super::{
    password,
    routes::{
        Actor, client_ip, issue_session, rate_limit, resolve_actor, service,
        stored_password, with_cookie,
    },
    session::Session,
    token,
};
use crate::{
    app::{AppState, JsonBody, ok, request_id},
    error::{ApiError, ApiResult},
};

pub const STEP: u64 = 30;
const ISSUER: &str = "HRMS";
const ALPHABET: &[u8; 32] = b"ABCDEFGHJKMNPQRSTUVWXYZ23456789X"; // no 0/O, 1/I/L

// ------------------------------------------------------------- the maths

const B32: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/// RFC 4648 base32 without padding (what authenticator apps expect).
pub fn base32(data: &[u8]) -> String {
    let mut out = String::with_capacity(data.len().div_ceil(5) * 8);
    let (mut buf, mut bits) = (0u32, 0u32);
    for &b in data {
        buf = (buf << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32[((buf >> bits) & 31) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32[((buf << (5 - bits)) & 31) as usize] as char);
    }
    out
}

/// HOTP value for one counter (6 digits).
pub fn hotp(secret: &[u8], counter: u64) -> u32 {
    let mut mac = <Hmac<Sha1> as Mac>::new_from_slice(secret).expect("hmac takes any key");
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[19] & 0x0f) as usize;
    let bin = u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]]);
    bin % 1_000_000
}

/// Digits only, spaces and dashes ignored.
pub fn clean_code(s: &str) -> String {
    s.chars().filter(|c| !c.is_whitespace() && *c != '-').collect()
}

/// The matching time step (previous, current or next 30 s), if any.
pub fn verify_totp(secret: &[u8], code: &str, unix: u64) -> Option<u64> {
    let code = clean_code(code);
    if code.len() != 6 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let now = unix / STEP;
    let mut hit = None;
    for step in [now.saturating_sub(1), now, now + 1] {
        let want = format!("{:06}", hotp(secret, step));
        if bool::from(want.as_bytes().ct_eq(code.as_bytes())) && hit.is_none() {
            hit = Some(step);
        }
    }
    hit
}

pub fn otpauth_uri(secret_b32: &str, account: &str) -> String {
    let enc = |s: &str| -> String {
        s.bytes()
            .map(|b| {
                if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) {
                    (b as char).to_string()
                } else {
                    format!("%{b:02X}")
                }
            })
            .collect()
    };
    format!(
        "otpauth://totp/{}:{}?secret={secret_b32}&issuer={}&algorithm=SHA1&digits=6&period=30",
        enc(ISSUER),
        enc(account),
        enc(ISSUER)
    )
}

pub fn qr_svg(data: &str) -> Option<String> {
    let code = qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::M).ok()?;
    Some(
        code.render::<qrcode::render::svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .build(),
    )
}

// --------------------------------------------------------- sealing

fn key(app_secret: &str) -> Key<Aes256Gcm> {
    let hk = Hkdf::<Sha256>::new(Some(b"hrms.two_step"), app_secret.as_bytes());
    let mut k = [0u8; 32];
    hk.expand(b"totp secret v1", &mut k).expect("32 bytes is a valid length");
    k.into()
}

/// nonce(12) ‖ ciphertext+tag, bound to the account id.
pub fn seal(app_secret: &str, user: Uuid, secret: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; 12];
    OsRng.fill_bytes(&mut nonce);
    let ct = Aes256Gcm::new(&key(app_secret))
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: secret, aad: user.as_bytes() })
        .expect("encryption of a short secret cannot fail");
    [nonce.to_vec(), ct].concat()
}

pub fn open(app_secret: &str, user: Uuid, sealed: &[u8]) -> Option<Vec<u8>> {
    if sealed.len() < 12 + 16 {
        return None;
    }
    let (nonce, ct) = sealed.split_at(12);
    Aes256Gcm::new(&key(app_secret))
        .decrypt(Nonce::from_slice(nonce), Payload { msg: ct, aad: user.as_bytes() })
        .ok()
}

// ---------------------------------------------------- recovery codes

/// Ten codes like "K7QM-2XRP" and their hashes.
pub fn new_recovery_codes() -> (Vec<String>, Vec<Vec<u8>>) {
    let mut codes = Vec::with_capacity(10);
    let mut hashes = Vec::with_capacity(10);
    while codes.len() < 10 {
        let mut raw = [0u8; 8];
        OsRng.fill_bytes(&mut raw);
        let s: String = raw.iter().map(|b| ALPHABET[(b & 31) as usize] as char).collect();
        let code = format!("{}-{}", &s[..4], &s[4..]);
        let h = recovery_hash(&code);
        if !hashes.contains(&h) {
            codes.push(code);
            hashes.push(h);
        }
    }
    (codes, hashes)
}

/// Case, spaces and dashes do not matter.
pub fn recovery_hash(code: &str) -> Vec<u8> {
    let norm: String = clean_code(code).to_ascii_uppercase();
    Sha256::digest(format!("hrms-recovery:{norm}").as_bytes()).to_vec()
}

fn looks_like_recovery(code: &str) -> bool {
    let c = clean_code(code);
    c.len() == 8 && c.bytes().all(|b| b.is_ascii_alphanumeric())
}

// ------------------------------------------------------------- helpers

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn bad_code() -> ApiError {
    let mut e = ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_CODE", "That code is not right. Try the newest code in your app.");
    e.field_errors = json!({ "code": "Incorrect code" });
    e
}

struct Factor {
    secret: Vec<u8>,
    enabled: bool,
}

async fn factor(state: &AppState, rid: Uuid, user: Uuid) -> ApiResult<Option<Factor>> {
    let db = state.db()?;
    let mut tx = service(&db.pool, rid).await?;
    let row: Option<(Vec<u8>, bool, i64)> = sqlx::query_as("select * from iam.totp_get($1)")
        .bind(user)
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(match row {
        None => None,
        Some((sealed, enabled, _)) => Some(Factor {
            secret: open(&state.config.app_secret, user, &sealed).ok_or_else(|| {
                tracing::error!(%user, "two-step secret could not be opened (APP_SECRET changed?)");
                ApiError::internal()
            })?,
            enabled,
        }),
    })
}

/// Checks a TOTP (once per time step) or, when allowed, a recovery code.
async fn check_code(state: &AppState, rid: Uuid, user: Uuid, f: &Factor, code: &str, allow_recovery: bool) -> ApiResult<bool> {
    let db = state.db()?;
    let mut tx = service(&db.pool, rid).await?;
    let ok = if let Some(step) = verify_totp(&f.secret, code, unix_now()) {
        sqlx::query_scalar::<_, bool>("select iam.totp_use_step($1, $2)")
            .bind(user)
            .bind(step as i64)
            .fetch_one(&mut *tx)
            .await?
    } else if allow_recovery && looks_like_recovery(code) {
        let used: bool = sqlx::query_scalar("select iam.totp_use_recovery($1, $2)")
            .bind(user)
            .bind(recovery_hash(code))
            .fetch_one(&mut *tx)
            .await?;
        if used {
            sqlx::query("select public.internal_two_step_event($1, 'recovery_used')")
                .bind(user)
                .execute(&mut *tx)
                .await?;
        }
        used
    } else {
        false
    };
    tx.commit().await?;
    Ok(ok)
}

/// Password check for the signed-in person (rate limited like reauth).
async fn confirm_password(state: &AppState, session: &Session, pw: Option<String>) -> ApiResult<Actor> {
    let pw = pw.unwrap_or_default();
    if pw.is_empty() || pw.chars().count() > 256 {
        return Err(ApiError::validation_field("password", "Required", "Enter your password."));
    }
    let db = state.db()?;
    let mut tx = service(&db.pool, session.request_id).await?;
    let actor = resolve_actor(&mut tx, &session.claims, "business").await?;
    if !rate_limit(&mut tx, &format!("reauth:{}", actor.employee_id), 900, 5).await? {
        tx.commit().await?;
        return Err(ApiError::rate_limited());
    }
    let stored = stored_password(&mut tx, &actor.auth_alias).await?;
    tx.commit().await?;
    let phc = stored.filter(|(id, _)| *id == session.claims.sub).and_then(|(_, p)| p);
    if !password::verify_async(pw, phc).await {
        let mut e = ApiError::new(StatusCode::FORBIDDEN, "REAUTH_REQUIRED", "Password is incorrect.");
        e.field_errors = json!({ "password": "Incorrect" });
        return Err(e);
    }
    Ok(actor)
}

async fn event(state: &AppState, rid: Uuid, user: Uuid, what: &str) -> ApiResult<()> {
    let db = state.db()?;
    let mut tx = service(&db.pool, rid).await?;
    sqlx::query("select public.internal_two_step_event($1, $2)")
        .bind(user)
        .bind(what)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

// ---------------------------------------------------------- sign-in

/// Called by login after the password matched. When two-step is on, returns
/// a challenge token (and no session is created yet).
pub async fn challenge_if_enabled(state: &AppState, rid: Uuid, user: Uuid, result: &Value) -> ApiResult<Option<String>> {
    match factor(state, rid, user).await? {
        Some(f) if f.enabled => {}
        _ => return Ok(None),
    }
    let (tok, hash) = token::new_session_token();
    let db = state.db()?;
    let mut tx = service(&db.pool, rid).await?;
    sqlx::query("select iam.challenge_create($1, $2, $3)")
        .bind(&hash[..])
        .bind(user)
        .bind(result)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Some(tok))
}

#[derive(Deserialize)]
pub struct ChallengeBody {
    challenge: Option<String>,
    code: Option<String>,
}

pub async fn login_two_step(State(state): State<AppState>, headers: HeaderMap, JsonBody(body): JsonBody<ChallengeBody>) -> ApiResult<Response> {
    let rid = request_id(&headers);
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let expired = || {
        tag(ApiError::new(StatusCode::UNAUTHORIZED, "CHALLENGE_EXPIRED", "This sign-in has expired. Enter your password again."))
    };
    let db = state.db()?;
    let ip = token::ip_hash(&state.config.app_secret, client_ip(&headers));
    let mut tx = service(&db.pool, rid).await?;
    let allowed = rate_limit(&mut tx, &format!("two-step-ip:{ip}"), 900, 30).await?;
    tx.commit().await?;
    if !allowed {
        return Err(tag(ApiError::rate_limited()));
    }
    let Some(hash) = body.challenge.as_deref().and_then(token::hash_presented) else {
        return Err(expired());
    };
    let code = body.code.unwrap_or_default();
    if code.chars().count() > 32 {
        return Err(tag(bad_code()));
    }
    let mut tx = service(&db.pool, rid).await?;
    let row: Option<(Uuid, Value, i32)> = sqlx::query_as("select * from iam.challenge_try($1)")
        .bind(&hash[..])
        .fetch_optional(&mut *tx)
        .await?;
    tx.commit().await?;
    let Some((user, result, attempts)) = row else {
        return Err(expired());
    };
    let f = match factor(&state, rid, user).await? {
        Some(f) if f.enabled => f,
        _ => return Err(expired()), // turned off meanwhile: start over
    };
    if !check_code(&state, rid, user, &f, &code, true).await? {
        let mut e = bad_code();
        if attempts >= 5 {
            e = ApiError::new(StatusCode::UNAUTHORIZED, "CHALLENGE_EXPIRED", "Too many wrong codes. Enter your password again.");
        }
        return Err(tag(e));
    }
    let mut tx = service(&db.pool, rid).await?;
    let fresh: bool = sqlx::query_scalar("select iam.challenge_consume($1)")
        .bind(&hash[..])
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    if !fresh {
        return Err(expired());
    }
    let cookie = issue_session(&state, rid, user, &headers).await?;
    let data = json!({
        "must_change_password": result["must_change_password"].as_bool().unwrap_or(false),
        "credential_hold": result["credential_hold"].as_bool().unwrap_or(false),
    });
    Ok(with_cookie(ok(data, rid), cookie))
}

// ------------------------------------------------------- management

#[derive(Deserialize)]
pub struct ManageBody {
    password: Option<String>,
    code: Option<String>,
}

pub async fn setup(State(state): State<AppState>, session: Session, JsonBody(body): JsonBody<ManageBody>) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let actor = confirm_password(&state, &session, body.password).await.map_err(tag)?;
    let user = session.claims.sub;
    let mut raw = [0u8; 20];
    OsRng.fill_bytes(&mut raw);
    let db = state.db().map_err(tag)?;
    let mut tx = service(&db.pool, rid).await?;
    let began: bool = sqlx::query_scalar("select iam.totp_begin($1, $2)")
        .bind(user)
        .bind(seal(&state.config.app_secret, user, &raw))
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    if !began {
        return Err(tag(ApiError::new(StatusCode::CONFLICT, "ALREADY_ON", "Two-step sign-in is already on.")));
    }
    let secret = base32(&raw);
    let uri = otpauth_uri(&secret, &actor.employee_code);
    Ok(ok(json!({ "secret": secret, "uri": uri, "qr_svg": qr_svg(&uri) }), rid).into_response())
}

pub async fn enable(State(state): State<AppState>, session: Session, JsonBody(body): JsonBody<ManageBody>) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let user = session.claims.sub;
    let db = state.db().map_err(tag)?;
    let mut tx = service(&db.pool, rid).await?;
    resolve_actor(&mut tx, &session.claims, "business").await.map_err(tag)?;
    if !rate_limit(&mut tx, &format!("two-step-enable:{user}"), 900, 10).await? {
        tx.commit().await?;
        return Err(tag(ApiError::rate_limited()));
    }
    tx.commit().await?;
    let f = match factor(&state, rid, user).await.map_err(tag)? {
        Some(f) if !f.enabled => f,
        Some(_) => return Err(tag(ApiError::new(StatusCode::CONFLICT, "ALREADY_ON", "Two-step sign-in is already on."))),
        None => return Err(tag(ApiError::new(StatusCode::CONFLICT, "SETUP_REQUIRED", "Start the setup again."))),
    };
    if !check_code(&state, rid, user, &f, &body.code.unwrap_or_default(), false).await.map_err(tag)? {
        return Err(tag(bad_code()));
    }
    let (codes, hashes) = new_recovery_codes();
    let mut tx = service(&db.pool, rid).await?;
    let on: bool = sqlx::query_scalar("select iam.totp_enable($1, $2)")
        .bind(user)
        .bind(&hashes)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    if !on {
        return Err(tag(ApiError::new(StatusCode::CONFLICT, "ALREADY_ON", "Two-step sign-in is already on.")));
    }
    event(&state, rid, user, "enabled").await.map_err(tag)?;
    Ok(ok(json!({ "recovery_codes": codes }), rid).into_response())
}

/// Password plus a current code (or a recovery code).
async fn confirm_both(state: &AppState, session: &Session, body: ManageBody) -> ApiResult<Factor> {
    confirm_password(state, session, body.password).await?;
    let user = session.claims.sub;
    let f = match factor(state, session.request_id, user).await? {
        Some(f) if f.enabled => f,
        _ => return Err(ApiError::new(StatusCode::CONFLICT, "NOT_ON", "Two-step sign-in is not on.")),
    };
    if !check_code(state, session.request_id, user, &f, &body.code.unwrap_or_default(), true).await? {
        return Err(bad_code());
    }
    Ok(f)
}

pub async fn disable(State(state): State<AppState>, session: Session, JsonBody(body): JsonBody<ManageBody>) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    confirm_both(&state, &session, body).await.map_err(tag)?;
    let db = state.db().map_err(tag)?;
    let mut tx = service(&db.pool, rid).await?;
    sqlx::query("select iam.totp_disable($1)").bind(session.claims.sub).execute(&mut *tx).await?;
    tx.commit().await?;
    event(&state, rid, session.claims.sub, "disabled").await.map_err(tag)?;
    Ok(ok(json!({ "enabled": false }), rid).into_response())
}

pub async fn recovery(State(state): State<AppState>, session: Session, JsonBody(body): JsonBody<ManageBody>) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    confirm_both(&state, &session, body).await.map_err(tag)?;
    let (codes, hashes) = new_recovery_codes();
    let db = state.db().map_err(tag)?;
    let mut tx = service(&db.pool, rid).await?;
    sqlx::query("select iam.totp_replace_codes($1, $2)")
        .bind(session.claims.sub)
        .bind(&hashes)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    event(&state, rid, session.claims.sub, "codes_replaced").await.map_err(tag)?;
    Ok(ok(json!({ "recovery_codes": codes }), rid).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    // RFC 6238 Appendix B (SHA-1, 8-digit values; we keep the last 6).
    const RFC_KEY: &[u8] = b"12345678901234567890";

    #[test]
    fn rfc6238_vectors() {
        for (t, want) in [(59u64, 94287082u32), (1111111109, 7081804), (1111111111, 14050471), (1234567890, 89005924), (2000000000, 69279037)] {
            assert_eq!(hotp(RFC_KEY, t / STEP), want % 1_000_000, "t={t}");
        }
    }

    #[test]
    fn rfc4226_vectors() {
        let want = [755224, 287082, 359152, 969429, 338314, 254676, 287922, 162583, 399871, 520489];
        for (i, w) in want.iter().enumerate() {
            assert_eq!(hotp(RFC_KEY, i as u64), *w);
        }
    }

    #[test]
    fn accepts_one_step_of_drift_only() {
        let t = 1_234_567_890;
        let code = |step: u64| format!("{:06}", hotp(RFC_KEY, step));
        let now = t / STEP;
        assert_eq!(verify_totp(RFC_KEY, &code(now), t), Some(now));
        assert_eq!(verify_totp(RFC_KEY, &code(now - 1), t), Some(now - 1));
        assert_eq!(verify_totp(RFC_KEY, &code(now + 1), t), Some(now + 1));
        assert_eq!(verify_totp(RFC_KEY, &code(now - 2), t), None);
        assert_eq!(verify_totp(RFC_KEY, &code(now + 2), t), None);
        // Spaces and dashes are fine; anything else is not.
        let c = code(now);
        assert_eq!(verify_totp(RFC_KEY, &format!("{} {}", &c[..3], &c[3..]), t), Some(now));
        assert_eq!(verify_totp(RFC_KEY, &format!("{}-{}", &c[..3], &c[3..]), t), Some(now));
        for bad in ["", "12345", "1234567", "abcdef", "12345a", "１２３４５６"] {
            assert_eq!(verify_totp(RFC_KEY, bad, t), None, "{bad}");
        }
        // Time zero does not underflow.
        assert!(verify_totp(RFC_KEY, &format!("{:06}", hotp(RFC_KEY, 0)), 5).is_some());
    }

    #[test]
    fn base32_matches_rfc4648() {
        for (raw, want) in [("", ""), ("f", "MY"), ("fo", "MZXQ"), ("foo", "MZXW6"), ("foob", "MZXW6YQ"), ("fooba", "MZXW6YTB"), ("foobar", "MZXW6YTBOI")] {
            assert_eq!(base32(raw.as_bytes()), want);
        }
        assert_eq!(base32(&[0u8; 20]).len(), 32);
    }

    #[test]
    fn sealed_secret_round_trips_and_is_bound_to_the_account() {
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        let s = seal("app-secret", a, b"0123456789abcdefghij");
        assert_eq!(s.len(), 12 + 20 + 16);
        assert_ne!(s, seal("app-secret", a, b"0123456789abcdefghij"), "fresh nonce each time");
        assert_eq!(open("app-secret", a, &s).unwrap(), b"0123456789abcdefghij");
        assert!(open("app-secret", b, &s).is_none(), "other account");
        assert!(open("other-secret", a, &s).is_none(), "other key");
        let mut t = s.clone();
        t[20] ^= 1;
        assert!(open("app-secret", a, &t).is_none(), "tampered");
        assert!(open("app-secret", a, &s[..27]).is_none(), "too short");
    }

    #[test]
    fn recovery_codes_are_unique_readable_and_forgiving() {
        let (codes, hashes) = new_recovery_codes();
        assert_eq!(codes.len(), 10);
        let mut uniq = hashes.clone();
        uniq.sort();
        uniq.dedup();
        assert_eq!(uniq.len(), 10);
        for c in &codes {
            assert_eq!(c.len(), 9);
            assert_eq!(&c[4..5], "-");
            assert!(!c.contains(['0', 'O', '1', 'I', 'L']), "{c}");
            assert!(looks_like_recovery(c));
        }
        let c = &codes[0];
        assert_eq!(recovery_hash(c), recovery_hash(&c.to_lowercase().replace('-', " ")));
        assert_ne!(recovery_hash(c), recovery_hash(&codes[1]));
        assert!(!looks_like_recovery("123456"));
    }

    #[test]
    fn otpauth_uri_and_qr() {
        let uri = otpauth_uri("MZXW6YTBOI", "EMP 001/x");
        assert_eq!(uri, "otpauth://totp/HRMS:EMP%20001%2Fx?secret=MZXW6YTBOI&issuer=HRMS&algorithm=SHA1&digits=6&period=30");
        let svg = qr_svg(&uri).unwrap();
        assert!(svg.starts_with("<?xml") || svg.starts_with("<svg"), "{}", &svg[..40]);
        assert!(svg.contains("<svg") && svg.contains("</svg>"));
        assert!(!svg.contains("<script"));
    }
}
