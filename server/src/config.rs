//! Process configuration, read once from the environment at start-up.
//! Missing or weak secrets stop the server instead of running insecurely.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{0} is not set")]
    Missing(&'static str),
    #[error("{0} must be at least {1} characters")]
    TooShort(&'static str, usize),
    #[error("{0} is not valid: {1}")]
    Invalid(&'static str, String),
}

#[derive(Clone)]
pub struct Config {
    pub addr: SocketAddr,
    /// Public web origin, e.g. `https://web-hrms.vercel.app`. Used for Origin checks.
    pub app_origin: String,
    /// Shared with the Vercel proxy. Every `/v1` request must carry it.
    pub proxy_secret: String,
}

impl std::fmt::Debug for Config {
    // Never print secrets, even in debug logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("addr", &self.addr)
            .field("app_origin", &self.app_origin)
            .field("proxy_secret", &"<redacted>")
            .finish()
    }
}

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, ConfigError> {
        // Render injects PORT; default 8080 for local runs.
        let port = match get("PORT") {
            Some(p) => p
                .parse::<u16>()
                .map_err(|e| ConfigError::Invalid("PORT", e.to_string()))?,
            None => 8080,
        };

        let app_origin = get("APP_ORIGIN").ok_or(ConfigError::Missing("APP_ORIGIN"))?;
        let app_origin = app_origin.trim_end_matches('/').to_owned();
        if !(app_origin.starts_with("https://") || app_origin.starts_with("http://localhost")) {
            return Err(ConfigError::Invalid(
                "APP_ORIGIN",
                "must be https:// (or http://localhost for development)".into(),
            ));
        }

        let proxy_secret = get("PROXY_SECRET").ok_or(ConfigError::Missing("PROXY_SECRET"))?;
        if proxy_secret.len() < 32 {
            return Err(ConfigError::TooShort("PROXY_SECRET", 32));
        }

        Ok(Self {
            addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
            app_origin,
            proxy_secret,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn lookup(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    const SECRET: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn valid_config_loads_with_default_port() {
        let c = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "https://web-hrms.vercel.app/"),
            ("PROXY_SECRET", SECRET),
        ]))
        .unwrap();
        assert_eq!(c.addr.port(), 8080);
        assert_eq!(c.app_origin, "https://web-hrms.vercel.app");
    }

    #[test]
    fn short_secret_is_rejected() {
        let e = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "https://x.vercel.app"),
            ("PROXY_SECRET", "short"),
        ]))
        .unwrap_err();
        assert!(matches!(e, ConfigError::TooShort("PROXY_SECRET", 32)));
    }

    #[test]
    fn plain_http_origin_is_rejected() {
        let e = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "http://example.com"),
            ("PROXY_SECRET", SECRET),
        ]))
        .unwrap_err();
        assert!(matches!(e, ConfigError::Invalid("APP_ORIGIN", _)));
    }

    #[test]
    fn debug_output_redacts_secret() {
        let c = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "https://x.vercel.app"),
            ("PROXY_SECRET", SECRET),
        ]))
        .unwrap();
        assert!(!format!("{c:?}").contains(SECRET));
    }
}
