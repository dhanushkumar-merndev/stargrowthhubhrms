# web-hrms — build plan

Date: 2026-11-13 · Status: plan, not implemented.

Owner decisions (2026-11-13):
- No custom domain. Use `*.vercel.app`, `*.onrender.com` and `*.workers.dev`.
- **Start fresh**: no data import.
- Stay on Vercel Hobby.
- The Android app is on hold. **Nothing is deleted**: `../hrms`, its Supabase project and fingertipssl stay as they are.

Sources (read-only, never modified):
- `../hrms` — Flutter/Android HRMS (features, RBAC, SQL business logic, design tokens).
- `~/Documents/Projects/november/fingertipssl` — eSSL/ZKTeco iclock (ADMS) device ingest + HR console.

Goal: one **PWA** (Next.js on Vercel) + one **Rust API** (Axum on Render) in a monorepo. It keeps every HRMS
feature, adds eSSL biometric punches, and looks the same as the Android app. Everything has to run on free plans.

---

## 1. Key decisions

| # | Decision | Why |
|---|---|---|
| K1 | **Business logic stays in Postgres**: port HRMS + fingertipssl SQL migrations (RPCs, constraints, pg_cron). Rust is the auth/HTTP/device/push/files layer. | ~36 tested HRMS migrations + 12 device migrations + pgTAP tests. A Rust rewrite would cost many times the tokens and add risk. |
| K2 | Replace `auth.uid()` with `hrms.actor_id()`, which reads `current_setting('app.actor_id')`. Rust sets it with `set_config(..., true)` inside each request transaction. | RPCs keep their own actor checks. The browser never talks to Postgres. |
| K3 | **Own auth in Rust** (no Supabase Auth): Employee ID + password (argon2id), short-lived access JWT + rotating refresh token, both **httpOnly Secure cookies**. | Fewer moving parts, no anon key in the browser, stronger session control. |
| K4 | **Notifications = standard Web Push (VAPID)** sent from Rust (`web-push` crate), plus an in-app inbox and live updates over **SSE**. | Free, no Firebase SDK. Works on Android Chrome, desktop, and iOS 16.4+ once installed to the Home Screen. FCM web would add a vendor SDK for nothing. |
| K5 | DB = **Supabase Postgres (free)** used only as Postgres (+ pg_cron). Files = **Cloudflare R2 (free 10 GB, no egress fees)**. | Supabase Storage free is only 1 GB. Cloudflare is already required for the device relay. |
| K6 | eSSL path: machine → **Cloudflare Worker on `hrms-device.<account>.workers.dev`** (HTTP :80) → Render `/iclock/*` (HTTPS). Port `protocol.ts`/`ingest.ts` to Rust. | Render redirects HTTP→HTTPS like Vercel does, and the machine does not follow redirects. P5 starts by testing that `curl -i http://…workers.dev/iclock/getrequest?SN=X` returns 404, not 301/308. If workers.dev forces HTTPS, the fallback is a ~₹800/yr domain on Cloudflare; that's the only paid item. |
| K7 | **Same-origin API through Vercel.** The browser only calls `https://<app>.vercel.app/api/*`. Next.js `src/proxy.ts` (Next 16's middleware) rewrites to `API_ORIGIN` on Render and adds `x-proxy-secret` + `x-client-ip` (taken from Vercel's trusted client IP). Rust rejects every `/v1` request without a matching `PROXY_SECRET` (`/healthz` and `/iclock` use their own checks). | Without a domain, `vercel.app` ↔ `onrender.com` is cross-site, and browsers block those cookies. Same-origin gives host-only `__Host-` cookies, no CORS, and an unspoofable client IP for the office-IP punch check. |
| K8 | PWA via the official Next.js approach: `app/manifest.ts` + hand-written `public/sw.js` (push, notificationclick, app-shell cache). No plugin. | Next 16 uses Turbopack, and PWA plugins lag behind it. |
| K9 | Rust API types → TypeScript via `ts-rs`, generated into `web/src/lib/api/types/`. | One source of truth for the contract. |

### Android-only checks → web replacements

| Android today | PWA replacement |
|---|---|
| Office Wi-Fi SSID / nearby networks | **Office public-IP allowlist** checked server-side (`X-Forwarded-For` from Render) + geofence. The eSSL machine is the primary in-office proof. |
| Play Integrity + hardware device key | **WebAuthn passkey** (platform authenticator) bound to the employee. Each PWA punch needs a passkey assertion (fingerprint/face on the phone). |
| `local_auth` biometric | Same passkey assertion |
| Precise GPS (geolocator) | `navigator.geolocation` with `enableHighAccuracy`. Server checks radius/accuracy/age (D10 rules kept). |
| FCM | Web Push (K4) |
| Phone settings channel (battery etc.) | Dropped. Replaced by an "Install app / enable notifications" setup screen. |

---

## 2. Monorepo layout

```
HRMS/
├── hrms/                      # untouched Android app
└── web-hrms/                  # new repo (git init here)
    ├── .gitignore  .env.example  .env.local  README.md  PLAN.md
    ├── package.json  pnpm-workspace.yaml        # pnpm workspace: web, relay
    ├── Cargo.toml                                # cargo workspace: server
    ├── web/                                      # Next.js 16 PWA (App Router, TS, Tailwind 4)
    │   ├── src/app/(auth)/login, password-change
    │   ├── src/app/(app)/home, action, explore, attendance, leave, ...   # one folder per HRMS route
    │   ├── src/components/ui/        # ports of lib/core/widgets (cards, pill_tabs, accordion, jelly nav, sheets, skeleton)
    │   ├── src/lib/api/              # fetch client + generated types
    │   ├── src/app/manifest.ts  public/sw.js  public/icons/  public/illustrations/ (copied from hrms/assets)
    │   └── middleware.ts              # route guard (UX only)
    ├── server/                        # Rust: Axum + sqlx + tokio
    │   ├── src/main.rs  config.rs  error.rs
    │   ├── src/auth/       # login, refresh, logout, password, reauth grants, passkeys, TOTP, rate limit
    │   ├── src/api/        # one module per feature → calls hrms RPCs
    │   ├── src/iclock/     # protocol.rs (port of protocol.ts), ingest.rs, commands
    │   ├── src/push/       # outbox worker, VAPID web-push
    │   ├── src/realtime/   # SSE hub (per-org + per-user topics, ids only)
    │   ├── src/files/      # R2 presigned upload/download, 5 MB limit, sha256, MIME sniff
    │   ├── src/jobs/       # tokio interval tasks (outbox, medical-file purge, photo retention, archive)
    │   ├── migrations/     # sqlx: ported SQL (see §4)
    │   ├── tests/          # Rust integration tests + pgTAP SQL under tests/sql
    │   └── Dockerfile      # cargo-chef multi-stage → distroless, ~20 MB RAM
    ├── relay/                         # Cloudflare Worker (from fingertipssl/deploy/cloudflare-worker)
    └── .github/workflows/ci.yml       # fmt, clippy, cargo test, pgTAP, tsc, lint, build
```

---

## 3. RBAC (from `three-role-rbac-leave-late-design.md`)

Roles: **Employee**, **HR**, **Admin**. `Member`/`Manager` is a display label only. Enforced in SQL RPCs. Rust adds
a route-level guard, and the UI hides what you can't use.

| Capability | Employee | HR | Admin |
|---|---|---|---|
| Own punch (PWA + eSSL), attendance, leave, late/correction/WFH requests, salary view, payslips, documents, profile | ✓ | ✓ | ✓ |
| Directory | safe fields | HR fields | HR fields |
| Approve leave / correction / late (pool, never own) | – | ✓ | ✓ (own auto-approve) |
| Add/remove Employee & HR, promote to HR | – | ✓ | ✓ |
| Create/promote/remove Admin; protect last Admin | – | – | ✓ |
| Salary edit, payslip upload/publish, deductions summary, org reports, announcements, policies, medical docs | – | ✓ | ✓ |
| **eSSL**: today board, live feed, unmatched PINs, link PIN, Fix checkout | – | ✓ | ✓ |
| **eSSL**: register device, enable commands, attendance rules | – | – | ✓ |
| Org settings, offices/IP allowlist, shifts, holidays, archive/cleanup, Google Sheet sync, audit | – | – | ✓ |
| Elevation to HR/Admin, bulk salary export, cleanup | – | reauth | reauth (5-min grant) |

---

## 4. Database port

1. Start from HRMS `supabase/migrations/*` in order. Mechanical rewrites:
   - `auth.uid()` → `hrms.actor_id()`. Remove `auth.users` FKs. Add `hrms.credentials` (employee_id, argon2id hash,
     must_change, credentials_valid_after, failed counters).
   - Drop Supabase `storage.*` usage → `file_records.object_key` points to R2.
   - Drop grants to `anon`/`authenticated` → one `hrms_api` role used by Rust (least privilege, EXECUTE on RPCs only).
   - Drop `device-register`/Play Integrity tables → `webauthn_credentials`, `push_subscriptions`.
2. Apply fingertipssl `device_attendance`, `device_management`, `attendance_rules`, `device_commands`,
   `device_auto_register`, `device_one_click`. **Skip all `hrms_stub_*` migrations**; HRMS provides the real tables.
3. Unify attendance: an accepted eSSL scan writes an `attendance_event` with `source='device'`. A PWA punch writes
   `source='pwa'`. The device rules (first scan IN, last OUT, 10-min duplicate window, midnight "forgot to checkout")
   and the HRMS shift/grace/late/deduction logic read from the same sessions. Precedence: HR fix > device/PWA > auto-checkout.
4. Port pgTAP tests from both repos (`hrms/supabase/tests/database/*`, `fingertipssl/supabase/tests/*`). Run them in CI against
   Postgres 17 in Docker.
5. **Fresh start**: no import. `server/src/bin/bootstrap.rs` creates the org, the first office, the standard leave types
   (PL/ML/UL), the default shift and the first Admin from `.env` (safe to re-run, like fingertipssl's `setup:org`).
   The Admin must change the password on first login. Everyone else is added in the app.
   The old HRMS Supabase project is never touched. A separate **new** Supabase project is used.

---

## 5. Rust API (`server/`)

Crates: `axum 0.8`, `tokio`, `sqlx` (postgres, rustls, migrate), `tower-http` (cors, compression, trace, timeout,
request-id), `tower_governor` (rate limit), `argon2`, `bcrypt` (import only), `jsonwebtoken`, `webauthn-rs`,
`totp-rs`, `web-push`, `aws-sdk-s3` (R2), `serde`, `ts-rs`, `tracing`.

| Area | Endpoints (prefix `/v1`) |
|---|---|
| Auth | `POST auth/login`, `auth/refresh`, `auth/logout`, `auth/password`, `auth/reauth`, `auth/passkey/{register,assert}`, `auth/totp/{enroll,verify}`, `GET auth/sessions`, `DELETE auth/sessions/:id` |
| Punch | `POST punch/challenge` → `POST punch` (geo + passkey assertion + server time + IP check) |
| Features | REST per HRMS module, one handler per RPC: attendance, leave, requests, approvals, salary, payslips, documents, people, employees, payroll, reports, admin/*, archive, announcements, notifications |
| Live | `GET events` (SSE: punch, approval, notification ids → client refetches; 20-s heartbeat; client reconnects automatically and falls back to 30-s polling if the stream drops through the Vercel proxy) |
| Push | `POST push/subscribe`, `DELETE push/subscribe` |
| Files | `POST files/upload-url` (presigned PUT, 5 MB cap, then server verifies size/sha256/MIME), `GET files/:id` (60-s presigned GET after RPC authorization) |
| Device | `/iclock/{cdata,getrequest,devicecmd,fdata,ping,registry,push,querydata}` (+ `.aspx`): text protocol, ingest secret, relay secret, serial allowlist |
| Ops | `GET /healthz` (no DB, for UptimeRobot), `GET /readyz` (DB ping) |

Security baseline:
- Access JWT lasts 10 min. The refresh token is opaque, hashed in the DB, rotated on each use, and reuse revokes the whole family.
- `credentials_valid_after` barrier is kept from HRMS.
- Rate limits: login per IP + per account with bounded cooldown. iclock per serial.
- Cookies: `__Host-at` / `__Host-rt` (Secure, HttpOnly, SameSite=Lax, Path=/, no Domain), first-party via K7.
- CSRF: SameSite=Lax + a required `X-Requested-With` header + Origin check against `APP_ORIGIN` on mutations.
- Direct hits on `*.onrender.com/v1/*` without `PROXY_SECRET` → 404.
- Client IP for the office-IP rule comes only from `x-client-ip`, which is trusted only alongside a valid proxy secret.
- WebAuthn RP ID = `<app>.vercel.app`, origin = `APP_ORIGIN`.
- Headers: strict CSP (no inline scripts except Next nonce), HSTS, `frame-ancestors 'none'`, no-store on sensitive JSON.
- TOTP 2FA is **required for HR/Admin** and optional for Employees.
- Audit log stays append-only and is written from the RPCs. Logs never contain tokens, passwords or signed URLs.
- Biometric templates are never stored (fingertipssl rule kept). Device photos stay in a private R2 prefix with 90-day retention.

Background jobs (tokio, in-process because Render free has no cron):
- push outbox every 10 s
- medical certificate purge after 7 days
- device photo retention
- daily absent/late notifications
- Supabase keep-alive query every 6 h, because a free project pauses after 7 idle days
- Midnight auto-checkout stays in **pg_cron** (from fingertipssl).

---

## 6. Next.js PWA (`web/`)

- **Design is copied exactly from `hrms/lib/app/theme.dart`.** Tokens become CSS variables in `globals.css` (Tailwind 4 `@theme`):
  - background `#F6F7F9`, surface `#FFF`, text `#263342`/`#596678`, primary `#4B59C7`, border `#E3E7ED`
  - module card/action pairs: attendance, leave, salary, people, approvals, documents, workspace
  - error/warning/success + soft variants, holiday, shift badge
  - card radius 20, row radius 16, icon tile 52, 16 px gutters, 4/8/12/16/24/32 spacing
  - system font stack, Material Symbols Outlined icons, light theme only
- Shell: bottom nav **Home · Action · Explore** (jelly nav port), notification bell in the Home app bar, pill tabs, accordion
  module cards (one open at a time), bottom-sheet filters, skeletons, empty/error/offline states.
- **Phone layout is identical to Android.** On ≥1024 px the same components sit in a centered column, and HR tables widen. No new visual language.
- Screens: one route per `hrms/lib/app/app_routes.dart` entry (35 routes: home, action, explore, attendance (+day), corrections,
  late/WFH requests, requests, leave (+apply), holidays, payslips, salary (+bank details), profile (+avatar crop), people,
  documents, policies, notifications, settings, workspace, approvals (+detail), reports/hours, employees (+new/detail/import),
  payroll/uploads, admin: organization, offices, shifts, teams, roles, leave-policies, outside-work, google-sheet, audit, archive,
  announcements/new) **plus** device screens adapted from fingertipssl into HRMS style:
  Explore → Workspace → *Today board*, *Live scans*, *Unmatched PINs*, *Devices*.
- Data: TanStack Query (cache + refetch on SSE event and window focus). Forms: react-hook-form + zod. XLSX export/import: `exceljs`
  (client side, as in Flutter). ZIP archive: `fflate`.
- PWA: install prompt and iOS "Add to Home Screen" guide. Service worker caches the app shell + static assets only, never API JSON
  with private data. Offline shows a stale label; punching needs network (server time is the authority).

---

## 7. New features (missing in Android HRMS)

1. **eSSL biometric attendance**: live scans, today board, unmatched PIN linking, device health/clock drift, Give PIN / Enroll finger
   commands (narrow allowlist), refused-traffic log.
2. **Passkeys**: phone-biometric login and punch confirmation.
3. **TOTP 2FA** for HR/Admin + **active sessions** list with remote sign-out.
4. **Live "Who's in" board** over SSE.
5. **Web Push** with per-category preferences and quiet hours.
6. **Forgot-checkout self-fix request**, prefilled from the auto-checkout tag.
7. **Holiday iCal feed** (per-user secret URL) for Google/Apple Calendar.
8. **Own attendance export** (XLSX/PDF) for any month.
9. **Birthday / work-anniversary reminders** on Home (opt-in field).
10. **Overtime / comp-off request**: hours beyond the checkout extension can be claimed; HR approves and credits a comp-off leave balance.
11. **Command search** (Ctrl/⌘-K) for HR/Admin on desktop: jump to employee or screen.

---

## 8. Free-tier budget (≈20 employees)

| Service | Free limit | Our use | Note |
|---|---|---|---|
| Vercel Hobby | 100 GB bandwidth, 1M edge requests | < 5 GB (API is proxied through Vercel), ~100k proxy requests | Owner accepted the Hobby non-commercial clause. Cloudflare Pages stays a possible fallback. |
| Render Free | 512 MB RAM, 750 h/month, sleeps after 15 min | ~25 MB RAM, 744 h (24/7) | UptimeRobot pings `/healthz` every 5 min. The eSSL machine's `getrequest` polling also keeps it awake. **Only one free web service fits in 750 h.** |
| Supabase Free | 500 MB DB, pauses after 7 idle days | < 100 MB | Keep-alive job. No daily backups → GitHub Action `pg_dump` weekly to R2. |
| Cloudflare | Workers 100k req/day, R2 10 GB | device ~3k req/day, files < 1 GB | Free `workers.dev` subdomain, no domain needed (see K6 for the HTTP check). Total cost: ₹0. |
| UptimeRobot | 50 monitors, 5-min interval | 2 monitors (`/healthz`, web) | |

Render builds: compiling Rust on the free builder is slow and can hit memory limits. **Build the Docker image in GitHub Actions →
push to GHCR → Render deploys the image.** Release profile: `lto="thin"`, `codegen-units=1`, `strip=true`.

---

## 9. Environment (`.env.example`, shared by both apps)

```
# web — public
NEXT_PUBLIC_VAPID_PUBLIC_KEY=
# web — server only (Vercel)
API_ORIGIN=https://web-hrms-api.onrender.com
PROXY_SECRET=               # >= 32 chars, same value on Render
# server (Render)
DATABASE_URL=postgres://...new supabase project pooler (session mode, 5432)...
DATABASE_MAX_CONNECTIONS=5
APP_ORIGIN=https://web-hrms.vercel.app
APP_SECRET=                 # >= 32 chars; keys IP hashes (sessions are opaque cookies, not JWTs)
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:<admin contact>
WEBAUTHN_RP_ID=web-hrms.vercel.app
R2_ACCOUNT_ID=  R2_ACCESS_KEY_ID=  R2_SECRET_ACCESS_KEY=  R2_BUCKET=
DEVICE_INGEST_SECRET=       # >= 32 chars, stored hashed in DB
DEVICE_RELAY_SECRET=        # >= 32 chars, same in Worker
ORG_TIMEZONE=Asia/Kolkata
# one-time bootstrap
ORG_CODE=  ORG_NAME=  ADMIN_EMPLOYEE_CODE=  ADMIN_NAME=  ADMIN_PASSWORD=
```
`.gitignore` covers `.env*` except `.env.example`, `target/`, `node_modules/`, `.next/`, `backups/`, `.wrangler/`.

---

## 10. Phases (each ends green: tests + build)

| Phase | Deliverable | Done when |
|---|---|---|
| P0 Scaffold ✅ 2026-11-13 | Folder tree, workspaces, `.gitignore`, `.env.example`/`.env.local`, CI, Dockerfile, `/healthz`, Vercel→Render proxy, PWA manifest + SW | 9 Rust tests, clippy, ESLint, tsc and `next build` pass. Proxy verified end-to-end. Image 46 MB, ~2.3 MB idle RAM |
| P1 DB ✅ 2026-11-14 | 42 ported migrations (HRMS + fingertipssl, zero logic changes via the `iam` shim) + 6 web-hrms migrations (device bridge, live events, Web Push tokens, sessions, jobs) | 27 SQL suites, 991 assertions on the Supabase Postgres 17 image |
| P2 Auth ✅ 2026-11-14 | Opaque `__Host-` cookie sessions (no JWT/refresh tokens: revocation is instant), argon2id, login/logout, password change gate, reauth grants, rate limits, provisioning + reset, RPC gateway, Origin/CSRF checks, job scheduler, `bootstrap` | 33 unit + 28 API tests against a real DB (sqlx migrations, cookies, CSRF, rate limits, saga, RBAC) |
| P3 Shell + design ✅ 2026-11-14 | Tokens, jelly nav, cards, Action scopes, Explore accordion, login/password/settings (devices) screens, session gate, API client | 68 Vitest tests (gate, RBAC menus, forms, API errors); 390×844 screenshots checked; full stack smoke test through the proxy |
| P4 Attendance | PWA punch (geo + passkey + IP), calendar, day detail, corrections, late/WFH requests, hours report | Punch rules tests; late/deduction tests ✅ 2026-11-14 |
| P5 eSSL | Rust iclock port + Worker + today/live/unmatched/devices screens + commands | Ported `protocol.test.ts` cases + simulator end-to-end ✅ 2026-11-14 (real machine on LAN: needs the owner's device) |
| P6 Leave & approvals | Leave apply/edit with live server preview (half days, balance after, conflicts), balances, holiday calendar, My requests (withdraw, cancel, edit & resubmit), review queue (scopes, filters, keyset paging), review detail (approve/return/reject, withdrawal and cancellation decisions, Admin fallback, reassign) | Ported leave/approval pgTAP + 97 new Vitest tests (stale versions, idempotent retry, reason rules, paging, RBAC) + browser e2e apply → approve → cancel → balance restored ✅ 2026-11-14 (leave types that need a document wait for P7 uploads) |
| P7 People & payroll | Private file storage (local folder or R2, SigV4, write-once), audited file viewer, profile + photo + personal-details change request, directory, employees list/new/detail (work, assignment, access, personal, status, reset password, salary, payslips, documents, phones, leave adjust, schedule change)/Excel+CSV import, salary, bank-detail change with proof, payslips, payslip upload/publish, documents + company policies, leave attachments | 5 MB/MIME/PDF/sha + storage + machine-photo API tests, bank-proof API test (found and fixed: proof never became current version), 115 new Vitest tests, browser e2e new hire → payslip publish → employee view → document → photo → bank change → import ✅ 2026-11-14 |
| P8 Admin | Org, offices, shifts, teams, roles, policies, holidays, outside-work, Sheet sync, audit, archive/cleanup | Admin-only tests; last-admin guard |
| P9 Notifications | Outbox → Web Push + inbox + SSE + preferences | Push delivered on Android Chrome, desktop, installed iOS |
| P10 New features | §7 items 3–11 | Each has tests |
| P11 Deploy | New Supabase project, R2, Render (GHCR image), Vercel, Worker on workers.dev, UptimeRobot, `bootstrap` first Admin | Production smoke test checklist in `DEPLOY.md` |

---

## 11. Resolved (2026-11-13)

| Question | Answer | Effect |
|---|---|---|
| Domain | None | K6 workers.dev relay, K7 same-origin proxy through Vercel |
| Existing data | Start fresh | `bootstrap` binary; new Supabase project; no import |
| Vercel Hobby | Stay | Accepted |
| Android app | On hold, delete nothing | `../hrms` and its backend untouched; this repo never writes outside `web-hrms/` |

Remaining risk to check early: whether `workers.dev` accepts plain HTTP (first task of P5). If not, a ~₹800/yr domain is needed.
