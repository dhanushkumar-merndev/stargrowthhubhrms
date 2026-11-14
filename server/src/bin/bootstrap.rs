//! `cargo run --bin bootstrap` — creates the organisation and first Admin.
//! Reads ORG_CODE, ORG_NAME, ORG_TIMEZONE, ADMIN_EMPLOYEE_CODE, ADMIN_NAME,
//! ADMIN_PASSWORD, ALIAS_DOMAIN and DATABASE_URL. Runs migrations first.

use hrms_server::{bootstrap, db};

fn env(key: &str) -> String {
    std::env::var(key).unwrap_or_default()
}

#[tokio::main]
async fn main() {
    let _ =
        dotenvy::from_filename(".env.local").or_else(|_| dotenvy::from_filename("../.env.local"));
    let url = env("DATABASE_URL");
    if url.is_empty() {
        eprintln!("DATABASE_URL is not set");
        std::process::exit(1);
    }
    let pool = db::connect(&url, 2).await.unwrap_or_else(|e| {
        eprintln!("cannot connect: {e}");
        std::process::exit(1)
    });
    if let Err(e) = db::migrate(&pool).await {
        eprintln!("migrations failed: {e}");
        std::process::exit(1);
    }
    let tz = env("ORG_TIMEZONE");
    let domain = env("ALIAS_DOMAIN");
    let input = bootstrap::Input {
        org_code: env("ORG_CODE"),
        org_name: env("ORG_NAME"),
        timezone: if tz.is_empty() {
            "Asia/Kolkata".into()
        } else {
            tz
        },
        admin_code: env("ADMIN_EMPLOYEE_CODE"),
        admin_name: env("ADMIN_NAME"),
        admin_password: env("ADMIN_PASSWORD"),
        alias_domain: if domain.is_empty() {
            "staff.hrms.invalid".into()
        } else {
            domain
        },
    };
    match bootstrap::run(&pool, &input).await {
        Ok(v) if v["already"] == true => {
            println!(
                "Admin already set up (employee {}). Nothing changed.",
                v["employee_id"]
            )
        }
        Ok(v) => println!(
            "Created Admin {} — sign in and change the password. Now remove ADMIN_PASSWORD from the environment.",
            v["employee_code"]
        ),
        Err(e) => {
            eprintln!("bootstrap failed: {e}");
            std::process::exit(1);
        }
    }
}
