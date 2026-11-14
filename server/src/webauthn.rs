//! Minimal WebAuthn (passkey) verification for punching, ES256 only.
//!
//! We need exactly two ceremonies and refuse everything else:
//! * registration (`webauthn.create`): the browser sends `clientDataJSON` and
//!   `authenticatorData` (from `getAuthenticatorData()`), so no attestation
//!   CBOR is parsed; we read the attested credential and its COSE EC2 key.
//! * assertion (`webauthn.get`): ECDSA P-256 over
//!   `authenticatorData || SHA-256(clientDataJSON)`.
//!
//! Both require the RP id hash of our host, User Present AND User Verified
//! (fingerprint / face / device PIN) and our exact web origin.

use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use p256::ecdsa::{Signature, VerifyingKey, signature::Verifier};
use serde::Deserialize;
use sha2::{Digest, Sha256};

pub const FLAG_UP: u8 = 0x01;
pub const FLAG_UV: u8 = 0x04;
pub const FLAG_AT: u8 = 0x40;
pub const FLAG_ED: u8 = 0x80;

/// DER prefix of a P-256 SubjectPublicKeyInfo with an uncompressed point.
const SPKI_PREFIX: [u8; 26] = [
    0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
    0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    Malformed,
    Type,
    Challenge,
    Origin,
    RpId,
    UserPresence,
    UserVerification,
    Credential,
    Key,
    Signature,
}

impl Fail {
    pub fn reason(self) -> &'static str {
        match self {
            Fail::Malformed => "malformed",
            Fail::Type => "type",
            Fail::Challenge => "challenge",
            Fail::Origin => "origin",
            Fail::RpId => "rp_id",
            Fail::UserPresence => "user_presence",
            Fail::UserVerification => "user_verification",
            Fail::Credential => "credential",
            Fail::Key => "key",
            Fail::Signature => "signature",
        }
    }
}

/// The relying-party id: the host of our web origin (no scheme, no port).
pub fn rp_id(app_origin: &str) -> String {
    let rest = app_origin
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(app_origin);
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = if let Some(stripped) = host.strip_prefix('[') {
        stripped.split(']').next().unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or_default()
    };
    host.to_ascii_lowercase()
}

pub fn b64url(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Accepts base64url with or without padding (browsers differ).
pub fn from_b64url(s: &str) -> Option<Vec<u8>> {
    if s.len() > 16 * 1024 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(s.trim_end_matches('=')).ok()
}

/// The WebAuthn challenge for a device registration challenge row.
pub fn registration_challenge(challenge_id: &str, nonce: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"hrms-device-v1\n");
    h.update(challenge_id.to_ascii_lowercase().as_bytes());
    h.update(b"\n");
    h.update(nonce.as_bytes());
    b64url(&h.finalize())
}

/// The WebAuthn challenge for a punch: SHA-256 of the canonical payload.
pub fn punch_challenge(canonical_payload: &str) -> String {
    b64url(&Sha256::digest(canonical_payload.as_bytes()))
}

#[derive(Deserialize)]
struct ClientData {
    #[serde(rename = "type")]
    kind: String,
    challenge: String,
    origin: String,
    #[serde(rename = "crossOrigin", default)]
    cross_origin: bool,
}

pub fn check_client_data(
    raw: &[u8],
    kind: &str,
    challenge: &str,
    origin: &str,
) -> Result<(), Fail> {
    let cd: ClientData = serde_json::from_slice(raw).map_err(|_| Fail::Malformed)?;
    if cd.kind != kind {
        return Err(Fail::Type);
    }
    // Compare decoded bytes so padding differences never matter.
    let presented = from_b64url(&cd.challenge).ok_or(Fail::Challenge)?;
    let expected = from_b64url(challenge).ok_or(Fail::Challenge)?;
    if presented != expected {
        return Err(Fail::Challenge);
    }
    if cd.origin != origin || cd.cross_origin {
        return Err(Fail::Origin);
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
pub struct AuthData {
    pub rp_id_hash: [u8; 32],
    pub flags: u8,
    pub sign_count: u32,
    pub credential_id: Option<Vec<u8>>,
    pub public_key: Option<[u8; 65]>,
}

pub fn parse_auth_data(b: &[u8]) -> Result<AuthData, Fail> {
    if b.len() < 37 {
        return Err(Fail::Malformed);
    }
    let rp_id_hash: [u8; 32] = b[..32].try_into().map_err(|_| Fail::Malformed)?;
    let flags = b[32];
    let sign_count = u32::from_be_bytes(b[33..37].try_into().map_err(|_| Fail::Malformed)?);
    let mut out = AuthData {
        rp_id_hash,
        flags,
        sign_count,
        credential_id: None,
        public_key: None,
    };
    if flags & FLAG_AT != 0 {
        // aaguid(16) | credIdLen(2) | credId | COSE key
        let rest = &b[37..];
        if rest.len() < 18 {
            return Err(Fail::Malformed);
        }
        let len = u16::from_be_bytes([rest[16], rest[17]]) as usize;
        if len == 0 || len > 1023 || rest.len() < 18 + len {
            return Err(Fail::Malformed);
        }
        out.credential_id = Some(rest[18..18 + len].to_vec());
        let (point, used) = cose_es256(&rest[18 + len..])?;
        // Extensions may follow only when the ED flag says so.
        if used != rest.len() - 18 - len && flags & FLAG_ED == 0 {
            return Err(Fail::Malformed);
        }
        out.public_key = Some(point);
    }
    Ok(out)
}

/// Reads a COSE_Key map for EC2/P-256/ES256 and returns the SEC1 point and
/// the number of bytes consumed. Only the integer/byte-string subset of CBOR
/// that such a key uses is accepted.
fn cose_es256(b: &[u8]) -> Result<([u8; 65], usize), Fail> {
    let mut i = 0usize;
    let head = |i: &mut usize| -> Result<(u8, u64), Fail> {
        let ib = *b.get(*i).ok_or(Fail::Key)?;
        *i += 1;
        let major = ib >> 5;
        let info = ib & 0x1f;
        let val = match info {
            0..=23 => info as u64,
            24 => {
                let v = *b.get(*i).ok_or(Fail::Key)? as u64;
                *i += 1;
                v
            }
            25 => {
                let s = b.get(*i..*i + 2).ok_or(Fail::Key)?;
                *i += 2;
                u16::from_be_bytes([s[0], s[1]]) as u64
            }
            _ => return Err(Fail::Key),
        };
        Ok((major, val))
    };
    let int = |i: &mut usize| -> Result<i64, Fail> {
        match head(i)? {
            (0, v) => Ok(v as i64),
            (1, v) => Ok(-1 - v as i64),
            _ => Err(Fail::Key),
        }
    };
    let (major, n) = head(&mut i)?;
    if major != 5 || n > 10 {
        return Err(Fail::Key);
    }
    let (mut kty, mut alg, mut crv) = (None, None, None);
    let (mut x, mut y): (Option<&[u8]>, Option<&[u8]>) = (None, None);
    for _ in 0..n {
        let key = int(&mut i)?;
        match key {
            -2 | -3 => {
                let (m, len) = head(&mut i)?;
                if m != 2 {
                    return Err(Fail::Key);
                }
                let s = b.get(i..i + len as usize).ok_or(Fail::Key)?;
                i += len as usize;
                if key == -2 { x = Some(s) } else { y = Some(s) }
            }
            1 => kty = Some(int(&mut i)?),
            3 => alg = Some(int(&mut i)?),
            -1 => crv = Some(int(&mut i)?),
            _ => {
                // Unknown labels must be simple integers (e.g. key ops are not expected).
                int(&mut i)?;
            }
        }
    }
    if kty != Some(2) || alg != Some(-7) || crv != Some(1) {
        return Err(Fail::Key);
    }
    let (x, y) = (x.ok_or(Fail::Key)?, y.ok_or(Fail::Key)?);
    if x.len() != 32 || y.len() != 32 {
        return Err(Fail::Key);
    }
    let mut point = [0u8; 65];
    point[0] = 0x04;
    point[1..33].copy_from_slice(x);
    point[33..].copy_from_slice(y);
    VerifyingKey::from_sec1_bytes(&point).map_err(|_| Fail::Key)?;
    Ok((point, i))
}

pub fn spki_b64(point: &[u8; 65]) -> String {
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(point);
    STANDARD.encode(der)
}

fn key_from_spki(spki_b64: &str) -> Result<VerifyingKey, Fail> {
    let der = STANDARD.decode(spki_b64).map_err(|_| Fail::Key)?;
    if der.len() != 91 || der[..26] != SPKI_PREFIX {
        return Err(Fail::Key);
    }
    VerifyingKey::from_sec1_bytes(&der[26..]).map_err(|_| Fail::Key)
}

fn check_rp_and_flags(ad: &AuthData, rp_id: &str) -> Result<(), Fail> {
    let expected: [u8; 32] = Sha256::digest(rp_id.as_bytes()).into();
    if ad.rp_id_hash != expected {
        return Err(Fail::RpId);
    }
    if ad.flags & FLAG_UP == 0 {
        return Err(Fail::UserPresence);
    }
    if ad.flags & FLAG_UV == 0 {
        return Err(Fail::UserVerification);
    }
    Ok(())
}

pub struct Registered {
    pub credential_id: String,
    pub spki_b64: String,
    pub sign_count: u32,
}

pub fn verify_registration(
    client_data_json: &[u8],
    authenticator_data: &[u8],
    credential_id: &str,
    expected_challenge: &str,
    origin: &str,
    rp_id: &str,
) -> Result<Registered, Fail> {
    check_client_data(
        client_data_json,
        "webauthn.create",
        expected_challenge,
        origin,
    )?;
    let ad = parse_auth_data(authenticator_data)?;
    check_rp_and_flags(&ad, rp_id)?;
    let (Some(cred), Some(point)) = (ad.credential_id, ad.public_key) else {
        return Err(Fail::Credential);
    };
    if from_b64url(credential_id).as_deref() != Some(cred.as_slice()) {
        return Err(Fail::Credential);
    }
    Ok(Registered {
        credential_id: b64url(&cred),
        spki_b64: spki_b64(&point),
        sign_count: ad.sign_count,
    })
}

/// Verifies a punch assertion; returns the authenticator's signature counter.
pub fn verify_assertion(
    spki_b64: &str,
    client_data_json: &[u8],
    authenticator_data: &[u8],
    signature_der: &[u8],
    expected_challenge: &str,
    origin: &str,
    rp_id: &str,
) -> Result<u32, Fail> {
    check_client_data(client_data_json, "webauthn.get", expected_challenge, origin)?;
    let ad = parse_auth_data(authenticator_data)?;
    check_rp_and_flags(&ad, rp_id)?;
    let key = key_from_spki(spki_b64)?;
    let sig = Signature::from_der(signature_der).map_err(|_| Fail::Signature)?;
    // Authenticators may emit high-S signatures; ECDSA accepts both forms.
    let sig = sig.normalize_s().unwrap_or(sig);
    let mut msg = authenticator_data.to_vec();
    msg.extend_from_slice(&Sha256::digest(client_data_json));
    key.verify(&msg, &sig).map_err(|_| Fail::Signature)?;
    Ok(ad.sign_count)
}

#[doc(hidden)]
pub mod testkit {
    //! A software authenticator for tests (unit and API). Never used by routes.
    use super::*;
    use p256::ecdsa::{SigningKey, signature::Signer};

    pub struct Authenticator {
        pub key: SigningKey,
        pub credential_id: Vec<u8>,
        pub rp_id: String,
        pub origin: String,
        pub counter: u32,
        pub flags: u8,
    }

    impl Authenticator {
        pub fn new(origin: &str) -> Self {
            let mut cred = vec![0u8; 32];
            argon2::password_hash::rand_core::RngCore::fill_bytes(
                &mut argon2::password_hash::rand_core::OsRng,
                &mut cred,
            );
            Self {
                key: SigningKey::random(&mut argon2::password_hash::rand_core::OsRng),
                credential_id: cred,
                rp_id: rp_id(origin),
                origin: origin.to_owned(),
                counter: 0,
                flags: FLAG_UP | FLAG_UV,
            }
        }

        pub fn cose(&self) -> Vec<u8> {
            let p = self.key.verifying_key().to_encoded_point(false);
            let mut v = vec![0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20];
            v.extend_from_slice(p.x().unwrap());
            v.extend_from_slice(&[0x22, 0x58, 0x20]);
            v.extend_from_slice(p.y().unwrap());
            v
        }

        pub fn auth_data(&self, attested: bool) -> Vec<u8> {
            let mut v = Sha256::digest(self.rp_id.as_bytes()).to_vec();
            v.push(self.flags | if attested { FLAG_AT } else { 0 });
            v.extend_from_slice(&self.counter.to_be_bytes());
            if attested {
                v.extend_from_slice(&[0u8; 16]);
                v.extend_from_slice(&(self.credential_id.len() as u16).to_be_bytes());
                v.extend_from_slice(&self.credential_id);
                v.extend_from_slice(&self.cose());
            }
            v
        }

        pub fn client_data(&self, kind: &str, challenge: &str) -> Vec<u8> {
            serde_json::to_vec(&serde_json::json!({
                "type": kind, "challenge": challenge, "origin": self.origin, "crossOrigin": false
            }))
            .unwrap()
        }

        /// (client_data_json, authenticator_data) for `navigator.credentials.create`.
        pub fn register(&self, challenge: &str) -> (Vec<u8>, Vec<u8>) {
            (
                self.client_data("webauthn.create", challenge),
                self.auth_data(true),
            )
        }

        /// (client_data_json, authenticator_data, DER signature) for `.get`.
        pub fn assert(&mut self, challenge: &str) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
            self.counter += 1;
            let cd = self.client_data("webauthn.get", challenge);
            let ad = self.auth_data(false);
            let mut msg = ad.clone();
            msg.extend_from_slice(&Sha256::digest(&cd));
            let sig: Signature = self.key.sign(&msg);
            (cd, ad, sig.to_der().as_bytes().to_vec())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testkit::Authenticator;
    use super::*;

    const O: &str = "https://web-hrms.vercel.app";

    #[test]
    fn rp_id_is_the_bare_host() {
        assert_eq!(rp_id(O), "web-hrms.vercel.app");
        assert_eq!(rp_id("http://localhost:3000"), "localhost");
        assert_eq!(rp_id("https://Example.COM/path?x"), "example.com");
        assert_eq!(rp_id("http://[::1]:3000"), "::1");
    }

    #[test]
    fn challenges_are_stable_and_distinct() {
        let a = registration_challenge("ABC", "n1");
        assert_eq!(
            a,
            registration_challenge("abc", "n1"),
            "uuid case does not matter"
        );
        assert_ne!(a, registration_challenge("abc", "n2"));
        assert_eq!(punch_challenge("x").len(), 43);
        assert_ne!(punch_challenge("x"), punch_challenge("y"));
    }

    fn reg(a: &Authenticator, ch: &str) -> Result<Registered, Fail> {
        let (cd, ad) = a.register(ch);
        verify_registration(&cd, &ad, &b64url(&a.credential_id), ch, O, &rp_id(O))
    }

    #[test]
    fn registration_happy_path_and_key_roundtrip() {
        let a = Authenticator::new(O);
        let ch = registration_challenge("id", "nonce");
        let r = reg(&a, &ch).unwrap();
        assert_eq!(r.credential_id, b64url(&a.credential_id));
        assert_eq!(r.spki_b64.len(), 124);
        assert!(key_from_spki(&r.spki_b64).is_ok());
    }

    #[test]
    fn registration_edge_cases() {
        let ch = registration_challenge("id", "nonce");
        let a = Authenticator::new(O);
        // wrong challenge
        let (cd, ad) = a.register(&registration_challenge("id", "other"));
        assert_eq!(
            verify_registration(&cd, &ad, &b64url(&a.credential_id), &ch, O, &rp_id(O)).err(),
            Some(Fail::Challenge)
        );
        // assertion type used for registration
        let cd = a.client_data("webauthn.get", &ch);
        assert_eq!(
            verify_registration(
                &cd,
                &a.auth_data(true),
                &b64url(&a.credential_id),
                &ch,
                O,
                &rp_id(O)
            )
            .err(),
            Some(Fail::Type)
        );
        // phishing origin, and an RP id for another site
        let evil = Authenticator::new("https://web-hrms.vercel.app.evil.example");
        let (cd, ad) = evil.register(&ch);
        assert_eq!(
            verify_registration(&cd, &ad, &b64url(&evil.credential_id), &ch, O, &rp_id(O)).err(),
            Some(Fail::Origin)
        );
        let mut other_rp = Authenticator::new(O);
        other_rp.rp_id = "evil.example".into();
        assert_eq!(reg(&other_rp, &ch).err(), Some(Fail::RpId));
        // no user verification / presence
        let mut no_uv = Authenticator::new(O);
        no_uv.flags = FLAG_UP;
        assert_eq!(reg(&no_uv, &ch).err(), Some(Fail::UserVerification));
        let mut no_up = Authenticator::new(O);
        no_up.flags = FLAG_UV;
        assert_eq!(reg(&no_up, &ch).err(), Some(Fail::UserPresence));
        // credential id that does not match the attested one
        let (cd, ad) = a.register(&ch);
        assert_eq!(
            verify_registration(
                &cd,
                &ad,
                &b64url(b"someone-elses-credential"),
                &ch,
                O,
                &rp_id(O)
            )
            .err(),
            Some(Fail::Credential)
        );
        // no attested credential at all
        let ad = a.auth_data(false);
        assert_eq!(
            verify_registration(&cd, &ad, &b64url(&a.credential_id), &ch, O, &rp_id(O)).err(),
            Some(Fail::Credential)
        );
        // cross-origin iframe
        let cd = serde_json::to_vec(&serde_json::json!({"type":"webauthn.create","challenge":ch,"origin":O,"crossOrigin":true})).unwrap();
        assert_eq!(
            verify_registration(
                &cd,
                &a.auth_data(true),
                &b64url(&a.credential_id),
                &ch,
                O,
                &rp_id(O)
            )
            .err(),
            Some(Fail::Origin)
        );
        // junk
        assert_eq!(
            verify_registration(b"not json", &a.auth_data(true), "x", &ch, O, &rp_id(O)).err(),
            Some(Fail::Malformed)
        );
    }

    #[test]
    fn cose_key_must_be_es256_p256() {
        let a = Authenticator::new(O);
        let good = a.cose();
        assert!(cose_es256(&good).is_ok());
        // RS256 (alg -257 = 0x39 0x01 0x00) is refused
        let mut rs = good.clone();
        rs[4] = 0x39;
        assert!(cose_es256(&rs).is_err());
        // EdDSA kty 1
        let mut okp = good.clone();
        okp[2] = 0x01;
        assert_eq!(cose_es256(&okp).err(), Some(Fail::Key));
        // a point that is not on the curve
        let mut off = good.clone();
        let n = off.len();
        off[n - 1] ^= 0xff;
        assert_eq!(cose_es256(&off).err(), Some(Fail::Key));
        // truncated
        assert!(cose_es256(&good[..good.len() - 5]).is_err());
        assert!(cose_es256(&[]).is_err());
        // trailing bytes without the extension flag
        let mut ad = a.auth_data(true);
        ad.push(0x00);
        assert_eq!(parse_auth_data(&ad).err(), Some(Fail::Malformed));
    }

    #[test]
    fn auth_data_bounds() {
        assert_eq!(parse_auth_data(&[0u8; 36]).err(), Some(Fail::Malformed));
        let mut ad = vec![0u8; 37];
        ad[32] = FLAG_AT; // claims attested data but has none
        assert_eq!(parse_auth_data(&ad).err(), Some(Fail::Malformed));
        let mut ad = vec![0u8; 37 + 18];
        ad[32] = FLAG_AT;
        ad[37 + 16] = 0xff; // credential id longer than the buffer
        assert_eq!(parse_auth_data(&ad).err(), Some(Fail::Malformed));
    }

    fn assertion(a: &mut Authenticator, spki: &str, ch: &str) -> Result<u32, Fail> {
        let (cd, ad, sig) = a.assert(ch);
        verify_assertion(spki, &cd, &ad, &sig, ch, O, &rp_id(O))
    }

    #[test]
    fn assertion_happy_path_and_counter() {
        let mut a = Authenticator::new(O);
        let spki = reg(&a, &registration_challenge("i", "n")).unwrap().spki_b64;
        let ch = punch_challenge("hrms-punch-v1\n...");
        assert_eq!(assertion(&mut a, &spki, &ch), Ok(1));
        assert_eq!(assertion(&mut a, &spki, &ch), Ok(2));
    }

    #[test]
    fn assertion_edge_cases() {
        let mut a = Authenticator::new(O);
        let spki = reg(&a, &registration_challenge("i", "n")).unwrap().spki_b64;
        let ch = punch_challenge("payload");

        // signature by a different key
        let mut other = Authenticator::new(O);
        assert_eq!(assertion(&mut other, &spki, &ch), Err(Fail::Signature));

        // the signed payload differs from what the server rebuilt
        let (cd, ad, sig) = a.assert(&punch_challenge("payload with other lat"));
        assert_eq!(
            verify_assertion(&spki, &cd, &ad, &sig, &ch, O, &rp_id(O)),
            Err(Fail::Challenge)
        );

        // tampered authenticator data (flip the counter) breaks the signature
        let (cd, mut ad, sig) = a.assert(&ch);
        ad[36] ^= 0x01;
        assert_eq!(
            verify_assertion(&spki, &cd, &ad, &sig, &ch, O, &rp_id(O)),
            Err(Fail::Signature)
        );

        // tampered client data (same challenge, extra field) breaks it too
        let (_, ad, sig) = a.assert(&ch);
        let cd2 = serde_json::to_vec(
            &serde_json::json!({"type":"webauthn.get","challenge":ch,"origin":O,"x":1}),
        )
        .unwrap();
        assert_eq!(
            verify_assertion(&spki, &cd2, &ad, &sig, &ch, O, &rp_id(O)),
            Err(Fail::Signature)
        );

        // registration-type client data replayed as an assertion
        let cd = a.client_data("webauthn.create", &ch);
        let (_, ad, sig) = a.assert(&ch);
        assert_eq!(
            verify_assertion(&spki, &cd, &ad, &sig, &ch, O, &rp_id(O)),
            Err(Fail::Type)
        );

        // without user verification
        a.flags = FLAG_UP;
        assert_eq!(assertion(&mut a, &spki, &ch), Err(Fail::UserVerification));
        a.flags = FLAG_UP | FLAG_UV;

        // garbage signature / key
        let (cd, ad, _) = a.assert(&ch);
        assert_eq!(
            verify_assertion(&spki, &cd, &ad, b"\x30\x00", &ch, O, &rp_id(O)),
            Err(Fail::Signature)
        );
        assert_eq!(
            verify_assertion("AAAA", &cd, &ad, b"", &ch, O, &rp_id(O)),
            Err(Fail::Key)
        );
    }

    #[test]
    fn high_s_signatures_are_accepted() {
        use p256::elliptic_curve::ops::Neg;
        let mut a = Authenticator::new(O);
        let spki = reg(&a, &registration_challenge("i", "n")).unwrap().spki_b64;
        let ch = punch_challenge("p");
        let (cd, ad, sig) = a.assert(&ch);
        let s = Signature::from_der(&sig).unwrap();
        let (r, sv) = s.split_scalars();
        let high = Signature::from_scalars(r, sv.as_ref().neg()).unwrap();
        let der = high.to_der().as_bytes().to_vec();
        assert!(verify_assertion(&spki, &cd, &ad, &der, &ch, O, &rp_id(O)).is_ok());
    }

    #[test]
    fn base64url_accepts_padding() {
        assert_eq!(from_b64url("YQ==").unwrap(), b"a");
        assert_eq!(from_b64url("YQ").unwrap(), b"a");
        assert!(from_b64url("***").is_none());
        assert!(from_b64url(&"A".repeat(20000)).is_none());
    }
}
