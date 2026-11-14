//! Personal calendar feed (RFC 5545), PLAN §7 item 7.
//!
//!   GET /v1/calendar/{token}.ics
//!
//! Calendar apps fetch this without cookies, so the secret 256-bit token in
//! the URL is the only credential. Only its SHA-256 is sent to the database.
//! Unknown, revoked or deactivated links all answer the same plain 404.

use axum::{
    extract::{Path, State},
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use crate::{app::AppState, db};

/// 32 random bytes as unpadded base64url.
pub fn token_ok(t: &str) -> bool {
    t.len() == 43
        && t
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn token_sha256(t: &str) -> String {
    Sha256::digest(t.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// TEXT value escaping (RFC 5545 §3.3.11).
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            ';' => out.push_str("\\;"),
            ',' => out.push_str("\\,"),
            '\n' => out.push_str("\\n"),
            '\r' => {}
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Folds a content line at 75 octets without splitting a UTF-8 character
/// (RFC 5545 §3.1). Each line ends with CRLF.
pub fn fold(line: &str) -> String {
    let mut out = String::with_capacity(line.len() + line.len() / 70 * 3 + 2);
    let mut width = 0;
    for c in line.chars() {
        let n = c.len_utf8();
        if width + n > 75 {
            out.push_str("\r\n ");
            width = 1; // the leading space counts
        }
        out.push(c);
        width += n;
    }
    out.push_str("\r\n");
    out
}

fn date(v: &Value) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(v.as_str()?, "%Y-%m-%d").ok()
}

fn all_day(out: &mut String, uid: &str, day: NaiveDate, summary: &str, stamp: &str, transparent: bool) {
    let next = day + Duration::days(1);
    for l in [
        "BEGIN:VEVENT".to_string(),
        format!("UID:{uid}"),
        format!("DTSTAMP:{stamp}"),
        format!("DTSTART;VALUE=DATE:{}", day.format("%Y%m%d")),
        format!("DTEND;VALUE=DATE:{}", next.format("%Y%m%d")),
        format!("SUMMARY:{}", escape(summary)),
        format!("TRANSP:{}", if transparent { "TRANSPARENT" } else { "OPAQUE" }),
        "END:VEVENT".to_string(),
    ] {
        out.push_str(&fold(&l));
    }
}

fn slot_label(slots: &[&str]) -> &'static str {
    match slots {
        ["AM"] => " (morning)",
        ["PM"] => " (afternoon)",
        _ => "",
    }
}

/// The whole VCALENDAR for one feed.
pub fn build_ics(feed: &Value, now: DateTime<Utc>) -> String {
    let stamp = now.format("%Y%m%dT%H%M%SZ").to_string();
    let org = feed.get("org_name").and_then(Value::as_str).unwrap_or("HRMS");
    let mut out = String::new();
    for l in [
        "BEGIN:VCALENDAR".to_string(),
        "VERSION:2.0".to_string(),
        "PRODID:-//HRMS//Calendar feed//EN".to_string(),
        "CALSCALE:GREGORIAN".to_string(),
        "METHOD:PUBLISH".to_string(),
        format!("X-WR-CALNAME:{}", escape(&format!("{org} · Holidays and leave"))),
        "REFRESH-INTERVAL;VALUE=DURATION:PT6H".to_string(),
        "X-PUBLISHED-TTL:PT6H".to_string(),
    ] {
        out.push_str(&fold(&l));
    }
    let empty = Vec::new();
    for h in feed.get("holidays").and_then(Value::as_array).unwrap_or(&empty) {
        let (Some(id), Some(day)) = (h.get("id").and_then(Value::as_str), h.get("date").and_then(date)) else {
            continue;
        };
        let name = h.get("name").and_then(Value::as_str).unwrap_or("Holiday");
        all_day(&mut out, &format!("holiday-{id}@hrms"), day, name, &stamp, true);
    }
    for l in feed.get("leave").and_then(Value::as_array).unwrap_or(&empty) {
        let (Some(id), Some(day)) = (l.get("request_id").and_then(Value::as_str), l.get("date").and_then(date)) else {
            continue;
        };
        let slots: Vec<&str> = l
            .get("slots")
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let kind = l.get("type").and_then(Value::as_str).unwrap_or("Leave");
        let summary = format!("On leave: {kind}{}", slot_label(&slots));
        let uid = format!("leave-{id}-{}@hrms", day.format("%Y%m%d"));
        all_day(&mut out, &uid, day, &summary, &stamp, false);
    }
    out.push_str("END:VCALENDAR\r\n");
    out
}

fn gone() -> Response {
    (StatusCode::NOT_FOUND, "Not Found").into_response()
}

pub async fn feed(State(state): State<AppState>, Path(file): Path<String>) -> Response {
    let Some(token) = file.strip_suffix(".ics").filter(|t| token_ok(t)) else {
        return gone();
    };
    let Ok(db) = state.db() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Try again later").into_response();
    };
    let data = match db::service_call(
        &db.pool,
        "internal_calendar_feed",
        json!({ "p_token_sha256": token_sha256(token) }),
    )
    .await
    {
        Ok(v) if v.is_object() => v,
        Ok(_) => return gone(),
        Err(e) => return e.into_response(),
    };
    let mut res = build_ics(&data, Utc::now()).into_response();
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/calendar; charset=utf-8"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("inline; filename=\"hrms.ics\""));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=900"));
    res
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_checked_and_hashed() {
        let t = "A".repeat(43);
        assert!(token_ok(&t));
        assert!(token_ok("abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"));
        assert!(!token_ok(&"A".repeat(42)));
        assert!(!token_ok(&"A".repeat(44)));
        assert!(!token_ok("abcdefghijklmnopqrstuvwxyz0123456789+/ABCDE"));
        assert!(!token_ok("../../../../../../../../../etc/passwd/xxxxx"));
        assert_eq!(
            token_sha256("abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn escapes_text() {
        assert_eq!(escape("a,b;c\\d\ne\r\u{7}"), "a\\,b\\;c\\\\d\\ne");
        assert_eq!(escape("Diwali · दीपावली"), "Diwali · दीपावली");
    }

    #[test]
    fn folds_at_75_octets_on_char_boundaries() {
        let short = fold("SUMMARY:x");
        assert_eq!(short, "SUMMARY:x\r\n");
        let long = fold(&format!("SUMMARY:{}", "a".repeat(100)));
        let lines: Vec<&str> = long.trim_end_matches("\r\n").split("\r\n").collect();
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].len(), 75);
        assert!(lines[1].starts_with(' '));
        // Multi-byte text: no line over 75 octets and the text survives unfolding.
        let text = format!("SUMMARY:{}", "दीपावली ".repeat(20));
        let folded = fold(&text);
        for l in folded.trim_end_matches("\r\n").split("\r\n") {
            assert!(l.len() <= 75, "{} octets", l.len());
        }
        assert_eq!(folded.trim_end_matches("\r\n").replace("\r\n ", ""), text);
    }

    #[test]
    fn builds_a_calendar() {
        let feed = json!({
            "org_name": "Acme, Inc",
            "holidays": [
                {"id": "h1", "date": "2026-11-08", "name": "Diwali; Lakshmi Puja"},
                {"id": "bad", "date": "not-a-date", "name": "skip"},
                {"date": "2026-12-25", "name": "no id"}
            ],
            "leave": [
                {"request_id": "r1", "date": "2026-11-20", "slots": ["FULL"], "type": "Casual leave"},
                {"request_id": "r2", "date": "2026-12-31", "slots": ["AM"], "type": null}
            ]
        });
        let now = DateTime::parse_from_rfc3339("2026-11-14T06:00:00Z").unwrap().with_timezone(&Utc);
        let ics = build_ics(&feed, now);
        assert!(ics.starts_with("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"));
        assert!(ics.ends_with("END:VCALENDAR\r\n"));
        assert!(!ics.replace("\r\n", "").contains('\n'), "bare LF");
        assert_eq!(ics.matches("BEGIN:VEVENT").count(), 3);
        assert!(ics.contains("X-WR-CALNAME:Acme\\, Inc · Holidays and leave\r\n"));
        assert!(ics.contains("UID:holiday-h1@hrms\r\nDTSTAMP:20261114T060000Z\r\nDTSTART;VALUE=DATE:20261108\r\nDTEND;VALUE=DATE:20261109\r\nSUMMARY:Diwali\\; Lakshmi Puja\r\nTRANSP:TRANSPARENT"));
        assert!(ics.contains("UID:leave-r1-20261120@hrms"));
        assert!(ics.contains("SUMMARY:On leave: Casual leave\r\nTRANSP:OPAQUE"));
        // Year boundary and half day, unknown type.
        assert!(ics.contains("DTSTART;VALUE=DATE:20261231\r\nDTEND;VALUE=DATE:20270101\r\nSUMMARY:On leave: Leave (morning)"));
    }

    #[test]
    fn empty_feed_is_still_valid() {
        let ics = build_ics(&json!({}), Utc::now());
        assert!(ics.contains("X-WR-CALNAME:HRMS · Holidays and leave"));
        assert!(!ics.contains("VEVENT"));
        assert_eq!(slot_label(&["AM", "PM"]), "");
        assert_eq!(slot_label(&["PM"]), " (afternoon)");
    }
}
