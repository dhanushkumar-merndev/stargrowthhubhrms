//! Firebase Cloud Messaging (HTTP v1) for the native Android and iOS apps.
//!
//! Browsers keep using standard Web Push (`push.rs`). A native app registers
//! its FCM registration token with `register_push_token(.., 'android' | 'ios')`
//! and the outbox worker sends those through FCM, which also forwards iOS
//! messages to APNs. The payload rules are the same as for Web Push: a
//! lock-screen-safe title and body, an in-app path and a tag. Never salary or
//! medical values.
//!
//! Auth: the Firebase service account signs a one-hour RS256 assertion, which
//! Google's token endpoint exchanges for an OAuth access token. The token is
//! cached until five minutes before it expires. Only Google's fixed URLs are
//! called; the `token_uri` inside the key file is ignored.
//!
//! Config (read at start-up, both optional):
//! - `FCM_SERVICE_ACCOUNT_JSON`: the downloaded key file, as base64 or raw JSON.
//! - `FCM_PROJECT_ID`: defaults to the key file's `project_id`; must match it.

use std::sync::{Arc, Mutex};

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD as B64},
};
use ring::{
    rand::SystemRandom,
    signature::{RSA_PKCS1_SHA256, RsaKeyPair},
};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::push::{Delivery, payload_value};

pub const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const SCOPE: &str = "https://www.googleapis.com/auth/firebase.messaging";
/// Re-fetch the access token this many seconds before it expires.
const TOKEN_MARGIN_SECS: i64 = 300;

#[derive(Deserialize)]
struct ServiceAccount {
    #[serde(rename = "type")]
    kind: Option<String>,
    project_id: Option<String>,
    client_email: String,
    private_key: String,
}

#[derive(Clone)]
pub struct Fcm {
    pub project_id: String,
    client_email: String,
    key: Arc<RsaKeyPair>,
    /// Cached OAuth access token and its expiry (unix seconds).
    token: Arc<Mutex<Option<(String, i64)>>>,
}

impl std::fmt::Debug for Fcm {
    // Never print the key or the access token.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Fcm")
            .field("project_id", &self.project_id)
            .field("client_email", &self.client_email)
            .finish()
    }
}

/// DER bytes of a `-----BEGIN PRIVATE KEY-----` (PKCS#8) PEM block.
fn pem_der(pem: &str) -> Result<Vec<u8>, String> {
    let body = pem
        .split("-----BEGIN PRIVATE KEY-----")
        .nth(1)
        .and_then(|rest| rest.split("-----END PRIVATE KEY-----").next())
        .ok_or_else(|| "the key file's private_key is not a PEM private key".to_string())?;
    let compact: String = body.replace("\\n", "").split_whitespace().collect();
    STANDARD
        .decode(compact)
        .map_err(|_| "the key file's private_key is not valid base64".to_string())
}

/// Firebase project IDs: lowercase letters, digits and dashes.
fn valid_project_id(id: &str) -> bool {
    (1..=64).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

impl Fcm {
    /// None when FCM is not configured; Err when configured wrongly.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Self>, String> {
        let env_project = get("FCM_PROJECT_ID")
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let raw = get("FCM_SERVICE_ACCOUNT_JSON").unwrap_or_default();
        let raw = raw.trim();
        if raw.is_empty() {
            if env_project.is_some() {
                return Err("FCM_PROJECT_ID is set but FCM_SERVICE_ACCOUNT_JSON is not".into());
            }
            return Ok(None);
        }
        let bytes = if raw.starts_with('{') {
            raw.as_bytes().to_vec()
        } else {
            let compact: String = raw.split_whitespace().collect();
            STANDARD
                .decode(compact)
                .map_err(|_| "FCM_SERVICE_ACCOUNT_JSON is neither JSON nor base64".to_string())?
        };
        let sa: ServiceAccount = serde_json::from_slice(&bytes)
            .map_err(|_| "FCM_SERVICE_ACCOUNT_JSON is not a service account key".to_string())?;
        if sa.kind.as_deref().is_some_and(|k| k != "service_account") {
            return Err("FCM_SERVICE_ACCOUNT_JSON must be a service_account key".into());
        }
        let project_id = match (env_project, sa.project_id) {
            (Some(env), Some(file)) if env != file => {
                return Err(format!(
                    "FCM_PROJECT_ID ({env}) does not match the key file's project ({file})"
                ));
            }
            (Some(p), _) | (None, Some(p)) => p,
            (None, None) => return Err("set FCM_PROJECT_ID".into()),
        };
        if !valid_project_id(&project_id) {
            return Err("FCM_PROJECT_ID is not a Firebase project ID".into());
        }
        if !sa.client_email.contains('@') {
            return Err("the key file's client_email is missing".into());
        }
        let key = RsaKeyPair::from_pkcs8(&pem_der(&sa.private_key)?)
            .map_err(|_| "the key file's private_key is not an RSA PKCS#8 key".to_string())?;
        Ok(Some(Self {
            project_id,
            client_email: sa.client_email,
            key: Arc::new(key),
            token: Arc::new(Mutex::new(None)),
        }))
    }

    /// RS256 JWT that Google exchanges for an access token (valid one hour).
    pub fn assertion(&self, now_unix: i64) -> Result<String, String> {
        let header = B64.encode(br#"{"alg":"RS256","typ":"JWT"}"#);
        let claims = B64.encode(
            json!({
                "iss": self.client_email,
                "scope": SCOPE,
                "aud": TOKEN_URL,
                "iat": now_unix,
                "exp": now_unix + 3600,
            })
            .to_string(),
        );
        let input = format!("{header}.{claims}");
        let mut sig = vec![0u8; self.key.public().modulus_len()];
        let rng = SystemRandom::new();
        self.key
            .sign(&RSA_PKCS1_SHA256, &rng, input.as_bytes(), &mut sig)
            .map_err(|_| "signing failed".to_string())?;
        Ok(format!("{input}.{}", B64.encode(sig)))
    }

    fn cached_token(&self, now_unix: i64) -> Option<String> {
        let guard = self.token.lock().ok()?;
        match guard.as_ref() {
            Some((t, exp)) if *exp - TOKEN_MARGIN_SECS > now_unix => Some(t.clone()),
            _ => None,
        }
    }

    fn forget_token(&self) {
        if let Ok(mut g) = self.token.lock() {
            *g = None;
        }
    }

    /// A valid OAuth access token. Sign-in problems are retried: they affect
    /// every message, so once the key is fixed the queued pushes still go out.
    async fn access_token(&self, http: &reqwest::Client) -> Result<String, Delivery> {
        let now = chrono::Utc::now().timestamp();
        if let Some(t) = self.cached_token(now) {
            return Ok(t);
        }
        let jwt = self.assertion(now).map_err(Delivery::Failed)?;
        // A JWT is base64url plus dots, so it needs no URL encoding.
        let form = format!(
            "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion={jwt}"
        );
        let res = http
            .post(TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .body(form)
            .send()
            .await
            .map_err(|_| Delivery::Retry("network".into()))?;
        let status = res.status().as_u16();
        let body = res
            .bytes()
            .await
            .map_err(|_| Delivery::Retry("network".into()))?;
        if !(200..300).contains(&status) {
            tracing::warn!(status, "FCM sign-in failed; check FCM_SERVICE_ACCOUNT_JSON");
            return Err(Delivery::Retry(format!("FCM sign-in HTTP {status}")));
        }
        #[derive(Deserialize)]
        struct Token {
            access_token: String,
            expires_in: Option<i64>,
        }
        let t: Token = serde_json::from_slice(&body)
            .map_err(|_| Delivery::Retry("FCM sign-in: unexpected response".into()))?;
        let expires = now + t.expires_in.unwrap_or(3600);
        if let Ok(mut g) = self.token.lock() {
            *g = Some((t.access_token.clone(), expires));
        }
        Ok(t.access_token)
    }

    /// Sends one outbox job to one native device.
    pub async fn send(&self, http: &reqwest::Client, token: &str, job: &Value) -> Delivery {
        if !valid_token(token) {
            return Delivery::Gone("bad FCM token".into());
        }
        let access = match self.access_token(http).await {
            Ok(a) => a,
            Err(d) => return d,
        };
        let url = format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            self.project_id
        );
        match http
            .post(url)
            .bearer_auth(access)
            .header("Content-Type", "application/json; charset=UTF-8")
            .body(message(token, job).to_string())
            .send()
            .await
        {
            Ok(r) => {
                let status = r.status().as_u16();
                let body = r.bytes().await.unwrap_or_default();
                if status == 401 {
                    self.forget_token();
                }
                classify(status, &body)
            }
            Err(_) => Delivery::Retry("network".into()),
        }
    }
}

/// FCM registration tokens are long and URL-safe; anything else is not one.
pub fn valid_token(token: &str) -> bool {
    (20..=4096).contains(&token.len())
        && token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b':'))
}

/// Same mapping as `hrms.notification_category` in SQL. Also the Android
/// notification channel id, so people can silence one kind in phone settings.
pub fn category(kind: &str) -> &'static str {
    match kind.split('.').next().unwrap_or_default() {
        "request" => "requests",
        "attendance" => "attendance",
        "leave" => "leave",
        "payslip" | "salary" => "pay",
        "announcement" => "announcements",
        _ => "account",
    }
}

/// FCM v1 message for one device. `data` values must all be strings.
pub fn message(token: &str, job: &Value) -> Value {
    let p = payload_value(job);
    let s = |k: &str| p[k].as_str().unwrap_or_default().to_owned();
    let (kind, tag) = (s("kind"), s("tag"));
    let cat = category(&kind);
    let mut data = json!({ "url": s("url"), "kind": kind, "tag": tag, "category": cat });
    if let Some(id) = job.get("notification_id").and_then(Value::as_str) {
        data["notification_id"] = json!(id);
    }
    let mut android = json!({ "channel_id": cat });
    let mut apns_headers = json!({ "apns-priority": "10", "apns-push-type": "alert" });
    if !tag.is_empty() {
        android["tag"] = json!(tag);
        if tag.len() <= 64 {
            apns_headers["apns-collapse-id"] = json!(tag);
        }
    }
    json!({
        "message": {
            "token": token,
            "notification": { "title": s("title"), "body": s("body") },
            "data": data,
            "android": { "priority": "high", "ttl": "86400s", "notification": android },
            "apns": {
                "headers": apns_headers,
                "payload": { "aps": { "sound": "default", "thread-id": cat } },
            },
        }
    })
}

/// What an FCM v1 response means for the outbox.
pub fn classify(status: u16, body: &[u8]) -> Delivery {
    let v: Value = serde_json::from_slice(body).unwrap_or_default();
    let code = v["error"]["details"]
        .as_array()
        .and_then(|d| d.iter().find_map(|x| x["errorCode"].as_str()))
        .unwrap_or_default();
    let msg = v["error"]["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let label = |c: &str| format!("FCM HTTP {status} {c}").trim_end().to_owned();
    match (status, code) {
        (200..=299, _) => Delivery::Sent,
        // App uninstalled, token expired, or a token from another Firebase project.
        (404, _) | (_, "UNREGISTERED") => Delivery::Gone(label("UNREGISTERED")),
        (_, "SENDER_ID_MISMATCH") => Delivery::Gone(label(code)),
        (400, _) if msg.contains("registration token") => Delivery::Gone(label("INVALID_TOKEN")),
        (401 | 408 | 429 | 500..=599, _) => Delivery::Retry(label(code)),
        _ => Delivery::Failed(label(code)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{KeyPair, RSA_PKCS1_2048_8192_SHA256, UnparsedPublicKey};
    use std::collections::HashMap;

    const KEY: &str = include_str!("../tests/fixtures/fcm_test_rsa_key.txt");
    const EMAIL: &str = "firebase-adminsdk-test@hrms-test.iam.gserviceaccount.com";
    const SA: &str = "FCM_SERVICE_ACCOUNT_JSON";
    const PID: &str = "FCM_PROJECT_ID";

    fn key_file_of(kind: &str, project: &str) -> String {
        let pem = &KEY[KEY.find("-----BEGIN").unwrap()..];
        json!({
            "type": kind,
            "project_id": project,
            "private_key_id": "x",
            "private_key": pem,
            "client_email": EMAIL,
            "token_uri": "https://evil.example/token",
        })
        .to_string()
    }

    fn key_file(project: &str) -> String {
        key_file_of("service_account", project)
    }

    fn load(pairs: &[(&str, String)]) -> Result<Option<Fcm>, String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.clone()))
            .collect();
        Fcm::from_lookup(move |k| map.get(k).cloned())
    }

    fn fcm(file: String) -> Fcm {
        let f = load(&[(SA, file)]);
        f.unwrap().expect("configured")
    }

    fn rejected(pairs: &[(&str, String)]) -> String {
        load(pairs).expect_err("rejected")
    }

    #[test]
    fn config() {
        let none = |pairs: &[(&str, String)]| load(pairs).unwrap().is_none();
        assert!(none(&[]));
        assert!(none(&[(SA, "  ".into())]));
        rejected(&[(PID, "hrms-test".into())]);

        // raw JSON and base64 both load; the project comes from the file
        assert_eq!(fcm(key_file("hrms-test")).project_id, "hrms-test");
        let b64 = STANDARD.encode(key_file("hrms-test"));
        let both = load(&[(SA, b64.clone()), (PID, "hrms-test".into())]);
        assert_eq!(both.unwrap().unwrap().project_id, "hrms-test");

        // the debug output never shows the key
        let d = format!("{:?}", fcm(key_file("hrms-test")));
        assert!(d.contains("hrms-test") && !d.contains("PRIVATE"));

        let e = rejected(&[(SA, b64), (PID, "other-project".into())]);
        assert!(e.contains("does not match"), "{e}");
        rejected(&[(SA, "not a key".into())]);
        rejected(&[(SA, key_file("Bad_Project"))]);
        rejected(&[(SA, key_file_of("authorized_user", "hrms-test"))]);
        let bad = json!({ "type": "service_account", "project_id": "p", "client_email": EMAIL,
            "private_key": "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n" });
        rejected(&[(SA, bad.to_string())]);
    }

    #[test]
    fn assertion_is_a_signed_rs256_jwt_for_google() {
        fn decode(s: &str) -> Value {
            serde_json::from_slice(&B64.decode(s).unwrap()).unwrap()
        }
        let f = fcm(key_file("hrms-test"));
        let jwt = f.assertion(1_800_000_000).unwrap();
        let parts: Vec<&str> = jwt.split('.').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(decode(parts[0])["alg"], "RS256");
        let claims = json!({ "iss": EMAIL, "scope": SCOPE, "aud": TOKEN_URL,
            "iat": 1_800_000_000, "exp": 1_800_003_600 });
        assert_eq!(decode(parts[1]), claims);
        let sig = B64.decode(parts[2]).unwrap();
        let signed = format!("{}.{}", parts[0], parts[1]);
        let public = UnparsedPublicKey::new(&RSA_PKCS1_2048_8192_SHA256, f.key.public_key());
        assert!(public.verify(signed.as_bytes(), &sig).is_ok());
    }

    #[test]
    fn token_cache_respects_the_margin() {
        let f = fcm(key_file("hrms-test"));
        assert_eq!(f.cached_token(1000), None);
        *f.token.lock().unwrap() = Some(("tok".into(), 4600));
        assert_eq!(f.cached_token(1000).as_deref(), Some("tok"));
        assert_eq!(f.cached_token(4301), None);
        f.forget_token();
        assert_eq!(f.cached_token(1000), None);
    }

    #[test]
    fn categories_match_sql() {
        for (kind, cat) in [
            ("request.submitted", "requests"),
            ("attendance.late_warning", "attendance"),
            ("leave.holiday_reconciled", "leave"),
            ("payslip.published", "pay"),
            ("salary.updated", "pay"),
            ("announcement.new", "announcements"),
            ("task.assigned", "account"),
            ("access.role_changed", "account"),
            ("", "account"),
        ] {
            assert_eq!(category(kind), cat, "{kind}");
        }
    }

    #[test]
    fn message_shape() {
        let tag = "8f1c1d1e-0000-4000-8000-000000000001";
        let job = json!({ "title": "Leave approved", "body": "Your leave for 20 Nov was approved.",
            "deep_link": "//evil.com", "event_id": tag, "kind": "leave.approved",
            "notification_id": "n-1", "outbox_id": 7 });
        let m = message("tok_ABC:123-xyz_0123456789", &job);
        let want = json!({ "message": {
            "token": "tok_ABC:123-xyz_0123456789",
            "notification": {
                "title": "Leave approved",
                "body": "Your leave for 20 Nov was approved.",
            },
            "data": { "url": "/notifications", "kind": "leave.approved", "tag": tag,
                      "category": "leave", "notification_id": "n-1" },
            "android": { "priority": "high", "ttl": "86400s",
                         "notification": { "channel_id": "leave", "tag": tag } },
            "apns": {
                "headers": {
                    "apns-priority": "10",
                    "apns-push-type": "alert",
                    "apns-collapse-id": tag,
                },
                "payload": { "aps": { "sound": "default", "thread-id": "leave" } },
            },
        }});
        assert_eq!(m, want);
        // FCM rejects non-string data values
        let data = m["message"]["data"].as_object().unwrap();
        assert!(data.values().all(Value::is_string));
    }

    #[test]
    fn tokens() {
        assert!(valid_token("dGVzdC10b2tlbg:APA91bH-abc_DEF0123456789"));
        assert!(!valid_token("short"));
        assert!(!valid_token(r#"{"endpoint":"https://fcm.googleapis.com/x"}"#));
        assert!(!valid_token("has spaces in the token value"));
    }

    fn err(code: &str, msg: &str) -> Vec<u8> {
        let detail = json!({ "errorCode": code });
        json!({ "error": { "message": msg, "details": [detail] } })
            .to_string()
            .into_bytes()
    }

    #[test]
    fn status_classes() {
        let gone = |status, body: &[u8]| matches!(classify(status, body), Delivery::Gone(_));
        let retry = |status, body: &[u8]| matches!(classify(status, body), Delivery::Retry(_));
        let failed = |status, body: &[u8]| matches!(classify(status, body), Delivery::Failed(_));
        assert_eq!(classify(200, b"{}"), Delivery::Sent);
        assert!(gone(404, &err("UNREGISTERED", "")));
        assert!(gone(404, b""));
        assert!(gone(403, &err("SENDER_ID_MISMATCH", "")));
        let bad_token = "The registration token is not a valid FCM registration token";
        assert!(gone(400, &err("INVALID_ARGUMENT", bad_token)));
        let bad_data = err("INVALID_ARGUMENT", "Invalid value at 'message.data'");
        assert!(failed(400, &bad_data));
        assert!(retry(401, b""));
        assert!(retry(429, &err("QUOTA_EXCEEDED", "")));
        assert!(retry(503, &err("UNAVAILABLE", "")));
        assert!(failed(403, &err("THIRD_PARTY_AUTH_ERROR", "")));
        let quota = classify(429, &err("QUOTA_EXCEEDED", ""));
        assert_eq!(quota, Delivery::Retry("FCM HTTP 429 QUOTA_EXCEEDED".into()));
    }
}
