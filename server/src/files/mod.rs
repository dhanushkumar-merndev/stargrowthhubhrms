//! Private files (port of the HRMS `files` Edge Function, without signed
//! storage URLs): the browser sends the bytes to us in one request and reads
//! them back through us. Storage credentials and object keys never leave the
//! server.
//!
//!   POST /v1/files?class=..&filename=..[&owner_employee_id&salary_month&document_date&title]
//!        body = raw bytes, Content-Type = the file's type
//!        -> begin (quota, rights) -> validate + hash -> write the final object
//!           once -> complete. Invalid bytes are never stored.
//!   GET  /v1/files/{version_id}?purpose=view|download|review
//!        -> audited authorisation -> bytes with `Cache-Control: no-store`.
//!           The grant id comes back in `x-file-grant` for report_file_opened.
//!   GET  /v1/device-photos/{punch_id} -> HR/Admin, audited, JPEG.

pub mod validate;

use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::{
    app::{AppState, ok},
    auth::session::Session,
    db,
    error::{ApiError, ApiResult},
    rpc,
    storage::{Store, StoreError},
};

const MIMES: &[&str] = &["application/pdf", "image/jpeg", "image/png", "image/webp"];

pub(crate) fn actor(s: &Session, extra: Value) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("p_auth_user_id".into(), json!(s.claims.sub));
    m.insert("p_session_id".into(), json!(s.claims.session_id));
    m.insert("p_email".into(), json!(s.claims.email));
    if let Value::Object(e) = extra {
        m.extend(e);
    }
    Value::Object(m)
}

pub(crate) fn store(state: &AppState) -> ApiResult<&Store> {
    state.store.as_deref().ok_or_else(|| {
        let mut e = ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "UPLOAD_UNAVAILABLE",
            "File storage is not set up yet.",
        );
        e.retryable = true;
        e
    })
}

pub(crate) fn storage_down(e: StoreError) -> ApiError {
    tracing::error!(error = %e, "object storage");
    let mut err = ApiError::new(
        StatusCode::SERVICE_UNAVAILABLE,
        "UPLOAD_UNAVAILABLE",
        "File storage is unavailable. Try again.",
    );
    err.retryable = true;
    err
}

fn too_large() -> ApiError {
    ApiError::new(
        StatusCode::PAYLOAD_TOO_LARGE,
        "FILE_TOO_LARGE",
        "Files must be at most 5 MB (5,000,000 bytes).",
    )
}

/// Keeps a display name safe for headers and logs.
pub fn clean_filename(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, '"' | '<' | '>' | ';'))
        .take(200)
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_owned();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned
    }
}

/// `Content-Disposition` with an ASCII fallback and RFC 5987 UTF-8 name.
pub fn disposition(kind: &str, filename: &str) -> String {
    let name = clean_filename(filename);
    let ascii: String = name
        .chars()
        .map(|c| if c.is_ascii() && c != '\\' { c } else { '_' })
        .collect();
    format!(
        "{kind}; filename=\"{ascii}\"; filename*=UTF-8''{}",
        crate::storage::sigv4::uri_encode(&name, false)
    )
}

#[derive(Deserialize)]
pub struct UploadQuery {
    class: String,
    filename: Option<String>,
    owner_employee_id: Option<Uuid>,
    salary_month: Option<chrono::NaiveDate>,
    document_date: Option<chrono::NaiveDate>,
    title: Option<String>,
}

pub async fn upload(
    State(state): State<AppState>,
    session: Session,
    Query(q): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let store = store(&state).map_err(tag)?;
    let pool = &state.db().map_err(tag)?.pool;

    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|m| MIMES.contains(&m.as_str()))
        .ok_or_else(|| {
            tag(ApiError::validation_field(
                "file",
                "type",
                "Use a PDF, JPG or PNG file.",
            ))
        })?;
    if headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok()?.parse::<usize>().ok())
        .is_some_and(|n| n > validate::MAX_BYTES)
    {
        return Err(tag(too_large()));
    }
    let bytes = axum::body::to_bytes(body, validate::MAX_BYTES)
        .await
        .map_err(|_| tag(too_large()))?;
    if bytes.is_empty() {
        return Err(tag(ApiError::validation_field(
            "file",
            "empty",
            "The file is empty.",
        )));
    }

    let begin = db::service_call(
        pool,
        "internal_begin_upload",
        actor(
            &session,
            json!({
                "p_class": q.class,
                "p_owner_employee_id": q.owner_employee_id,
                "p_salary_month": q.salary_month,
                "p_document_date": q.document_date,
                "p_title": q.title.as_deref().map(|t| t.chars().take(200).collect::<String>()),
                "p_filename": clean_filename(q.filename.as_deref().unwrap_or("file")),
                "p_declared_size": bytes.len(),
                "p_declared_mime": mime,
            }),
        ),
    )
    .await
    .map_err(tag)?;
    let version: Uuid = begin
        .get("file_version_id")
        .and_then(Value::as_str)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| tag(ApiError::internal()))?;

    let prep = db::service_call(
        pool,
        "internal_finish_upload_prepare",
        actor(&session, json!({ "p_file_version_id": version })),
    )
    .await
    .map_err(tag)?;
    if prep.get("already_complete").and_then(Value::as_bool) == Some(true) {
        return Ok(ok(
            json!({ "file_version_id": version, "state": prep["state"] }),
            rid,
        )
        .into_response());
    }
    let s = |k: &str| {
        prep.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned()
    };
    let (class, declared, bucket, key) = (
        s("class"),
        s("declared_mime"),
        s("final_bucket"),
        s("final_key"),
    );

    let check = validate::validate(&bytes, &declared, validate::allowed(&class));
    let sha = check
        .valid
        .then(|| crate::storage::sigv4::hex(&Sha256::digest(&bytes)));
    if check.valid {
        // Written once; a retry after a crash finds the same bytes in place.
        store
            .put(&bucket, &key, &bytes, &declared)
            .await
            .map_err(|e| tag(storage_down(e)))?;
    }
    let done = db::service_call(
        pool,
        "internal_finish_upload_complete",
        actor(
            &session,
            json!({
                "p_file_version_id": version,
                "p_valid": check.valid,
                "p_detected_mime": check.mime,
                "p_size_bytes": check.valid.then_some(bytes.len()),
                "p_sha256": sha,
                "p_error": check.error,
            }),
        ),
    )
    .await;
    let done = match done {
        Ok(v) => v,
        Err(e) => {
            if check.valid {
                let _ = store.delete(&bucket, &key).await;
            }
            return Err(tag(e));
        }
    };
    if !check.valid {
        let msg = check.error.unwrap_or("The file was rejected.");
        let mut e = ApiError::new(StatusCode::UNPROCESSABLE_ENTITY, "INVALID_FILE_TYPE", msg);
        e.field_errors = json!({ "file": msg });
        return Err(tag(e));
    }
    let mut out = json!({ "file_version_id": version });
    if let (Value::Object(o), Value::Object(d)) = (&mut out, done) {
        for (k, v) in d {
            o.entry(k).or_insert(v);
        }
    }
    Ok((StatusCode::CREATED, ok(out, rid)).into_response())
}

#[derive(Deserialize)]
pub struct AccessQuery {
    purpose: Option<String>,
}

pub(crate) fn file_response(
    bytes: Vec<u8>,
    mime: &str,
    disposition_value: &str,
    grant: Option<&str>,
) -> Response {
    let mut res = Response::new(Body::from(bytes));
    let h = res.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_str(mime).unwrap_or(HeaderValue::from_static("application/octet-stream")),
    );
    if let Ok(v) = HeaderValue::from_str(disposition_value) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    // Pay documents must not linger in shared caches or the browser cache.
    h.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, max-age=0"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    if let Some(g) = grant.and_then(|g| HeaderValue::from_str(g).ok()) {
        h.insert("x-file-grant", g);
    }
    res
}

pub async fn download(
    State(state): State<AppState>,
    session: Session,
    Path(version): Path<Uuid>,
    Query(q): Query<AccessQuery>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let store = store(&state).map_err(tag)?;
    let pool = &state.db().map_err(tag)?.pool;
    let purpose = match q.purpose.as_deref() {
        Some("download") => "download",
        Some("review") => "review",
        _ => "view",
    };
    let grant = db::service_call(
        pool,
        "internal_authorize_file_access",
        actor(
            &session,
            json!({ "p_file_version_id": version, "p_purpose": purpose }),
        ),
    )
    .await
    .map_err(tag)?;
    if grant.get("available").and_then(Value::as_bool) != Some(true) {
        let msg = grant
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("This file is not available.");
        return Err(tag(ApiError::new(StatusCode::GONE, "ARCHIVED", msg)));
    }
    let s = |k: &str| grant.get(k).and_then(Value::as_str).unwrap_or_default();
    let bytes = store
        .get(s("bucket"), s("object_key"))
        .await
        .map_err(|e| tag(storage_down(e)))?
        .ok_or_else(|| {
            tag(ApiError::new(
                StatusCode::GONE,
                "ARCHIVED",
                "This file is no longer stored.",
            ))
        })?;
    let kind = if purpose == "download" {
        "attachment"
    } else {
        "inline"
    };
    let mime = Some(s("mime"))
        .filter(|m| MIMES.contains(m))
        .unwrap_or("application/octet-stream");
    Ok(file_response(
        bytes,
        mime,
        &disposition(kind, s("filename")),
        grant.get("grant_id").and_then(Value::as_str),
    ))
}

pub async fn device_photo(
    State(state): State<AppState>,
    session: Session,
    Path(punch): Path<Uuid>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let store = store(&state).map_err(tag)?;
    let db = state.db().map_err(tag)?;
    let out = rpc::call_public(
        &db.pool,
        &db.catalog,
        &session.claims,
        "authorize_device_photo",
        json!({ "p_punch_id": punch }),
        rid,
    )
    .await?;
    let data = out.get("data").unwrap_or(&out);
    let s = |k: &str| data.get(k).and_then(Value::as_str).unwrap_or_default();
    let bytes = store
        .get(s("bucket"), s("path"))
        .await
        .map_err(|e| tag(storage_down(e)))?
        .ok_or_else(|| {
            tag(ApiError::new(
                StatusCode::GONE,
                "ARCHIVED",
                "This photo was removed after the retention period.",
            ))
        })?;
    Ok(file_response(bytes, "image/jpeg", "inline; filename=\"punch.jpg\"", None).into_response())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filenames_are_cleaned() {
        assert_eq!(clean_filename("../../etc/passwd"), "passwd");
        assert_eq!(clean_filename("C:\\Users\\a\\payslip.pdf"), "payslip.pdf");
        assert_eq!(clean_filename("..hidden"), "hidden");
        assert_eq!(clean_filename("a\"b<c>;d\r\n.pdf"), "abcd.pdf");
        assert_eq!(clean_filename("   "), "file");
        assert_eq!(clean_filename(""), "file");
        assert_eq!(clean_filename(&"x".repeat(300)).len(), 200);
    }

    #[test]
    fn disposition_has_ascii_and_utf8_names() {
        assert_eq!(
            disposition("inline", "Nov payslip.pdf"),
            "inline; filename=\"Nov payslip.pdf\"; filename*=UTF-8''Nov%20payslip.pdf"
        );
        assert_eq!(
            disposition("attachment", "ரசீது.pdf"),
            "attachment; filename=\"_____.pdf\"; filename*=UTF-8''%E0%AE%B0%E0%AE%9A%E0%AF%80%E0%AE%A4%E0%AF%81.pdf"
        );
        assert!(HeaderValue::from_str(&disposition("inline", "a\r\nSet-Cookie: x")).is_ok());
    }
}
