//! Web Push (RFC 8030) with message encryption (RFC 8291, aes128gcm) and
//! VAPID (RFC 8292). Replaces the HRMS FCM sender; no vendor SDK.
//!
//! The outbox worker claims due jobs (`internal_claim_outbox`), sends one
//! encrypted push per active web subscription and reports outcomes
//! (`internal_complete_outbox`): 404/410 revoke the subscription, 429/5xx and
//! network errors retry with backoff, preferences mark a job `skipped`.
//!
//! Payloads are small and never contain salary or medical values: title,
//! body (already generic in SQL), an in-app path and a tag.
//!
//! Subscriptions are browser-supplied URLs, so the worker only ever POSTs to
//! known push services over HTTPS (no redirects, short timeout) — a stored
//! subscription can never make the server call an internal address.

use std::time::Duration;

use aes_gcm::{Aes128Gcm, KeyInit, aead::Aead};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD as B64};
use hkdf::Hkdf;
use p256::{
    PublicKey, SecretKey,
    ecdsa::{Signature, SigningKey, signature::Signer},
    elliptic_curve::sec1::ToEncodedPoint,
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::Sha256;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{db, error::ApiResult};

/// Hosts of the browser push services we deliver to (suffix match).
pub const PUSH_HOSTS: &[&str] = &[
    "fcm.googleapis.com",
    "android.googleapis.com",
    "updates.push.services.mozilla.com",
    "push.services.mozilla.com",
    "web.push.apple.com",
    "push.apple.com",
    "notify.windows.com",
];

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PushError {
    #[error("bad subscription: {0}")]
    BadSubscription(&'static str),
    #[error("push service not allowed")]
    HostNotAllowed,
    #[error("payload too large")]
    TooLarge,
    #[error("crypto failure")]
    Crypto,
}

/// Server identity for VAPID. The private key is a base64url P-256 scalar.
#[derive(Clone)]
pub struct Vapid {
    key: SigningKey,
    /// Uncompressed public key, base64url (the browser's applicationServerKey).
    pub public_key: String,
    subject: String,
}

impl std::fmt::Debug for Vapid {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Vapid")
            .field("public_key", &self.public_key)
            .field("subject", &self.subject)
            .finish()
    }
}

impl Vapid {
    /// None when push is not configured; Err when configured wrongly.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let Some(private) = get("VAPID_PRIVATE_KEY").filter(|s| !s.trim().is_empty()) else {
            return Ok(None);
        };
        let subject = get("VAPID_SUBJECT").unwrap_or_default();
        if !(subject.starts_with("mailto:") || subject.starts_with("https://")) {
            return Err("VAPID_SUBJECT must be a mailto: or https:// contact".into());
        }
        let raw = B64
            .decode(private.trim().trim_end_matches('='))
            .map_err(|_| "VAPID_PRIVATE_KEY is not base64url".to_string())?;
        let secret = SecretKey::from_slice(&raw)
            .map_err(|_| "VAPID_PRIVATE_KEY is not a P-256 key".to_string())?;
        let vapid = Self::from_secret(secret, subject);
        if let Some(public) = get("VAPID_PUBLIC_KEY").filter(|s| !s.trim().is_empty())
            && public.trim().trim_end_matches('=') != vapid.public_key
        {
            return Err("VAPID_PUBLIC_KEY does not match VAPID_PRIVATE_KEY".into());
        }
        Ok(Some(vapid))
    }

    pub fn from_secret(secret: SecretKey, subject: String) -> Self {
        let public_key = B64.encode(secret.public_key().to_encoded_point(false).as_bytes());
        Self {
            key: SigningKey::from(secret),
            public_key,
            subject,
        }
    }

    /// `Authorization` header value for one endpoint (ES256 JWT, 12 h).
    pub fn authorization(&self, endpoint: &str, now_unix: i64) -> Result<String, PushError> {
        let aud = origin(endpoint).ok_or(PushError::BadSubscription("endpoint"))?;
        let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
        let claims = B64.encode(
            json!({ "aud": aud, "exp": now_unix + 12 * 3600, "sub": self.subject }).to_string(),
        );
        let input = format!("{header}.{claims}");
        let sig: Signature = self.key.sign(input.as_bytes());
        Ok(format!(
            "vapid t={input}.{}, k={}",
            B64.encode(sig.to_bytes()),
            self.public_key
        ))
    }
}

/// `https://host[:port]` of a URL, or None.
pub fn origin(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://")?;
    let host = rest.split(['/', '?', '#']).next()?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    Some(format!("https://{host}"))
}

/// Only HTTPS endpoints on a known push service, default port.
pub fn endpoint_allowed(url: &str) -> bool {
    let Some(o) = origin(url) else { return false };
    let host = &o["https://".len()..];
    if host.contains(':') {
        return false;
    }
    let host = host.to_ascii_lowercase();
    PUSH_HOSTS
        .iter()
        .any(|h| host == *h || host.ends_with(&format!(".{h}")))
}

#[derive(Debug, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub keys: SubKeys,
}
#[derive(Debug, Deserialize)]
pub struct SubKeys {
    pub p256dh: String,
    pub auth: String,
}

fn b64(s: &str) -> Result<Vec<u8>, PushError> {
    B64.decode(s.trim_end_matches('='))
        .map_err(|_| PushError::BadSubscription("keys"))
}

/// RFC 8291 encryption with a caller-chosen sender key and salt (tests use
/// the RFC's fixed values; production passes fresh random ones).
pub fn encrypt_with(
    plaintext: &[u8],
    ua_public: &[u8],
    auth_secret: &[u8],
    as_secret: &SecretKey,
    salt: &[u8; 16],
) -> Result<Vec<u8>, PushError> {
    // One record, so the payload must fit 4096 - 16 (tag) - 1 (delimiter).
    if plaintext.len() > 3993 {
        return Err(PushError::TooLarge);
    }
    if auth_secret.len() != 16 {
        return Err(PushError::BadSubscription("auth"));
    }
    let ua =
        PublicKey::from_sec1_bytes(ua_public).map_err(|_| PushError::BadSubscription("p256dh"))?;
    let ua_bytes = ua.to_encoded_point(false);
    let as_public = as_secret.public_key().to_encoded_point(false);
    let shared = p256::ecdh::diffie_hellman(as_secret.to_nonzero_scalar(), ua.as_affine());

    let mut key_info = b"WebPush: info\0".to_vec();
    key_info.extend_from_slice(ua_bytes.as_bytes());
    key_info.extend_from_slice(as_public.as_bytes());
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes().as_slice())
        .expand(&key_info, &mut ikm)
        .map_err(|_| PushError::Crypto)?;

    let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| PushError::Crypto)?;
    prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| PushError::Crypto)?;

    let mut record = plaintext.to_vec();
    record.push(2); // last-record delimiter, no padding
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| PushError::Crypto)?;
    let sealed = cipher
        .encrypt((&nonce).into(), record.as_slice())
        .map_err(|_| PushError::Crypto)?;

    let mut out = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(65);
    out.extend_from_slice(as_public.as_bytes());
    out.extend_from_slice(&sealed);
    Ok(out)
}

pub fn encrypt(plaintext: &[u8], sub: &Subscription) -> Result<Vec<u8>, PushError> {
    use p256::elliptic_curve::rand_core::{OsRng, RngCore};
    let mut salt = [0u8; 16];
    OsRng.fill_bytes(&mut salt);
    let ephemeral = SecretKey::random(&mut OsRng);
    encrypt_with(
        plaintext,
        &b64(&sub.keys.p256dh)?,
        &b64(&sub.keys.auth)?,
        &ephemeral,
        &salt,
    )
}

/// What one delivery attempt means for the outbox.
#[derive(Debug, Clone, PartialEq)]
pub enum Delivery {
    Sent,
    /// The subscription is gone (404/410) or unusable: revoke it.
    Gone(String),
    Retry(String),
    Failed(String),
}

pub fn classify(status: u16) -> Delivery {
    match status {
        200..=299 => Delivery::Sent,
        404 | 410 => Delivery::Gone(format!("HTTP {status}")),
        408 | 425 | 429 | 500..=599 => Delivery::Retry(format!("HTTP {status}")),
        413 => Delivery::Failed("payload too large".into()),
        // 400/401/403: our request or VAPID key is wrong for this subscription.
        _ => Delivery::Failed(format!("HTTP {status}")),
    }
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("http client")
}

pub async fn send(http: &reqwest::Client, vapid: &Vapid, token: &str, payload: &[u8]) -> Delivery {
    let sub: Subscription = match serde_json::from_str(token) {
        Ok(s) => s,
        Err(_) => return Delivery::Gone("bad subscription".into()),
    };
    if !endpoint_allowed(&sub.endpoint) {
        return Delivery::Gone("push service not allowed".into());
    }
    let body = match encrypt(payload, &sub) {
        Ok(b) => b,
        Err(PushError::BadSubscription(_)) => {
            return Delivery::Gone("bad subscription keys".into());
        }
        Err(e) => return Delivery::Failed(e.to_string()),
    };
    let auth = match vapid.authorization(&sub.endpoint, chrono::Utc::now().timestamp()) {
        Ok(a) => a,
        Err(e) => return Delivery::Gone(e.to_string()),
    };
    match http
        .post(&sub.endpoint)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("TTL", "86400")
        .header("Urgency", "normal")
        .header("Authorization", auth)
        .body(body)
        .send()
        .await
    {
        Ok(r) => classify(r.status().as_u16()),
        Err(e) if e.is_timeout() || e.is_connect() || e.is_request() => {
            Delivery::Retry("network".into())
        }
        Err(_) => Delivery::Retry("network".into()),
    }
}

/// In-app paths only; anything else opens the inbox.
pub fn safe_path(link: Option<&str>) -> String {
    match link {
        Some(p)
            if p.starts_with('/')
                && !p.starts_with("//")
                && !p.contains('\\')
                && p.len() <= 200 =>
        {
            p.to_owned()
        }
        _ => "/notifications".into(),
    }
}

pub fn payload(job: &Value) -> Vec<u8> {
    let s = |k: &str| job.get(k).and_then(Value::as_str);
    let clip =
        |v: Option<&str>, n: usize| v.unwrap_or_default().chars().take(n).collect::<String>();
    json!({
        "title": clip(s("title"), 120),
        "body": clip(s("body"), 300),
        "url": safe_path(s("deep_link")),
        "tag": s("event_id").unwrap_or_default(),
        "kind": clip(s("kind"), 60),
    })
    .to_string()
    .into_bytes()
}

/// Combines per-subscription results into one outbox outcome.
pub fn outcome(results: &[(String, Delivery)]) -> Value {
    let invalid: Vec<&String> = results
        .iter()
        .filter(|(_, d)| matches!(d, Delivery::Gone(_)))
        .map(|(t, _)| t)
        .collect();
    let sent = results.iter().any(|(_, d)| *d == Delivery::Sent);
    let retry = results.iter().find_map(|(_, d)| {
        if let Delivery::Retry(e) = d {
            Some(e.clone())
        } else {
            None
        }
    });
    let failed = results.iter().find_map(|(_, d)| match d {
        Delivery::Failed(e) | Delivery::Gone(e) => Some(e.clone()),
        _ => None,
    });
    let (outcome, error) = if sent {
        ("sent", None)
    } else if let Some(e) = retry {
        ("retry", Some(e))
    } else if results.is_empty() {
        ("skipped", Some("no devices".to_owned()))
    } else {
        ("failed", failed)
    };
    json!({ "outcome": outcome, "error": error, "invalid_tokens": if invalid.is_empty() { Value::Null } else { json!(invalid) } })
}

async fn service(pool: &PgPool, sql: &str, arg: Value) -> ApiResult<Value> {
    let mut tx = db::begin_as(pool, db::Caller::Service, Uuid::new_v4()).await?;
    let v: Option<Value> = sqlx::query_scalar(sql)
        .bind(arg)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(v.unwrap_or(Value::Null))
}

/// One outbox pass. Returns how many jobs were completed.
pub async fn run_outbox(
    pool: &PgPool,
    vapid: Option<&Vapid>,
    http: &reqwest::Client,
) -> ApiResult<usize> {
    let jobs = service(
        pool,
        "select public.internal_claim_outbox(($1::jsonb ->> 'limit')::int, 60)",
        json!({ "limit": 50 }),
    )
    .await?;
    let jobs = jobs.as_array().cloned().unwrap_or_default();
    if jobs.is_empty() {
        return Ok(0);
    }
    let mut results = Vec::with_capacity(jobs.len());
    for job in &jobs {
        let id = job.get("outbox_id").cloned().unwrap_or(Value::Null);
        let web: Vec<String> = job
            .get("tokens")
            .and_then(Value::as_array)
            .map(|t| {
                t.iter()
                    .filter(|x| x.get("platform").and_then(Value::as_str) == Some("web"))
                    .filter_map(|x| x.get("token").and_then(Value::as_str).map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        let mut r = if job.get("suppressed").and_then(Value::as_bool) == Some(true) {
            json!({ "outcome": "skipped", "error": "muted or quiet hours" })
        } else if let Some(v) = vapid {
            let body = payload(job);
            let mut per = Vec::with_capacity(web.len());
            for t in web {
                let d = send(http, v, &t, &body).await;
                per.push((t, d));
            }
            outcome(&per)
        } else {
            json!({ "outcome": "skipped", "error": "push not configured" })
        };
        r["outbox_id"] = id;
        results.push(r);
    }
    let n = results.len();
    service(
        pool,
        "select public.internal_complete_outbox($1)",
        Value::Array(results),
    )
    .await?;
    Ok(n)
}

/// Polls for due pushes every 10 s (cheap `internal_outbox_has_due` first).
pub fn spawn(pool: PgPool, vapid: Option<Vapid>) {
    tokio::spawn(async move {
        let http = client();
        let mut every = tokio::time::interval(Duration::from_secs(10));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            let due = async {
                let mut tx = db::begin_as(&pool, db::Caller::Service, Uuid::new_v4()).await?;
                let due: bool = sqlx::query_scalar("select public.internal_outbox_has_due()")
                    .fetch_one(&mut *tx)
                    .await?;
                tx.commit().await?;
                ApiResult::Ok(due)
            }
            .await;
            match due {
                Ok(true) => {
                    if let Err(e) = run_outbox(&pool, vapid.as_ref(), &http).await {
                        tracing::warn!(code = %e.code, "push outbox pass failed");
                    }
                }
                Ok(false) => {}
                Err(e) => tracing::warn!(code = %e.code, "push outbox check failed"),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use aes_gcm::aead::Aead;

    const D: fn(&str) -> Vec<u8> = |s| B64.decode(s).unwrap();

    /// Receiver side of RFC 8291, used to prove our output decrypts.
    fn decrypt(body: &[u8], ua_secret: &SecretKey, auth: &[u8]) -> Vec<u8> {
        let salt = &body[..16];
        let idlen = body[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&body[21..21 + idlen]).unwrap();
        let ct = &body[21 + idlen..];
        let shared =
            p256::ecdh::diffie_hellman(ua_secret.to_nonzero_scalar(), as_public.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_secret.public_key().to_encoded_point(false).as_bytes());
        info.extend_from_slice(as_public.to_encoded_point(false).as_bytes());
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes().as_slice())
            .expand(&info, &mut ikm)
            .unwrap();
        let prk = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let (mut cek, mut nonce) = ([0u8; 16], [0u8; 12]);
        prk.expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .unwrap();
        prk.expand(b"Content-Encoding: nonce\0", &mut nonce)
            .unwrap();
        let mut pt = Aes128Gcm::new_from_slice(&cek)
            .unwrap()
            .decrypt((&nonce).into(), ct)
            .unwrap();
        assert_eq!(pt.pop(), Some(2));
        pt
    }

    #[test]
    fn rfc8291_appendix_a_vector() {
        let as_secret =
            SecretKey::from_slice(&D("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        assert_eq!(
            B64.encode(as_secret.public_key().to_encoded_point(false).as_bytes()),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
        );
        let ua_public = D(
            "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
        );
        let auth = D("BTBZMqHH6r4Tts7J_aSIgg");
        let salt: [u8; 16] = D("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = encrypt_with(
            b"When I grow up, I want to be a watermelon",
            &ua_public,
            &auth,
            &as_secret,
            &salt,
        )
        .unwrap();
        assert_eq!(
            B64.encode(&body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
        let ua_secret =
            SecretKey::from_slice(&D("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94")).unwrap();
        assert_eq!(
            decrypt(&body, &ua_secret, &auth),
            b"When I grow up, I want to be a watermelon"
        );
    }

    #[test]
    fn random_encryption_round_trips_and_differs_each_time() {
        use p256::elliptic_curve::rand_core::OsRng;
        let ua = SecretKey::random(&mut OsRng);
        let sub = Subscription {
            endpoint: "https://fcm.googleapis.com/fcm/send/x".into(),
            keys: SubKeys {
                p256dh: B64.encode(ua.public_key().to_encoded_point(false).as_bytes()),
                auth: B64.encode([7u8; 16]),
            },
        };
        let a = encrypt(b"{\"title\":\"Hi\"}", &sub).unwrap();
        let b = encrypt(b"{\"title\":\"Hi\"}", &sub).unwrap();
        assert_ne!(a, b);
        assert_eq!(decrypt(&a, &ua, &[7u8; 16]), b"{\"title\":\"Hi\"}");
        assert_eq!(encrypt(&vec![b'x'; 3994], &sub), Err(PushError::TooLarge));
        let bad = Subscription {
            endpoint: sub.endpoint.clone(),
            keys: SubKeys {
                p256dh: "AAAA".into(),
                auth: sub.keys.auth.clone(),
            },
        };
        assert_eq!(
            encrypt(b"x", &bad),
            Err(PushError::BadSubscription("p256dh"))
        );
        let short = Subscription {
            endpoint: sub.endpoint.clone(),
            keys: SubKeys {
                p256dh: sub.keys.p256dh.clone(),
                auth: "AAAA".into(),
            },
        };
        assert_eq!(
            encrypt(b"x", &short),
            Err(PushError::BadSubscription("auth"))
        );
    }

    #[test]
    fn vapid_jwt_is_es256_for_the_endpoint_origin() {
        use p256::ecdsa::{VerifyingKey, signature::Verifier};
        let secret = SecretKey::from_slice(&[9u8; 32]).unwrap();
        let v = Vapid::from_secret(secret.clone(), "mailto:ops@example.com".into());
        let h = v
            .authorization("https://fcm.googleapis.com/fcm/send/abc?x=1", 1_000)
            .unwrap();
        let t = h
            .strip_prefix("vapid t=")
            .unwrap()
            .split(", k=")
            .next()
            .unwrap();
        let k = h.split(", k=").nth(1).unwrap();
        assert_eq!(k, v.public_key);
        let parts: Vec<&str> = t.split('.').collect();
        let claims: Value = serde_json::from_slice(&B64.decode(parts[1]).unwrap()).unwrap();
        assert_eq!(
            claims,
            json!({ "aud": "https://fcm.googleapis.com", "exp": 1_000 + 43_200, "sub": "mailto:ops@example.com" })
        );
        let sig = Signature::from_slice(&B64.decode(parts[2]).unwrap()).unwrap();
        VerifyingKey::from(&SigningKey::from(secret))
            .verify(format!("{}.{}", parts[0], parts[1]).as_bytes(), &sig)
            .unwrap();
    }

    #[test]
    fn vapid_config() {
        let key = B64.encode([9u8; 32]);
        let get = |pairs: Vec<(&'static str, String)>| {
            move |k: &str| pairs.iter().find(|(n, _)| *n == k).map(|(_, v)| v.clone())
        };
        assert!(Vapid::from_lookup(get(vec![])).unwrap().is_none());
        assert!(Vapid::from_lookup(get(vec![("VAPID_PRIVATE_KEY", key.clone())])).is_err()); // no subject
        let ok = Vapid::from_lookup(get(vec![
            ("VAPID_PRIVATE_KEY", key.clone()),
            ("VAPID_SUBJECT", "mailto:a@b.c".into()),
        ]))
        .unwrap()
        .unwrap();
        assert_eq!(ok.public_key.len(), 87);
        assert!(
            Vapid::from_lookup(get(vec![
                ("VAPID_PRIVATE_KEY", "!!".into()),
                ("VAPID_SUBJECT", "mailto:a@b.c".into())
            ]))
            .is_err()
        );
        assert!(
            Vapid::from_lookup(get(vec![
                ("VAPID_PRIVATE_KEY", B64.encode([0u8; 32])),
                ("VAPID_SUBJECT", "mailto:a@b.c".into())
            ]))
            .is_err()
        );
        assert!(
            Vapid::from_lookup(get(vec![
                ("VAPID_PRIVATE_KEY", key.clone()),
                ("VAPID_SUBJECT", "mailto:a@b.c".into()),
                ("VAPID_PUBLIC_KEY", "wrong".into())
            ]))
            .is_err()
        );
        assert!(
            Vapid::from_lookup(get(vec![
                ("VAPID_PRIVATE_KEY", key),
                ("VAPID_SUBJECT", "mailto:a@b.c".into()),
                ("VAPID_PUBLIC_KEY", ok.public_key.clone())
            ]))
            .is_ok()
        );
        assert!(!format!("{ok:?}").contains(&B64.encode([9u8; 32])));
    }

    #[test]
    fn only_known_push_services() {
        for ok in [
            "https://fcm.googleapis.com/fcm/send/x",
            "https://updates.push.services.mozilla.com/wpush/v2/x",
            "https://web.push.apple.com/QG",
            "https://wns2-bl2p.notify.windows.com/w/?token=x",
        ] {
            assert!(endpoint_allowed(ok), "{ok}");
        }
        for bad in [
            "http://fcm.googleapis.com/x",
            "https://evil.com/fcm.googleapis.com",
            "https://fcm.googleapis.com.evil.com/x",
            "https://localhost/x",
            "https://127.0.0.1/x",
            "https://fcm.googleapis.com:8443/x",
            "https://user@fcm.googleapis.com/x",
            "https://notfcm.googleapis.com.evil/x",
            "fcm.googleapis.com/x",
            "",
        ] {
            assert!(!endpoint_allowed(bad), "{bad}");
        }
    }

    #[test]
    fn status_classes() {
        assert_eq!(classify(201), Delivery::Sent);
        assert!(matches!(classify(410), Delivery::Gone(_)));
        assert!(matches!(classify(404), Delivery::Gone(_)));
        assert!(matches!(classify(429), Delivery::Retry(_)));
        assert!(matches!(classify(503), Delivery::Retry(_)));
        assert!(matches!(classify(403), Delivery::Failed(_)));
        assert!(matches!(classify(413), Delivery::Failed(_)));
    }

    #[test]
    fn outcomes_and_payload() {
        let sent = outcome(&[
            ("a".into(), Delivery::Sent),
            ("b".into(), Delivery::Gone("HTTP 410".into())),
        ]);
        assert_eq!(
            sent,
            json!({ "outcome": "sent", "error": null, "invalid_tokens": ["b"] })
        );
        assert_eq!(
            outcome(&[("a".into(), Delivery::Retry("HTTP 503".into()))])["outcome"],
            "retry"
        );
        assert_eq!(
            outcome(&[("a".into(), Delivery::Gone("HTTP 410".into()))])["outcome"],
            "failed"
        );
        assert_eq!(
            outcome(&[]),
            json!({ "outcome": "skipped", "error": "no devices", "invalid_tokens": null })
        );
        let p: Value = serde_json::from_slice(&payload(&json!({ "title": "T", "body": "B", "deep_link": "//evil.com", "event_id": "e", "kind": "payslip.published" }))).unwrap();
        assert_eq!(
            p,
            json!({ "title": "T", "body": "B", "url": "/notifications", "tag": "e", "kind": "payslip.published" })
        );
        assert_eq!(safe_path(Some("/approvals/1")), "/approvals/1");
        assert_eq!(safe_path(Some("https://x")), "/notifications");
        assert_eq!(safe_path(Some("/\\evil")), "/notifications");
        assert_eq!(safe_path(None), "/notifications");
    }
}
