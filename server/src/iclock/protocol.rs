//! eSSL / ZKTeco "iclock" (ADMS push) protocol: parsing and replies.
//! A faithful port of fingertipssl `src/lib/iclock/protocol.ts`.
//!
//! Firmware varies widely: everything here is tolerant on input and strict on
//! what it hands to the database. Biometric data is never parsed or kept.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE},
};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Endpoint {
    Cdata,
    Getrequest,
    Devicecmd,
    Fdata,
    Ping,
    Registry,
    Push,
    Querydata,
}

impl Endpoint {
    pub fn as_str(self) -> &'static str {
        match self {
            Endpoint::Cdata => "cdata",
            Endpoint::Getrequest => "getrequest",
            Endpoint::Devicecmd => "devicecmd",
            Endpoint::Fdata => "fdata",
            Endpoint::Ping => "ping",
            Endpoint::Registry => "registry",
            Endpoint::Push => "push",
            Endpoint::Querydata => "querydata",
        }
    }
}

/// `cdata.aspx` -> Cdata. Unknown names -> None.
pub fn normalize_endpoint(segment: &str) -> Option<Endpoint> {
    let lower = segment.to_ascii_lowercase();
    let name = lower.strip_suffix(".aspx").unwrap_or(&lower);
    Some(match name {
        "cdata" => Endpoint::Cdata,
        "getrequest" => Endpoint::Getrequest,
        "devicecmd" => Endpoint::Devicecmd,
        "fdata" => Endpoint::Fdata,
        "ping" => Endpoint::Ping,
        "registry" => Endpoint::Registry,
        "push" => Endpoint::Push,
        "querydata" => Endpoint::Querydata,
        _ => return None,
    })
}

/// Tables that carry biometric data: acknowledged, never read or stored.
pub const BIOMETRIC_TABLES: [&str; 6] = [
    "BIODATA",
    "FINGERTMP",
    "FACE",
    "FVEIN",
    "BIOPHOTO",
    "USERPIC",
];

pub const MAX_ATTLOG_LINES: usize = 5000;
pub const MAX_PHOTO_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_COMMAND_RESULTS: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AttlogRecord {
    pub line: usize,
    pub pin: String,
    /// "YYYY-MM-DD HH:MM:SS", device-local wall time.
    pub device_time: String,
    /// Claimed in/out: untrusted.
    pub status: Option<String>,
    /// 1 fingerprint, 15 face, 0 password, ...
    pub verify: Option<String>,
    pub work_code: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MalformedLine {
    pub line: usize,
    pub error: &'static str,
    pub raw: String,
}

fn clean_line(raw: &str) -> String {
    raw.replace('\0', "").trim().to_owned()
}

fn head(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

pub fn is_pin(s: &str) -> bool {
    (1..=24).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// `YYYY-MM-DD HH:MM:SS` (shape only; the database validates the value).
pub fn is_device_time(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 19
        && b.iter().enumerate().all(|(i, c)| match i {
            4 | 7 => *c == b'-',
            10 => *c == b' ',
            13 | 16 => *c == b':',
            _ => c.is_ascii_digit(),
        })
}

fn small_number(s: Option<&str>) -> Option<String> {
    s.filter(|v| (1..=3).contains(&v.len()) && v.bytes().all(|b| b.is_ascii_digit()))
        .map(str::to_owned)
}

/// ATTLOG body: `PIN \t YYYY-MM-DD HH:MM:SS \t Status \t Verify \t WorkCode [...]`,
/// with a space-separated fallback. Lines over the cap are reported as
/// malformed so they are still acknowledged-and-logged, never silently lost.
pub fn parse_attlog(body: &str) -> (Vec<AttlogRecord>, Vec<MalformedLine>) {
    let mut records = Vec::new();
    let mut malformed = Vec::new();
    let mut n = 0usize;
    for raw_line in body.split('\n') {
        let raw = clean_line(raw_line);
        if raw.is_empty() {
            continue;
        }
        n += 1;
        let bad = |error| MalformedLine {
            line: n,
            error,
            raw: head(&raw, 200),
        };
        if n > MAX_ATTLOG_LINES {
            malformed.push(bad("batch_too_large"));
            continue;
        }
        let fields: Vec<String> = if raw.contains('\t') {
            raw.split('\t').map(|f| f.trim().to_owned()).collect()
        } else {
            loose_fields(&raw)
        };
        let get = |i: usize| fields.get(i).map(String::as_str).filter(|s| !s.is_empty());
        let (Some(pin), Some(time)) = (get(0), get(1)) else {
            malformed.push(bad("too_few_fields"));
            continue;
        };
        if !is_pin(pin) {
            malformed.push(bad("bad_pin"));
            continue;
        }
        if !is_device_time(time) {
            malformed.push(bad("bad_time"));
            continue;
        }
        records.push(AttlogRecord {
            line: n,
            pin: pin.to_owned(),
            device_time: time.to_owned(),
            status: small_number(get(2)),
            verify: small_number(get(3)),
            work_code: get(4).filter(|w| w.len() <= 24).map(str::to_owned),
        });
    }
    (records, malformed)
}

/// `PIN  YYYY-MM-DD HH:MM:SS  [status] [verify] [workcode]` separated by spaces.
fn loose_fields(raw: &str) -> Vec<String> {
    let parts: Vec<&str> = raw.split_whitespace().collect();
    if parts.len() < 3 {
        return Vec::new();
    }
    let time = format!("{} {}", parts[1], parts[2]);
    if !is_device_time(&time) {
        return Vec::new();
    }
    let mut out = vec![parts[0].to_owned(), time];
    out.extend(parts.iter().skip(3).take(3).map(|s| (*s).to_owned()));
    out
}

/// Non-empty lines (to ACK tables we discard).
pub fn count_lines(body: &str) -> usize {
    body.split('\n')
        .filter(|l| !clean_line(l).is_empty())
        .count()
}

// ---------------------------------------------------------------- user roster

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DeviceUser {
    pub pin: String,
    pub name: Option<String>,
    /// 0 = normal user, anything else = machine admin.
    pub privilege: Option<String>,
}

/// Machine user list from OPERLOG (`USER PIN=..`) or USERINFO (`PIN=..`).
/// Only pin, name and privilege survive: passwords, cards, fingerprint and
/// face lines are dropped here.
pub fn parse_user_records(table: &str, body: &str) -> Vec<DeviceUser> {
    let mut out = Vec::new();
    for raw_line in body.split('\n') {
        let mut line = clean_line(raw_line);
        if line.is_empty() {
            continue;
        }
        if table == "OPERLOG" {
            let upper = line.to_ascii_uppercase();
            if !(upper.starts_with("USER ") || upper.starts_with("USER\t")) {
                continue; // FP / FACE / OPLOG / BIOPHOTO are never read
            }
            line = line[5..].trim_start().to_owned();
        } else if !line.to_ascii_uppercase().starts_with("PIN=") {
            continue;
        }
        let mut fields: HashMap<String, String> = HashMap::new();
        for part in line.split('\t') {
            if let Some((k, v)) = part.split_once('=')
                && !k.trim().is_empty()
            {
                fields.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
            }
        }
        let pin = fields.get("pin").cloned().unwrap_or_default();
        if !is_pin(&pin) {
            continue;
        }
        let name: String = fields
            .get("name")
            .map(|n| n.chars().filter(|c| !c.is_control()).take(80).collect())
            .unwrap_or_default();
        let pri = fields
            .get("pri")
            .or_else(|| fields.get("privilege"))
            .map(String::as_str);
        out.push(DeviceUser {
            pin,
            name: (!name.is_empty()).then_some(name),
            privilege: small_number(pri),
        });
        if out.len() >= MAX_ATTLOG_LINES {
            break;
        }
    }
    out
}

// ---------------------------------------------------------------- photos

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PhotoUpload {
    pub pin: String,
    pub device_time: String,
    pub jpeg: Vec<u8>,
}

/// "20261111100203-7.jpg" -> ("7", "2026-11-11 10:02:03")
pub fn parse_photo_filename(name: &str) -> Option<(String, String)> {
    let name = name.trim();
    let lower = name.to_ascii_lowercase();
    let stem_len = if lower.ends_with(".jpeg") {
        name.len() - 5
    } else if lower.ends_with(".jpg") {
        name.len() - 4
    } else {
        return None;
    };
    let stem = &name[..stem_len];
    let (stamp_part, pin) = stem.rsplit_once('-')?;
    if !is_pin(pin) || stamp_part.len() < 14 {
        return None;
    }
    let ts = &stamp_part[stamp_part.len() - 14..];
    if !ts.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    Some((
        pin.to_owned(),
        format!(
            "{}-{}-{} {}:{}:{}",
            &ts[0..4],
            &ts[4..6],
            &ts[6..8],
            &ts[8..10],
            &ts[10..12],
            &ts[12..14]
        ),
    ))
}

fn index_of_jpeg(b: &[u8]) -> Option<usize> {
    b.windows(3).position(|w| w == [0xff, 0xd8, 0xff])
}

pub fn is_jpeg(b: &[u8]) -> bool {
    b.len() > 4 && b[0] == 0xff && b[1] == 0xd8 && b[2] == 0xff
}

fn latin1(b: &[u8]) -> String {
    b.iter().map(|&c| c as char).collect()
}

fn header_fields(text: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for part in text.split(['\r', '\n', '&']) {
        if let Some((k, v)) = part.split_once('=')
            && !k.trim().is_empty()
        {
            out.insert(k.trim().to_ascii_lowercase(), v.trim().to_owned());
        }
    }
    out
}

fn decode_base64(value: &str) -> Option<Vec<u8>> {
    let v = value.trim();
    let v = v
        .strip_prefix("data:image/jpeg;base64,")
        .or_else(|| v.strip_prefix("data:image/jpg;base64,"))
        .unwrap_or(v);
    let clean: String = v.chars().filter(|c| !c.is_whitespace()).collect();
    if clean.len() < 8
        || !clean
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"+/=_-".contains(&b))
    {
        return None;
    }
    let std = clean.replace('-', "+").replace('_', "/");
    STANDARD
        .decode(&std)
        .or_else(|_| URL_SAFE.decode(&clean))
        .ok()
}

/// Pin + time from `PIN=<time>-<pin>.jpg`, `filename=`, or `pin=` + `time=`.
pub fn photo_identity(fields: &HashMap<String, String>) -> Option<(String, String)> {
    for key in ["pin", "filename", "file", "name"] {
        if let Some(v) = fields.get(key)
            && let Some(id) = parse_photo_filename(v)
        {
            return Some(id);
        }
    }
    let pin = fields.get("pin")?;
    let time = fields.get("time").or_else(|| fields.get("datetime"))?;
    (is_pin(pin) && is_device_time(time)).then(|| (pin.clone(), time.clone()))
}

pub type PhotoParse = Result<PhotoUpload, &'static str>;

/// Raw ATTPHOTO body: header + NUL + JPEG, header + JPEG, or base64 JPEG.
pub fn parse_photo_body(body: &[u8]) -> PhotoParse {
    if body.is_empty() {
        return Err("empty_body");
    }
    let jpeg_at = index_of_jpeg(body);
    let nul_at = body.iter().position(|&b| b == 0);
    let header = match jpeg_at {
        Some(j) => latin1(&body[..j.min(4096)]),
        None => latin1(&body[..nul_at.unwrap_or(body.len())]),
    };
    let fields = header_fields(&header.replace('\0', "\n"));
    let identity = photo_identity(&fields).ok_or("no_pin_or_time")?;
    let jpeg = match jpeg_at {
        Some(j) => Some(body[j..].to_vec()),
        None => fields
            .get("photo")
            .or_else(|| fields.get("content"))
            .or_else(|| fields.get("data"))
            .cloned()
            .or_else(|| nul_at.map(|n| latin1(&body[n + 1..])))
            .and_then(|b| decode_base64(&b)),
    };
    finish_photo(identity, jpeg)
}

pub struct FilePart {
    pub name: String,
    pub bytes: Vec<u8>,
}

/// Multipart `fdata` upload, already split into text fields and one file.
pub fn parse_photo_multipart(
    text_fields: &HashMap<String, String>,
    file: Option<FilePart>,
) -> PhotoParse {
    let mut fields = text_fields.clone();
    if let Some(f) = &file
        && !f.name.is_empty()
    {
        fields
            .entry("filename".into())
            .or_insert_with(|| f.name.clone());
    }
    let identity = photo_identity(&fields).ok_or("no_pin_or_time")?;
    let mut jpeg = file.map(|f| f.bytes);
    if let Some(b) = &jpeg
        && !is_jpeg(b)
    {
        jpeg = match index_of_jpeg(b) {
            Some(at) => Some(b[at..].to_vec()),
            None => decode_base64(&latin1(b)),
        };
    }
    if jpeg.is_none() {
        jpeg = fields
            .get("photo")
            .or_else(|| fields.get("content"))
            .or_else(|| fields.get("data"))
            .and_then(|v| decode_base64(v));
    }
    finish_photo(identity, jpeg)
}

fn finish_photo((pin, device_time): (String, String), jpeg: Option<Vec<u8>>) -> PhotoParse {
    let jpeg = jpeg.filter(|j| is_jpeg(j)).ok_or("not_jpeg")?;
    if jpeg.len() > MAX_PHOTO_BYTES {
        return Err("photo_too_large");
    }
    Ok(PhotoUpload {
        pin,
        device_time,
        jpeg,
    })
}

/// Minimal multipart/form-data splitter (text fields + the first file part).
pub fn split_multipart(
    content_type: &str,
    body: &[u8],
) -> Option<(HashMap<String, String>, Option<FilePart>)> {
    let boundary = content_type
        .split(';')
        .filter_map(|p| p.trim().strip_prefix("boundary="))
        .next()?
        .trim_matches('"');
    if boundary.is_empty() || boundary.len() > 200 {
        return None;
    }
    let delim = format!("--{boundary}").into_bytes();
    let mut fields = HashMap::new();
    let mut file = None;
    let mut rest = body;
    let start = find(rest, &delim)?;
    rest = &rest[start + delim.len()..];
    loop {
        if rest.starts_with(b"--") {
            break;
        }
        rest = rest
            .strip_prefix(b"\r\n")
            .or_else(|| rest.strip_prefix(b"\n"))
            .unwrap_or(rest);
        let next = find(rest, &delim)?;
        let mut part = &rest[..next];
        part = part
            .strip_suffix(b"\r\n")
            .or_else(|| part.strip_suffix(b"\n"))
            .unwrap_or(part);
        let (hdr_end, sep) = find(part, b"\r\n\r\n")
            .map(|i| (i, 4))
            .or_else(|| find(part, b"\n\n").map(|i| (i, 2)))?;
        let headers = latin1(&part[..hdr_end]);
        let content = &part[hdr_end + sep..];
        let disp = headers
            .lines()
            .find(|l| l.to_ascii_lowercase().starts_with("content-disposition"))
            .unwrap_or("");
        let param = |key: &str| {
            disp.split(';')
                .filter_map(|p| p.trim().strip_prefix(&format!("{key}=")))
                .next()
                .map(|v| v.trim_matches('"').to_owned())
        };
        let name = param("name").unwrap_or_default().to_ascii_lowercase();
        match param("filename") {
            Some(filename) if file.is_none() => {
                file = Some(FilePart {
                    name: filename,
                    bytes: content.to_vec(),
                })
            }
            Some(_) => {}
            None if !name.is_empty() => {
                fields.insert(name, head(&latin1(content), 4 * 1024 * 1024));
            }
            None => {}
        }
        rest = &rest[next + delim.len()..];
    }
    Some((fields, file))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

// ---------------------------------------------------------------- replies

#[derive(Debug, Clone, Copy, Default)]
pub struct Cursors {
    pub attlog: i64,
    pub photo: i64,
    pub oplog: i64,
}

/// Handshake reply. Requests attendance logs, punch photos and user records
/// (PIN + name roster); never fingerprint, face or user-photo data. Newer
/// firmware (`pushver`) gets named TransFlags; older gets the bit string
/// 1 AttLog 2 OpLog 3 AttPhoto 4 EnrollFP 5 EnrollUser 6 FPImag 7 ChgUser
/// 8 ChgFP 9 FACE 10 UserPic = 1110101000.
pub fn build_options(serial: &str, c: Cursors, pushver: Option<&str>) -> String {
    let flags = if pushver.is_some() {
        "TransFlag=TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser"
    } else {
        "TransFlag=1110101000"
    };
    [
        format!("GET OPTION FROM: {serial}"),
        format!("Stamp={}", c.attlog),
        format!("ATTLOGStamp={}", c.attlog),
        format!("OPERLOGStamp={}", c.oplog),
        format!("ATTPHOTOStamp={}", c.photo),
        "ErrorDelay=30".into(),
        "Delay=10".into(),
        "TransTimes=00:00;14:05".into(),
        "TransInterval=1".into(),
        flags.into(),
        "Realtime=1".into(),
        "Encrypt=0".into(),
    ]
    .join("\n")
        + "\n"
}

pub fn ack_lines(n: usize) -> String {
    format!("OK: {n}")
}

/// Firmware from a getrequest `INFO=` ("Ver 8.0.4.2-...,users,fps,...").
pub fn firmware_from_info(info: Option<&str>) -> Option<String> {
    let first = info?.split(',').next()?.trim();
    (!first.is_empty()).then(|| head(first, 120))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct CommandResult {
    pub id: i64,
    #[serde(rename = "return")]
    pub return_code: i64,
}

/// devicecmd body: `ID=12&Return=0&CMD=DATA` per line; junk ignored.
pub fn parse_command_results(body: &str) -> Vec<CommandResult> {
    let mut out = Vec::new();
    for raw in body.split('\n') {
        let line = clean_line(raw);
        if line.is_empty() {
            continue;
        }
        let params: HashMap<String, String> = line
            .split('&')
            .filter_map(|p| p.split_once('='))
            .map(|(k, v)| (k.to_owned(), v.to_owned()))
            .collect();
        let id = params.get("ID").or_else(|| params.get("id"));
        let ret = params.get("Return").or_else(|| params.get("return"));
        let (Some(id), Some(ret)) = (id, ret) else {
            continue;
        };
        let id_ok = (1..=18).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit());
        let r = ret.strip_prefix('-').unwrap_or(ret);
        let ret_ok = (1..=9).contains(&r.len()) && r.bytes().all(|b| b.is_ascii_digit());
        if !id_ok || !ret_ok {
            continue;
        }
        out.push(CommandResult {
            id: id.parse().unwrap_or(0),
            return_code: ret.parse().unwrap_or(0),
        });
        if out.len() >= MAX_COMMAND_RESULTS {
            break;
        }
    }
    out
}

/// getrequest reply: queued command lines, or "OK" when idle.
pub fn command_reply(lines: &[String]) -> String {
    if lines.is_empty() {
        "OK".into()
    } else {
        lines.join("\n") + "\n"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JPEG: [u8; 12] = [
        0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9,
    ];

    #[test]
    fn endpoints() {
        assert_eq!(normalize_endpoint("cdata"), Some(Endpoint::Cdata));
        assert_eq!(normalize_endpoint("CDATA.aspx"), Some(Endpoint::Cdata));
        assert_eq!(
            normalize_endpoint("getrequest.aspx"),
            Some(Endpoint::Getrequest)
        );
        assert_eq!(normalize_endpoint("admin"), None);
        assert_eq!(normalize_endpoint("cdata.php"), None);
        assert_eq!(normalize_endpoint(""), None);
    }

    #[test]
    fn attlog_tabs_with_extra_fields() {
        let (r, m) = parse_attlog(
            "7\t2026-11-11 10:02:03\t0\t1\t0\t0\t0\r\n12\t2026-11-11 10:05:00\t1\t15\t0\n\n",
        );
        assert!(m.is_empty());
        assert_eq!(
            r[0],
            AttlogRecord {
                line: 1,
                pin: "7".into(),
                device_time: "2026-11-11 10:02:03".into(),
                status: Some("0".into()),
                verify: Some("1".into()),
                work_code: Some("0".into())
            }
        );
        assert_eq!(r[1].verify.as_deref(), Some("15"));
    }

    #[test]
    fn attlog_space_fallback_and_minimal_lines() {
        let (r, _) = parse_attlog("7  2026-11-11 10:02:03  0  1\n8 2026-11-11 10:02:04\n");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0].verify.as_deref(), Some("1"));
        assert_eq!(r[1].status, None);
    }

    #[test]
    fn attlog_malformed_lines_are_reported() {
        let (r, m) =
            parse_attlog("garbage\n7\t11/11/2026 10:02\t0\t1\n';drop\t2026-11-11 10:02:03\t0\t1\n");
        assert!(r.is_empty());
        assert_eq!(
            m.iter().map(|x| x.error).collect::<Vec<_>>(),
            ["too_few_fields", "bad_time", "bad_pin"]
        );
        assert_eq!(m.iter().map(|x| x.line).collect::<Vec<_>>(), [1, 2, 3]);
    }

    #[test]
    fn attlog_odd_values_become_null_and_nuls_are_stripped() {
        let (r, _) = parse_attlog("7\t2026-11-11 10:02:03\tX\t9999\n\0\0\n");
        assert_eq!((r[0].status.clone(), r[0].verify.clone()), (None, None));
        assert_eq!(r.len(), 1);
        let (r, _) = parse_attlog("7\t2026-11-11 10:02:03\t0\t1\tWORKCODE-TOO-LONG-FOR-THE-FIELD");
        assert_eq!(r[0].work_code, None);
    }

    #[test]
    fn attlog_cap_reports_the_overflow() {
        let body: String = (0..MAX_ATTLOG_LINES + 3)
            .map(|i| format!("{i}\t2026-11-11 10:00:00\n"))
            .collect();
        let (r, m) = parse_attlog(&body);
        assert_eq!(r.len(), MAX_ATTLOG_LINES);
        assert_eq!(m.len(), 3);
        assert!(m.iter().all(|x| x.error == "batch_too_large"));
    }

    #[test]
    fn attlog_raw_is_truncated() {
        let (_, m) = parse_attlog(&format!("{}\n", "x".repeat(500)));
        assert_eq!(m[0].raw.len(), 200);
    }

    #[test]
    fn device_time_shape() {
        assert!(is_device_time("2026-11-11 10:02:03"));
        assert!(!is_device_time("2026-11-11T10:02:03"));
        assert!(!is_device_time("2026-11-11 10:02"));
        assert!(!is_device_time("2026-1a-11 10:02:03"));
    }

    #[test]
    fn photo_filename() {
        assert_eq!(
            parse_photo_filename("20261111100203-7.jpg"),
            Some(("7".into(), "2026-11-11 10:02:03".into()))
        );
        assert_eq!(
            parse_photo_filename("cam/20261111100203-A12.JPEG"),
            Some(("A12".into(), "2026-11-11 10:02:03".into()))
        );
        assert_eq!(parse_photo_filename("../../etc/passwd"), None);
        assert_eq!(parse_photo_filename("20261111100203-7.png"), None);
        assert_eq!(parse_photo_filename("2026111110020-7.jpg"), None);
        assert_eq!(parse_photo_filename("20261111100203-bad;pin.jpg"), None);
    }

    #[test]
    fn photo_header_nul_binary() {
        let mut body = b"PIN=20261111100203-7.jpg\nSN=ABC\nsize=12\nCMD=uploadphoto\0".to_vec();
        body.extend_from_slice(&JPEG);
        let p = parse_photo_body(&body).unwrap();
        assert_eq!(
            (p.pin.as_str(), p.device_time.as_str(), p.jpeg.len()),
            ("7", "2026-11-11 10:02:03", JPEG.len())
        );
    }

    #[test]
    fn photo_without_nul_and_base64_variants() {
        let mut body = b"PIN=20261111100203-7.jpg\nSN=ABC\n".to_vec();
        body.extend_from_slice(&JPEG);
        assert!(parse_photo_body(&body).is_ok());
        let b64 = format!(
            "PIN=20261111100203-7.jpg\nSN=ABC\nphoto={}\n",
            STANDARD.encode(JPEG)
        );
        assert!(parse_photo_body(b64.as_bytes()).is_ok());
        let after_nul = format!("PIN=20261111100203-7.jpg\0{}", STANDARD.encode(JPEG));
        assert!(parse_photo_body(after_nul.as_bytes()).is_ok());
        let data_uri = format!(
            "pin=7&time=2026-11-11 10:02:03&data=data:image/jpeg;base64,{}",
            STANDARD.encode(JPEG)
        );
        assert_eq!(parse_photo_body(data_uri.as_bytes()).unwrap().pin, "7");
    }

    #[test]
    fn photo_refusals() {
        assert_eq!(
            parse_photo_body(b"PIN=20261111100203-7.jpg\0hello"),
            Err("not_jpeg")
        );
        assert_eq!(parse_photo_body(b"SN=ABC\0"), Err("no_pin_or_time"));
        assert_eq!(parse_photo_body(b""), Err("empty_body"));
        let mut big = b"PIN=20261111100203-7.jpg\0".to_vec();
        big.extend_from_slice(&JPEG);
        big.resize(big.len() + MAX_PHOTO_BYTES, 0);
        assert_eq!(parse_photo_body(&big), Err("photo_too_large"));
    }

    #[test]
    fn photo_multipart_identity_from_file_name() {
        let fields = HashMap::from([("sn".to_owned(), "ABC".to_owned())]);
        let ok = parse_photo_multipart(
            &fields,
            Some(FilePart {
                name: "20261111100203-7.jpg".into(),
                bytes: JPEG.to_vec(),
            }),
        );
        assert!(ok.is_ok());
        // base64 file content and junk before the JPEG
        let b64 = parse_photo_multipart(
            &fields,
            Some(FilePart {
                name: "20261111100203-7.jpg".into(),
                bytes: STANDARD.encode(JPEG).into_bytes(),
            }),
        );
        assert!(b64.is_ok());
        let mut junk = b"xx".to_vec();
        junk.extend_from_slice(&JPEG);
        assert!(
            parse_photo_multipart(
                &fields,
                Some(FilePart {
                    name: "20261111100203-7.jpg".into(),
                    bytes: junk
                })
            )
            .is_ok()
        );
        assert_eq!(parse_photo_multipart(&fields, None), Err("no_pin_or_time"));
    }

    #[test]
    fn multipart_splitting() {
        let mut body = b"--XyZ\r\nContent-Disposition: form-data; name=\"SN\"\r\n\r\nABC\r\n--XyZ\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"20261111100203-7.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".to_vec();
        body.extend_from_slice(&JPEG);
        body.extend_from_slice(b"\r\n--XyZ--\r\n");
        let (fields, file) = split_multipart("multipart/form-data; boundary=XyZ", &body).unwrap();
        assert_eq!(fields.get("sn").map(String::as_str), Some("ABC"));
        let file = file.unwrap();
        assert_eq!(file.name, "20261111100203-7.jpg");
        assert_eq!(file.bytes, JPEG);
        assert!(parse_photo_multipart(&fields, Some(file)).is_ok());
        assert!(
            split_multipart("multipart/form-data", &body).is_none(),
            "no boundary"
        );
        assert!(split_multipart("multipart/form-data; boundary=Other", &body).is_none());
        assert!(split_multipart("multipart/form-data; boundary=XyZ", b"--XyZ\r\nbroken").is_none());
    }

    #[test]
    fn options_never_request_biometrics() {
        let c = Cursors {
            attlog: 5,
            photo: 2,
            oplog: 7,
        };
        let legacy = build_options("ABC", c, None);
        assert!(legacy.starts_with("GET OPTION FROM: ABC\n"));
        let bits = legacy.split("TransFlag=").nth(1).unwrap()[..10].to_owned();
        assert_eq!(bits, "1110101000");
        for pos in [4, 6, 8, 9, 10] {
            assert_eq!(&bits[pos - 1..pos], "0");
        }
        assert!(
            legacy.contains("ATTLOGStamp=5\n")
                && legacy.contains("OPERLOGStamp=7\n")
                && legacy.contains("ATTPHOTOStamp=2\n")
        );
        let modern = build_options("ABC", c, Some("2.4.1"));
        assert!(
            modern.contains("TransFlag=TransData AttLog\tOpLog\tAttPhoto\tEnrollUser\tChgUser\n")
        );
        for bad in ["EnrollFP", "ChgFP", "FPImag", "FACE", "UserPic", "BIODATA"] {
            assert!(
                !modern
                    .to_ascii_lowercase()
                    .contains(&bad.to_ascii_lowercase()),
                "{bad}"
            );
        }
        assert!(modern.ends_with('\n'));
    }

    #[test]
    fn user_roster_keeps_only_pin_name_privilege() {
        let operlog = [
            "OPLOG 4\t0\t2026-11-11 10:00:00\t0\t0\t0\t0",
            "USER PIN=7\tName=Priya M\tPri=0\tPasswd=1234\tCard=[0012345678]\tGrp=1\tTZ=0000000100000000",
            "FP PIN=7\tFID=6\tSize=1336\tValid=1\tTMP=SECRETTEMPLATE",
            "FACE PIN=7\tFID=0\tSIZE=2048\tVALID=1\tTMP=SECRETFACE",
            "USER PIN=1\tName=Admin\tPri=14\tPasswd=\tCard=",
            "USER PIN=bad;pin\tName=x",
        ]
        .join("\n");
        let users = parse_user_records("OPERLOG", &operlog);
        assert_eq!(
            users,
            vec![
                DeviceUser {
                    pin: "7".into(),
                    name: Some("Priya M".into()),
                    privilege: Some("0".into())
                },
                DeviceUser {
                    pin: "1".into(),
                    name: Some("Admin".into()),
                    privilege: Some("14".into())
                },
            ]
        );
        let json = serde_json::to_string(&users).unwrap();
        assert!(!json.contains("1234") && !json.contains("0012345678") && !json.contains("SECRET"));
        let info = parse_user_records("USERINFO", "PIN=3\tName=Meera\tPri=0\tPasswd=9\tCard=5\n");
        assert_eq!(
            info,
            vec![DeviceUser {
                pin: "3".into(),
                name: Some("Meera".into()),
                privilege: Some("0".into())
            }]
        );
        // control characters in names are removed; an empty name is null
        let odd = parse_user_records("USERINFO", "PIN=4\tName=\u{7}\u{1b}\tPri=x\n");
        assert_eq!(odd[0].name, None);
        assert_eq!(odd[0].privilege, None);
    }

    #[test]
    fn helpers() {
        assert_eq!(count_lines("a\n\nb\r\n"), 2);
        assert_eq!(
            firmware_from_info(Some("Ver 8.0.4.2-SIM,5,0,42")).as_deref(),
            Some("Ver 8.0.4.2-SIM")
        );
        assert_eq!(firmware_from_info(None), None);
        assert_eq!(firmware_from_info(Some(",")), None);
        assert_eq!(ack_lines(3), "OK: 3");
    }

    #[test]
    fn devicecmd_results() {
        let body = "ID=12&Return=0&CMD=DATA\r\nID=13&Return=-1002&CMD=ENROLL_FP\n\0\nID=x&Return=0\nReturn=0\n";
        assert_eq!(
            parse_command_results(body),
            vec![
                CommandResult {
                    id: 12,
                    return_code: 0
                },
                CommandResult {
                    id: 13,
                    return_code: -1002
                }
            ]
        );
        assert!(parse_command_results("").is_empty());
        let many: String = (1..=150).map(|i| format!("ID={i}&Return=0\n")).collect();
        assert_eq!(parse_command_results(&many).len(), MAX_COMMAND_RESULTS);
        assert!(
            parse_command_results("ID=1234567890123456789&Return=0").is_empty(),
            "id too long"
        );
    }

    #[test]
    fn getrequest_reply() {
        assert_eq!(command_reply(&[]), "OK");
        assert_eq!(
            command_reply(&[
                "C:1:DATA DELETE USERINFO PIN=5".into(),
                "C:2:DATA DELETE USERINFO PIN=6".into()
            ]),
            "C:1:DATA DELETE USERINFO PIN=5\nC:2:DATA DELETE USERINFO PIN=6\n"
        );
    }
}

#[cfg(test)]
mod querydata_users {
    use super::*;

    #[test]
    fn querydata_user_lines_parse_like_operlog() {
        let body = "user uid=1\tcardno=\tpin=7\tpassword=123\tgroup=1\tname=Asha Rao\tprivilege=14\n\
                    user uid=2\tpin=08\tname=\tprivilege=0\r\n\
                    user uid=3\tpin=a-b\tname=Bad\n\
                    FP PIN=7\tFID=1\tTMP=xxxx\n";
        let u = parse_user_records("OPERLOG", body);
        assert_eq!(u.len(), 2);
        assert_eq!(
            (
                u[0].pin.as_str(),
                u[0].name.as_deref(),
                u[0].privilege.as_deref()
            ),
            ("7", Some("Asha Rao"), Some("14"))
        );
        assert_eq!((u[1].pin.as_str(), u[1].name.as_deref()), ("08", None));
    }
}
