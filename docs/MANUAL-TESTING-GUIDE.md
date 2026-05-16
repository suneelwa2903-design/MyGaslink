# Manual Testing Guide — Re-New GasLink

For founder QA tomorrow. 7 sessions, ~3 hours total. Run them in order.

Prerequisite: complete `docs/LOCAL-DEV-STARTUP.md` first (Docker up, DB migrated + seeded, `pnpm dev` running).

---

## SESSION 1 — Super Admin (~30 min)

**Credentials:** `admin@mygaslink.com` / `Admin@123`
**Starting URL:** http://localhost:5173

### Test 1.1: Login and dashboard

Steps:
1. Open browser, go to http://localhost:5173
2. Enter super admin email and password
3. Click Sign In

Expected:
- Login succeeds, redirects to the app
- Sidebar visible with at minimum: Distributors, Analytics, Provider Catalog, Health Monitoring, Pending Actions
- No console errors (open DevTools → Console)

Pass criteria: dashboard loads, sidebar visible, console clean

Notes: ___________

### Test 1.2: View distributor list

Steps:
1. Click Distributors in the sidebar

Expected:
- Table of distributors with at least: business name, plan, status, GST mode columns
- At least 2 distributors visible: "Bhargava Gas Agency" and "Sharma Gas Distributors"

Pass criteria: table loads, both seeded distributors visible

Notes: ___________

### Test 1.3: Switch tenant context

Steps:
1. Click on "Bhargava Gas Agency" row
2. Detail page opens with billing / GST usage / seat usage sections
3. Look for the distributor selector in the top header bar (or a "View as" affordance) — switch to Bhargava
4. Navigate to Analytics

Expected:
- Header / banner shows the current tenant context (Bhargava)
- Analytics dashboard now shows Bhargava's data (orders, customers, etc — populated by the seed)
- No data from Sharma is visible

Pass criteria: data scopes to Bhargava; cross-tenant isolation visually confirmed

Notes: ___________

### Test 1.4: GSTIN lookup on new distributor

Steps:
1. Go back to Distributors → click New Distributor (or "+ Create" button)
2. Find the GSTIN field
3. Enter: `29AABCU9603R1ZX` (a public test GSTIN)
4. Click the lookup / search affordance next to the field

Expected:
- Legal name and address auto-populate from WhiteBooks
- (If WhiteBooks credentials aren't set up, expect a clear error message — not a 500)

Pass criteria: fields fill OR a clear "credentials not configured" error appears

Notes: ___________

### Test 1.5: Provider catalog

Steps:
1. Click Provider Catalog in sidebar

Expected:
- List of cylinder types from oil companies
- Columns include type name, capacity, oil company

Pass criteria: list loads with at least a few entries

Notes: ___________

---

## SESSION 2 — Distributor Admin (~60 min)

**Credentials:** `bhargava@gasagency.com` / `Distadmin@123`
**Starting URL:** http://localhost:5173

### Test 2.1: Morning dashboard sections (NEW today)

Steps:
1. Login as distributor admin
2. Observe the dashboard layout — note the order of sections from top to bottom

Expected — these 4 sections in this exact order:
1. **Stock Position** — every active cylinder type shows: type name, fulls count, empties count, color-coded badge (green=OK, yellow=WARNING, red=CRITICAL)
2. **Today's Dispatch** — three cards: pending dispatch count, orders today count, delivered today count
3. **Call these customers today** — overdue call list, max 8 rows, columns: customer name, phone (tappable `tel:`), total outstanding, days overdue badge
4. **Pending Actions** — existing action queue, now BELOW the morning briefing

If the seed didn't create overdue invoices, section 3 will say "No customers past their credit period" — that's still pass.

Pass criteria: all 4 sections visible in correct order; click-throughs from Stock Position, Today's Dispatch, and "View all →" on the call list all navigate correctly
Fail criteria: any section missing, sections in wrong order, console errors

Notes: ___________

### Test 2.2: Onboarding checklist (NEW today)

Steps:
1. Click Settings in sidebar
2. The first tab in Settings should be "Onboarding"
3. Click Onboarding

Expected:
- Progress bar showing "X of 5 required steps complete"
- 6-step checklist:
  1. Add cylinder types and prices
  2. Add your drivers and vehicles
  3. Add your customers
  4. Enter opening stock balance
  5. Import customer opening balances (CSV)
  6. Configure GST (optional — marked as such)
- Each completed step shows a green checkmark; incomplete steps show their step number
- Below the checklist: a "Bulk import" card with two options (Import customers / Import opening balances), each with Download template + Upload CSV buttons

Pass criteria: checklist visible, progress bar accurate, all 6 steps listed

Notes: ___________

### Test 2.3: CSV customer import (NEW today)

Steps:
1. In Settings → Onboarding → Bulk import card → click **Download template** (Import customers)
2. Open the downloaded `customers-template.csv` — verify columns: `name, phone, address, gstin, credit_period_days, customer_type`
3. Edit the CSV — keep the header row, add 3 new rows with test data (use unique phone numbers like 9999000001, 9999000002, 9999000003)
4. Save the file
5. Click **Upload CSV** → pick your edited file
6. Modal opens with a preview table showing your 3 rows + a "valid rows" count
7. Click **Import 3 customers**
8. Toast or modal shows "Imported 3 · Failed 0"
9. Close the modal
10. Click Customers in the sidebar

Expected: your 3 new customers appear in the customer list

Pass criteria: all 3 customers created with the right names + phone numbers
Fail criteria: any row fails unexpectedly, or count mismatches

Notes: ___________

### Test 2.4: Opening stock balance entry (NEW today)

Steps:
1. Settings → Onboarding → click on **step 4** "Enter opening stock balance"
2. Modal "Enter Opening Stock" opens
3. Modal shows every active cylinder type as a row with two number inputs: Opening fulls, Opening empties
4. Fill in non-zero values for at least one cylinder type (e.g. 5 KG: fulls=50, empties=20)
5. Click **Save**

Expected:
- Toast "Opening stock saved (N cylinder type(s))"
- Modal closes
- Onboarding step 4 flips to a green checkmark
- Click Inventory in sidebar → today's summary shows the values you entered

Pass criteria: inventory summary reflects the entered values; step 4 is now done

Notes: ___________

### Test 2.5: Create and complete an order

Steps:
1. Click Orders in sidebar
2. Click **+ New Order** (or "Create Order" button)
3. Select a customer (e.g. "Royal Kitchen Restaurant")
4. Add a line item: pick a cylinder type, enter quantity 2
5. Set delivery date to today
6. Click Save

Expected: order created with status `pending_driver_assignment`. Find it in the orders list.

7. Open the order → click **Assign Driver**
8. Select an available driver (e.g. Raju)

Expected: status changes to `pending_dispatch`, driver name appears on the order

Pass criteria: order created, driver assigned, status transitions correctly

Notes: ___________

### Test 2.6: Generate invoice and record payment

Steps:
1. Find a delivered order in the list (or use the one from Test 2.5 after manually advancing it through delivery)
2. Open the invoice (auto-generated when delivery is confirmed; or click Generate Invoice if visible)
3. Verify line items match order items, total is correct
4. Click **Record Payment**
5. Enter an amount LESS than the invoice total (partial payment)
6. Method: Cash. Click Save.

Expected: invoice shows partial payment. Outstanding amount reduced by the payment amount.

7. Click **Record Payment** again, this time for the remaining outstanding amount

Expected: invoice status flips to **PAID**, outstanding shows ₹0 (or 0.0000 if Decimal display is verbose)

Pass criteria: payment math is exact (no floating-point drift visible — Decimal migration), status updates correctly, allocation recorded

Notes: ___________

### Test 2.7: Download invoice PDF

Steps:
1. Open any invoice
2. Find Download PDF button
3. Click it

Expected:
- PDF downloads or opens in a new tab
- PDF contains: distributor name, customer name, line items, total, GST breakdown if applicable, IRN/QR if GST live

Pass criteria: PDF downloads, contains correct data

Notes: ___________

---

## SESSION 3 — Finance User (~30 min)

**Credentials:** `finance@gasagency.com` / `Finance@123`
**Starting URL:** http://localhost:5173

### Test 3.1: Finance morning dashboard (NEW today)

Steps:
1. Login as finance user
2. Observe the dashboard

Expected — finance-specific view:
- **Call list** at the TOP (same overdue customers as the admin sees)
- **Unallocated payments** section below — top 20 unallocated/partially-allocated payments, sorted by amount desc, columns: customer name, date, allocation status, unallocated amount
- **GST failures** section — invoices with `irnStatus = 'failed'`, max 5 rows
- **Pending Actions** at the bottom

Should NOT see:
- Stock Position (not the finance role's job)
- Today's Dispatch (not their job)

Pass criteria: finance-only view; admin sections hidden

Notes: ___________

### Test 3.2: Collections call list (NEW today)

Steps:
1. Click Collections in sidebar
2. Look for tabs at top: "Call list" and "All collections"
3. Click **Call list** (default)

Expected:
- Desktop: table with columns: Customer, Outstanding, Overdue invoices, Days overdue, Phone, View account
- Phone column: each phone is a `tel:` link
- Sorted by days overdue descending (most overdue at top)
- Click "All collections" tab → shows the existing full collections table

If on a phone-sized window: cards instead of a table, with a big "Call <phone>" button per customer.

Pass criteria: call list loads, sorted correctly, phone numbers tappable, tab toggle works

Notes: ___________

### Test 3.3: Record payment and allocate

Steps:
1. Click Billing & Payments in sidebar
2. Click **Record Payment**
3. Select a customer with outstanding invoices
4. Enter payment amount, choose method
5. Look for allocation options — auto or manual

Expected: payment can be auto-allocated (FIFO across outstanding invoices) or manually applied to specific invoices

6. Complete the payment

Expected: outstanding balances reduce correctly. The payment shows on the customer's ledger.

Pass criteria: payment recorded, allocations correct, ledger updated

Notes: ___________

---

## SESSION 4 — Inventory User (~30 min)

**Credentials:** `inventory@gasagency.com` / `Inventory@123`
**Starting URL:** http://localhost:5173

### Test 4.1: Inventory morning dashboard (NEW today)

Steps:
1. Login as inventory user
2. Observe the dashboard

Expected — inventory-specific view:
- **Stock Position** at the top (same component as admin sees)
- **Vehicles pending reconciliation** section — driver-vehicle assignments for today not yet reconciled
- **Threshold alerts** — cylinder types currently below warning/critical level
- **Pending Actions** at the bottom

Should NOT see:
- Financial/collections data (not their job)

Pass criteria: inventory-specific view; financial sections hidden

Notes: ___________

### Test 4.2: Record incoming stock

Steps:
1. Click Inventory in sidebar
2. Find "Record Incoming" or "Incoming Fulls" button
3. Select a cylinder type
4. Enter quantity (e.g. 100)
5. Enter document number (any reference like "INV-TEST-001")
6. Save

Expected: today's daily summary updates to reflect the new stock

Pass criteria: stock count increases by the entered amount

Notes: ___________

### Test 4.3: View daily summary

Steps:
1. On the Inventory page, find Daily Summary or Depot view
2. Select today's date

Expected: table per cylinder type showing: Opening fulls, Incoming, Outgoing, Closing. Numbers add up: closing = opening + incoming - outgoing.

Pass criteria: summary visible with correct totals

Notes: ___________

---

## SESSION 5 — Driver on Mobile (~20 min)

**Setup:**
1. Install Expo Go on phone (Play Store / App Store)
2. Phone and laptop on same Wi-Fi
3. Find your laptop's LAN IP (`ipconfig` on Windows, `ifconfig` on macOS)
4. Edit `packages/mobile/.env` and set `EXPO_PUBLIC_API_URL=http://<YOUR-LAN-IP>:5000/api`
5. Run `pnpm dev:mobile` from the repo root
6. Scan the QR code from your terminal with Expo Go

**Credentials:** `raju@gasagency.com` / `Driver@123`

### Test 5.1: Login on mobile

Steps:
1. App loads in Expo Go → login screen appears
2. Enter driver credentials → tap Sign In

Expected: driver dashboard loads. Tab bar at the bottom shows: Analytics, My Deliveries, Trip, Vehicle Stock, More.

Pass criteria: login works, driver view visible

Notes: ___________

### Test 5.2: View and confirm a delivery

Steps:
1. Tap **My Deliveries** tab
2. List of assigned orders for today appears

(If the list is empty: from web as `bhargava@gasagency.com`, create an order, assign Raju as the driver, then return here.)

3. Tap an order → detail view with customer name, address, items
4. Tap **Confirm Delivery**
5. Form for entering delivered quantities + empties collected
6. Optional: take a photo via the proof-of-delivery camera
7. Tap Submit

Expected:
- Toast/alert "Delivery confirmed!"
- Order disappears from pending list (or moves to delivered status)

Pass criteria: delivery confirmed successfully end to end

Notes: ___________

### Test 5.3: Offline delivery confirmation (NEW today)

Steps:
1. Make sure there's at least one undelivered order in the list (create one from web admin if needed)
2. **Turn OFF Wi-Fi on the phone** (and disable mobile data, OR stop the API server with Ctrl+C in the terminal)
3. Open an undelivered order on mobile
4. Tap Confirm Delivery → enter quantities → tap Submit

Expected:
- Alert: "Saved offline — Delivery will sync automatically when you're back online"
- Order shows a **"pending sync"** orange badge instead of its normal status
- The My Deliveries tab icon shows an orange badge with the count of pending syncs (e.g. "1")

5. **Turn Wi-Fi back ON** (or restart the API server with `pnpm dev:api`)

Expected: within ~5-10 seconds the queue auto-syncs (NetInfo listener fires on reconnect). Pending sync badge disappears.

6. Switch to web as `bhargava@gasagency.com` → verify the delivery is recorded against the order.

Pass criteria: offline save works, auto-sync on reconnect works, server records the delivery exactly once

Notes: ___________

---

## SESSION 6 — Customer Portal (~20 min)

**Credentials:** `royal@kitchen.com` / `Customer@123`
**Starting URL:** http://localhost:5173

This account is linked to "Royal Kitchen Restaurant" customer under Bhargava Gas Agency.

### Test 6.1: Login and dashboard

Steps:
1. Login as customer

Expected:
- Customer portal dashboard (NOT the admin dashboard)
- Cards/sections showing: orders pending, invoices outstanding, amount outstanding, cylinder balance summary

Pass criteria: customer-portal view, NOT admin view

Notes: ___________

### Test 6.2: Place an order

Steps:
1. Click Orders or "My Orders"
2. Click **+ Place Order**
3. Pick a cylinder type and quantity
4. Pick a delivery date
5. Submit

Expected: order created, appears in the order list with `pending_driver_assignment` status

Pass criteria: order placed, visible in list

Notes: ___________

### Test 6.3: Driver contact visibility (NEW today)

Steps:
1. From web as `bhargava@gasagency.com`, find one of Royal Kitchen's orders, assign Raju as the driver, save (status should now be `pending_dispatch`)
2. Back on customer portal as Royal Kitchen → open that order

Expected: a highlighted callout section "**Your delivery driver**" with:
- Driver name (Raju)
- Driver phone as a tappable `tel:` link

3. Find a delivered order (or mark this one delivered from the admin side, then re-open here)

Expected: "Your delivery driver" callout is **NOT** visible (delivered = no need to call).

4. Find an order still at `pending_driver_assignment` (no driver assigned yet)

Expected: callout NOT visible (no driver yet).

Pass criteria: driver contact appears ONLY during in-flight statuses (`pending_dispatch` / `pending_delivery`)

Notes: ___________

### Test 6.4: View and download invoice

Steps:
1. Click Invoices or "My Invoices"

Expected: list of invoices for THIS customer only (Royal Kitchen)

2. Click on an invoice → detail view with line items, total, payment status
3. Find Download PDF → click

Expected: PDF downloads with the correct invoice data

Pass criteria: invoice list scoped, PDF downloads correctly

Notes: ___________

---

## SESSION 7 — Tenant Isolation (~20 min)

This session verifies that distributors cannot see each other's data. Critical security check.

**Credentials:**
- Distributor A: `bhargava@gasagency.com` / `Distadmin@123` (Bhargava Gas Agency)
- Distributor B: `sharma@gasdist.com` / `Gstadmin@123` (Sharma Gas Distributors)

### Test 7.1: Customer list isolation

Steps:
1. Login as Distributor A (Bhargava)
2. Click Customers → write down 3 customer names you see (e.g. "Royal Kitchen Restaurant", "Spice Garden Hotel")
3. Click into one — note the customer ID from the URL (e.g. `/customers/abc-123-...`)
4. Logout
5. Login as Distributor B (Sharma)
6. Click Customers

Expected: NONE of Bhargava's customer names appear

Pass criteria: complete separation
Fail criteria: any Bhargava customer visible to Sharma

Notes: ___________

### Test 7.2: Direct URL access attempt

Steps:
1. Still logged in as Sharma
2. In the browser address bar, paste a URL referencing one of Bhargava's customer IDs:
   `http://localhost:5173/app/customers/<bhargava-customer-id>`

Expected: 404 page, redirect, or empty/access-denied state — Bhargava's customer data NOT shown

Pass criteria: access denied OR 404 OR redirect
Fail criteria: Bhargava's customer details appear

Notes: ___________

### Test 7.3: Order isolation

Steps:
1. Login as Bhargava → note an order ID from any order URL
2. Logout, login as Sharma
3. Navigate to `http://localhost:5173/app/orders/<bhargava-order-id>`

Expected: 404, redirect, or access denied — NOT the order

Pass criteria: order not accessible across distributor boundary

Notes: ___________

---

## SESSION 8 — GST Compliance Flow (Sharma, ~45 min) (NEW — WI-035 to WI-043)

These tests exercise the full pre-dispatch GST pipeline added in WI-035 through WI-043. Run as `sharma@gasdist.com / Gstadmin@123` unless a step explicitly switches users — Sharma is the only seeded distributor with `gstMode=sandbox`, so the WhiteBooks calls actually fire.

> **Prereqs:** API running on :5000, web on :5173, postgres up. Sharma's e-Invoice and e-Way Bill credentials must already be Valid (Settings → GST tab). If they aren't, run **Test 8.4** first.

---

### Test 8.1: Dispatch flow — per-driver button + progress modal (WI-036)

Steps:
1. Login as `sharma@gasdist.com`.
2. Navigate to **Orders → Driver Assignment** tab.
3. Find any unassigned order on today's delivery date (create one if none — Test 2.5 has the recipe). Assign it to a driver with a confirmed vehicle mapping (Kiran Reddy on KA01-MN-9999 is seeded).
4. Scroll to the "Ready to Dispatch" section that appears below the assignment table. Confirm the driver card shows: `Kiran Reddy KA01-MN-9999`, order count, total value, and a `Dispatch Kiran ▶` button.
5. Click `Dispatch Kiran ▶`.
6. The progress modal opens with `Dispatching Kiran Reddy's orders` and a spinner reading "Generating IRN / EWB at WhiteBooks…".
7. When the response returns, confirm per-order rows render with a green ✓ for each success, showing `B2B · IRN xxxx… · EWB xxxx` (or `B2C` for B2C customers).
8. On full success the modal shows "N/N dispatched successfully" plus a `Download Trip Sheet` button.

Expected: dispatched orders disappear from the assignment list. Their status flips to `Out for Delivery` (orange badge) on the Orders tab. Browser console stays clean.

Pass criteria: ✓ all orders succeed (or partial-success modal with per-order error messages); ✓ assignment status moves to `loaded_and_dispatched`; ✓ zero console errors.

Notes: ___________

---

### Test 8.2: Trip sheet PDF download (WI-038)

Steps:
1. From Test 8.1's successful modal, click `Download Trip Sheet`. (If you closed the modal, the assignment can still be re-fetched — call the endpoint directly: `http://localhost:5000/api/orders/trip-sheet/<assignmentId>`.)
2. PDF opens / downloads.

Expected: A4 PDF titled `DELIVERY TRIP SHEET` (or `SINGLE ORDER TRIP SHEET` if only one order) with:
- Driver name + vehicle number + date in the header
- `Consolidated EWB: <number>` (or `EWB References: N per-order EWBs (listed below)` for the fallback path)
- Table listing every order with Order # | Customer | Address | EWB No | Items | Value
- Footer line affirming legal validity

Pass criteria: ✓ PDF opens; ✓ EWB numbers match what the dispatch modal showed; ✓ download triggered through the shared axios client (no JSON-as-PDF — anti-pattern #5).

Notes: ___________

---

### Test 8.3: Invoice PDF — EWB No in header (WI-041)

Steps:
1. Still as Sharma. Navigate to **Billing & Payments → Invoices** tab.
2. Find an invoice that has both an IRN and an EWB (any of the dispatched orders from Test 8.1 — filter by `irnStatus=success`).
3. Click the download icon on the row to fetch the invoice PDF.

Expected: invoice PDF header (top-right) shows three stacked lines:
```
Tax Invoice
GST Doc No: INV-xxxxxxxxxxxxxxx
EWB No: 181012xxxxxx
```
The `EWB No` line appears only when `gstDoc.ewbNo` is present.

Pass criteria: ✓ EWB No line visible; ✓ format matches above; ✓ existing e-Documents card at the bottom (with QR + validity dates) still renders.

Notes: ___________

---

### Test 8.4: GST credentials Settings UI — Test & Save + Test Connection (WI-042)

Steps:
1. Navigate to **Settings → GST** tab.
2. Confirm two cards render: `e-Invoice Credentials` and `e-Way Bill Credentials`. Each shows masked Client ID, username, GSTIN, a status pill (`● Valid` or `● Not validated`) with the last-validated date.
3. Click `Test Connection` on the e-Invoice card.
   - **Expected on valid creds:** toast `Connection validated`; status pill stays / becomes `Valid` with today's date.
   - **Expected on invalid creds:** toast with the WhiteBooks error message; pill flips to `Not validated`.
4. Click `Update Credentials` on the e-Way Bill card.
5. In the modal, change the `Password` field to `WrongPassword123` and click `Test & Save`.
6. Expected: modal stays open; toast shows the actual WhiteBooks `AUTH_FAILED` message; the stored row's `isValid` is now false (verify via the pill after closing).
7. Re-open the modal, restore the correct password, click `Test & Save`.
8. Expected: toast `Credentials validated ✓`; modal closes; pill returns to `Valid`.

Pass criteria: ✓ Test & Save authenticates BEFORE persisting; ✓ failures surface the NIC error message verbatim; ✓ finance role (`finance@gasagency.com`) cannot see/click these buttons (verify in a second login session).

Notes: ___________

---

### Test 8.5: Customer GSTIN autofill (WI-040)

Steps:
1. Navigate to **Customers**, click `New Customer`.
2. In the modal, leave the GSTIN field empty. Confirm the `Fetch Details` button under the field is **disabled**.
3. Enter a valid GSTIN (sandbox: `29AAGCB1286Q1Z0` works for testing). The button enables.
4. Click `Fetch Details`.

Expected (success): a green `● Active` pill appears next to the button; `Business Name`, `Address Line 1`, `City`, `State`, and `Pincode` fields auto-populate from the NIC response. `Customer Name` and `Phone` stay untouched (preserved on purpose — NIC contact data is often stale).

Expected (failure path): for an invalid GSTIN like `29INVALID00000Z0`, a red error message renders next to the button without clearing existing field values.

Pass criteria: ✓ autofill works on a valid GSTIN; ✓ finance / inventory / distributor_admin all reach this endpoint (WI-043 widened access); ✓ no console errors.

Notes: ___________

---

### Test 8.6: Credit Note workflow — create → approve → IRN → PDF (WI-039)

Steps:
1. Login as `finance@gasagency.com / Finance@123` (note: switch to Bhargava — GST is off here so the IRN step at #4 will be skipped; for full GST flow run this against Sharma's `sharma@gasdist.com` instead).
2. Navigate to **Billing & Payments → Invoices** tab.
3. Pick an issued invoice. Click the `Credit Note` icon (red minus circle) on the row.
4. In the Credit Note modal, fill `Reason: Quantity adjustment` and add one line item with `Quantity: 1, Unit Price: 100, GST Rate: 18`. Submit.
5. Toast confirms creation. The CN status is `pending`.
6. Click the View (eye) icon on the same invoice. The View Invoice modal opens. Expand `View Credit / Debit Notes`.
7. Confirm the new CN appears with a yellow `pending` badge, amount, reason, created-at.
8. Logout, log back in as `sharma@gasdist.com` (or any `distributor_admin`).
9. Re-open the same invoice's View modal → Credit / Debit Notes section. The pending CN now shows `Approve` and `Reject` buttons.
10. Click `Approve`. Toast confirms. Status pill flips to green `approved`.
11. (Sharma only — Bhargava has GST disabled) Wait 2–3 seconds, refresh the modal. A `Download PDF` link appears next to the status pill. Click it.
12. Expected: credit note PDF downloads (`credit-note-xxxxx.pdf`), starts with `%PDF`, contains the seller info, reason, and amount.
13. **Reject path (run on a separate CN):** create another CN as finance, view as admin, click `Reject`. A modal opens with a required reason textarea. Submit.
14. Expected: CN status flips to red `rejected`. The reason is captured in the audit log (verify via DB if desired: `SELECT * FROM audit_logs WHERE action='reject' AND entity_type='credit_note'`).

Pass criteria: ✓ finance can create + reject is admin-only; ✓ approve fires IRN generation in the background (Sharma); ✓ PDF downloads on approved CN; ✓ reject reason captured in audit log.

Notes: ___________

---

### Test 8.7: Debit Note PDF (WI-039 — DN side)

Steps:
1. Repeat Test 8.6 but use the `Debit Note` icon (red plus circle) on the row.
2. After admin approves the DN, look for `Download PDF` in the Credit / Debit Notes section.
3. Click → DN PDF downloads.

Expected: A4 PDF titled `Debit Note` with seller / buyer block, reference invoice number, reason, and amount. Layout mirrors the credit note PDF.

Pass criteria: ✓ DN PDF available only on approved notes; ✓ tenant-scoped (cross-tenant DN id returns 404).

Notes: ___________

---

### Test 8.8: Delivery mismatch reissue (WI-037)

Steps:
1. As Sharma, find a `pending_delivery` order created via the WI-035 preflight (it should have a valid IRN and EWB).
2. Confirm delivery with a **different quantity** than ordered — e.g. ordered 10 cylinders, confirm 8 delivered.
3. Submit the delivery.
4. Wait 2–3 seconds (the reissue runs fire-and-forget after confirmDelivery returns).

Expected behind the scenes:
- The existing EWB is cancelled (if active and within 24hrs).
- The existing IRN is cancelled.
- Invoice items + totals are updated to the delivered qty (8 in this example).
- A new IRN is generated for the revised invoice (B2B). For B2C, a fresh standalone EWB is generated.
- A row is written to `invoice_revisions` with original_total, revised_total, original_items JSON, revised_items JSON, reason `delivery_mismatch`.
- `Invoice.revisedPostDeliveryAt` timestamp is set.

Verify via DB:
```bash
docker exec gaslink-db psql -U gaslink -d gaslink -c \
  "SELECT invoice_id, revision_number, reason, original_total, revised_total FROM invoice_revisions ORDER BY revised_at DESC LIMIT 5;"
```

Expected DB output: one row for the modified invoice with `original_total > revised_total` and reason `delivery_mismatch`.

Edge cases to spot-check:
- IRN cancel failure → flow aborts; a HIGH-severity `IRN_CANCEL_BLOCKED` PendingAction appears in Settings → Pending Actions. Invoice quantities stay at original.
- EWB cancel failure → flow continues; a MEDIUM-severity `EWB_CANCEL_FAILED` PendingAction appears.

Pass criteria: ✓ invoice items reflect delivered qty; ✓ new IRN value is 64 hex chars (real, not the mock `irn_xxxxxxxx` test fixture); ✓ invoice_revisions row written.

Notes: ___________

---



## SESSION 9 — Mobile Setup (~15 min, ONE-TIME)

This session has no test result rows — it's the prerequisite for SESSIONS 10 → 13. Run it once per dev machine.

### 9.0 Prerequisites

- [ ] Phone (Android or iOS) and laptop on the **same Wi-Fi network**
- [ ] **Expo Go** installed on the phone (Play Store / App Store — search "Expo Go")
- [ ] API server running on the laptop on port 5000 (`pnpm dev:api`). The server now binds `0.0.0.0` automatically in dev (server.ts WI-053 FIX B), so it's already reachable from the LAN.
- [ ] Find your laptop's LAN IP:
  - **Windows:** `ipconfig` → look for "IPv4 Address" under your **Wi-Fi adapter** (not Ethernet, not WSL). Example: `192.168.1.5`.
  - **macOS:** `ifconfig | grep inet` → grab the `192.168.x.x` (not `127.0.0.1`)
  - **Linux:** `hostname -I` → first IP in the list

### 9.1 Configure mobile app

1. From the repo root:
   ```powershell
   cp packages/mobile/.env.local.example packages/mobile/.env.local
   ```
2. Open `packages/mobile/.env.local` and replace the example IP with **your** LAN IP:
   ```
   EXPO_PUBLIC_API_URL=http://192.168.1.5:5000/api
   ```
3. Start the mobile app (from repo root):
   ```powershell
   pnpm --filter @gaslink/mobile start
   ```
4. Wait for the QR code to render in your terminal.
5. Open Expo Go on your phone → scan the QR code → app loads.

**Smoke check:** the login screen renders. If it doesn't, the most common causes are (a) wrong LAN IP, (b) phone on a different Wi-Fi (e.g. guest network), (c) laptop firewall blocking inbound 5000 (Windows Defender often does — allow Node.js when it prompts).

### 9.2 Driver mobile flow (raju@gasagency.com)

**Credentials:** `raju@gasagency.com` / `Driver@123` (Bhargava driver)

| # | Step | Pass criteria | Result | Notes |
|---|------|---------------|--------|-------|
| 9.2.1 | Login on mobile | 4 tabs visible: Analytics, My Deliveries, Trip, Vehicle Stock (+ More) | ⬜ | |
| 9.2.2 | **Analytics** tab loads | KPI cards render: Completed Today, Pending Deliveries, etc. | ⬜ | |
| 9.2.3 | **My Deliveries** tab | Pending-delivery orders for Raju show. If empty, create one from web admin. | ⬜ | |
| 9.2.4 | **Trip** tab | Today's assignment card with vehicle + 4-step status pipeline. | ⬜ | |
| 9.2.5 | **Vehicle Stock** tab | Per-cylinder-type fulls + empties + cancelled-stock-to-return. | ⬜ | |

**Delivery flow (~5 min):**

1. Tap an order on My Deliveries → tap **Deliver** → confirm in alert.
2. Expected: alert "Delivery confirmed!", the order disappears from the pending list.
3. On web (as `bhargava@gasagency.com`): the order's status is now `delivered`. Open the order → an invoice should be auto-generated.

### 9.3 Driver offline test (~5 min, NEW today)

1. Make sure there's at least one undelivered order in the list (create one from web admin if needed).
2. **Turn OFF Wi-Fi on the phone** (or stop the API with Ctrl-C in the terminal).
3. Open an undelivered order → tap **Deliver** → confirm.
4. Expected: alert "Saved offline — Delivery will sync automatically when you're back online", the order shows a **"pending sync"** orange badge instead of its normal status, and the My Deliveries tab icon shows an orange count badge.
5. **Turn Wi-Fi back ON** (or restart `pnpm dev:api`).
6. Expected: within ~5–10 seconds the queue auto-syncs (NetInfo listener fires on reconnect). The pending-sync badge disappears.
7. On web: confirm the delivery is recorded against the order **exactly once** (idempotency from WI-027).

Pass criteria: offline save works, auto-sync on reconnect works, server records the delivery exactly once.

Notes: ___________

---

## SESSION 10 — Mobile Distributor Admin (~25 min)

**Credentials:** `sharma@gasdist.com` / `Gstadmin@123` (GST sandbox tenant — exercises the IRN/EWB flow on the dispatch path)

| # | Test | Pass criteria | Result | Notes |
|---|------|---------------|--------|-------|
| 10.1 | Dashboard loads with today's metrics | KPI cards render, no console errors visible (use the More → debug if exposed) | ⬜ | |
| 10.2 | **Orders** tab shows all orders | List populates; status badges render | ⬜ | |
| 10.3 | Assign driver to an unassigned order | Tap order → Assign Driver → pick driver from list → save → status flips to `pending_dispatch` | ⬜ | |
| 10.4 | **Dispatch** from mobile (only if WhiteBooks sandbox is up) | After assignment, dispatch flow generates IRN + EWB; status flips to `pending_delivery`. If WhiteBooks is down, expect a clear error toast — not a silent failure. | ⬜ | |
| 10.5 | **Inventory** tab shows stock levels | Per cylinder type fulls + empties; matches web Inventory page | ⬜ | |
| 10.6 | **Finance** tab | Outstanding/overdue cards; click an invoice → details show. Known TODO: PDF download not wired (WI-046 will fix). | ⬜ | |
| 10.7 | **More** tab — customer/driver/vehicle/user CRUD | Open each form, create one of each (use unique phone like `9999000010`). Save returns success. | ⬜ | |

---

## SESSION 11 — Mobile Customer Portal (~15 min)

**Credentials:** `royal@kitchen.com` / `Customer@123`

| # | Test | Pass criteria | Result | Notes |
|---|------|---------------|--------|-------|
| 11.1 | Dashboard loads | Outstanding, overdue, total orders, pending, empty cylinders cards. Recent orders list. | ⬜ | |
| 11.2 | **Orders** list | Shows ONLY Royal Kitchen's orders. Tap one → detail view. | ⬜ | |
| 11.3 | **Invoices** list | Shows ONLY Royal Kitchen's invoices. Tap one → detail. | ⬜ | |
| 11.4 | **Payments** list | Shows ONLY Royal Kitchen's payments. | ⬜ | |
| 11.5 | **Account** screen | Profile + addresses + sign out work. | ⬜ | |

**Tenant isolation spot-check:** none of Bhargava's other customers' data should ever appear. If you see anything from "Spice Garden Hotel" or any other customer here, that's a CRITICAL bug.

---

## SESSION 12 — Mobile Inventory (~20 min)

**Credentials:** `inventory@gasagency.com` / `Inventory@123`

| # | Test | Pass criteria | Result | Notes |
|---|------|---------------|--------|-------|
| 12.1 | **Summary** tab loads | Per-cylinder-type opening / incoming / outgoing / closing | ⬜ | |
| 12.2 | **Actions** — record incoming stock | Tap Incoming Fulls → pick cylinder type → quantity 100 → reference "INV-MOBILE-TEST-001" → Save. Toast confirms; today's summary updates. | ⬜ | |
| 12.3 | **Actions** — record outgoing empties | Same shape, opposite direction. | ⬜ | |
| 12.4 | **Reconciliation** tab | Lists driver-vehicle assignments pending reconciliation. | ⬜ | |
| 12.5 | **Alerts** tab | Cylinder types currently below warning/critical threshold. Empty if everything's healthy. | ⬜ | |
| 12.6 | **Fleet** tab | Drivers + vehicles list. | ⬜ | |
| 12.7 | **Orders** tab | Inventory user can create orders too (per role widening in §17 of ARCHITECTURE). | ⬜ | |

---

## SESSION 13 — Mobile Finance (~15 min)

**Credentials:** `finance@gasagency.com` / `Finance@123`

| # | Test | Pass criteria | Result | Notes |
|---|------|---------------|--------|-------|
| 13.1 | Dashboard loads | Call list at top, unallocated payments below, GST failures section, pending actions at bottom. | ⬜ | |
| 13.2 | **Payments** — record payment | Pick customer → enter amount → method (cash/UPI/cheque) → reference → save. Toast confirms; outstanding balance reduces. | ⬜ | |
| 13.3 | **Invoices** — view + filter | List loads; filter by status. Tap invoice → details. | ⬜ | |
| 13.4 | **Collections** | Same call list as the dashboard, with a "Call" button per customer (tappable `tel:` link). | ⬜ | |
| 13.5 | Cancel IRN / EWB (Sharma only) | If you logged in as Sharma's finance equivalent: WI-039 widened cancel-IRN / cancel-EWB to finance role. Verify the buttons are visible. (For Bhargava finance, GST is off — no buttons expected.) | ⬜ | |

---

Copy this for each bug you find:

```
Bug #: ___
Session: ___ (e.g. Session 2 — Distributor Admin)
Test number: ___ (e.g. Test 2.5)
What I did: ___
What I expected: ___
What actually happened: ___
Screenshot filename: ___
Severity:
  [ ] Critical — blocks core workflow, data wrong
  [ ] High — feature broken but workaround exists
  [ ] Medium — minor issue, cosmetic or edge case
  [ ] Low — polish item
```

---

**Total tests across all sessions: 60.**
- Session 1: 5 (1.1 – 1.5)
- Session 2: 7 (2.1 – 2.7)
- Session 3: 3 (3.1 – 3.3)
- Session 4: 3 (4.1 – 4.3)
- Session 5: 3 (5.1 – 5.3)
- Session 6: 4 (6.1 – 6.4)
- Session 7: 3 (7.1 – 7.3)
- Session 8: 8 (8.1 – 8.8) — GST Compliance Flow, WI-035 to WI-043
- Session 9: 6 (9.2.1 – 9.2.5 + 9.3) — Mobile setup + Driver
- Session 10: 7 (10.1 – 10.7) — Mobile Distributor Admin
- Session 11: 5 (11.1 – 11.5) — Mobile Customer
- Session 12: 7 (12.1 – 12.7) — Mobile Inventory
- Session 13: 5 (13.1 – 13.5) — Mobile Finance
