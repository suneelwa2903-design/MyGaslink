# AWS Pre-Deployment Assessment & Checklist — Re-New GasLink

> **Document type:** Comprehensive read-only assessment. No code was changed to produce this.
> **Generated:** 2026-05-25
> **Scope:** Root monorepo (`packages/api`, `packages/web`, `packages/mobile`). The legacy
> `New_GasLink/` subfolder was read only to extract prior AWS experience (Step 1).
> **Severity legend:** 🔴 **CRITICAL** = must fix before going live · 🟡 **RECOMMENDED** = should do, not blocking · 🟢 **GOOD** = already in good shape.

---

## Executive Summary

Re-New GasLink is an LPG-distribution SaaS monorepo:
- **API** — Express 5 + TypeScript (ESM) + Prisma 6 + PostgreSQL (`packages/api`)
- **Web** — React 19 + Vite 7 + Tailwind + Zustand (`packages/web`)
- **Mobile** — React Native + Expo 54 (`packages/mobile`)

The target AWS topology is **already encoded in the repo** (`.github/workflows/ci.yml`, `docker-compose.prod.yml`, Dockerfiles): **web → S3 + CloudFront, API → EC2 + PM2, database → PostgreSQL (RDS), region `ap-south-1`**. A previous iteration of this product was already deployed to AWS in `ap-south-1` (single EC2 `t3.micro` + RDS Postgres + S3 static website) — its lessons are captured below and shape the recommendations.

**The good news:** the codebase is in solid security shape. JWT auth in header (no CSRF surface), Helmet enabled, bcrypt(12) password hashing, per-endpoint auth rate limiting, strict multi-tenant isolation, Prisma everywhere (no SQL injection), no analytics/tracking SDKs, and the previously-found gst-documents IDOR is confirmed fixed. **There are no CRITICAL code-security findings.**

**The blockers** are infrastructure and data-governance items, not application bugs:
1. 🔴 GST credentials + refresh tokens stored in plaintext columns → require RDS encryption-at-rest (and ideally app-level/KMS encryption).
2. 🔴 No HTTPS/TLS anywhere in the app — must be terminated at the edge (ALB/CloudFront/ACM) before any real customer data flows.
3. 🔴 Production env vars must be set (`DATABASE_URL`, both JWT secrets, `CORS_ORIGINS`) — `validateEnv()` hard-fails the boot without them, which is good, but they must be provisioned.
4. 🟡 No data-retention / erasure mechanism (GST payloads, audit logs, soft-deleted PII retained indefinitely).
5. 🟡 Dependency patches: bump `nodemailer` (≥8.0.4) and `qs` (≥6.15.2).

---

## STEP 1 — Legacy AWS Setup (lessons from `New_GasLink/`)

The prior iteration (`New_GasLink/`) was a **pre-monorepo** stack: plain Node/Express (CommonJS `app.cjs`), **Firebase Admin** auth, raw `pg` pool, Python OCR in a `.venv`, separate `frontend/` + `backend/`. It was actually deployed to AWS. Two doc layers exist: an aspirational `AWS_DEPLOYMENT_GUIDE.md` (us-east-1, ALB, CloudFront) and the **real** deployment (ap-south-1, single EC2, S3 website, no ALB/CloudFront).

### What was actually deployed
| Service | Reality | Notes |
|---|---|---|
| **Region** | `ap-south-1` (Mumbai) | Guide said us-east-1 — ignore |
| **EC2** | single `t3.micro`, Amazon Linux | RAM too tight → OOM; mitigated with 2 GB swap + `--max_old_space_size=512` |
| **RDS** | PostgreSQL **17**, `gaslink-db`, forced SSL (`rds.force_ssl=1`) | manual schema dump (74 tables) |
| **S3** | `gaslink-frontend-prod` as **static website** | public-read, `index.html` as both index + error doc (SPA fallback) |
| **CloudWatch** | agent config existed, marked pending | log group `/aws/ec2/gaslink-api` |
| **CloudFront / Route53 / ACM / ALB / Elastic IP** | **NOT deployed** | no custom domain, **no HTTPS on backend** (plain `http://IP:5000`) |
| **Redis** | local on EC2 (not ElastiCache) | |

### Server layout & deploy process
- Code at `~/new_gaslink` (scripts/CI assumed `/opt/gaslink` — **path mismatch**, CI would have failed as-is; real path was manual PowerShell scripts).
- API run by **PM2** (`gaslink-api`, fork mode) with `pm2 startup systemd` + `pm2 save` for boot persistence.
- Deploy = SSH in → `git stash` `.env` → `git pull` → `git stash pop` → `pm2 restart --update-env`. Frontend = local `npm run build` → `aws s3 sync dist/ s3://... --delete`.

### Pain points (the valuable lessons — design these out from the start)
1. **RDS SSL hell (~3 hrs):** `self-signed certificate in chain`. Fix was `ssl: { rejectUnauthorized: false }` **and** dropping a conflicting `?sslmode=require`. → For Prisma, use `?sslmode=require` with the RDS CA bundle, or `sslmode=no-verify` as a pragmatic fallback.
2. **CORS:** S3 origin missing from allowed origins; the S3 website URL dash-vs-dot format (`s3-website-ap-south-1` vs `s3-website.ap-south-1`) bit them.
3. **SPA 404 on refresh:** solved with S3 error document = `index.html` (and CloudFront custom error response → `/index.html` 200).
4. **OOM on t3.micro:** needed swap + Node heap cap + PM2 `max_memory_restart`. → **Use t3.small minimum** for the new stack.
5. **Ephemeral public IP:** frontend hard-coded the EC2 public IP; any stop/start broke the app. → **Elastic IP from day one** (or never call EC2 directly — go through CloudFront/domain).
6. **`.env` clobbered by `git pull`** → store prod env outside the repo working tree.
7. **No TLS anywhere in prod** — both S3 and backend were plain HTTP.

### What carries over vs. what doesn't
- **Carries over:** the topology (EC2 + PM2 + nginx reverse proxy + RDS Postgres + S3 static web), `ap-south-1`, RDS SSL handling, PM2 memory cap discipline, S3 SPA fallback, CORS-origin discipline, the GitHub Actions skeleton.
- **Does NOT carry over:** Firebase auth (now JWT), Python OCR, CommonJS/raw `pg` (now ESM + Prisma), `npm` (now `pnpm`), manual schema dump (now `prisma migrate deploy`). The deploy must switch to `pnpm` + `prisma migrate deploy` + per-package build paths, and **add Elastic IP + ACM/HTTPS from the start**.

---

## STEP 2 — Current Project Infrastructure Config

### CI/CD — already defined (`.github/workflows/`, repo root)
- **`ci.yml`**: `lint-and-typecheck` → `test` (spins Postgres 17 service, `db:generate`/`migrate`/`seed`, `pnpm test`) → `build` (uploads `packages/web/dist`) → env-gated deploys:
  - `deploy-staging` (branch `develop`): S3 sync → `S3_BUCKET_STAGING`, CloudFront invalidation, SSH to `EC2_HOST_STAGING` → `cd /opt/gaslink`, git pull, pnpm install, `db:migrate:prod`, build, `pm2 restart gaslink-api`.
  - `deploy-production` (branch `master`): same against PRODUCTION secrets, default region `ap-south-1`.
  - `backup` (after prod deploy): SSH runs `scripts/backup.sh`, uploads dump to `S3_BACKUP_BUCKET`.
- **`e2e-monitor.yml`**: nightly cron (21:00 UTC), runs `scripts/e2e-monitor.ts`, emails + opens GitHub issue on failure.
- ⚠️ The workflow hard-codes `/opt/gaslink` and PM2 name `gaslink-api`, entry `packages/api/dist/server.js`. **Reconcile the deploy path** (`/opt/gaslink`) when provisioning EC2 — the legacy stack hit exactly this mismatch.

### Containerization (parallel option to EC2/PM2)
- `docker-compose.yml` — **dev only**: `postgres:17-alpine`, host port **5433→5432**, db/user/pass `gaslink`/`gaslink`/`gaslink_dev`. (`pnpm docker:up`)
- `docker-compose.prod.yml` — 3 services: `postgres`, `api` (from `packages/api/Dockerfile`, port 5000, healthcheck `/api/health`), `web` (from `packages/web/Dockerfile`, nginx, port `${WEB_PORT:-80}`).
- `packages/api/Dockerfile` — multi-stage node:22-alpine, pnpm 9.15.0, runs `node packages/api/dist/server.js`, EXPOSE 5000.
- `packages/web/Dockerfile` — multi-stage, `nginx:alpine` serving `dist` with `packages/web/nginx.conf` (SPA fallback + gzip + 1-yr asset cache + `/api/` proxy to `http://api:5000`).

### Build config
- **`vite.config.ts`**: outDir `dist`, base `/`, sourcemaps off, dev port 5173 with proxy `/api → http://localhost:5000`.
- **`packages/api/package.json`**: `"type":"module"`, entry `dist/server.js`. Scripts: `build` (`tsc`), `start` (`node dist/server.js`), `db:migrate:prod` (`prisma migrate deploy`), `db:seed` (`tsx prisma/seed.ts`).
- **`prisma/schema.prisma`**: `provider = "postgresql"`, `url = env("DATABASE_URL")`. **13 migrations** present (init `20260323000000` → `20260524100000_wi127_order_dispute_fields`). *(CLAUDE.md says "single migration" — stale; it's 13.)*

### Server entry (`server.ts` / `app.ts`)
- **Port:** `PORT` env or `5000`. **Host:** `HOST` env, else `127.0.0.1` in prod / `0.0.0.0` in dev (assumes a local reverse proxy in prod).
  - 🟡 **If deploying API directly on EC2 without a local nginx, set `HOST=0.0.0.0`** — otherwise the API only listens on loopback and the security group won't help.
- Boots via `validateEnv()`; graceful SIGTERM/SIGINT shutdown; in-process node-cron overdue-invoice job.
- **Middleware order:** requestId → helmet → cors → global rate-limit (1000/15min) → json/urlencoded (10 mb) → logger → routes → swagger → 404 → Sentry handler.
- **CORS:** `CORS_ORIGINS` (comma-split, default `http://localhost:5173`), `credentials: true`, allows `X-Distributor-Id`.

### Complete API environment variable list (all must be considered for EC2)
| Var | Required | Default | Purpose |
|---|---|---|---|
| `DATABASE_URL` | 🔴 **YES (always hard-fails)** | none | Postgres connection (Prisma) |
| `NODE_ENV` | Strongly recommended | `development` | Gates prod hardening, `/test` routes, Sentry |
| `PORT` | No | `5000` | Listen port |
| `HOST` | No | prod `127.0.0.1` / dev `0.0.0.0` | **Set `0.0.0.0` on EC2 if no local nginx** |
| `CORS_ORIGINS` | 🔴 **YES in prod** | `http://localhost:5173` | Comma-separated allowed origins (web + any custom domain) |
| `JWT_ACCESS_SECRET` | 🔴 **YES in prod (must differ from dev default)** | dev default | Access token signing |
| `JWT_REFRESH_SECRET` | 🔴 **YES in prod (must differ from dev default)** | dev default | Refresh token signing |
| `SMTP_HOST` | For email | `''` | Email host (→ SES, see Step 6) |
| `SMTP_PORT` | No | `587` | Email port |
| `SMTP_USER` | For email | `''` | Email login |
| `SMTP_PASS` | For email | `''` | Email password |
| `SMTP_FROM` | No | `noreply@mygaslink.com` | From address (must be SES-verified) |
| `CONTACT_FORM_EMAIL` | No | `info@mygaslink.com` | Contact-form recipient |
| `GASLINK_GST_CLIENT_ID` | For GST | `''` | WhiteBooks client id |
| `GASLINK_GST_CLIENT_SECRET` | For GST | `''` | WhiteBooks client secret |
| `GASLINK_GST_USERNAME` | For GST | `''` | WhiteBooks username |
| `GASLINK_GST_GSTIN` | For GST | `''` | Platform GSTIN |
| `GASLINK_GST_SANDBOX` | No | unset (false) | `'true'` → GST sandbox |
| `AWS_REGION` | No | `ap-south-1` | AWS region (app-side) |
| `AWS_S3_BUCKET` | No | `''` | App-side S3 bucket (if used for uploads) |
| `AWS_CLOUDFRONT_URL` | No | `''` | CloudFront URL |
| `SENTRY_DSN` | No | unset | Sentry (inits only if prod + set) |
| `INVENTORY_DISPATCH_DEBIT` | No | unset | Feature flag (mostly tests) |

**Web (build-time `import.meta.env`):** `VITE_API_URL` (default `/api` — **this is what the code reads**), `VITE_SENTRY_DSN`, `VITE_APP_VERSION`.
- 🟡 **Build-arg mismatch:** the web Dockerfile + `docker-compose.prod.yml` inject `VITE_API_BASE_URL`, but the app reads `VITE_API_URL`. The Docker build arg is effectively dead (bundle falls back to `/api`). Harmless if you intend `/api` behind nginx/CloudFront, but the intended override silently won't work. Fix before relying on it.

**Mobile (`EXPO_PUBLIC_*`, set in `eas.json`/`.env`):** `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_SENTRY_DSN`.

---

## STEP 3 — Security Audit

| Area | Verdict | Detail |
|---|---|---|
| **3A Headers/XSS** | 🟢 / 🟡 | Helmet enabled globally (`app.ts:47`). **No explicit CSP** — Helmet defaults only. Web: **zero** `dangerouslySetInnerHTML`/`innerHTML` — clean. 🟡 Define explicit CSP at the CloudFront/web edge. |
| **3B CSRF** | 🟢 N/A | JWT in `Authorization: Bearer` header (`auth.ts`), stored in Zustand→localStorage (`authStore.ts`), **no cookies**. Classic CSRF does not apply. (`cors credentials:true` is set but unused — could be tightened.) 🟡 localStorage tokens are XSS-exfiltratable — mitigated by clean XSS posture. |
| **3C SQL injection** | 🟢 | Prisma throughout. Only raw SQL: `health.ts:12` `$queryRaw\`SELECT 1\`` (no input) and one parameterized test. No `$queryRawUnsafe`/concatenation in prod. |
| **3D Auth** | 🟢 / 🟡 | JWT dev fallback exists but **prod hard-gated** by `validateEnv()` → `process.exit(1)` (`config/index.ts`). Access `15m` / refresh `7d`. bcryptjs **SALT_ROUNDS=12**; OTPs bcrypt-hashed. Rate limits: login 10/15min, refresh 30/15min, forgot-password+verify-otp 5/15min. 🟡 **`POST /auth/reset-password` has no dedicated limiter** — add `forgotPasswordLimiter`. |
| **3E IDOR / multi-tenant** | 🟢 | All tenant routes go through `authenticate → resolveDistributor → requireDistributor`. `distributorId` always from JWT, never body. By-id `findUnique` calls are followed by explicit `distributorId` ownership checks or relation-scoped. **gst-documents IDOR confirmed fixed** (`invoices.ts:268-290`). |
| **3F Log leaks** | 🟢 | No prod log interpolates password/token/secret/JWT. Plaintext OTP log is `if (config.isDev)`-gated only. Prod error handler returns generic message. |
| **3G Dependencies** | 🟡 | `pnpm audit`: **36 vulns (19 high, 16 moderate, 1 low), no critical.** Most highs are in **build/test/mobile tooling** (expo CLI, vitest, jest-expo) — not the deployed API path. Live-surface items: **`qs`** (moderate, via Express 5) and **`nodemailer@7.0.13`** (low, SMTP command injection — directly used). 🟡 Bump `nodemailer`≥8.0.4 and `qs`≥6.15.2. |

**No CRITICAL code-security findings.** Lowest-effort/highest-value pre-deploy fixes: bump `nodemailer`+`qs`, add a rate limiter on `/auth/reset-password`, and set an explicit CSP at the web edge.

---

## STEP 4 — Privacy & Data Policy

### 4A — Personal data stored (45-model schema)
- **Distributor**: businessName, legalName, gstin, addresses, phone, email, geo.
- **User**: email, name, phone, role, **passwordHash**, **refreshToken (plaintext)**, **resetOtp (hashed)**, loginAttempts, lockedUntil.
- **Customer** (highest-volume PII): customerName, businessName, gstin, phone, email, full billing + shipping addresses, creditPeriodDays.
- **CustomerContact**: name, phone, email.
- **Driver**: driverName, phone, **licenseNumber (govt ID)**, employmentType.
- **Order**: delivery lat/long (customer geolocation), notes, dispute reasons.
- **Financial**: Invoice (amounts, irn, ackNo), InvoiceItem, CreditNote, DebitNote, **PaymentTransaction** (amount, method, cheque/UPI/txn refs), PaymentAllocation, CustomerLedgerEntry, PaymentCommitment.
- **GstCredential**: clientId, **clientSecret**, username, **password**, gstin, email, **tokenCache** (third-party secrets).
- **GstDocument / GstApiLog**: full request/response JSON (names, GSTINs, addresses, amounts).
- **AuditLog**: userId, ipAddress, userAgent. **License**: licenseNumber, documentUrl (PAN/cancelled-cheque doc types). **ContactSubmission** (leads): name, phone, email, agencyName, monthlySale.
- No bank account-number column; bank details only as a License `documentUrl` pointer + PaymentTransaction reference.

### 4B — Retention & deletion
- **Soft delete** (`deletedAt`): Distributor, User, Customer, Order, Invoice, PaymentTransaction, Driver, Vehicle, GstDocument. Queries filter `deletedAt: null`.
- **Hard delete**: only child/config rows (customerContact, orderItem, inventoryEvent, driverVehicleAssignment, cylinderPrice, distributorSetting, license) — never core PII entities.
- 🟡 **No retention policy / purge job.** The only cron is the overdue-invoice flipper. GST payloads, audit logs, soft-deleted PII, and stale leads are retained **indefinitely**. Gap for any right-to-erasure / retention requirement — plan a purge/anonymization job.

### 4C — Encryption at rest
- 🟢 Passwords bcrypt(12); reset OTP bcrypt-hashed; OTP via `crypto.randomInt`.
- 🔴 **GST credentials stored PLAINTEXT** — `gst_credentials.clientSecret`, `password`, `tokenCache` are plain String columns, read raw. No app-level encryption exists anywhere (`crypto` used only for OTP randomness). `User.refreshToken` also plaintext.
- **DB-level encryption is infra:** enable **RDS storage encryption** (KMS) on the instance + snapshots. Consider additionally encrypting `gst_credentials` columns at the app layer (KMS/envelope) given they unlock a tax-filing API.

### 4D — Data in transit
- 🔴 **No HTTPS enforcement in app code** — `helmet()` defaults only, no explicit HSTS config, no HTTP→HTTPS redirect. TLS must be terminated at the edge (ALB/CloudFront + ACM) and HSTS set there.
- 🟢 **No outbound plain HTTP.** WhiteBooks client uses HTTPS for both sandbox (`https://apisandbox.whitebooks.in`) and prod (`https://api.whitebooks.in`), chosen per-tenant by `distributor.gstMode`.
- 🟡 SMTP: `secure: port===465`; on 587 STARTTLS is left to nodemailer default — verify TLS for the chosen port (SES supports both).

### 4E — Third-party data sharing
- **WhiteBooks / NIC GST** (only when `gstMode !== disabled`): sends seller GSTIN/name/address/phone/email, buyer (customer) GSTIN-or-URP/name/billing-address/phone/email, item HSN/qty/amounts; EWB adds vehicle number + transport distance/mode. Full payloads persisted to `gst_documents`/`gst_api_logs` (ties to 4B indefinite-retention gap).
- 🟢 **No analytics/tracking SDKs** (no GA/Mixpanel/PostHog/Segment/Firebase) in web or mobile.
- **Sentry** (error tracking, gated on DSN) — API + web. 🟡 No explicit `sendDefaultPii` seen, but stack traces / error contexts may incidentally carry PII — confirm Sentry data scrubbing before prod.
- **Email** via SMTP/nodemailer (OTP + contact-form).

---

## STEP 5 — Current Architecture Assessment

| Tier | Component | AWS placement |
|---|---|---|
| **Server** | `packages/api` (Express+TS+Prisma). Holds ALL persistent data; runs in-process node-cron overdue job (**single-instance assumption — flag for horizontal scaling**). | EC2 + PM2 (per CI) **or** ECS/Docker |
| **Database** | PostgreSQL, single DB, multi-tenant by `distributorId` | RDS PostgreSQL |
| **Static** | `packages/web` (React/Vite build → static assets); axios injects JWT + `X-Distributor-Id` | S3 + CloudFront |
| **Mobile** | `packages/mobile` (Expo/React Native); tokens in `expo-secure-store`; hits same API over HTTPS | Expo EAS (not AWS-hosted) |

**External services called:**
1. **WhiteBooks / NIC GST** (HTTPS, sandbox vs prod per tenant) — on invoice IRN/EWB generation, dispatch preflight, cancel, GSTIN lookup, session probe.
2. **SMTP email** — password-reset OTP + contact-form notifications → **migrate to SES**.
3. **Sentry** — error events (gated on DSN).
4. **AWS S3** — ⚠️ **no `@aws-sdk` in code today**; `License.documentUrl` is just a stored URL string. Confirm where license docs / PAN / cheque images actually get uploaded before assuming S3 is wired — this may be manual/external right now.

---

## STEP 6 — AWS Deployment Plan

Region: **`ap-south-1` (Mumbai)** — matches data locality (India GST), the legacy deployment, and the CI default. Costs below are rough monthly USD estimates for a **single-tenant-pilot / small launch** scale, on-demand pricing.

| Service | Used for | Recommended tier (launch) | Est. $/mo |
|---|---|---|---|
| **EC2** | API server (Node + PM2) | **t3.small** (2 vCPU, 2 GB) Amazon Linux 2023. *Not t3.micro — legacy hit OOM.* | ~$15–18 |
| **RDS PostgreSQL** | Primary database | **db.t3.micro**, 20 GB gp3, **storage-encrypted (KMS)**, automated backups 7d. Single-AZ for pilot; Multi-AZ later. | ~$15–18 (single-AZ) / ~$30 (Multi-AZ) |
| **S3** | Static web hosting + invoice/PDF/license storage | Standard, <5 GB, versioning on for web bucket | ~$1–2 |
| **CloudFront** | CDN + TLS for web; SPA error→`/index.html` | PriceClass_100 (India/EU/US edge) | ~$2–5 (low traffic) |
| **ACM** | SSL certs for CloudFront + ALB | Public certs | **Free** |
| **Route53** | DNS for the domain | 1 hosted zone | ~$0.50 + queries |
| **SES** | Transactional email (replaces SMTP) | Pay-per-email; verify domain + DKIM; request production access (out of sandbox) | <$1 at launch |
| **Elastic IP** | Stable API address (if hitting EC2 directly) | 1 EIP attached to running instance | Free while attached |
| **CloudWatch** | Logs + basic alarms | Logs + a few alarms | ~$3–10 |
| **(Optional) ALB** | TLS termination + health checks in front of API | application LB | ~$16 + LCU |
| **Data transfer** | Egress | — | ~$5–10 |

**Indicative total: ~$45–70/mo single-AZ pilot** (closer to ~$90–110 with Multi-AZ RDS + ALB). The legacy `HOSTING_COST_ANALYSIS.md` estimated ~$80/mo for a comparable AWS single-instance setup and noted non-AWS alternatives at ~$50/mo — AWS is the right call here for data locality and the existing CI wiring.

### RDS vs EC2-hosted PostgreSQL
**Use RDS.** This app stores financial + tax + PII data and has no DBA. RDS gives managed backups, point-in-time recovery, encryption-at-rest (KMS) with one checkbox, minor-version patching, and easy Multi-AZ later. EC2-hosted Postgres saves a few dollars but puts backup/patching/encryption/availability entirely on you — not worth it for a compliance-sensitive launch. (The legacy stack already used RDS Postgres 17.)

### TLS / edge
- **Web:** S3 (private) → CloudFront (OAC) → ACM cert on the apex/`www`. CloudFront custom error response: 403/404 → `/index.html` (200) for SPA routing.
- **API:** front EC2 with **either** an **ALB + ACM** (cleaner, supports HSTS/health checks) **or** a local **nginx + certbot** on the EC2 box. Given there's no in-app HTTPS redirect, do TLS at this layer and set **HSTS** here. Put the API behind the same domain (e.g. `api.yourdomain.com`).
- Set `CORS_ORIGINS` to the real web origin(s); set web `VITE_API_URL` to the API origin (or `/api` if same-origin via CloudFront behavior).

### Security groups / VPC
- **VPC:** default or a simple custom VPC with public + private subnets.
- **EC2 SG:** inbound **443** (if nginx/ALB on the box) and **22** (SSH, **restricted to your office/admin IP only**). If using ALB, EC2 only accepts **5000 from the ALB SG**. Do **not** open 5000 to the world.
- **RDS SG:** inbound **5432 only from the EC2/API security group** — never public. Place RDS in private subnets.
- Enforce RDS SSL; in Prisma `DATABASE_URL` use `?sslmode=require` with the RDS CA bundle (legacy lesson: avoid the `sslmode` vs `rejectUnauthorized` conflict).

---

## STEP 7 — Pre-Launch Checklist

### A. Infrastructure setup
1. Create VPC (public + private subnets) in `ap-south-1`.
2. Launch **t3.small** EC2 (Amazon Linux 2023); install Node 22, pnpm 9.15.0, PM2; add 2 GB swap as insurance.
3. Reconcile deploy path: either deploy to `/opt/gaslink` (matches `ci.yml`) or update the workflow — **don't repeat the legacy `/opt` vs `~/` mismatch**.
4. Provision **RDS db.t3.micro**, 20 GB gp3, **storage encryption ON (KMS)**, automated backups 7 days, private subnets.
5. Create S3 buckets: web (CloudFront origin, private+OAC) and a separate bucket for invoice/PDF/license storage (private).
6. Create CloudFront distribution (ACM cert, SPA error mapping).
7. Allocate + attach **Elastic IP** to EC2 (or route all traffic via domain/ALB so the IP never leaks into builds).
8. Configure security groups per Step 6 (443/22 in, 5432 only from API SG, 5000 not public).
9. Set up CloudWatch log group + alarms (CPU, memory, RDS connections, 5xx rate, disk).

### B. Environment variables (set on EC2 / SSM Parameter Store — NOT in the repo)
10. 🔴 `DATABASE_URL` (RDS endpoint, `?sslmode=require`).
11. 🔴 `JWT_ACCESS_SECRET` + `JWT_REFRESH_SECRET` — strong, random, **different from dev defaults** (validateEnv will refuse to boot otherwise).
12. 🔴 `CORS_ORIGINS` = real web origin(s).
13. `NODE_ENV=production`, `HOST=0.0.0.0` (if no local nginx), `PORT=5000`.
14. `SMTP_*` pointed at **SES** SMTP creds; `SMTP_FROM` = SES-verified address.
15. `GASLINK_GST_*` = **production** WhiteBooks credentials (see item 27).
16. `AWS_REGION=ap-south-1`, `AWS_S3_BUCKET` (if app uploads enabled), `SENTRY_DSN`.
17. Web build: set `VITE_API_URL` to the API origin; fix or align the `VITE_API_BASE_URL` Docker build-arg mismatch.

### C. Security hardening
18. 🟡 Bump `nodemailer`≥8.0.4 and `qs`≥6.15.2 (`pnpm update`); re-run `pnpm audit`.
19. 🟡 Add a dedicated rate limiter on `POST /auth/reset-password`.
20. 🟡 Set explicit **CSP + HSTS** headers at CloudFront (web) and ALB/nginx (API).
21. 🔴 Enable RDS encryption-at-rest (KMS) — item 4 above. Consider app-level/KMS encryption for `gst_credentials` columns and `User.refreshToken`.
22. 🟡 Confirm Sentry PII scrubbing (no `sendDefaultPii`); restrict SSH SG to admin IPs.
23. Verify `validateEnv()` runs at boot and the API refuses to start with default secrets.

### D. Database migration on prod
24. From the deploy host: `pnpm --filter @gaslink/api db:migrate:prod` (`prisma migrate deploy`) against the RDS `DATABASE_URL`. **Never** `prisma migrate reset` against prod.
25. Seed only the minimum needed (super-admin + reference data) — **do not** load the dev test accounts/fixtures (the `TEST-*` vehicles, demo distributors) into prod.
26. Confirm `scripts/backup.sh` works against RDS and uploads to `S3_BACKUP_BUCKET`; verify a restore once.

### E. WhiteBooks GST sandbox → production switch
27. 🔴 Swap `GASLINK_GST_*` to live WhiteBooks credentials; set each distributor's `gstMode` to `live` (not `sandbox`) only after a live-sandbox verification per CLAUDE.md anti-patterns #10/#15 (exercise one real IRN + EWB against prod and capture the raw NIC response before flipping tenants).

### F. SSL / DNS
28. Validate ACM certs (DNS validation via Route53).
29. Point Route53 records: apex/`www` → CloudFront, `api` → ALB/EIP.
30. Confirm HTTPS end-to-end; confirm SPA deep links (refresh on a nested route) return 200.

### G. Mobile (Expo / EAS)
31. Set production `EXPO_PUBLIC_API_URL` (the HTTPS API domain) + `EXPO_PUBLIC_SENTRY_DSN` in `eas.json` production profile.
32. EAS production build (iOS + Android); bump `version` + `buildNumber`/`versionCode`; tag the release.
33. Verify tokens use `expo-secure-store` (per CLAUDE.md), strip `console.log`, test on a physical device + slow network, confirm deep-link handling.
34. Prepare store metadata + privacy policy URL; confirm cert pinning / HTTPS-only per the mobile rules.

### H. Monitoring / alerting
35. Sentry live for API + web (+ mobile).
36. CloudWatch alarms (item 9) wired to an email/SNS topic.
37. Confirm the nightly `e2e-monitor.yml` points at a reachable environment (or disable for prod).
38. 🟡 Plan a data-retention/erasure job (GST payloads, audit logs, soft-deleted PII) — not a launch blocker but required for any privacy/compliance commitment.

---

## Appendix — Open Questions to Resolve Before Push
- **File uploads:** where do license/PAN/cheque images and invoice PDFs actually get stored today? No `@aws-sdk` in code — confirm before assuming S3.
- **Single API instance:** the in-process node-cron job assumes one instance. If scaling horizontally, move the cron to a single leader / EventBridge schedule.
- **`gst_credentials` plaintext:** decide app-level encryption vs. relying solely on RDS encryption-at-rest.
- **Deploy path:** `/opt/gaslink` (CI) vs wherever the box actually checks out — pin one.
