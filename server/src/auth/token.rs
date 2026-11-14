//! Session tokens, cookies and IP hashing.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use axum::http::{HeaderMap, HeaderValue, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

/// A new random session token (sent to the browser) and its SHA-256 (stored).
pub fn new_session_token() -> (String, [u8; 32]) {
    let mut raw = [0u8; 32];
    OsRng.fill_bytes(&mut raw);
    let token = URL_SAFE_NO_PAD.encode(raw);
    let hash = digest(&token);
    (token, hash)
}

fn digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// Hash of a presented token, or None when it is not shaped like one of ours
/// (so junk never reaches the database).
pub fn hash_presented(token: &str) -> Option<[u8; 32]> {
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(digest(token))
}

/// HMAC of the client IP so rate limits work without storing raw IPs.
pub fn ip_hash(secret: &str, ip: &str) -> String {
    let ip = ip.trim();
    let ip = if ip.is_empty() { "unknown" } else { ip };
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("hmac takes any key");
    mac.update(ip.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[derive(Clone, Debug)]
pub struct CookieSpec {
    pub name: &'static str,
    pub secure: bool,
}

impl CookieSpec {
    /// `__Host-` (Secure, Path=/, no Domain) on https; a plain name on
    /// http://localhost because some browsers refuse Secure cookies there.
    pub fn for_origin(app_origin: &str) -> Self {
        if app_origin.starts_with("https://") {
            Self {
                name: "__Host-hrms_session",
                secure: true,
            }
        } else {
            Self {
                name: "hrms_session",
                secure: false,
            }
        }
    }

    pub fn set(&self, token: &str, max_age_secs: i64) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{secure}",
            self.name
        ))
        .expect("token is URL-safe")
    }

    pub fn clear(&self) -> HeaderValue {
        let secure = if self.secure { "; Secure" } else { "" };
        HeaderValue::from_str(&format!(
            "{}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0{secure}",
            self.name
        ))
        .expect("static cookie")
    }

    pub fn read<'a>(&self, headers: &'a HeaderMap) -> Option<&'a str> {
        headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|v| v.to_str().ok())
            .flat_map(|v| v.split(';'))
            .filter_map(|pair| pair.trim().split_once('='))
            .find(|(k, _)| *k == self.name)
            .map(|(_, v)| v.trim())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_random_and_hash_consistently() {
        let (t1, h1) = new_session_token();
        let (t2, _) = new_session_token();
        assert_ne!(t1, t2);
        assert_eq!(t1.len(), 43);
        assert_eq!(hash_presented(&t1), Some(h1));
    }

    #[test]
    fn malformed_tokens_are_rejected_before_the_db() {
        assert_eq!(hash_presented(""), None);
        assert_eq!(hash_presented("short"), None);
        assert_eq!(hash_presented(&"a".repeat(44)), None);
        assert_eq!(hash_presented(&format!("{}'", "a".repeat(42))), None);
        assert_eq!(hash_presented(&format!("{};", "a".repeat(42))), None);
        assert!(hash_presented(&"a".repeat(43)).is_some());
    }

    #[test]
    fn ip_hash_is_keyed_and_stable() {
        let a = ip_hash("secret-one", "1.2.3.4");
        assert_eq!(a, ip_hash("secret-one", " 1.2.3.4 "));
        assert_ne!(a, ip_hash("secret-two", "1.2.3.4"));
        assert_ne!(a, ip_hash("secret-one", "1.2.3.5"));
        assert_eq!(ip_hash("s", ""), ip_hash("s", "unknown"));
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn cookie_flags_follow_origin() {
        let https = CookieSpec::for_origin("https://web-hrms.vercel.app");
        let v = https.set("tok", 60);
        let s = v.to_str().unwrap();
        assert!(s.starts_with(
            "__Host-hrms_session=tok; Path=/; HttpOnly; SameSite=Lax; Max-Age=60; Secure"
        ));
        assert!(!s.contains("Domain"));
        let local = CookieSpec::for_origin("http://localhost:3000");
        assert!(!local.set("tok", 60).to_str().unwrap().contains("Secure"));
        assert!(https.clear().to_str().unwrap().contains("Max-Age=0"));
    }

    #[test]
    fn cookie_reading_handles_multiple_headers_and_pairs() {
        let spec = CookieSpec::for_origin("https://x.vercel.app");
        let mut h = HeaderMap::new();
        h.append(
            header::COOKIE,
            HeaderValue::from_static("a=1; __Host-hrms_session=abc ; b=2"),
        );
        assert_eq!(spec.read(&h), Some("abc"));
        let mut h = HeaderMap::new();
        h.append(header::COOKIE, HeaderValue::from_static("a=1"));
        h.append(
            header::COOKIE,
            HeaderValue::from_static("__Host-hrms_session=xyz"),
        );
        assert_eq!(spec.read(&h), Some("xyz"));
        let mut h = HeaderMap::new();
        h.append(
            header::COOKIE,
            HeaderValue::from_static("hrms_session=plain"),
        );
        assert_eq!(
            spec.read(&h),
            None,
            "the non-prefixed cookie is not accepted on https"
        );
    }
}
