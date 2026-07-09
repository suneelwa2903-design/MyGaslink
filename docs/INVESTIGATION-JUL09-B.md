# INVESTIGATION-JUL09-B

Read-only investigation across 11 items. **No code changes were made and nothing was committed as part of this session.**

Prod EC2 SSH access **denied** from this dev box (`Permission denied (publickey)` — no key installed for `ec2-user@43.204.63.205`), and the local `DATABASE_URL` points at the local docker Postgres, **not** prod RDS. Any DB query stubbed as `> Needs prod run:` must be executed by someone with prod access.

Investigator: Claude Code · Repo HEAD: `7e262e5` (post-deploy) · Date: 2026-07-09.

---

## Item 1 — Customer picker

**Trigger & modal component:** [packages/mobile/app/(admin)/orders.tsx:1180-1268](packages/mobile/app/(admin)/orders.tsx) (inside `CreateOrderModal`, itself lines 1065-1481). Same pattern duplicated in `ReturnsOrderModal` at `orders.tsx:2202-2270`.

Open/close: local `showCustomerPicker` boolean state ([orders.tsx:1082](packages/mobile/app/(admin)/orders.tsx:1082)). Tapping the picker button sets it true; the header X and item-tap set it false.

```tsx
// orders.tsx:1200-1212
<Modal visible={showCustomerPicker} animationType="slide" transparent>
  <View style={[styles.pickerOverlay, { backgroundColor: C.overlay }]}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, justifyContent: 'flex-end' }}
    >
      <View style={[styles.pickerSheet, { backgroundColor: C.modalBg }]}>
        <View style={[styles.pickerSheetHeader, { borderBottomColor: C.divider }]}>
          <Text style={[styles.pickerSheetTitle, { color: C.text }]}>Select Customer</Text>
          <TouchableOpacity onPress={() => setShowCustomerPicker(false)}>
            <Ionicons name="close" size={24} color={C.text} />
          </TouchableOpacity>
```

**Android back handling:** none. The `<Modal>` on line 1200 has NO `onRequestClose` prop; no `BackHandler.addEventListener`; no `useFocusEffect`. Grep across `packages/mobile/app/(admin)/orders.tsx` returns zero hits for `BackHandler|useFocusEffect|hardwareBackPress|onRequestClose`. RN's `Modal` on Android requires `onRequestClose` to receive the hardware-back event — without it, the back press is uncaught by the picker Modal and propagates to the outer `CreateOrderModal` (also missing `onRequestClose`, `orders.tsx:1152`), which in modern RN either dismisses the outer sheet or does nothing depending on version. Either way, the picker is not dismissed by back. Other modals in the same app DO wire it correctly (e.g. `(admin)/more.tsx:1066`, `finance.tsx:1319`, `pending-payments.tsx:249` all pass `onRequestClose={onClose}`) — the orders picker was simply forgotten.

**API populating the list:** [orders.tsx:278-283](packages/mobile/app/(admin)/orders.tsx:278).

```tsx
const { data: customersData } = useApiQuery<{ customers: Customer[] }>(
  ['customers-list'],
  '/customers',
  { limit: 200 },
  { staleTime: 5 * 60 * 1000 },
);
```

Fixed page of 200, no `search` param, no pagination. Filtering is client-side inside `filteredCustomers` ([orders.tsx:1105-1109](packages/mobile/app/(admin)/orders.tsx:1105)):

```tsx
const filteredCustomers = useMemo(() => {
  if (!customerSearch.trim()) return customers;
  const q = customerSearch.toLowerCase();
  return customers.filter((c) => c.customerName.toLowerCase().includes(q));
}, [customers, customerSearch]);
```

So the picker only ever sees whatever 200 customers the API returned by default — for any distributor with >200 customers, older ones never appear and can never be searched.

**Server supports server-side search** — [packages/api/src/routes/customers.ts:25-37](packages/api/src/routes/customers.ts) calls `customerService.listCustomers` with `customerFilterSchema` — which the web `CustomerSearchInput` already uses via `{ search, status: 'active', pageSize: 10 }`.

**Web equivalent** ([packages/web/src/components/ui/CustomerSearchInput.tsx](packages/web/src/components/ui/CustomerSearchInput.tsx), used from [OrdersPage.tsx:558-569](packages/web/src/pages/OrdersPage.tsx:558)):

```tsx
// CustomerSearchInput.tsx:27-75
const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;
const RESULT_LIMIT = 10;
...
useEffect(() => {
  const timer = setTimeout(() => {
    setDebouncedQuery(query.length >= MIN_CHARS ? query : '');
  }, DEBOUNCE_MS);
  return () => clearTimeout(timer);
}, [query]);

const { data, isFetching } = useQuery({
  queryKey: ['customer-search', debouncedQuery],
  queryFn: () => apiGet<{ customers: Customer[] }>('/customers', {
    search: debouncedQuery,
    status: 'active',
    pageSize: RESULT_LIMIT,
  }),
  enabled: debouncedQuery.length >= MIN_CHARS,
  staleTime: 30_000,
});
```

Type-ahead with min 3 chars, 300 ms debounce, `search=` param goes to the server, results limited to 10. **Delta vs mobile:** mobile fetches a static 200-row cache and never sends `search`.

**Root cause — back trap:** `<Modal>` at `orders.tsx:1200` is missing the required `onRequestClose` prop, so the Android hardware back button isn't captured by the picker.

**Root cause — "only recent customers show":** `useApiQuery('/customers', { limit: 200 })` at `orders.tsx:278-283` uses no `search` parameter and caches 200 rows; the picker filters that cache client-side, hiding anything beyond the first 200.

**Complexity:** small. Two focused changes: (a) add `onRequestClose={() => setShowCustomerPicker(false)}` (and `onRequestClose={onClose}` on `CreateOrderModal`'s outer Modal at `orders.tsx:1152`); (b) rework the picker to use a debounced state-driven `useApiQuery` keyed on the search term (mirror `CustomerSearchInput` — `queryKey: ['customer-search', debouncedQuery]`, params `{ search, status: 'active', pageSize: 10 }`, `enabled: debouncedQuery.length >= 3`). Also apply the same fix to `ReturnsOrderModal` (`orders.tsx:2214+`, same shape).

---

## Item 2 — Keyboard overlap

**Broken modal:** `DeliveryConfirmationModal`, [packages/mobile/app/(admin)/orders.tsx:1826-2015](packages/mobile/app/(admin)/orders.tsx:1826).

```tsx
// orders.tsx:1879-1905
<Modal visible={visible} animationType="slide" presentationStyle="fullScreen">
  <SafeAreaProvider>
  <SafeAreaView edges={['top','bottom','left','right']} style={[styles.modalContainer, { backgroundColor: C.modalBg }]}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1 }}
    >
      <View style={[styles.modalHeader, ...]}>...</View>
      <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
```

Then two `TextInput`s per item (Delivered Qty, Empties Collected — `orders.tsx:1939-1966`) and a multiline `notes` `TextInput` (`orders.tsx:1976-1988`).

Container structure: `Modal(fullScreen) > SafeAreaView > KeyboardAvoidingView(behavior=undefined on Android) > ScrollView > TextInputs`.

- `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` — on Android KAV is a **no-op**.
- No `keyboardVerticalOffset` anywhere in the mobile package (grep on `keyboardVerticalOffset|behavior="height"` returns zero hits).
- No `onRequestClose` on this Modal either.
- Same anti-pattern on the driver-side equivalent [(driver)/orders.tsx:321-332](packages/mobile/app/(driver)/orders.tsx:321) — the in-file comment at lines 315-320 explicitly acknowledges it and defers to "AndroidManifest's default adjustResize."

That deferral is the bug. RN's `<Modal>` on Android renders in its own `Dialog` window whose `softInputMode` is NOT inherited from the Activity — `adjustResize` at the Activity level does not resize the Modal's Dialog. So the keyboard covers the inputs whenever they're near the bottom half of the sheet.

**Comparison — pattern that works** (auth screens, NOT inside a Modal):

```tsx
// packages/mobile/app/(auth)/login.tsx:133-135
<KeyboardAvoidingView
  behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
  style={{ flex: 1 }}
>
```

Same in `(auth)/forgot-password.tsx:168-170`. Critical delta: `behavior='height'` on Android (not `undefined`). Because those screens aren't inside a `<Modal>`, they also don't hit the Dialog-softInputMode issue.

**Diff between broken and working:**
1. `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` → `behavior={Platform.OS === 'ios' ? 'padding' : 'height'}` (or `'padding'` on both).
2. Add `keyboardVerticalOffset` to compensate for the modal's header.
3. Because this KAV lives inside a Modal on Android, `behavior='height'` alone may still be insufficient — the Modal's Dialog window needs `softInputMode="adjustResize"`. React Native does not expose this as a `<Modal>` prop; typical fixes are (a) rely on `windowSoftInputMode` in `AndroidManifest.xml`, or (b) drop `presentationStyle="fullScreen"` in favour of a non-Modal sheet or `presentationStyle="pageSheet"` (as `(customer)/payments.tsx:318` does with `onRequestClose`).

**Complexity:** small if the accepted fix is just `behavior='height'` on Android on the two confirm-delivery modals (`(admin)/orders.tsx:1883` and `(driver)/orders.tsx:329`). Medium if a proper repo-wide fix is wanted — there are ~12 `behavior={Platform.OS === 'ios' ? 'padding' : undefined}` sites and the CLAUDE.md comment at `orders.tsx:1195-1199` documents this as an intentional pattern citing `docs/IOS-KOF-AUDIT.md`, so the sweep needs alignment with that audit before flipping the default.

---

## Item 3 — Change password

**API endpoint: EXISTS.** [packages/api/src/routes/auth.ts:93-112](packages/api/src/routes/auth.ts:93).

```ts
router.post('/change-password', authenticate, validate(changePasswordSchema), async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  await authService.changePassword(req.user!.userId, currentPassword, newPassword);
  logBusinessEvent({ action: 'user.password_changed', entityType: 'user',
                     entityId: req.user!.userId, requestId: req.requestId });
  return sendSuccess(res, { message: 'Password changed successfully' });
});
```

- **Auth:** yes (`authenticate` middleware). **Rate-limit:** NO — the login/refresh/forgot/reset endpoints all have `rateLimit()` wrappers; change-password does not.
- **Payload** (`shared/schemas/index.ts:40-44`): `{ currentPassword, newPassword (min 8), confirmPassword }`, cross-field equality enforced.
- **Roles:** any authenticated user, no role gate — drivers, customers, admins, finance, inventory, super_admin all eligible.
- **Service** ([authService.ts:231-261](packages/api/src/services/authService.ts:231)): bcrypt-verifies `currentPassword`, hashes new one at `SALT_ROUNDS=12`, sets `requiresPasswordReset:false`, **nulls `refreshToken` (force re-login on all other sessions)**, then fires `sendPasswordChangedEmail`.
- **Tests:** yes — [phase6-mobile-parity.test.ts:136-187](packages/api/src/__tests__/phase6-mobile-parity.test.ts:136) (401-unauth + happy path + asserts the mobile force-reset screen posts here) and [password-emails.test.ts:88-117](packages/api/src/__tests__/password-emails.test.ts:88) (email-log side effects + no-email-on-wrong-password).

**Web UI — EXISTS for staff roles.** [packages/web/src/pages/ProfilePage.tsx:211-223](packages/web/src/pages/ProfilePage.tsx:211):

```tsx
function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { register, handleSubmit, formState: { errors } } = useForm<ChangePasswordInput>({
    resolver: zodResolver(changePasswordSchema),
  });
  const mutation = useMutation({
    mutationFn: (data: ChangePasswordInput) => apiPost('/auth/change-password', data),
    onSuccess: () => { toast.success('Password updated'); onClose(); },
```

Wired into ProfilePage (`/app/profile`) for admin / finance / inventory / super_admin. Also `ForcePasswordResetPage.tsx` uses the same endpoint. **Customer role has its own page** `/app/customer/account` (comment at `ProfilePage.tsx:55`) — grep shows no change-password wiring in the customer-account file, so **customer web = missing.**

**Mobile UI — STUB.** [packages/mobile/src/screens/ProfileScreen.tsx:221-340](packages/mobile/src/screens/ProfileScreen.tsx:221):

```tsx
{/* Change password — opens a "coming soon" modal. The actual
    password-change flow is a separate piece of work; keeping the
    row here so the UI surface is complete. */}
<TouchableOpacity onPress={() => setShowChangePassword(true)} ...>
...
  <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
    Coming soon
  </Text>
```

Shared by `(admin)/profile.tsx`, `(finance)/profile.tsx`, `(inventory)/profile.tsx` via the `ProfileScreen` re-export. **Driver + customer** have no profile screen path that surfaces change-password at all. A working mobile screen already exists for the **forced** case: `(auth)/force-password-reset.tsx` posts to `/auth/change-password` (verified by phase6-mobile-parity.test.ts:185) — the **voluntary** path is what's missing.

**Password storage:** bcryptjs, `SALT_ROUNDS = 12` ([authService.ts:55-58](packages/api/src/services/authService.ts:55)); schema field `User.passwordHash String @map("password_hash")` ([schema.prisma:486](packages/api/prisma/schema.prisma:486)). No legacy plaintext column. **All roles** (driver, customer, admin, finance, inventory, super_admin) authenticate the same way via `POST /api/auth/login` with `email + password` — driver auth is **password-based, not OTP**. OTP only exists as a *reset* mechanism (`forgotPassword` → email OTP → `verifyResetOtp` → short-lived reset JWT → `resetPassword`).

**What needs to ship for voluntary change-password:**

| Surface | Status | Effort |
|---------|--------|--------|
| web admin/finance/inventory/super_admin | ✅ done | — |
| web customer | ❌ missing | small (reuse `ChangePasswordModal`) |
| mobile admin/finance/inventory | 🟡 stub only | small (replace placeholder with real form; force-reset screen is copy-paste reference) |
| mobile driver | ❌ no entry point | small-medium (add row in driver More screen + form) |
| mobile customer | ❌ no entry point | small-medium (add row in `(customer)/account.tsx`) |
| API rate-limit | ❌ missing | tiny (add `rateLimit()` wrapper on `/change-password`) |

**Total complexity: small.** Backend + web-staff done; five UI surfaces to plumb through one shared form.

---

## Item 4 — Session expiry / involuntary logout

**Access token expiry: `15m`.** [packages/api/src/config/index.ts:16](packages/api/src/config/index.ts:16) `accessExpiresIn: '15m'`.

**Refresh token expiry: `180d`** (confirmed — bumped 2026-06-21). [config/index.ts:17-27](packages/api/src/config/index.ts:17):

```ts
// Persistent-login refresh TTL (bumped 2026-06-21 from 7d → 180d).
// Token rotation already implemented in authService.refreshTokens —
// every successful refresh issues a NEW refresh token and writes it
// to User.refreshToken, invalidating the old one. With this TTL +
// rotation, an active user (opens the app at least once every 180
// days) stays logged in indefinitely. Dormant users get logged out
// at 180d. Mirrors the Swiggy/Rapido/Zomato session pattern.
refreshExpiresIn: '180d',
```

Confirmed by commit `56dd405 feat(auth): persistent login - 180d refresh TTL + JTI rotation guarantee`. **The 180-day claim is real, not a myth.**

**Refresh endpoint:** `POST /api/auth/refresh` — [routes/auth.ts:76-87](packages/api/src/routes/auth.ts:76). Zod-validated body `{ refreshToken }`, rate-limited (30/15min prod). Handler at [authService.ts:199-229](packages/api/src/services/authService.ts:199) verifies the JWT, compares against `User.refreshToken` DB column (single-session rotation), issues new pair, overwrites the stored refresh with the new one.

**Mobile token storage: `expo-secure-store`** (compliant with CLAUDE.md rule). [packages/mobile/src/lib/api.ts:2, 14-41](packages/mobile/src/lib/api.ts) — every access via `SecureStore.getItemAsync/setItemAsync/deleteItemAsync`. Keys `accessToken`, `refreshToken`. No AsyncStorage anywhere in the auth path.

**App-open validation flow:** [packages/mobile/app/_layout.tsx:22-31](packages/mobile/app/_layout.tsx:22) → [authStore.ts:50-67](packages/mobile/src/stores/authStore.ts:50):

```ts
hydrate: async () => {
  try {
    const token = await tokenStorage.getAccessToken();
    if (!token) { set({ isLoading: false }); return; }
    const user = await apiGet<UserProfile>('/auth/me');   // ← drives the 401 refresh path
    set({ user, isAuthenticated: true, isLoading: false });
  } catch {
    await tokenStorage.clearTokens();                     // ← catch-all clears BOTH tokens
    set({ user: null, isAuthenticated: false, isLoading: false });
  }
},
```

If `/auth/me` returns 401, the axios interceptor tries refresh once; if refresh succeeds it retries `/auth/me`; if refresh fails → interceptor calls `tokenStorage.clearTokens()` and the `hydrate` catch runs and also clears.

**401 interceptor** [api.ts:91-121](packages/mobile/src/lib/api.ts:91):

```ts
if (error.response?.status === 401 && !original._retry) {
  original._retry = true;
  ...
  try {
    const refreshToken = await getToken('refreshToken');
    if (!refreshToken) throw new Error('No refresh token');
    const res = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken });
    const { accessToken, refreshToken: newRefresh } = res.data.data.tokens;
    await tokenStorage.setTokens(accessToken, newRefresh);
    ...
    return api(original);
  } catch (e) {
    processQueue(e);
    await tokenStorage.clearTokens();      // ← ANY refresh failure wipes tokens
    return Promise.reject(e);
  }
}
```

Interceptor guards `/auth/` URLs (line 69) — so a 401 on `/auth/refresh` itself does NOT re-recurse, but the outer `catch` still clears tokens.

**Every code path that clears tokens:**
1. Explicit `useAuthStore.logout()` — [authStore.ts:45-48](packages/mobile/src/stores/authStore.ts:45).
2. `hydrate()` catch on ANY thrown error from `/auth/me` — [authStore.ts:63-66](packages/mobile/src/stores/authStore.ts:63).
3. Response interceptor catch on any refresh failure — [api.ts:114-117](packages/mobile/src/lib/api.ts:114).
4. Server-side `/api/auth/logout` nulls `User.refreshToken` — [authService.ts:263-268](packages/api/src/services/authService.ts:263).
5. Server-side `changePassword` and `resetPassword` null `User.refreshToken` — [authService.ts:248, 389](packages/api/src/services/authService.ts:248).

**Most likely root cause of "logged out after a few hours":**

**Refresh-token rotation with single-slot DB storage** ([authService.ts:222-226](packages/api/src/services/authService.ts:222) — `prisma.user.update({ data: { refreshToken: tokens.refreshToken }})`). The server stores exactly ONE refresh token per user. Concurrency traps:

- **Same user on two devices** (e.g. phone + web, or two phones). Device A refreshes → DB now holds A's new token. Device B's next refresh fails (`user.refreshToken !== refreshToken` at [authService.ts:208](packages/api/src/services/authService.ts:208) returns 401) → interceptor's `catch` fires `clearTokens()` → user is logged out on Device B "a few hours later" (whenever access token first expires after A refreshed).
- **Server-side password change on another device / password reset** nulls `User.refreshToken` → every other logged-in device gets forcibly logged out on its next refresh. Intended behaviour, but explains a subset of complaints.
- **Explicit `logout()` on Device A** also nulls `refreshToken`, invalidating Device B (same shape).

Nothing in the config would produce a "few hours" logout on a single-device single-session user — access token expires every 15 min but the interceptor transparently refreshes and the refresh token lasts 180 days. So the "few hours" complaint fits **multi-device usage** (same user logged into web admin + mobile, or two mobile installs) or **a password reset triggered elsewhere.**

**Complexity: medium.** Move refresh tokens from a single `User.refreshToken` column to a `RefreshTokenSession` table keyed by `(userId, jti)` so N devices can hold N valid refresh tokens simultaneously. JTI infrastructure is already in place ([authService.ts:75-79](packages/api/src/services/authService.ts:75) — `{ ...payload, jti: randomUUID() }`), just not persisted per-session. Needs schema migration + rewrites of `refreshTokens`, `logout`, `changePassword`, `resetPassword`, plus a "logout all sessions" explicit path.

---

## Item 5 — Network errors on web (EC2 investigation)

**No prod access from this dev box.** SSH to `ec2-user@43.204.63.205` returned `Permission denied (publickey,gssapi-keyex,gssapi-with-mic)` — no key installed here. This section documents (a) the exact commands to run from a box with prod access, and (b) what indirect signals in the code suggest.

### Commands to run on EC2 (someone with prod SSH access)

```bash
# 5.1 Recent app logs
ssh ec2-user@43.204.63.205 "pm2 logs gaslink-api --lines 200 --nostream"

# Look for: ECONNRESET, ETIMEDOUT, socket hang up, Prisma "connection pool"
# warnings, "Unhandled promise rejection", "Killing process", "OOM",
# "restarting" — anything indicating instability.

# 5.2 Process health
ssh ec2-user@43.204.63.205 "pm2 show gaslink-api"

# Look for: restart count > 0-2, uptime resetting frequently, memory usage
# creeping toward the process limit, CPU pegged at 100%.

# 5.3 Restart/crash grep
ssh ec2-user@43.204.63.205 "pm2 logs gaslink-api --lines 500 --nostream | grep -E 'restart|crash|ENOMEM|killed|SIGTERM|SIGKILL|out of memory|heap|EAI_AGAIN|ECONN'"

# 5.4 Host health
ssh ec2-user@43.204.63.205 "free -m && df -h && uptime && cat /proc/loadavg"

# Look for:
# - free -m: available < 200 MB is a red flag (Node can swap and slow down)
# - df -h: /var/log or / near full → pm2 log rotation stalls
# - uptime + load avg: 5-min avg > CPU count is sustained overload

# 5.5 Node/nginx timeouts + connection tuning
ssh ec2-user@43.204.63.205 "sudo cat /etc/nginx/conf.d/gaslink*.conf | grep -E 'timeout|proxy_read|keepalive|client_max'"

# Look for: proxy_read_timeout < 60s can drop long API calls. keepalive_timeout
# lower than 65s can cause AWS ALB-side "socket hang up" symptoms on the client.
```

### Client-side signals already visible in the repo

- **Server timeout config** ([packages/api/src/server.ts:64-93](packages/api/src/server.ts:64)): only a 30 s graceful-shutdown timer. There is **no explicit `server.timeout`, `server.keepAliveTimeout`, or `server.headersTimeout` tuning.** Node defaults for `keepAliveTimeout` (5 s) are shorter than typical AWS ALB idle timeouts (60 s) — this is a **known misconfiguration class** that produces intermittent 502 / "socket hang up" errors on the client without any obvious server-side error. It should be a top suspect if EC2 logs show no crashes.

- **Web axios timeout** ([packages/web/src/lib/api.ts:20-22](packages/web/src/lib/api.ts:20)): `timeout: 30000` (30 s). Any single request that takes longer surfaces as `ECONNABORTED` in the browser — could look like "network error" to the user.

- **Web 401 refresh path** ([api.ts:131-168](packages/web/src/lib/api.ts:131)): only 401 forces logout. Every other status (400/403/404/409/5xx and axios timeouts) is rejected as-is and the calling mutation handles it inline. **No spurious logouts** from network hiccups.

### Most likely root cause (based on code signals alone)

**Missing `server.keepAliveTimeout` + `headersTimeout` tuning on the Express server.** The AWS ALB / Nginx in front of the API will hold a keep-alive connection for ~60 s, but the Node HTTP server closes the socket at 5 s by default. When the client sends a new request on what it believes is a still-open connection, it lands on a half-closed socket → the client sees "socket hang up" / "network error". The fix (once confirmed) is 2 lines in `packages/api/src/server.ts`:

```ts
server.keepAliveTimeout = 65_000;   // longer than ALB's 60 s idle
server.headersTimeout   = 66_000;   // must be > keepAliveTimeout
```

Not applying this change now — it's an investigation report, and the commands above must be run against prod first to confirm this is the actual signature.

**Complexity to fix:** tiny (2 lines) once EC2 logs confirm the pattern. If EC2 logs instead show pm2 restarts / OOM, that's a different fix (memory limit, worker count) and would be small.

---

## Item 6 — Backdated driver trip

**6.1 DVA past-date validation — NONE. Past dates permitted.**

[packages/api/src/routes/assignments.ts:120-127](packages/api/src/routes/assignments.ts:120):

```ts
router.post('/',
  requireRole('distributor_admin', 'super_admin', 'finance', 'inventory'),
  validate(z.object({
    driverId: z.string().uuid(),
    vehicleId: z.string().uuid(),
    assignmentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })),
```

Just a YYYY-MM-DD regex — no `.refine(date => date >= todayStr)`. The service (`assignmentService.ts:432-472`) `new Date(data.date)` and writes it straight to `driverVehicleAssignment.assignmentDate` with `status: 'dispatch_ready', isReconciled: false`. **However**, the state machine (`pending → dispatch_ready → loaded_and_dispatched → reconciled`) is driven by preflight/dispatch/reconcile flows that write real inventory events, so a past-date DVA would sit in `dispatch_ready` unless we also route it through the workflow.

**6.2 Preflight past-date — NO validation.**

[gstPreflightService.ts:161-211](packages/api/src/services/gst/gstPreflightService.ts:161) takes `assignmentDate: string` and uses it verbatim. IRN generation flows into `payloadBuilders.ts:292-296`:

```ts
DocDtls: {
  Typ: data.docType,
  No: truncateDocNumber(data.docNumber),
  Dt: formatDate(data.docDate),
},
```

Since `backdatedOrderService.ts:165-167` already passes `issueDateOverride: issueDate` into `createInvoiceFromOrder`, `invoice.issueDate` is the backdated date. **IRN DocDtls.Dt will carry the correct historical date.** Confirmed.

**Caveat:** NIC rejects e-invoices >30 days old (`Reported after specified days`). The current single-order backdated flow lives under this window because the Zod guard restricts to current calendar month; a bulk trip flow inherits the same window.

**6.3 backdatedOrderService today — single customer, single order, supports driver+vehicle.**

[backdatedOrderService.ts:39-200](packages/api/src/services/backdatedOrderService.ts:39) accepts one `customerId` and one `items[]`, but already supports optional `driverId` + `vehicleId`. Shape at `shared/src/schemas/index.ts:236-275`:

```ts
export const backdatedOrderSchema = z.object({
  customerId: uuid,
  issueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/)...
  items: z.array(z.object({ cylinderTypeId, quantity, emptiesCollected })).min(1),
  driverId: uuid.optional(),
  vehicleId: uuid.optional(),
  payment: z.object({ amount, paymentMethod, referenceNumber, transactionDate }).optional(),
});
```

Order gets `status: 'delivered'`, `orderType: 'delivery'`, `isBackdated: true`, `deliveredAt: issueDate`, and IRN fires post-commit. **No inventory events by design** — settlement is deferred to `applyBackdatedInventoryAdjustment` ([backdatedAdjustmentService.ts:41-141](packages/api/src/services/backdatedAdjustmentService.ts:41)), which writes events dated TODAY (no historical cascade — explicit design in the doc-block).

**6.4 Bulk pattern in repo:** only `bulk_assign_driver` ([routes/orders.ts:355](packages/api/src/routes/orders.ts:355)). No `orders/bulk-create`. Transaction pattern for multi-write is `prisma.$transaction(async (tx) => {...})` — already used inside `createBackdatedOrder`. Nesting N customer creates in one tx is fine for 10-20 rows; each currently creates order+invoice+optional payment and allocates a doc number via `allocateNumber(tx, ...)` which is FY-sequenced and rolls back cleanly.

**What to change for bulk-per-trip:**

- **schema.prisma**: no changes. `Order.isBackdated`, `driverId`, `vehicleId`, `DriverVehicleAssignment.assignmentDate` all exist.
- **Zod (shared/src/schemas/index.ts)**: add `backdatedTripSchema` = `{ issueDate, driverId, vehicleId, orders: Array<{customerId, items, poNumber, payment?}>, specialInstructions? }`. Reuse the same-month/before-today refines.
- **service**: new `backdatedTripService.createBackdatedTrip()` that (a) upserts a `driverVehicleAssignment` for `(driverId, vehicleId, issueDate)` with `status: 'reconciled', isReconciled: true` (skip the state machine — trip already happened), (b) loops `createBackdatedOrder`-equivalent inside ONE `prisma.$transaction` per order (safer than one mega-tx for 20 orders; keeps the existing IRN-per-invoice retry surface).
- **new endpoint**: `POST /api/orders/backdated-trip` — distributor_admin only.
- **web UI**: new modal on OrdersPage — driver/vehicle picker + date + repeatable customer-line groups.
- **mobile**: not required v1 (admin-only, low frequency).

**6.5 Cascade + is_locked behavior — CORRECT & safe for past-date entry.**

[inventoryService.ts:233-309](packages/api/src/services/inventoryService.ts:233):

```ts
export async function recalculateSummariesFromDate(distributorId, cylinderTypeId, fromDate) {
  const events = await prisma.inventoryEvent.findMany({
    where: { distributorId, cylinderTypeId, eventDate: { gte: fromDate } },
    distinct: ['eventDate'], orderBy: { eventDate: 'asc' },
  });
  ...
  for (const date of sortedDates) {
    const existing = await prisma.inventorySummary.findUnique({...select: { isLocked: true }});
    if (existing?.isLocked) continue;  // ← lock-skip guard
    const summary = await computeSummaryForDate(...);
    await prisma.inventorySummary.upsert({...});
  }
}
```

Cascade correctly walks all event-dates AND existing-summary-dates from `fromDate` forward, and **skips any locked row** at line 288. Readers of `isLocked`: only the recalc + two lock endpoints — no other service branches on it.

BUT — the current backdated design intentionally does NOT cascade past inventory. `applyBackdatedInventoryAdjustment` writes events dated `localTodayISO()` and only recalcs from today. If bulk-per-trip should reflect stock as-of the trip date, that's a **design choice change** (write events dated `issueDate` and cascade). The cascade itself is safe; is_locked would block days the admin closed.

> Needs prod run:
> ```sql
> SELECT summary_date, COUNT(*) FROM inventory_summaries
> WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
>   AND is_locked = true
> ORDER BY summary_date DESC LIMIT 20;
> ```

**Recommended path: (b) new bulk service.** `createBackdatedOrder` has a hard 1:1 customer:order assumption in its var names, tx boundary, and the payment field. Wrapping N calls in a Promise.all loses the IRN idempotency guard; adding an `orders[]` param inside the existing function bloats it. New service — reuse `getEffectivePrice`, `computeOrderTotal`, `allocateNumber`, `createInvoiceFromOrder`, `createPaymentInTx`, plus a DVA upsert.

**Complexity: medium** (~2-3 days: shared schema, service, route, web modal, tests for the driver+multi-customer + DVA reconciled path; primitives all exist).

---

## Item 7 — Empties-only return

**7.1 Current Returns Order flow — implemented and wired end-to-end, not stubbed.**

Route: `POST /api/orders/returns-only` → `orderService.createReturnsOrder` ([orderService.ts:404-443](packages/api/src/services/orderService.ts:404)) creates `Order` with `orderType: 'returns_only'`, `totalAmount: 0`, `status` pending_delivery or pending_dispatch, plus `OrderStatusLog` and optional `DriverAssignment`. **No invoice, no inventory events at creation.** Then `POST /api/orders/:id/confirm-returns` → `confirmReturnsCollection` ([orderService.ts:1252-1361](packages/api/src/services/orderService.ts:1252)) writes:

- `InventoryEvent` with `eventType: 'returns_collection'` ([orderService.ts:1313](packages/api/src/services/orderService.ts:1313)),
- `CustomerInventoryBalance` decrement of `withCustomerQty` ([orderService.ts:1324-1339](packages/api/src/services/orderService.ts:1324)),
- `orderStatusLog`,
- No invoice (comment at line 1343: `NO invoice creation for returns-only orders`).

Web modal: `OrdersPage.tsx:1611-1736` (`ReturnsOrderModal`). Mobile: `(admin)/orders.tsx:2116-2200`. Both require driver later (via Assign Driver). This is a **schedule-then-collect** two-step flow — not lightweight.

**7.2 What a simple empties return needs (no schedule, no order, no driver, no invoice):**

- **InventoryEventType**: use `'returns_collection'` — already what `confirmReturnsCollection` uses ([orderService.ts:1313](packages/api/src/services/orderService.ts:1313)), and the summary aggregator at [inventoryService.ts:183-186](packages/api/src/services/inventoryService.ts:183) already sums it into `collectedEmpties`. `'collection'` is for empties collected *during* a delivery ([orderService.ts:1058](packages/api/src/services/orderService.ts:1058)); `'reconciliation_empties_return'` is supervisor-verified return at vehicle reconcile and feeds `closingEmpties` directly ([inventoryService.ts:187-194](packages/api/src/services/inventoryService.ts:187)).

  **Caveat:** under the new inventory model, `collectedEmpties` is display-only and only `emptiesReturnedVerified` (from `reconciliation_empties_return`) actually credits `closingEmpties` ([inventoryService.ts:211](packages/api/src/services/inventoryService.ts:211)). If a bare empties-return should credit depot stock immediately (no vehicle involved), write **both** — mirroring the godown-pickup synthetic-event pattern at `orderService.ts:1079-1092`. Safer play: write `reconciliation_empties_return` + `referenceType: 'empties_return'`.

- **CustomerInventoryBalance**: decrement `withCustomerQty` ([schema.prisma:630](packages/api/prisma/schema.prisma:630)). Same upsert as `orderService.ts:1324-1339`.
- **CustomerLedgerEntry**: not needed. No money movement; `paymentService` is not invoked.
- **Invoice**: not needed. The `returns_only` order path already skips invoice creation and works.

**7.3 confirmDelivery collection block** — [orderService.ts:1041-1092](packages/api/src/services/orderService.ts:1041). `recalculateSummariesFromDate(distributorId, cylinderTypeId, order.deliveryDate)` is called at `orderService.ts:1350` (returns) and inside every other event write path. Cascade covered in 6.5.

**7.4 UI placement:** InventoryPage.tsx daily-summary tab already renders `Incoming Fulls | Outgoing Empties | Adjust Stock` at [InventoryPage.tsx:352-360](packages/web/src/pages/InventoryPage.tsx:352):

```tsx
<Button ...onClick={() => setIncomingOpen(true)}>Incoming Fulls</Button>
<Button ...onClick={() => setOutgoingOpen(true)}>Outgoing Empties</Button>
<Button ...onClick={() => setAdjustOpen(true)}>Adjust Stock</Button>
```

Add `"Empties Return"` as a 4th button — same pattern, opens a modal picking customer + cylinderType + qty + date + optional notes.

**7.5 Past-date feasibility: yes.** Write `InventoryEvent.eventDate = <picked date>`, call `recalculateSummariesFromDate`. Only `is_locked` days silently skip the cascade write, which is correct behavior. Warn in the modal.

**7.6 Remove existing Returns Order?** Feasible:
- Web: `OrdersPage.tsx` — ~125 LOC in `ReturnsOrderModal` (1611-1736), trigger button (175-178), render (420).
- Mobile: `(admin)/orders.tsx` — ~85 LOC (2116-2200).
- API: `POST /api/orders/returns-only`, `POST /api/orders/:id/confirm-returns`, `orderService.createReturnsOrder` (~40 LOC), `confirmReturnsCollection` (~110 LOC), 2 Zod schemas.
- Also referenced in `reportsService.ts`, `deliveryWorkflowService.ts`, `inventoryService.ts`, `workflow.test.ts` — mostly filter/status-machine branches.

Rough total: **~400 LOC removable** if we retire the enum value; **~250 LOC** if we keep the enum for historical rows and just remove UI + create endpoint. Given prod has historical `orders.orderType='returns_only'` rows, keep the enum and prune UI+creation only.

**Complexity: small** (~1 day for a fresh empties-return modal + route + service + tests; +½ day if we also delete the existing Returns Order UI in the same PR).

> Needs prod run:
> ```sql
> SELECT COUNT(*) FROM orders
> WHERE distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
>   AND order_type = 'returns_only';
> SELECT COUNT(*), MAX(delivery_date) FROM orders
> WHERE order_type = 'returns_only' AND created_at > NOW() - INTERVAL '90 days';
> ```

---

## Item 8 — Overdue recompute on credit-period change

**Bug confirmed.** `invoice.dueDate` is a snapshot at creation; `updateCustomer` never cascades. Several aging-related readers use the stale `dueDate` and will disagree with the customer's current `creditPeriodDays`. The canonical "overdue amount" (dashboard KPI, order-gate) does NOT suffer from this — it recomputes live — but per-invoice aging, the `overdue` status badge, and the customer-statement aging buckets are stale.

### dueDate write logic (snapshotted from `customer.creditPeriodDays` at creation)

[invoiceService.ts:186-198](packages/api/src/services/invoiceService.ts:186) (`createInvoiceFromOrder`):

```ts
const issueDate = options?.issueDateOverride ?? new Date();
...
// Due date is creditPeriod days from the (possibly backdated) issueDate,
const dueDate = new Date(issueDate);
dueDate.setDate(dueDate.getDate() + (order.customer?.creditPeriodDays ?? 30));
```

`creditPeriodDays` comes from the `customer` include at :152 — read at that moment only, never referenced again for that invoice.

[invoiceService.ts:501](packages/api/src/services/invoiceService.ts:501) (`createManualInvoice`): `dueDate: new Date(data.dueDate)` — trusts the caller's precomputed value. Same snapshot semantics.

### customer.updateCustomer cascade behaviour — NONE

[customerService.ts:295](packages/api/src/services/customerService.ts:295):

```ts
if (data.creditPeriodDays !== undefined) updateData.creditPeriodDays = data.creditPeriodDays;
```

Whole function (189-320) shows one `tx.customer.update`, audit-trail rows, contacts, cylinder discounts — **no `tx.invoice.updateMany` and no re-derivation of `dueDate`**.

No cron rewrites `dueDate` either. `markOverdueInvoices` (`invoiceService.ts:845-859`) only flips `status: 'overdue'` and it too reads the stale `dueDate: { lt: new Date() }` predicate — so a bumped-up credit period will not "un-overdue" a customer whose window just expanded.

### Every reader — stored `dueDate` vs live recompute

| Reader | File:line | Reads |
|---|---|---|
| `computeCustomerOverdue` (dashboard KPI, order-gate, WI-122 canonical) | `paymentService.ts:774-852` | **LIVE** — reads `customer.creditPeriodDays` (:781) and `order.deliveryDate` (:820). Ignores `invoice.dueDate` entirely. Immune. |
| `getCustomerLedger` (summary.overdueAmount + per-row overDueAmount) | `paymentService.ts:471-505` | **LIVE** — uses `creditDays` from customer + `entry.entryDate`. Immune. |
| `getDueAmountsReport.overdueDue` | `analyticsService.ts:197` | LIVE (delegates to `computeCustomerOverdue`). |
| `getDueAmountsReport.overdueDays` age | `analyticsService.ts:200-203` | **STALE** — `now - new Date(inv.dueDate)`. |
| `getCustomerCollections.overdueDue` | `analyticsService.ts:418` | LIVE. |
| `getCustomerCollections.overdueDays` age | `analyticsService.ts:421-424` | **STALE** — `new Date(inv.dueDate)`. |
| `getOverdueCallList` (dashboard) | `analyticsService.ts:475-522` | **STALE** — filters + sorts by `dueDate: { lt: today }` and computes `daysOverdue` from `dueDate`. Bumping credit period does not remove the customer from this list. |
| Dashboard "Overdue Invoices count" | `analyticsService.ts:58` | **STALE** — counts `status: 'overdue'` rows (the flag set by `markOverdueInvoices`, which itself keys off `dueDate`). |
| `getBillingReport` per-invoice status | `reportsService.ts:987-1001` | **STALE** — `const dueDate = inv.dueDate; ... status === 'Overdue'`. `creditDays` is reverse-derived from `dueDate - issueDate`. |
| `getReceivablesAging` (0-30 / 31-60 / 60+ buckets) | `reportsService.ts:194-199` | **STALE** — buckets on `now - new Date(inv.dueDate)`. |
| Driver / customer statement aging | inherits `paymentService.getCustomerLedger` | LIVE. |
| Customer-portal dashboard, list, detail | `customerPortalService.ts:106` and mobile screens | reads the `status` flag (stale) + shows raw `dueDate` (snapshot) for display. |
| Invoice PDF | `pdf/invoicePdfService.ts:825-827` | **INTENTIONALLY STALE** — `formatDate(invoice.dueDate)` + `paymentTerms = 'Net ${cust.creditPeriodDays}'`. The two can disagree on the printed PDF. |
| Customer statement PDF header | `pdf/customerLedgerPdfService.ts:221` | Shows current `customer.creditPeriodDays` (live), body's overdue column from LIVE ledger. Self-consistent. |
| `markOverdueInvoices` cron/route | `invoiceService.ts:845-858` | **STALE** — `dueDate: { lt: new Date() }`. |

### Recommended fix — **Option B (per-read recompute), with a carve-out**

- **Keep `invoice.dueDate` frozen forever** at issuance. This preserves GST/PDF immutability and matches the "commercial invoice = fixed instrument" convention.
- For every **aging/status** reader currently keying off `invoice.dueDate`, switch to `derived = issueDate + customer.creditPeriodDays` at read time:
  - `analyticsService.ts` — `getDueAmountsReport.overdueDays`, `getCustomerCollections.overdueDays`, `getOverdueCallList` filter and sort, dashboard "Overdue Invoices count" (drop status flag, count from the derived formula).
  - `reportsService.ts` — `getReceivablesAging` buckets and `getBillingReport` per-row status.
  - `markOverdueInvoices` — either delete the job (WI-122 already labels it "supplementary") or rewrite to derive from customer join.
- Invoice PDF continues to render the stored `invoice.dueDate` — correct as an immutable legal document.

**Tradeoff:** Option A is one `updateMany` per credit-period change and every reader keeps working — but it violates invoice immutability and forces us to either regenerate PDFs (expensive, GST-risky) or accept a DB-vs-PDF drift. Option B touches ~6 reader sites but keeps the invoice a fixed instrument — matching how the canonical `computeCustomerOverdue` already works.

**Option B has a nice invariant:** readers use `customer.creditPeriodDays` LIVE, only stored piece consulted is `issueDate`. Intuitive: "change credit period → aging immediately reflects new period."

### Prod verification query

> Needs prod run:
> ```sql
> SELECT c.credit_period_days, i.due_date, i.issue_date,
>        i.outstanding_amount,
>        (i.issue_date + c.credit_period_days * INTERVAL '1 day') AS computed_due
> FROM customers c
> JOIN invoices i ON i.customer_id = c.id
> WHERE c.distributor_id = '6a749f20-5a82-4b74-9977-51eac69049f2'
>   AND i.outstanding_amount > 0
>   AND i.deleted_at IS NULL
> ORDER BY i.issue_date DESC
> LIMIT 10;
> ```
> Any row where `due_date <> computed_due` proves the snapshot drifted (credit period changed after issuance).

**Complexity: small–medium.** ~6 reader sites, each 3-5 line change to swap `inv.dueDate` for `inv.issueDate + customer.creditPeriodDays`. Plus two guard tests. Retire or rewrite `markOverdueInvoices`. Estimated 4–6 hours including tests. No migrations, no data backfill.

---

## Item 9 — Driver analytics

**Screens in `packages/mobile/app/(driver)/`:**
- `_layout.tsx` — Tabs config + SSE wiring.
- `analytics.tsx` — "My Performance" dashboard.
- `orders.tsx` — My Deliveries list.
- `trip.tsx` — Active trip screen.
- `inventory.tsx` — Vehicle Stock.
- `more.tsx` — Menu.
- `profile.tsx` — Profile (stack-only, hidden from tabs).
- `submit-payment.tsx` — Payment submission form (stack-only).
- `my-submissions.tsx` — Driver's own payment-submission history (stack-only).

**Current analytics screen: [analytics.tsx:62-70](packages/mobile/app/(driver)/analytics.tsx:62)** — hits `/analytics/driver-performance`:

```tsx
const { data: perfData, ... } = useApiQuery<DriverPerformanceRow[]>(
  ['driver-analytics-performance', dateFrom, dateTo],
  '/analytics/driver-performance',
  { dateFrom, dateTo },
);
```

**Server-side response builder** — [analyticsService.ts:278-313](packages/api/src/services/analyticsService.ts:278) (`getDriverDeliveryPerformance`). Returns only `totalOrders / deliveredOrders / cancelledOrders / deliveryRate` per driver — **no cylinder-type breakdown**.

**Data model support** — [schema.prisma:884-885](packages/api/prisma/schema.prisma:884):

```prisma
deliveredQuantity Int?    @map("delivered_quantity")
emptiesCollected  Int?    @map("empties_collected")
```

Order carries `driverId`, `deliveryDate`, `status`.

**Existing aggregation — YES for reports.** [reportsService.ts:290](packages/api/src/services/reportsService.ts:290) (`deliveryPerformance`) and `:635` (`deliveryPerformanceDrilldown`) already aggregate by (driver × cylinderType × customer) with `fullsDelivered / emptiesCollected / saleAmount`. Cyl-agg row shape at `:372`: `{ cylinderTypeId, cylinderTypeName, fullsDelivered, emptiesCollected, saleAmount }`. This is admin/reports only — not driver-scoped and not wired into the driver `/analytics/driver-performance` endpoint.

**Driver self-scoped endpoints under `/api/drivers/me/*`** ([driversVehicles.ts](packages/api/src/routes/driversVehicles.ts)): `/assignment`, `/events` (SSE), `/trip-stock`, `/trip-ewbs`, `/trip-sheet-pdf`, `/vehicle-inventory`, `/cancelled-stock`, `/orders`, `/payment-submissions`. **No `/summary` endpoint exists.**

**UI placement.** Tab bar already has 5 tabs (Analytics, My Deliveries, Trip, Vehicle Stock, More) — full per mobile CLAUDE.md ("max 5 items"). Add cyl-type cards **inside the existing analytics.tsx**, between `My Performance` metric grid (`:168-199`) and `Recent Payments Submitted` (`:205`). Reuse `DateInput` already present at `:144-163`. No new tab needed.

**What to build:**
- Backend: extend `getDriverDeliveryPerformance` (or add sibling `getDriverCylinderSummary(distributorId, driverId, dateFrom, dateTo)`) that groups OrderItems by `cylinderTypeId` where the parent Order is `(driverId, deliveryDate BETWEEN)` and `status IN ('delivered','modified_delivered')`, summing `deliveredQuantity ?? quantity` and `emptiesCollected`. Return `[{ cylinderTypeId, cylinderTypeName, fullsDelivered, emptiesCollected }]`. Reuse the driver-scoping guard at `routes/analytics.ts:83-90`. Wire-shape guard test.
- Mobile: new `useApiQuery` for `/analytics/driver-cylinder-summary` (or extended endpoint), render a grid of MetricCards or a table row-per-cyl-type below the existing metric grid.

**Complexity: small** (backend endpoint ~30 LOC + driver-scoping, one mobile query + grid, shape guard test).

---

## Item 10 — Driver payment settlement visibility

**Driver submission screen** — [(driver)/submit-payment.tsx:107-114](packages/mobile/app/(driver)/submit-payment.tsx:107):

```tsx
await apiPost('/drivers/me/payment-submissions', {
  customerId: effectiveCustomerId,
  amount: amt, paymentMethod: method, transactionDate,
  referenceNumber: referenceNumber || undefined,
  notes: notes || undefined,
});
```

Bulk lump sum against a single customer — **not per-invoice**. The driver picks a customer, enters an amount; the office decides allocation on approval.

**Table written: `PaymentSubmission`** (anti-pattern #23 — separate staging table, NOT `payment_transactions`). Route: [driversVehicles.ts:1002-1032](packages/api/src/routes/driversVehicles.ts:1002) calls `submissionService.createSubmission` with `submittedBy: 'driver'`, `submittedByDriverId: driver.id`.

**Approval endpoint** — [payments.ts:264-267](packages/api/src/routes/payments.ts:264):

```ts
router.post('/:id/verify',
  requireRole('super_admin', 'distributor_admin', 'finance'),
  validate(verifySubmissionSchema),
  auditLog('verify', 'payment_submission'),
```

`verifySubmissionSchema` takes optional `allocations: [{ invoiceId, amount }]`.

**Allocation creation** — [paymentSubmissionService.ts:276-319](packages/api/src/services/paymentSubmissionService.ts:276) (`verifySubmission`) wraps a `$transaction`:

```ts
const payment = await createPaymentInTx(tx, distributorId, verifiedByUserId, {
  customerId: submission.customerId,
  amount: toNum(submission.amount),
  paymentMethod: submission.paymentMethod,
  referenceNumber: submission.referenceNumber ?? undefined,
  transactionDate: submission.transactionDate.toISOString().slice(0, 10),
  allocations,
});
const updated = await tx.paymentSubmission.update({
  where: { id: submission.id },
  data: { status: 'verified', verifiedByUserId, verifiedAt: new Date(),
          resultingPaymentId: payment.id },
});
```

`createPaymentInTx` ([paymentService.ts:132-215](packages/api/src/services/paymentService.ts:132)) either applies the explicit `allocations` or auto-allocates to oldest outstanding invoices, calling `tx.paymentAllocation.create({ data: { paymentId, invoiceId, allocatedAmount } })` per invoice.

**Schema — the column already exists.** [schema.prisma:1420, 1430, 1439](packages/api/prisma/schema.prisma:1420):

```prisma
submittedByDriverId String? @map("submitted_by_driver_id")
resultingPaymentId  String? @unique @map("resulting_payment_id")
resultingPayment    PaymentTransaction? @relation(...)
```

`PaymentTransaction.allocations PaymentAllocation[]` at `:1358`; each `PaymentAllocation` has `invoiceId`, `allocatedAmount`, and relations to Invoice.

**My-submissions screen today** — [(driver)/my-submissions.tsx:97-131](packages/mobile/app/(driver)/my-submissions.tsx:97). Renders `customerName`, `amount`, `paymentMethod`, `transactionDate`, `status` badge, rejection reason on rejected rows. **Detail modal at `:135-197`** shows the same fields — has `resultingPaymentId` in the interface (`:38`) but never displays it or joins allocations.

**Backend gap.** [paymentSubmissionService.ts:209-236](packages/api/src/services/paymentSubmissionService.ts:209) (`listByDriver`) only includes `customer`:

```ts
prisma.paymentSubmission.findMany({
  where: { distributorId, submittedByDriverId: driverId },
  include: { customer: { select: { id: true, customerName: true } } },
  orderBy: { createdAt: 'desc' }, ...
});
```

No `resultingPayment` join, so allocations never flow to the driver.

**API change:** extend the include to
```ts
resultingPayment: { include: { allocations: { include: { invoice: { select: { id: true, invoiceNumber: true } } } } } }
```

Update `mapPaymentSubmission` ([utils/mappers.ts:477-491](packages/api/src/utils/mappers.ts:477)) to project `settledInvoices: [{ invoiceId, invoiceNumber, allocatedAmount }]` on verified rows. Add wire-shape guard per anti-pattern #9.

**Mobile change:** in `my-submissions.tsx` on verified rows, render an expanded list under the amount/method line ("Settled against: INV-… ₹450, INV-… ₹300"). Same block inside the detail modal.

**Complexity: small.**

> Needs prod run (real column names: `submitted_by_driver_id`, `resulting_payment_id`, `payment_id`, `allocated_amount`):
> ```sql
> SELECT ps.id, ps.status, ps.amount, ps.resulting_payment_id,
>        pa.invoice_id, i.invoice_number, pa.allocated_amount
> FROM payment_submissions ps
> LEFT JOIN payment_allocations pa ON pa.payment_id = ps.resulting_payment_id
> LEFT JOIN invoices i ON i.id = pa.invoice_id
> WHERE ps.submitted_by_driver_id = '<driver-uuid>'
>   AND ps.status = 'verified'
> ORDER BY ps.created_at DESC
> LIMIT 20;
> ```

---

## Item 11 — Orders list cylinder detail

**Web row today** — [OrdersPage.tsx:284, 305](packages/web/src/pages/OrdersPage.tsx:284):

```tsx
<th>Items</th>
...
<td>{order.items.length} items</td>
```

**Local `Order` type** — imports from `@gaslink/shared` (`packages/shared/src/types/index.ts:283-334`), which already carries `items: OrderItem[]` at `:324`. `OrderItem` (`:336-346`) has `cylinderTypeName`, `quantity`, `deliveredQuantity`, `emptiesCollected`. So the browser already has everything needed — nothing to change type-side.

**List endpoint include** — [orderService.ts:31-38](packages/api/src/services/orderService.ts:31):

```ts
const orderInclude = {
  customer: { select: { id: true, customerName: true, ... } },
  driver: { select: { id: true, driverName: true } },
  vehicle: { select: { id: true, vehicleNumber: true } },
  items: { include: { cylinderType: { select: { typeName: true } } } },
} satisfies Prisma.OrderInclude;
```

`listOrders` (`:40-84`) passes `include: orderInclude`. Wire already carries `items[].quantity`, `items[].deliveredQuantity`, `items[].cylinderType.typeName` (flat-aliased to `cylinderTypeName` via `mapOrder`).

**Conclusion: data already comes back. No backend change required.**

**Modified-delivered surface.** [schema.prisma:61](packages/api/prisma/schema.prisma:61) — `modified_delivered` is already a first-class `OrderStatus`. `orderStatusLabel/Variant` from `@gaslink/shared` map it to a badge — used at `OrdersPage.tsx:320-321`. Rendering follows the mobile analytics precedent at [(driver)/analytics.tsx:283-299](packages/mobile/app/(driver)/analytics.tsx:283):

```tsx
{order.items.map((item) => {
  const qty = order.status === 'modified_delivered' && item.deliveredQuantity && item.deliveredQuantity > 0
    ? item.deliveredQuantity : item.quantity;
  return `${item.cylinderTypeName} x${qty}`;
}).join(', ')}
```

For "Ordered vs Delivered" side-by-side, render a two-line cell when `status==='modified_delivered'`: "Ordered: 2× 19 KG · Delivered: 1× 19 KG".

**Page size / N+1.** `orderService.ts:65` — `pageSize = filters.pageSize || 25`. `items: { include: { cylinderType: { select: { typeName: true } } } }` is a single Prisma join per level — no N+1; adding zero extra queries.

**Sibling render sites:**
- `packages/web/src/pages/customer/OrdersPage.tsx:94` — customer portal orders list also uses `{ count: order.items.length }`; same fix applies.
- `packages/mobile/app/(admin)/orders.tsx:558-587` — admin mobile order card **already** does the cylinder-type breakdown (with a `showDelivered` toggle and modified-delivered handling) — no change needed.
- Driver `analytics.tsx:283-299` — same treatment, no change.

**Complexity: tiny.** Two JSX cells to update (`OrdersPage.tsx:305` and `customer/OrdersPage.tsx:94`), zero backend, no schema, no type-graph churn.

---

## Summary

| # | Item | Type | Complexity | Needs new app build? | Blocker? |
|---|------|------|------------|----------------------|----------|
| 1 | Customer picker back button + search on mobile | Bug (2 bugs) | small | **YES** (mobile) | No |
| 2 | Keyboard overlap on confirm-order modal | Bug | small–medium | **YES** (mobile) | No |
| 3 | Change password — voluntary flow | Missing feature (5 UI surfaces) | small | **YES** (mobile + web) | No |
| 4 | Users logged out on mobile (multi-device rotation) | Bug | medium (schema migration) | **YES** (mobile + backend) | No — impacts multi-device users only |
| 5 | Web network errors (EC2 investigation) | Unknown until prod logs run | tiny (if config) / small (if OOM) | **NO** (backend only) | **YES** — needs someone with prod EC2 SSH access to run the commands documented above |
| 6 | Backdated driver-trip bulk creation | New feature | medium (~2-3 days) | **YES** (web) | No |
| 7 | Simple empties-only return | New feature | small (~1 day) | **YES** (web) | No |
| 8 | Overdue recompute on credit-period change | Bug (6 stale readers, 1 stale cron) | small–medium (~4-6 hours) | **NO** (backend + web display) | No |
| 9 | Driver analytics — cylinder summary | New feature | small (~½ day) | **YES** (mobile) | No |
| 10 | Driver payment settlement visibility | New feature | small (~½ day) | **YES** (mobile) | No |
| 11 | Orders list — show cylinder detail | Enhancement (display only) | tiny (~1-2 hrs) | **YES** (web only) | No |

### Access blockers documented for the user

- **Prod EC2 SSH:** no public key on this dev box → cannot run item 5 commands here. Suneel (or whoever holds the `.pem`) needs to run the pm2/`free`/`df`/nginx-conf commands in the item 5 section.
- **Prod RDS:** dev DATABASE_URL points at local docker. The three `> Needs prod run:` SQL blocks (items 6.5, 7.6, 8.4, 10.3) need to be executed via the RDS bastion.

No code changes and no commits were made in this session.
