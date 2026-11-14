//! Authentication: argon2id passwords, opaque cookie sessions, and the HTTP
//! routes that replace the HRMS auth-* / admin-users Edge Functions.

pub mod password;
pub mod routes;
pub mod session;
pub mod token;
pub mod two_step;
