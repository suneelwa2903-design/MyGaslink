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

## BUG REPORT TEMPLATE

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

**Total tests across all sessions: 22.**
- Session 1: 5 (1.1 – 1.5)
- Session 2: 7 (2.1 – 2.7)
- Session 3: 3 (3.1 – 3.3)
- Session 4: 3 (4.1 – 4.3)
- Session 5: 3 (5.1 – 5.3)
- Session 6: 4 (6.1 – 6.4)
- Session 7: 3 (7.1 – 7.3)
