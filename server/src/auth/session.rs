//! Resolves the session cookie into verified claims for every request.

use axum::{extract::FromRequestParts, http::request::Parts};
use uuid::Uuid;

use super::token::hash_presented;
use crate::{
    app::{AppState, request_id},
    db::Claims,
    error::ApiError,
};

/// A signed-in caller. Extracting it fails with 401 AUTH_REQUIRED when the
/// cookie is missing, malformed, unknown, expired or idle too long.
#[derive(Debug, Clone)]
pub struct Session {
    pub claims: Claims,
    pub token_hash: [u8; 32],
    pub request_id: Uuid,
}

impl FromRequestParts<AppState> for Session {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let rid = request_id(&parts.headers);
        let denied = || ApiError::auth_required().with_request_id(Some(rid.to_string()));
        let token = state.cookie.read(&parts.headers).ok_or_else(denied)?;
        let token_hash = hash_presented(token).ok_or_else(denied)?;
        let db = state.db()?;
        let row: Option<(Uuid, Uuid, String)> =
            sqlx::query_as("select session_id, user_id, email from iam.resolve_session($1)")
                .bind(&token_hash[..])
                .fetch_optional(&db.pool)
                .await?;
        let (session_id, sub, email) = row.ok_or_else(denied)?;
        Ok(Self {
            claims: Claims {
                sub,
                session_id,
                email,
            },
            token_hash,
            request_id: rid,
        })
    }
}
