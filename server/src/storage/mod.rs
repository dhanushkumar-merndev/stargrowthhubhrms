//! Private object storage for documents, payslips, avatars and machine punch
//! photos. Production uses Cloudflare R2 (S3 API, signed requests from the
//! server only: browsers never get storage credentials or bucket URLs).
//! Development and tests use a local folder with the same rules.
//!
//! Every logical bucket (`employee-files`, `device-photos`, ...) is a prefix
//! inside one R2 bucket. Objects are written once (`If-None-Match: *`).

pub mod sigv4;

use std::{path::PathBuf, time::Duration};

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("invalid object key")]
    BadKey,
    #[error("storage unavailable: {0}")]
    Unavailable(String),
}

#[derive(Clone)]
pub struct R2 {
    endpoint: String,
    host: String,
    bucket: String,
    access_key: String,
    secret_key: String,
    http: reqwest::Client,
}

#[derive(Clone)]
pub enum Store {
    Dir(PathBuf),
    R2(R2),
}

impl std::fmt::Debug for Store {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Store::Dir(p) => write!(f, "Store::Dir({})", p.display()),
            Store::R2(r) => write!(f, "Store::R2({}/<redacted>)", r.bucket),
        }
    }
}

/// `bucket/key` with a conservative character set: no `..`, no leading `/`,
/// no backslashes, at most 400 characters.
pub fn object_path(bucket: &str, key: &str) -> Result<String, StoreError> {
    let bucket_ok = !bucket.is_empty()
        && bucket.len() <= 63
        && bucket
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    let key_ok = !key.is_empty()
        && key.len() <= 400
        && !key.starts_with('/')
        && !key.ends_with('/')
        && key
            .split('/')
            .all(|seg| !seg.is_empty() && seg != "." && seg != "..")
        && key
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'-' | b'_' | b'.'));
    if bucket_ok && key_ok {
        Ok(format!("{bucket}/{key}"))
    } else {
        Err(StoreError::BadKey)
    }
}

impl Store {
    /// R2 when all four R2_* variables are set, else FILE_STORE_DIR, else None
    /// (uploads and downloads then answer 503 and machine photos are logged only).
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Option<Store>, String> {
        let v = |k: &str| {
            get(k)
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
        };
        let r2 = [
            v("R2_ACCOUNT_ID"),
            v("R2_ACCESS_KEY_ID"),
            v("R2_SECRET_ACCESS_KEY"),
            v("R2_BUCKET"),
        ];
        match r2 {
            [Some(account), Some(access_key), Some(secret_key), Some(bucket)] => {
                if !account.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    return Err("R2_ACCOUNT_ID must be alphanumeric".into());
                }
                let host = format!("{account}.r2.cloudflarestorage.com");
                Ok(Some(Store::R2(R2::new(format!("https://{host}"), host, bucket, access_key, secret_key)?)))
            }
            [None, None, None, None] => Ok(v("FILE_STORE_DIR").map(|d| Store::Dir(PathBuf::from(d)))),
            _ => Err("set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET, or none".into()),
        }
    }

    /// Writes once. Ok(false) when the object already exists (left untouched).
    pub async fn put(
        &self,
        bucket: &str,
        key: &str,
        bytes: &[u8],
        mime: &str,
    ) -> Result<bool, StoreError> {
        let path = object_path(bucket, key)?;
        match self {
            Store::Dir(root) => {
                let full = root.join(&path);
                if let Some(parent) = full.parent() {
                    tokio::fs::create_dir_all(parent).await.map_err(io)?;
                }
                if tokio::fs::try_exists(&full).await.map_err(io)? {
                    return Ok(false);
                }
                let tmp = full.with_extension(format!("part-{}", uuid::Uuid::new_v4()));
                tokio::fs::write(&tmp, bytes).await.map_err(io)?;
                tokio::fs::rename(&tmp, &full).await.map_err(io)?;
                Ok(true)
            }
            Store::R2(r2) => r2.put(&path, bytes, mime).await,
        }
    }

    pub async fn get(&self, bucket: &str, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let path = object_path(bucket, key)?;
        match self {
            Store::Dir(root) => match tokio::fs::read(root.join(&path)).await {
                Ok(b) => Ok(Some(b)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(io(e)),
            },
            Store::R2(r2) => r2.get(&path).await,
        }
    }

    pub async fn delete(&self, bucket: &str, key: &str) -> Result<(), StoreError> {
        let path = object_path(bucket, key)?;
        match self {
            Store::Dir(root) => match tokio::fs::remove_file(root.join(&path)).await {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io(e)),
                _ => Ok(()),
            },
            Store::R2(r2) => r2.delete(&path).await,
        }
    }
}

fn io(e: std::io::Error) -> StoreError {
    StoreError::Unavailable(e.kind().to_string())
}

impl R2 {
    fn new(
        endpoint: String,
        host: String,
        bucket: String,
        access_key: String,
        secret_key: String,
    ) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .connect_timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            endpoint,
            host,
            bucket,
            access_key,
            secret_key,
            http,
        })
    }

    fn signed(
        &self,
        method: reqwest::Method,
        path: &str,
        payload_sha: &str,
        extra: &[(&'static str, String)],
    ) -> reqwest::RequestBuilder {
        let url_path = format!(
            "/{}/{}",
            sigv4::uri_encode(&self.bucket, false),
            sigv4::uri_encode(path, true)
        );
        let amz_date = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
        let mut headers: Vec<(&str, String)> = vec![
            ("host", self.host.clone()),
            ("x-amz-content-sha256", payload_sha.to_owned()),
            ("x-amz-date", amz_date.clone()),
        ];
        headers.extend(extra.iter().map(|(k, v)| (*k, v.clone())));
        let auth = sigv4::authorization(
            &sigv4::Request {
                method: method.as_str(),
                path: &url_path,
                query: "",
                headers: &headers,
                payload_sha256: payload_sha,
                amz_date: &amz_date,
                region: "auto",
                service: "s3",
            },
            &self.access_key,
            &self.secret_key,
        );
        let mut rb = self
            .http
            .request(method, format!("{}{}", self.endpoint, url_path))
            .header("authorization", auth);
        for (k, v) in headers.iter().filter(|(k, _)| *k != "host") {
            rb = rb.header(*k, v);
        }
        rb
    }

    async fn put(&self, path: &str, bytes: &[u8], mime: &str) -> Result<bool, StoreError> {
        let sha = sigv4::sha256_hex(bytes);
        let res = self
            .signed(
                reqwest::Method::PUT,
                path,
                &sha,
                &[
                    ("content-type", mime.to_owned()),
                    ("if-none-match", "*".to_owned()),
                ],
            )
            .body(bytes.to_vec())
            .send()
            .await
            .map_err(|e| StoreError::Unavailable(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200 | 201 => Ok(true),
            412 => Ok(false),
            s => Err(StoreError::Unavailable(format!("PUT {s}"))),
        }
    }

    async fn get(&self, path: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let empty = sigv4::sha256_hex(b"");
        let res = self
            .signed(reqwest::Method::GET, path, &empty, &[])
            .send()
            .await
            .map_err(|e| StoreError::Unavailable(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200 => Ok(Some(
                res.bytes()
                    .await
                    .map_err(|e| StoreError::Unavailable(e.without_url().to_string()))?
                    .to_vec(),
            )),
            404 => Ok(None),
            s => Err(StoreError::Unavailable(format!("GET {s}"))),
        }
    }

    async fn delete(&self, path: &str) -> Result<(), StoreError> {
        let empty = sigv4::sha256_hex(b"");
        let res = self
            .signed(reqwest::Method::DELETE, path, &empty, &[])
            .send()
            .await
            .map_err(|e| StoreError::Unavailable(e.without_url().to_string()))?;
        match res.status().as_u16() {
            200 | 204 | 404 => Ok(()),
            s => Err(StoreError::Unavailable(format!("DELETE {s}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_paths_are_strict() {
        assert_eq!(
            object_path("employee-files", "o1/e1/v1.pdf").unwrap(),
            "employee-files/o1/e1/v1.pdf"
        );
        for bad in [
            "",
            "/abs",
            "a/../b",
            "a//b",
            "a/./b",
            "trail/",
            "sp ace",
            "back\\slash",
            "q?x",
            &"x".repeat(401),
        ] {
            assert!(object_path("b", bad).is_err(), "{bad:?}");
        }
        for bad in ["", "Upper", "under_score", "dot.ted", &"b".repeat(64)] {
            assert!(object_path(bad, "k").is_err(), "{bad:?}");
        }
    }

    #[test]
    fn config_needs_all_r2_or_none() {
        let env = |pairs: &'static [(&'static str, &'static str)]| {
            move |k: &str| {
                pairs
                    .iter()
                    .find(|(a, _)| *a == k)
                    .map(|(_, v)| v.to_string())
            }
        };
        assert!(Store::from_lookup(env(&[])).unwrap().is_none());
        assert!(matches!(
            Store::from_lookup(env(&[("FILE_STORE_DIR", "/tmp/x")])).unwrap(),
            Some(Store::Dir(_))
        ));
        assert!(Store::from_lookup(env(&[("R2_BUCKET", "b")])).is_err());
        assert!(
            Store::from_lookup(env(&[
                ("R2_ACCOUNT_ID", "bad.host"),
                ("R2_ACCESS_KEY_ID", "a"),
                ("R2_SECRET_ACCESS_KEY", "s"),
                ("R2_BUCKET", "b")
            ]))
            .is_err()
        );
        let r2 = Store::from_lookup(env(&[
            ("R2_ACCOUNT_ID", "abc123"),
            ("R2_ACCESS_KEY_ID", "a"),
            ("R2_SECRET_ACCESS_KEY", "s"),
            ("R2_BUCKET", "b"),
            ("FILE_STORE_DIR", "/tmp"),
        ]))
        .unwrap()
        .unwrap();
        assert!(matches!(&r2, Store::R2(r) if r.host == "abc123.r2.cloudflarestorage.com"));
        assert!(format!("{r2:?}").contains("<redacted>"));
    }

    #[tokio::test]
    async fn dir_store_writes_once_reads_and_deletes() {
        let dir = std::env::temp_dir().join(format!("hrms-store-{}", uuid::Uuid::new_v4()));
        let s = Store::Dir(dir.clone());
        assert!(
            s.put("files", "a/b.pdf", b"one", "application/pdf")
                .await
                .unwrap()
        );
        assert!(
            !s.put("files", "a/b.pdf", b"two", "application/pdf")
                .await
                .unwrap()
        );
        assert_eq!(s.get("files", "a/b.pdf").await.unwrap().unwrap(), b"one");
        assert!(s.get("files", "a/missing.pdf").await.unwrap().is_none());
        s.delete("files", "a/b.pdf").await.unwrap();
        s.delete("files", "a/b.pdf").await.unwrap();
        assert!(s.get("files", "a/b.pdf").await.unwrap().is_none());
        assert!(matches!(
            s.put("files", "../escape", b"x", "x").await,
            Err(StoreError::BadKey)
        ));
        let _ = std::fs::remove_dir_all(dir);
    }
}
