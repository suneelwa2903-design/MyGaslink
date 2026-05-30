I now have a comprehensive view. Let me produce the audit report.

---

# Re-New GasLink â€” Web â†” Mobile Parity Audit (Distributor Admin, Finance, Inventory)

Scope: distributor_admin, finance, inventory only. Read-only discovery; no files modified.

Code references:
- Web router: `C:\Projects\Re-New_Gaslink\packages\web\src\routes\index.tsx`
- Web sidebar: `C:\Projects\Re-New_Gaslink\packages\web\src\components\layout\Sidebar.tsx`
- Mobile root layout: `C:\Projects\Re-New_Gaslink\packages\mobile\app\_layout.tsx`
- Mobile role landing: `C:\Projects\Re-New_Gaslink\packages\mobile\app\index.tsx`

---

## PHASE 1 â€” Complete Web Route Map

Web role gating is centralised in two places: visible nav entries are filtered by `roles[]` on `MenuItem` in `Sidebar.tsx:39-158`; route access is enforced by `<ProtectedRoute allowedRoles=[...]>` in `routes/index.tsx`. Every protected app route is also wrapped by `DashboardLayout` (single shared layout) and most additionally by `requireDistributor` (super-admin only restriction).

### Distributor Admin â€” All Web Routes

| URL path | Page component | Sidebar section | Visible label | Has sub-tabs? |
|---|---|---|---|---|
| `/app/analytics` | `AnalyticsPage` | Analytics | "Analytics" (`nav.analytics`) | Yes â€” Dashboard, Overview, Reports, Pending Actions (`AnalyticsPage.tsx:224-229`) |
| `/app/orders` | `OrdersPage` | Orders | "Orders" (`nav.orders`) | Yes â€” Orders, Driver Assignment (`OrdersPage.tsx:198-221`) |
| `/app/inventory` | `InventoryPage` | Inventory | "Inventory" (`nav.inventory`) | Yes â€” Daily Summary, Depot History, Stock at Onboarding, AI Demand Forecast, Customer Balances, Vehicle Return (`InventoryPage.tsx:261-268`) |
| `/app/customers` | `CustomersPage` | Customers | "Customers" (`nav.customers`) | No (single list; modal-based detail) |
| `/app/billing-payments` | `BillingPaymentsPage` | Billing & Payments | "Billing & Payments" (`nav.billing`) | Yes â€” Invoices, Payments (`BillingPaymentsPage.tsx:108-114`) |
| `/app/collections` | `CollectionsPage` | Collections | "Collections" (hard-coded EN, no i18n key) | Yes â€” Call list, All collections, Blocked (`CollectionsPage.tsx:30, 113-143`) |
| `/app/fleet` | `FleetPage` | Fleet | "Fleet" (`nav.fleet`) | Yes â€” Drivers, Vehicles, Vehicle Mapping (`FleetPage.tsx:48-53`) |
| `/app/settings` | `SettingsPage` | Settings | "Settings" (`nav.settings`) | Yes â€” Onboarding, General, Subscription, GST, Cylinder Types, Cylinder Prices, Thresholds, Approvals, Users, Licenses (`SettingsPage.tsx:63-74`) |
| `/app/pending-actions` | `PendingActionsPage` | (no sidebar entry â€” only via Analytics tab and bell) | n/a | No |
| `/app/invoices` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/billing-payments` |
| `/app/payments` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/billing-payments` |
| `/app/drivers-vehicles` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/fleet` |
| `/app/assignments` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/fleet` |
| `/app/reports` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/analytics` |
| `/app/billing` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/settings` |
| `/app/billing/suspended` | `BillingSuspendedPage` | n/a | n/a | No |
| `/app/dashboard` â†’ redirect | n/a | n/a | n/a | Redirect to `/app/analytics` |

### Finance â€” All Web Routes
Identical to Distributor Admin (same `MenuItem.roles` lists; same `ProtectedRoute.allowedRoles`). Cf. `Sidebar.tsx:39-158` and `routes/index.tsx:99-258`. Inâ€‘page UI gates supply viewâ€‘only mode (e.g. `CustomersPage.tsx:94-95` hides create/edit/stop-supply buttons for FINANCE). Settings tabs visible to FINANCE: Cylinder Types, Cylinder Prices, Thresholds, Licenses only â€” `SettingsPage.tsx:59-74` (admin-only tabs are filtered out).

| URL path | Page component | Sidebar section | Visible label | Has sub-tabs? |
|---|---|---|---|---|
| `/app/analytics` | `AnalyticsPage` | Analytics | "Analytics" | Yes â€” Dashboard, Overview, Reports, Pending Actions |
| `/app/orders` | `OrdersPage` | Orders | "Orders" | Yes â€” Orders, Driver Assignment (FINANCE has `canAssignDrivers=true` in `OrdersPage.tsx:74-78`) |
| `/app/inventory` | `InventoryPage` | Inventory | "Inventory" | Yes â€” same 6 sub-tabs |
| `/app/customers` | `CustomersPage` | Customers | "Customers" | No (view-only for FINANCE) |
| `/app/billing-payments` | `BillingPaymentsPage` | Billing & Payments | "Billing & Payments" | Yes â€” Invoices, Payments |
| `/app/collections` | `CollectionsPage` | Collections | "Collections" | Yes â€” Call list, All collections, Blocked |
| `/app/fleet` | `FleetPage` | Fleet | "Fleet" | Yes â€” Drivers, Vehicles, Vehicle Mapping |
| `/app/settings` | `SettingsPage` | Settings | "Settings" | Yes (4 tabs: Cylinder Types, Cylinder Prices, Thresholds, Licenses) |
| `/app/pending-actions` | `PendingActionsPage` | (no sidebar entry) | n/a | No |
| (all redirect aliases identical to admin) | | | | |

### Inventory â€” All Web Routes
Sidebar item filtering for INVENTORY (same `Sidebar.tsx:39-158` array, `roles` includes UserRole.INVENTORY):

| URL path | Page component | Sidebar section | Visible label | Has sub-tabs? |
|---|---|---|---|---|
| `/app/analytics` | `AnalyticsPage` | Analytics | "Analytics" | Yes â€” Dashboard, Overview, Reports, Pending Actions |
| `/app/orders` | `OrdersPage` | Orders | "Orders" | Yes â€” Orders, Driver Assignment (INVENTORY has `canAssignDrivers=true`) |
| `/app/inventory` | `InventoryPage` | Inventory | "Inventory" | Yes â€” same 6 sub-tabs |
| `/app/customers` | `CustomersPage` | Customers | "Customers" | No (INVENTORY can manage) |
| `/app/billing-payments` | `BillingPaymentsPage` | Billing & Payments | "Billing & Payments" | Yes |
| `/app/collections` | `CollectionsPage` | Collections | "Collections" | Yes |
| `/app/fleet` | `FleetPage` | Fleet | "Fleet" | Yes |
| `/app/settings` | `SettingsPage` | Settings | "Settings" | Yes (4 tabs: Cylinder Types, Cylinder Prices, Thresholds, Licenses) |
| `/app/pending-actions` | `PendingActionsPage` | (no sidebar entry) | n/a | No |

---

## PHASE 2 â€” Complete Mobile Screen Map

Tab definitions:
- Admin: `packages/mobile/app/(admin)/_layout.tsx:52-82` (5 tabs)
- Finance: `packages/mobile/app/(finance)/_layout.tsx:13-20` (5 visible + 1 hidden `profile`)
- Inventory: `packages/mobile/app/(inventory)/_layout.tsx:25-61` (5 visible + 5 hidden `summary/actions/reconciliation/alerts/profile`)

Index router: `packages/mobile/app/index.tsx:19-40`. Note: `distributor_admin` â†’ `/(admin)/dashboard`; `finance` â†’ `/(finance)/dashboard`; `inventory` â†’ `/(inventory)/summary` (an `href:null`-hidden screen, not the visible Analytics tab â€” index.tsx:33 vs _layout.tsx:57).

### Distributor Admin â€” All Mobile Screens

| File path | Screen title (shown to user) | Tab/Nav location | Sub-screens / modals |
|---|---|---|---|
| `packages/mobile/app/(admin)/dashboard.tsx` | "Dashboard" (tab); content header: "Good morning/afternoon, {firstName}" | Tab 1 of 5 | None (read-only KPI grid + pending actions list) |
| `packages/mobile/app/(admin)/orders.tsx` | "Orders" | Tab 2 of 5 | Create Order modal, Assign Driver modal, Bulk Assign modal, Delivery Confirmation modal, Dispatch Result modal |
| `packages/mobile/app/(admin)/finance.tsx` | "Billing" (tab); content tabs: Invoices / Payments | Tab 3 of 5 | Pay Invoice modal, Create Payment modal, Create Credit/Debit Note modal, Reject Note modal, Allocate Payment modal, Invoice notes section (inline) |
| `packages/mobile/app/(admin)/inventory.tsx` | "Inventory" | Tab 4 of 5 | Sub-tabs: Summary, History, Cancelled, Forecast, Balances, Reconcile; Incoming Fulls modal, Outgoing Empties modal, Adjust Stock modal |
| `packages/mobile/app/(admin)/more.tsx` | "More" | Tab 5 of 5 | Customers modal, Fleet modal (Drivers/Vehicles/Assignments tabs), Collections modal, Analytics Overview modal, Reports modal (Revenue/Top Customers/Driver Performance tabs), GST Configuration modal, Cylinder Prices modal, Inventory Thresholds modal, User Management modal |

### Finance â€” All Mobile Screens

| File path | Screen title | Tab/Nav location | Sub-screens / modals |
|---|---|---|---|
| `packages/mobile/app/(finance)/dashboard.tsx` | "Analytics" (header) | Tab 1 of 5 ("Analytics") | Sub-tabs: Overview, Overdue Customers (in-screen) |
| `packages/mobile/app/(finance)/invoices.tsx` | "Invoices" (tab) | Tab 2 of 5 | Status filter pills (All/Issued/Partial/Paid/Overdue); Invoice Detail modal |
| `packages/mobile/app/(finance)/payments.tsx` | "Payments" (tab) | Tab 3 of 5 | Screen tabs: Payments / Credit/Debit Notes; Record Payment modal; Create Note modal |
| `packages/mobile/app/(finance)/collections.tsx` | "Collections" (tab) | Tab 4 of 5 | None (single list with summary metrics) |
| `packages/mobile/app/(finance)/more.tsx` | "More" | Tab 5 of 5 | Profile link, Sign Out alert |
| `packages/mobile/app/(finance)/profile.tsx` | "Profile" | Hidden (`href:null`) â€” only via /more | None |

### Inventory â€” All Mobile Screens

| File path | Screen title | Tab/Nav location | Sub-screens / modals |
|---|---|---|---|
| `packages/mobile/app/(inventory)/analytics.tsx` | "Analytics" | Tab 1 of 5 | None (KPIs, snapshot, recent orders) |
| `packages/mobile/app/(inventory)/orders.tsx` | "Orders" (tab) | Tab 2 of 5 | Status tabs (All/Pending/Dispatched/Delivered); expandable cards; no modals |
| `packages/mobile/app/(inventory)/inventory.tsx` | "Inventory" (tab) | Tab 3 of 5 | Sub-tabs: Summary, Actions, Reconciliation, Alerts; Action modal (Incoming/Outgoing/Manual Adjustment) |
| `packages/mobile/app/(inventory)/fleet.tsx` | "Fleet" | Tab 4 of 5 | None â€” search + status filter + driver list |
| `packages/mobile/app/(inventory)/more.tsx` | "More" | Tab 5 of 5 | Profile (inline), Settings (no-op), Sign Out |
| `packages/mobile/app/(inventory)/summary.tsx` | Legacy summary screen | Hidden (`href:null`); index.tsx routes inventory role here on login | â€” |
| `packages/mobile/app/(inventory)/actions.tsx` | Legacy actions screen | Hidden | â€” |
| `packages/mobile/app/(inventory)/reconciliation.tsx` | Legacy reconciliation | Hidden | â€” |
| `packages/mobile/app/(inventory)/alerts.tsx` | Legacy alerts | Hidden | â€” |
| `packages/mobile/app/(inventory)/profile.tsx` | "Profile" | Hidden | â€” |

Note: `/(inventory)/summary` is the initial route for inventory role per `index.tsx:33`, but `summary` is marked `href:null` in `_layout.tsx:57`. This means inventory users land on a screen that isn't reachable from the tab bar (likely a bug or stale routing â€” flag for product decision).

---

## PHASE 3 â€” Side-by-Side Page Analysis

### Distributor Admin â†’ Analytics

#### Web version (`packages/web/src/pages/AnalyticsPage.tsx`)
- Filters: `dateFrom` and `dateTo` date pickers in header (`AnalyticsPage.tsx:263-267`); defaults to last 1 month (`:70-73`).
- Sub-tabs (`:224-229`): **Dashboard / Overview / Reports / Pending Actions**.
- Dashboard tab columns/cards (`:215-222`):
  - 4 metric cards: "Pending Orders" â†’ `/app/orders?status=pending_driver_assignment,pending_dispatch`; "Outstanding Amount" â†’ `/app/collections`; "Overdue Invoices" â†’ `/app/billing-payments?status=overdue`; "Inventory Alerts" â†’ `/app/inventory`.
  - Role-aware morning briefing sections (`:105-165`): Stock Summary (admin+inventory), Overdue Call List (admin+finance), Threshold Alerts (inventory), Unallocated Payments (finance), GST Failures (finance), Pending Reconciliation (inventory), Onboarding banner (admin).
  - Pending Actions list with Approve/Reject/Resolve actions.
- Overview tab: insights list from `/analytics/insights`.
- Reports tab: embeds `ReportsPanel` (a full reports page).
- Pending Actions tab: embeds `PendingActionsPanel` (filter by module + status, group by module).
- Actions: approve, reject, resolve pending actions (`:167-195`); navigate to detail pages via card links.
- Sort: server-side; no UI sort controls.
- Export: no.
- File: `packages/web/src/pages/AnalyticsPage.tsx:56-300+`

#### Mobile version (`packages/mobile/app/(admin)/dashboard.tsx`)
- EXISTS: partial.
- Filters: none (date range is fixed/server-default; no UI control).
- Fields shown (KPI cards, `:101-168`): Orders Today, Delivered, Revenue Today, Pending Orders, Overdue Invoices, Outstanding, Inventory Alerts, Pending Actions (8 cards, fixed layout).
- Pending Actions section: top 5 only; tap "View All" â†’ routes to `/(admin)/more` (NOT a dedicated PA screen) (`:382-393`).
- Sub-tabs: none.
- Actions: none on actions list (display only â€” no Approve/Reject/Resolve buttons on mobile).
- Sort: n/a.
- Export: no.
- File: `packages/mobile/app/(admin)/dashboard.tsx`

#### Gaps (web has, mobile doesn't)
- Date range filter (header pickers).
- Sub-tabs: Overview / Reports / Pending Actions (mobile only has dashboard view; Overview + Reports live behind separate modals in `/(admin)/more`; full Pending Actions list is missing entirely on mobile).
- Approve / Reject / Resolve actions on pending-actions cards.
- Role-aware morning briefing sections: Stock Summary, Overdue Call List, Threshold Alerts, Unallocated Payments, GST Failures, Pending Reconciliation, Onboarding banner.
- Clickable navigation from KPI cards to filtered views (web routes; mobile cards are non-interactive).

#### Mobile-only (mobile has, web doesn't)
- "Good morning/afternoon/evening" greeting (`dashboard.tsx:58-63`).
- 8 KPI cards including Orders Today, Delivered Today, Revenue Today (web dropped these in 4-card redesign, per `AnalyticsPage.tsx:208-214` comment).

---

### Distributor Admin â†’ Orders

#### Web version (`packages/web/src/pages/OrdersPage.tsx`)
- Filters (`:228-261`):
  - Search box (free text).
  - Status dropdown â€” all `OrderStatus` values: `pending_driver_assignment, pending_dispatch, preflight_in_progress, pending_delivery, delivered, modified_delivered, cancelled`.
  - Date From (default = today âˆ’ 30d).
  - Date To (default = today).
- Sub-tabs (`:198-221`): **Orders / Driver Assignment** (Driver Assignment for admin/finance/inventory; `canAssignDrivers`).
- Driver Assignment tab structure (`:1317+`): three sections â€”
  - **In Transit** drivers (with [+ Add to Trip] and Trip Sheet button).
  - **Ready to Dispatch** groups by driver (with Dispatch button â†’ triggers preflight).
  - **Pending Assignment** orders list with inline per-row driver dropdown + bulk-assign toolbar.
- Columns/fields (Orders tab, `:286-294`): bulk-select checkbox, Order #, Customer, Delivery Date, Items (count), Amount, Driver, Status, Actions.
- Actions (per-row, `:319-368`):
  - View (eye icon) â€” opens `OrderDetailModal` (read-only).
  - Assign Driver (truck icon) â€” opens `AssignDriverModal`.
  - Confirm Delivery (check icon) â€” opens `DeliveryConfirmationModal`.
  - Edit (pencil) â€” opens `EditOrderModal`.
  - Cancel (X icon) â€” opens `CancelOrderModal`.
- Header actions (`:167-195`):
  - Bulk "Assign Driver (n)" (when â‰¥1 PENDING_DRIVER_ASSIGNMENT selected).
  - "Returns Order" â†’ opens `ReturnsOrderModal`.
  - "New Order" â†’ opens `CreateOrderModal`.
- Sort: server-side, no UI control.
- Export: no.
- Modals (10): Create Order, Returns Order, Assign Driver, Bulk Assign Driver, Delivery Confirmation, Edit Order, Order Detail (view), Cancel Order, Dispatch Progress (inside Assignments tab), Add to Trip.
- File: `packages/web/src/pages/OrdersPage.tsx:66-1996`

#### Mobile version (`packages/mobile/app/(admin)/orders.tsx`)
- EXISTS: partial.
- Filters (`:120-127`): status tabs only â€” All / Pending Assignment / Pending Dispatch / Pending Delivery / Delivered / Cancelled (NO `preflight_in_progress`, NO `modified_delivered`). Search box. NO date range pickers.
- Sub-tabs: none (single screen).
- Fields per card (`:447-481`): Order Number, Customer Name, Status badge, Delivery Date, Driver/Unassigned, Amount, Items as chips (`cylinderType x qty`).
- Expanded view (`:484-538`): detailed item rows with unit prices, Special Instructions, action buttons.
- Actions (`:507-536`):
  - Assign Driver (`canAssign === pending_driver_assignment`) â€” opens AssignDriverModal.
  - Confirm Delivery (`canDeliver === pending_delivery || pending_dispatch`) â€” opens DeliveryConfirmationModal.
  - Cancel (`canCancel`) â€” Alert dialog confirm, then mutate.
- Long-press to multi-select (`:434-436`); bulk-assign bar appears at top (`:602-624`).
- "Ready to Dispatch" header (`:647-693`) â€” groups by driver, Dispatch button calls `/orders/preflight-dispatch`.
- "In Transit" footer (`:695-738`) â€” list of drivers with Trip Sheet download button (shares PDF).
- FAB "+" (`:752-758`) â€” opens CreateOrderModal.
- NO: Returns Order, Edit Order, View-only Order Detail modal (web's read-only `OrderDetailModal`), Driver Assignment dedicated tab.
- Sort: n/a.
- Export: Trip Sheet PDF only (`handleDownloadTripSheet`, `:375-403`).
- File: `packages/mobile/app/(admin)/orders.tsx`

#### Gaps (web has, mobile doesn't)
- Date-range filters (From/To).
- Status filter values: `preflight_in_progress`, `modified_delivered`.
- "Returns Order" button + Returns Order modal (web `:186-189`).
- Edit Order modal â€” mobile has no way to edit an existing order.
- Read-only Order Detail modal for delivered/cancelled orders.
- Dedicated "Driver Assignment" tab with In Transit + Ready to Dispatch + Pending sections as a single workflow page.
- Inline per-row driver dropdown for one-tap assignment (mobile requires opening a modal).
- "Add to Trip" flow (web `:1331-1332` mode flag).
- Cancel Order details modal with the explanation copy (web's CancelOrderModal vs mobile's simple Alert).

#### Mobile-only (mobile has, web doesn't)
- Long-press to multi-select (web uses checkboxes).
- Floating Action Button.
- Trip Sheet PDF download/share from In Transit section (web exposes this on Assignments tab too â€” partial parity).

---

### Distributor Admin â†’ Inventory

#### Web version (`packages/web/src/pages/InventoryPage.tsx`)
- Filters: Date navigation (prev/next arrows + date picker + "Today" button, `:294-348`); per-tab filters (Depot History has its own From/To/Event Type).
- Sub-tabs (`:261-268`): **Daily Summary / Depot History / Stock at Onboarding / AI Demand Forecast / Customer Balances / Vehicle Return** (6 tabs).
- Daily Summary columns (`:710-727`): grouped headers â€” **Corporation** (Incoming Fulls / Outgoing Empties), **Opening** (Fulls / Empties), **On Vehicle** (Fulls / Empties), **At Customer** (Delivered Fulls / Collected Empties), **Adjustments** (Returned / Manual), **Closing** (Fulls / Empties) + Status. Column visibility toggleable via "Columns" picker (`:762-790`); persisted to localStorage.
- Header actions (`:278-291`): Incoming Fulls, Outgoing Empties, Adjust Stock (only when day not locked).
- Lock/Unlock Day button (`:322-346`).
- Depot History columns (`:434-445`): Date, Type, Cylinder Type, Qty, Vehicle No, Driver, Doc Type, Doc No, Doc Date, Notes. Pagination.
- Stock at Onboarding columns (`:497-503`): Cylinder Type, Opening Fulls, Opening Empties, Date Set.
- AI Demand Forecast columns (`:533-541`): Cylinder Type, Avg Daily Demand, Current Stock, Days Remaining, 7-Day Forecast, 30-Day Forecast, Reorder Qty, Trend.
- Customer Balances tab: separate component (`CustomerBalancesTab`).
- Vehicle Return tab (`:580-605`): cards per vehicle with cancelled-stock lines, empties verification inputs, Confirm & Reconcile + Report Mismatch buttons; Mismatch Log section.
- Adjust Stock modal (`:1053+`): New Adjustment + Adjustment History tabs; CSV export (`:1117-1138`).
- Sort: no UI sort controls.
- Export: CSV from Adjustment History (`downloadCsv`, `:1117`).
- File: `packages/web/src/pages/InventoryPage.tsx:105-1666`

#### Mobile version (`packages/mobile/app/(admin)/inventory.tsx`)
- EXISTS: partial.
- Filters: Date navigation arrows + Today button (`:577-645`); History tab has its own From / To buttons + quick 7D/30D presets (`:1386-1461`).
- Sub-tabs (`:109-116`): **Summary / History / Cancelled / Forecast / Balances / Reconcile** (6 tabs â€” matches web 1:1 by count but renamed).
- Summary card-per-cylinder layout (`:664-799`): each cylinder gets a card with 2-col metrics grid (Opening Fulls, Incoming, Delivered, Cancelled, Outgoing Empties, Collected Empties) + closing row. NO column-grouped table; NO column visibility picker.
- Action buttons row (`:517-574`): Incoming Fulls, Outgoing Empties, Adjust Stock (always visible).
- Lock/Unlock button (`:629-644`).
- History tab columns (per card, `:1318-1378`): Date, Type badge (Incoming/Outgoing), Cylinder Type, Â±Qty, Vehicle, Doc Number. NO Driver, Doc Type, Doc Date, Notes columns.
- Cancelled tab (`:1490-1641`): list of cancelled stock with Qty / Driver / Vehicle, Return to Depot action.
- Forecast tab (`:1646-1700+`): per-cylinder cards with current stock, avg daily, days remaining, trend, 7d/30d forecast, reorder qty.
- Balances tab and Reconcile tab: implemented per `TABS` array.
- Sort: n/a.
- Export: NO CSV export.
- NO: "Stock at Onboarding" tab (web has it; mobile collapses Onboarding info elsewhere).
- File: `packages/mobile/app/(admin)/inventory.tsx`

#### Gaps (web has, mobile doesn't)
- Stock at Onboarding sub-tab â€” mobile is missing this view entirely.
- Column-grouped Daily Summary table (Corporation / Opening / On Vehicle / At Customer / Adjustments / Closing) â€” mobile uses simpler 2-col metric cards.
- "Columns" picker with localStorage persistence.
- Detailed legend / "Example â€” 19 KG cylinders on a typical day" explanation block (`InventoryPage.tsx:846-861`).
- Depot History columns: Driver, Doc Type, Doc Date, Notes.
- Adjustment History view (web has full History tab in Adjust Stock modal, with filters by bucket/cylinder/date + CSV export).
- Mismatch Log section + Report Mismatch modal (web Vehicle Return tab has structured 3-step mismatch modal; mobile Reconcile has simpler flow).
- Forecast tab: web shows Trend (Increasing/Decreasing/Stable with arrows) with explicit colour coding; mobile shows similar info via icon.

#### Mobile-only (mobile has, web doesn't)
- Date quick presets (7D / 30D) on History tab.
- Card-per-cylinder layout (web is single table).

---

### Distributor Admin â†’ Customers

#### Web version (`packages/web/src/pages/CustomersPage.tsx`)
- Filters (`:112-131`): Search box + Status dropdown (Active/Suspended/Inactive).
- Sub-tabs: none.
- Columns (`:147-153`): Name (+ business name sub-line), Phone, Type (B2B/B2C badge), Credit Period, Supply (Active/Stopped badge), Status, Actions.
- Actions (`:183-217`): View (eye), Edit (pencil), Stop Supply / Resume Supply (toggle).
- Header: "New Customer" button (admin/super_admin/inventory only; hidden for FINANCE â€” `:94-95`).
- Sort: no UI sort controls.
- Export: no (CustomerDetailModal has invoice/payment/ledger PDF downloads, surveyed but not enumerated here).
- Pagination.
- Modals: CustomerFormModal (create/edit), CustomerDetailModal.
- File: `packages/web/src/pages/CustomersPage.tsx:44-300+`

#### Mobile version
- EXISTS: yes, but **NOT in the main tab bar** â€” accessed via `/(admin)/more.tsx` â†’ "Customers" MenuRow (`more.tsx:2097`).
- Filters (`more.tsx:746-774`): Search box only (no status dropdown).
- Fields per row (`:548-592`): Avatar with initial, Customer name, Phone, Type badge (B2B/B2C), Status badge (active/suspended).
- Expanded detail rows (`:596-650`): Business, Email, GSTIN, Credit Period, Total Orders, Outstanding, Stop/Resume Supply button.
- Actions: Stop Supply / Resume Supply (in expanded view).
- Header action: FAB "+" â†’ create customer form (in-modal scroll view with Name, Business Name, Phone, Email, GSTIN, Type (B2C/B2B toggle), Credit Period).
- No Edit action.
- No View modal (expand-in-place instead).
- Sort: n/a.
- Export: no.
- File: `packages/mobile/app/(admin)/more.tsx:423-795` (CustomersModal)

#### Gaps (web has, mobile doesn't)
- Customers is a top-level sidebar item on web; on mobile it's buried in More â†’ Customers (extra tap).
- Status filter dropdown (Active/Suspended/Inactive).
- Edit Customer flow (web has dedicated Edit modal; mobile only has create).
- Full Customer Detail view (web `CustomerDetailModal` includes invoices/payments/ledger tabs).
- Pagination (mobile loads `?limit=200`; web paginates 25/page).
- Inventory role nuance: web `canManage = role !== FINANCE`; mobile Customers modal is inside the (admin) group only.

#### Mobile-only
- Expanded-card pattern with avatar.

---

### Distributor Admin â†’ Billing & Payments

#### Web version (`packages/web/src/pages/BillingPaymentsPage.tsx`)
- Sub-tabs (`:108-114`): **Invoices / Payments**.
- Invoices tab filters (`:225-244`): Status dropdown (DRAFT/ISSUED/PARTIALLY_PAID/PAID/OVERDUE/CANCELLED), IRN Status dropdown (only when GST enabled), Date From, Date To.
- Invoice columns (`:255-275`): Invoice # (with CN/DN count badges), Customer, Issue Date, Due Date, Total, Outstanding, Status, GST (when enabled: IRN + EWB pills for B2B; EWB only for B2C â€” `:316-326`), Actions.
- Actions per invoice (`:329-353`):
  - View (eye).
  - Download PDF.
  - Record Payment (banknote, only when status not CANCELLED/PAID).
  - Credit Note (minus, only when GST enabled).
  - Debit Note (plus, only when GST enabled).
  - (Inside detail modal) Cancel IRN, Cancel EWB, Generate GST, Regenerate Invoice.
- Payments tab: separate component (PaymentsTab) with allocation status filtering.
- Sort: no UI sort controls.
- Export: PDF (per invoice).
- Modals: InvoiceDetailModal, CreditNoteModal, DebitNoteModal, PayInvoiceModal, CancelIrnModal, CancelEwbModal.
- File: `packages/web/src/pages/BillingPaymentsPage.tsx:107-400+`

#### Mobile version (`packages/mobile/app/(admin)/finance.tsx`)
- EXISTS: partial.
- Top tabs (`:286-318`): Invoices / Payments â€” matches web.
- Invoices tab:
  - Filters (`:93-100`): status pills All / Issued / Partially Paid / Paid / Overdue / Cancelled. NO IRN Status filter. NO date pickers.
  - Card fields (`:492-558`): Invoice number, status badge, CN/DN count chips, Customer name, Issue date, Total, Due (outstanding), Due Date.
  - Expand to reveal Line Items, Summary (Total/Paid/Outstanding), Action buttons.
  - Actions (`:639-727`): Download PDF (share), Record Payment, Credit Note (GST + status==issued only), Debit Note (GST + status==issued only).
  - Inline Notes section showing CN/DN with Approve/Reject buttons + PDF download.
- Payments tab:
  - No status filter.
  - Card fields (`:1391-1506`): Date, Customer Name, Amount (green), Method badge, Reference, Allocation status badge, Allocations invoice link, Unallocated amount + Allocate button.
- Sort: n/a.
- Export: PDF (invoice + CN + DN).
- Modals: PayInvoiceModal, CreatePaymentModal, CreateNoteModal (CN+DN), RejectNoteModal, AllocatePaymentModal.
- File: `packages/mobile/app/(admin)/finance.tsx`

#### Gaps (web has, mobile doesn't)
- Date From / Date To pickers on Invoices.
- IRN Status filter (when GST enabled).
- Status options: `draft` (mobile filter omits this, though usually draft invoices are rare).
- GST badge column (B2B IRN + EWB pills, B2C EWB only) â€” mobile shows "GST e-Invoice" badge only when IRN exists.
- Cancel IRN / Cancel EWB / Generate GST / Regenerate Invoice actions (web's detail modal; mobile lacks these).
- Web Payments tab has allocation status filter at server level; mobile doesn't filter.

#### Mobile-only
- Inline expand-to-show-line-items pattern.
- Inline CN/DN list under each invoice card with Approve/Reject buttons.
- Allocate Payment modal on Payments cards.

---

### Distributor Admin â†’ Collections

#### Web version (`packages/web/src/pages/CollectionsPage.tsx`)
- Sub-tabs / view toggle (`:113-143`): **Call list / All collections / Blocked**.
- Header: "Export to Excel" button (`:91-93`).
- Summary cards: Total Due, Total Overdue, Missing Cylinders.
- Call List table columns (`:155-185`): Customer, Outstanding, Overdue invoices, Days overdue, Phone (tel: link), View account link.
- Mobile (responsive) view: cards with phone CTA button.
- Blocked view: pending OVERDUE_ORDER_OVERRIDE actions with Approve button.
- Sort: server-side (call list sorts by daysOverdue desc).
- Export: Excel (collections-report.xlsx).
- File: `packages/web/src/pages/CollectionsPage.tsx`

#### Mobile version
- EXISTS: partial.
- For Distributor Admin: accessed via `/(admin)/more.tsx` â†’ "Collections" MenuRow â†’ CollectionsModal (`more.tsx:1139-1230`).
- Sub-tabs: none.
- Summary metrics (4 boxes): Total Collected, Pending, Collection Rate %, Overdue.
- Recent Collections list (read-only).
- NO Call list with phone CTA.
- NO Blocked / override-approval view.
- Sort: n/a.
- Export: no.

For Finance role, dedicated mobile screen at `/(finance)/collections.tsx`:
- Sub-tabs: none.
- Summary metrics: Total Receivable, Overdue, Missing Cylinder Value, Customers (with outstanding dues).
- Customer list with per-card details: Total Due, Overdue, Missing Cylinders + value, Excess Empties, Total Collectible, Credit period.
- NO Call list / Blocked sub-tabs.

#### Gaps (web has, mobile doesn't)
- "Call list" view with tel: phone CTA (the primary workflow per web design).
- "Blocked" view with OVERDUE_ORDER_OVERRIDE pending actions and Approve button.
- Excel export.
- "Days overdue" badge per row.
- Admin role: Collections is a dedicated sidebar item on web; on mobile (admin) it's behind /more.

---

### Distributor Admin â†’ Fleet

#### Web version (`packages/web/src/pages/FleetPage.tsx`)
- Sub-tabs (`:48-53`): **Drivers / Vehicles / Vehicle Mapping**.
- Vehicle Mapping tab (`:104-300+`):
  - Date picker.
  - "Bulk Confirm (Use Previous Day)" button.
  - Table columns: Driver, Vehicle (inline editable Select), Status (confirmed/recommended/unassigned badge), Source.
  - Inactive-vehicle warning per row.
  - Summary footer: Confirmed: N | Recommended: N | Unassigned: N.
- Drivers tab: standard list + create (DriversTab).
- Vehicles tab: standard list + create (VehiclesTab).
- File: `packages/web/src/pages/FleetPage.tsx:35-300+`

#### Mobile version
- EXISTS: partial. Three locations:
- (admin) â†’ via `/(admin)/more.tsx` â†’ "Fleet" MenuRow â†’ FleetModal (`more.tsx:820-1118`). Tabs: Drivers / Vehicles / Assignments.
- (inventory) â†’ top-level `/(inventory)/fleet.tsx` tab.
- Drivers section (admin modal): list with name, phone, license + Add Driver form (FAB).
- Vehicles section (admin modal): list with vehicle number, type, capacity + Add Vehicle form (FAB).
- Assignments section: read-only list of driver/vehicle mappings with assigned date.
- NO inline-editable Vehicle picker per driver row.
- NO Bulk Confirm (Use Previous Day) action.
- NO Date picker for the mappings view.
- NO Status (confirmed / recommended / unassigned) classification.
- (inventory)/fleet.tsx: single combined list of drivers with vehicle inline; status filter pills (All / Active / Inactive); search; NO mappings management at all.
- Files: `packages/mobile/app/(admin)/more.tsx:820-1118`, `packages/mobile/app/(inventory)/fleet.tsx`

#### Gaps (web has, mobile doesn't)
- Vehicle Mapping is a core daily workflow on web; on mobile (admin) it's a read-only assignments list; on mobile (inventory) it doesn't exist.
- "Bulk Confirm (Use Previous Day)" button.
- Date picker for mappings.
- Inline Vehicle dropdown editor per driver.
- Vehicle Mapping status badges (confirmed/recommended/unassigned) + summary counts.
- Inactive-vehicle warning per mapping row.
- Web Drivers/Vehicles tabs have Edit/Delete; mobile has Add only.
- Web tab name "Vehicle Mapping" vs mobile "Assignments".

---

### Distributor Admin â†’ Settings

#### Web version (`packages/web/src/pages/SettingsPage.tsx`)
- Sub-tabs (`:63-74`): **Onboarding / General / Subscription / GST / Cylinder Types / Cylinder Prices / Thresholds / Approvals / Users / Licenses**.
- General: SLA hours (Critical/High/Medium/Low), Invoice Code (3-letter `docCode`).
- Subscription: pricing/billing settings.
- GST: mode selector + credentials form.
- Cylinder Types: CRUD list.
- Cylinder Prices: per-type prices.
- Thresholds: warning + critical per cylinder type.
- Approvals: `ApprovalWorkflowConfig`.
- Users: CRUD list.
- Licenses: CRUD list.
- File: `packages/web/src/pages/SettingsPage.tsx`

#### Mobile version
- EXISTS: partial. Spread across `/(admin)/more.tsx` MenuRows (`more.tsx:2105-2161`):
  - "GST Configuration" â†’ GstModal (mode + credentials).
  - "Cylinder Prices" â†’ PricesModal.
  - "Inventory Thresholds" â†’ InventoryThresholdsModal (warning/critical levels).
  - "User Management" â†’ UsersModal.
- NO: Onboarding, General (SLA hours, docCode), Subscription, Approvals, Licenses, Cylinder Types (separate from prices).
- Files: `packages/mobile/app/(admin)/more.tsx:1500-2100`

#### Gaps (web has, mobile doesn't)
- 6 of 10 Settings sub-tabs are missing from mobile: Onboarding, General, Subscription, Cylinder Types, Approvals, Licenses.
- SLA hours configuration.
- Invoice docCode setter.

---

### Distributor Admin â†’ Pending Actions

#### Web version (`packages/web/src/pages/PendingActionsPage.tsx`)
- Filters (`:128-133`): Module dropdown (all `PendingActionModule` values), Status dropdown (open/in_progress/resolved/failed/skipped).
- Grouped by module (`:141-220`).
- Per-action card: severity + status + SLA badge, description, action type + created date, resolution notes (if resolved).
- Actions per card: Approve, Reject (when `requiresApproval`), Resolve (with notes).
- Dynamic action labels per `errorCode` (Look Up IRN, Fix GSTIN, Manual Action Required, Review & Approve, Retry, Resolve) â€” `:93-100`.
- Sort: server-side.
- Export: no.
- File: `packages/web/src/pages/PendingActionsPage.tsx`

#### Mobile version
- EXISTS: no (no dedicated screen).
- Top 5 pending actions are shown on admin Dashboard (`dashboard.tsx:298-396`) read-only with severity badge + description + time-ago + meta. "View All" link goes to `/(admin)/more` rather than a PA list.

#### Gaps
- Entire dedicated Pending Actions screen with filters, grouping, Approve/Reject/Resolve actions is missing on mobile.

---

### Finance â†’ Dashboard/Analytics

#### Web version
- Same `AnalyticsPage` as admin (role-aware sections kick in for finance: Overdue Call List + Unallocated Payments + GST Failures, instead of Stock Summary + Threshold Alerts).
- File: `packages/web/src/pages/AnalyticsPage.tsx:117-152`

#### Mobile version (`packages/mobile/app/(finance)/dashboard.tsx`)
- EXISTS: partial.
- Title: "Analytics".
- Sub-tabs: Overview / Overdue Customers.
- Overview cards: Receivables (Total Due, Overdue, Collected, Unrecovered), Capital (In Market, Total Capital), Health Indicators (Shrinkage %, Delivery Efficiency %), Activity (Overdue Invoices, Pending Actions), Top Overdue list.
- Overdue Customers tab: full list sorted by overdue amount desc.

#### Gaps (web has, mobile doesn't)
- Date range filter.
- Sub-tabs: Reports, Pending Actions (web has full Reports panel + PA approval workflow).
- GST Failures card (Finance-specific on web).
- Unallocated Payments list with breakdown.

#### Mobile-only
- "Capital" section (In Market value, Total Capital).
- "Health Indicators" section (Shrinkage %, Delivery Efficiency %).
- Unrecovered amount metric.

---

### Finance â†’ Invoices (mobile-only top-level tab)

#### Web version
- Same as Distributor Admin â†’ Billing & Payments â†’ Invoices tab.

#### Mobile version (`packages/mobile/app/(finance)/invoices.tsx`)
- Status pills (`:12-18`): All / Issued / Partial / Paid / Overdue. NO Cancelled.
- Summary: Outstanding + Overdue count.
- Card fields: Invoice number, Customer, Status badge, Days overdue (when applicable), Issue/Due dates, Total/Paid/Outstanding breakdown, GST e-Invoice badge with IRN substring.
- Tap to open Invoice Detail modal.

#### Gaps (web has, mobile doesn't)
- Cancelled filter option.
- Date range pickers.
- IRN status filter.
- All actions (Record Payment, Credit Note, Debit Note, Cancel IRN/EWB, Generate GST, Regenerate Invoice) â€” Finance mobile is **read-only** for invoices; payments go through a separate Payments tab.
- Download PDF action button.

---

### Finance â†’ Payments (mobile-only top-level tab)

#### Web version
- Same as Distributor Admin â†’ Billing & Payments â†’ Payments tab.

#### Mobile version (`packages/mobile/app/(finance)/payments.tsx`)
- Screen tabs: Payments / Credit/Debit Notes.
- Payments view: summary (Total Collected, Transactions count) + list cards (method icon, customer, date, amount, method badge, reference, allocations).
- "+ Record" button â†’ RecordPaymentModal.
- Credit/Debit Notes view: simple list + "+ Create" button.

#### Gaps (web has, mobile doesn't)
- Allocation status filter.
- Detailed allocation status badges (fully/partially/unallocated).
- Allocate button on unallocated payments (web has it; mobile finance lacks).

---

### Finance â†’ Collections (mobile-only top-level tab)

(Already analysed above under Distributor Admin â†’ Collections; mobile finance Collections is dedicated screen, more featureful than admin's modal version.)

#### Gaps (web has, mobile doesn't)
- Sub-tabs: Call list, All collections, Blocked.
- Tel: phone CTA per customer.
- Excel export.
- Blocked customers with override approval.

---

### Finance â†’ Settings

#### Web version
- 4 visible tabs (Cylinder Types, Cylinder Prices, Thresholds, Licenses).

#### Mobile version
- EXISTS: no. Finance role on mobile has no Settings entry point. The (finance) `more.tsx` only shows Profile + Sign Out (`packages/mobile/app/(finance)/more.tsx:36-49`).

#### Gaps (web has, mobile doesn't)
- All 4 settings tabs missing for Finance role on mobile.

---

### Inventory â†’ Analytics / Orders / Inventory / Fleet / More

Web inventory role uses same pages as Distributor Admin (with in-page role checks). Differences from admin already noted above. Mobile inventory role has its own dedicated tabs:

#### Inventory Analytics
- Mobile: `packages/mobile/app/(inventory)/analytics.tsx` â€” single screen with KPIs + Header Metrics row + Inventory Snapshot + Recent Orders.
- NO sub-tabs (web AnalyticsPage has 4 tabs).
- NO date range filter.
- NO pending actions list.
- NO Threshold Alerts (web has this in role-aware section for inventory).

#### Inventory Orders
- Mobile: `packages/mobile/app/(inventory)/orders.tsx` â€” read-only list with status filters (All / Pending / Dispatched / Delivered).
- NO Create Order, Assign Driver, Confirm Delivery, Cancel, Edit actions on this screen (inventory role on web has these â€” admin role page is shared).
- NO Driver Assignment tab (web inventory has access to this).

#### Inventory Inventory tab
- Mobile: `packages/mobile/app/(inventory)/inventory.tsx` â€” sub-tabs **Summary / Actions / Reconciliation / Alerts** (4 tabs vs 6 on web).
- Summary tab: date nav + 2 metric cards (Closing Full, Closing Empty) + lock/unlock + per-cylinder cards.
- Actions tab: card chooser (Incoming Fulls / Outgoing Empties / Manual Adjustment) â†’ forms.
- Reconciliation tab: per-vehicle pending recon items.
- Alerts tab: threshold alerts list.
- vs Web (6 tabs): Daily Summary, Depot History, Stock at Onboarding, AI Demand Forecast, Customer Balances, Vehicle Return.

#### Gaps for inventory role mobile
- Depot History tab missing on inventory mobile inventory tab (admin mobile has it; inventory mobile doesn't).
- Stock at Onboarding missing.
- AI Demand Forecast missing on inventory mobile (admin mobile has Forecast).
- Customer Balances missing.
- Vehicle Return / structured 3-step Mismatch modal missing.

#### Inventory Fleet
- Mobile: `packages/mobile/app/(inventory)/fleet.tsx` â€” combined driver+vehicle list with status filter (All / Active / Inactive) and search. NO Vehicle Mapping management. NO Add Driver/Vehicle FAB.

#### Inventory More
- Mobile: `packages/mobile/app/(inventory)/more.tsx` â€” Profile (inline only â€” `case 'profile': break;`), Settings (no-op), Sign Out only.
- NO link to Customers, Collections, Settings, Pending Actions, Billing & Payments.

#### Gaps for inventory role (overall)
- No access on mobile to: Customers, Billing & Payments (Invoices/Payments), Collections, Pending Actions, Settings tabs (Cylinder Types/Prices/Thresholds/Licenses).
- Inventory role on web has the same nav as admin minus admin-only Settings tabs; mobile inventory navigation is much more constrained (5 tabs vs 9 sidebar items).

---

## PHASE 4 â€” Terminology Mismatches

| Concept | Web text | Web file:line | Mobile text | Mobile file:line | Same? |
|---|---|---|---|---|---|
| Order status: PENDING_DRIVER_ASSIGNMENT | "Pending Assignment" | `OrdersPage.tsx:53` | "Pending Assignment" | `(admin)/orders.tsx:138`, `(inventory)/orders.tsx:40` | YES |
| Order status: PENDING_DISPATCH | "Pending Dispatch" | `OrdersPage.tsx:54` | "Pending Dispatch" (admin) / NOT shown (inventory only shows "Dispatched" label) | `(admin)/orders.tsx:139` / `(inventory)/orders.tsx:33` | partial â€” inventory shows `pending_delivery` as "In Transit" but no specific Pending Dispatch row |
| Order status: PREFLIGHT_IN_PROGRESS | "Dispatchingâ€¦" (ellipsis char) | `OrdersPage.tsx:55` | (no mapping â€” not in mobile STATUS_LABELS) | n/a | NO |
| Order status: PENDING_DELIVERY | "Out for Delivery" | `OrdersPage.tsx:56` | "Pending Delivery" (admin) / "In Transit" (inventory) | `(admin)/orders.tsx:140` / `(inventory)/orders.tsx:42` | NO â€” three different labels for same status |
| Order status: DELIVERED | "Delivered" | `OrdersPage.tsx:57` | "Delivered" | both mobile | YES |
| Order status: MODIFIED_DELIVERED | "Modified Delivered" | `OrdersPage.tsx:58` | "Modified Delivered" (admin) / "Modified" (inventory) | `(admin)/orders.tsx:143` / `(inventory)/orders.tsx:44` | NO between mobile screens |
| Order status: CANCELLED | "Cancelled" | `OrdersPage.tsx:59` | "Cancelled" | both | YES |
| Customer status | "Active" / "Suspended" / "Inactive" | `CustomersPage.tsx:35-37` | "active" / "suspended" (lowercase, raw) | `more.tsx:585` (uses item.status directly in StatusBadge) | NO â€” casing differs |
| Invoice status: ISSUED | "issued" (raw, regex-replaced underscores) | `BillingPaymentsPage.tsx:313` (`inv.status.replace(/_/g, ' ')`) | "Issued" (capitalized) | `(admin)/finance.tsx:178-183` (`capitalizeStatus`) / "Issued" filter | NO â€” casing differs |
| Invoice status: PARTIALLY_PAID | "partially paid" | `BillingPaymentsPage.tsx:313` | "Partially Paid" (admin) / "Partial" (finance) | `(admin)/finance.tsx:96` / `(finance)/invoices.tsx:15` | NO â€” three forms |
| Invoice status: PAID | "paid" | `BillingPaymentsPage.tsx:313` | "Paid" | both mobile | NO â€” casing only |
| Invoice status: OVERDUE | "overdue" | `BillingPaymentsPage.tsx:313` | "Overdue" | both mobile | NO â€” casing only |
| Status badge: customer Supply | "Stopped" / "Active" | `CustomersPage.tsx:170-176` | "Stop Supply" button label | `more.tsx:645` | partial â€” web uses adjective ("Stopped"), mobile button uses verb ("Stop Supply") |
| Driver assigned (orders list) | "Unassigned" | `OrdersPage.tsx:312` | "Unassigned" | `(admin)/orders.tsx:464` | YES |
| Empty state â€” orders | "No orders found" | `OrdersPage.tsx:268` | "No orders found" | `(admin)/orders.tsx:742` | YES |
| Empty state â€” orders description | "Create your first order to get started." | `OrdersPage.tsx:269` | "Try a different search term" / "No orders match the selected filter" | `(admin)/orders.tsx:744` | NO â€” different copy |
| Empty state â€” customers | "No customers found" / "Add your first customer to get started." | `CustomersPage.tsx:137-138` | "No customers found" / (none) | `more.tsx:784` | partial |
| Empty state â€” pending actions | "No pending actions" / "All clear! No items require your attention." | `PendingActionsPage.tsx:138` | "All clear! No items require your attention." | `(admin)/dashboard.tsx:332` | YES (mobile uses same exact phrase, but no title) |
| Empty state â€” invoices | "No invoices found" / "Invoices will appear here once orders are delivered." | `BillingPaymentsPage.tsx:249` | "No invoices found" / "No {status} invoices" / "Invoices will appear here" | `(admin)/finance.tsx:760-765` | partial |
| Empty state â€” payments | "No payments found" (not shown above but in PaymentsTab) | n/a | "No payments recorded" | `(admin)/finance.tsx:1526` | NO |
| Empty state â€” depot history | "No depot history" / "No incoming fulls or outgoing empties transactions found." | `InventoryPage.tsx:428` | "No depot history" / "No incoming/outgoing transactions found" | `(admin)/inventory.tsx:1469-1471` | partial |
| Empty state â€” forecast | "No forecast data" | `InventoryPage.tsx:528` | "No forecast data" / "Forecasts will appear once enough data is collected" | `(admin)/inventory.tsx:1673` | partial |
| Empty state â€” Vehicle Return | "No vehicles pending" / "All returned vehicles have been reconciled" | `InventoryPage.tsx:586-587` | (mobile reconcile uses different copy in inventory mobile screens) | `(admin)/inventory.tsx` reconcile tab | NO confirmed equality |
| Button: New Order | "New Order" | `OrdersPage.tsx:193` | (FAB icon â€” no label) | `(admin)/orders.tsx:751-758` | NO â€” text vs icon |
| Button: Create Order modal submit | "Create Order" | `OrdersPage.tsx:601` | "Create Order" | `(admin)/orders.tsx:1145` | YES |
| Button: Returns Order | "Returns Order" | `OrdersPage.tsx:188` | (not present on mobile) | n/a | mobile missing |
| Button: Assign Driver | "Assign" (modal submit) / "Assign Driver" (action button title) | `OrdersPage.tsx:937, 332` | "Assign Driver" (button) / "Assign Driver" (modal title) | `(admin)/orders.tsx:515, 1202` | YES |
| Button: Confirm Delivery | "Confirm Delivery" / "Confirm Return" | `OrdersPage.tsx:1104-1106` | "Confirm Delivery" | `(admin)/orders.tsx:1540` | partial â€” mobile doesn't differentiate return vs delivery |
| Button: Cancel Order | "Cancel Order" (modal) / "Go Back" | `OrdersPage.tsx:1296, 1303` | "Cancel" (button) / Alert dialog "No" + "Yes, Cancel" | `(admin)/orders.tsx:533, 336-341` | NO â€” different UX/wording |
| Cancellation message | "This will cancel the order. No invoice has been generated yet. This cannot be undone." | `OrdersPage.tsx:1276-1278` | "Are you sure you want to cancel order {orderNumber}?" | `(admin)/orders.tsx:333` | NO â€” completely different copy |
| Section header: "Ready to Dispatch" | (implied via grouping, no explicit header in web Driver Assignment section header observed in snippet) | `OrdersPage.tsx:1426-1455` | "Ready to Dispatch" | `(admin)/orders.tsx:651` | both present, partial |
| Section header: "In Transit" | (implied) | `OrdersPage.tsx:1370-1378` | "In Transit" | `(admin)/orders.tsx:699` | YES |
| Inventory action: Lock Day | "Lock Day" | `InventoryPage.tsx:343` | "Lock Inventory" (alert title) | `(admin)/inventory.tsx:414`, `(inventory)/inventory.tsx:156` | NO â€” Day vs Inventory |
| Inventory action: Unlock Day | "Unlock Day" | `InventoryPage.tsx:325` | "Unlock Inventory" (alert title) | `(admin)/inventory.tsx:408`, `(inventory)/inventory.tsx:163` | NO |
| Inventory header: Lock confirmation copy | "Lock inventory for {date}? All summaries for this day will be frozen and can only be changed after an admin unlocks the day." | `InventoryPage.tsx:336-337` | "Lock inventory for {date}? This prevents further edits." | `(admin)/inventory.tsx:415` | NO â€” different copy |
| Inventory column group | "CORPORATION" / "OPENING" / "ON VEHICLE" / "AT CUSTOMER" / "ADJUSTMENTS" / "CLOSING" | `InventoryPage.tsx:671` | "Opening Fulls" / "Incoming" / "Delivered" / "Cancelled" / "Outgoing Empties" / "Collected Empties" labels per-card | `(admin)/inventory.tsx:728-766` | NO â€” different taxonomy |
| Customer detail label | "Credit Period" | `CustomersPage.tsx:151` | "Credit Period" | `more.tsx:613` | YES |
| Customer Type | "Type" (column header) | `CustomersPage.tsx:149` | "Customer Type" (form label) | `more.tsx:676` | partial |
| Settings page tabs label "Cylinder Types" | "Cylinder Types" | `SettingsPage.tsx:68` | n/a (not present on mobile) | n/a | mobile missing |
| Settings tab: "Cylinder Prices" | "Cylinder Prices" | `SettingsPage.tsx:69` | "Cylinder Prices" | `more.tsx:2115` | YES |
| Settings tab: "Thresholds" | "Thresholds" | `SettingsPage.tsx:70` | "Inventory Thresholds" | `more.tsx:2117` | NO â€” Web omits "Inventory" prefix |
| Settings tab: GST | "GST" | `SettingsPage.tsx:67` | "GST Configuration" | `more.tsx:2113` | NO â€” Web shorter |
| Settings tab: Users | "Users" | `SettingsPage.tsx:72` | "User Management" | `more.tsx:2119` | NO |
| Collections "Call list" view | "Call list" | `CollectionsPage.tsx:122` | (not present on admin mobile; finance mobile Collections is single list, no Call list tab) | n/a | NO |
| Collections summary card | "Total Due" / "Total Overdue" / "Missing Cylinders" | `CollectionsPage.tsx:99-108` | "Total Collected" / "Pending" / "Collection Rate" / "Overdue" (admin More modal) | `more.tsx:1162-1188` | NO â€” different metric set |
| Collections (finance mobile) summary | n/a | n/a | "Total Receivable" / "Overdue" / "Missing Cylinder Value" / "Customers" | `(finance)/collections.tsx:29-43` | NO |
| Days overdue label | "{n}d overdue" | `CollectionsPage.tsx:172` | "{n}d overdue" | `(finance)/dashboard.tsx:163` (top overdue card) | YES |
| GST badges | "IRN" / "EWB" (single-word badges) | `BillingPaymentsPage.tsx:323-325` | "GST e-Invoice" (single combined badge) | `(finance)/invoices.tsx:104` | NO |
| Tab label: Analytics dashboard | "Dashboard" | `AnalyticsPage.tsx:225` | "Dashboard" (admin) / "Analytics" (finance/inventory tab title) | `(admin)/_layout.tsx:53` / `(finance)/_layout.tsx:14` / `(inventory)/_layout.tsx:25` | NO across roles |
| Tab label: Billing & Payments | "Billing & Payments" (sidebar) | `Sidebar.tsx:86` | "Billing" (admin tab) / "Invoices" + "Payments" (finance separate tabs) | `(admin)/_layout.tsx:65` / `(finance)/_layout.tsx:15-16` | NO |
| Pagination "Previous" / "Next" | "Previous" / "Next" | `OrdersPage.tsx:385,387` | (no pagination on mobile â€” list-based) | n/a | mobile lacks |
| Sign out confirmation | (not surveyed on web sidebar logout â€” appears to be direct logout) | `Sidebar.tsx:220-226` | "Logout" / "Are you sure you want to sign out?" / "Cancel" + "Sign Out" | `(finance)/more.tsx:23-33`, `(inventory)/more.tsx:33-37` | NO â€” mobile confirms, web doesn't |

---

## SUMMARY TABLES

### Distributor Admin
| Web page | Mobile equivalent | Status |
|---|---|---|
| /app/analytics â€” Dashboard tab | /(admin)/dashboard | Partial (KPIs different, no role-aware sections, no PA actions) |
| /app/analytics â€” Overview tab | /(admin)/more â†’ Overview modal | Partial |
| /app/analytics â€” Reports tab | /(admin)/more â†’ Reports modal | Partial |
| /app/analytics â€” Pending Actions tab | (top-5 on dashboard read-only) | Missing (no full list, no actions) |
| /app/orders â€” Orders tab | /(admin)/orders | Partial (no date filter, no Edit, no Returns, no Order Detail view modal) |
| /app/orders â€” Driver Assignment tab | (split across /(admin)/orders header sections) | Partial |
| /app/inventory â€” Daily Summary | /(admin)/inventory â†’ Summary | Partial (no grouped columns, no Columns picker) |
| /app/inventory â€” Depot History | /(admin)/inventory â†’ History | Partial (fewer columns) |
| /app/inventory â€” Stock at Onboarding | n/a | Missing |
| /app/inventory â€” AI Demand Forecast | /(admin)/inventory â†’ Forecast | Full |
| /app/inventory â€” Customer Balances | /(admin)/inventory â†’ Balances | Full |
| /app/inventory â€” Vehicle Return | /(admin)/inventory â†’ Reconcile | Partial (no Mismatch Log section) |
| /app/customers | /(admin)/more â†’ Customers modal | Partial (no edit, no status filter, no full detail; buried in More) |
| /app/billing-payments â€” Invoices | /(admin)/finance â†’ Invoices | Partial (no IRN filter, no date filter, no Cancel IRN/EWB, no Regenerate) |
| /app/billing-payments â€” Payments | /(admin)/finance â†’ Payments | Partial (no allocation filter) |
| /app/collections | /(admin)/more â†’ Collections modal | Partial (no call list/blocked/export) |
| /app/fleet â€” Drivers | /(admin)/more â†’ Fleet â†’ Drivers | Partial (no edit) |
| /app/fleet â€” Vehicles | /(admin)/more â†’ Fleet â†’ Vehicles | Partial (no edit) |
| /app/fleet â€” Vehicle Mapping | /(admin)/more â†’ Fleet â†’ Assignments | Partial (read-only, no Bulk Confirm, no inline edit) |
| /app/settings â€” Onboarding | n/a | Missing |
| /app/settings â€” General | n/a | Missing |
| /app/settings â€” Subscription | n/a | Missing |
| /app/settings â€” GST | /(admin)/more â†’ GST Configuration | Partial |
| /app/settings â€” Cylinder Types | n/a | Missing |
| /app/settings â€” Cylinder Prices | /(admin)/more â†’ Cylinder Prices | Full |
| /app/settings â€” Thresholds | /(admin)/more â†’ Inventory Thresholds | Partial (read-only?) |
| /app/settings â€” Approvals | n/a | Missing |
| /app/settings â€” Users | /(admin)/more â†’ User Management | Partial |
| /app/settings â€” Licenses | n/a | Missing |
| /app/pending-actions (standalone) | n/a | Missing |

### Finance
| Web page | Mobile equivalent | Status |
|---|---|---|
| /app/analytics â€” Dashboard | /(finance)/dashboard â†’ Overview | Partial (different metrics, mobile-only Capital + Health sections) |
| /app/analytics â€” Overview | n/a | Missing |
| /app/analytics â€” Reports | n/a | Missing |
| /app/analytics â€” Pending Actions | n/a | Missing |
| /app/orders | n/a | Missing (Finance has no orders entry point on mobile) |
| /app/inventory | n/a | Missing |
| /app/customers | n/a | Missing |
| /app/billing-payments â€” Invoices | /(finance)/invoices | Partial (read-only; no actions; no IRN/date filters) |
| /app/billing-payments â€” Payments | /(finance)/payments | Partial (no allocation filter) |
| /app/collections | /(finance)/collections | Partial (no call list/blocked/export) |
| /app/fleet | n/a | Missing |
| /app/settings (4 tabs) | n/a | Missing (finance more.tsx has only Profile + Sign Out) |
| /app/pending-actions | n/a | Missing |

### Inventory
| Web page | Mobile equivalent | Status |
|---|---|---|
| /app/analytics â€” Dashboard | /(inventory)/analytics | Partial (no role-aware Threshold Alerts panel, no PA approvals) |
| /app/analytics â€” Overview / Reports / Pending Actions | n/a | Missing |
| /app/orders | /(inventory)/orders | Partial (read-only; no create/assign/deliver/cancel) |
| /app/inventory â€” Daily Summary | /(inventory)/inventory â†’ Summary | Partial |
| /app/inventory â€” Depot History | n/a (inventory mobile doesn't expose it; admin mobile has it) | Missing for inventory role |
| /app/inventory â€” Stock at Onboarding | n/a | Missing |
| /app/inventory â€” AI Demand Forecast | n/a (inventory mobile inventory tab has 4 sub-tabs: Summary/Actions/Reconciliation/Alerts only) | Missing |
| /app/inventory â€” Customer Balances | n/a | Missing |
| /app/inventory â€” Vehicle Return | /(inventory)/inventory â†’ Reconciliation | Partial |
| /app/customers | n/a | Missing |
| /app/billing-payments | n/a | Missing |
| /app/collections | n/a | Missing |
| /app/fleet | /(inventory)/fleet | Partial (driver list only, no Vehicle Mapping, no Add) |
| /app/settings (4 tabs) | n/a | Missing |
| /app/pending-actions | n/a | Missing |

### Total Gap Count

| Role | Full match | Partial | Missing |
|---|---|---|---|
| Distributor Admin | 2 (Forecast, Customer Balances, Cylinder Prices) â€” call it 3 | 18 | 9 |
| Finance | 0 | 4 | 9 |
| Inventory | 0 | 5 | 10 |

---

## Key cross-cutting observations (for product decisions)

1. **Inventory role lands on a hidden screen at login** â€” `index.tsx:33` sends inventory users to `/(inventory)/summary`, which is marked `href:null` in the tab layout (`(inventory)/_layout.tsx:57`). Likely either a stale routing decision or the visible tab should be `analytics`/`inventory` instead.

2. **Finance role on mobile has no Customers, no Orders, no Settings, no Fleet** â€” web exposes these (read-only for customers). The (finance)/more.tsx file only contains Profile + Sign Out. This is a significant role-coverage gap.

3. **Pending Actions is completely missing on mobile** â€” admin sees top 5 read-only; finance/inventory don't see any. No Approve/Reject/Resolve actions on mobile.

4. **Settings is essentially absent on mobile** â€” admin gets 4 of 10 sub-tabs as modals in More; finance/inventory get nothing.

5. **Driver Assignment (web's dedicated tab on Orders) is split awkwardly on mobile** â€” admin mobile shows In Transit footer + Ready to Dispatch header within the Orders list rather than as a dedicated workflow tab.

6. **Vehicle Mapping is read-only on mobile** â€” web allows daily driverâ†”vehicle mapping editing (a core morning workflow); mobile only lists existing assignments.

7. **Inventory daily summary uses fundamentally different layouts** â€” web has a 12-column grouped table (Corporation/Opening/On Vehicle/At Customer/Adjustments/Closing); mobile has 6 simple metric cells per cylinder card. Terminology and grouping differ.

8. **Order status label inconsistencies** â€” `PENDING_DELIVERY` is "Out for Delivery" on web, "Pending Delivery" on admin mobile, "In Transit" on inventory mobile (three labels for one status). Also `PREFLIGHT_IN_PROGRESS` is "Dispatchingâ€¦" on web with no mobile mapping. `MODIFIED_DELIVERED` is "Modified Delivered" on admin mobile, "Modified" on inventory mobile.

9. **Invoice/customer status casing differs across web/mobile** â€” web does `status.replace(/_/g, ' ')` (lowercase); mobile uses `capitalizeStatus` (title case).

10. **Web sidebar items in Collections lack i18n** â€” "Collections" has no `labelKey` (Sidebar.tsx:100-110), while every other admin item does â€” minor i18n debt.
