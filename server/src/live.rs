//! Live updates over Server-Sent Events (replaces Supabase Realtime).
//!
//! Producers call `hrms.publish_live` (a row in hrms.live_events plus
//! `pg_notify('hrms_live')`, delivered on COMMIT). One hub task per process
//! LISTENs (with a polling fallback for poolers that cannot LISTEN), reads new
//! rows in id order and broadcasts them. Each `/v1/live` stream forwards only
//! events whose audience matches the viewer. Payloads carry ids only: the
//! browser re-reads through the normal RPCs, which decide access.
//!
//! Streams end after `MAX_STREAM` so a revoked session or changed role never
//! keeps listening; EventSource reconnects with Last-Event-ID and replays.

use std::{convert::Infallible, sync::Arc, time::Duration};

use axum::{
    extract::{Query, State},
    http::{HeaderMap, HeaderValue, header},
    response::{
        IntoResponse, Response,
        sse::{Event, KeepAlive, Sse},
    },
};
use futures_util::stream::{self, Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::{PgPool, postgres::PgListener};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::{app::AppState, auth::session::Session, error::ApiResult, rpc};

pub const CHANNEL: &str = "hrms_live";
pub const MAX_STREAM: Duration = Duration::from_secs(10 * 60);
pub const REPLAY_LIMIT: i64 = 200;
const BATCH: i64 = 500;

#[derive(Debug, Clone, PartialEq, sqlx::FromRow)]
pub struct LiveEvent {
    pub id: i64,
    pub org_id: Uuid,
    pub audience: String,
    pub employee_id: Option<Uuid>,
    pub kind: String,
    pub payload: Value,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Viewer {
    pub org: Uuid,
    pub employee: Uuid,
    pub hr_admin: bool,
}

impl Viewer {
    pub fn sees(&self, e: &LiveEvent) -> bool {
        e.org_id == self.org
            && match e.audience.as_str() {
                "org" => true,
                "hr_admin" => self.hr_admin,
                "employee" => e.employee_id == Some(self.employee),
                _ => false,
            }
    }

    /// From get_session_context (envelope or bare).
    pub fn from_context(v: &Value) -> Option<Self> {
        let d = if v["data"].is_object() { &v["data"] } else { v };
        let id = |x: &Value| x.as_str().and_then(|s| s.parse::<Uuid>().ok());
        let roles: Vec<&str> = d["roles"]
            .as_array()
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        Some(Self {
            org: id(&d["org"]["id"])?,
            employee: id(&d["employee"]["id"])?,
            hr_admin: roles.iter().any(|r| *r == "hr" || *r == "admin")
                || matches!(d["role"].as_str(), Some("hr" | "admin")),
        })
    }
}

#[derive(Clone)]
pub struct Hub {
    tx: broadcast::Sender<Arc<LiveEvent>>,
}

impl Hub {
    /// Starts the hub task on the current runtime.
    pub fn spawn(pool: PgPool) -> Self {
        let (tx, _) = broadcast::channel(1024);
        let hub = Self { tx: tx.clone() };
        tokio::spawn(run(pool, tx));
        hub
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Arc<LiveEvent>> {
        self.tx.subscribe()
    }
}

const SELECT: &str =
    "select id, org_id, audience, employee_id, kind, payload from hrms.live_events";

async fn run(pool: PgPool, tx: broadcast::Sender<Arc<LiveEvent>>) {
    let mut last: i64 = loop {
        match sqlx::query_scalar::<_, Option<i64>>("select max(id) from hrms.live_events")
            .fetch_one(&pool)
            .await
        {
            Ok(v) => break v.unwrap_or(0),
            Err(e) => {
                tracing::warn!(error = %e, "live hub: cannot read the cursor yet");
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }
    };
    let mut listener = listen(&pool).await;
    loop {
        match listener.as_mut() {
            Some(l) => {
                tokio::select! {
                    r = l.recv() => if let Err(e) = r {
                        tracing::warn!(error = %e, "live hub: LISTEN lost, polling");
                        listener = None;
                    },
                    // Safety net for a missed notification.
                    _ = tokio::time::sleep(Duration::from_secs(15)) => {}
                }
            }
            None => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                listener = listen(&pool).await;
            }
        }
        match fetch_after(&pool, last, BATCH).await {
            Ok(rows) => {
                for row in rows {
                    last = last.max(row.id);
                    let _ = tx.send(Arc::new(row)); // no listeners is fine
                }
            }
            Err(e) => tracing::warn!(error = %e, "live hub: read failed"),
        }
    }
}

async fn listen(pool: &PgPool) -> Option<PgListener> {
    let mut l = PgListener::connect_with(pool).await.ok()?;
    l.listen(CHANNEL).await.ok()?;
    Some(l)
}

pub async fn fetch_after(
    pool: &PgPool,
    after: i64,
    limit: i64,
) -> Result<Vec<LiveEvent>, sqlx::Error> {
    sqlx::query_as::<_, LiveEvent>(&format!("{SELECT} where id > $1 order by id limit $2"))
        .bind(after)
        .bind(limit)
        .fetch_all(pool)
        .await
}

async fn replay(pool: &PgPool, org: Uuid, after: i64) -> Result<Vec<LiveEvent>, sqlx::Error> {
    sqlx::query_as::<_, LiveEvent>(&format!(
        "{SELECT} where org_id = $1 and id > $2 order by id limit $3"
    ))
    .bind(org)
    .bind(after)
    .bind(REPLAY_LIMIT)
    .fetch_all(pool)
    .await
}

pub fn to_sse(e: &LiveEvent) -> Event {
    Event::default()
        .id(e.id.to_string())
        .event(e.kind.clone())
        .data(json!({ "id": e.id, "kind": e.kind, "payload": e.payload }).to_string())
}

#[derive(Deserialize)]
pub struct LiveQuery {
    /// For clients that cannot send Last-Event-ID (first connect after reload).
    pub after: Option<i64>,
}

fn last_event_id(headers: &HeaderMap, q: &LiveQuery) -> Option<i64> {
    headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.trim().parse::<i64>().ok())
        .or(q.after)
        .filter(|v| *v >= 0)
}

/// GET /v1/live
pub async fn live(
    State(state): State<AppState>,
    session: Session,
    headers: HeaderMap,
    Query(q): Query<LiveQuery>,
) -> ApiResult<Response> {
    let db = state.db()?;
    let ctx = rpc::call_public(
        &db.pool,
        &db.catalog,
        &session.claims,
        "get_session_context",
        Value::Null,
        session.request_id,
    )
    .await?;
    let viewer = Viewer::from_context(&ctx).ok_or_else(crate::error::ApiError::access_denied)?;
    let hub = state.live_hub().await?;
    // Subscribe before replaying so nothing falls between the two.
    let rx = hub.subscribe();
    let backlog = match last_event_id(&headers, &q) {
        Some(after) => replay(&db.pool, viewer.org, after).await?,
        None => Vec::new(),
    };
    let stream = event_stream(viewer, backlog, rx, MAX_STREAM);
    let mut res = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(20)))
        .into_response();
    let h = res.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    Ok(res)
}

/// Backlog first (filtered), then live events newer than the backlog, until
/// `max` elapses or the receiver lags (the client reconnects and replays).
pub fn viewer_stream(
    viewer: Viewer,
    backlog: Vec<LiveEvent>,
    rx: broadcast::Receiver<Arc<LiveEvent>>,
    max: Duration,
) -> impl Stream<Item = LiveEvent> + Send + 'static {
    let seen = backlog.iter().map(|e| e.id).max().unwrap_or(i64::MIN);
    let first: Vec<LiveEvent> = backlog.into_iter().filter(|e| viewer.sees(e)).collect();
    let deadline = tokio::time::Instant::now() + max;
    let live = stream::unfold((rx, seen), move |(mut rx, mut seen)| async move {
        loop {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Ok(e)) => {
                    if e.id <= seen || !viewer.sees(&e) {
                        continue;
                    }
                    seen = e.id;
                    return Some(((*e).clone(), (rx, seen)));
                }
                // Lagged, closed or past the deadline: end; EventSource resumes.
                _ => return None,
            }
        }
    });
    stream::iter(first).chain(live)
}

pub fn event_stream(
    viewer: Viewer,
    backlog: Vec<LiveEvent>,
    rx: broadcast::Receiver<Arc<LiveEvent>>,
    max: Duration,
) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
    viewer_stream(viewer, backlog, rx, max).map(|e| Ok(to_sse(&e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(id: i64, org: Uuid, audience: &str, emp: Option<Uuid>) -> LiveEvent {
        LiveEvent {
            id,
            org_id: org,
            audience: audience.into(),
            employee_id: emp,
            kind: "device.punch".into(),
            payload: json!({"id": id}),
        }
    }

    #[test]
    fn audience_rules() {
        let (org, other, me, you) = (
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
            Uuid::new_v4(),
        );
        let staff = Viewer {
            org,
            employee: me,
            hr_admin: false,
        };
        let hr = Viewer {
            org,
            employee: you,
            hr_admin: true,
        };
        assert!(staff.sees(&ev(1, org, "org", None)));
        assert!(!staff.sees(&ev(1, org, "hr_admin", None)));
        assert!(hr.sees(&ev(1, org, "hr_admin", None)));
        assert!(staff.sees(&ev(1, org, "employee", Some(me))));
        assert!(
            !hr.sees(&ev(1, org, "employee", Some(me))),
            "HR does not get my personal events"
        );
        assert!(
            !hr.sees(&ev(1, other, "hr_admin", None)),
            "never another organisation"
        );
        assert!(!hr.sees(&ev(1, org, "everyone", None)));
    }

    #[test]
    fn viewer_from_context() {
        let (org, emp) = (Uuid::new_v4(), Uuid::new_v4());
        let ctx = json!({"ok": true, "data": {"org": {"id": org}, "employee": {"id": emp}, "role": "hr", "roles": ["employee", "hr"]}});
        assert_eq!(
            Viewer::from_context(&ctx),
            Some(Viewer {
                org,
                employee: emp,
                hr_admin: true
            })
        );
        let bare = json!({"org": {"id": org}, "employee": {"id": emp}, "role": "employee", "roles": ["employee"]});
        assert!(!Viewer::from_context(&bare).unwrap().hr_admin);
        assert_eq!(Viewer::from_context(&json!({"data": {"org": {}}})), None);
    }

    #[test]
    fn last_event_id_sources() {
        let mut h = HeaderMap::new();
        assert_eq!(last_event_id(&h, &LiveQuery { after: Some(4) }), Some(4));
        h.insert("last-event-id", "17".parse().unwrap());
        assert_eq!(
            last_event_id(&h, &LiveQuery { after: Some(4) }),
            Some(17),
            "header wins"
        );
        h.insert("last-event-id", "junk".parse().unwrap());
        assert_eq!(last_event_id(&h, &LiveQuery { after: None }), None);
        assert_eq!(
            last_event_id(&HeaderMap::new(), &LiveQuery { after: Some(-1) }),
            None
        );
    }

    async fn ids(s: impl Stream<Item = LiveEvent>) -> Vec<i64> {
        s.map(|e| e.id).collect().await
    }

    #[tokio::test]
    async fn stream_replays_filters_dedupes_and_ends() {
        let (org, me) = (Uuid::new_v4(), Uuid::new_v4());
        let staff = Viewer {
            org,
            employee: me,
            hr_admin: false,
        };
        let (tx, rx) = broadcast::channel(16);
        let backlog = vec![ev(5, org, "org", None), ev(6, org, "hr_admin", None)];
        let s = viewer_stream(staff, backlog, rx, Duration::from_millis(150));
        tx.send(Arc::new(ev(6, org, "org", None))).unwrap(); // covered by the backlog
        tx.send(Arc::new(ev(7, org, "employee", Some(me)))).unwrap();
        tx.send(Arc::new(ev(7, org, "employee", Some(me)))).unwrap(); // a duplicate delivery
        tx.send(Arc::new(ev(8, org, "employee", Some(Uuid::new_v4()))))
            .unwrap();
        tx.send(Arc::new(ev(9, Uuid::new_v4(), "org", None)))
            .unwrap();
        tx.send(Arc::new(ev(10, org, "org", None))).unwrap();
        assert_eq!(ids(s).await, vec![5, 7, 10], "ends at the deadline");
    }

    #[tokio::test]
    async fn a_lagging_stream_ends_so_the_client_replays() {
        let org = Uuid::new_v4();
        let hr = Viewer {
            org,
            employee: Uuid::new_v4(),
            hr_admin: true,
        };
        let (tx, rx) = broadcast::channel(2);
        for i in 1..=5 {
            tx.send(Arc::new(ev(i, org, "hr_admin", None))).unwrap();
        }
        assert!(
            ids(viewer_stream(hr, vec![], rx, Duration::from_secs(5)))
                .await
                .is_empty()
        );
    }

    #[test]
    fn sse_event_carries_the_row_id() {
        let e = to_sse(&ev(42, Uuid::new_v4(), "org", None));
        assert!(format!("{e:?}").contains("42"));
    }
}
