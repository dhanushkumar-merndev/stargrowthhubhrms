# web-hrms

PWA version of the internal HRMS with eSSL biometric attendance.
Next.js on Vercel + Rust (Axum) on Render + Postgres on Supabase. Everything runs on free plans.
See [PLAN.md](PLAN.md) for the design, decisions and phases.

```
browser ──HTTPS──▶ Vercel  web/  (Next.js PWA)
                     │ src/proxy.ts: /api/* → Render, adds x-proxy-secret + x-client-ip
                     ▼
                   Render  server/  (Rust API)  ──▶ Supabase Postgres (P1)
                     ▲
eSSL machine ─HTTP─▶ Cloudflare Worker  relay/  (P5)
```

| Folder | What |
|---|---|
| `web/` | Next.js 16 PWA (App Router, Tailwind 4, tokens copied from `hrms/lib/app/theme.dart`) |
| `server/` | Rust API: `/healthz` (public), `/v1/*` (only through the Vercel proxy) |
| `relay/` | Cloudflare Worker that turns the machine's plain HTTP into HTTPS |

## Local development

Needs Rust 1.90+, Node 24+, pnpm 12, Docker (for the database from P1).

```sh
cp .env.example .env.local      # already done on the dev machine; fill PROXY_SECRET etc.
pnpm install
pnpm dev:server                 # http://localhost:8080   (reads ../.env.local)
pnpm dev:web                    # http://localhost:3000   (reads ../.env.local)
curl localhost:3000/api/v1/ping # → {"ok":true,...} via the proxy
```

Both apps read the single root `.env.local`.

| Command | Does |
|---|---|
| `pnpm test` | Rust unit + HTTP tests |
| `pnpm lint` | ESLint + clippy (`-D warnings`) |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm build:web` / `pnpm build:server` | production builds |

## Deploy (summary; full guide in P11)

1. **Server image**: push to `main` → `.github/workflows/server-image.yml` builds `server/Dockerfile` and pushes
   `ghcr.io/<owner>/web-hrms-server`. Make the GHCR package public, or add registry credentials in Render.
2. **Render**: New → Blueprint (`render.yaml`, replace `OWNER`). Set `APP_ORIGIN` and `PROXY_SECRET`.
   Copy the Deploy Hook URL into the GitHub secret `RENDER_DEPLOY_HOOK_URL`.
3. **Vercel**: import the repo, Root Directory `web`. Env: `API_ORIGIN=https://web-hrms-api.onrender.com` and the same `PROXY_SECRET`.
4. **UptimeRobot**: HTTP monitor on `https://web-hrms-api.onrender.com/healthz` every 5 minutes.
