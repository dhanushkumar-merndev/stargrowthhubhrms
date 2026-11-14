//! One-time creation of the organisation and its first Admin login.
//! Idempotent: re-running with the same org/admin code changes nothing once
//! the Admin is linked (and never resets their password).

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{auth::password, error::ApiError};

#[derive(Debug, Clone)]
pub struct Input {
    pub org_code: String,
    pub org_name: String,
    pub timezone: String,
    pub admin_code: String,
    pub admin_name: String,
    pub admin_password: String,
    pub alias_domain: String,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("database: {0}")]
    Db(#[from] sqlx::Error),
}

pub async fn run(pool: &PgPool, input: &Input) -> Result<Value, Error> {
    password::validate_new(&input.admin_password, Some(&input.admin_code))
        .map_err(|e: ApiError| Error::Invalid(format!("ADMIN_PASSWORD: {}", e.message)))?;
    if input.org_code.trim().is_empty() {
        return Err(Error::Invalid("ORG_CODE is required".into()));
    }

    let mut tx = pool.begin().await?;
    let org: Value = sqlx::query_scalar("select hrms.bootstrap_org_admin($1, $2, $3, $4, $5, $6)")
        .bind(&input.org_code)
        .bind(&input.org_name)
        .bind(&input.timezone)
        .bind(&input.admin_code)
        .bind(&input.admin_name)
        .bind(&input.alias_domain)
        .fetch_one(&mut *tx)
        .await?;
    if org["linked"] == json!(true) {
        tx.commit().await?;
        return Ok(json!({ "employee_id": org["employee_id"], "already": true }));
    }
    let employee_id: Uuid = org["employee_id"]
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| Error::Invalid("bootstrap returned no employee".into()))?;
    let alias = org["auth_alias"].as_str().unwrap_or_default().to_owned();

    let phc = password::hash(&input.admin_password);
    let existing: Option<Uuid> =
        sqlx::query_scalar("select user_id from iam.password_for_alias($1)")
            .bind(&alias)
            .fetch_optional(&mut *tx)
            .await?;
    let user_id = match existing {
        Some(id) => {
            sqlx::query("select iam.set_password($1, $2)")
                .bind(id)
                .bind(&phc)
                .execute(&mut *tx)
                .await?;
            id
        }
        None => {
            sqlx::query_scalar("select iam.create_user($1, $2)")
                .bind(&alias)
                .bind(&phc)
                .fetch_one(&mut *tx)
                .await?
        }
    };
    let link: Value = sqlx::query_scalar("select hrms.bootstrap_link($1, $2)")
        .bind(employee_id)
        .bind(user_id)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(
        json!({ "employee_id": employee_id, "employee_code": link["employee_code"], "already": false }),
    )
}
