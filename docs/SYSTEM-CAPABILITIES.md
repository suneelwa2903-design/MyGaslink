# SYSTEM CAPABILITIES — Re-New GasLink

A plain-English walkthrough of everything the platform can do, written for the founder.

Generated 2026-05-06 by reading the entire codebase: 22 backend route files, 25 web pages, 7 mobile role areas with 35 screens, the 1,406-line database schema, all 25 backend services including the GST and PDF subsystems, the 20 work items in the live tracker, and the testing log.

---

## PART 1 — What Is This System?

**Re-New GasLink** is the operating software for an LPG (cooking-gas) distribution business. The kind of business that buys cylinders by the truckload from IOCL / HPCL / BPCL bottling plants, stores them in a godown, and delivers them every day to thousands of homes, restaurants, factories, and shops. Today, most of these distributors run on paper, WhatsApp messages, and Excel sheets — which means lost cylinders, missed deliveries, late GST filings, slow collections, and no visibility into what's actually happening on the ground.

The platform replaces all of that with one connected system: a web app for the office, a phone app for drivers and inventory staff, a customer self-service portal, and a back office for the platform owner who runs this as a SaaS for many distributors. It handles the daily workflow (orders, deliveries, inventory, returns), the money side (invoices, GST e-invoicing with WhiteBooks, payments, credit/debit notes, customer ledgers), the people side (drivers, vehicles, customers, staff, roles), and the platform side (per-distributor billing, seat limits, suspension when bills go unpaid). The audience is mid-sized LPG distributors in India — the ones running 200 to 2,000 deliveries a day — and the agencies that operate them.

---

## PART 2 — The People Who Use It

The system has six types of user. Each one logs into the same web app or the same mobile app, but sees a different world depending on their role.

### 2.1 The Super Admin (Platform Owner)

**Who they are.** This is you and your co-founder. You run the platform itself — the SaaS that distributors pay you to use. You are not a gas distributor; you are the company that builds and operates the software for them.

**What they see when they log in.** A dashboard showing every distributor on the platform, with a switcher in the top bar that lets them "step into" any distributor's view. When they pick a distributor, the system uses an `X-Distributor-Id` header on every subsequent request, and the rest of the screens behave as if they were a distributor admin for that company. The middleware verifies that the chosen distributor exists and is active, and writes an audit-log entry every time a super admin switches tenant — so there's a forensic trail of which platform operator looked at which distributor's data and when.

**Every action they can take:**
- See a list of every distributor (`Distributors` page), search by name, sort and filter
- Click into any distributor to see their full detail page: subscription plan, seat limits, current GST API usage for the month, GST API usage history (so you can see who's hitting their quota), all their billing cycles
- Create a brand-new distributor — and there's a built-in **GSTIN lookup** that calls WhiteBooks to auto-fill the legal name, address, city, state, and pincode from the GSTIN, plus a **geocode** button that converts the address to latitude/longitude for delivery distance calculations
- Edit any distributor's details, including their subscription plan, billing tier, GST mode (off / sandbox / live), provider codes (which oil company they buy from)
- Trigger billing operations: `Generate billing cycle` for a period, `Mark cycle paid`, `Suspend a distributor` for overdue bills, `Unsuspend` once they pay, `Check expiry` for upcoming renewals, `Mark overdue` (cron-driven)
- View pricing tiers (the four plans: starter / growth / business / enterprise) and seat limits per plan
- Approve or reject seat-request applications from distributors who want extra users beyond their plan
- Browse and manage the **Provider Catalog** — the master list of cylinder types that any oil company sells (HPCL 19 KG Domestic, etc.), so distributors can import these into their own catalog instead of typing them in by hand
- See **Health Monitoring** — a server-side health snapshot
- Download the GasLink-side billing invoice PDF for any billing cycle (so distributors can see what they're paying)
- Access the API documentation (Swagger UI) — gated to super admin only

**What they cannot do.** Super admins do not have automatic access to a distributor's customer-facing data. They have to explicitly select a tenant via the header before any tenant-scoped query returns data. They cannot impersonate a customer of a distributor (no login-as-user flow). They cannot directly edit a financial transaction once it has been issued (credit notes / debit notes are the only way to amend money records). They cannot bypass GST rules — even in their own admin view, IRN cancellation requires a real reason and goes through WhiteBooks.

### 2.2 The Distributor Admin (The Business Owner)

**Who they are.** This is the agency owner — the person who actually runs the LPG distribution business. They know every customer, every driver, and they sign every cheque. There is normally one of them per distributor (sometimes two co-owners). They are the system's primary daily user.

**What they see when they log in.** A central Analytics dashboard with the day's KPIs: orders today, pending orders, active drivers (with status — dispatched, en-route, idle), today's collections broken down by cash / UPI / bank transfer, cylinder stock levels by type with a coloured progress bar, fleet status, top customers this month, weekly orders trend, customer segmentation pie chart, GST compliance summary (invoices filed, e-way bills active, GST collected, returns up to date). Below the KPIs there's a **Pending Actions** tray surfacing things that need their attention right now — an order that needs a driver, an invoice that needs approval, a payment that's unallocated.

**Every action they can take:**
- **Customers:** create / edit / view / soft-delete customers with full address, GSTIN, contacts (multiple per customer with primary flag), per-cylinder discount agreements, credit period in days, billing address vs shipping address. Stop or resume supply for a customer (with audit trail). Provision portal access (creates a customer-portal login). Approve or reject modification requests submitted by finance/inventory staff.
- **Cylinder catalog:** create cylinder types (5 KG / 19 KG / 47.5 KG / 425 KG / etc.), set monthly prices per type (effective-dated so historical orders bill correctly), set empty-cylinder deposit prices, set inventory thresholds (warning level + critical level) per type. Import types from the platform's provider catalog with one click.
- **Orders:** create new orders for any customer with multiple line items, set delivery date, special instructions; edit orders before dispatch; cancel orders before or after dispatch (different rules); assign a driver (vehicle is auto-resolved from the day's driver-vehicle pairing); bulk-assign drivers to many orders at once; view order detail with full delivery history.
- **Returns-only orders:** create an order purely to pick up empties from a customer (no delivery line items).
- **Inventory:** record incoming fulls (with document number — typically Delivery Challan from the bottling plant), record outgoing empties (when shipping empties back to IOCL), record manual adjustments (corrections after physical count). View daily summary by cylinder type with opening / closing fulls and empties. Lock the day once reconciled (prevents further edits) and unlock if needed. View depot history with date filters. View cancelled stock (goods that came back from a failed delivery). Return cancelled stock to the godown. View customer cylinder balances (how many cylinders does Customer X currently have at their premises). View 7-day inventory forecast.
- **Reconciliation:** when a driver returns a vehicle at end of day, the inventory team reconciles vehicle stock vs orders delivered. The admin sees every vehicle pending reconciliation and confirms or flags discrepancies.
- **Fleet:** create and edit drivers (name, phone, license number, employment type), drivers' availability per day, soft-delete drivers; create and edit vehicles (number, type, capacity); create driver-vehicle assignments per date (which driver gets which vehicle today); view driver performance per period; view vehicle inventory at a moment in time.
- **Assignments page:** see automatic recommended driver-vehicle pairings for a chosen date, confirm them in bulk, plus auto-recommend which driver to assign to which order based on the customer's preferred driver, location, and current load. Bulk-assign multiple orders at once.
- **Billing & Payments (admin view):** see all invoices, filter by status / IRN status / date range / customer, view invoice detail, download invoice PDF (with QR code if GST is on), record payments (cash / cheque / online / UPI / bank transfer / credit), allocate payments to specific invoices (manual or auto to oldest first), view payment ledger per customer (full transaction history including credit/debit notes), create credit notes (with approval workflow), create debit notes (with approval workflow), download credit note PDFs, approve or reject credit/debit notes, regenerate invoice (cancel old IRN and create new invoice if line items change after delivery), mark invoices overdue.
- **Collections:** see who owes how much, age buckets (0-30 days, 30-60, 60-90, 90+), export to Excel.
- **Settings:** configure SLA hours per severity level for the pending-actions system, configure GST credentials (two sets — e-invoice and e-way bill — tested live with WhiteBooks before saving), toggle GST mode (off / sandbox / live), configure cylinder thresholds, configure approval workflows (which actions require approval, which roles can approve), upload licenses (PESO, GST registration certificate, partnership deed, PAN, bank details, cancellation cheque), manage staff users (create finance / inventory / driver users with seat-limit enforcement, reset passwords, edit, soft-delete — with cannot-delete-yourself protection), view and download GasLink billing invoices for the SaaS subscription, request additional seats from the platform (super admin approves).
- **Pending Actions:** unified inbox of items that need attention (failed GST submissions, unconfirmed deliveries, overdue invoices, pending approvals). Approve, resolve with notes, or skip.
- **Analytics:** the dashboard plus deeper reports — collections, revenue trends by month, top customers, driver performance, customer lifetime value, advanced metrics (per period). Export each one to Excel.

**What they cannot do.** They cannot see another distributor's data. The middleware locks every query to their `distributorId`. They cannot change their own subscription plan or billing tier directly — those are super admin only. They cannot delete a customer hard (only soft-delete via `deletedAt`); historical orders and invoices keep working. They cannot back-date GST documents — once an IRN is issued, only WhiteBooks-driven cancel-and-regenerate is permitted. They cannot approve their own submitted modification requests (the approval workflow needs a different person). When their distributor account is suspended for non-payment, the web app redirects them to a Billing-Suspended landing page and blocks all admin actions until they pay.

### 2.3 The Finance User

**Who they are.** The accountant or back-office finance person. Often part-time. Their job is invoices, payments, collections, GST, and reporting — never inventory, never order entry, never driver assignment.

**What they see when they log in.** Same dashboard as the distributor admin, but the sidebar is shorter. They see Analytics, Billing & Payments, Collections, Pending Actions. The Orders, Inventory, Customers, Fleet, and Settings pages are not in their menu — and the middleware refuses access if they try to URL-jump to them.

**Every action they can take:**
- View all invoices, filter, drill in
- Download invoice PDFs and credit-note PDFs (PDFs are generated on demand server-side using PDFKit; they include the GST QR code when IRN is present)
- Record payments — pick the customer, the amount, the method (cash / cheque / online / UPI / bank transfer / credit), an optional reference number, and either let the system auto-allocate to the oldest open invoices or manually allocate specific amounts to specific invoices
- View payment allocations and ledger per customer
- Create credit notes (sends through approval workflow), create debit notes (same)
- Submit customer modification requests (e.g. "stop supply for ABC customer because their dues crossed threshold") — admin approves
- View collections dashboard with age buckets
- Export collections, due amounts, empty-cylinder reports to Excel
- See pending actions in their domain (failed GST, unallocated payments)
- Access analytics reports

**What they cannot do.** Cannot create / cancel / dispatch orders. Cannot record inventory movements. Cannot create customers, drivers, vehicles, or cylinder types. Cannot change settings (no GST mode toggle, no thresholds, no users). Cannot approve their own modification requests. Cannot suspend a customer directly — they file a modification request and the admin approves.

### 2.4 The Inventory Staff

**Who they are.** The godown manager, the person responsible for physical cylinder count and what goes on / off each truck.

**What they see when they log in.** Sidebar: Analytics (limited view), Orders (read + status updates), Inventory (full access), Fleet (full access). They are the only non-admin role with full Fleet access because they manage the daily driver-vehicle pairing.

**Every action they can take:**
- View daily inventory summary (opening / incoming / outgoing / closing per cylinder type)
- Record incoming fulls (with document number, document date, optional vehicle, notes)
- Record outgoing empties (returns to oil company)
- Manual adjustments (with required reason — physical count corrections)
- Lock the day's inventory once reconciled, or unlock if a correction is needed (admin-only on some operations)
- View cancelled stock from failed deliveries
- Return cancelled stock to godown
- View depot history with filters
- View threshold alerts (cylinders below critical level)
- View customer balances
- View 7-day inventory forecast (algorithm-driven)
- Manage drivers and vehicles, create driver-vehicle assignments per day
- Confirm vehicle reconciliation when a driver returns a vehicle at end of day (compare loaded out vs delivered + returned + cancelled stock — discrepancies create AccountabilityLog entries)
- View pending actions in their domain (low stock alerts, vehicles pending reconciliation)
- Access empty-cylinder report from analytics

**What they cannot do.** No customer create / edit. No payment recording. No invoice creation. No GST settings. No staff user management.

### 2.5 The Driver

**Who they are.** The person who actually delivers cylinders to customers. They use the **mobile app** primarily, not the web. They probably own an Android phone, may not have unlimited data, and need the app to work in fading network conditions (godowns and customer doorsteps are not always covered).

**What they see when they log in.** A mobile tab bar with five sections — Analytics, My Deliveries, Trip, Vehicle Stock, More — plus a hidden Profile screen reachable from More.

**Every action they can take:**
- **Analytics tab:** their personal day's deliveries count, completion rate, KMs covered (where tracked), pending count
- **My Deliveries tab:** the list of orders assigned to them today with status. Tap an order to see customer name, address, items expected, special instructions
- **Confirm delivery:** mark an order delivered — choose delivered quantity per item (defaults to ordered quantity but allows partial), choose empties collected per item, take a **delivery proof photo** with the on-device camera (saves to device, can be uploaded), add notes
- **Trip tab:** geographic / sequential view of today's run. (Combined with `expo-location` permissions for tracking.)
- **Vehicle Stock tab:** what's currently on their vehicle, computed from morning load + deliveries so far + empties picked up
- **Cancelled stock:** if a customer refuses a delivery (closed shop, stop-supply customer, wrong address), the driver marks the line cancelled — the stock stays on the vehicle and shows as cancelled-stock until reconciliation. They can also create an order from cancelled stock if a different customer agrees to take it.
- **End of day:** mark vehicle returned. The inventory team picks up reconciliation from there.
- **Profile / More:** see their own driver record, change password, log out

**What they cannot do.** Cannot see other drivers' orders. Cannot see customer payment history. Cannot create new orders (the office does that). Cannot edit prices. Cannot access analytics reports beyond their own performance. Cannot dispatch themselves (an admin or inventory user has to mark the assignment loaded-and-dispatched).

### 2.6 The Customer

**Who they are.** The person or business buying gas. Could be a household, a restaurant, a hotel, a hostel, a factory canteen. They get a portal login from the distributor (admin provisions it on the customer record) — not every customer has one, but those who do can self-serve.

**What they see when they log in.** A focused 5-page portal:
1. **Dashboard** — total orders ever, pending orders, total invoices, outstanding amount, recent orders list, recent invoices list, current cylinder balance summary (how many of each type they have right now)
2. **My Orders** — list with status, place a new order from the portal (pick cylinder type + quantity, choose preferred delivery date, optional notes), view detail with line items, driver name once assigned, special instructions
3. **My Invoices** — list with filter by status, view detail with line items + GST breakup if applicable, download PDF
4. **My Payments** — payment history with method, reference, allocation status, view detail showing which invoices each payment was applied to
5. **My Account** — profile (name, business name, GSTIN, addresses, contacts, credit period, cylinder discount agreements), update profile fields like email / phone / shipping address, view distributor info (their gas agency's contact)

**Plus delivery confirmation flow:** when a driver delivers and confirms an order, the customer sees a "pending confirmation" banner. They can confirm what they actually received (number of cylinders, empties returned), which closes the loop. If quantities differ, the system creates a modified-delivery record and inventory reconciliation handles the discrepancy.

**What they cannot do.** Cannot see anything about other customers. Cannot edit invoice amounts or payment records (read-only). Cannot edit historical orders. Cannot trigger their own credit / debit notes (they file a request via support; the distributor's finance team creates the actual document). Cannot see internal distributor data like inventory, drivers, or other customers.

---

## PART 3 — The Core Workflows

This is what actually happens day-to-day, told as stories rather than feature lists.

### 3.1 A Cylinder Order, Cradle to Grave

**Morning, 8:00 AM.** The distributor admin (or a customer through the portal) creates an order. They pick a customer (the system warns if the customer is on stop-supply), pick cylinder types and quantities, set a delivery date. The system computes the price using the customer's current price effective on the order date — and applies any per-cylinder discount the customer has agreed (e.g. ₹10 off on 19 KG for Royal Kitchen). The total is calculated server-side; the form just shows it.

**Behind the scenes**, the order is saved with status `pending_driver_assignment`. If the customer has a `preferredDriverId` set, and that driver has a vehicle assigned for the delivery date, the order is auto-promoted to `pending_dispatch` with that driver pre-assigned. Otherwise it sits in the queue. An OrderStatusLog row is written for traceability.

**Mid-morning.** The admin or inventory user opens the Orders page, sees a list of pending orders, and either assigns drivers individually or uses Bulk Assign Driver. They pick the driver; the vehicle is auto-resolved from the day's DriverVehicleAssignment (the vehicle field in the modal was deliberately removed to avoid confusion). The order moves to `pending_dispatch`. A DriverAssignment row is created.

**Loading.** The driver-vehicle assignment status moves from `dispatch_ready` to `loaded_and_dispatched` (someone marks the vehicle loaded). At this moment, the system records VehicleInventory rows — which cylinders are physically on the truck.

**On the road.** The driver opens the mobile app, sees today's deliveries. They tap the first order, drive to the address. At the doorstep they confirm the delivery: actual quantity delivered, empties collected, optional photo, notes. The mobile app POSTs to `/orders/:id/deliver`. Server-side, the order moves to `delivered` (or `modified_delivered` if quantities don't match the original), a CustomerInventoryBalance entry is updated (the customer now holds N more fulls and the distributor has N more of their empties pending return), and an InventoryEvent is recorded — `delivery` event reduces vehicle fulls, `collection` event increases vehicle empties.

**Cancelled at the door.** If the customer refuses, the line goes to cancelled. The cylinders stay on the vehicle and become CancelledStockEvents with status `on_vehicle`. Later, those can be re-routed to another customer, returned to the godown (`returned_to_depot`), or written off.

**Invoice generation.** When the order hits `delivered` (or `modified_delivered`), the system can auto-create an Invoice (or the finance team creates it manually). InvoiceItems mirror the OrderItems with line totals. If the distributor's GST mode is `sandbox` or `live`, the invoice is queued for IRN — `invoiceService` calls `gstService.processInvoiceGst` which uses the WhiteBooks client to fetch / cache an auth token, builds the IRN payload (invoice number, GSTIN, line items with HSN codes, taxable amount, CGST/SGST/IGST split based on whether the customer is intra-state or inter-state, B2B vs B2C — automatic), sends it, and on success stamps the invoice with the IRN, ack number, signed QR, and IRN status. A GstDocument row records the full request/response. If a delivery-vehicle E-way bill is needed, a parallel `generateDispatchEwb` flow runs.

**Failure handling.** If WhiteBooks rejects the IRN (bad GSTIN, validation error, network), a PendingAction is created with severity high or critical and an SLA deadline. The action shows on the admin/finance pending-actions tray. The actual invoice still exists; only its IRN status is `failed`. Once the underlying issue is fixed, the admin retries.

**Payment.** The customer pays — cash to the driver, UPI on the phone, bank transfer, cheque, online. Finance opens the Payments page, picks `Record Payment`, selects the customer, the amount, the method, the date, and either lets the system auto-allocate to the oldest open invoices or picks specific invoice + amount per allocation. Each PaymentTransaction is saved with PaymentAllocation children. Every allocation reduces the corresponding Invoice.outstandingAmount and bumps amountPaid; when outstanding hits zero the invoice flips to `paid` and a `closedAt` timestamp is stamped. A CustomerLedgerEntry is recorded for both the original invoice and the payment, so the per-customer ledger always reconciles.

**Driver returns at end of day.** The driver marks their vehicle returned in the mobile app. Inventory takes over: for each remaining stock on the vehicle they reconcile vs orders delivered. Loaded out − delivered − returned-as-empties − cancelled-stock-still-on-vehicle should equal zero. If not, an AccountabilityLog entry captures the discrepancy with cylinder type, quantity, and a status of `open` for someone to investigate (lost / damaged / missing / dispute).

**Reconciled.** Once accountability is resolved (recovered from driver, written off, charged to customer), the day's inventory summary can be locked. Locking prevents further edits to that day's events. Unlocking is possible but audited.

### 3.2 GST E-Invoicing With WhiteBooks

Indian GST regulations require that any B2B invoice above ₹5 cr aggregate turnover be reported electronically to the IRP (Invoice Registration Portal) within 24 hours and an IRN (Invoice Reference Number) attached. For inter-state goods movement above ₹50,000, an E-way bill is also required. The distributor's compliance burden is significant, and the platform automates it through **WhiteBooks**, an authorised GSP (GST Suvidha Provider).

Each distributor has a per-tenant `gstMode` setting: `disabled` (no GST features visible at all — the customer is too small or has a separate filing process), `sandbox` (full flow against WhiteBooks' test environment — useful for staging), or `live` (real production filing). The distributor admin enables it, then enters two sets of credentials in Settings: e-invoice credentials (for IRN) and e-way-bill credentials (for EWB). Each credential set is tested live with a WhiteBooks auth call before being saved — if the credentials fail, the save is refused.

Once enabled, every issued invoice automatically goes through the IRN flow. The credit note and debit note flows do the same — `processCreditNoteGst` and `processDebitNoteGst` send the document to WhiteBooks and stamp it with its own IRN. If a delivery line item changes after the invoice was issued (modified delivery), there's a `cancelAndRegenerateInvoice` flow: it cancels the old IRN with WhiteBooks (with a reason — required by law), creates a new invoice with the corrected lines, and issues a fresh IRN. The old GstDocument row is preserved with `isLatest = false` so audits can trace the chain.

The platform tracks per-distributor GST API usage (`GstApiUsage` model) by month: how many IRN calls, how many EWB calls, against the distributor's plan quota. Overage is charged extra at billing time.

**Important caveat.** The system has been fully tested against the WhiteBooks **sandbox** environment — every IRN, EWB, cancel, regenerate flow passes the integration test suite. It has **not** yet been tested against production WhiteBooks credentials. Doing that is WI-007, marked as a launch blocker.

### 3.3 How Inventory Is Tracked

The system uses an **event-sourced** model for inventory. Every cylinder movement is an `InventoryEvent` row with type — `incoming_fulls` (truck arrives from oil company), `outgoing_empties` (truck takes empties back), `delivery` (driver delivers to customer), `collection` (driver picks up empties from customer), `manual_adjustment` (corrections), `cancellation` (customer refuses), `cancellation_return` (cancelled stock goes back to godown), `initial_balance` (one-time setup), `write_off` (lost / damaged), `returns_collection` (returns-only order). Each event references a cylinder type, a date, optional document number, optional vehicle, and the user who created it.

Each day, an `InventorySummary` is computed per (distributor, cylinder type, date): opening fulls, opening empties, sum of incoming fulls, sum of outgoing empties, sum of delivered, sum of collected empties, closing fulls, closing empties. The summary is recomputed automatically on event creation. A day can be **locked** once reconciled — locking prevents further events on that date. There's an unlock flow if a real correction is needed, with an audit trail.

`CustomerInventoryBalance` separately tracks how many of each cylinder type each customer is currently holding. Useful for the customer portal "Your cylinder balance" section, for the reconciliation dashboard, and for accountability when a customer claims they returned more than the system shows.

`VehicleInventory` snapshots what's on a vehicle right now. Updated by load-out and by every delivery / collection.

`CancelledStockEvent` is its own table because cancelled stock has its own lifecycle: `pending_return` → `on_vehicle` → `returned_to_depot` → `reconciled` (or `written_off`). A cancelled cylinder might sit on a vehicle for hours before going back to the godown; the system tracks that, and inventory cannot reconcile until cancelled stock is resolved.

Threshold alerts: `CylinderThreshold` per (distributor, cylinder type) holds warning + critical levels. The dashboard surfaces alerts for any type below threshold. There's a 7-day forecast that uses recent consumption rate and current stock to predict when each type will run out.

### 3.4 Distributor Subscription & GasLink Billing

This is the SaaS side — what distributors pay you for the platform. There are four `PricingTier` plans:

- **Starter**: 1 admin, 1 finance, 1 inventory, 5 drivers, 1,500 GST API calls included, ₹4,999/month
- **Growth**: 2/2/2/12, 4,000 calls, ₹8,999/month
- **Business**: 3/3/3/25, 8,000 calls, ₹14,999/month
- **Enterprise**: 5/4/4/40, 15,000 calls, ₹19,999/month

Each tier also has overage prices for extra admin seats (₹299), driver seats (₹99), customer-portal access (₹49 per portal user), GST API overages (₹2 per call beyond included quota). Quarterly / half-yearly / yearly upfront commitments get 5% / 10% / 15% discounts.

When a super admin generates a `BillingCycle` for a distributor, the system counts the active users by role on the cycle date, looks up the tier pricing, applies the period type (monthly billing means just the monthly price; yearly applies the discount), totals it with GST (CGST + SGST or IGST depending on whether the distributor is in the same state as GasLink HQ), and creates `BillingItem` rows for the line breakdown — base subscription, driver-login fees, customer-portal fees, GST API overage, custom add-ons, period discount. The cycle's `dueDate` is set to `periodEndDate + grace period` (defined in shared constants).

A **payment** marks the cycle paid. A scheduled cron job marks cycles `overdue` past due date, and after a configurable grace period (`BILLING_OVERDUE_SUSPEND_DAYS`) automatically suspends the distributor — `Distributor.billingSuspended = true`. The web app's response interceptor sees the 403 with code `BILLING_SUSPENDED` and redirects to a Billing Suspended page that explains the situation and shows contact info. Unsuspending is a super-admin operation.

`SeatRequest` lets a distributor admin ask for extra seats beyond their plan. The request has a role (driver / admin / finance / inventory) and a reason. Super admin approves or rejects; on approval, the system computes the per-month seat price using the distributor's current tier pricing and stamps the request.

`License` lets distributors upload regulatory documents (PESO licence, GST registration, partnership deed, PAN, bank cancellation cheque, custom). The platform stores the URL and expiry date. Useful for audit and onboarding new tenants.

### 3.5 The Customer Portal (Self-Service)

A customer with a portal login skips calling the office for routine things:

- **Dashboard**: total orders, pending orders, total invoices, outstanding amount, current cylinder balance, recent orders + invoices
- **Place an order**: pick cylinder types and quantities, preferred delivery date, special instructions. The order lands as `pending_driver_assignment` in the distributor's queue exactly like a phone order.
- **Confirm delivery**: when the driver marks a delivery confirmed, the customer sees a pending-confirmation banner. They confirm what they actually received — quantity per item, empties returned. If quantities differ from what the driver claimed, the order ends up `modified_delivered` and a `CustomerInventoryBalance` adjustment + an inventory event reflect the difference.
- **View invoices**: list and detail with GST documents (IRN, ack number, EWB number, signed QR if present). Bulk download summary for tax filing.
- **View payments**: history with allocations.
- **Update profile**: limited fields — phone, email, shipping address. Other changes (name, GSTIN, billing address) go through a **modification request** — the customer files it with a reason; the distributor admin approves or rejects.

The portal queries are fully tenant-scoped via the customer's `customerId` from JWT; a customer cannot see anything outside their own data, and a customer of distributor A cannot see anything from distributor B even if they guessed an ID.

### 3.6 Super Admin Manages the Platform

The super admin's main loop:

1. **Onboard a distributor.** Click `New Distributor`, type the GSTIN, hit `Lookup` — WhiteBooks returns the legal name, address, city, state, pincode, which auto-fill the form. Fill in extras (godown address, office address if different), pick a subscription plan, pick a billing tier, set `gaslinkBillingEnabled = true` if they're a paying tenant from day one (or `false` if they're on a free trial), set `gstMode` (usually `disabled` until they upload credentials), assign provider codes (HPCL, BPCL, IOCL — they can have multiple). Save.
2. **Provision the admin user.** Either type their email and create a password manually (sent by email), or invite via the seat-request flow.
3. **Watch usage.** Distributors detail page shows GST API usage trending toward quota, seat usage approaching limit, billing cycles paid / pending / overdue.
4. **Generate monthly billing.** Either manually triggered or cron-driven. Verify the cycle, send invoice (PDF generated server-side via `generateBillingInvoicePdf`).
5. **Approve seat requests.** A distributor needs an extra driver seat — review and approve.
6. **Suspend / unsuspend.** Cron auto-suspends overdue tenants; super admin manually unsuspends after they pay.
7. **Maintain the provider catalog.** Add new cylinder types as IOCL / HPCL / BPCL release them; distributors import them with one click.
8. **Health monitoring.** Server health snapshot.

---

## PART 4 — The Business Rules

The rules the system enforces. These are not suggestions — the code rejects requests that violate them.

### 4.1 Pricing Rules

- Cylinder prices are **effective-dated**. An order placed today uses the price effective today; a historical order uses the price effective on its order date. Changing today's price does not retroactively change yesterday's invoices.
- **Per-customer discounts** apply on top of the base price. A discount is per cylinder type per customer (e.g. Royal Kitchen gets ₹10 off on 19 KG). The discount is applied at order time, not invoice time, so the order total and invoice total agree.
- **Empty cylinder deposit prices** are tracked separately from filled-cylinder prices. Used when a customer pays a deposit on first delivery.
- **GasLink billing prices** are tier-driven, not per-distributor. A distributor on the Business tier pays the Business monthly price; you cannot give one distributor a custom price without changing their tier.

### 4.2 GST Rules

- A distributor's GST mode must be `disabled`, `sandbox`, or `live`. There's no "partial" mode.
- When `gstMode = disabled`, no IRN / EWB calls happen, no GST UI columns appear (the credit-note and debit-note buttons are hidden, the invoice PDF skips the GST block). The system enforces this at both the UI layer (`gstEnabled` flag) and the service layer (the GST flow short-circuits).
- Saving GST credentials requires a **live test call** to WhiteBooks. Bad credentials cannot be saved.
- An issued IRN can only be cancelled within WhiteBooks' allowed cancellation window (24 hours per IRP rules). The reason is mandatory.
- A credit note or debit note follows its own approval workflow: created (`pending_cn` / `pending_dn`) → approved (`approved_cn`) → issued. Once issued, the GST flow generates a separate IRN for the CN/DN. Rejecting moves to `rejected_cn` / `rejected_dn`.
- The HSN code on every invoice line is required for GST submission — defaulted to `27111900` (LPG) but overridable per cylinder type.
- **CGST/SGST vs IGST is automatic**: same-state customer = CGST + SGST split; different-state = IGST only. Computed from comparing the distributor's state code (first 2 digits of GSTIN) to the customer's state code.

### 4.3 Payment Rules

- A payment must reference a customer and an amount > 0. Negative amounts are refunds, which use credit notes, not negative payments.
- Payment allocations cannot exceed the payment amount. A ₹10,000 payment allocated to invoices A (₹4,000) + B (₹3,000) leaves ₹3,000 unallocated.
- An allocation cannot exceed the target invoice's outstanding amount. You cannot allocate ₹5,000 to an invoice that already has only ₹2,000 outstanding.
- An invoice flips to `paid` when outstanding hits zero. It does not flip back if a credit note later reduces the total — the credit note creates its own ledger entry.
- A payment can be `unallocated` (advance), `partially_allocated` (some allocations), or `fully_allocated`. The status updates automatically.

### 4.4 Inventory Rules

- A locked day cannot accept new inventory events, edits, or adjustments. Unlock requires a privileged role and is audited.
- Stock cannot go negative. The system rejects an outgoing-empties event that would push empties below zero, and a delivery event that would push fulls below zero.
- A `CancelledStockEvent` must transition through a defined state machine: `pending_return → on_vehicle → returned_to_depot → reconciled` (or → `written_off`). Skipping states is rejected.
- A reconciliation cannot be confirmed while cancelled stock is still pending return for that vehicle.
- Manual adjustments require a non-empty reason field.

### 4.5 Access Rules (Multi-Tenant + Role)

- **Every database query on a tenant-scoped table includes `where: { distributorId }`** — there is no row-level security in Postgres; this is enforced by convention in services. The convention has been audited (WI-001) and middleware-verified (WI-013).
- **`distributorId` is sourced from the JWT** (set at login, never changes for non-super-admins) or from the validated `X-Distributor-Id` header for super admins. **Never from request body or query string** — that anti-pattern was removed in WI-002.
- **Super admin tenant switches are audited** — every successful header-driven switch writes a `super_admin_tenant_switch` business log entry with admin ID, target distributor ID, IP, request ID.
- **Role checks** use `requireRole(...)` middleware on each route. Super admin bypasses role checks. Other roles are explicitly enumerated per route.
- **Customer self-service routes** are doubly scoped: `distributorId` from JWT + `customerId` from JWT. A customer can only see their own data, even within their own distributor.
- **Soft delete is the standard**. `Distributor`, `User`, `Customer`, `Order`, `Invoice`, `Driver`, `Vehicle`, `CylinderType` use a `deletedAt` timestamp; queries filter `deletedAt: null`. Hard delete is never exposed via API.
- **A distributor on `billingSuspended = true`** is blocked at the response interceptor level — every API call gets `403 BILLING_SUSPENDED` and the web redirects to the suspension landing page. The super admin has to lift the suspension before the tenant can act again.
- **A user cannot delete their own account** — explicit guard in `users.ts`.
- **Seat limits are enforced** at user-create time: `userService.checkSeatAvailability` queries the distributor's tier, looks up tier seat caps per role, counts current active users in that role, and rejects if the seat is taken. Distributors can request more via SeatRequest.
- **Rate limits** apply globally (1,000 req / 15 min per IP) and on auth endpoints (10 login attempts / minute in production, 5 forgot-password / minute).

---

## PART 5 — The Technical Backbone

Plain English, no code.

### 5.1 How Data Is Kept Separate Between Distributors

Every distributor has a unique `distributorId`. Almost every table in the database has a `distributorId` column — 29 of the 45 models. The rest are either platform-level reference data (the master cylinder catalog, the list of GST states, HSN codes) or children of tenant-scoped parents (an `OrderItem` doesn't have its own `distributorId` but it lives under an `Order` that does).

When a request arrives at the API:
1. The auth middleware validates the JWT and identifies the user.
2. The resolveDistributor middleware decides which distributor's data this request can see — for normal users it's the one in their JWT (set when they logged in), for super admins it's whichever they put in the `X-Distributor-Id` header.
3. The middleware verifies the distributor row exists in the database and is not suspended. If it's gone or suspended, the request is rejected with a clear error code.
4. The verified distributor info is attached to the request object so downstream services don't have to query again.
5. Every service function that reads or writes a tenant table includes `distributorId` in the WHERE clause.

The result: a customer of Distributor A cannot see anything from Distributor B even if they manipulate URLs. A staff member of Distributor A who tries to call an API endpoint with the URL of a Distributor B record gets a 404 (not a 403, deliberately — we don't confirm the existence of records you can't access). A super admin can see across distributors only by explicitly switching, and every switch is logged.

There is no row-level security in Postgres. The database itself trusts the application to filter correctly. This was audited end-to-end on 2026-05-06 — every Prisma query in every service file was checked. CRITICAL, HIGH, and MEDIUM findings were all fixed in commits b6f8c58, a0f855c, 8c758b2.

### 5.2 How the Mobile App Connects to the Backend

The mobile app is built with Expo (managed workflow), Expo Router for navigation, and React Native for the UI. It targets both iOS and Android, minimum iOS 15+ and Android 10+.

It talks to the same REST API the web app uses. The base URL is configured via `EXPO_PUBLIC_API_URL` — pointing to localhost during local dev (only works on simulator; real devices need a LAN IP) or to `https://api.mygaslink.com/api` for production builds.

Authentication uses the same JWT system. The app stores the access token and refresh token in **expo-secure-store**, which uses iOS Keychain and Android Keystore — never plain AsyncStorage, which would be unencrypted. The Zustand auth store hydrates from secure storage on app start.

Every API call goes through a shared axios instance that automatically attaches the JWT and the `X-Distributor-Id` header (for super admins). When a 401 comes back, the interceptor automatically tries the refresh-token flow; if refresh also fails, the app logs the user out and shows the login screen.

Camera access (for delivery proof photos) uses **expo-camera**. Location (for trip tracking) uses **expo-location**. Push notifications use **expo-notifications** — the icon and notification color are configured.

The mobile app today has fully built screens for all 6 roles — driver, finance, inventory, admin, customer, and super admin — each with its own tab bar layout. Mobile-side i18n is not yet wired up; that's part of WI-008.

### 5.3 How PDFs Are Generated

PDFs are generated server-side on demand using **PDFKit**. There are three PDF types:

- **Customer invoice PDF** (`invoicePdfService.generateInvoicePdf`) — branded layout with seller block (distributor's legal name, GSTIN, address), buyer block (customer's name, GSTIN, address), shipping address if different, line items with HSN code, taxable value, GST split (CGST / SGST or IGST per tax rate), grand total, GST QR code (signed QR from WhiteBooks if IRN is issued), invoice number, IRN, ack number, EWB number where applicable, page numbers, total in words.
- **Credit note PDF** (`creditNotePdfService.generateCreditNotePdf`) — same layout, marked CREDIT NOTE, references the original invoice number.
- **Billing invoice PDF** (`billingInvoicePdfService.generateBillingInvoicePdf`) — used by GasLink to bill distributors for the SaaS subscription. Lists the billing cycle items with breakdown.

Each PDF function takes an entity ID + the caller's distributorId, fetches the data with the distributor scope enforced (so you can't generate a PDF for another tenant's invoice), and streams the PDF as a Buffer back to the route which sends it as `application/pdf` with a sensible filename. The web client uses the shared axios instance to download the blob (an earlier bug where downloads bypassed the interceptor and dropped the X-Distributor-Id header was fixed in commit 7f2758f).

Layout helpers in `pdfLayoutUtils.ts` provide consistent money formatting (Indian rupee with locale grouping), date formatting, IRN display formatting, and a `numberToWords` function (for the legally required "amount in words" line on Indian invoices).

### 5.4 GST Integration With WhiteBooks

WhiteBooks is the third-party GSP that bridges between the distributor and the government's IRP (Invoice Registration Portal) and EWB Portal. Direct IRP integration requires accreditation; using a GSP is the standard approach.

Each distributor has two sets of WhiteBooks credentials:
- **e-invoice credentials** — for IRN issuance, IRN cancel, IRN details lookup, GSTIN validation
- **e-way-bill credentials** — for EWB generation, EWB cancel, EWB status

These are stored encrypted in `GstCredential` rows scoped to the distributor and the scope (`einvoice` / `ewaybill`).

The `whitebooksClient.ts` module handles the protocol:
- Fetches a session token from WhiteBooks using the credentials, caches it in memory with a TTL (auth tokens are valid for hours, so caching saves API calls)
- All subsequent API calls use the cached token; if a call returns 401 the cache is cleared and the next call re-authenticates
- Every API call records request / response details in `GstApiUsage` for billing and quota tracking

The high-level flows live in `gstService.ts`:
- `processInvoiceGst` — given an issued invoice, builds the IRN payload via `payloadBuilders.buildIrnPayload`, sends to WhiteBooks, on success stamps the invoice with IRN / ack / signed QR, on failure creates a PendingAction
- `generateDispatchEwb` — generates an E-way bill at order dispatch time
- `cancelIrn` — cancels an existing IRN within WhiteBooks' allowed window with a reason
- `cancelEwb` — same for E-way bills
- `processCreditNoteGst` and `processDebitNoteGst` — issue IRN for CN / DN
- `cancelAndRegenerateInvoice` — for modified deliveries: cancels the old IRN, creates a new invoice, issues a fresh IRN, links the chain
- `validateGstin` — used by the customer-create flow to confirm a GSTIN is valid and active before saving the customer
- `getIrnDetails`, `getEwbStatus` — read-only queries for status display

There's also `gstinLookup.ts` with two utilities the super admin uses when onboarding distributors: `lookupGstin` calls WhiteBooks to fetch the legal name and registered address from a GSTIN, and `geocodeAddress` converts a postal address to lat/long for distance calculations.

**Important:** all of this has been thoroughly tested against WhiteBooks **sandbox** credentials. Production WhiteBooks integration has never been exercised against real GSTINs and real money. WI-007 is the work item to do this before any tenant goes to `gstMode = live`.

### 5.5 What Happens When Something Goes Wrong

The system is built to fail loudly in development and gracefully in production.

**Application crashes.** The API server installs handlers for `unhandledRejection` (logs + Sentry, doesn't exit — the rejection might be recoverable) and `uncaughtException` (logs + Sentry + flush + exit 1, because the process state is undefined after an uncaught throw). On SIGTERM (from pm2 or Docker) and SIGINT (Ctrl-C in dev), the server stops accepting new connections via `server.close()`, drains in-flight requests, calls `prisma.$disconnect()`, and exits. A 30-second hard timeout via `setTimeout().unref()` forces an exit if anything hangs.

**Frontend render errors.** The web app wraps its entire root in an ErrorBoundary class component. Any uncaught render error shows a recoverable fallback UI — "Something went wrong" with a "Try again" button (resets the boundary) and a "Refresh page" button — instead of a white screen. In production, with `VITE_SENTRY_DSN` set and a global Sentry script loaded, the error is captured.

**API errors.** Every route uses a shared `sendError` helper that returns `{ success: false, data: null, error: <message>, code?: <code> }`. Specific error codes drive specific UI behaviour: `BILLING_SUSPENDED` redirects to the suspension page, `NO_DISTRIBUTOR_SELECTED` prompts the super admin to pick a tenant, `INVALID_DISTRIBUTOR` rejects malformed header values, `DISTRIBUTOR_SUSPENDED` is the suspended-tenant case.

**GST submission failures.** If WhiteBooks rejects an IRN (validation, network, auth), the invoice's IRN status becomes `failed`, a `GstDocument` row records the response payload, and a `PendingAction` is created in the `gst_compliance` module with severity high and an SLA deadline. The admin sees it in the pending-actions tray and can retry.

**Inventory discrepancies.** If a vehicle reconciliation finds a mismatch (loaded out ≠ delivered + returned + cancelled stock), an `AccountabilityLog` entry captures the cylinder type, quantity, and incident type (lost / damaged / missing / shortage / dispute). Status starts at `open`; investigation moves it through `investigating` → `resolved_recovered` / `resolved_written_off` / `resolved_charged` → `closed`.

**Audit log.** Every business-significant action — create / update / delete on customers, orders, invoices, payments, GST documents, distributor settings — emits an `AuditLog` entry via the `auditLog()` middleware on the route. Captures user, distributor, action, entity type, entity ID, timestamp, and IP.

**Daily E2E monitor.** A scheduled GitHub Actions workflow (`e2e-monitor.yml`) runs at 02:30 IST every day: spins up an ephemeral Postgres, applies the schema, seeds, starts the API, runs the critical-path E2E script (`packages/api/scripts/e2e-monitor.ts`), and emails results via SMTP. On failure it opens a GitHub issue with a `bug, monitoring` label.

**Health endpoint.** `GET /api/health` returns liveness and readiness. The web app surfaces it on the Health Monitoring page (super admin only). The operations scripts (`scripts/monitor/health-check.{ps1,sh}`) can poll it from cron / Windows Task Scheduler and Telegram-alert on failures via `scripts/alerts/`.

---

## PART 6 — What Is Built vs What Is Coming

Honest list. The `tracking/work_items.json` has 23 items. Here's the reality.

### Fully built and tested

- **Multi-tenant foundation** — distributor isolation across every service, audited end-to-end (WI-001 done)
- **Authentication** — JWT access + refresh tokens, secure-store on mobile, password reset via OTP, force password reset on first login, rate limits on login and forgot-password
- **Authorization** — 6 roles, role-gated routes, super admin tenant switching with audit log (WI-013, WI-014 done)
- **Customer management** — CRUD, search, soft delete, modification request workflow, audit trail, stop / resume supply, portal access provisioning
- **Cylinder catalog** — types, prices (effective-dated), empty-cylinder prices, thresholds, import from provider catalog
- **Orders** — full lifecycle from creation through dispatch, delivery, cancellation, modified delivery, returns-only orders
- **Inventory** — event-sourced, daily summaries, depot history, cancelled stock, threshold alerts, customer balances, 7-day forecast, lock/unlock days
- **Fleet** — driver / vehicle CRUD, daily driver-vehicle assignments, automatic recommendations, bulk operations, vehicle inventory, performance reports
- **Reconciliation** — vehicle return reconciliation with discrepancy → AccountabilityLog
- **Invoices** — generation from orders, GST split (CGST/SGST/IGST), credit notes, debit notes, both with approval workflows, PDF generation with QR codes
- **Payments** — record payment, auto-allocate or manual allocate, ledger per customer, multiple payment methods, partial payments
- **GST integration with WhiteBooks (sandbox only)** — IRN issue, IRN cancel, EWB generate, EWB cancel, IRN/EWB status lookup, GSTIN validation, cancel-and-regenerate flow, GSTIN lookup for distributor onboarding, geocoding
- **Customer portal** — dashboard, orders (place + view), invoices (view + bulk download summary), payments (view), account (profile + modification requests + cylinder discounts), delivery confirmation flow
- **Super admin** — distributors list / create / edit, distributor detail page with seat / GST usage / billing cycles, billing operations (generate / mark paid / suspend / unsuspend / check-expiry / mark-overdue), seat-request approval, provider catalog management, health monitoring
- **GasLink billing** — pricing tiers, billing cycle generation, BillingItem breakdown, period discounts, GST API overage billing, suspension flow, billing invoice PDF
- **Pending Actions inbox** — unified queue with module / status / severity filters, approve / resolve / reject with notes
- **Accountability** — discrepancy logging, resolution workflow with cost amount tracking
- **Analytics** — dashboard, header metrics, empty-cylinders report, due-amounts report, top sales, driver performance, revenue trends, customer lifetime value, collections, advanced metrics, Excel export
- **Settings** — SLA per severity, GST credentials with live test, GST mode toggle, cylinder thresholds, approval workflows, license uploads, staff user management with seat limits
- **Reliability** — graceful shutdown, process error handlers, web ErrorBoundary, source maps off in production (WI-009, WI-010, WI-011 done)
- **Security** — axios CVE upgrade (WI-012 done), distributor verification middleware (WI-013), audit logging (WI-014), tenant query-param anti-pattern removed (WI-002)
- **Mobile app** — all role-based screens built: driver delivery flow with proof camera, finance dashboard, inventory ops, admin dashboard, customer portal, super admin, auth flow including forgot password
- **API integration tests** — 254 tests covering 17 of 22 routes including auth, customers, payments, billing, settings, drivers/vehicles, assignments, analytics, cylinder types, pricing, users, pending actions, customer portal, GST sandbox flow, full workflow, inventory (WI-016, WI-017, WI-018 done)

### Built but needs more testing

- **Manual smoke / E2E** — Phase 1 navigation smoke (55 cases × 7 roles) is at 0/55. Phase 2 module-by-module E2E (~204 cases) is at 0. Phase 3 mobile via Expo Go is at 0. WI-024 tracks this — founder-driven once the API is reachable on a hosted URL.
- **GST live mode against production WhiteBooks** — sandbox is fully covered, production credentials have never been exercised. WI-007 is the launch blocker for any tenant flipping to `gstMode = live`.

### Foundation in place, completion pending

- **Telugu i18n** — i18next infrastructure, EN + TE locale files, language switcher in the web sidebar, ErrorBoundary translated, LoginPage + 4 customer-portal pages (Dashboard, Orders, Invoices, Payments) translated end-to-end, 4 enum namespaces translated (orderStatus, invoiceStatus, paymentMethod, paymentAllocationStatus). **5 of 28 web pages done** (~18%). Per-page extraction protocol documented at `.session/i18n-extraction-protocol.md`. Mobile i18n not started. WI-008 status: in_progress. Estimate: ~36-47 hours of focused work + a native-speaker translation review pass.
- **Float → Decimal migration for monetary fields** — schema currently uses Float for 35 monetary fields. This causes rounding drift in sum / aggregate operations on large datasets. A detailed 7-step migration plan with full field inventory exists at `.session/float-to-decimal-plan.md`. Execution deferred — it's a 4-8 hour surgical migration touching every monetary calculation in api / web. WI-006 status: planned. Currently classified `blocksLaunch: false` — Float is within tolerance for typical order values.
- **Sentry web wiring** — the ErrorBoundary uses `globalThis.Sentry` (script-tag style) so we don't have a hard dependency on `@sentry/browser` until a DSN is provisioned. Once the DSN exists, install `@sentry/browser`, init in main.tsx, and switch ErrorBoundary to a direct dynamic import. WI-020 tracks this.

### Planned but not started

- **GitHub remote + push** — no `origin` remote configured today. Required before CI/CD runs against pushes. WI-023, P0.
- **Telugu i18n full extraction** — 23 remaining web pages, 5 remaining web components, all 55 mobile route files, 7 mobile components, plus native-speaker translation review. Part of WI-008.
- **EAS production build** — Apple Developer + Google Play accounts must be set up with bundle ID `com.mygaslink.app`. DNS for `api.mygaslink.com` must point to the production EC2 with TLS. Privacy policy URL must be hosted publicly. `eas credentials` must be run interactively once. `eas.json submit.production` block must be filled in with Apple ID + ASC App ID + Google service-account path. The `RECORD_AUDIO` Android permission either needs an iOS `NSMicrophoneUsageDescription` or to be removed. All tracked in `.session/eas-readiness.md`.
- **Phase 1 / 2 / 3 manual testing** — currently 0/N. Founder-driven, ~30 minutes for Phase 1, several hours for Phase 2 and Phase 3.
- **Source map upload to Sentry** — `@sentry/vite-plugin` for the web bundle, `@sentry/react-native` for mobile. After DSN is provisioned.
- **Operations tooling integration** — the framework's `scripts/alerts/` (Telegram), `scripts/crons/cron-runner.sh`, `scripts/monitor/` (DB / disk / mem health), `scripts/security/security-scan.sh` exist on disk and are runnable, but none are wired into the CI workflows or the production EC2 yet. They're operator-side cron / Task Scheduler tooling.
- **Coverage instrumentation** — the ADLC config defines coverage thresholds (auth 100%, business 80%, overall 70%) but `vitest --coverage` is not wired into CI. Aspirational gates today.
