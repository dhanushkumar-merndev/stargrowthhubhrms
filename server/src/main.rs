use std::sync::Arc;

use hrms_server::{
    app::{self, AppState, Db},
    config::Config,
    db, rpc,
};
use tracing_subscriber::{EnvFilter, fmt, prelude::*};

#[tokio::main]
async fn main() {
    // Local development reads the monorepo-root .env.local. Render injects real env vars.
    #[cfg(debug_assertions)]
    {
        let _ = dotenvy::from_filename(".env.local")
            .or_else(|_| dotenvy::from_filename("../.env.local"));
    }

    let json_logs = std::env::var("LOG_FORMAT").is_ok_and(|v| v == "json");
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info,tower_http=info"));
    let registry = tracing_subscriber::registry().with(filter);
    if json_logs {
        registry.with(fmt::layer().json()).init();
    } else {
        registry.with(fmt::layer()).init();
    }

    let config = match Config::from_env() {
        Ok(c) => c,
        Err(e) => {
            tracing::error!("configuration error: {e}");
            std::process::exit(1);
        }
    };
    let addr = config.addr;

    let Some(url) = config.database_url.clone() else {
        tracing::error!("configuration error: DATABASE_URL is not set");
        std::process::exit(1);
    };
    let pool = match db::connect(&url, config.database_max_connections).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!("database connection failed: {e}");
            std::process::exit(1);
        }
    };
    if let Err(e) = db::migrate(&pool).await {
        tracing::error!("migrations failed: {e}");
        std::process::exit(1);
    }
    let catalog = match rpc::Catalog::load(&pool).await {
        Ok(c) => Arc::new(c),
        Err(e) => {
            tracing::error!("cannot read the RPC catalog: {e}");
            std::process::exit(1);
        }
    };
    tracing::info!(functions = catalog.public_len(), "rpc catalog loaded");
    if let Some(secret) = config.device_ingest_secret.as_deref() {
        if let Err(e) = hrms_server::iclock::routes::configure(&pool, secret).await {
            tracing::error!("cannot configure device ingest: {e:?}");
            std::process::exit(1);
        }
        tracing::info!("attendance machine ingest enabled");
    }
    hrms_server::jobs::spawn(pool.clone());
    let store = match hrms_server::storage::Store::from_lookup(|k| std::env::var(k).ok()) {
        Ok(s) => s,
        Err(e) => {
            tracing::error!("file storage misconfigured: {e}");
            std::process::exit(1);
        }
    };
    if store.is_none() {
        tracing::warn!("file storage is off (set R2_* or FILE_STORE_DIR)");
    }
    let state = AppState::new(config, Some(Db { pool, catalog })).with_store(store);

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .unwrap_or_else(|e| panic!("cannot bind {addr}: {e}"));
    tracing::info!(%addr, "hrms-server listening");

    axum::serve(listener, app::router(state))
        .with_graceful_shutdown(shutdown_signal())
        .await
        .expect("server error");
}

/// Render sends SIGTERM on deploys; finish in-flight requests first.
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
