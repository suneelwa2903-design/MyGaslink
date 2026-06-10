# Distributor GST Activation — Onboarding Runbook

**Audience:** GasLink super-admin onboarding a new LPG distributor onto the platform's GST e-invoicing flow.

**Scope:** Everything that needs to happen between "we signed a contract with this distributor" and "their first GST invoice generates an IRN against NIC".

**Architecture context (Group A, post-2026-06-10):** This runbook reflects the [Layer 1 / Layer 2 credential split](#about-the-credential-layers) introduced by Group A. If you previously remember collecting `client_id` / `client_secret` / `email` from distributors — that is no longer correct.

---

## TL;DR

| Who | What |
|---|---|
| **Distributor** | Registers on einvoice1.gst.gov.in (and ewaybillgst.gov.in) with WhiteBooks as GSP → creates a NIC API **username + password** → sends those two values + their GSTIN to GasLink |
| **You (GasLink super-admin)** | Open the GST Activation screen for that distributor → enter the username + password → click Test Connection → click Activate |

That's it. No client_id, no client_secret, no email collected from the distributor — those are MyGasLink-global values living in the platform's environment.

---

## Section 1 — Distributor's responsibility

The distributor handles two NIC portal registrations (e-invoice + e-Way Bill are separate processes even though most taxpayers reuse the same username/password).

### 1.1 e-Invoice portal registration

1. Distributor logs in to **https://einvoice1.gst.gov.in** with their GSTIN-tied login
2. Navigate to **API Registration → API Access Through GSP** (UI sometimes changes; alternatively "GSP API Access")
3. Select **WhiteBooks** from the GSP dropdown
4. Create a **username + password** specific to this GSTIN — NIC calls these "API Login Credentials"
5. Write them down securely

### 1.2 e-Way Bill portal registration

The e-Way Bill API is governed by a separate portal. Even though most taxpayers use the same credentials for both, the registration is separate.

1. Distributor logs in to **https://ewaybillgst.gov.in** with their GSTIN-tied login
2. **Registration → For API**
3. Select **WhiteBooks** as GSP
4. Create a **username + password** specific to this GSTIN for the e-Way Bill API
5. Most taxpayers reuse the same values as e-invoice — that's fine

### 1.3 What the distributor sends to GasLink super-admin

After 1.1 + 1.2, they should send you:

| Field | Used for | Notes |
|---|---|---|
| GSTIN | Identification + state code extraction | 15-char, ends `Z\d` (e.g. `36AABCU9603R1ZM`) |
| e-invoice **username** | NIC e-invoice API auth | typically 6-10 chars |
| e-invoice **password** | NIC e-invoice API auth | typically 8-15 chars |
| e-Way Bill **username** | NIC e-Way Bill API auth | often the same as e-invoice |
| e-Way Bill **password** | NIC e-Way Bill API auth | often the same as e-invoice |

> 💡 **If they ask "what about client_id and client_secret?"** — explain that those are WhiteBooks-account-level (MyGasLink's WhiteBooks account, not theirs) and you already have them in the platform's environment. Same for the email-of-record.

---

## Section 2 — What is NOT collected from the distributor

The following live in MyGasLink's environment as Layer 1 env vars, NOT in per-distributor credentials:

| Env var pattern | Meaning |
|---|---|
| `WHITEBOOKS_<SCOPE>_<ENV>_CLIENT_ID` | WhiteBooks-issued client_id for MyGasLink's WhiteBooks account |
| `WHITEBOOKS_<SCOPE>_<ENV>_CLIENT_SECRET` | WhiteBooks-issued client_secret for MyGasLink's WhiteBooks account |
| `WHITEBOOKS_<SCOPE>_<ENV>_EMAIL` | Email-of-record on MyGasLink's WhiteBooks account |

Where:
- `<SCOPE>` = `EINVOICE` or `EWAYBILL`
- `<ENV>` = `SANDBOX` or `PROD`

Total: 12 env vars (3 fields × 2 scopes × 2 environments). They are populated on EC2 by the GitHub Actions deploy workflow.

If you ever rotate MyGasLink's WhiteBooks account credentials, you rotate them ONCE in GitHub Secrets and the next deploy injects the new values. No per-distributor changes needed.

---

## Section 3 — GasLink super-admin's responsibility

You receive the distributor's username + password + GSTIN. Now activate them.

### 3.1 Open the GST Activation screen

1. Sign in to the web app at **https://app.mygaslink.com** (or your local dev URL) as a super-admin
2. Left nav → **Distributors**
3. Click the distributor row → lands on the distributor detail page
4. In the header, click **Configure GST** (shield icon, secondary button)

URL: `/app/distributors/<distributor-id>/gst-activation`

### 3.2 Verify the distributor info

The page shows a distributor info card. Confirm:

- GSTIN matches what the distributor sent
- State is correct
- **Current GST Mode** badge says `disabled` (new distributors start disabled)
- **Test tenant** says `No` (real distributors should always be `No`)

If the test tenant flag is `Yes` for a real distributor, that's wrong — surface to engineering before proceeding.

### 3.3 Pick target mode

Click **Live** in the Target Mode row.

> ⚠️ Real distributors go disabled → **live**. They do NOT pass through sandbox.
> The Sandbox tile is grayed out with "(test tenants only)" for them — that's intentional.

### 3.4 Fill the credentials

The form shows a blue info banner reminding you: "Only NIC username + password are per-distributor. WhiteBooks client credentials and email-of-record are GasLink-global."

1. **Same credentials for e-invoice and e-Way Bill** — leave ON if the distributor reused the same username/password for both portals (the common case)
2. **NIC Portal Username** — paste the distributor's e-invoice username
3. **NIC Portal Password** — paste the distributor's e-invoice password
4. If the same-creds toggle is OFF, expand the e-Way Bill section and fill those too

### 3.5 Pick a reason

The Reason dropdown defaults to **New distributor activation**. Keep that for first-time activation.

Other values:
- `Credential rotation` — when the distributor's existing credentials are being replaced
- `Mode change` — when transitioning live ↔ disabled (use the dedicated Disable button below for `live → disabled`)
- `Revoke access` — when offboarding a distributor
- `Other` — free-text required in the "Please specify" field

### 3.6 Test Connection

Click **Run Test**.

Expected outcomes:

| Result | Meaning |
|---|---|
| ✅ Green tick on both `e-Invoice` and `e-Way Bill` | Credentials authenticate against WhiteBooks AND NIC is responding. Safe to activate |
| ❌ Red `e-Invoice` only | Either the username/password is wrong, or the GSTIN doesn't match the registered account on NIC's portal. Verify both with the distributor before proceeding |
| ❌ Red `e-Way Bill` only | Same fields but for the EWB portal. The distributor may have only registered one portal — they need to complete Section 1.2 too |
| Both ❌ with "WhiteBooks sandbox credentials not configured in env" | A platform-level env var is missing. Surface to engineering — this is NOT a distributor issue |
| Both ❌ with "WhiteBooks rejected the supplied credentials" | The provided credentials are simply wrong, OR NIC is in one of its periodic flicker windows. Wait 1-2 minutes and retry; if still red, get the distributor to re-verify their NIC portal login still works |

### 3.7 Activate

When both Test Connection results are green, the **Activate (live)** button becomes clickable. Click it.

On success, you see a toast "GST activated" and you're redirected back to the distributor detail page. The Current GST Mode badge now reads `live`.

---

## Section 4 — Common errors and how to resolve

| Error | Cause | Fix |
|---|---|---|
| `SANDBOX_NOT_ALLOWED` | You clicked Sandbox on a tenant where `is_test_tenant=false` | Use Live instead. Sandbox is reserved for `dist-demo` and internal test tenants |
| `LIVE_TO_SANDBOX_BLOCKED` | You're trying to flip a live tenant back to sandbox | Once live, the only way back is `live → disabled`. Re-activation is allowed afterwards |
| `LIVE_REQUIRES_CREDENTIALS` | The transition guard saw missing Layer 2 credentials | The form should be supplying them; if you see this, surface to engineering — it's an internal contract violation |
| `IN_FLIGHT_GST_DOCS` (when disabling) | There are open EWBs or pending IRNs for this tenant | Cancel them first, OR wait for delivery to complete and the docs to settle |
| `TEST_CONNECTION_FAILED` with per-scope detail in `data` field | NIC/WhiteBooks rejected the supplied credentials for that scope | Re-check the username/password with the distributor; verify their NIC portal login still works |
| `NO_PROD_CREDS` (in any flow) | Platform `WHITEBOOKS_*_PROD_*` env vars are empty | The WhiteBooks production package hasn't been purchased OR the env vars weren't injected on the last deploy. Engineering issue |
| `NO_GASLINK_EMAIL` | Both env email and legacy DB email empty | Same — platform env issue |

---

## Section 5 — Mode transitions reference

The transition guards live in `packages/api/src/services/gst/transitionGuards.ts`. The matrix:

| From → To | Allowed? | Notes |
|---|---|---|
| `disabled → live` | ✅ | The standard activation path. Requires valid credentials |
| `disabled → sandbox` | ✅ if test tenant | Real distributors are blocked with SANDBOX_NOT_ALLOWED |
| `sandbox → live` | ✅ if test tenant | Activation from sandbox to live (for dist-demo, etc.) |
| `sandbox → disabled` | ✅ | No guards |
| `live → disabled` | ✅ if no in-flight GST docs | Use the dedicated Disable button on the activation screen. Provides the mandatory `reason` field. Credentials are preserved for re-activation later |
| `live → sandbox` | ❌ | Permanently blocked. Once live, the only path out is `live → disabled` |

---

## About the credential layers

A taxpayer using a GSP (like WhiteBooks) authenticates to NIC's API with TWO independent credential pairs:

**Layer 1 — WhiteBooks API access (GasLink-global)**
- `client_id` + `client_secret` + `email` for MyGasLink's WhiteBooks account
- Same values used for every distributor we onboard
- Stored as env vars on EC2 (injected from GitHub Secrets at deploy time)

**Layer 2 — NIC API login (per-distributor)**
- `username` + `password` that the distributor created on einvoice1.gst.gov.in (and ewaybillgst.gov.in) for THEIR GSTIN under WhiteBooks as their GSP
- Different per distributor
- Stored in the `gst_credentials` table

The distributor's own GSTIN ties Layer 2 to identity.

Per the NIC documentation: *"Client Id and Client Secret are provided to the Service Providers like GSPs, ERPs and ECOs"* — that's Layer 1. *"Username and Password are created by each tax payer for his GSTIN to generate IRNs"* — that's Layer 2.

---

## Onboarding checklist (checklist version)

- [ ] Contract signed with distributor; you have their GSTIN
- [ ] Distributor record created via super-admin "Create Distributor" flow on /app/distributors
- [ ] Distributor registered on einvoice1.gst.gov.in with WhiteBooks as GSP and shared their NIC username + password
- [ ] Distributor registered on ewaybillgst.gov.in with WhiteBooks as GSP and shared their EWB username + password (often same as e-invoice)
- [ ] Super-admin opens Configure GST screen for the distributor
- [ ] Mode = Live selected
- [ ] Credentials entered (same-creds toggle ON if applicable)
- [ ] Test Connection run; both scopes green
- [ ] Activate clicked; success toast shown
- [ ] Distributor detail page shows `Current GST Mode: live`
- [ ] Audit log entry exists with `action=gst_activate`, `reason=new_distributor_activation`, both credential fingerprints present

If any step fails, see Section 4. If you can't resolve it, surface to engineering with: distributor ID, time of attempt, full error message, and which step failed.
