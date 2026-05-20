/**
 * WI-085 token-retry integration test.
 *
 * Verifies the stale-token retry path added in WI-085:
 *   1. Inject a stale token into the server's einvoice cache for dist-002.
 *   2. Create a B2B order (Maruthi Agencies, 19 KG × 1) + preflight dispatch.
 *      The first getAuthToken call sees the expired cache entry, discards it,
 *      calls doAuthFetch → WhiteBooks → fresh token (retrying once if
 *      WhiteBooks returns a stale TokenExpiry). Dispatch must succeed.
 *   3. Verify gst_api_logs: IRN_GENERATE success, EWB_GENERATE_BY_IRN success,
 *      no SESSION_EXPIRED in the log set.
 *   4. Verify cache is now valid (expiresAt > now) after dispatch.
 *   5. Cancel the order (EWB → IRN). Verify both cancel calls succeed at NIC.
 *   6. PASS / FAIL report — all 6 steps must pass before WI-085 merges.
 *
 * Run:
 *   npx tsx packages/api/scripts/test-wi085-token-retry.ts
 * Requires: API on :5000, WhiteBooks sandbox reachable, NODE_ENV != production.
 */

import { prisma } from '../src/lib/prisma.js';

const BASE  = 'http://localhost:5000';
const APIB  = `${BASE}/api`;
const TODAY = new Date().toISOString().split('T')[0];
const DIST  = 'dist-002';

// ─── Colours ──────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};
const ok   = (s: string) => `${C.green}✓ PASS${C.reset}  ${s}`;
const fail = (s: string) => `${C.red}✗ FAIL${C.reset}  ${s}`;
const info = (s: string) => `${C.cyan}  ·${C.reset} ${s}`;
const step = (n: number, s: string) => `\n${C.bold}${C.yellow}STEP ${n} — ${s}${C.reset}`;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
async function http(method: string, url: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(url, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

const api = (method: string, path: string, body?: unknown, token?: string) =>
  http(method, `${APIB}${path}`, body, token);

const test_ = (method: string, path: string, body?: unknown) =>
  http(method, `${BASE}${path}`, body);

// ─── Assertions ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(ok(label) + (detail ? `  ${C.dim}(${detail})${C.reset}` : ''));
    passed++;
  } else {
    console.log(fail(label) + (detail ? `  ${C.red}← ${detail}${C.reset}` : ''));
    failed++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}   WI-085 — Stale Token Retry  + Cancel  End-to-End     ${C.reset}`);
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(info(`Date: ${TODAY}   API: ${APIB}   Dist: ${DIST}`));

  // ── Auth ───────────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}Authenticate${C.reset}`);
  const loginRes = await api('POST', '/auth/login', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  check('Login 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  const token: string = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken || '';
  check('Token present', !!token);
  if (!token) throw new Error('Cannot proceed without token');

  // ── Resolve entities ───────────────────────────────────────────────────────
  const maruthi = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
    select: { id: true },
  });
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: DIST, status: 'active', deletedAt: null },
    select: { id: true, driverName: true },
  });
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null, status: { not: 'inactive' } },
    select: { id: true, vehicleNumber: true },
  });
  const cylType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, capacity: 19 },
    select: { id: true },
  });
  await prisma.driverVehicleAssignment.upsert({
    where: { driverId_assignmentDate_tripNumber: { driverId: driver.id, assignmentDate: new Date(TODAY), tripNumber: 1 } },
    create: {
      driverId: driver.id, vehicleId: vehicle.id,
      distributorId: DIST, assignmentDate: new Date(TODAY),
      tripNumber: 1, status: 'dispatch_ready',
    },
    update: {},
  });
  console.log(info(`Driver: ${driver.driverName}  Vehicle: ${vehicle.vehicleNumber}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(1, 'Force stale einvoice token into server cache'));
  // ────────────────────────────────────────────────────────────────────────────

  const injectRes = await test_('POST', '/test/inject-stale-token', { distributorId: DIST, scope: 'einvoice' });
  check('POST /test/inject-stale-token → 200', injectRes.status === 200, `HTTP ${injectRes.status}`);
  if (injectRes.status !== 200) {
    console.log(`  ${C.red}Response: ${JSON.stringify(injectRes.data).slice(0, 200)}${C.reset}`);
    throw new Error('inject-stale-token endpoint failed — is NODE_ENV !== production and API restarted after build?');
  }
  console.log(info(`injected token prefix: ${injectRes.data?.data?.tokenPrefix ?? '?'}`));
  console.log(info(`expiresAt: ${injectRes.data?.data?.expiresAt ?? '?'}`));

  // Verify it's stale via cache-state endpoint
  const stateAfterInject = await test_('GET', `/test/token-cache-state?distributorId=${DIST}&scope=einvoice`);
  check('Cache state reachable', stateAfterInject.status === 200, `HTTP ${stateAfterInject.status}`);
  const d1 = stateAfterInject.data?.data ?? {};
  check('Cache entry exists after injection', d1.cached === true, `cached=${d1.cached}`);
  check('Injected token is stale (expiresAt < now)', d1.isStale === true, `isStale=${d1.isStale}  expiresAt=${d1.expiresAt}`);
  console.log(info(`cache: cached=${d1.cached}  isValid=${d1.isValid}  isStale=${d1.isStale}  expiresAt=${d1.expiresAt ?? 'null'}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(2, 'Create B2B order + preflight dispatch (cache evicts → re-auth → should succeed)'));
  // ────────────────────────────────────────────────────────────────────────────

  const createRes = await api('POST', '/orders', {
    customerId: maruthi.id, deliveryDate: TODAY,
    items: [{ cylinderTypeId: cylType.id, quantity: 1 }],
  }, token);
  check('POST /orders → 201', createRes.status === 201, `HTTP ${createRes.status}`);
  const orderId: string = createRes.data?.data?.orderId || createRes.data?.data?.id || '';
  const orderNumber: string = createRes.data?.data?.orderNumber || '?';
  check('orderId returned', !!orderId, orderId);
  if (!orderId) throw new Error('Cannot proceed without orderId');
  console.log(info(`Order: ${orderNumber}  id=${orderId}`));

  const assignRes = await api('POST', `/orders/${orderId}/assign-driver`, {
    driverId: driver.id, vehicleId: vehicle.id,
  }, token);
  check('Assign driver → 200', assignRes.status === 200, `HTTP ${assignRes.status}`);

  // Preflight (handles ALREADY_DISPATCHED by falling back to add-to-trip)
  let preflightOk = false;
  let preflightResults: any[] = [];
  try {
    const r = await api('POST', '/orders/preflight-dispatch', { driverId: driver.id, assignmentDate: TODAY }, token);
    if (r.status === 400 && JSON.stringify(r.data).includes('ALREADY_DISPATCHED')) {
      console.log(info('ALREADY_DISPATCHED — falling back to /preflight-add-to-trip'));
      const r2 = await api('POST', '/orders/preflight-add-to-trip', { driverId: driver.id, assignmentDate: TODAY }, token);
      preflightOk = r2.status === 200 || r2.status === 207;
      preflightResults = r2.data?.data?.results ?? [];
    } else {
      preflightOk = r.status === 200 || r.status === 207;
      preflightResults = r.data?.data?.results ?? [];
    }
  } catch (e: any) {
    console.log(`  ${C.red}Preflight threw: ${e.message}${C.reset}`);
  }
  check('Preflight dispatch 200/207', preflightOk, preflightOk ? 'ok' : 'failed');

  const myResult = preflightResults.find((r: any) => r.orderId === orderId);
  if (myResult) {
    console.log(info(`Preflight result: success=${myResult.success}  mode=${myResult.mode}  irn=${myResult.irn ?? 'null'}  ewb=${myResult.ewbNo ?? 'null'}`));
  }

  // Read invoice from DB
  const orderRow = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } },
  });
  check('Order pending_delivery', orderRow.status === 'pending_delivery', `actual: ${orderRow.status}`);
  const inv = orderRow.invoice;
  const invoiceId = inv?.id ?? '';
  check('Invoice created', !!invoiceId, invoiceId || 'missing');
  if (invoiceId) {
    console.log(info(`Invoice: ${inv!.invoiceNumber}  irnStatus=${inv!.irnStatus}  ewbStatus=${inv!.ewbStatus}`));
    console.log(info(`IRN: ${inv!.irn ? inv!.irn.slice(0, 32) + '…' : 'null'}`));
  }
  check('IRN generated (irnStatus=success)', inv?.irnStatus === 'success', `actual: ${inv?.irnStatus}`);
  check('EWB active (ewbStatus=active)',     inv?.ewbStatus  === 'active',  `actual: ${inv?.ewbStatus}`);

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(3, 'Verify gst_api_logs — no SESSION_EXPIRED, both generate calls success'));
  // ────────────────────────────────────────────────────────────────────────────

  const genLogs = invoiceId ? await prisma.gstApiLog.findMany({
    where: { invoiceId },
    orderBy: { createdAt: 'asc' },
    select: { apiType: true, status: true, httpStatus: true, errorCode: true, errorMessage: true, createdAt: true, responsePayload: true },
  }) : [];

  console.log(info(`gst_api_logs for invoice (${genLogs.length} entries):`));
  const logLine = (l: typeof genLogs[0]) => {
    const resp = l.responsePayload as any;
    const statusCd = resp?.status_cd ?? '?';
    const col = l.status === 'success' ? C.green : C.red;
    return `  ${col}${l.apiType.padEnd(24)}${C.reset} status=${l.status}  status_cd=${statusCd}  httpStatus=${l.httpStatus ?? 'n/a'}`;
  };
  for (const l of genLogs) console.log(logLine(l));

  const irnGenLog = genLogs.find(l => l.apiType === 'IRN_GENERATE');
  const ewbGenLog = genLogs.find(l => l.apiType === 'EWB_GENERATE_BY_IRN');
  const sessionExpiredLog = genLogs.find(l => l.errorCode === 'SESSION_EXPIRED' || l.errorMessage?.includes('SESSION_EXPIRED'));

  check('IRN_GENERATE log exists',             !!irnGenLog,                    irnGenLog ? 'found' : 'not found');
  check('IRN_GENERATE status=success',          irnGenLog?.status === 'success', `status=${irnGenLog?.status ?? '?'}`);
  check('EWB_GENERATE_BY_IRN log exists',      !!ewbGenLog,                    ewbGenLog ? 'found' : 'not found');
  check('EWB_GENERATE_BY_IRN status=success',  ewbGenLog?.status === 'success', `status=${ewbGenLog?.status ?? '?'}`);
  check('No SESSION_EXPIRED in logs',          !sessionExpiredLog,             sessionExpiredLog ? `found: ${sessionExpiredLog.errorCode}` : 'clean');

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(4, 'Check token cache — should be valid (fresh) after dispatch'));
  // ────────────────────────────────────────────────────────────────────────────

  const stateAfterDispatch = await test_('GET', `/test/token-cache-state?distributorId=${DIST}&scope=einvoice`);
  check('Cache state reachable', stateAfterDispatch.status === 200, `HTTP ${stateAfterDispatch.status}`);
  const d2 = stateAfterDispatch.data?.data ?? {};
  check('Cache entry present after dispatch', d2.cached === true,  `cached=${d2.cached}`);
  check('Token now valid (expiresAt > now)',   d2.isValid === true, `isValid=${d2.isValid}  isStale=${d2.isStale}  expiresAt=${d2.expiresAt ?? 'null'}`);
  console.log(info(`cache after dispatch: isValid=${d2.isValid}  isStale=${d2.isStale}  tokenPrefix=${d2.tokenPrefix ?? 'null'}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(5, 'Cancel the order — EWB cancel then IRN cancel'));
  // ────────────────────────────────────────────────────────────────────────────

  if (!invoiceId) {
    console.log(`  ${C.yellow}Skipping cancel — no invoice${C.reset}`);
  } else {
    const cancelRes = await api('POST', `/orders/${orderId}/cancel`, {
      reason: 'WI-085 token-retry E2E test',
    }, token);
    console.log(info(`Cancel HTTP ${cancelRes.status}  status=${cancelRes.data?.data?.status ?? '?'}`));
    if (cancelRes.status !== 200) {
      console.log(`  ${C.red}Cancel body: ${JSON.stringify(cancelRes.data).slice(0, 200)}${C.reset}`);
    }
    check('Cancel returns 200', cancelRes.status === 200, `HTTP ${cancelRes.status}`);

    await new Promise(r => setTimeout(r, 400));

    const cancelLogs = await prisma.gstApiLog.findMany({
      where: { invoiceId },
      orderBy: { createdAt: 'asc' },
      select: { apiType: true, status: true, httpStatus: true, errorCode: true, responsePayload: true },
    });
    console.log(info(`All gst_api_logs for invoice (${cancelLogs.length} total):`));
    for (const l of cancelLogs) console.log(logLine(l));

    const ewbCancelLog = cancelLogs.find(l => l.apiType === 'EWB_CANCEL');
    const irnCancelLog = cancelLogs.find(l => l.apiType === 'IRN_CANCEL');

    if (ewbCancelLog) {
      const resp = ewbCancelLog.responsePayload as any;
      console.log(info(`EWB_CANCEL NIC response: status_cd=${resp?.status_cd}  ewbNo=${resp?.data?.ewayBillNo ?? '?'}  cancelDate=${resp?.data?.cancelDate ?? '?'}`));
    }
    if (irnCancelLog) {
      const resp = irnCancelLog.responsePayload as any;
      console.log(info(`IRN_CANCEL NIC response: status_cd=${resp?.status_cd}  cancelDate=${resp?.data?.CancelDate ?? '?'}`));
    }

    check('EWB_CANCEL log exists',            !!ewbCancelLog,                     ewbCancelLog ? 'found' : 'not found');
    check('EWB_CANCEL status=success',         ewbCancelLog?.status === 'success', `status=${ewbCancelLog?.status ?? '?'}`);
    check('IRN_CANCEL log exists',             !!irnCancelLog,                     irnCancelLog ? 'found' : 'not found');
    check('IRN_CANCEL status=success',         irnCancelLog?.status === 'success', `status=${irnCancelLog?.status ?? '?'}`);

    // Final DB state
    const invFinal = await prisma.invoice.findUniqueOrThrow({
      where: { id: invoiceId },
      select: { irnStatus: true, ewbStatus: true },
    });
    check('invoice.irnStatus=cancelled', invFinal.irnStatus === 'cancelled', `actual: ${invFinal.irnStatus}`);
    check('invoice.ewbStatus=cancelled', invFinal.ewbStatus === 'cancelled', `actual: ${invFinal.ewbStatus}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(6, 'Final summary'));
  // ────────────────────────────────────────────────────────────────────────────

  console.log('');
  const total = passed + failed;
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  if (failed === 0) {
    console.log(`${C.bold}${C.green}  ALL ${total} CHECKS PASSED — WI-085 clears to merge${C.reset}`);
  } else {
    console.log(`${C.bold}  ${total} checks  —  ${C.green}${passed} passed${C.reset}${C.bold}  ${C.red}${failed} FAILED — do NOT merge${C.reset}`);
  }
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}\n`);

  if (failed > 0) process.exit(1);
}

main()
  .catch(e => {
    console.error(`\n${C.red}Script crashed:${C.reset}`, e);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
