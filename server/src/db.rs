//! Postgres access. Every request runs in its own transaction where the role,
//! JWT-style claims, request id and statement timeout are set with
//! `set_config(..., true)` (transaction-local), so nothing leaks between
//! requests that share a pooled connection.

use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{
    PgPool, Postgres, Transaction,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

use crate::error::ApiResult;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

/// Who the database should believe is calling. Built only by the server after
/// it verified the session cookie (never from client input).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Claims {
    pub sub: Uuid,
    pub session_id: Uuid,
    /// The internal alias (iam.users.email); hrms.resolve_actor compares it.
    pub email: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Caller<'a> {
    /// A signed-in employee (role `authenticated`).
    User(&'a Claims),
    /// The server itself (role `service_role`): internal_* RPCs only.
    Service,
}

pub async fn connect(url: &str, max_connections: u32) -> Result<PgPool, sqlx::Error> {
    let opts: PgConnectOptions = url.parse()?;
    // Supabase's pooler and the free tier work best with few, recycled
    // connections. Statement cache is disabled for transaction-mode poolers.
    let opts = opts
        .statement_cache_capacity(0)
        .application_name("web-hrms");
    PgPoolOptions::new()
        .max_connections(max_connections)
        .min_connections(0)
        .acquire_timeout(Duration::from_secs(10))
        .idle_timeout(Some(Duration::from_secs(300)))
        .max_lifetime(Some(Duration::from_secs(1800)))
        .connect_with(opts)
        .await
}

pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    MIGRATOR.run(pool).await
}

/// Starts a transaction acting as `caller`. `request_id` must be a UUID.
pub async fn begin_as(
    pool: &PgPool,
    caller: Caller<'_>,
    request_id: Uuid,
) -> ApiResult<Transaction<'static, Postgres>> {
    let mut tx = pool.begin().await?;
    let (role, claims) = match caller {
        Caller::User(c) => (
            "authenticated",
            json!({ "sub": c.sub, "role": "authenticated", "session_id": c.session_id, "email": c.email }),
        ),
        Caller::Service => ("service_role", json!({ "role": "service_role" })),
    };
    sqlx::query(
        "select set_config('role', $1, true),
                set_config('request.jwt.claims', $2, true),
                set_config('hrms.request_id', $3, true),
                set_config('statement_timeout', '15s', true)",
    )
    .bind(role)
    .bind(claims.to_string())
    .bind(request_id.to_string())
    .execute(&mut *tx)
    .await?;
    Ok(tx)
}

/// Runs `select <sql>` returning one jsonb value inside a caller transaction.
pub async fn query_json(
    pool: &PgPool,
    caller: Caller<'_>,
    request_id: Uuid,
    sql: &str,
    arg: Value,
) -> ApiResult<Value> {
    let mut tx = begin_as(pool, caller, request_id).await?;
    let v: Option<Value> = sqlx::query_scalar(sql)
        .bind(arg)
        .fetch_one(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(v.unwrap_or(Value::Null))
}

/// Calls a `public.internal_*` function as the server with named arguments.
/// `name` and argument names are compile-time constants in our code.
pub async fn service_call(pool: &PgPool, name: &'static str, args: Value) -> ApiResult<Value> {
    crate::rpc::call_internal(pool, name, args, Uuid::new_v4()).await
}
