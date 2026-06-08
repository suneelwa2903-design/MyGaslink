# iOS Account Deletion — Specification

**Status:** SPEC (no code yet)
**Author:** Claude (Opus 4.7)
**Date:** 2026-06-08
**Owner:** Suneel
**Target:** Mobile (iOS App Store + Google Play) + API
**Estimate:** 3.5 working days (1 engineer) — see §9

---

## 1. Problem Statement + Legal Landscape

### 1.1 What we have today

The current implementation (`packages/mobile/src/components/DeleteAccountButton.tsx`) is a `mailto:info@mygaslink.com` link with a pre-filled subject + body. The user is told their request "will be processed within 30 days." This is wired into:

- `packages/mobile/app/(admin)/more.tsx`
- `packages/mobile/app/(super-admin)/settings.tsx`
- `packages/mobile/app/(customer)/account.tsx`
- `packages/mobile/app/(driver)/profile.tsx`
- `packages/mobile/app/(finance)/profile.tsx`
- `packages/mobile/app/(inventory)/profile.tsx`

This was acceptable for Google Play under the "off-app deletion path is allowed if disclosed" rule. **It is NOT acceptable for Apple.**

### 1.2 Apple App Store Review Guideline 5.1.1(v) — verbatim

> "Apps that support account creation must also offer account deletion within the app. […] Deleting an account should completely delete the account from the developer's records, including any associated personal data, except where the developer is required to retain data for legitimate legal purposes. Deleting an account should not just deactivate or disable the account. Apps in regulated industries may be required to confirm the user's identity prior to account deletion."
>
> "Account deletion must be initiated from within the app and the deletion must be completed from within the app, with no further interaction required beyond confirmation. Sending the user to a website to complete account deletion creates unnecessary friction."

— Apple App Store Review Guidelines, §5.1.1(v), as of 2024-04 (still current 2026-06).

**Implication:** the `mailto:` path fails on three counts: (a) user is forced out of the app, (b) deletion is not initiated from within the app — it is initiated by Suneel reading an email and running SQL, (c) no in-app confirmation flow.

### 1.3 India DPDP Act §12 — Right to Erasure

The Digital Personal Data Protection Act 2023 (DPDP), §12(1):

> "A Data Principal shall have the right to […] (a) the erasure of her personal data, where the personal data is no longer necessary for the purpose for which it was processed, **unless retention is necessary for a legal purpose**."

§12(3) adds the duty on the Data Fiduciary to "erase the personal data unless retention is necessary for compliance with any law for the time being in force."

**Implication:** we MUST honour deletion of *personal data* but MAY retain *financial records* required by other laws.

### 1.4 Indian Income Tax + GST statutory retention — 8 years

- **Income Tax Act, §44AA + Rule 6F(5):** "books of account and other documents […] shall be kept and maintained for a period of six years from the end of the relevant assessment year." Practical floor: **6 years** for taxpayers under presumptive schemes, **8 years** in practice for reassessment-window safety (§149 reassessment window was extended to 10 years for high-value cases by Finance Act 2021).
- **CGST Act, §36 + Rule 56(15):** "every registered person required to keep and maintain books of account or other records […] shall retain them until the expiry of **seventy-two months** [6 years] from the due date of furnishing of annual return for the year pertaining to such accounts and records." Annual return (GSTR-9) is due 31-Dec of the following FY, so the effective floor is **~6.75 years from invoice date**.
- **Distributor obligation under PESO + LPG control orders:** distribution records (delivery logs, returns) — 3 years.

**We pick 8 years** as the single retention window. It safely covers the longest applicable rule (Income Tax §149 reassessment), is easy to communicate to the user, and survives a CA's review. Confirm with CA before shipping (see §10).

### 1.5 The resolution: PII anonymization with statutory record retention

A literal `DELETE FROM users WHERE id = ?` would violate Income Tax + GST law because invoices and payment ledger rows reference `customerId` / `userId`. A literal "keep everything" would violate DPDP §12.

**The design:** drop personally identifying fields (name, email, phone, address, photo, FCM token, refresh token) and replace them with a deterministic anonymous token (`ANON-<sha256(userId)[:16]>`) so foreign-key integrity is preserved. Keep the underlying financial/audit rows intact for 8 years. After 8 years, a separate scheduled job (out of scope for this WI — track as follow-up) permanently DELETEs the anonymized rows.

We will tell the user this honestly in the in-app confirmation (§2). Apple's guideline explicitly allows this — "*except where the developer is required to retain data for legitimate legal purposes*" — provided the disclosure is clear.

---

## 2. Apple-Acceptable Disclosure Copy

The exact text shown on the confirmation screen (§7, screen 2). Calibrated to be (a) honest enough for Apple's reviewer, (b) legally accurate for Indian Income Tax + GST + DPDP, (c) short enough to read on a single mobile viewport.

> **Delete Your Account**
>
> Your account will be deleted immediately. Your personal information — name, email, phone, address, and photo — will be permanently removed and cannot be recovered.
>
> As required by Indian Income Tax and GST law, your invoice and payment history must be retained for 8 years. After deletion these records remain in our system in **anonymized form**, linked to a non-identifying ID — not to you. They are used only for statutory tax compliance and audit, never for marketing or analytics.
>
> After 8 years, all records will be permanently deleted.
>
> This action cannot be undone. You will be signed out of all devices.

**Locked wording.** Do not paraphrase without re-reviewing against §5.1.1(v). Reviewers compare disclosure copy to actual behaviour — if we say "name removed" we must actually null `firstName`/`lastName`.

A shorter inline confirmation appears on the force-type screen (§7, screen 3):

> Type **DELETE MY ACCOUNT** below to confirm. This cannot be undone.

---

## 3. PII vs Statutory-Record Mapping — Model-by-Model Audit

**Legend (Type column):**
- **PII** — Personally Identifying. Null out, or replace with `ANON-<hash>` token if NOT NULL.
- **PII-link** — A reference to a record that itself holds PII; cleared on the parent (no action needed on the child link).
- **Tenant** — `distributorId` / `customerId` linking to a distributor or customer entity. Retain unchanged.
- **Statutory** — Required for 8-year IT/GST retention. Retain unchanged.
- **Operational** — Active session / queue / cache state. Cascade delete or revoke immediately.
- **Reference** — Cross-tenant master data (HSN, states, provider catalog). Skip entirely.
- **Out-of-scope** — Tenant-level data; deletion of a user does NOT cascade to the tenant.

**Legend (Action column):** `NULL` | `ANON` (replace with `ANON-<hash>`) | `RETAIN` | `DELETE` | `REVOKE` | `SKIP`.

### 3.1 Scope decision matrix per role

Account deletion semantics differ by `User.role`:

| Role | Deletes own User row? | Cascades to Customer? | Cascades to Driver? | Notes |
|------|----------------------|----------------------|---------------------|-------|
| `customer` | Yes — anonymize | Yes — anonymize **linked** Customer (User.customerId) IF no other Users link to the same Customer | No | Customer entity itself can also be referenced by sibling User rows (rare); enumerate before anonymizing. |
| `driver` | Yes — anonymize | No | Yes — soft-deactivate Driver row; anonymize PII fields | Driver row holds `phone`, `driverName`, `licenseNumber` — all PII. |
| `finance`, `inventory`, `distributor_admin` | Yes — anonymize | No | No | Pure employee account. No Customer/Driver cascade. |
| `super_admin` | **BLOCKED** (423) | — | — | Only deletable by another super_admin via a separate admin endpoint (out of scope). |

### 3.2 Per-model audit

> Reference: `packages/api/prisma/schema.prisma`. Line ranges are approximate (single migration, but lines drift with edits — re-check on implementation).

#### 3.2.1 — Distributor (schema.prisma:320)
**Out-of-scope.** Tenant-level. Deleting a user MUST NOT touch this row, even if the user is the distributor's only admin (see §10 open question on orphaned tenants).

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| (all) | Tenant | SKIP | — |

#### 3.2.2 — User (schema.prisma:395) — **PRIMARY TARGET**

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `id` | PK | RETAIN | Anchor for foreign-key integrity. |
| `email` | PII | ANON → `deleted-<hash>@anon.mygaslink.local` | Must be unique → use hash. |
| `passwordHash` | PII (auth) | NULL or set to a cryptographically random unreachable hash | Prevents any future login. |
| `firstName` | PII | ANON → `"Deleted"` | NOT NULL. Use literal `"Deleted"` for human-readable audit. |
| `lastName` | PII | ANON → `"User"` | NOT NULL. Use literal `"User"`. |
| `phone` | PII | NULL | Nullable. |
| `role` | Statutory | RETAIN | Needed to interpret historical audit logs (who did what). |
| `status` | Operational | Set to `inactive` | Belt + braces vs the `deletedAt` timestamp. |
| `provisioningStatus` | Operational | RETAIN | — |
| `distributorId` | Tenant | RETAIN | Required for tenant lineage in audit log. |
| `customerId` | PII-link | RETAIN | Anonymized on the Customer row separately. |
| `requiresPasswordReset` | Operational | Set to `false` | Doesn't matter — login is blocked by null password — but tidy. |
| `refreshToken` | PII (auth) | NULL | Revokes all refresh sessions. |
| `lastLoginAt` | PII (telemetry) | NULL | Last-login timestamp could be identifying in a tiny tenant. |
| `loginAttempts` | Operational | Set to `0` | — |
| `lockedUntil` | Operational | NULL | — |
| `resetOtp` | PII (auth) | NULL | — |
| `resetOtpExpiresAt` | PII (auth) | NULL | — |
| `createdAt` | Statutory | RETAIN | — |
| `updatedAt` | Auto | RETAIN | — |
| `deletedAt` | Marker | SET = `now()` | Soft-delete marker — distinguishes "anonymized" from "active". |

#### 3.2.3 — Customer (schema.prisma:433) — **CASCADE WHEN ROLE = customer**

Only cascade IF `User.customerId IS NOT NULL` AND no *other* active (non-deletedAt) User row references the same `customerId`. Otherwise leave Customer alone (a B2B customer can have multiple portal logins).

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `id` | PK | RETAIN | — |
| `distributorId` | Tenant | RETAIN | — |
| `customerName` | PII | ANON → `"Deleted Customer"` | NOT NULL. |
| `businessName` | PII | NULL | Nullable. |
| `gstin` | Statutory | RETAIN | GSTIN is on invoices, IRN, EWB. Required for GSTR-1 audit. **DO NOT NULL.** Apple disclosure (§2) covers this — "tax compliance" exception. |
| `customerType` | Statutory | RETAIN | — |
| `phone` | PII | NULL → empty string `""` if NOT NULL (column is NOT NULL on Customer) | Yes, the schema enforces NOT NULL — use `""` here. |
| `email` | PII | NULL | Nullable. |
| `billingAddressLine1` | PII | NULL | All billing address fields nullable. |
| `billingAddressLine2` | PII | NULL | — |
| `billingCity` | PII (low-cardinality, but still) | NULL | — |
| `billingState` | Statutory | RETAIN | Required for IGST vs CGST/SGST on retained invoices. |
| `billingPincode` | PII | NULL | — |
| `shippingAddressLine1` | PII | NULL | — |
| `shippingAddressLine2` | PII | NULL | — |
| `shippingCity` | PII | NULL | — |
| `shippingState` | Statutory | RETAIN | Required for IGST determination on EWB. |
| `shippingPincode` | PII | NULL | — |
| `creditPeriodDays` | Operational | RETAIN | Harmless. |
| `transportChargePerCylinder` | Operational | RETAIN | — |
| `status` | Operational | Set to `inactive` | — |
| `stopSupply` | Operational | Set to `true` | Prevents accidental re-activation. |
| `preferredDriverId` | Operational | NULL | — |
| `deletedAt` | Marker | SET = `now()` | — |

#### 3.2.4 — CustomerContact (schema.prisma:485)

In-scope IF Customer is being cascaded. `onDelete: Cascade` is set in schema, but we are *anonymizing* not deleting the Customer.

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `id` | PK | RETAIN | — |
| `customerId` | Tenant | RETAIN | — |
| `name` | PII | ANON → `"Deleted"` | — |
| `phone` | PII | NULL → `""` (NOT NULL) | — |
| `email` | PII | NULL | — |
| `isPrimary` | Operational | RETAIN | — |

#### 3.2.5 — CustomerCylinderDiscount (schema.prisma:498)
No PII. Cascade with Customer.
| Field | Type | Action |
|-------|------|--------|
| (all) | Operational/Reference | RETAIN |

#### 3.2.6 — CustomerInventoryBalance (schema.prisma:511)
No PII. Operational state on retained Customer.
| Field | Type | Action |
|-------|------|--------|
| (all) | Operational | RETAIN |

#### 3.2.7 — CustomerModificationRequest (schema.prisma:527)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `requestedBy` | PII-link (User.id) | RETAIN | The User row is being anonymized in §3.2.2 — this FK keeps lineage. |
| `reviewedBy` | PII-link | RETAIN | — |
| `reason` | Possibly-PII (free text) | NULL | Free-text fields are PII risk. Null to be safe. |
| `changes` (Json) | Possibly-PII | NULL | Could contain old name/phone. NULL the JSON. |
| (rest) | Statutory | RETAIN | — |

#### 3.2.8 — CustomerAuditTrail (schema.prisma:546)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `performedBy` | PII-link (User.id) | RETAIN | — |
| `actionType` | Statutory | RETAIN | — |
| `fieldName` | Statutory | RETAIN | — |
| `oldValue` (Json) | Possibly-PII | **REDACT** | If `fieldName IN ('phone','email','address','name', …)` set to `{"redacted": true}`. Tricky — easier to NULL the whole JSON for the customer's own trail rows. |
| `newValue` (Json) | Possibly-PII | **REDACT** | Same. |
| (rest) | Statutory | RETAIN | — |

**Decision:** redact `oldValue`/`newValue` JSON to `{"redacted": "user-deletion-2026-06-XX"}` for rows where `customerId` is the deleted user's customer. Keeps the audit timeline intact, removes the PII payload.

#### 3.2.9 — CustomerLedgerEntry (schema.prisma:563) — **STATUTORY**
| Field | Type | Action |
|-------|------|--------|
| (all) | Statutory | RETAIN |

The ledger is the spine of the 8-year retention. Touch nothing.

#### 3.2.10 — CylinderType (schema.prisma:585)
Tenant-level. Out-of-scope.

#### 3.2.11 — CylinderPrice (schema.prisma:620)
Tenant-level. Out-of-scope.

#### 3.2.12 — EmptyCylinderPrice (schema.prisma:635)
Tenant-level. Out-of-scope.

#### 3.2.13 — CylinderThreshold (schema.prisma:649)
Tenant-level. Out-of-scope.

#### 3.2.14 — Order (schema.prisma:665)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `customerId` | PII-link | RETAIN | Customer is anonymized separately. |
| `driverId` | PII-link | RETAIN | Driver is anonymized separately if a driver user is being deleted. |
| `specialInstructions` | Possibly-PII | NULL | Free-text — customers sometimes write "leave at door, key under mat" etc. |
| `deliveryNotes` | Possibly-PII | NULL | Driver free-text — same risk. |
| `deliveryLatitude`/`deliveryLongitude` | PII (geolocation) | NULL | Geolocation is PII. **But:** for *delivered* orders these correspond to a delivery proof — see §4.2 nuance. **Decision:** retain on delivered, null on cancelled. |
| `cancellationReason` | Possibly-PII | NULL | — |
| `customerDisputeReason` / `disputeResolutionNote` / `disputeReopenReason` | Possibly-PII | NULL | Customer free-text. |
| (rest) | Statutory | RETAIN | Order is statutorily linked to Invoice via `orderId` — must not delete. |

#### 3.2.15 — OrderItem (schema.prisma:727)
No PII. RETAIN all. Statutory.

#### 3.2.16 — OrderStatusLog (schema.prisma:744)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `changedBy` | PII-link | RETAIN | — |
| `notes` | Possibly-PII | NULL | Free text. |
| (rest) | Statutory | RETAIN | — |

#### 3.2.17 — Driver (schema.prisma:761) — **CASCADE WHEN ROLE = driver**

Driver entity itself is per-tenant, but the Driver row holds the human's PII. Cascade only IF the deleted User is uniquely linked to this Driver (via shared `phone` + `distributorId` — there is no FK; see §10 open question on User↔Driver linkage).

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `id` | PK | RETAIN | — |
| `distributorId` | Tenant | RETAIN | — |
| `driverName` | PII | ANON → `"Deleted Driver"` | — |
| `phone` | PII | NULL → `""` (NOT NULL) | — |
| `licenseNumber` | PII | NULL | DL number is PII. |
| `employmentType` | Operational | RETAIN | — |
| `status` | Operational | Set to `inactive` | — |
| `availableToday` | Operational | Set to `false` | — |
| `preferredVehicleId` | Operational | NULL | — |
| `joiningDate` | Statutory (HR record) | RETAIN | Labour-law retention — kept. |
| `deactivatedAt` | Marker | SET = `now()` | — |
| `deactivationNotes` | Audit | Set to `"User-initiated account deletion"` | — |
| `deletedAt` | Marker | SET = `now()` | — |

#### 3.2.18 — Vehicle (schema.prisma:791)
Tenant-level. Out-of-scope. Vehicle number is the asset, not the user.

#### 3.2.19 — DriverVehicleAssignment (schema.prisma:816)
No PII. RETAIN. Statutory (links to trip-sheet EWB).

#### 3.2.20 — ReconciliationEmptiesReturned (schema.prisma:865)
No PII. RETAIN.

#### 3.2.21 — DriverAssignment (schema.prisma:880)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `assignedBy` (User FK) | PII-link | RETAIN | — |
| `notes` | Possibly-PII | NULL | — |
| (rest) | Statutory | RETAIN | — |

**§4-relevant:** rows where `driverId` = the deleting driver AND `status='active'` AND the underlying Order is still pending need reassignment. See §4.

#### 3.2.22 — VehicleInventory (schema.prisma:897)
No PII. RETAIN.

#### 3.2.23 — InvoiceCounter (schema.prisma:918)
Tenant-level. Out-of-scope.

#### 3.2.24 — Invoice (schema.prisma:933) — **STATUTORY, FULL RETAIN**

| Field | Type | Action |
|-------|------|--------|
| (all) | Statutory | RETAIN |

Invoices are the heart of GST/IT retention. **Touch nothing.** This includes `irn`, `ackNo`, `signedQr` — those are NIC artifacts and must remain queryable for GSTR-1 reconciliation.

#### 3.2.25 — InvoiceRevision (schema.prisma:988)
Statutory. RETAIN all (including the `Json` snapshots — they contain the historical line items, not customer PII).

#### 3.2.26 — InvoiceItem (schema.prisma:1008)
Statutory. RETAIN all.

#### 3.2.27 — CreditNote (schema.prisma:1026)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `reason` | Statutory (1-liner used in GSTR) | RETAIN | — |
| `note` | Possibly-PII (free-text to customer) | NULL | — |
| `issuedBy` / `approvedBy` (User FK) | PII-link | RETAIN | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.28 — DebitNote (schema.prisma:1048)
Same as CreditNote. `note` → NULL, everything else RETAIN.

#### 3.2.29 — PaymentTransaction (schema.prisma:1071) — **STATUTORY**
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `referenceNumber` | Statutory (cheque/UPI/bank ref) | RETAIN | Required for bank reconciliation audit. |
| `receivedBy` (User FK) | PII-link | RETAIN | — |
| `notes` | Possibly-PII | NULL | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.30 — PaymentAllocation (schema.prisma:1095)
No PII. RETAIN. Statutory.

#### 3.2.31 — InventoryEvent (schema.prisma:1110)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `driverName` | PII (snapshot, denormalized) | ANON → `"Deleted Driver"` | When deleting a driver, scrub this for rows where `driverName` matches. |
| `vehicleNumber` | Asset | RETAIN | Not PII. |
| `notes` | Possibly-PII | NULL | — |
| `authorizationRef` | Operational | RETAIN | — |
| `createdBy` (User FK) | PII-link | RETAIN | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.32 — InventorySummary (schema.prisma:1144)
No PII (aggregates only). RETAIN. `lockedBy` is a User FK → RETAIN.

#### 3.2.33 — CancelledStockEvent (schema.prisma:1175)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `reconciledBy` (User FK) | PII-link | RETAIN | — |
| `notes` | Possibly-PII | NULL | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.34 — GstDocument (schema.prisma:1206) — **STATUTORY**

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `requestPayload` (Json) | Statutory (IRN/EWB audit) | RETAIN | Contains buyer's GSTIN + address. **GST law requires retaining the as-sent payload.** Apple disclosure (§2) covers this. |
| `responsePayload` (Json) | Statutory | RETAIN | — |
| `cancelledByUserId` (User FK) | PII-link | RETAIN | — |
| `cancelReason` | Statutory (NIC field) | RETAIN | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.35 — GstCredential (schema.prisma:1252)
Tenant-level (distributor's WhiteBooks creds). Out-of-scope.

#### 3.2.36 — BillingCycle / BillingItem (schema.prisma:1277, 1302)
Tenant-level (GasLink SaaS billing to the distributor). Out-of-scope for user deletion.

#### 3.2.37 — PricingTier (schema.prisma:1327)
Reference data. SKIP.

#### 3.2.38 — GstApiUsage (schema.prisma:1355)
Tenant-level. Out-of-scope.

#### 3.2.39 — GstApiLog (schema.prisma:1379) — **STATUTORY (forensic) + PII risk**

This is the per-call audit log of WhiteBooks calls. `requestPayload` contains customer name + GSTIN + address.

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `requestPayload` (Json) | Statutory + PII | **RETAIN** | Same argument as `GstDocument` — required by GST/IT retention for the IRN audit chain. |
| `responsePayload` | Statutory | RETAIN | — |
| (rest) | Statutory | RETAIN | — |

**Note:** this is borderline. A privacy-purist could argue these logs should be retained only as long as the underlying invoice is queried — but Rule 56(15) doesn't distinguish "the invoice" from "the API audit that proved the invoice was filed." Keep all. Document in privacy policy.

#### 3.2.40 — SeatRequest (schema.prisma:1404)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `requestedBy` / `approvedBy` (User FK) | PII-link | RETAIN | — |
| `reason` | Possibly-PII | NULL | — |
| (rest) | Operational | RETAIN | — |

#### 3.2.41 — PendingAction (schema.prisma:1424)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `description` | Possibly-PII | **REDACT** if mentions the deleted user (`LIKE '%<userId>%'` is the cheap check, but description can also mention name/phone — see open question §10). | Free-text. |
| `approvedBy` / `resolvedBy` (User FK) | PII-link | RETAIN | — |
| `resolutionNotes` | Possibly-PII | NULL where related to deleted user | — |
| `errorContext` (Json) | Possibly-PII | RETAIN | Usually NIC error codes — low PII risk. |
| (rest) | Operational | RETAIN | — |

**Operational nuance:** any `PendingAction` with `status = 'open'` AND `entityType = 'user'` AND `entityId = <deleted userId>` should be resolved/skipped on deletion (orphaned open action).

#### 3.2.42 — PaymentCommitment (schema.prisma:1462)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `createdBy` / `resolvedBy` (User FK) | PII-link | RETAIN | — |
| (rest) | Statutory (collections) | RETAIN | — |

#### 3.2.43 — AccountabilityLog (schema.prisma:1489)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `description` | Possibly-PII | **REDACT** for rows where `driverId` or `customerId` is the deleted user | Free-text. |
| `resolvedBy` (User FK) | PII-link | RETAIN | — |
| `resolutionNotes` | Possibly-PII | NULL for affected rows | — |
| (rest) | Statutory | RETAIN | — |

#### 3.2.44 — AuditLog (schema.prisma:1519) — **STATUTORY (forensic)**

| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `userId` | PII-link | RETAIN | The User row it points to is anonymized — that's the anonymization. |
| `action` | Statutory | RETAIN | — |
| `entityType` / `entityId` | Statutory | RETAIN | — |
| `details` (Json) | Possibly-PII | **REDACT for the deletion target's rows** | The `details` JSON may snapshot old email/phone on a user-edit event. Replace with `{"redacted": "user-deletion-2026-06-XX"}` for rows where `userId = <deleted>`. |
| `ipAddress` | PII | NULL | IP is PII under DPDP. |
| `userAgent` | PII | NULL | UA strings can be device-fingerprint-identifying. |
| (rest) | Statutory | RETAIN | — |

**Important:** the **deletion action itself** writes a NEW AuditLog row (§6 step 7). That row's `userId` will be the soon-to-be-anonymized user; its `details` will be `{ deletedFields: [...] }` — sanitized, not containing the original PII values. Apply the same 8-year retention to that row.

#### 3.2.45 — DistributorSetting (schema.prisma:1542)
Tenant-level. Out-of-scope.

#### 3.2.46 — License (schema.prisma:1558)
Tenant-level (distributor's PESO/PAN/etc. licenses). Out-of-scope.

#### 3.2.47 — ContactSubmission (schema.prisma:1577)
Pre-tenant lead form. Out-of-scope for an authenticated user's deletion (the user wasn't authenticated when they submitted). But: if `email`/`phone` of the deleting user appears in `contact_submissions` rows, anonymize those rows opportunistically — they hold direct PII. Decision: **defer to a follow-up** so this WI ships within estimate (track in §10).

#### 3.2.48 — GstState / HsnCode / ProviderCatalogCylinderType (schema.prisma:1598, 1605, 1614)
Reference data. SKIP.

#### 3.2.49 — StockMismatchRecord (schema.prisma:1659)
| Field | Type | Action | Notes |
|-------|------|--------|-------|
| `vehicleNumber` (snapshot) | Asset | RETAIN | — |
| `driverId` / `customerId` (FK) | PII-link | RETAIN | Anonymized on parent. |
| `resolutionNotes` | Possibly-PII | NULL where `driverId` or `customerId` is the deleted user | — |
| `createdBy` / `resolvedBy` (User FK) | PII-link | RETAIN | — |
| (rest) | Statutory | RETAIN | — |

### 3.3 Coverage summary

**Total models in schema:** 46 (excluding pure enum definitions).
**In-scope for user-deletion anonymization:** 14 models with direct PII writes (User, Customer, CustomerContact, CustomerModificationRequest, CustomerAuditTrail, Driver, Order, OrderStatusLog, DriverAssignment, InventoryEvent, CancelledStockEvent, PendingAction, AccountabilityLog, AuditLog) + 1 stretch (StockMismatchRecord — light).
**Statutory full-retain (touch nothing):** 8 (Invoice, InvoiceRevision, InvoiceItem, CreditNote, DebitNote, PaymentTransaction, PaymentAllocation, CustomerLedgerEntry, GstDocument, GstApiLog).
**Tenant-level / out-of-scope:** 15.
**Reference data / skip:** 4.

---

## 4. Pending-Order Semantics

When a user requests deletion, in-flight operational state needs to be cleaned up. The principle: **don't leave operational state pointing at a deleted user, but don't lose statutory records by force-finishing them either.**

### 4.1 Open Orders (status ∉ {delivered, modified_delivered, cancelled})

**Customer-initiated deletion:**
- Orders with `status IN ('pending_driver_assignment', 'pending_dispatch')` → **cancel** with `cancellationReason = 'Customer account deleted'`. No invoice yet, no statutory loss.
- Orders with `status IN ('preflight_in_progress', 'pending_delivery')` → **HARD BLOCK** the deletion (return 409). An IRN may already be live at NIC; cancelling the order requires `irn_cancel` first which has a 24-hour NIC window. Tell the user: "You have an active delivery in progress. Please wait until it is complete and then try again."
- Orders with `status = 'returns_only'` → cancel.

**Driver-initiated deletion:**
- Orders where `driverId = <deleting driver>` AND `status IN ('pending_dispatch', 'preflight_in_progress', 'pending_delivery')` → **HARD BLOCK** (409). The distributor admin must reassign first.
- Orders where `driverId = <deleting driver>` AND `status = 'pending_driver_assignment'` (rare — shouldn't have a driverId yet, but defensive) → null `driverId`.

**Admin/finance/inventory deletion:**
- No order-level cascade (admins don't own orders).

### 4.2 Pending Invoices

- `Invoice.irnStatus = 'success'` → **RETAIN** unchanged. Already filed with NIC; statutory.
- `Invoice.irnStatus IN ('not_attempted', 'failed')` AND `Invoice.status = 'draft'` → set `status = 'cancelled'`, add notes "Customer account deleted before invoicing". No IRN was filed, so no NIC reversal needed.
- `Invoice.irnStatus = 'pending'` (a call in flight) → wait or block. The preflight transaction is short — if `updated_at > now() - 5 min`, retry the check; otherwise treat as failed and cancel.

### 4.3 Pending CreditNote / DebitNote

- `status = 'pending_cn' / 'pending_dn'` (`approved_at IS NULL`) → set `status = 'rejected_cn' / 'rejected_dn'` with `note = 'Customer account deleted'`. No NIC call has happened yet.
- `status = 'approved_cn'` or `issued` → RETAIN (statutory; IRN may exist).

### 4.4 Active DriverAssignment

- `status = 'active'` AND parent Order is still pending → covered by §4.1's hard-block rule.
- `status = 'active'` AND parent Order is delivered → set assignment `status = 'completed'` (defensive cleanup; this shouldn't normally happen).

### 4.5 Active sessions / tokens

See §5.

### 4.6 Open PendingAction rows for this user

- `entityType = 'user'` AND `entityId = <userId>` AND `status = 'open'` → set `status = 'skipped'`, `resolutionNotes = 'User-initiated account deletion'`.

### 4.7 PaymentCommitment with `status = 'open'`

If the deleting user is a customer with an open commitment (overdue order, promise-to-pay):
- The commitment itself is statutory (collections audit) — RETAIN.
- But it points to a pending Order — if that Order is being cancelled in §4.1, the commitment should be marked `status = 'broken'` with notes `'Account deleted'`. Distributor admin gets a PendingAction to write off or pursue separately.

### 4.8 Outstanding balance check (409 condition)

**Hard block** deletion (return 409) if the customer has `customer_ledger_entries` net balance > some threshold (Suneel decides — recommend ₹100 to allow rounding-error tails). Reason: a customer who owes the distributor money cannot simply delete and walk away — the distributor has a legal recovery right. UX message: "You have ₹X outstanding. Please contact the distributor to settle before deleting your account."

For drivers/admins/finance/inventory: no balance check; their deletion doesn't extinguish customer balances.

---

## 5. Session + Token Revocation

### 5.1 Server-side

- `User.refreshToken` → NULL. Kills the long-lived refresh path.
- `User.passwordHash` → unreachable random value. Prevents password-based login even if email anonymization somehow leaked.
- `User.email` → ANON. Email-based login lookup `findUnique({ email })` returns nothing.

### 5.2 Active JWT access tokens

Access tokens are stateless. They CANNOT be revoked centrally without a denylist (we don't have one and it's out of scope for this WI).

**Mitigation:** access tokens are short-lived (15 min — confirm with [packages/api/src/services/authService.ts]). Within that window, the JWT still authenticates — but:
- Every middleware-protected route does `prisma.user.findUnique({ id: req.user.id })` and rejects if `User.status = 'inactive'` OR `User.deletedAt IS NOT NULL`. **Add this check if it isn't already there** — see open question §10.
- Within 15 minutes the access token naturally expires; the refresh attempt fails (refresh token nulled in §5.1); the user is force-logged-out.

### 5.3 Client-side (mobile)

- On 204 response from `DELETE /api/users/me`, the mobile app immediately:
  1. Calls `useAuthStore.getState().clear()` to drop in-memory state.
  2. Calls `await SecureStore.deleteItemAsync('jwt')` and `await SecureStore.deleteItemAsync('refreshToken')`. Required — per CLAUDE.md Mobile Rule #1, tokens live in `expo-secure-store`, NOT AsyncStorage.
  3. Calls `await AsyncStorage.clear()` for cached query state.
  4. Resets the React Query cache: `queryClient.clear()`.
  5. Resets the navigator to `/login`.

### 5.4 Concurrent sessions on web

If the user has a web session open, it dies on next request when middleware checks `User.deletedAt`. Document in privacy policy; no further action.

### 5.5 Push notification tokens / FCM

**Not in current schema.** When push tokens are added (item #5 in CLAUDE.md "MUST DO" list), the spec must include a `UserDeviceToken` model with a deletion-cascade rule.

---

## 6. API Contract — `DELETE /api/users/me`

### 6.1 Route

```
DELETE /api/users/me
Authorization: Bearer <accessToken>
Content-Type: application/json
```

Mounted in `packages/api/src/app.ts` under `/api/users` with `authenticate` + `resolveDistributor` middleware. **Crucially: no `requireDistributor`** — a customer-portal user has `distributorId` set via Customer; no distributor-header needed.

### 6.2 Request body

```json
{
  "confirmText": "DELETE MY ACCOUNT"
}
```

Zod schema (`packages/api/src/routes/userRoutes.ts` or similar):
```ts
const deleteSelfSchema = z.object({
  confirmText: z.literal('DELETE MY ACCOUNT'),
});
```

The literal check is the server-side enforcement of the in-app force-typed confirmation. If a client sent the API call without the exact string, return 400.

### 6.3 Responses

| Status | When | Body |
|--------|------|------|
| `204 No Content` | Success — anonymization committed. | (empty) |
| `400 Bad Request` | `confirmText` missing or not exactly `"DELETE MY ACCOUNT"`. | `{ error: { code: 'INVALID_CONFIRMATION', message: '...' } }` via `sendError`. |
| `401 Unauthorized` | No / invalid JWT. | Standard envelope from `sendUnauthorized`. |
| `409 Conflict` | Outstanding balance > threshold, OR active delivery in progress, OR (driver) active assignment in non-cancellable state. | `{ error: { code: 'DELETION_BLOCKED', message: '<reason>', context: { type: 'outstanding_balance' \| 'active_delivery' \| 'active_driver_assignment', detail: ... } } }` |
| `423 Locked` | User role is `super_admin`. Super-admins cannot self-delete. | `{ error: { code: 'SUPERADMIN_SELF_DELETE_BLOCKED', message: 'Super-admin accounts must be deleted by another super-admin.' } }` |
| `404 Not Found` | User already anonymized (`deletedAt IS NOT NULL`) — idempotency case. | Standard envelope. |
| `500 Internal Server Error` | Transaction rollback. | Standard envelope; alert via Sentry. |

### 6.4 Side effects — ordered

1. **Authenticate** (JWT middleware). Reject if invalid.
2. **Re-fetch User row** from DB (`prisma.user.findUnique({ id: req.user.id })`). If `deletedAt IS NOT NULL` → return 404 (idempotency).
3. **Role gate.** If `role = 'super_admin'` → return 423.
4. **Validate `confirmText`** (zod literal). If mismatch → 400.
5. **Pre-check blocking conditions:**
   - For customers: outstanding balance via `customer_ledger_entries` net sum > ₹100 → 409.
   - For customers: any Order with `status IN ('preflight_in_progress', 'pending_delivery')` → 409.
   - For drivers: any Order where `driverId = userId` AND `status IN ('pending_dispatch', 'preflight_in_progress', 'pending_delivery')` → 409.
6. **Begin Prisma transaction** (`prisma.$transaction(async tx => { ... })`).
7. **Apply anonymization mapping (§3.2)** in this order to avoid FK contention:
   1. Cancel pending Orders (§4.1).
   2. Cancel pending Invoices in draft (§4.2).
   3. Reject pending CN/DN (§4.3).
   4. Resolve open PendingAction rows for the user (§4.6).
   5. Mark PaymentCommitments broken (§4.7).
   6. Anonymize related Driver row (if role=driver).
   7. Anonymize related Customer row (if role=customer and no other Users link to it).
   8. Anonymize related CustomerContact, CustomerModificationRequest, CustomerAuditTrail, CustomerLedgerEntry (NULL free-text only).
   9. NULL free-text + geo on Orders + OrderStatusLog + InventoryEvent + CancelledStockEvent + AccountabilityLog + StockMismatchRecord linked to this user.
   10. Redact AuditLog `details` JSON + null IP/UA for `userId = <deleted>`.
   11. NULL `User.refreshToken`, `User.email` → ANON, `User.firstName/lastName` → ANON, `User.phone` → NULL, `User.passwordHash` → unreachable, `User.status` → `inactive`, `User.deletedAt` → `now()`.
8. **Write a final AuditLog row** with `action = 'user.account.deleted_self'`, `entityType = 'user'`, `entityId = userId`, `details = { affectedModels: [...], anonymizedAt: now() }`. This row's `userId` is the now-anonymized user — that's fine; the audit lineage stays.
9. **Commit transaction.**
10. **Return 204.**

### 6.5 Idempotency

A second `DELETE /api/users/me` for the same userId — but wait, the user's tokens are revoked after step 9, so they can't authenticate. The idempotency case is purely defensive against a client retrying mid-flight before getting the 204. Step 2's `deletedAt` check handles it (returns 404).

### 6.6 Multi-tenant safety

- A distributor admin **cannot** call `DELETE /api/users/{otherId}` via this endpoint — the path is `/me` only.
- A separate `DELETE /api/users/:id` endpoint exists today for distributor admins to deactivate seats (verify in [packages/api/src/routes/userRoutes.ts]). That endpoint is **out of scope** for this WI but must:
  - Be guarded by `requireRole(['distributor_admin', 'super_admin'])`.
  - Enforce `target.distributorId === req.user.distributorId` (or super_admin override). Per CLAUDE.md Anti-pattern #13, never trust the path param — re-fetch and check.

### 6.7 Rate limiting

Apply the same per-IP + per-user rate limiter as the auth endpoints (CLAUDE.md Mobile Rule #6). A bot spraying `DELETE /api/users/me` with stolen tokens shouldn't burn through them — 3 attempts per 15 minutes is enough.

---

## 7. In-App UX Flow

### 7.1 Three-screen flow

```
[Settings / Profile / Account screen]
        │
        ▼
[Screen 1: Entry point]
   ┌───────────────────────────────────────────┐
   │  Settings                                  │
   │  ─────────────────                         │
   │  • Profile                                 │
   │  • Notifications                           │
   │  • Privacy Policy                          │
   │  ─────────────────                         │
   │  🗑  Delete Account            (red text)  │  ← entry
   └───────────────────────────────────────────┘
                        │ tap
                        ▼
[Screen 2: Disclosure]
   ┌───────────────────────────────────────────┐
   │  Delete Your Account                       │
   │  ─────────────────                         │
   │                                            │
   │  Your account will be deleted              │
   │  immediately. Your personal information    │
   │  — name, email, phone, address, and        │
   │  photo — will be permanently removed       │
   │  and cannot be recovered.                  │
   │                                            │
   │  As required by Indian Income Tax and      │
   │  GST law, your invoice and payment         │
   │  history must be retained for 8 years.     │
   │  After deletion these records remain in    │
   │  our system in ANONYMIZED form, linked     │
   │  to a non-identifying ID — not to you.     │
   │  They are used only for statutory tax      │
   │  compliance and audit, never for           │
   │  marketing or analytics.                   │
   │                                            │
   │  After 8 years, all records will be        │
   │  permanently deleted.                      │
   │                                            │
   │  This action cannot be undone. You will    │
   │  be signed out of all devices.             │
   │                                            │
   │  ┌───────────────────┐  ┌──────────┐       │
   │  │     Cancel        │  │ Continue │       │  ← Cancel primary, Continue secondary
   │  └───────────────────┘  └──────────┘       │
   └───────────────────────────────────────────┘
                        │ tap Continue
                        ▼
[Screen 3: Force-typed confirmation]
   ┌───────────────────────────────────────────┐
   │  Final Confirmation                        │
   │  ─────────────────                         │
   │                                            │
   │  Type DELETE MY ACCOUNT below to confirm.  │
   │                                            │
   │  ┌───────────────────────────────────┐     │
   │  │                                   │     │  ← text input
   │  └───────────────────────────────────┘     │
   │                                            │
   │  ┌───────────────────┐  ┌──────────┐       │
   │  │     Cancel        │  │  Delete  │       │  ← Delete disabled until exact match
   │  └───────────────────┘  └──────────┘       │
   │                                            │
   │  (loading spinner inline once tapped)      │
   └───────────────────────────────────────────┘
                        │ tap Delete (enabled), 204 received
                        ▼
[Screen 4: Result + forced logout]
   ┌───────────────────────────────────────────┐
   │  ✓  Account Deleted                        │
   │                                            │
   │  Your account has been deleted. Your tax   │
   │  records will be retained anonymously for  │
   │  8 years per Indian law. The app will      │
   │  now sign you out.                         │
   │                                            │
   │            ┌─────────┐                     │
   │            │   OK    │                     │  ← tap OK → forced navigation to /login
   │            └─────────┘                     │
   └───────────────────────────────────────────┘
                        │ tap OK
                        ▼
                  [/login screen]
                  (cannot log back in — email anonymized)
```

### 7.2 Error states on Screen 3

When `DELETE /api/users/me` returns non-204:
- `409` with `context.type = 'outstanding_balance'` → modal: "You have ₹X outstanding. Please contact the distributor to settle before deleting." Single OK button → back to Screen 1.
- `409` with `context.type = 'active_delivery'` → modal: "You have an active delivery in progress. Please try again after it's complete." Single OK.
- `409` with `context.type = 'active_driver_assignment'` → modal: "You have an active dispatch assignment. Please ask your distributor admin to reassign and try again." Single OK.
- `423` (super_admin) → modal: "Super-admin accounts cannot be self-deleted. Contact another super-admin." (Should never reach this — UI should hide the entry point for super_admin role; see §7.4.)
- `500` → modal: "Something went wrong. Please try again or contact support." Single OK.

### 7.3 Files to add/change

**Add:**
- `packages/mobile/app/(shared)/delete-account/index.tsx` — Screen 2 (disclosure).
- `packages/mobile/app/(shared)/delete-account/confirm.tsx` — Screen 3 (force-typed).
- `packages/mobile/app/(shared)/delete-account/done.tsx` — Screen 4 (result).
- `packages/mobile/src/api/account.ts` — `deleteAccount()` API client, calls `useApiMutation` per CLAUDE.md Mobile Rule #3.

Alternative single-screen-per-role approach (NOT recommended — leads to drift):
- `packages/mobile/app/(customer)/settings/delete-account.tsx` + driver + admin + finance + inventory + super-admin. 6× the screens, same logic. Avoid.

**Modify:**
- `packages/mobile/src/components/DeleteAccountButton.tsx` — replace `mailto:` `handleOpenMail` with `router.push('/(shared)/delete-account')`. Drop the modal entirely OR keep it as the entry but make its CTA go to the new flow.
- The 6 screens that today use `<DeleteAccountButton />`:
  - `packages/mobile/app/(admin)/more.tsx`
  - `packages/mobile/app/(super-admin)/settings.tsx` — additionally hide for super_admin role (§7.4).
  - `packages/mobile/app/(customer)/account.tsx`
  - `packages/mobile/app/(driver)/profile.tsx`
  - `packages/mobile/app/(finance)/profile.tsx`
  - `packages/mobile/app/(inventory)/profile.tsx`
  - No changes needed beyond the underlying component update — they each just render `<DeleteAccountButton />`.

### 7.4 Super-admin hide

In `packages/mobile/app/(super-admin)/settings.tsx`, wrap the `<DeleteAccountButton />` with `{user.role !== 'super_admin' && ...}`. Belt + braces alongside the 423 server response.

### 7.5 Loading / error states

Per CLAUDE.md Mobile Rule #2, every screen handles loading / error / empty:
- Screen 3 Submit button shows spinner while mutation is in-flight.
- 409 / 423 / 500 → modal pattern above.
- Network error → "No internet connection. Please try again." (Mobile is offline-aware per CLAUDE.md Mobile Rule #4 — but account deletion is not queueable; the user must be online.)

---

## 8. Test Plan

### 8.1 Unit tests

**File:** `packages/api/src/__tests__/account-deletion-anonymization.test.ts`

- Seed a customer User + Customer + CustomerContact + 5 historical Orders + 5 historical Invoices (irn=success) + a PaymentTransaction + an AuditLog with PII in details + 1 open Order.
- Call the anonymization function (extracted from the route handler for testability).
- Assert per the §3.2 mapping:
  - `User.email` matches `/^deleted-[a-f0-9]+@anon\.mygaslink\.local$/`
  - `User.firstName === 'Deleted'`, `lastName === 'User'`, `phone IS NULL`, `passwordHash !== originalHash`, `refreshToken IS NULL`, `status === 'inactive'`, `deletedAt IS NOT NULL`.
  - `Customer.customerName === 'Deleted Customer'`, `phone === ''`, `email IS NULL`, billing address line 1-2 NULL, billing state RETAINED.
  - 5 historical Invoice rows: every field unchanged (snapshot-compare).
  - 5 historical Order rows: `specialInstructions`/`deliveryNotes` NULL, `customerId` UNCHANGED, status UNCHANGED.
  - The 1 open Order: `status === 'cancelled'`, `cancellationReason === 'Customer account deleted'`.
  - AuditLog row with the deletion: present, `action === 'user.account.deleted_self'`.
  - AuditLog rows on the deleted user: `details = { redacted: '...' }`, `ipAddress IS NULL`, `userAgent IS NULL`.

- Repeat for a driver User (assert Driver row anonymized, no Customer cascade).
- Repeat for an admin User (assert User-only anonymization, no Customer/Driver cascade).

**Anti-pattern guard test:** assert that for every Prisma update used by the anonymization function, `distributorId` is in the `where` clause (per CLAUDE.md Anti-pattern #13). Pattern lifted from [packages/api/src/__tests__/anti-pattern-guards.test.ts].

### 8.2 Integration tests

**File:** `packages/api/src/__tests__/users-delete-me.test.ts`

- `DELETE /api/users/me` with valid token + confirmText → 204; subsequent GET on the user 404s.
- Without confirmText → 400.
- Without token → 401.
- Customer with outstanding balance > ₹100 → 409 `outstanding_balance`.
- Customer with order in `pending_delivery` → 409 `active_delivery`.
- Driver with order in `pending_delivery` → 409 `active_driver_assignment`.
- super_admin role → 423.
- Second call after success → 404 (idempotency).
- **Multi-tenant guard:** delete user from dist-001; verify dist-002's customers, orders, drivers, invoices, audit logs are bit-identical (snapshot-compare).
- **Statutory retention guard:** delete a customer with 3 historical Invoices (one with `irn='abc123'`); verify all 3 Invoice rows are completely untouched (every field).

### 8.3 E2E (manual)

Steps documented in `docs/E2E_Testing_Guide.xlsx` (add new tab "Account Deletion"):
1. Log in as customer `royal@kitchen.com`.
2. Navigate Settings → Account → Delete Account.
3. Confirm disclosure screen text matches §2 verbatim.
4. Tap Continue. Type `delete my account` (lowercase) → Delete button stays disabled.
5. Type `DELETE MY ACCOUNT` → Delete button enables.
6. Tap Delete → spinner → success screen.
7. Tap OK → routed to /login.
8. Attempt login with `royal@kitchen.com / Customer@123` → "Invalid credentials" (email anonymized).
9. Verify in DB (`pnpm db:studio`): User row has `firstName='Deleted'`, `email LIKE 'deleted-%@anon.mygaslink.local'`, `deletedAt IS NOT NULL`. Customer row anonymized. Historical Invoice rows unchanged.

### 8.4 Apple-reviewer test account

Create a dedicated TestFlight account `apple-reviewer@mygaslink.com` with role `customer`, distributor `Bhargava Gas Agency`. Seed 1 historical paid Invoice and 0 pending orders. Document in the App Store Connect "Notes for Reviewer" field:

> "To test account deletion: log in as apple-reviewer@mygaslink.com / [password], navigate Settings → Account → Delete Account, follow the in-app flow. The account is rebuilt nightly by our seed script so you can re-test."

Add the seed step to `packages/api/scripts/seed-apple-test-account.ts` and to nightly cron.

### 8.5 OWASP / security review

- Re-run `/secure` skill on the diff.
- Specifically verify (per CLAUDE.md Anti-pattern #13): every Prisma write in the anonymization function has `distributorId` in `where` where the model is tenant-scoped.
- Verify the `confirmText` literal is server-validated (CLAUDE.md Anti-pattern §2 — never trust client claims).

---

## 9. Effort Estimate

| Section | Work | Hours |
|---------|------|-------|
| §3 | Anonymization service — Prisma updates for 14 models in a single transaction | 4 |
| §4 | Pending-order / pending-invoice cleanup logic + 409 pre-checks | 3 |
| §5 | Token revocation: server (User.refreshToken null + middleware deletedAt check) + mobile SecureStore wipe | 2 |
| §6 | `DELETE /api/users/me` route + zod schema + responses + auditLog write | 3 |
| §7 | 3 mobile screens (disclosure / confirm / done) + entry-point rewire + super-admin hide | 6 |
| §8 | Unit + integration + manual E2E + Apple-reviewer seed | 6 |
| Privacy policy / store metadata update | Update `mygaslink.com/privacy` + App Store / Play Store data safety forms to reflect anonymization | 1.5 |
| Code review + fix-up | Self-review + Suneel review + iterate | 2 |
| **Total** | | **27.5 hours ≈ 3.5 working days** |

**Risk factors:**
- The §4 pre-checks (outstanding balance, active delivery) need careful query design — getting the balance computation wrong could either (a) block legitimate deletions, embarrassing, or (b) allow deletion of a customer with ₹50k outstanding, real financial harm. Budget the extra 1h for query review.
- The Customer cascade rule ("anonymize only if no other Users link to this Customer") needs a real query — a B2B customer can have 3 portal logins for 3 employees. Confirm with Suneel: is that even a supported pattern today? If not, skip the multi-user check.

If §10's open question on User↔Driver linkage requires a schema migration (adding a `Driver.userId` FK), add 4 hours. Not included in the estimate above.

---

## 10. Open Questions for Suneel

1. **Statutory retention period.** I picked 8 years to cover Income Tax §149 reassessment (extended to 10y for high-value). CGST Rule 56(15) says 6 years; PESO/LPG control orders ~3 years. **Confirm with the CA: is 8 years correct, or should it be 6 years (CGST) / 10 years (IT reassessment)?** The user-facing disclosure (§2) is locked to "8 years" — if CA says 10, we update copy.

2. **Super-admin self-deletion.** I've blocked it entirely (423) — Suneel is the only super-admin and self-deleting would orphan the platform. **Confirm: never allow super_admin self-delete; must be deleted by another super_admin via a separate admin endpoint** (out of scope for this WI). Or: do you want a delegated-deletion-request workflow instead?

3. **Distributor-admin self-deletion → orphaned tenant.** If the *only* distributor_admin for a tenant deletes themselves, the tenant has zero admins and becomes unmanageable (driver/finance/inventory can't add new users). Recommended behaviour: **block** with a 409 if `user.role === 'distributor_admin'` AND `count(other distributor_admins in same tenant where deletedAt IS NULL) === 0`. UX message: "You are the only admin for this distributor. Please add another admin before deleting your account."

4. **User↔Driver linkage.** The schema has no FK between `User` (`role='driver'`) and `Driver`. The link is by-convention (same `distributorId` + matching `phone`?). **Confirm the actual join rule** so the cascade in §3.1 / §3.2.17 can be implemented. If there's no reliable link, we can either (a) skip the Driver cascade (anonymize User only) — Driver row continues to hold the human's name + phone — or (b) require schema migration to add `Driver.userId String? @unique`. Option (b) is cleaner but adds 4 hours.

5. **B2B customer with multiple portal logins.** A single Customer row (B2B account) can be referenced by multiple User rows (`User.customerId`). If User A deletes themselves and Users B + C still link to the same Customer, we **must not** anonymize the Customer (B + C still need it). The §3.1 rule handles this — but is the multi-user-per-customer pattern actually used in production today? If "no," the check is dead defence; if "yes," we need an integration test.

6. **Anonymization of cross-references the user appears in.** Currently a Customer entity can have multiple `CustomerContact` rows (e.g., a husband-and-wife B2B account). If the husband deletes his account and the wife is a contact (name = husband), do we re-point her contact? Recommended: **no**, contacts are statutorily-irrelevant operational metadata; let them stale-out. Confirm.

7. **`ContactSubmission` rows (lead form).** Per §3.2.47 I've deferred anonymizing `contact_submissions` rows whose `phone`/`email` match the deleting user. Confirm we can defer this to a follow-up WI — it's a pre-auth lead-form table; not in the JWT-authenticated user's "owned data" by strict reading.

8. **Real-time NIC reversal for pending IRN.** §4.2 says we cancel draft invoices but don't reverse already-filed IRNs. The Apple disclosure (§2) says "personal information removed" — does the GSTIN/name/address on a *retained, NIC-filed* invoice count as "personal information"? My read: no — it's a tax document, exempt under "legitimate legal purposes." But a strict reading of DPDP could argue otherwise. **Get CA + legal sign-off on the disclosure copy before App Store submission.**

9. **Push notification tokens.** Push isn't shipped yet (CLAUDE.md "MUST DO" item #5). When it is, the spec must add the `UserDeviceToken` model to §3.2. Flag now so it doesn't slip when push lands.

10. **Idempotency response code.** I chose 404 for "user already anonymized" so it's distinguishable from "operation succeeded." Some shops return 204 unconditionally (idempotent PUT/DELETE convention). Confirm preference.

---

## Appendix A — Privacy Policy Update Required

`mygaslink.com/privacy` currently states "Account deletion is processed within 30 days." This MUST be updated before shipping:

- Add: "You can delete your account directly within the app at Settings → Account → Delete Account. Deletion is immediate."
- Add: "Personal information (name, email, phone, address, photo) is permanently removed. Invoice and payment records are retained in anonymized form for 8 years as required by Indian Income Tax and GST law (CGST Rule 56(15), Income Tax §149). After 8 years, all records are permanently deleted."
- Add: "Anonymized records are linked to a random identifier and cannot be traced back to you. They are used only for statutory tax compliance and audit."

Owner: Suneel (content) + dev (publish).

## Appendix B — App Store / Play Store data-safety form delta

App Store Connect → "App Privacy" section:
- Confirm "Account Deletion" → "Yes, in-app."
- Update "Data Retention" section to mention 8-year anonymized retention.

Google Play Console → "Data Safety" section:
- Same disclosures.
- "Account Deletion Web Resource" field — point to the new in-app path documentation (or remove if Play allows in-app-only).

---

*End of spec. Implementation should produce a WI-spec (`/work-new`) referencing this document.*
