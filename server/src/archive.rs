//! Annual archive (port of the HRMS `archive` Edge Function).
//!
//!   GET  /v1/archive/{job}/files/{version}
//!        -> Admin only, audited grant for ONE inventoried cloud file of an
//!           export; streams the bytes (no signed URL ever leaves us). The
//!           browser checks `x-sha256` before adding it to the ZIP.
//!   POST /v1/archive/cleanup/{job}?reconcile_only=true
//!        -> claims one leased batch for the driving Admin, deletes exactly
//!           those object keys and records each outcome.

use axum::{
    extract::{Path, Query, State},
    http::{HeaderValue, StatusCode},
    response::Response,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    app::{AppState, ok},
    auth::session::Session,
    db,
    error::{ApiError, ApiResult},
    files::{actor, disposition, file_response, storage_down, store},
};

pub async fn export_file(
    State(state): State<AppState>,
    session: Session,
    Path((job, version)): Path<(Uuid, Uuid)>,
) -> ApiResult<Response> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let store = store(&state).map_err(tag)?;
    let pool = &state.db().map_err(tag)?.pool;
    let grant = db::service_call(
        pool,
        "internal_authorize_export_file",
        actor(&session, json!({ "p_job_id": job, "p_file_version_id": version })),
    )
    .await
    .map_err(tag)?;
    if grant.get("available").and_then(Value::as_bool) != Some(true) {
        let msg = grant
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("This file is no longer in cloud storage.");
        return Err(tag(ApiError::new(StatusCode::GONE, "ARCHIVED", msg)));
    }
    let s = |k: &str| grant.get(k).and_then(Value::as_str).unwrap_or_default();
    let bytes = store
        .get(s("bucket"), s("object_key"))
        .await
        .map_err(|e| tag(storage_down(e)))?
        .ok_or_else(|| tag(ApiError::new(StatusCode::GONE, "ARCHIVED", "This file is no longer stored.")))?;
    let mut res = file_response(
        bytes,
        "application/octet-stream",
        &disposition("attachment", &version.to_string()),
        grant.get("grant_id").and_then(Value::as_str),
    );
    if let Ok(v) = HeaderValue::from_str(s("sha256")) {
        res.headers_mut().insert("x-sha256", v);
    }
    Ok(res)
}

#[derive(Deserialize)]
pub struct CleanupQuery {
    reconcile_only: Option<bool>,
}

#[derive(Deserialize)]
struct Item {
    item_id: i64,
    bucket: String,
    object_key: String,
}

/// Only exact server-generated keys are ever deleted; anything that looks
/// like a path escape is refused (and left for reconcile) rather than guessed.
pub fn safe_key(key: &str) -> bool {
    !key.is_empty() && !key.contains("..") && !key.starts_with('/') && !key.contains('\\')
}

pub async fn cleanup_batch(
    State(state): State<AppState>,
    session: Session,
    Path(job): Path<Uuid>,
    Query(q): Query<CleanupQuery>,
) -> ApiResult<axum::Json<Value>> {
    let rid = session.request_id;
    let tag = |e: ApiError| e.with_request_id(Some(rid.to_string()));
    let store = store(&state).map_err(tag)?;
    let pool = &state.db().map_err(tag)?.pool;
    let worker = Uuid::new_v4();
    let claim = db::service_call(
        pool,
        "internal_cleanup_claim",
        actor(
            &session,
            json!({
                "p_cleanup_job_id": job,
                "p_worker": worker,
                "p_limit": 20,
                "p_reconcile_only": q.reconcile_only.unwrap_or(false),
            }),
        ),
    )
    .await
    .map_err(tag)?;
    let items: Vec<Item> = claim
        .get("items")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let flag = |k: &str| claim.get(k).and_then(Value::as_bool) == Some(true);
    if flag("done") || flag("busy") || items.is_empty() {
        return Ok(ok(claim, rid));
    }
    let mut results = Vec::with_capacity(items.len());
    for it in items.iter().filter(|i| safe_key(&i.object_key)) {
        // A key that is already gone counts as deleted (Store::delete is idempotent).
        match store.delete(&it.bucket, &it.object_key).await {
            Ok(()) => results.push(json!({ "item_id": it.item_id, "ok": true })),
            Err(e) => {
                let msg: String = e.to_string().chars().take(200).collect();
                results.push(json!({ "item_id": it.item_id, "ok": false, "error": msg }));
            }
        }
    }
    let done = db::service_call(
        pool,
        "internal_cleanup_complete",
        actor(
            &session,
            json!({ "p_cleanup_job_id": job, "p_worker": worker, "p_results": results }),
        ),
    )
    .await
    .map_err(tag)?;
    Ok(ok(done, rid))
}

#[cfg(test)]
mod tests {
    use super::safe_key;

    #[test]
    fn refuses_path_escapes() {
        assert!(safe_key("org/abc/file.pdf"));
        assert!(!safe_key(""));
        assert!(!safe_key("/etc/passwd"));
        assert!(!safe_key("a/../b"));
        assert!(!safe_key("a\\b"));
    }
}
