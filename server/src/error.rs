//! API errors. Every failure becomes `{"error": {code, message, field_errors,
//! retryable, request_id}}` with a stable code the web client can switch on.
//! HRMS SQL raises `P0001` with message = code and detail = JSON (see
//! hrms.raise_error); those pass through unchanged. Other database errors are
//! mapped to safe generic codes and never leak SQL text to the client.

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use serde_json::{Value, json};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ApiError {
    #[serde(skip)]
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub field_errors: Value,
    pub retryable: bool,
    pub request_id: Option<String>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &str, message: impl Into<String>) -> Self {
        Self {
            status,
            code: code.to_owned(),
            message: message.into(),
            field_errors: json!({}),
            retryable: false,
            request_id: None,
        }
    }

    pub fn auth_required() -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "AUTH_REQUIRED", "Please sign in.")
    }
    pub fn access_denied() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "ACCESS_DENIED",
            "You do not have access to this.",
        )
    }
    pub fn not_found() -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Not found.")
    }
    pub fn validation(message: impl Into<String>) -> Self {
        Self::new(
            StatusCode::UNPROCESSABLE_ENTITY,
            "VALIDATION_FAILED",
            message,
        )
    }
    pub fn validation_field(field: &str, problem: &str, message: impl Into<String>) -> Self {
        let mut e = Self::validation(message);
        e.field_errors = json!({ field: problem });
        e
    }
    pub fn rate_limited() -> Self {
        let mut e = Self::new(
            StatusCode::TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many attempts. Wait a moment and try again.",
        );
        e.retryable = true;
        e
    }
    pub fn internal() -> Self {
        let mut e = Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            "Something went wrong. Please try again.",
        );
        e.retryable = true;
        e
    }
    pub fn unavailable(message: impl Into<String>) -> Self {
        let mut e = Self::new(StatusCode::SERVICE_UNAVAILABLE, "UNAVAILABLE", message);
        e.retryable = true;
        e
    }
    pub fn with_request_id(mut self, id: Option<String>) -> Self {
        if self.request_id.is_none() {
            self.request_id = id;
        }
        self
    }
}

/// HTTP status for an HRMS error code (hrms.raise_error codes).
pub fn status_for_code(code: &str) -> StatusCode {
    match code {
        "AUTH_REQUIRED" => StatusCode::UNAUTHORIZED,
        "ACCESS_DENIED"
        | "PASSWORD_CHANGE_REQUIRED"
        | "REAUTH_REQUIRED"
        | "ACCOUNT_INACTIVE"
        | "SELF_APPROVAL_FORBIDDEN"
        | "VERIFICATION_FAILED" => StatusCode::FORBIDDEN,
        "NOT_FOUND" => StatusCode::NOT_FOUND,
        "STALE_VERSION"
        | "CONFLICT"
        | "REQUEST_LOCKED"
        | "IDEMPOTENCY_CONFLICT"
        | "OPERATION_IN_PROGRESS"
        | "CREDENTIAL_OPERATION_PENDING"
        | "PERIOD_BUSY"
        | "ARCHIVE_STALE"
        | "OVERLAPPING_LEAVE"
        | "LEAVE_ATTENDANCE_CONFLICT" => StatusCode::CONFLICT,
        "FILE_TOO_LARGE" => StatusCode::PAYLOAD_TOO_LARGE,
        "INVALID_FILE_TYPE" => StatusCode::UNSUPPORTED_MEDIA_TYPE,
        "RATE_LIMITED" => StatusCode::TOO_MANY_REQUESTS,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(err: sqlx::Error) -> Self {
        let Some(db) = err.as_database_error() else {
            return match err {
                sqlx::Error::PoolTimedOut | sqlx::Error::Io(_) => {
                    tracing::warn!(error = %err, "database unavailable");
                    ApiError::unavailable("The service is busy. Please try again.")
                }
                sqlx::Error::RowNotFound => ApiError::not_found(),
                other => {
                    tracing::error!(error = %other, "database error");
                    ApiError::internal()
                }
            };
        };
        let sqlstate = db.code().map(|c| c.into_owned()).unwrap_or_default();
        let pg = db.try_downcast_ref::<sqlx::postgres::PgDatabaseError>();

        if sqlstate == "P0001" {
            let code = db.message().to_owned();
            if code.chars().all(|c| c.is_ascii_uppercase() || c == '_') && !code.is_empty() {
                let detail: Value = pg
                    .and_then(|p| p.detail())
                    .and_then(|d| serde_json::from_str(d).ok())
                    .unwrap_or_else(|| json!({}));
                return ApiError {
                    status: status_for_code(&code),
                    message: detail
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or(&code)
                        .to_owned(),
                    field_errors: detail
                        .get("field_errors")
                        .cloned()
                        .filter(Value::is_object)
                        .unwrap_or_else(|| json!({})),
                    retryable: detail
                        .get("retryable")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    request_id: detail
                        .get("request_id")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    code,
                };
            }
        }

        match sqlstate.as_str() {
            // permission denied: the API role cannot call/see this.
            "42501" => ApiError::access_denied(),
            // invalid input syntax / out of range / bad datetime / not null / check
            "22P02" | "22007" | "22008" | "22003" | "22023" | "22001" | "23502" | "23514"
            | "22004" | "2201B" => ApiError::validation("Some values are not valid."),
            "23505" => ApiError::new(StatusCode::CONFLICT, "CONFLICT", "This already exists."),
            "23503" => ApiError::validation("A referenced record does not exist."),
            "40001" | "40P01" | "55P03" => {
                let mut e = ApiError::new(
                    StatusCode::CONFLICT,
                    "CONFLICT",
                    "Someone else changed this at the same time. Please try again.",
                );
                e.retryable = true;
                e
            }
            "57014" => ApiError::unavailable("That took too long. Please try again."),
            _ => {
                tracing::error!(
                    sqlstate,
                    message = db.message(),
                    "unexpected database error"
                );
                ApiError::internal()
            }
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status;
        let mut res = (status, Json(json!({ "error": self }))).into_response();
        if status == StatusCode::TOO_MANY_REQUESTS {
            res.headers_mut().insert(
                axum::http::header::RETRY_AFTER,
                axum::http::HeaderValue::from_static("30"),
            );
        }
        res
    }
}

pub type ApiResult<T> = Result<T, ApiError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_mapping_covers_auth_and_conflicts() {
        assert_eq!(status_for_code("AUTH_REQUIRED"), StatusCode::UNAUTHORIZED);
        assert_eq!(
            status_for_code("PASSWORD_CHANGE_REQUIRED"),
            StatusCode::FORBIDDEN
        );
        assert_eq!(status_for_code("STALE_VERSION"), StatusCode::CONFLICT);
        assert_eq!(
            status_for_code("RATE_LIMITED"),
            StatusCode::TOO_MANY_REQUESTS
        );
        assert_eq!(
            status_for_code("FILE_TOO_LARGE"),
            StatusCode::PAYLOAD_TOO_LARGE
        );
        // Unknown business codes are client errors, never 500.
        assert_eq!(
            status_for_code("INSUFFICIENT_BALANCE"),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            status_for_code("SOMETHING_NEW"),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    #[test]
    fn rate_limited_sets_retry_after() {
        let res = ApiError::rate_limited().into_response();
        assert_eq!(res.status(), StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(res.headers()["retry-after"], "30");
    }

    #[test]
    fn request_id_is_not_overwritten() {
        let mut e = ApiError::internal();
        e.request_id = Some("a".into());
        assert_eq!(
            e.with_request_id(Some("b".into())).request_id.as_deref(),
            Some("a")
        );
        assert_eq!(
            ApiError::internal()
                .with_request_id(Some("b".into()))
                .request_id
                .as_deref(),
            Some("b")
        );
    }
}
