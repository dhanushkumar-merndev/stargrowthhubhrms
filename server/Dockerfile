# syntax=docker/dockerfile:1.7
# Rust API image for Render (free, 512 MB). Build context = repo root:
#   docker build -f server/Dockerfile -t hrms-server .
# Built in GitHub Actions and pushed to GHCR; Render only pulls the image.

ARG RUST_VERSION=1.99

FROM rust:${RUST_VERSION}-slim-trixie AS chef
RUN cargo install cargo-chef --locked --version 0.1.78
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock ./
COPY server ./server
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Dependencies only: cached until Cargo.lock changes.
RUN cargo chef cook --release --recipe-path recipe.json
COPY Cargo.toml Cargo.lock ./
COPY server ./server
RUN cargo build --release -p hrms-server --bin hrms-server

# distroless: no shell, no package manager, runs as uid 65532.
FROM gcr.io/distroless/cc-debian13:nonroot
COPY --from=builder /app/target/release/hrms-server /usr/local/bin/hrms-server
ENV LOG_FORMAT=json PORT=8080
EXPOSE 8080
USER nonroot
ENTRYPOINT ["/usr/local/bin/hrms-server"]
