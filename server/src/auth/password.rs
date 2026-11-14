//! Password hashing (argon2id) and the HRMS password policy.

use std::sync::OnceLock;

use argon2::{
    Algorithm, Argon2, Params, PasswordHash, PasswordHasher, PasswordVerifier, Version,
    password_hash::{SaltString, rand_core::OsRng, rand_core::RngCore},
};

use crate::error::{ApiError, ApiResult};

/// OWASP-recommended argon2id: 19 MiB, 2 passes, 1 lane (fits Render free).
fn argon() -> Argon2<'static> {
    let params = Params::new(19 * 1024, 2, 1, None).expect("valid argon2 params");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

pub fn hash(password: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    argon()
        .hash_password(password.as_bytes(), &salt)
        .expect("argon2 hashing cannot fail with valid params")
        .to_string()
}

/// Constant work whether or not the account exists: unknown accounts are
/// checked against a fixed dummy hash so timing does not reveal valid IDs.
pub fn verify(password: &str, phc: Option<&str>) -> bool {
    static DUMMY: OnceLock<String> = OnceLock::new();
    let dummy = DUMMY.get_or_init(|| hash("dummy-password-for-timing-only"));
    let (target, real) = match phc {
        Some(p) if p.starts_with("$argon2") => (p, true),
        _ => (dummy.as_str(), false),
    };
    let ok = PasswordHash::new(target)
        .map(|h| argon().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false);
    ok && real
}

pub async fn hash_async(password: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || hash(&password))
        .await
        .map_err(|_| ApiError::internal())
}

pub async fn verify_async(password: String, phc: Option<String>) -> bool {
    tokio::task::spawn_blocking(move || verify(&password, phc.as_deref()))
        .await
        .unwrap_or(false)
}

/// HRMS rule (auth-password Edge Function): 12–128 chars, not containing the
/// employee ID, not one repeated character.
pub fn validate_new(password: &str, employee_code: Option<&str>) -> ApiResult<()> {
    let len = password.chars().count();
    if !(12..=128).contains(&len) {
        return Err(ApiError::validation_field(
            "new_password",
            "At least 12 characters",
            "Use 12 to 128 characters.",
        ));
    }
    if let Some(code) = employee_code.filter(|c| !c.is_empty())
        && password.to_uppercase().contains(&code.to_uppercase())
    {
        return Err(ApiError::validation_field(
            "new_password",
            "Must not contain your employee ID",
            "Do not include your employee ID in the password.",
        ));
    }
    let mut chars = password.chars();
    let first = chars.next();
    if chars.all(|c| Some(c) == first) {
        return Err(ApiError::validation_field(
            "new_password",
            "Too simple",
            "Choose a less predictable password.",
        ));
    }
    Ok(())
}

/// 16-character temporary password from an unambiguous alphabet, shown once.
pub fn temporary() -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
    let mut bytes = [0u8; 13];
    OsRng.fill_bytes(&mut bytes);
    // Rejection sampling keeps the distribution uniform.
    let mut out = String::with_capacity(16);
    let limit = 256 - (256 % ALPHABET.len());
    let mut i = 0;
    while out.len() < 13 {
        if i == bytes.len() {
            OsRng.fill_bytes(&mut bytes);
            i = 0;
        }
        let b = bytes[i] as usize;
        i += 1;
        if b < limit {
            out.push(ALPHABET[b % ALPHABET.len()] as char);
        }
    }
    // Guarantee an upper, lower and digit for any policy checks.
    out.push_str("K7m");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_then_verify() {
        let h = hash("correct horse battery");
        assert!(h.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
        assert!(verify("correct horse battery", Some(&h)));
        assert!(!verify("wrong horse battery", Some(&h)));
    }

    #[test]
    fn unknown_or_garbage_hash_never_verifies() {
        assert!(!verify("dummy-password-for-timing-only", None));
        assert!(!verify("x", Some("not-a-hash")));
        assert!(!verify("x", Some("$argon2id$garbage")));
        assert!(!verify("", Some(&hash("a long enough password"))));
    }

    #[test]
    fn salts_differ() {
        assert_ne!(hash("same password here"), hash("same password here"));
    }

    #[test]
    fn policy_edges() {
        assert!(validate_new("short", None).is_err());
        assert!(validate_new(&"a".repeat(11), None).is_err());
        assert!(
            validate_new("aaaaaaaaaaaa", None).is_err(),
            "one repeated char"
        );
        assert!(validate_new(&"ab".repeat(65), None).is_err(), "129+ chars");
        assert!(
            validate_new(&"ab".repeat(64), None).is_ok(),
            "128 chars is fine"
        );
        assert!(validate_new("abcdefghijkl", None).is_ok(), "exactly 12");
        let e = validate_new("my-emp001-password", Some("EMP001")).unwrap_err();
        assert_eq!(
            e.field_errors["new_password"],
            "Must not contain your employee ID"
        );
        assert!(validate_new("my-other-password", Some("EMP001")).is_ok());
        assert!(
            validate_new("ünïcödé-pässwörd", None).is_ok(),
            "unicode counts chars"
        );
        assert!(
            validate_new("😀😀😀😀😀😀😀😀😀😀😀😀", None).is_err(),
            "12 identical emoji"
        );
    }

    #[test]
    fn temporary_passwords_pass_policy_and_are_unique() {
        let a = temporary();
        let b = temporary();
        assert_eq!(a.len(), 16);
        assert_ne!(a, b);
        assert!(validate_new(&a, Some("EMP001")).is_ok());
        assert!(a.chars().all(|c| c.is_ascii_alphanumeric()));
        assert!(!a.contains(['0', 'O', '1', 'l', 'I']));
    }
}
