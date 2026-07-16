# GROUPING-PREREQ.md — Customer Group Portal (Feature A) — Ground-Truth Prerequisite Research

**Status:** READ-ONLY research pass. No code or DB changes made.
**Baseline:** `main @ e1d7d13` (`test(scenario): Phase 2+3 end-to-end scenarios — 7/7 PASS`)
**Monorepo layout confirmed:** `packages/api`, `packages/web`, `packages/mobile`, `packages/shared` (not `apps/*`).
**Context documents read first:** `docs/FEATURE-INVESTIGATION.md` §A (baseline `main @ a54d6c8`) and `docs/HQ-PORTAL-BRAINSTORM.md` (baseline `main @ 7e73768`). Both predate a set of Proof-of-Collection (Feature B) changes that have since landed on `main` — noted inline below where the codebase has moved since those docs were written. **`CustomerGroup`/`CustomerGroupMember`/`customer_hq`/`groupId` do NOT exist anywhere in the codebase at this commit** (confirmed via grep across `packages/api/prisma/schema.prisma` — zero matches) — Feature A itself has not been started; only Feature B (delivery proof) has landed since the brainstorm doc.

---

## P1 — Current auth model

### `User` model — verbatim (`packages/api/prisma/schema.prisma:504-559`)

```prisma
model User {
  id                    String             @id @default(uuid()) @map("user_id")
  email                 String             @unique
  passwordHash          String             @map("password_hash")
  firstName             String             @map("first_name")
  lastName              String             @map("last_name")
  phone                 String?
  role                  UserRole
  status                UserStatus         @default(active)
  provisioningStatus    ProvisioningStatus @default(active) @map("provisioning_status")
  distributorId         String?            @map("distributor_id")
  customerId            String?            @map("customer_id")
  requiresPasswordReset Boolean            @default(true) @map("requires_password_reset")
  refreshToken          String?            @map("refresh_token")
  lastLoginAt           DateTime?          @map("last_login_at")
  loginAttempts         Int                @default(0) @map("login_attempts")
  lockedUntil           DateTime?          @map("locked_until")
  resetOtp              String?            @map("reset_otp")
  resetOtpExpiresAt     DateTime?          @map("reset_otp_expires_at")
  createdAt             DateTime           @default(now()) @map("created_at")
  updatedAt             DateTime           @updatedAt @map("updated_at")
  deletedAt             DateTime?          @map("deleted_at")

  // Relations
  distributor           Distributor?       @relation(fields: [distributorId], references: [id])
  customer              Customer?          @relation(fields: [customerId], references: [id])
  driverProfile         Driver?            @relation("DriverUser")
  auditLogs             AuditLog[]
  driverAssignments     DriverAssignment[] @relation("AssignedBy")
  cancelledGstDocuments GstDocument[]      @relation("CancelledGstDocuments")
  loginHistory          LoginHistory[]
  manifestsConfirmed    DVALoadManifest[]  @relation("ManifestConfirmedBy")
  paymentSubmissionsSubmitted PaymentSubmission[] @relation("SubmittedByUser")
  paymentSubmissionsVerified  PaymentSubmission[] @relation("VerifiedByUser")
  accountDeletionRequest AccountDeletionRequest?
  refreshTokenSessions RefreshTokenSession[]

  @@index([email])
  @@index([distributorId])
  @@index([role, status])
  @@map("users")
}
```

Note: `Customer` model FK relation for `requireDeliveryVerification` (Proof-of-Collection Phase 1, landed since the brainstorm doc) now exists on `Customer`, not `User` — see P6.

### `UserRole` enum — every value

Prisma (`packages/api/prisma/schema.prisma:14-21`):
```prisma
enum UserRole {
  super_admin
  distributor_admin
  finance
  inventory
  driver
  customer
}
```

Mirrored in `packages/shared/src/enums/index.ts:3-10`:
```ts
export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  DISTRIBUTOR_ADMIN = 'distributor_admin',
  FINANCE = 'finance',
  INVENTORY = 'inventory',
  DRIVER = 'driver',
  CUSTOMER = 'customer',
}
```
**Six values, identical in both files, in lockstep.** No `customer_hq` value exists yet in either location — confirmed by direct grep, zero hits for `customer_hq` in the whole repo.

### `JwtPayload` — verbatim (`packages/shared/src/types/index.ts:43-49`)

```ts
export interface JwtPayload {
  userId: string;
  email: string;
  role: UserRole;
  distributorId: string | null;
  customerId: string | null;
}
```
No `groupId` field exists yet.

### `generateTokens()` — `packages/api/src/services/authService.ts:65-81`

```ts
export function generateTokens(payload: JwtPayload): AuthTokens {
  const accessToken = jwt.sign(payload, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessExpiresIn,
  });
  const refreshToken = jwt.sign(
    { ...payload, jti: randomUUID() },
    config.jwt.refreshSecret,
    { expiresIn: config.jwt.refreshExpiresIn },
  );
  return { accessToken, refreshToken };
}
```
The `JwtPayload` fields that go into both tokens are exactly the five on the interface: `userId, email, role, distributorId, customerId` (refresh token additionally carries a `jti`). Two call sites construct this literal payload — `login()` at `authService.ts:235-241` and `refreshTokens()` at `authService.ts:309-315` — both must be updated in the same commit if `groupId` is added (matches the FEATURE-INVESTIGATION.md §A3 regression-prone-modules list, item 4).

### `authenticate()` middleware — verbatim (`packages/api/src/middleware/auth.ts:41-113`)

```ts
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return sendUnauthorized(res, 'Missing or invalid authorization header');
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret) as JwtPayload;
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true, status: true, role: true, distributorId: true, customerId: true,
        accountDeletionRequest: {
          select: { id: true, status: true, scheduledCompletionAt: true },
        },
      },
    });
    if (!user || user.status !== 'active') {
      return sendUnauthorized(res, 'User account is inactive or not found');
    }
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      role: decoded.role,
      distributorId: decoded.distributorId,
      customerId: decoded.customerId,
    };
    // M14 v1.0 (spec §5.1): pending-deletion gate. Only cancel + status
    // + logout are reachable. Everything else gets 403 with the special
    // `account_pending_deletion` code...
    if (user.accountDeletionRequest && user.accountDeletionRequest.status === 'pending') {
      const path = req.originalUrl.split('?')[0];
      const method = req.method;
      const ALLOWED: Array<{ method: string; path: string }> = [
        { method: 'POST', path: '/api/users/me/deletion-request/cancel' },
        { method: 'GET', path: '/api/users/me/deletion-request' },
        { method: 'POST', path: '/api/auth/logout' },
      ];
      const allowed = ALLOWED.some((e) => e.method === method && e.path === path);
      if (!allowed) {
        return res.status(403).json({
          success: false, data: null, error: 'account_pending_deletion',
          code: 'ACCOUNT_PENDING_DELETION',
          context: { scheduledCompletionAt: user.accountDeletionRequest.scheduledCompletionAt },
        });
      }
    }
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) return sendUnauthorized(res, 'Token expired');
    return sendUnauthorized(res, 'Invalid token');
  }
}
```

**`req.user` is reconstructed from a fresh DB row on every request, NOT blindly trusted from the JWT** — `role`, `distributorId`, `customerId` come from `decoded` (the verified JWT), but the *existence/active-status* gate re-queries `prisma.user.findUnique`. This is the "resolve from DB per request" precedent both investigation docs cite as the pattern a group's visible-customerId set should follow (a per-request `CustomerGroupMember` lookup, not a JWT-embedded list).

Note the `ALLOWED` array pattern at lines 87-91 is a **method+path allowlist for the pending-deletion gate specifically** — it is not a generic "reject non-GET" utility function; a new "GET-only" guard for `/api/customer-group-portal` would need its own small middleware modeled on this shape, not a reuse of this exact array.

### `requireRole()` — verbatim (`packages/api/src/middleware/auth.ts:118-135`)

```ts
export function requireRole(...allowedRoles: (UserRole | string)[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return sendUnauthorized(res);
    }
    // Super admin bypasses role checks
    if (req.user.role === 'super_admin') {
      return next();
    }
    if (!allowedRoles.includes(req.user.role as UserRole)) {
      return sendForbidden(res, `Role '${req.user.role}' does not have access to this resource`);
    }
    next();
  };
}
```
**Exact-match via `.includes()`** — a route gated `requireRole('customer')` will correctly reject a hypothetical `customer_hq` role (not a substring/prefix match), confirming FEATURE-INVESTIGATION.md's claim that `customerPortal.ts` "won't break" if left untouched. Note `super_admin` bypasses every `requireRole()` check unconditionally — relevant if a group router should NOT be super-admin-accessible without an explicit distributor context (it would need `resolveDistributor`/`requireDistributor` chained too, matching the pattern already used elsewhere, e.g. `orders`, `customers` routes).

---

## P2 — Current customer portal auth

### `packages/api/src/routes/customerPortal.ts` (827 lines, mounted at `/api/customer-portal`)

**Every `requireRole()` call in the file:** every single route — all 22 — calls `requireRole('customer')` (lines 32, 53, 78, 96, 132, 165, 194, 217, 242, 266, 286, 313, 382, 410, 429, 449, 466, 484, 513, 578, 680, 796). No route in this file accepts any other role.

**Full route list (method + path + purpose):**

| # | Method | Path | Purpose | Line |
|---|---|---|---|---|
| 1 | GET | `/dashboard` | Dashboard stats (outstanding/overdue/orders/empties) | 31 |
| 2 | GET | `/orders` | Paginated order list | 52 |
| 3 | GET | `/orders/:id` | Single order detail | 77 |
| 4 | POST | `/orders` | Create new order (write) | 95 |
| 5 | PATCH | `/orders/:id/cancel` | Self-cancel pre-dispatch order (write) | 131 |
| 6 | PATCH | `/orders/:id` | Modify quantities/delivery date of pending order (write) | 164 |
| 7 | POST | `/orders/:id/dispute` | Raise a delivery dispute (write) | 193 |
| 8 | GET | `/invoices` | Paginated invoice list | 216 |
| 9 | GET | `/invoices/with-gst` | Invoices with GST document details | 241 |
| 10 | GET | `/invoices/download-summary` | Bulk-download metadata summary | 265 |
| 11 | GET | `/invoices/:id` | Invoice detail, customer-shaped | 285 |
| 12 | GET | `/invoices/:id/pdf` | Invoice PDF download | 312 |
| 13 | GET | `/payments` | Paginated payment list | 381 |
| 14 | GET | `/payments/my-submissions` | Self-reported payment submissions | 409 |
| 15 | GET | `/payments/:id` | Single payment detail | 428 |
| 16 | GET | `/balance` | Cylinder balance / empties | 448 |
| 17 | GET | `/account` | Account/profile info | 465 |
| 18 | PUT | `/account` | Update limited profile fields (write) | 483 |
| 19 | GET | `/distributor` | Distributor contact info | 512 |
| 20 | POST | `/invoices/:id/create-payment-order` | Razorpay order creation (write, money) | 576 |
| 21 | POST | `/invoices/:id/verify-payment` | Razorpay payment verification (write, money) | 678 |
| 22 | POST | `/payments/submit` | Self-report an off-portal payment (write) | 794 |

**GET routes (14, all safe to re-expose to a read-only HQ router):** #1,2,3,8,9,10,11,12,13,14,15,16,17,19.
**Write routes (8, must NOT be re-exposed):** #4,5,6,7,18,20,21,22.

**Razorpay usage — exact line numbers:**
- Comment block explaining the per-distributor-credentials model: lines 523-541.
- `getDistributorRazorpayCreds()` helper: lines 557-566 (reads `distributor.razorpayEnabled/razorpayKeyId/razorpayKeySecret`).
- `POST /invoices/:id/create-payment-order` handler: lines 576-668.
- `POST /invoices/:id/verify-payment` handler: lines 678-772 (calls `paymentService.createPayment` at line 746).

**How `customerId` is resolved from `req.user`:** every single handler does the identical two-step pattern — `if (!req.user!.customerId) return sendError(res, 'No customer linked to this account', 400);` followed by passing `req.user!.customerId` (and `req.user!.distributorId!`) as **explicit function parameters** into the service layer. `customerId` is never read out of `req.body`/`req.query`/`req.params` for scoping purposes — this is the exact architectural fact FEATURE-INVESTIGATION.md §A2 relies on ("the entire read surface can be reused verbatim, per-customer, by a group router").

### `packages/api/src/services/customerPortalService.ts` (888 lines)

**`getMyOrders` signature + full WHERE clause, verbatim** (lines 162-183):
```ts
export async function getMyOrders(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number; from?: string; to?: string }
) {
  const where: Prisma.OrderWhereInput = { customerId, distributorId, deletedAt: null };
  if (filters.status) {
    const statuses = filters.status.split(',').map((s) => s.trim()).filter(Boolean) as $Enums.OrderStatus[];
    where.status = statuses.length > 1 ? { in: statuses } : statuses[0];
  }
  if (filters.from || filters.to) {
    where.deliveryDate = {};
    if (filters.from) where.deliveryDate.gte = new Date(filters.from);
    if (filters.to) { const toEnd = new Date(filters.to); toEnd.setHours(23,59,59,999); where.deliveryDate.lte = toEnd; }
  }
```
Note: since the brainstorm doc was written, this function's `include` now also pulls `deliveryProof: { select: { otpCode, otpVerifiedAt } }` and `customer: { select: { requireDeliveryVerification } }` (lines 199-200) to support the newly-landed Proof-of-Collection OTP feature — an incidental but real change to this function's shape since the brainstorm doc's snapshot.

**`getMyInvoices` signature + full WHERE clause, verbatim** (lines 510-528):
```ts
export async function getMyInvoices(
  distributorId: string,
  customerId: string,
  filters: { status?: string; page?: number; pageSize?: number; from?: string; to?: string }
) {
  const where: Prisma.InvoiceWhereInput = {
    customerId, distributorId, deletedAt: null, isGaslinkBilling: false,
    OR: INVOICE_VISIBILITY_OR,
  };
  if (filters.status) where.status = filters.status as $Enums.InvoiceStatus;
  if (filters.from || filters.to) {
    where.issueDate = {};
    if (filters.from) where.issueDate.gte = new Date(filters.from);
    if (filters.to) { const toEnd = new Date(filters.to); toEnd.setHours(23,59,59,999); where.issueDate.lte = toEnd; }
  }
```
`INVOICE_VISIBILITY_OR` (lines 500-508) hides invoices whose linked order is still `pending_driver_assignment`/`pending_dispatch`/`pending_delivery` — this business rule must be preserved unchanged for any group view.

**`getCustomerLedger`** actually lives in `paymentService.ts` (confirmed) — signature (lines 398-402):
```ts
export async function getCustomerLedger(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedgerResponse>
```

**`getMyPayments` signature** (lines 604-608):
```ts
export async function getMyPayments(
  distributorId: string,
  customerId: string,
  filters: { page?: number; pageSize?: number; from?: string; to?: string }
)
```

**All exported functions in `customerPortalService.ts`** (17 total, in file order):
1. `getCustomerDashboard(distributorId, customerId, range?)` — line 11
2. `getMyOrders(distributorId, customerId, filters)` — line 162
3. `getMyOrderById(distributorId, customerId, orderId)` — line 261
4. `createMyOrder(distributorId, customerId, userId, data)` — line 303
5. `modifyMyOrder(distributorId, customerId, orderId, items, deliveryDate?)` — line 352
6. `raiseDispute(distributorId, customerId, orderId, reason)` — line 439
7. `getMyInvoices(distributorId, customerId, filters)` — line 510
8. `getMyInvoiceById(distributorId, customerId, invoiceId, options?)` — line 556
9. `getMyPayments(distributorId, customerId, filters)` — line 604
10. `getMyPaymentById(distributorId, customerId, paymentId)` — line 647
11. `getMyBalance(distributorId, customerId)` — line 661
12. `getMyAccount(distributorId, customerId)` — line 671
13. `updateMyProfile(distributorId, customerId, data)` — line 745
14. `getMyDistributorInfo(distributorId)` — line 777
15. `getCustomerInvoices(distributorId, customerId, filters?)` — line 800
16. `getInvoiceSummaryForDownload(distributorId, customerId, dateFrom, dateTo)` — line 833
17. `PortalError` class — line 882

Every function except `getMyDistributorInfo` (single-tenant, no customer scoping needed) takes `distributorId, customerId` as leading explicit parameters — confirming the "reusable verbatim per visible customerId" architecture claim.

---

## P3 — Billing service

**`customerPortalCount` computation — exact call + WHERE, `packages/api/src/services/billingService.ts:243-244`:**
```ts
const customerPortalCount = await prisma.user.count({
  where: { distributorId, role: 'customer', status: 'active', deletedAt: null },
});
```
Used at line 246 (`if (customerPortalCount > 0)`) to add a `customer_portal` billing line item (lines 246-259).

**Confirmed the only production site:** a repo-wide grep for `role:\s*'customer'` returns 10 files total, of which 8 are test files (`anti-pattern-guards.test.ts`, `delivery-proof-otp.test.ts`, `auth-refresh.test.ts`, `users.test.ts`, `customer-portal-invoice-visibility.test.ts`, `phaseF-razorpay-customer-portal.test.ts`, `driver-analytics-security.test.ts`) plus `orderService.ts` and `customerService.ts` (unrelated role checks, not billing counts). `billingService.ts:243` is the **only** production site computing a customer-role login count for billing purposes. **A `customer_hq` login would not be counted/billed** unless this query (or a parallel one) is extended — confirms the FEATURE-INVESTIGATION.md finding as still accurate at this commit.

---

## P4 — Web routing and role guards

### `packages/web/src/routes/ProtectedRoute.tsx` (101 lines) — full file effectively captured

Role-based routing mechanism: `ProtectedRoute` wraps `ProtectedRouteInner`, which checks `allowedRoles` against `user.role`. `UserRole.SUPER_ADMIN` always bypasses the `allowedRoles` check (line 60: `if (userRole !== UserRole.SUPER_ADMIN && !allowedRoles.includes(userRole))`). Where `UserRole.CUSTOMER` is handled — lines 61-65:
```ts
const fallback =
  userRole === UserRole.CUSTOMER
    ? '/app/customer/dashboard'
    : '/app/analytics';
return <Navigate to={fallback} replace />;
```
**A hypothetical `CUSTOMER_HQ` role hitting a route it's not allowed on today would fall into the `/app/analytics` branch** (an admin-only page it would then immediately bounce out of again, per the FEATURE-INVESTIGATION.md finding) — confirmed unchanged at this commit; needs an explicit `CUSTOMER_HQ` branch.

### `packages/web/src/routes/index.tsx` (364 lines) — full route tree, `AppRoutes()`

Structure: a `Suspense`-wrapped `<Routes>` tree. Public routes (`/`, `/login`, `/force-password-reset`, `/forgot-password`, legal pages) sit outside the protected shell. Everything else nests under:
```tsx
<Route path="/app" element={<ProtectedRoute><DashboardLayout /></ProtectedRoute>}>
  <Route index element={<Navigate to="analytics" replace />} />
  <Route path="dashboard" element={<Navigate to="/app/analytics" replace />} />
  <Route path="orders" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN, DISTRIBUTOR_ADMIN, FINANCE, INVENTORY, DRIVER]} requireDistributor />}><Route index element={<OrdersPage />} /></Route>
  <Route path="inventory" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN, DISTRIBUTOR_ADMIN, FINANCE, INVENTORY]} requireDistributor />}>...</Route>
  <Route path="customers" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN, DISTRIBUTOR_ADMIN, INVENTORY, FINANCE]} requireDistributor />}><Route index element={<CustomersPage />} /></Route>
  <Route path="billing-payments" .../>
  <Route path="fleet" .../>
  <Route path="analytics" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN, DISTRIBUTOR_ADMIN, FINANCE, INVENTORY, DRIVER]} />}>...</Route>
  <Route path="collections" .../>
  <Route path="pending-actions" .../>
  <Route path="settings" .../>
  <Route path="distributors" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN]} />}>
    <Route index element={<DistributorsPage />} />
    <Route path=":id" element={<DistributorDetailPage />} />
    <Route path=":id/gst-activation" element={<GstActivationPage />} />
  </Route>
  <Route path="provider-catalog" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN]} />}>...</Route>
  <Route path="health" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN]} />}>...</Route>
  <Route path="deletion-requests" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN]} />}>...</Route>
  <Route path="profile" element={<ProtectedRoute allowedRoles={[SUPER_ADMIN, DISTRIBUTOR_ADMIN, FINANCE, INVENTORY, DRIVER]} />}>...</Route>

  {/* Customer portal routes */}
  <Route path="customer" element={<ProtectedRoute allowedRoles={[UserRole.CUSTOMER]} />}>
    <Route index element={<Navigate to="dashboard" replace />} />
    <Route path="dashboard" element={<CustomerDashboardPage />} />
    <Route path="orders" element={<CustomerOrdersPage />} />
    <Route path="invoices" element={<CustomerInvoicesPage />} />
    <Route path="payments" element={<CustomerPaymentsPage />} />
    <Route path="account" element={<CustomerAccountPage />} />
  </Route>
</Route>
<Route path="*" element={<NotFoundPage />} />
```
A new `/app/customer-group` (or similar) subtree, gated `allowedRoles={[UserRole.CUSTOMER_HQ]}` (once that enum value exists), would slot in exactly like the existing `customer` block — no existing route needs modification, purely additive.

Also note `PublicOnlyRoute` (lines 52-66, used on `/login`) has its own independent `isCustomer` check that redirects an already-authenticated user away from the login page — this too needs a `customer_hq` branch or an HQ user re-visiting `/login` while logged in falls into the `/app/analytics` bucket.

### `packages/web/src/pages/customer/` — file list

```
packages/web/src/pages/customer/AccountPage.tsx
packages/web/src/pages/customer/DashboardPage.tsx
packages/web/src/pages/customer/InvoicesPage.tsx
packages/web/src/pages/customer/OrdersPage.tsx
packages/web/src/pages/customer/PaymentsPage.tsx
```
Five pages, matching the five sub-routes above 1:1. No group/HQ page exists yet anywhere in the repo.

---

## P5 — Customer service and routes

**`createCustomer` signature** (`packages/api/src/services/customerService.ts:102-130`):
```ts
export async function createCustomer(
  distributorId: string,
  data: {
    customerName: string;
    businessName?: string;
    gstin?: string;
    phone: string;
    email?: string;
    billingAddressLine1?: string;
    billingAddressLine2?: string;
    billingCity?: string;
    billingState?: string;
    billingPincode?: string;
    shippingAddressLine1?: string;
    shippingAddressLine2?: string;
    shippingCity?: string;
    shippingState?: string;
    shippingPincode?: string;
    creditPeriodDays?: number;
    transportChargePerCylinder?: number;
    gstRateOverride?: number | null;
    contacts?: { name: string; phone?: string; email?: string; isPrimary?: boolean }[];
    cylinderDiscounts?: { cylinderTypeId: string; discountPerUnit: number }[];
    requireDeliveryVerification?: boolean;
  }
)
```
Note `requireDeliveryVerification?: boolean` (line 128) is a Proof-of-Collection-Phase-1 field that landed since the brainstorm doc — not related to grouping, but a real schema addition since that snapshot. **No `groupId`/`parentCustomerId` field exists on this signature** — confirms zero group-membership plumbing exists in `createCustomer` today.

**`updateCustomer` signature** (`packages/api/src/services/customerService.ts:196-201`):
```ts
export async function updateCustomer(
  id: string,
  distributorId: string,
  data: CustomerUpdateData,
  performedBy: string
)
```

**`POST /api/customers/:id/portal-access` — full handler** (`packages/api/src/routes/customers.ts:475-499`):
```ts
// POST /api/customers/:id/portal-access
router.post('/:id/portal-access',
  requireRole('super_admin', 'distributor_admin'),
  validate(z.object({
    email: z.string().email(),
    password: z.string().min(8),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
  })),
  auditLog('provision_portal_access', 'customer'),
  async (req, res) => {
    try {
      const user = await customerService.provisionPortalAccess(
        param(req.params.id), req.user!.distributorId!, req.body
      );
      return sendCreated(res, mapUser(user));
    } catch (err: unknown) {
      const e = err as ServiceError;
      if (e.code === 'P2002') {
        return sendError(res, 'A user with this email already exists', 409, 'CONFLICT');
      }
      return sendError(res, e.message, e.statusCode || 500);
    }
  }
);
```
This is a staff-only (`super_admin`/`distributor_admin`) route that provisions a single `customer`-role `User` row bound to one `Customer`. This is the closest existing precedent for a future "provision a `customer_hq` login for a `CustomerGroup`" endpoint.

---

## P6 — Index coverage check

**`Customer` model** (`schema.prisma:586-655`):
```prisma
@@index([distributorId, status])
@@index([distributorId, customerName])
@@index([gstin])
```
No `(distributorId, customerId, ...)` shape applies here — `Customer` doesn't have a `customerId` column (it *is* the customer row). Not applicable to the double-scope pattern; relevant instead for group-membership lookups.

**`Order` model** (`schema.prisma:839-935`):
```prisma
@@index([distributorId, status, deliveryDate])
@@index([distributorId, customerId, createdAt(sort: Desc)])
@@index([driverId, deliveryDate])
```
**Composite `(distributorId, customerId, createdAt)` exists** — line 932.

**`Invoice` model** (`schema.prisma:1250-1316`):
```prisma
@@index([distributorId, status, dueDate])
@@index([distributorId, customerId, createdAt(sort: Desc)])
@@index([irnStatus])
```
**Composite `(distributorId, customerId, createdAt)` exists** — line 1313.

**`CustomerLedgerEntry` model** (`schema.prisma:735-753`):
```prisma
@@index([distributorId, customerId, entryDate])
@@index([referenceId])
```
**Composite `(distributorId, customerId, entryDate)` exists** — line 750.

**`PaymentTransaction` model** (`schema.prisma:1430-1465`):
```prisma
@@index([distributorId, customerId, createdAt(sort: Desc)])
@@index([distributorId, transactionDate])
@@index([razorpayOrderId])
```
**Composite `(distributorId, customerId, createdAt)` exists** — line 1461.

**Explicit confirmation:** all four tables the HQ portal will hit — `Order` (:932), `Invoice` (:1313), `CustomerLedgerEntry` (:750), `PaymentTransaction` (:1461) — **already carry `distributorId` leading, `customerId` as the immediate second column.** This reconfirms the HQ-PORTAL-BRAINSTORM.md §6 audit exactly at this commit: a `distributorId = X AND customerId IN (...)` query on any of the four tables can use these existing composite indexes with `distributorId` as the equality-bound leading predicate — no new indexes/migrations required for that access pattern.

**`PaymentAllocation` model** (`schema.prisma:1467-1478`) — **confirmed: zero `@@index` block, only the implicit PK.** This is a pre-existing gap (not introduced by the grouping feature) — flagged in the brainstorm doc, reconfirmed here unchanged.

---

## P7 — `outstandingAging` in `reportsService.ts`

Full function (`packages/api/src/services/reportsService.ts:174-243`):
```ts
export async function outstandingAging(distributorId: string, f: ReportFilters): Promise<ReportResult> {
  const dateFrom = f?.dateFrom ? new Date(f.dateFrom) : null;
  const dateTo = f?.dateTo ? new Date(f.dateTo) : null;
  const invoiceWhere: Prisma.InvoiceWhereInput = {
    distributorId,
    outstandingAmount: { gt: 0 },
    deletedAt: null,
    status: { not: 'cancelled' },
  };
  if (dateFrom || dateTo) {
    invoiceWhere.issueDate = {};
    if (dateFrom) (invoiceWhere.issueDate as Prisma.DateTimeFilter).gte = dateFrom;
    if (dateTo) (invoiceWhere.issueDate as Prisma.DateTimeFilter).lte = dateTo;
  }
  const invoices = await prisma.invoice.findMany({
    where: invoiceWhere,
    select: {
      customerId: true,
      outstandingAmount: true,
      issueDate: true,
      customer: { select: { customerName: true, creditPeriodDays: true } },
    },
  });
  const lastPayments = await prisma.paymentTransaction.groupBy({
    by: ['customerId'],
    where: { distributorId, deletedAt: null },
    _max: { transactionDate: true },
  });
  const lastPayMap = new Map(lastPayments.map((p) => [p.customerId, p._max.transactionDate]));

  const now = new Date();
  const nowMs = now.getTime();
  const byCust = new Map<string, {...}>();
  for (const inv of invoices) {
    if (!inv.customerId) continue;
    const amt = num(inv.outstandingAmount);
    const creditPeriodDays = inv.customer?.creditPeriodDays ?? 30;
    const derivedDueMs = new Date(inv.issueDate).getTime() + creditPeriodDays * 86_400_000;
    const daysOverdue = Math.floor((nowMs - derivedDueMs) / 86_400_000);
    const cur = byCust.get(inv.customerId) ?? { customer: inv.customer?.customerName ?? 'Unknown', total: 0, b0_30: 0, b31_60: 0, b60plus: 0, lastPayment: '', _overdue: false };
    cur.total += amt;
    if (daysOverdue <= 30) cur.b0_30 += amt;
    else if (daysOverdue <= 60) { cur.b31_60 += amt; cur._overdue = true; }
    else { cur.b60plus += amt; cur._overdue = true; }
    const lp = lastPayMap.get(inv.customerId);
    cur.lastPayment = lp ? dayKey(new Date(lp)) : '—';
    byCust.set(inv.customerId, cur);
  }
  const rows = [...byCust.values()].sort((a, b) => b.total - a.total);
  // totals + column definitions...
  return { columns: [...], rows, totals };
}
```

**Explicitly confirmed: the current `invoiceWhere` has NO `customerId` clause at all** (lines 177-182) — it is 100% distributor-wide today, grouping happens purely in JS (`byCust` Map keyed by `inv.customerId`) after fetching every outstanding invoice for the tenant. **To become per-group, it needs an added `customerId: { in: visibleCustomerIds }` clause on `invoiceWhere`** — a one-line, low-risk change since the grouping-by-customerId JS logic downstream already works generically over whatever set of invoices comes back. This reconfirms the brainstorm's claim that this is "the strongest existing precedent for the whole HQ dashboard" and requires only the `customerId: {in:[...]}` filter add.

---

## P8 — Existing web customer page structure

### `packages/web/src/pages/CustomersPage.tsx` (1445 lines)

**No top-level page tabs exist.** The `CustomersPage` itself is a single flat view: search/filter bar (lines 173-198) → paginated customer table → row actions. **Tabs exist only inside `CustomerDetailModal`** (a per-customer drill-down modal, lines 941-1138), with state `const [tab, setTab] = useState<'orders' | 'invoices' | 'payments' | 'ledger' | 'balances'>('orders')` (line 950) and the tab-list JSX at lines 1029-1047:
```tsx
{/* Tabs */}
<div className="border-b border-surface-200 dark:border-surface-700 mb-4">
  <div className="flex gap-4">
    {tabs.map((t) => (
      <button
        key={t.key}
        onClick={() => setTab(t.key)}
        className={cn(
          'pb-2 text-sm font-medium border-b-2 transition-colors',
          tab === t.key
            ? 'border-brand-500 text-brand-600 dark:text-brand-400'
            : 'border-transparent text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
        )}
      >
        {t.label}
      </button>
    ))}
  </div>
</div>
```
where `tabs` (lines 999-1005) = `[{key:'orders',...}, {key:'invoices',...}, {key:'payments',...}, {key:'ledger',...}, {key:'balances',label:'Cylinder Balances'}]`.

**Important nuance for the implementation plan:** if the plan calls for adding a "Groups" **tab** modeled on this pattern, note this tab set lives inside the per-customer detail modal (drilling into one customer's history), not on the top-level `CustomersPage` list view. A "Groups" management UI (create/edit `CustomerGroup`, assign members) is architecturally a **sibling top-level concept to `CustomersPage`** (more like a new page or a toolbar addition next to "New Customer"), not naturally another tab inside `CustomerDetailModal`. Confirm with the plan author which UI location is actually intended before implementing.

**UI component library — confirmed custom Tailwind, not shadcn.** `CustomersPage.tsx` imports `{ Button, Input, Select, Combobox, Modal, Badge, Loader, EmptyState } from '@/components/ui'` (line 33). The component directory (`packages/web/src/components/ui/`) contains hand-written components: `Button.tsx, Modal.tsx, Badge.tsx, Loader.tsx, EmptyState.tsx, Input.tsx, Select.tsx, Combobox.tsx, CustomerSearchInput.tsx, Pagination.tsx, index.ts`. `Button.tsx` verbatim confirms the pattern — no `class-variance-authority`, no Radix primitives, no shadcn scaffolding; it composes fixed Tailwind utility classes (`btn`, `btn-primary`, `btn-secondary`, etc.) via a local `cn()` helper (`@/lib/cn`):
```tsx
const variants = { primary: 'btn-primary', secondary: 'btn-secondary', accent: 'btn-accent', danger: 'btn-danger', ghost: 'btn-ghost' } as const;
...
<button ref={ref} className={cn('btn', variants[variant], sizes[size], className)} disabled={disabled || loading} {...props}>
```

**One existing tab as a pattern reference (Ledger tab, lines 1112-1130)** — good template for a future "Groups" surface's date-filter + PDF-download affordance:
```tsx
{tab === 'ledger' && (
  <div className="space-y-4">
    <div className="flex flex-wrap items-end gap-3">
      <div><label className="label">From</label><input type="date" value={ledgerFrom} onChange={...} className="input py-2" /></div>
      <div><label className="label">To</label><input type="date" value={ledgerTo} onChange={...} className="input py-2" /></div>
      <Button variant="secondary" onClick={handleDownloadStatement}>
        <HiOutlineDocumentArrowDown className="h-4 w-4" />
        Download PDF
      </Button>
    </div>
    <LedgerTab entries={ledgerEntries ?? []} loading={ledgerLoading} />
  </div>
)}
```

**"New Customer" button — role-gated location (lines 164-169 and 206):**
```tsx
{canManage && (
  <Button onClick={() => setCreateOpen(true)}>
    <HiOutlinePlus className="h-4 w-4" />
    New Customer
  </Button>
)}
```
where `canManage = role !== UserRole.FINANCE` (line 101) — i.e. `super_admin`/`distributor_admin`/`inventory` can create/edit; `finance` is view-only (buttons hidden client-side; the API additionally enforces this — `POST /api/customers` is `requireRole('super_admin', 'distributor_admin', 'inventory')`, `customers.ts:250`, finance excluded). This `canManage`-style client gate is the pattern a "Manage Groups" button would follow.

---

## P9 — Mappers used for customer portal

All four verbatim, `packages/api/src/utils/mappers.ts`:

**`mapCustomer`** (lines 100-124):
```ts
export function mapCustomer(c: CustomerInput | null | undefined): MappedRecord | null | undefined {
  if (!c) return c;
  const mapped = renameId(c, 'customerId');
  if (mapped.transportChargePerCylinder != null) {
    mapped.transportChargePerCylinder = Number(mapped.transportChargePerCylinder);
  }
  if (mapped.contacts) {
    mapped.contacts = (mapped.contacts as HasId[]).map((ct) => renameId(ct, 'contactId'));
  }
  if (mapped.cylinderDiscounts) {
    mapped.cylinderDiscounts = (mapped.cylinderDiscounts as ChildWithCylinderType[]).map((d) => {
      const m = renameId(d, 'discountId');
      if (d.cylinderType) m.cylinderTypeName = d.cylinderType.typeName;
      return m;
    });
  }
  if (mapped.inventoryBalances) {
    mapped.inventoryBalances = (mapped.inventoryBalances as ChildWithCylinderType[]).map((b) => {
      const m = renameId(b, 'balanceId');
      if (b.cylinderType) m.cylinderTypeName = b.cylinderType.typeName;
      return m;
    });
  }
  return mapped;
}
```

**`mapOrder`** (lines 141-192) — see mapper file for full body; key facts: flat-aliases `customerName` (line 156: `mapped.customerName = o.customer?.customerName ?? 'Deleted Customer';`), `customerType` (line 159), and (Proof-of-Collection additions since the brainstorm doc) `customerRequiresVerification` (line 165) and `customerHasPortalAccess` (line 172: `(o.customer?._count?.users ?? 0) > 0`). Nests `mapInvoice(o.invoice)` when present (line 187).

**`mapInvoice`** (lines 211-265) — full body includes: flat `customerName`/`customerType` from `inv.customer` (lines 228-231), flat `orderStatus` (line 235), flat `isGodownPickup` (line 240), nested `mapOrder(inv.order)` (line 241), CN/DN count flattening from Prisma `_count` (lines 254-259).

**`mapCustomerInvoiceDetail`** (lines 330-423) — full body:
```ts
export function mapCustomerInvoiceDetail(
  inv: CustomerInvoiceInput | null | undefined,
): MappedRecord | null | undefined {
  if (!inv) return inv;
  const cgstAmount = toNum(inv.cgstValue);
  const sgstAmount = toNum(inv.sgstValue);
  const igstAmount = toNum(inv.igstValue);
  const totalAmount = toNum(inv.totalAmount);
  const subtotal = Number((totalAmount - cgstAmount - sgstAmount - igstAmount).toFixed(2));
  const billingAddress = inv.customer
    ? ([inv.customer.billingAddressLine1, inv.customer.billingAddressLine2, inv.customer.billingCity, inv.customer.billingState, inv.customer.billingPincode]
        .filter((s) => s != null && String(s).trim() !== '').join(', ') || null)
    : null;
  const items = (inv.items ?? []).map((it) => {
    const m = renameId(it, 'invoiceItemId') as MappedRecord;
    const quantity = Number(it.quantity ?? 0);
    const totalPrice = toNum(it.totalPrice);
    m.cylinderTypeName = it.cylinderType?.typeName ?? it.description ?? '';
    m.quantity = quantity;
    m.lineTotal = totalPrice;
    m.unitPrice = quantity > 0 ? Number((totalPrice / quantity).toFixed(2)) : 0;
    m.gstRate = Number(it.gstRate ?? 0);
    delete m.totalPrice; delete m.discountPerUnit; delete m.invoiceId; delete m.cylinderTypeId; delete m.cylinderType; delete m.description; delete m.hsnCode;
    return m;
  });
  const payments = (inv.paymentAllocations ?? []).map((alloc) => ({
    paymentId: alloc.payment?.id ?? alloc.id ?? '',
    amount: toNum(alloc.amount),
    transactionDate: alloc.payment?.transactionDate ?? null,
    paymentMethod: alloc.payment?.paymentMethod ?? '',
    referenceNumber: alloc.payment?.referenceNumber ?? null,
  }));
  const mapped = renameId(inv, 'invoiceId');
  mapped.customerName = inv.customer?.customerName ?? 'Customer';
  mapped.customerGstin = inv.customer?.gstin ?? null;
  mapped.billingAddress = billingAddress;
  mapped.items = items;
  mapped.subtotal = subtotal;
  mapped.cgstAmount = cgstAmount;
  mapped.sgstAmount = sgstAmount;
  mapped.igstAmount = igstAmount;
  mapped.totalAmount = totalAmount;
  mapped.orderStatus = inv.order?.status ?? null;
  mapped.payments = payments;
  delete mapped.cgstValue; delete mapped.sgstValue; delete mapped.igstValue; delete mapped.customer; delete mapped.order;
  delete mapped.paymentAllocations; delete mapped.creditNotes; delete mapped.debitNotes; delete mapped.distributorId;
  delete mapped.customerId; delete mapped.orderId; delete mapped.issuedBy; delete mapped.closedAt; delete mapped.notes; delete mapped.deletedAt;
  return mapped;
}
```

**`sellerGstin` gap — explicitly reconfirmed still present at this commit.** The `CustomerInvoiceInput.customer` type (lines 313-321) selects only buyer-side fields (`customerName, gstin, billingAddressLine1/2, billingCity, billingState, billingPincode`) — there is no `distributor`/seller relation selected anywhere in this type or in the mapper body, and `mapped.customerGstin` (line 394, the buyer's GSTIN) is the only GSTIN field the function produces. No `sellerGstin`/`distributorGstin` field exists on the output. This matches `getMyInvoiceById`'s query (`customerPortalService.ts:576-587`), whose `include` selects `customer: { select: {...} }` but never `distributor`. **The gap is real and unchanged** — closing it requires adding `distributor: { select: { gstin: true } }` to the invoice query's `include` plus one new line in this mapper.

---

## P10 — paymentService ledger functions

`packages/api/src/services/paymentService.ts`

### `getCustomerLedger` — full signature (lines 398-402)
```ts
export async function getCustomerLedger(
  distributorId: string,
  customerId: string,
  range?: { from?: string; to?: string },
): Promise<CustomerLedgerResponse>
```

### `processEntry` state machine — lines 519-695 (confirmed location, matches brainstorm's cited range)

It is a **closure** defined inside `getCustomerLedger`, sharing mutable state with the enclosing function via captured variables (not a class, not passed-in state):

- **State variables it maintains** (declared just above, lines 472-477):
  - `cumulativeInvoiceAmount: number` (running total invoiced)
  - `cumulativeReceivedAmount: number` (running total received)
  - `pendingEmptiesPerType: Map<string, number>` (per-cylinder-type empties owed back)
  - `unpaidDeliveries: { date: Date; amount: number }[]` — the FIFO aging queue; **only non-opening-balance invoice debits + debit-notes + positive adjustments enter this list** (this is the exact contract that must be preserved if extracted for group use — `computeCustomerOverdue` relies on an equivalent parallel structure staying aligned).
- **Per-entry mutation, by `entry.entryType` (a switch statement, lines 536-694):**
  - `invoice_entry`: `cumulativeInvoiceAmount += delta`; if `delta > 0` pushes into `unpaidDeliveries`; **opening-balance invoices are folded into a pre-range carry-forward figure and never individually emitted** (line 554: `if (isOB) return;`); otherwise builds one row per cylinder type via `aggByType` aggregation over `inv.items` joined against `inv.order.items` for delivered/collected quantities (lines 580-621).
  - `payment_entry`: `cumulativeReceivedAmount += Math.abs(delta)`, emits a receipt row.
  - `credit_note`: same increment-received-amount behaviour, different narration.
  - `debit_note`: `cumulativeInvoiceAmount += delta`, also enters the FIFO queue if positive.
  - `adjustment`: sign-dependent — positive treated like an invoice debit (enters FIFO), negative treated like a payment credit.
  - `empties_return`: pure stock movement, `amountDelta` is always 0 by writer convention — does not touch either cumulative total, only updates `pendingEmptiesPerType` bookkeeping (already done above the switch) and emits a "—" money row.
- **`rebuildOverdueOnState()` (lines 480-491):** re-walks `unpaidDeliveries` FIFO-style against `cumulativeReceivedAmount` every time it's called (called once per emitted row inside `emitRow`, line 511, and once for the final `summary.overdueAmount`, line 769) — this is O(n) per row, so O(n²) overall for a long ledger; acceptable at current per-customer row counts but would need care if directly reused per-customer inside a merged multi-customer loop (should still be fine — it's bounded by one customer's own entry count, not the group's).
- **Two-pass execution:** Pass 1 (lines 701-706) walks every entry in date order with `emit=false` to accumulate pre-range state + fold in all OB entries regardless of date; the opening-balance carry-forward row is then synthesized (lines 708-727+); a second in-range pass (not fully quoted here but structurally implied by the `emit` flag) re-walks and emits visible rows.

**What would need to change for group-consolidated ledger** (confirms brainstorm's assessment): `processEntry` and its captured state are scoped to a single `getCustomerLedger` invocation processing one customer's `allEntries`. To serve a merged multi-customer view without either (a) losing correct per-customer running-balance semantics or (b) doing N full separate DB round trips, the closure's state (`cumulativeInvoiceAmount`, `cumulativeReceivedAmount`, `pendingEmptiesPerType`, `unpaidDeliveries`) would need to be re-initialized **once per customerId bucket** against a single shared `findMany({ customerId: { in: [...] } } })` fetch, then the resulting per-customer row arrays merged back into one chronologically-sorted list with a Property column — i.e. extract the closure to accept pre-fetched entries + return fresh state per call, rather than doing its own `findMany`. This is confirmed as a genuine, scoped refactor (not a rewrite) — the switch-statement logic itself is reusable verbatim.

### `computeCustomerOverdue` — full signature + FIFO summary (lines 797-876)

```ts
export async function computeCustomerOverdue(
  distributorId: string,
  customerId: string,
  asOf: Date = new Date(),
): Promise<number>
```

**Tables it reads** (3 parallel queries via `Promise.all`, lines 809-838):
1. `prisma.order.findMany` — delivered/modified_delivered orders for this customer, `include: { items: true }`, ordered by `deliveryDate asc`.
2. `prisma.invoice.findMany` — opening-balance invoices (`isOpeningBalance: true`, status not cancelled), selecting `issueDate, totalAmount, outstandingAmount`.
3. `prisma.paymentTransaction.findMany` — all payments for the customer, selecting `amount` only.

**What it returns:** a single `number` — the total amount that is both unpaid AND past the customer's `creditPeriodDays` window, computed via:
- Build a `deliveries[]` list combining (a) `delivered qty × (unitPrice − discount)` per order item (line 844-847) and (b) each OB invoice's `totalAmount` treated as a synthetic delivery dated at `issueDate` (lines 855-858) — sorted oldest-first (line 859).
- Sum all payments into `totalReceived` (line 861).
- Walk `deliveries` oldest-first, consuming `remainingPayments` FIFO; any `unpaidPortion` on a delivery whose `daysSinceDelivery > creditDays` (relative to `asOf`) is added to the `overdue` accumulator (lines 863-874).
- Returns `Math.round(overdue * 100) / 100`.

This is the exact same FIFO-aging algorithm as `processEntry`'s `rebuildOverdueOnState`, applied fresh from raw tables rather than from `CustomerLedgerEntry` rows — confirmed **no batch/multi-customer form exists**; it is hard-coded to one `customerId` per call (parameter at line 799), doing 3 separate round trips internally. For a 20-50 property group this means N×3 round trips if called once per member — acceptable at the row counts documented in the brainstorm (§6), but a genuine N+1-shaped cost if the group grows large.

---

## Additional cross-cutting checks (bonus)

### Web login-redirect landing-route logic

`packages/web/src/pages/LoginPage.tsx:230-239` (the `onSuccess` handler of the `POST /auth/login` mutation):
```ts
const loginMutation = useMutation({
  mutationFn: (data: LoginInput) => apiPost<LoginResponse>('/auth/login', data),
  onSuccess: (data) => {
    setTokens(data.tokens.accessToken, data.tokens.refreshToken);
    setUser(data.user);
    if (data.user.requiresPasswordReset) { navigate('/force-password-reset', { replace: true }); return; }
    toast.success(t('auth.welcomeBackToast', { name: data.user.firstName }));
    if (from) { navigate(from, { replace: true }); return; }
    navigate(data.user.role === UserRole.CUSTOMER ? '/app/customer/dashboard' : '/app/dashboard', { replace: true });
  },
  onError: (error) => toast.error(getErrorMessage(error)),
});
```
Note `/app/dashboard` itself redirects to `/app/analytics` via the `AppRoutes()` tree (`routes/index.tsx:105`). **This is the exact spot needing a new `customer_hq` branch** — e.g. `data.user.role === UserRole.CUSTOMER ? '/app/customer/dashboard' : data.user.role === UserRole.CUSTOMER_HQ ? '/app/customer-group/dashboard' : '/app/dashboard'`. Also relevant: `PublicOnlyRoute` in `routes/index.tsx:52-66` has its own separate `isCustomer` check for the already-authenticated case on `/login` — needs the same new branch.

### `requireRole()` composability with a new `requireGroupAccess` middleware

The codebase already chains multiple middlewares per route as standard practice — e.g. `customerPortal.ts:576-580` chains `customerPaymentLimiter, requireRole('customer'), validate(schema), auditLog(...)` before the handler; `customers.ts:476-484` chains `requireRole(...), validate(schema), auditLog(...)`. A new `requireGroupAccess` middleware (resolving `CustomerGroupMember` rows for `req.user.groupId` and attaching `req.visibleCustomerIds` to the request, analogous to how `resolveDistributor` attaches `req.distributor`) would compose identically: `router.get('/orders', requireRole('customer_hq'), requireGroupAccess, handler)`. `requireRole()` itself needs no modification to support this — it's a simple variadic-role gate, agnostic to what runs after it.

### Mobile landing-route role switch

`packages/mobile/app/index.tsx` — full file, verbatim (52 lines):
```tsx
import { useEffect } from 'react';
import { View, ActivityIndicator } from 'react-native';
import { useRouter } from 'expo-router';
import { useAuthStore } from '../src/stores/authStore';

export default function Index() {
  const router = useRouter();
  const { isAuthenticated, isLoading, user } = useAuthStore();

  useEffect(() => {
    if (isLoading) return;

    if (!isAuthenticated || !user) {
      router.replace('/(auth)/login');
      return;
    }

    // Route based on role
    switch (user.role) {
      case 'customer':
        router.replace('/(customer)/dashboard');
        break;
      case 'driver':
        router.replace('/(driver)/orders');
        break;
      case 'super_admin':
        router.replace('/(super-admin)/dashboard');
        break;
      case 'distributor_admin':
        router.replace('/(admin)/dashboard');
        break;
      case 'inventory':
        router.replace('/(inventory)/analytics');
        break;
      case 'finance':
        router.replace('/(finance)/dashboard');
        break;
      default:
        router.replace('/(auth)/login');
    }
  }, [isAuthenticated, isLoading, user, router]);

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' }}>
      <ActivityIndicator size="large" color="#338dff" />
    </View>
  );
}
```
**Confirmed exactly as FEATURE-INVESTIGATION.md described:** a `customer_hq` user with no matching `case` falls into `default: router.replace('/(auth)/login')` — silently bounced to the login screen. Per HQ-PORTAL-BRAINSTORM.md §7's recommendation (v1 web-only), this file may not need a real destination case yet, but at minimum should not silently loop a `customer_hq` login back to `/login` with no explanation — worth an explicit decision in the implementation plan (e.g. a "not yet available on mobile" screen, or simply defer entirely per the brainstorm's phased recommendation).

---

## Summary of confirmed deltas vs. the two source documents

1. **Feature A (grouping) is entirely unbuilt** — no `CustomerGroup`, `CustomerGroupMember`, `customer_hq`, or `groupId` exists anywhere in the repo at this commit. Both investigation docs' recommendations remain fully prospective.
2. **Feature B (Proof of Collection) has fully landed since both docs were written** (confirmed via the task history and in-code comments dated 2026-07-15: `DeliveryProof` model, `Customer.requireDeliveryVerification`, OTP generation/verification routes, mobile signature/photo/OTP capture, PDF `drawProofSection`). This incidentally touched several files the grouping feature will also touch: `customerPortalService.ts:getMyOrders` (added `deliveryProof`/`customer.requireDeliveryVerification` to its `include`), `mappers.ts:mapOrder` (added `customerRequiresVerification`, `customerHasPortalAccess` flat fields), `customerService.ts:createCustomer` (added `requireDeliveryVerification` param). None of this conflicts with the grouping plan, but the implementer should be aware these files have moved since the brainstorm's snapshot.
3. **All specific line-cited claims in both docs were spot-checked against the current commit and found accurate**, with the line-number deltas noted above (`getMyOrders`'s WHERE clause is unchanged; only its `include` grew).
4. **The `sellerGstin` gap, the `outstandingAging` distributor-wide-only limitation, the `PaymentAllocation` missing-index gap, and the single-customer-only `getCustomerLedger`/`generateCustomerLedgerPdf` signatures are all reconfirmed present, unchanged, at this commit.**

