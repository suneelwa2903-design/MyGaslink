# i18n Extraction Protocol (WI-008)

**Living document** — update as the rollout progresses.

## Per-page extraction recipe

Follow these steps for every page you migrate. Aim for one PR (or one commit) per page so reviews stay focused.

### 1. Read the file
List every user-visible English string. **What counts:** headings, labels, placeholders, button text, toast messages, modal titles, table column headers, empty-state copy, error messages.

**What does NOT need extraction:**
- Server-driven content (`order.orderNumber`, `customer.customerName`)
- Industry/regulatory short forms (GST, IRN, EWB, HSN, GSTIN, UPI) — keep in Latin/English script per locale convention
- Dummy decorative content (e.g. LoginPage's rotating stat cards) — flag for a later pass if needed

### 2. Pick a namespace

| Page area | Namespace |
|---|---|
| Auth flow (login, forgot password, force reset) | `auth.*` |
| Customer portal pages | `customerPortal.<page>.*` (e.g. `customerPortal.invoices`) |
| Admin pages | `admin.<page>.*` (e.g. `admin.orders`) |
| Truly shared atoms | `common.*` (save/cancel/delete/etc.) |
| Schema-driven enum values | `enums.<enumName>.*` |

### 3. Add EN keys to `packages/web/src/locales/en/common.json`
Use nested objects for clarity. Use `{{var}}` for interpolation (i18next syntax). Keep existing key shapes — no orphan top-level strings.

### 4. Add TE keys to `packages/web/src/locales/te/common.json`
Telugu script throughout, except:
- Industry terms (GST, IRN, EWB, HSN, GSTIN, UPI) — keep English
- Standard short forms (CGST, SGST, IGST, B2B, B2C) — keep English
- Email addresses, URLs, dates: format-only, no translation

Tone: respectful + plain (`మీ <noun>`), avoid colloquialism. Toasts can be slightly warmer ("తిరిగి స్వాగతం" for "Welcome back").

### 5. Refactor the component
- `import { useTranslation } from 'react-i18next';`
- `const { t } = useTranslation();`
- Replace strings with `t('namespace.key')` or `t('namespace.key', { var: value })`
- For schema enum values (status, etc.), use `t(\`enums.<enum>.${value}\`, value.replace(/_/g, ' '))` — second arg is the fallback if the enum value ever drifts and a key is missing.

### 6. Verify
```bash
pnpm --filter @gaslink/web run typecheck     # must be 0 errors
node -e "JSON.parse(require('fs').readFileSync('packages/web/src/locales/en/common.json'))"
node -e "JSON.parse(require('fs').readFileSync('packages/web/src/locales/te/common.json'))"
pnpm --filter @gaslink/api run test           # must remain 254/254
```

### 7. Commit
Commit message format:
```
feat(i18n): extract <PageName> (<sections>)

WI-008 progress — page X of Y this session.

Strings translated:
- ...

New enum namespaces (if any):
- ...

Web typecheck clean. JSON validated.

Refs: WI-008
```

## Page priority order (traffic-driven)

| # | Page | Status | Strings | Namespace |
|---|---|---|---|---|
| 1 | `LoginPage` | ✅ done (e3b480d) | ~12 | `auth.*` |
| 2 | `customer/DashboardPage` | ✅ done (288d287) | ~11 + enums | `customerPortal.dashboard.*` + `enums.orderStatus.*` + `enums.invoiceStatus.*` |
| 3 | `customer/OrdersPage` | ✅ done (4b50f18) | ~30 | `customerPortal.orders.*` |
| 4 | `customer/InvoicesPage` | ✅ done (97b64c2) | ~25 | `customerPortal.invoices.*` |
| 5 | `customer/PaymentsPage` | ✅ done (86ed73c) | ~20 + enums | `customerPortal.payments.*` + `enums.paymentMethod.*` + `enums.paymentAllocationStatus.*` |
| 6 | `customer/AccountPage` | pending | ~25 | `customerPortal.account.*` |
| 7 | `AnalyticsPage` (admin dashboard) | pending | ~40 | `admin.analytics.*` + reuse `dashboard.*` |
| 8 | `OrdersPage` (admin) | pending | ~80 | `admin.orders.*` (reuse `enums.orderStatus.*`) |
| 9 | `CustomersPage` | pending | ~50 | `admin.customers.*` |
| 10 | `InventoryPage` | pending | ~60 | `admin.inventory.*` |
| 11 | `BillingPaymentsPage` | pending | ~50 | `admin.billing.*` |
| 12 | `InvoicesPage` (admin) | pending | ~40 | `admin.invoices.*` (reuse `enums.invoiceStatus.*`) |
| 13 | `FleetPage` | pending | ~30 | `admin.fleet.*` |
| 14 | `CollectionsPage` | pending | ~40 | `admin.collections.*` |
| 15 | `AssignmentsPage` | pending | ~50 | `admin.assignments.*` |
| 16 | `ReconciliationPage` | pending | ~40 | `admin.reconciliation.*` |
| 17 | `PaymentsPage` (admin) | pending | ~30 | `admin.payments.*` |
| 18 | `SettingsPage` | pending | ~60 | `admin.settings.*` |
| 19 | `DistributorsPage` (super admin) | pending | ~40 | `admin.distributors.*` |
| 20 | `DistributorDetailPage` (super admin) | pending | ~70 | `admin.distributorDetail.*` |
| 21 | `LandingPage` | pending | ~60 | `landing.*` |
| 22 | `PendingActionsPage` | pending | ~30 | `admin.pendingActions.*` |
| 23 | `ProviderCatalogPage` | pending | ~35 | `admin.providerCatalog.*` |
| 24 | `HealthMonitoringPage` | pending | ~40 | `admin.health.*` |
| 25 | `DriversVehiclesPage` | pending | ~50 | `admin.driversVehicles.*` |
| 26 | `BillingSuspendedPage` | pending | ~10 | `admin.billingSuspended.*` |
| 27 | `ForcePasswordResetPage` | pending | ~15 | `auth.*` (extend) |
| 28 | `NotFoundPage` | pending | ~5 | `errors.notFound.*` |

Plus **11 components** (DashboardLayout, Sidebar already partial, DistributorSelector, ThemeToggle, ErrorBoundary done, LanguageSwitcher done, ProtectedRoute, plus 7 in `components/ui/`).

## Mobile

Not started. When picked up:
- Install `react-i18next`, `i18next`, `expo-localization`, `i18next-react-native-language-detector` in `packages/mobile`
- Mirror `src/lib/i18n.ts` setup from web
- Replicate locale JSONs (or share them via a workspace package, but JSON-as-resource is simpler)
- Add language switcher to Settings/Profile screen
- Extract per route file (55 routes) using the same protocol

## Notable decisions made

1. **Pagination strings duplicated per namespace** (`customerPortal.orders.pageOf` etc.) instead of a shared `common.pagination.*`. Refactor to shared once 5+ pages need it; the cost of a search-and-replace later is low.
2. **Status enum values** live under `enums.<enumName>.<value>`. Use `value` as the lookup key (matches the API serialization) and the previous `.replace(/_/g, ' ')` humanisation as the fallback.
3. **Industry terms** (GST/IRN/EWB/HSN/GSTIN/UPI/CGST/SGST/IGST/B2B/B2C) stay in English. Operators using the app expect them in this form.
4. **The decorative rotating stat cards on LoginPage** — 16 stylized demos with English copy ("Orders Today", "Active Drivers", etc.) — were intentionally NOT translated. They're marketing dummy content shown to logged-out visitors and add little value translated. Flag for a later pass if Telugu market feedback says otherwise.
5. **Native-speaker review.** All translations in this rollout are produced from documented Telugu spelling and tone conventions. **Before launch, a native speaker should review the entire `te/common.json` file** for register, regional variants, and consistency. Strings most likely to need adjustment: verbs of action (extract, submit, confirm), formal address, and any compound noun phrases.

## Estimate

| Slice | Effort |
|---|---|
| Web pages 6–28 (23 pages) | ~16-20 hours |
| Web components (5 remaining out of 11) | ~2-3 hours |
| Mobile setup + 55 routes + 7 components | ~14-18 hours |
| Native-speaker review pass | ~4-6 hours (separate) |
| **Total to fully complete WI-008** | **~36-47 hours** of focused work |

5 pages done in this session represents roughly 12% of the web page count (5/28) and ~10% of total estimated effort.
