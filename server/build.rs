// Rebuild when a migration is added: sqlx::migrate! embeds the folder.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
