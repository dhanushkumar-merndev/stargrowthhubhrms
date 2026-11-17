//! `/iclock/<endpoint>[.aspx]` (also `/api/iclock/...`): the push endpoint the
//! attendance machines call directly (not through the Vercel proxy).
//!
//! Security posture (as in fingertipssl):
//!   * Feature off (no DEVICE_INGEST_SECRET), unknown / inactive serials, a
//!     wrong token or a bad secret get a bland 404; the database logs a row in
//!     hrms.device_ingest_rejections.
//!   * ATTLOG and ATTPHOTO are processed. OPERLOG / USERINFO only yield the
//!     roster (PIN + name + admin flag). Biometric tables are acknowledged so
//!     the machine stops resending, and never read or stored.
//!   * Commands are built by the database from an allowlist; off per machine
//!     unless an Admin enables them.
//!   * Database trouble answers 503 so the machine keeps the data and retries.

use axum::{
    body::{Body, to_bytes},
    extract::{Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use super::protocol::{self as p, Endpoint};
use crate::{app::AppState, auth::token, db};

/// Under the Cloudflare relay's and Render's limits.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

pub const RELAY_SECRET_HEADER: &str = "x-relay-secret";
pub const DEVICE_IP_HEADER: &str = "x-device-ip";

fn reply(body: impl Into<String>, status: StatusCode) -> Response {
    let body: String = body.into();
    (
        status,
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("text/plain; charset=utf-8"),
            ),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
        ],
        body,
    )
        .into_response()
}

fn ok(body: impl Into<String>) -> Response {
    reply(body, StatusCode::OK)
}
fn not_found() -> Response {
    reply("Not Found", StatusCode::NOT_FOUND)
}
fn unavailable() -> Response {
    reply("Service Unavailable", StatusCode::SERVICE_UNAVAILABLE)
}

/// The machine's IP. Behind the Cloudflare relay every request comes from
/// Cloudflare, so the relay passes the real one in x-device-ip; it is only
/// believed with the shared DEVICE_RELAY_SECRET.
pub fn device_ip(headers: &HeaderMap, relay_secret: Option<&str>) -> String {
    let get = |h: &str| headers.get(h).and_then(|v| v.to_str().ok()).map(str::trim);
    if let (Some(relay), Some(presented)) = (relay_secret, get(RELAY_SECRET_HEADER))
        && bool::from(presented.as_bytes().ct_eq(relay.as_bytes()))
        && let Some(ip) = get(DEVICE_IP_HEADER).filter(|s| !s.is_empty())
    {
        return ip.chars().take(64).collect();
    }
    get("x-forwarded-for")
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| get("x-real-ip").filter(|s| !s.is_empty()))
        .unwrap_or("unknown")
        .chars()
        .take(64)
        .collect()
}

/// Keyed hash of the device IP: correlate abuse without storing IPs.
pub fn ip_hash(ingest_secret: &str, ip: &str) -> String {
    token::ip_hash(ingest_secret, &format!("ip:{ip}"))[..32].to_owned()
}

const PHOTO_BUCKET: &str = "device-photos";
/// Same cap as `device_punch_photos.size_bytes`.
const MAX_PHOTO_BYTES: usize = 2_097_152;

/// `<org>/<serial>/<YYYY-MM-DD>/<pin>-<HHMMSS>-<sha8>.jpg`, exactly what
/// internal_attach_device_photo expects. None for anything unsafe.
pub fn photo_path(
    org: &str,
    serial: &str,
    pin: &str,
    device_time: &str,
    sha: &str,
) -> Option<String> {
    let t = chrono::NaiveDateTime::parse_from_str(device_time.trim(), "%Y-%m-%d %H:%M:%S").ok()?;
    let safe = |s: &str, max: usize| {
        !s.is_empty() && s.len() <= max && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    if !safe(org, 36)
        || !safe(serial, 64)
        || !pin.bytes().all(|b| b.is_ascii_alphanumeric())
        || pin.is_empty()
        || pin.len() > 24
        || sha.len() < 8
    {
        return None;
    }
    Some(format!(
        "{org}/{serial}/{}/{pin}-{}-{}.jpg",
        t.format("%Y-%m-%d"),
        t.format("%H%M%S"),
        &sha[..8]
    ))
}

struct Ctx<'a> {
    pool: &'a sqlx::PgPool,
    secret: &'a str,
    serial: String,
    token: Option<String>,
    ip_hash: String,
    store: Option<&'a crate::storage::Store>,
}

struct Transient;

impl From<crate::error::ApiError> for Transient {
    fn from(e: crate::error::ApiError) -> Self {
        tracing::error!(error = ?e, "iclock database call failed");
        Transient
    }
}

type R<T> = Result<T, Transient>;

impl Ctx<'_> {
    fn base(&self) -> serde_json::Map<String, Value> {
        let mut m = serde_json::Map::new();
        m.insert("p_secret".into(), json!(self.secret));
        m.insert("p_serial".into(), json!(self.serial));
        m.insert("p_token".into(), json!(self.token));
        m.insert("p_ip_hash".into(), json!(self.ip_hash));
        m
    }

    async fn call(&self, name: &'static str, extra: Value) -> R<Value> {
        let mut args = self.base();
        if let Value::Object(e) = extra {
            args.extend(e);
        }
        Ok(db::service_call(self.pool, name, Value::Object(args)).await?)
    }

    async fn gate(&self, endpoint: &str, meta: Value) -> R<Value> {
        self.call(
            "internal_device_gate",
            json!({ "p_endpoint": endpoint, "p_meta": meta }),
        )
        .await
    }

    /// Best effort: a failed log never changes the reply.
    async fn reject(&self, code: &str, detail: Value) {
        let args = json!({
            "p_secret": self.secret, "p_serial": self.serial, "p_code": code,
            "p_detail": detail, "p_ip_hash": self.ip_hash,
        });
        if let Err(e) = db::service_call(self.pool, "internal_log_device_rejection", args).await {
            tracing::warn!(error = ?e, code, "iclock rejection log failed");
        }
    }
}

fn is_ok(v: &Value) -> bool {
    v["ok"].as_bool() == Some(true)
}

fn param<'a>(q: &'a [(String, String)], names: &[&str]) -> Option<&'a str> {
    names
        .iter()
        .find_map(|n| q.iter().find(|(k, _)| k == n).map(|(_, v)| v.as_str()))
}

pub async fn handle(
    State(state): State<AppState>,
    Path(segment): Path<String>,
    Query(query): Query<Vec<(String, String)>>,
    req: Request,
) -> Response {
    let (Some(secret), Some(endpoint)) = (
        state.config.device_ingest_secret.as_deref(),
        p::normalize_endpoint(&segment),
    ) else {
        return not_found();
    };
    let serial = param(&query, &["SN", "sn"]).map(str::trim).unwrap_or("");
    if serial.is_empty() {
        return not_found();
    }
    let Ok(dbh) = state.db() else {
        return unavailable();
    };
    let headers = req.headers().clone();
    let ip = device_ip(&headers, state.config.device_relay_secret.as_deref());
    let ctx = Ctx {
        pool: &dbh.pool,
        secret,
        serial: serial.chars().take(64).collect(),
        token: param(&query, &["token"]).map(str::to_owned).or_else(|| {
            headers
                .get("x-device-token")
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        }),
        ip_hash: ip_hash(secret, &ip),
        store: state.store.as_deref(),
    };
    let method = req.method().clone();
    let result = if method == Method::GET {
        handle_get(&ctx, endpoint, &query).await
    } else if method == Method::POST {
        handle_post(&ctx, endpoint, &query, &headers, req.into_body()).await
    } else {
        return not_found();
    };
    let mut res = result.unwrap_or_else(|Transient| unavailable());
    if res.status() == StatusCode::OK {
        stamp_local_date(&mut res, &dbh.pool, &ctx.serial).await;
    }
    res
}

/// The machines set their clock from the HTTP `Date` header of every reply,
/// read as local time (a machine left on UTC was 5 h 30 m behind and undid
/// any SET OPTION DateTime within seconds). So machine replies carry the
/// organisation's wall-clock time in `Date`. Nothing else reads this header.
async fn stamp_local_date(res: &mut Response, pool: &sqlx::PgPool, serial: &str) {
    let offset: Option<i32> = sqlx::query_scalar(
        "select extract(epoch from (now() at time zone o.timezone) - (now() at time zone 'UTC'))::int \
           from hrms.attendance_devices d join hrms.organizations o on o.id = d.org_id where d.serial = $1",
    )
    .bind(serial)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    if let Some(v) =
        offset.and_then(|s| HeaderValue::from_str(&p::local_http_date(chrono::Utc::now(), s)).ok())
    {
        res.headers_mut().insert(header::DATE, v);
    }
}

async fn handle_get(ctx: &Ctx<'_>, endpoint: Endpoint, q: &[(String, String)]) -> R<Response> {
    if endpoint == Endpoint::Cdata {
        let pushver = param(q, &["pushver"]);
        let g = ctx.gate("handshake", json!({ "pushver": pushver })).await?;
        if !is_ok(&g) {
            return Ok(not_found());
        }
        let c = p::Cursors {
            attlog: g["attlog_stamp"].as_i64().unwrap_or(0),
            photo: g["photo_stamp"].as_i64().unwrap_or(0),
            oplog: g["oplog_stamp"].as_i64().unwrap_or(0),
        };
        return Ok(ok(p::build_options(&ctx.serial, c, pushver)));
    }
    let meta = json!({ "firmware": p::firmware_from_info(param(q, &["INFO", "info"])) });
    if endpoint == Endpoint::Getrequest {
        let r = ctx
            .call("internal_device_poll", json!({ "p_meta": meta }))
            .await?;
        if !is_ok(&r) {
            return Ok(not_found());
        }
        let lines: Vec<String> = r["commands"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_owned))
                    .collect()
            })
            .unwrap_or_default();
        return Ok(ok(p::command_reply(&lines)));
    }
    let g = ctx.gate(endpoint.as_str(), meta).await?;
    Ok(if is_ok(&g) { ok("OK") } else { not_found() })
}

async fn read_body(headers: &HeaderMap, body: Body) -> Option<Vec<u8>> {
    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    if declared > MAX_BODY_BYTES as u64 {
        return None;
    }
    to_bytes(body, MAX_BODY_BYTES)
        .await
        .ok()
        .map(|b| b.to_vec())
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

async fn too_large(ctx: &Ctx<'_>, table: &str) -> Response {
    ctx.reject("body_too_large", json!({ "table": table }))
        .await;
    reply("Payload Too Large", StatusCode::PAYLOAD_TOO_LARGE)
}

async fn handle_post(
    ctx: &Ctx<'_>,
    endpoint: Endpoint,
    q: &[(String, String)],
    headers: &HeaderMap,
    body: Body,
) -> R<Response> {
    let table = param(q, &["table"]).unwrap_or("").to_ascii_uppercase();
    let stamp = param(q, &["Stamp", "stamp"]).map(str::to_owned);

    if endpoint == Endpoint::Devicecmd {
        let Some(bytes) = read_body(headers, body).await else {
            return Ok(too_large(ctx, "devicecmd").await);
        };
        let results = p::parse_command_results(&latin1(&bytes));
        let r = ctx
            .call(
                "internal_device_command_results",
                json!({ "p_results": results }),
            )
            .await?;
        return Ok(if is_ok(&r) { ok("OK") } else { not_found() });
    }

    // Answer to DATA QUERY USERINFO: `user uid=..\tpin=..\tname=..\tprivilege=..`
    // lines (same fields as an OPERLOG USER record). Only the roster is kept.
    if endpoint == Endpoint::Querydata
        && param(q, &["tablename", "TableName"]).is_some_and(|t| t.eq_ignore_ascii_case("user"))
    {
        let Some(bytes) = read_body(headers, body).await else {
            return Ok(too_large(ctx, "querydata").await);
        };
        let users = p::parse_user_records("OPERLOG", &latin1(&bytes));
        if users.is_empty() {
            let g = ctx.gate("querydata", json!({})).await?;
            return Ok(if is_ok(&g) { ok("OK") } else { not_found() });
        }
        let r = ctx
            .call(
                "internal_ingest_device_users",
                json!({ "p_users": users, "p_stamp": Value::Null }),
            )
            .await?;
        return Ok(if is_ok(&r) { ok("OK") } else { not_found() });
    }

    if endpoint != Endpoint::Cdata && endpoint != Endpoint::Fdata {
        // Other pushes: acknowledge, never act.
        let g = ctx.gate(endpoint.as_str(), json!({})).await?;
        return Ok(if is_ok(&g) { ok("OK") } else { not_found() });
    }

    let Some(bytes) = read_body(headers, body).await else {
        return Ok(too_large(ctx, &table).await);
    };
    let is_photo = endpoint == Endpoint::Fdata || table == "ATTPHOTO";

    if table == "ATTLOG" && !is_photo {
        let (records, malformed) = p::parse_attlog(&latin1(&bytes));
        if records.is_empty() && malformed.is_empty() {
            let g = ctx.gate("attlog", json!({})).await?;
            return Ok(if is_ok(&g) {
                ok(p::ack_lines(0))
            } else {
                not_found()
            });
        }
        let mut all: Vec<(usize, Value)> = records
            .iter()
            .map(|r| (r.line, json!(r)))
            .chain(malformed.iter().map(|m| (m.line, json!(m))))
            .collect();
        all.sort_by_key(|(line, _)| *line);
        let list: Vec<Value> = all.into_iter().map(|(_, v)| v).collect();
        let r = ctx
            .call(
                "internal_ingest_device_punches",
                json!({ "p_records": list, "p_stamp": stamp }),
            )
            .await?;
        if !is_ok(&r) {
            return Ok(not_found());
        }
        return Ok(ok(p::ack_lines(
            r["processed"].as_u64().unwrap_or(0) as usize
        )));
    }

    if is_photo {
        let g = ctx.gate("attphoto", json!({})).await?;
        if !is_ok(&g) {
            return Ok(not_found());
        }
        let org_id = g["org_id"].as_str().unwrap_or_default().to_owned();
        let content_type = headers
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        let parsed = if content_type
            .to_ascii_lowercase()
            .starts_with("multipart/form-data")
        {
            match p::split_multipart(content_type, &bytes) {
                Some((fields, file)) => p::parse_photo_multipart(&fields, file),
                None => Err("bad_multipart"),
            }
        } else {
            p::parse_photo_body(&bytes)
        };
        match parsed {
            Err(error) => {
                // Unusable photo: log and acknowledge so it is not resent forever.
                ctx.reject("bad_photo", json!({ "error": error })).await;
            }
            Ok(photo) => {
                let sha = hex(&Sha256::digest(&photo.jpeg));
                match (
                    ctx.store,
                    photo_path(&org_id, &ctx.serial, &photo.pin, &photo.device_time, &sha),
                ) {
                    (None, _) => {
                        // No object storage configured: acknowledge, log the fingerprint only.
                        tracing::info!(serial = %ctx.serial, pin = %photo.pin, sha = &sha[..8], bytes = photo.jpeg.len(), "punch photo received (storage off)");
                        ctx.reject(
                            "photo_storage_off",
                            json!({ "pin": photo.pin, "device_time": photo.device_time, "sha8": &sha[..8] }),
                        )
                        .await;
                    }
                    (Some(_), None) => {
                        ctx.reject(
                            "bad_photo",
                            json!({ "error": "bad_path", "pin": photo.pin }),
                        )
                        .await;
                    }
                    (Some(store), Some(path)) if photo.jpeg.len() <= MAX_PHOTO_BYTES => {
                        let fresh = match store
                            .put(PHOTO_BUCKET, &path, &photo.jpeg, "image/jpeg")
                            .await
                        {
                            Ok(fresh) => fresh,
                            Err(e) => {
                                // The machine resends on a non-OK reply.
                                tracing::error!(error = %e, "punch photo storage failed");
                                return Ok(unavailable());
                            }
                        };
                        let r = ctx
                            .call(
                                "internal_attach_device_photo",
                                json!({
                                    "p_pin": photo.pin, "p_device_time": photo.device_time,
                                    "p_storage_path": path, "p_sha256": sha,
                                    "p_size_bytes": photo.jpeg.len(), "p_stamp": stamp,
                                }),
                            )
                            .await;
                        let keep = matches!(&r, Ok(v) if is_ok(v));
                        if !keep && fresh {
                            let _ = store.delete(PHOTO_BUCKET, &path).await;
                        }
                        r?;
                    }
                    (Some(_), Some(_)) => {
                        ctx.reject(
                            "bad_photo",
                            json!({ "error": "too_large", "bytes": photo.jpeg.len() }),
                        )
                        .await;
                    }
                }
            }
        }
        return Ok(ok("OK"));
    }

    if table == "OPERLOG" || table == "USERINFO" {
        let text = latin1(&bytes);
        let users = p::parse_user_records(&table, &text);
        let r = if users.is_empty() {
            ctx.call("internal_device_oplog_seen", json!({ "p_stamp": stamp }))
                .await?
        } else {
            ctx.call(
                "internal_ingest_device_users",
                json!({ "p_users": users, "p_stamp": stamp }),
            )
            .await?
        };
        return Ok(if is_ok(&r) {
            ok(p::ack_lines(p::count_lines(&text)))
        } else {
            not_found()
        });
    }

    // Any other table (BIODATA, FINGERTMP, FACE, ...): never stored.
    let label: String = table.chars().take(20).collect();
    let g = ctx
        .gate(
            &format!("discard:{}", if label.is_empty() { "none" } else { &label }),
            json!({}),
        )
        .await?;
    if !is_ok(&g) {
        return Ok(not_found());
    }
    if p::BIOMETRIC_TABLES.contains(&table.as_str()) {
        ctx.reject("biometric_discarded", json!({ "table": table }))
            .await;
    }
    Ok(ok(p::ack_lines(p::count_lines(&latin1(&bytes)))))
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Registers the ingest secret's hash so the database can verify devices.
pub async fn configure(pool: &sqlx::PgPool, secret: &str) -> Result<(), crate::error::ApiError> {
    db::service_call(
        pool,
        "internal_configure_device_ingest",
        json!({ "p_secret": secret }),
    )
    .await
    .map(|_| ())
}

#[cfg(test)]
mod tests {

    #[test]
    fn photo_paths_match_the_database_rule() {
        let org = "6f1c2c56-0d7a-4c55-9c0e-5f3a1b2c3d4e";
        let sha = "abcdef0123456789";
        assert_eq!(
            photo_path(org, "CKJB12", "7", "2026-11-14 09:05:03", sha).unwrap(),
            format!("{org}/CKJB12/2026-11-14/7-090503-abcdef01.jpg")
        );
        assert!(photo_path(org, "CKJB12", "7", "2026-11-14T09:05:03", sha).is_none());
        assert!(photo_path(org, "CKJB12", "7", "2026-02-30 09:05:03", sha).is_none());
        assert!(photo_path(org, "../x", "7", "2026-11-14 09:05:03", sha).is_none());
        assert!(photo_path(org, "CKJB12", "7/..", "2026-11-14 09:05:03", sha).is_none());
        assert!(photo_path(org, "CKJB12", "", "2026-11-14 09:05:03", sha).is_none());
        assert!(photo_path(org, "CKJB12", &"9".repeat(25), "2026-11-14 09:05:03", sha).is_none());
        assert!(photo_path("", "CKJB12", "7", "2026-11-14 09:05:03", sha).is_none());
        assert!(photo_path(org, "CKJB12", "7", "2026-11-14 09:05:03", "abc").is_none());
    }

    use super::*;

    fn h(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (k, v) in pairs {
            m.insert(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        m
    }

    #[test]
    fn device_ip_trusts_the_relay_only_with_its_secret() {
        let relay = "r".repeat(40);
        let fwd = [("x-forwarded-for", "203.0.113.9, 10.0.0.1")];
        assert_eq!(device_ip(&h(&fwd), Some(&relay)), "203.0.113.9");
        let spoof = [
            ("x-forwarded-for", "203.0.113.9"),
            (DEVICE_IP_HEADER, "1.2.3.4"),
        ];
        assert_eq!(
            device_ip(&h(&spoof), Some(&relay)),
            "203.0.113.9",
            "no relay secret"
        );
        let wrong = [(RELAY_SECRET_HEADER, "nope"), (DEVICE_IP_HEADER, "1.2.3.4")];
        assert_eq!(device_ip(&h(&wrong), Some(&relay)), "unknown");
        let good = [
            (RELAY_SECRET_HEADER, relay.as_str()),
            (DEVICE_IP_HEADER, "1.2.3.4"),
        ];
        assert_eq!(device_ip(&h(&good), Some(&relay)), "1.2.3.4");
        assert_eq!(
            device_ip(&h(&good), None),
            "unknown",
            "relay not configured"
        );
        assert_eq!(
            device_ip(&h(&[("x-real-ip", "198.51.100.2")]), None),
            "198.51.100.2"
        );
        assert_eq!(device_ip(&h(&[]), None), "unknown");
    }

    #[test]
    fn ip_hash_is_keyed_and_short() {
        let a = ip_hash(&"k".repeat(32), "1.2.3.4");
        assert_eq!(a.len(), 32);
        assert_ne!(a, ip_hash(&"j".repeat(32), "1.2.3.4"));
        assert_ne!(a, ip_hash(&"k".repeat(32), "1.2.3.5"));
        assert!(!a.contains("1.2.3.4"));
    }

    #[test]
    fn params_are_case_sensitive_with_fallbacks() {
        let q = vec![
            ("sn".to_owned(), "ABC".to_owned()),
            ("Stamp".to_owned(), "9".to_owned()),
        ];
        assert_eq!(param(&q, &["SN", "sn"]), Some("ABC"));
        assert_eq!(param(&q, &["Stamp", "stamp"]), Some("9"));
        assert_eq!(param(&q, &["token"]), None);
    }
}
