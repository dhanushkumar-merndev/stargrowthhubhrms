//! Background jobs. Each tick asks Postgres whether a job is due
//! (`internal_job_claim`), so timing survives restarts and never double-runs.
//! Jobs that need later phases (Web Push outbox, R2 file purge, holiday feed,
//! Google Sheets) are added by those phases.

use std::time::Duration;

use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{db, error::ApiResult};

#[derive(Debug, Clone, Copy)]
pub struct Job {
    pub name: &'static str,
    pub every_secs: u64,
    /// Daily jobs: earliest UTC time (HH:MM:SS) on each date.
    pub not_before_utc: Option<&'static str>,
}

/// Same cadence as the HRMS pg_cron schedule (tick */15, daily 21:17 UTC).
pub const JOBS: &[Job] = &[
    Job {
        name: "maintenance.tick",
        every_secs: 15 * 60,
        not_before_utc: None,
    },
    Job {
        name: "maintenance.daily",
        every_secs: 3600,
        not_before_utc: Some("21:17:00"),
    },
    Job {
        name: "live_events.purge",
        every_secs: 15 * 60,
        not_before_utc: None,
    },
    Job {
        name: "sessions.purge",
        every_secs: 3600,
        not_before_utc: None,
    },
];

async fn claim(pool: &PgPool, job: &Job) -> ApiResult<bool> {
    let mut tx = db::begin_as(pool, db::Caller::Service, Uuid::new_v4()).await?;
    let won: bool = sqlx::query_scalar(
        "select public.internal_job_claim($1, make_interval(secs => $2), $3::time)",
    )
    .bind(job.name)
    .bind(job.every_secs as f64)
    .bind(job.not_before_utc)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(won)
}

async fn execute(pool: &PgPool, name: &str) -> ApiResult<Value> {
    let rid = Uuid::new_v4();
    let sql = match name {
        "maintenance.tick" => "select public.internal_maintenance_tick()",
        "maintenance.daily" => "select public.internal_maintenance_daily()",
        "live_events.purge" => "select to_jsonb(public.internal_purge_live_events())",
        "sessions.purge" => "select to_jsonb(public.internal_purge_expired_sessions())",
        _ => return Ok(json!({ "skipped": "unknown job" })),
    };
    let mut tx = db::begin_as(pool, db::Caller::Service, rid).await?;
    let v: Option<Value> = sqlx::query_scalar(sql).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(v.unwrap_or(Value::Null))
}

async fn done(pool: &PgPool, name: &str, result: &ApiResult<Value>) {
    let (ok, detail, err) = match result {
        Ok(v) => (true, Some(v.clone()), None),
        Err(e) => (false, None, Some(format!("{}: {}", e.code, e.message))),
    };
    let r = async {
        let mut tx = db::begin_as(pool, db::Caller::Service, Uuid::new_v4()).await?;
        sqlx::query("select public.internal_job_done($1, $2, $3, $4)")
            .bind(name)
            .bind(ok)
            .bind(detail)
            .bind(err)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        ApiResult::Ok(())
    }
    .await;
    if let Err(e) = r {
        tracing::warn!(job = name, error = %e.code, "could not record job result");
    }
}

/// Runs every due job once. Returns the names that ran.
pub async fn run_due(pool: &PgPool) -> Vec<&'static str> {
    let mut ran = Vec::new();
    for job in JOBS {
        match claim(pool, job).await {
            Ok(true) => {
                let result = execute(pool, job.name).await;
                match &result {
                    Ok(v) => tracing::info!(job = job.name, detail = %v, "job done"),
                    Err(e) => tracing::warn!(job = job.name, code = %e.code, "job failed"),
                }
                done(pool, job.name, &result).await;
                ran.push(job.name);
            }
            Ok(false) => {}
            Err(e) => tracing::warn!(job = job.name, code = %e.code, "job claim failed"),
        }
    }
    ran
}

/// Checks for due jobs every minute until the process exits.
pub fn spawn(pool: PgPool) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(Duration::from_secs(60));
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            every.tick().await;
            run_due(&pool).await;
        }
    });
}
