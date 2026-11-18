# Deploying web-hrms (free tier, no domain)

Everything below runs on free plans: **Supabase** (Postgres), **Cloudflare R2**
(files) and a **Worker** (attendance-machine relay), **Render** (Rust API),
**Vercel** (web app and API proxy) and **UptimeRobot** (keeps Render awake).
The existing HRMS app and its Supabase project are not touched: web-hrms uses
a **new** Supabase project.

```
browser ──HTTPS──▶ Vercel (Next.js, /api/* proxy + PROXY_SECRET) ──▶ Render (Rust API) ──▶ Supabase Postgres
eSSL machine ─HTTP─▶ Cloudflare Worker relay/ ──HTTPS──▶ Render /iclock/*          └──▶ Cloudflare R2 (files)
```

Order matters: database → secrets → R2 → Render → Vercel → Worker → UptimeRobot → first Admin → smoke test.

---

## 0. Secrets

Generate every secret fresh for production. **Never reuse values from `.env.local`.**

```sh
openssl rand -base64 48 | tr -d '\n=+/' ; echo     # run once per secret
```

| Name | Where | Notes |
|---|---|---|
| `PROXY_SECRET` | Vercel **and** Render | Same value on both. ≥ 32 chars. |
| `APP_SECRET` | Render | ≥ 32 chars, different from `PROXY_SECRET`. Keys rate-limit IP hashes **and seals two-step (TOTP) secrets**. Changing it later turns off everyone's two-step sign-in (they cannot sign in with codes until an Admin resets it), so set it once and keep a copy in a password manager. |
| `DEVICE_INGEST_SECRET` | Render | ≥ 32 chars. Stored hashed in the DB. |
| `DEVICE_RELAY_SECRET` | Render **and** Worker | Same value on both. |
| `VAPID_PRIVATE_KEY` | Render | See §0.1. |
| `FCM_SERVICE_ACCOUNT_JSON`, `FCM_PROJECT_ID` | Render | Optional, only for the native mobile apps. See §0.2. |

### 0.1 Web Push (VAPID) key

```sh
openssl ecparam -name prime256v1 -genkey -noout -out vapid.pem
openssl ec -in vapid.pem -outform DER | tail -c +8 | head -c 32 | base64 | tr '+/' '-_' | tr -d '=\n' ; echo
```

The printed 43-character value is `VAPID_PRIVATE_KEY`. Set `VAPID_SUBJECT` to
`mailto:` + an inbox the push services may contact (a shared ops address, not a
personal one). The browser reads the public key from `GET /v1/push/config`, so
nothing push-related is set on Vercel. Store `vapid.pem` in a password manager,
then delete the file. Rotating the key makes every browser re-subscribe.

### 0.2 Firebase Cloud Messaging (native mobile apps only)

Browsers and the installed PWA use Web Push (§0.1). FCM is only for the
Android/iOS apps, which register their FCM token with
`register_push_token(.., 'android' | 'ios')`.

1. Firebase console → Project settings → **Cloud Messaging**: "Firebase Cloud
   Messaging API (V1)" must say *Enabled*.
2. Project settings → **Service accounts** → *Generate new private key*.
3. On Render set `FCM_SERVICE_ACCOUNT_JSON` to the file as base64 and
   `FCM_PROJECT_ID` to the project ID (e.g. `hrms-26469`). PowerShell:
   `[Convert]::ToBase64String([IO.File]::ReadAllBytes("firebase-key.json")) | Set-Clipboard`
4. Store the file in a password manager, then delete it. The start-up log says
   `FCM push for the mobile apps is on`; a wrong key logs
   `FCM misconfigured, mobile-app push is off: …` and the API keeps running.
5. iOS also needs an APNs auth key (`.p8`) uploaded under Cloud Messaging →
   Apple app configuration.

---

## 1. Supabase (database only)

1. supabase.com → **New project** (region: Mumbai / `ap-south-1`). Save the database password.
2. Project Settings → Database → **Connection string → Session pooler (port 5432)**. This is `DATABASE_URL`.
   - Use **session mode (5432)**, not transaction mode (6543): live updates use `LISTEN/NOTIFY` and the
     server keeps prepared statements; both need a session connection.
   - Keep `DATABASE_MAX_CONNECTIONS=5` (free pooler limit is shared).
3. No SQL to run by hand: the API applies all migrations at start-up (sqlx, embedded in the binary).
4. Free projects **pause after 7 idle days**. The API's background jobs and the UptimeRobot pings keep it
   active. If it ever pauses, restore it from the dashboard; no data is lost.
5. Backups: the free plan has none. Add a weekly `pg_dump` (GitHub Action or your laptop) to R2 or another
   private place.

## 2. Cloudflare R2 (files)

1. Cloudflare dashboard → R2 → **Create bucket** (e.g. `web-hrms-files`). Keep it **private** (no public access, no custom domain).
2. R2 → **Manage API tokens → Create token**: *Object Read & Write*, limited to this bucket.
3. Note `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
4. Never set `FILE_STORE_DIR` in production (local-folder storage is for development only).

## 3. Render (Rust API)

The image is built by GitHub Actions (`.github/workflows/server-image.yml`), not on Render's small builder.

1. Push the repo to GitHub. The **Server image** workflow builds and pushes
   `ghcr.io/<owner>/web-hrms-server:latest` on every push to `main` that touches `server/`.
2. GitHub → Packages → `web-hrms-server` → Package settings → make it **public**, or give Render a
   registry credential for GHCR.
3. In `render.yaml` replace `OWNER` with your GitHub user, then Render → **New → Blueprint** → this repo.
4. Fill the environment variables on the `web-hrms-api` service:

   | Variable | Value |
   |---|---|
   | `APP_ORIGIN` | `https://<project>.vercel.app` (exact, no trailing slash) |
   | `PROXY_SECRET`, `APP_SECRET` | from §0 |
   | `DATABASE_URL`, `DATABASE_MAX_CONNECTIONS` | from §1 |
   | `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | from §0.1 |
   | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` | from §2 |
   | `DEVICE_INGEST_SECRET`, `DEVICE_RELAY_SECRET` | from §0 |
   | `ORG_TIMEZONE` | `Asia/Kolkata` |
   | `ALIAS_DOMAIN` | `staff.hrms.invalid` (internal login alias, never a mailbox) |
   | `RUST_LOG`, `LOG_FORMAT` | already in `render.yaml` |

   `PORT` is injected by Render. `WEBAUTHN_RP_ID` is not needed: passkeys use `APP_ORIGIN`'s host.
5. Render → service → Settings → **Deploy hook** → copy the URL into the GitHub repo secret
   `RENDER_DEPLOY_HOOK_URL`. Each image build then redeploys Render.
6. Check: `https://web-hrms-api.onrender.com/healthz` returns `ok`. Every `/v1/*` path answers **404**
   when called directly: it only works through Vercel (proxy secret). That is intended.
7. Render free = 512 MB RAM and **one** always-on service fits in 750 h/month. Do not add a second free service.

## 4. Vercel (web app + API proxy)

1. vercel.com → **Add New → Project** → import the repo. Root directory: `web`. Framework: Next.js.
2. Environment variables (Production):

   | Variable | Value |
   |---|---|
   | `API_ORIGIN` | `https://web-hrms-api.onrender.com` |
   | `PROXY_SECRET` | same as Render |

   No `NEXT_PUBLIC_*` variables are needed.
3. Deploy. The project URL (`https://<project>.vercel.app`) must equal Render's `APP_ORIGIN`; if Vercel gives
   a different name, update `APP_ORIGIN` on Render and redeploy it.
4. Limits to know:
   - **Uploads over the proxy are capped at 4.5 MB by Vercel.** The app caps files at 5 MB, so a file between
     4.5 and 5 MB fails at Vercel with 413. Ask people to keep scans under 4.5 MB (photos are resized in the
     browser).
   - Hobby plan: personal / non-commercial use (owner accepted).
5. Calendar feed links (`/api/v1/calendar/<token>.ics`) go through the same proxy; calendar apps need no cookies.

## 5. Attendance machines (Cloudflare Worker relay)

eSSL machines speak plain HTTP and cannot reach Render's HTTPS-only URL, so they go through the Worker in `relay/`.

```sh
cd relay
npx wrangler login
npx wrangler secret put DEVICE_RELAY_SECRET     # same value as Render
# API_ORIGIN is in wrangler.toml [vars]; change it if your Render URL differs
npx wrangler deploy
```

On the machine (Comm → Cloud server): **server address** `hrms-device.<account>.workers.dev`, **port 80**,
HTTPS off. In the app, Admin → Devices → register the machine's serial number (unknown serials are refused).
The machine's own polling (`getrequest`) also keeps Render awake during office hours.

## 6. UptimeRobot

Two free HTTP monitors, 5-minute interval:

1. `https://web-hrms-api.onrender.com/healthz` (keeps Render from sleeping; alerts when the API is down).
2. `https://<project>.vercel.app/login` (web app).

Send alerts to a shared ops address.

## 7. First Admin (one time)

Run the bootstrap **from your laptop** against the production database. It creates the organisation and the
first Admin, never resets an existing Admin, and is safe to run again.

```sh
cd server
DATABASE_URL='<session pooler URL>' \
ORG_CODE=ACME ORG_NAME='Acme Pvt Ltd' ORG_TIMEZONE=Asia/Kolkata ALIAS_DOMAIN=staff.hrms.invalid \
ADMIN_EMPLOYEE_CODE=ADMIN1 ADMIN_NAME='First Admin' ADMIN_PASSWORD='<temporary, long>' \
cargo run --release --bin bootstrap
```

Then clear your shell history line (or prefix the command with a space if `HISTCONTROL=ignorespace`). Sign in
at the Vercel URL with `ADMIN1` and the temporary password: the app forces a new password at once. **Turn on
two-step sign-in** for this account (Settings → Two-step sign-in) and keep the recovery codes offline.
If the only Admin loses both phone and codes, there is no in-app reset: an operator must run
`select iam.totp_disable(auth_user_id) from hrms.employees where employee_code = 'ADMIN1';` in the Supabase
SQL editor.

## 8. Production smoke test

Tick each on a phone (Android Chrome) **and** a desktop browser.

**Sign-in and security**
- [ ] `/healthz` is `ok`; `https://web-hrms-api.onrender.com/v1/ping` is **404** (no proxy secret).
- [ ] Sign in as `ADMIN1`; the temporary password must be changed; the old password stops working.
- [ ] Two-step: turn on, sign out, sign in with the code; a used code is refused the second time; a recovery code works once.
- [ ] Wrong password 5 times locks for a while with the same generic message.
- [ ] Settings → Devices lists this session; "Sign out other devices" works.

**People and files**
- [ ] Admin → Employees → New: create an HR user and an employee; each signs in and changes the password.
- [ ] Upload a profile photo and a 1–4 MB PDF payslip; both open from R2; the employee sees only their own.
- [ ] Bank-detail change with proof → HR approves → change appears.

**Attendance**
- [ ] Admin → Offices: set the office location and radius (and office Wi-Fi/IP if used).
- [ ] Employee punches in at the office (location + passkey) and out; the day shows correct hours.
- [ ] Outside the radius the punch is refused with a clear reason.
- [ ] Forgot check-out: the "Fix check-out" link opens the correction form with the check-in prefilled.
- [ ] My attendance → Download Excel opens in Excel/Sheets; Print / PDF prints one month.
- [ ] eSSL machine: register serial, punch a finger, the punch appears in Today/Live within a minute.

**Leave and requests**
- [ ] Apply leave → HR approves → balance drops; cancel → balance restored.
- [ ] Late arrival, work from home and comp-off requests reach HR and apply on approval (comp-off adds a "Comp off" balance).
- [ ] Holidays → publish one; the employee's calendar feed (Settings → Calendar subscription) shows it in Google Calendar within a few hours.

**Notifications**
- [ ] Settings → Notifications → Turn on → Send a test: the push arrives on Android Chrome, desktop Chrome/Edge/Firefox, and an iPhone **with HRMS added to the Home Screen** (iOS 16.4+). Headless/automated browsers cannot test this.
- [ ] Quiet hours and muted categories stop pop-ups but the in-app inbox still fills.

**Admin**
- [ ] Roles: giving someone Admin asks for your password again.
- [ ] Audit log shows the actions above; background jobs page shows recent runs.
- [ ] Annual archive builds and verifies in the browser (try with a small date range first).

**Uptime**
- [ ] UptimeRobot shows both monitors up; after 30 idle minutes the app still opens without a cold-start wait.

## 9. Updating

- API: push to `main` → GitHub builds the image → deploy hook → Render pulls it → migrations run on start.
  Migrations are forward-only; never edit one that has reached production, add a new one.
- Web: push to `main` → Vercel builds automatically.
- Worker: `cd relay && npx wrangler deploy`.

## 10. Rotating secrets

| Secret | How |
|---|---|
| `PROXY_SECRET` | Set the new value on Render and Vercel, redeploy both (a minute of 404s in between). |
| `DEVICE_RELAY_SECRET` | Render + `wrangler secret put`, then redeploy both. |
| `DEVICE_INGEST_SECRET` | Render only; the server re-hashes it on start. |
| `VAPID_PRIVATE_KEY` | Render; browsers re-subscribe the next time people open Notification settings. |
| `FCM_SERVICE_ACCOUNT_JSON` | Generate a new key (Firebase → Service accounts), set it on Render, redeploy, then delete the old key in Google Cloud → IAM → Service accounts → Keys. Device tokens stay valid. |
| `APP_SECRET` | Avoid. It also seals two-step secrets, so everyone with two-step on must be reset by an Admin. Rate-limit windows also reset. |
| Database password | Supabase → reset password → update `DATABASE_URL` on Render. |
