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
    /// Keys IP hashes for rate limits (>= 32 chars). Never sent anywhere.
    pub app_secret: String,
    /// Postgres URL. None only in tests that never touch the database.
    pub database_url: Option<String>,
    pub database_max_connections: u32,
    /// Domain of the internal login aliases (never a real mailbox).
    pub alias_domain: String,
    /// eSSL/ZKTeco push: shared ingest secret (>= 32 chars). None = /iclock is off.
    pub device_ingest_secret: Option<String>,
    /// Shared with the Cloudflare relay; only then is `x-device-ip` believed.
    pub device_relay_secret: Option<String>,
}

impl std::fmt::Debug for Config {
    // Never print secrets, even in debug logs.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("addr", &self.addr)
            .field("app_origin", &self.app_origin)
            .field("proxy_secret", &"<redacted>")
            .field("app_secret", &"<redacted>")
            .field(
                "database_url",
                &self.database_url.as_ref().map(|_| "<redacted>"),
            )
            .field("database_max_connections", &self.database_max_connections)
            .field("alias_domain", &self.alias_domain)
            .field(
                "device_ingest_secret",
                &self.device_ingest_secret.as_ref().map(|_| "<redacted>"),
            )
            .field(
                "device_relay_secret",
                &self.device_relay_secret.as_ref().map(|_| "<redacted>"),
            )
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

        let app_secret = get("APP_SECRET").ok_or(ConfigError::Missing("APP_SECRET"))?;
        if app_secret.len() < 32 {
            return Err(ConfigError::TooShort("APP_SECRET", 32));
        }
        if app_secret == proxy_secret {
            return Err(ConfigError::Invalid(
                "APP_SECRET",
                "must differ from PROXY_SECRET".into(),
            ));
        }

        let database_url = get("DATABASE_URL").filter(|u| !u.trim().is_empty());
        if let Some(u) = &database_url
            && !(u.starts_with("postgres://") || u.starts_with("postgresql://"))
        {
            return Err(ConfigError::Invalid(
                "DATABASE_URL",
                "must start with postgres://".into(),
            ));
        }
        let database_max_connections = match get("DATABASE_MAX_CONNECTIONS") {
            Some(v) if !v.is_empty() => v
                .parse::<u32>()
                .ok()
                .filter(|n| (1..=50).contains(n))
                .ok_or_else(|| {
                    ConfigError::Invalid("DATABASE_MAX_CONNECTIONS", "use 1 to 50".into())
                })?,
            _ => 5,
        };
        let alias_domain = get("ALIAS_DOMAIN")
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "staff.hrms.invalid".into())
            .to_lowercase();
        if !alias_domain
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
            || !alias_domain.contains('.')
        {
            return Err(ConfigError::Invalid("ALIAS_DOMAIN", "not a domain".into()));
        }

        let optional_secret = |key: &'static str| -> Result<Option<String>, ConfigError> {
            match get(key).filter(|v| !v.trim().is_empty()) {
                Some(v) if v.len() < 32 => Err(ConfigError::TooShort(key, 32)),
                Some(v) if v == proxy_secret || v == app_secret => Err(ConfigError::Invalid(
                    key,
                    "must differ from the other secrets".into(),
                )),
                other => Ok(other),
            }
        };
        let device_ingest_secret = optional_secret("DEVICE_INGEST_SECRET")?;
        let device_relay_secret = optional_secret("DEVICE_RELAY_SECRET")?;
        if device_relay_secret.is_some() && device_relay_secret == device_ingest_secret {
            return Err(ConfigError::Invalid(
                "DEVICE_RELAY_SECRET",
                "must differ from DEVICE_INGEST_SECRET".into(),
            ));
        }

        Ok(Self {
            addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port),
            app_origin,
            proxy_secret,
            app_secret,
            database_url,
            database_max_connections,
            alias_domain,
            device_ingest_secret,
            device_relay_secret,
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
    const APP: &str = "fedcba9876543210fedcba9876543210";

    fn base() -> Vec<(&'static str, &'static str)> {
        vec![
            ("APP_ORIGIN", "https://x.vercel.app"),
            ("PROXY_SECRET", SECRET),
            ("APP_SECRET", APP),
        ]
    }

    fn with(extra: &[(&'static str, &'static str)]) -> Result<Config, ConfigError> {
        let mut v = base();
        for (k, val) in extra {
            v.retain(|(kk, _)| kk != k);
            v.push((k, val));
        }
        Config::from_lookup(lookup(&v))
    }

    #[test]
    fn device_secrets_are_optional_but_strong_and_distinct() {
        let c = with(&[]).unwrap();
        assert!(c.device_ingest_secret.is_none() && c.device_relay_secret.is_none());
        let ingest = "ingest-secret-0123456789abcdef01234";
        let relay = "relay-secret-0123456789abcdef012345";
        let c = with(&[
            ("DEVICE_INGEST_SECRET", ingest),
            ("DEVICE_RELAY_SECRET", relay),
        ])
        .unwrap();
        assert_eq!(c.device_ingest_secret.as_deref(), Some(ingest));
        assert!(!format!("{c:?}").contains(ingest) && !format!("{c:?}").contains(relay));
        assert!(matches!(
            with(&[("DEVICE_INGEST_SECRET", "short")]),
            Err(ConfigError::TooShort(..))
        ));
        assert!(
            with(&[("DEVICE_INGEST_SECRET", "   ")])
                .unwrap()
                .device_ingest_secret
                .is_none()
        );
        assert!(matches!(
            with(&[("DEVICE_INGEST_SECRET", SECRET)]),
            Err(ConfigError::Invalid(..))
        ));
        assert!(matches!(
            with(&[("DEVICE_RELAY_SECRET", APP)]),
            Err(ConfigError::Invalid(..))
        ));
        assert!(matches!(
            with(&[
                ("DEVICE_INGEST_SECRET", ingest),
                ("DEVICE_RELAY_SECRET", ingest)
            ]),
            Err(ConfigError::Invalid(..))
        ));
    }

    #[test]
    fn app_secret_rules() {
        let mut v = base();
        v.retain(|(k, _)| *k != "APP_SECRET");
        assert!(matches!(
            Config::from_lookup(lookup(&v)).unwrap_err(),
            ConfigError::Missing("APP_SECRET")
        ));
        assert!(matches!(
            with(&[("APP_SECRET", "short")]).unwrap_err(),
            ConfigError::TooShort("APP_SECRET", 32)
        ));
        assert!(matches!(
            with(&[("APP_SECRET", SECRET)]).unwrap_err(),
            ConfigError::Invalid("APP_SECRET", _)
        ));
    }

    #[test]
    fn database_settings() {
        let c = with(&[]).unwrap();
        assert_eq!(c.database_url, None);
        assert_eq!(c.database_max_connections, 5);
        assert_eq!(c.alias_domain, "staff.hrms.invalid");
        assert!(with(&[("DATABASE_URL", "mysql://x")]).is_err());
        assert!(with(&[("DATABASE_URL", "postgres://u:p@h/db")]).is_ok());
        assert_eq!(with(&[("DATABASE_URL", "  ")]).unwrap().database_url, None);
        assert!(with(&[("DATABASE_MAX_CONNECTIONS", "0")]).is_err());
        assert!(with(&[("DATABASE_MAX_CONNECTIONS", "51")]).is_err());
        assert!(with(&[("DATABASE_MAX_CONNECTIONS", "abc")]).is_err());
        assert_eq!(
            with(&[("DATABASE_MAX_CONNECTIONS", "3")])
                .unwrap()
                .database_max_connections,
            3
        );
        assert!(with(&[("ALIAS_DOMAIN", "bad domain")]).is_err());
        assert!(with(&[("ALIAS_DOMAIN", "nodot")]).is_err());
        assert_eq!(
            with(&[("ALIAS_DOMAIN", "Staff.Example.INVALID")])
                .unwrap()
                .alias_domain,
            "staff.example.invalid"
        );
        assert!(with(&[("PORT", "99999")]).is_err());
    }

    #[test]
    fn debug_redacts_database_url() {
        let c = with(&[("DATABASE_URL", "postgres://u:hunter2@h/db")]).unwrap();
        let d = format!("{c:?}");
        assert!(!d.contains("hunter2") && !d.contains(APP));
    }

    #[test]
    fn valid_config_loads_with_default_port() {
        let c = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "https://web-hrms.vercel.app/"),
            ("PROXY_SECRET", SECRET),
            ("APP_SECRET", APP),
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
            ("APP_SECRET", APP),
        ]))
        .unwrap_err();
        assert!(matches!(e, ConfigError::TooShort("PROXY_SECRET", 32)));
    }

    #[test]
    fn plain_http_origin_is_rejected() {
        let e = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "http://example.com"),
            ("PROXY_SECRET", SECRET),
            ("APP_SECRET", APP),
        ]))
        .unwrap_err();
        assert!(matches!(e, ConfigError::Invalid("APP_ORIGIN", _)));
    }

    #[test]
    fn debug_output_redacts_secret() {
        let c = Config::from_lookup(lookup(&[
            ("APP_ORIGIN", "https://x.vercel.app"),
            ("PROXY_SECRET", SECRET),
            ("APP_SECRET", APP),
        ]))
        .unwrap();
        assert!(!format!("{c:?}").contains(SECRET));
    }
}
