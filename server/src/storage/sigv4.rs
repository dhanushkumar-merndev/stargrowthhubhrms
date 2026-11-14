//! AWS Signature Version 4 for single-chunk S3 requests (Cloudflare R2 speaks
//! the S3 API with region `auto`). Only what PUT/GET/DELETE object needs.

use hmac::{Hmac, Mac};
use sha2::{Digest, Sha256};

type HmacSha256 = Hmac<Sha256>;

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hmac(key: &[u8], data: &str) -> Vec<u8> {
    let mut m = HmacSha256::new_from_slice(key).expect("hmac accepts any key length");
    m.update(data.as_bytes());
    m.finalize().into_bytes().to_vec()
}

/// RFC 3986 encoding as S3 expects: unreserved characters stay, everything
/// else is %XX. Slashes stay in paths (`keep_slash`).
pub fn uri_encode(s: &str, keep_slash: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b'/' if keep_slash => out.push('/'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub struct Request<'a> {
    pub method: &'a str,
    /// Already URI-encoded absolute path, e.g. `/bucket/key`.
    pub path: &'a str,
    /// Already-canonical query string (sorted, encoded) or "".
    pub query: &'a str,
    /// Lower-case header names with trimmed values; must include `host`,
    /// `x-amz-content-sha256` and `x-amz-date`.
    pub headers: &'a [(&'a str, String)],
    pub payload_sha256: &'a str,
    /// `YYYYMMDDTHHMMSSZ`
    pub amz_date: &'a str,
    pub region: &'a str,
    pub service: &'a str,
}

/// Returns the `Authorization` header value.
pub fn authorization(r: &Request<'_>, access_key: &str, secret_key: &str) -> String {
    let mut headers: Vec<(&str, &str)> = r.headers.iter().map(|(k, v)| (*k, v.as_str())).collect();
    headers.sort_by(|a, b| a.0.cmp(b.0));
    let canonical_headers: String = headers
        .iter()
        .map(|(k, v)| format!("{k}:{}\n", v.trim()))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(k, _)| *k)
        .collect::<Vec<_>>()
        .join(";");
    let canonical = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        r.method, r.path, r.query, canonical_headers, signed_headers, r.payload_sha256
    );
    let date = &r.amz_date[..8];
    let scope = format!("{date}/{}/{}/aws4_request", r.region, r.service);
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        r.amz_date,
        sha256_hex(canonical.as_bytes())
    );
    let k_date = hmac(format!("AWS4{secret_key}").as_bytes(), date);
    let k_region = hmac(&k_date, r.region);
    let k_service = hmac(&k_region, r.service);
    let k_signing = hmac(&k_service, "aws4_request");
    let signature = hex(&hmac(&k_signing, &to_sign));
    format!(
        "AWS4-HMAC-SHA256 Credential={access_key}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The worked example from the AWS S3 docs ("GET Object", single chunk).
    #[test]
    fn matches_the_aws_documented_example() {
        let empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
        let headers = [
            ("host", "examplebucket.s3.amazonaws.com".to_string()),
            ("range", "bytes=0-9".to_string()),
            ("x-amz-content-sha256", empty.to_string()),
            ("x-amz-date", "20130524T000000Z".to_string()),
        ];
        let auth = authorization(
            &Request {
                method: "GET",
                path: "/test.txt",
                query: "",
                headers: &headers,
                payload_sha256: empty,
                amz_date: "20130524T000000Z",
                region: "us-east-1",
                service: "s3",
            },
            "AKIAIOSFODNN7EXAMPLE",
            "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        );
        assert_eq!(
            auth,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    #[test]
    fn header_order_does_not_matter() {
        let h1 = [
            ("x-amz-date", "20260101T000000Z".to_string()),
            ("host", "h".to_string()),
            ("x-amz-content-sha256", "x".to_string()),
        ];
        let h2 = [
            ("host", "h".to_string()),
            ("x-amz-content-sha256", "x".to_string()),
            ("x-amz-date", "20260101T000000Z".to_string()),
        ];
        let r = |h: &'static [(&'static str, String)]| Request {
            method: "PUT",
            path: "/b/k",
            query: "",
            headers: h,
            payload_sha256: "x",
            amz_date: "20260101T000000Z",
            region: "auto",
            service: "s3",
        };
        let h1: &'static [_] = Box::leak(Box::new(h1));
        let h2: &'static [_] = Box::leak(Box::new(h2));
        assert_eq!(
            authorization(&r(h1), "a", "s"),
            authorization(&r(h2), "a", "s")
        );
    }

    #[test]
    fn encodes_like_s3() {
        assert_eq!(uri_encode("a b/c+d~e", true), "a%20b/c%2Bd~e");
        assert_eq!(uri_encode("a/b", false), "a%2Fb");
        assert_eq!(uri_encode("é", true), "%C3%A9");
    }
}
