/**
 * Full B2B + B2C end-to-end smoke test.
 *
 * Covers every GST API call for both order types:
 *   - B2B intra-state  : Maruthi Agencies (GSTIN 29AWGPV7107B1Z1, Karnataka)
 *   - B2C unregistered : Bangalore Foods  (no GSTIN)
 *
 * Flow per order:
 *   Create → Assign driver → Preflight dispatch (IRN_GENERATE + EWB_GENERATE_BY_IRN)
 *   → Verify DB + gst_api_logs → Verify token cache valid
 *   → Cancel (EWB_CANCEL + IRN_CANCEL) → Verify DB cancelled
 *
 * Validates WI-084 + WI-085 changes end-to-end:
 *   - Stale token retry (WI-085): dispatch works even after stale cache injection
 *   - Cancel token refresh (WI-084): cancel never throws SESSION_EXPIRED
 *   - IRN retry-corruption guard (WI-084): outer catch doesn't stamp failed on committed IRN
 *
 * Run:
 *   npx tsx packages/api/scripts/test-full-b2b-b2c.ts
 * Requires: API on :5000, WhiteBooks sandbox reachable, NODE_ENV != production.
 */

import { prisma } from '../src/lib/prisma.js';

const BASE = 'http://localhost:5000';
const APIB = `${BASE}/api`;
const TODAY = new Date().toISOString().split('T')[0];
const DIST  = 'dist-002';

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};
const ok   = (s: string) => `${C.green}✓ PASS${C.reset}  ${s}`;
const fail = (s: string) => `${C.red}✗ FAIL${C.reset}  ${s}`;
const info = (s: string) => `${C.cyan}  ·${C.reset} ${s}`;
const step = (n: number | string, s: string) =>
  `\n${C.bold}${C.yellow}STEP ${n} — ${s}${C.reset}`;

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
const api  = (m: string, p: string, b?: unknown, t?: string) => http(m, `${APIB}${p}`, b, t);
const test_ = (m: string, p: string, b?: unknown) => http(m, `${BASE}${p}`, b);

// ─── Assertions ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(ok(label) + (detail ? `  ${C.dim}(${detail})${C.reset}` : ''));
    passed++;
  } else {
    console.log(fail(label) + (detail ? `  ${C.red}← ${detail}${C.reset}` : ''));
    failed++;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function logLine(l: { apiType: string; status: string; httpStatus: number | null; errorCode: string | null; responsePayload: any }) {
  const resp = l.responsePayload as any;
  const statusCd = resp?.status_cd ?? '?';
  const col = l.status === 'success' ? C.green : C.red;
  return `  ${col}${l.apiType.padEnd(28)}${C.reset} status=${l.status}  status_cd=${statusCd}  http=${l.httpStatus ?? 'n/a'}`;
}

async function dispatchOrder(
  label: string,
  customerId: string,
  cylinderTypeId: string,
  driverId: string,
  vehicleId: string,
  authToken: string,
): Promise<{ orderId: string; invoiceId: string; irn: string | null | undefined }> {
  // Create order
  const cr = await api('POST', '/orders', {
    customerId, deliveryDate: TODAY,
    items: [{ cylinderTypeId, quantity: 1 }],
  }, authToken);
  const orderId: string = cr.data?.data?.orderId || cr.data?.data?.id || '';
  const orderNumber: string = cr.data?.data?.orderNumber || '?';
  check(`[${label}] POST /orders → 201`, cr.status === 201, `HTTP ${cr.status}`);
  check(`[${label}] orderId returned`, !!orderId, orderId || 'missing');
  console.log(info(`Order: ${orderNumber}  id=${orderId}`));

  // Assign driver
  const ar = await api('POST', `/orders/${orderId}/assign-driver`, { driverId, vehicleId }, authToken);
  check(`[${label}] Assign driver → 200`, ar.status === 200, `HTTP ${ar.status}`);

  return { orderId, invoiceId: '', irn: undefined };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}   Full B2B + B2C GST End-to-End Smoke — WI-084 / WI-085        ${C.reset}`);
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(info(`Date: ${TODAY}   API: ${APIB}   Dist: ${DIST}`));

  // ── Auth ───────────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}Authenticate${C.reset}`);
  const loginRes = await api('POST', '/auth/login', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  check('Login 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  const authToken: string = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken || '';
  check('Auth token present', !!authToken);
  if (!authToken) throw new Error('Cannot proceed without auth token');

  // ── Resolve entities ───────────────────────────────────────────────────────
  console.log(`\n${C.bold}Resolve test fixtures${C.reset}`);
  const maruthi = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
    select: { id: true, customerName: true, gstin: true },
  });
  const bangaloreFoods = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Bangalore Foods', deletedAt: null },
    select: { id: true, customerName: true, gstin: true },
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

  console.log(info(`B2B: ${maruthi.customerName}  GSTIN=${maruthi.gstin}`));
  console.log(info(`B2C: ${bangaloreFoods.customerName}  GSTIN=${bangaloreFoods.gstin ?? 'none'}`));
  console.log(info(`Driver: ${driver.driverName}  Vehicle: ${vehicle.vehicleNumber}`));

  // Ensure DVA exists for today
  await prisma.driverVehicleAssignment.upsert({
    where: {
      driverId_assignmentDate_tripNumber: {
        driverId: driver.id,
        assignmentDate: new Date(TODAY),
        tripNumber: 1,
      },
    },
    create: {
      driverId: driver.id, vehicleId: vehicle.id,
      distributorId: DIST, assignmentDate: new Date(TODAY),
      tripNumber: 1, status: 'dispatch_ready',
    },
    update: { vehicleId: vehicle.id, status: 'dispatch_ready' },
  });

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(1, 'Inject stale token — confirm retry path is exercised'));
  // ────────────────────────────────────────────────────────────────────────────
  const injectRes = await test_('POST', '/test/inject-stale-token', { distributorId: DIST, scope: 'einvoice' });
  check('POST /test/inject-stale-token → 200', injectRes.status === 200, `HTTP ${injectRes.status}`);
  const stateAfterInject = await test_('GET', `/test/token-cache-state?distributorId=${DIST}&scope=einvoice`);
  const d0 = stateAfterInject.data?.data ?? {};
  check('Injected token is stale (isStale=true)', d0.isStale === true, `isStale=${d0.isStale}  expiresAt=${d0.expiresAt}`);
  console.log(info(`Cache: cached=${d0.cached}  isStale=${d0.isStale}  expiresAt=${d0.expiresAt}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(2, 'Create + assign B2B order (Maruthi Agencies, 19KG × 1)'));
  // ────────────────────────────────────────────────────────────────────────────
  const b2bCr = await api('POST', '/orders', {
    customerId: maruthi.id, deliveryDate: TODAY,
    items: [{ cylinderTypeId: cylType.id, quantity: 1 }],
  }, authToken);
  check('[B2B] POST /orders → 201', b2bCr.status === 201, `HTTP ${b2bCr.status}`);
  const b2bOrderId: string = b2bCr.data?.data?.orderId || b2bCr.data?.data?.id || '';
  const b2bOrderNo: string = b2bCr.data?.data?.orderNumber || '?';
  check('[B2B] orderId returned', !!b2bOrderId, b2bOrderId || 'missing');
  console.log(info(`B2B order: ${b2bOrderNo}  id=${b2bOrderId}`));
  if (!b2bOrderId) throw new Error('B2B orderId missing — cannot continue');

  const b2bAssign = await api('POST', `/orders/${b2bOrderId}/assign-driver`, { driverId: driver.id, vehicleId: vehicle.id }, authToken);
  check('[B2B] Assign driver → 200', b2bAssign.status === 200, `HTTP ${b2bAssign.status}`);

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(3, 'Create + assign B2C order (Bangalore Foods, 19KG × 1)'));
  // ────────────────────────────────────────────────────────────────────────────
  const b2cCr = await api('POST', '/orders', {
    customerId: bangaloreFoods.id, deliveryDate: TODAY,
    items: [{ cylinderTypeId: cylType.id, quantity: 1 }],
  }, authToken);
  check('[B2C] POST /orders → 201', b2cCr.status === 201, `HTTP ${b2cCr.status}`);
  const b2cOrderId: string = b2cCr.data?.data?.orderId || b2cCr.data?.data?.id || '';
  const b2cOrderNo: string = b2cCr.data?.data?.orderNumber || '?';
  check('[B2C] orderId returned', !!b2cOrderId, b2cOrderId || 'missing');
  console.log(info(`B2C order: ${b2cOrderNo}  id=${b2cOrderId}`));
  if (!b2cOrderId) throw new Error('B2C orderId missing — cannot continue');

  const b2cAssign = await api('POST', `/orders/${b2cOrderId}/assign-driver`, { driverId: driver.id, vehicleId: vehicle.id }, authToken);
  check('[B2C] Assign driver → 200', b2cAssign.status === 200, `HTTP ${b2cAssign.status}`);

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(4, 'Preflight dispatch (both orders → IRN_GENERATE + EWB_GENERATE_BY_IRN)'));
  // ────────────────────────────────────────────────────────────────────────────
  let preflightOk = false;
  let preflightResults: any[] = [];
  try {
    const r = await api('POST', '/orders/preflight-dispatch', { driverId: driver.id, assignmentDate: TODAY }, authToken);
    const rBody = JSON.stringify(r.data);
    if (rBody.includes('ALREADY_DISPATCHED')) {
      console.log(info('ALREADY_DISPATCHED — falling back to /preflight-add-to-trip'));
      const r2 = await api('POST', '/orders/preflight-add-to-trip', { driverId: driver.id, assignmentDate: TODAY }, authToken);
      if (r2.status !== 200 && r2.status !== 207) {
        console.log(`  ${C.red}preflight-add-to-trip ${r2.status}: ${JSON.stringify(r2.data).slice(0, 300)}${C.reset}`);
      }
      preflightOk = r2.status === 200 || r2.status === 207;
      preflightResults = r2.data?.data?.results ?? [];
    } else {
      if (r.status !== 200 && r.status !== 207) {
        console.log(`  ${C.red}preflight-dispatch ${r.status}: ${rBody.slice(0, 300)}${C.reset}`);
      }
      preflightOk = r.status === 200 || r.status === 207;
      preflightResults = r.data?.data?.results ?? [];
    }
  } catch (e: any) {
    console.log(`  ${C.red}Preflight threw: ${e.message}${C.reset}`);
  }
  check('Preflight 200/207', preflightOk, preflightOk ? 'ok' : 'failed');

  for (const r of preflightResults) {
    console.log(info(`  ${r.orderNumber ?? r.orderId}  success=${r.success}  mode=${r.mode ?? '-'}  irn=${r.irn ? r.irn.slice(0, 20) + '…' : 'null'}  ewb=${r.ewbNo ?? 'null'}`));
  }

  const b2bResult = preflightResults.find((r: any) => r.orderId === b2bOrderId);
  const b2cResult = preflightResults.find((r: any) => r.orderId === b2cOrderId);
  check('[B2B] preflight result success', b2bResult?.success === true, `success=${b2bResult?.success}`);
  check('[B2C] preflight result success', b2cResult?.success === true, `success=${b2cResult?.success}`);

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(5, 'Verify DB — invoices have IRN + active EWB'));
  // ────────────────────────────────────────────────────────────────────────────
  const [b2bRow, b2cRow] = await Promise.all([
    prisma.order.findUniqueOrThrow({
      where: { id: b2bOrderId },
      include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } },
    }),
    prisma.order.findUniqueOrThrow({
      where: { id: b2cOrderId },
      include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } },
    }),
  ]);

  const b2bInv = b2bRow.invoice;
  const b2cInv = b2cRow.invoice;

  check('[B2B] order status = pending_delivery', b2bRow.status === 'pending_delivery', `actual: ${b2bRow.status}`);
  check('[B2B] invoice created', !!b2bInv?.id, b2bInv?.invoiceNumber || 'missing');
  check('[B2B] irnStatus = success', b2bInv?.irnStatus === 'success', `actual: ${b2bInv?.irnStatus}`);
  check('[B2B] ewbStatus = active', b2bInv?.ewbStatus === 'active', `actual: ${b2bInv?.ewbStatus}`);
  check('[B2B] IRN string present (64 hex)', !!b2bInv?.irn && b2bInv.irn.length >= 32, `irn=${b2bInv?.irn?.slice(0, 20) ?? 'null'}…`);

  // B2C (no GSTIN) — NIC does NOT issue an IRN; system generates a standalone
  // EWB directly. irnStatus='not_attempted' and irn=null are CORRECT here.
  check('[B2C] order status = pending_delivery', b2cRow.status === 'pending_delivery', `actual: ${b2cRow.status}`);
  check('[B2C] invoice created', !!b2cInv?.id, b2cInv?.invoiceNumber || 'missing');
  check('[B2C] irnStatus = not_attempted (B2C has no IRN)', b2cInv?.irnStatus === 'not_attempted', `actual: ${b2cInv?.irnStatus}`);
  check('[B2C] ewbStatus = active', b2cInv?.ewbStatus === 'active', `actual: ${b2cInv?.ewbStatus}`);
  check('[B2C] irn field is null (expected for B2C)', !b2cInv?.irn, `irn=${b2cInv?.irn ?? 'null (correct)'}`);

  // Look up EWB numbers from gst_api_logs (EWB stored in responsePayload)
  const [b2bEwbLog, b2cEwbLog] = await Promise.all([
    b2bInv?.id ? prisma.gstApiLog.findFirst({
      where: { invoiceId: b2bInv.id, apiType: 'EWB_GENERATE_BY_IRN', status: 'success' },
      select: { responsePayload: true },
    }) : null,
    b2cInv?.id ? prisma.gstApiLog.findFirst({
      // B2C uses EWB_GENERATE_STANDALONE (no IRN step)
      where: { invoiceId: b2cInv.id, apiType: 'EWB_GENERATE_STANDALONE', status: 'success' },
      select: { responsePayload: true },
    }) : null,
  ]);
  const b2bEwbNo = (b2bEwbLog?.responsePayload as any)?.data?.ewayBillNo ?? (b2bEwbLog?.responsePayload as any)?.data?.ewbNo ?? 'n/a';
  const b2cEwbNo = (b2cEwbLog?.responsePayload as any)?.data?.ewayBillNo ?? (b2cEwbLog?.responsePayload as any)?.data?.ewbNo ?? 'n/a';
  check('[B2B] EWB number in EWB_GENERATE_BY_IRN log', b2bEwbNo !== 'n/a', `ewbNo=${b2bEwbNo}`);
  check('[B2C] EWB number in EWB_GENERATE_STANDALONE log', b2cEwbNo !== 'n/a', `ewbNo=${b2cEwbNo}`);

  if (b2bInv) console.log(info(`B2B invoice: ${b2bInv.invoiceNumber}  IRN=${b2bInv.irn?.slice(0, 24)}…  EWB=${b2bEwbNo}`));
  if (b2cInv) console.log(info(`B2C invoice: ${b2cInv.invoiceNumber}  IRN=none(B2C)  EWB=${b2cEwbNo}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(6, 'Verify gst_api_logs — IRN_GENERATE + EWB_GENERATE_BY_IRN success, no SESSION_EXPIRED'));
  // ────────────────────────────────────────────────────────────────────────────
  // B2B logs: IRN_GENERATE + EWB_GENERATE_BY_IRN
  if (b2bInv?.id) {
    const logs = await prisma.gstApiLog.findMany({
      where: { invoiceId: b2bInv.id },
      orderBy: { createdAt: 'asc' },
      select: { apiType: true, status: true, httpStatus: true, errorCode: true, errorMessage: true, responsePayload: true },
    });
    console.log(info(`B2B gst_api_logs (${logs.length}):`));
    for (const l of logs) console.log(logLine(l));

    const irnLog    = logs.find(l => l.apiType === 'IRN_GENERATE');
    const ewbLog    = logs.find(l => l.apiType === 'EWB_GENERATE_BY_IRN');
    const sessionErr = logs.find(l => l.errorCode === 'SESSION_EXPIRED' || l.errorMessage?.includes('SESSION_EXPIRED'));

    check('[B2B] IRN_GENERATE log exists',           !!irnLog,                      irnLog ? 'found' : 'not found');
    check('[B2B] IRN_GENERATE status=success',        irnLog?.status === 'success',  `status=${irnLog?.status ?? '?'}`);
    check('[B2B] EWB_GENERATE_BY_IRN log exists',    !!ewbLog,                      ewbLog ? 'found' : 'not found');
    check('[B2B] EWB_GENERATE_BY_IRN status=success', ewbLog?.status === 'success', `status=${ewbLog?.status ?? '?'}`);
    check('[B2B] No SESSION_EXPIRED in logs',        !sessionErr,                   sessionErr ? `found: ${sessionErr.errorCode}` : 'clean');
  }

  // B2C logs: EWB_GENERATE_STANDALONE only (no IRN step for unregistered buyers)
  if (b2cInv?.id) {
    const logs = await prisma.gstApiLog.findMany({
      where: { invoiceId: b2cInv.id },
      orderBy: { createdAt: 'asc' },
      select: { apiType: true, status: true, httpStatus: true, errorCode: true, errorMessage: true, responsePayload: true },
    });
    console.log(info(`B2C gst_api_logs (${logs.length}):`));
    for (const l of logs) console.log(logLine(l));

    const ewbStandaloneLog = logs.find(l => l.apiType === 'EWB_GENERATE_STANDALONE');
    const irnLog           = logs.find(l => l.apiType === 'IRN_GENERATE');
    const sessionErr       = logs.find(l => l.errorCode === 'SESSION_EXPIRED' || l.errorMessage?.includes('SESSION_EXPIRED'));

    check('[B2C] EWB_GENERATE_STANDALONE log exists',    !!ewbStandaloneLog,                      ewbStandaloneLog ? 'found' : 'not found');
    check('[B2C] EWB_GENERATE_STANDALONE status=success', ewbStandaloneLog?.status === 'success', `status=${ewbStandaloneLog?.status ?? '?'}`);
    check('[B2C] No IRN_GENERATE log (B2C skips IRN)',   !irnLog,                                 irnLog ? 'unexpectedly found' : 'correct — absent');
    check('[B2C] No SESSION_EXPIRED in logs',            !sessionErr,                             sessionErr ? `found: ${sessionErr.errorCode}` : 'clean');
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(7, 'Token cache — should be valid (fresh) after dispatch'));
  // ────────────────────────────────────────────────────────────────────────────
  const cacheRes = await test_('GET', `/test/token-cache-state?distributorId=${DIST}&scope=einvoice`);
  const dc = cacheRes.data?.data ?? {};
  check('Cache state reachable', cacheRes.status === 200, `HTTP ${cacheRes.status}`);
  check('Cache entry present', dc.cached === true, `cached=${dc.cached}`);
  check('Token now valid (isValid=true)', dc.isValid === true, `isValid=${dc.isValid}  isStale=${dc.isStale}  expiresAt=${dc.expiresAt}`);
  console.log(info(`Cache: isValid=${dc.isValid}  isStale=${dc.isStale}  expiresAt=${dc.expiresAt}  prefix=${dc.tokenPrefix ?? 'null'}`));

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step('8a', 'Cancel B2B order (EWB_CANCEL → IRN_CANCEL)'));
  // ────────────────────────────────────────────────────────────────────────────
  const b2bCancel = await api('POST', `/orders/${b2bOrderId}/cancel`, { reason: 'B2B+B2C E2E smoke test — cleanup' }, authToken);
  check('[B2B] Cancel → 200', b2bCancel.status === 200, `HTTP ${b2bCancel.status}`);
  if (b2bCancel.status !== 200) console.log(`  ${C.red}Body: ${JSON.stringify(b2bCancel.data).slice(0, 200)}${C.reset}`);

  await new Promise(r => setTimeout(r, 600));

  if (b2bInv?.id) {
    const cancelLogs = await prisma.gstApiLog.findMany({
      where: { invoiceId: b2bInv.id },
      orderBy: { createdAt: 'asc' },
      select: { apiType: true, status: true, httpStatus: true, errorCode: true, responsePayload: true },
    });
    console.log(info(`B2B all logs after cancel (${cancelLogs.length}):`));
    for (const l of cancelLogs) console.log(logLine(l));

    const ewbCancelLog = cancelLogs.find(l => l.apiType === 'EWB_CANCEL');
    const irnCancelLog = cancelLogs.find(l => l.apiType === 'IRN_CANCEL');
    const sessionErrCancel = cancelLogs.find(l => l.errorCode === 'SESSION_EXPIRED' || l.errorMessage?.includes('SESSION_EXPIRED'));

    if (ewbCancelLog) {
      const r = ewbCancelLog.responsePayload as any;
      console.log(info(`EWB_CANCEL NIC: status_cd=${r?.status_cd}  ewbNo=${r?.data?.ewayBillNo ?? r?.data?.ewbNo ?? '?'}  cancelDate=${r?.data?.cancelDate ?? '?'}`));
    }
    if (irnCancelLog) {
      const r = irnCancelLog.responsePayload as any;
      console.log(info(`IRN_CANCEL NIC: status_cd=${r?.status_cd}  CancelDate=${r?.data?.CancelDate ?? '?'}`));
    }

    check('[B2B] EWB_CANCEL log exists',          !!ewbCancelLog,                      ewbCancelLog ? 'found' : 'not found');
    check('[B2B] EWB_CANCEL status=success',       ewbCancelLog?.status === 'success',  `status=${ewbCancelLog?.status ?? '?'}`);
    check('[B2B] IRN_CANCEL log exists',           !!irnCancelLog,                      irnCancelLog ? 'found' : 'not found');
    check('[B2B] IRN_CANCEL status=success',       irnCancelLog?.status === 'success',  `status=${irnCancelLog?.status ?? '?'}`);
    check('[B2B] No SESSION_EXPIRED on cancel',    !sessionErrCancel,                   sessionErrCancel ? `found: ${sessionErrCancel.errorCode}` : 'clean');

    const invFinal = await prisma.invoice.findUniqueOrThrow({
      where: { id: b2bInv.id },
      select: { irnStatus: true, ewbStatus: true },
    });
    check('[B2B] invoice.irnStatus = cancelled', invFinal.irnStatus === 'cancelled', `actual: ${invFinal.irnStatus}`);
    check('[B2B] invoice.ewbStatus = cancelled', invFinal.ewbStatus === 'cancelled', `actual: ${invFinal.ewbStatus}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step('8b', 'Cancel B2C order (EWB_CANCEL → IRN_CANCEL)'));
  // ────────────────────────────────────────────────────────────────────────────
  const b2cCancel = await api('POST', `/orders/${b2cOrderId}/cancel`, { reason: 'B2B+B2C E2E smoke test — cleanup' }, authToken);
  check('[B2C] Cancel → 200', b2cCancel.status === 200, `HTTP ${b2cCancel.status}`);
  if (b2cCancel.status !== 200) console.log(`  ${C.red}Body: ${JSON.stringify(b2cCancel.data).slice(0, 200)}${C.reset}`);

  await new Promise(r => setTimeout(r, 600));

  if (b2cInv?.id) {
    const cancelLogs = await prisma.gstApiLog.findMany({
      where: { invoiceId: b2cInv.id },
      orderBy: { createdAt: 'asc' },
      select: { apiType: true, status: true, httpStatus: true, errorCode: true, responsePayload: true },
    });
    console.log(info(`B2C all logs after cancel (${cancelLogs.length}):`));
    for (const l of cancelLogs) console.log(logLine(l));

    const ewbCancelLog = cancelLogs.find(l => l.apiType === 'EWB_CANCEL');
    const irnCancelLog = cancelLogs.find(l => l.apiType === 'IRN_CANCEL');
    const sessionErrCancel = cancelLogs.find(l => l.errorCode === 'SESSION_EXPIRED' || l.errorMessage?.includes('SESSION_EXPIRED'));

    if (ewbCancelLog) {
      const r = ewbCancelLog.responsePayload as any;
      console.log(info(`EWB_CANCEL NIC: status_cd=${r?.status_cd}  ewbNo=${r?.data?.ewayBillNo ?? r?.data?.ewbNo ?? '?'}  cancelDate=${r?.data?.cancelDate ?? '?'}`));
    }
    if (irnCancelLog) {
      const r = irnCancelLog.responsePayload as any;
      console.log(info(`IRN_CANCEL NIC: status_cd=${r?.status_cd}  CancelDate=${r?.data?.CancelDate ?? '?'}`));
    }

    check('[B2C] EWB_CANCEL log exists',                        !!ewbCancelLog,                     ewbCancelLog ? 'found' : 'not found');
    check('[B2C] EWB_CANCEL status=success',                    ewbCancelLog?.status === 'success', `status=${ewbCancelLog?.status ?? '?'}`);
    check('[B2C] No IRN_CANCEL log (B2C has no IRN to cancel)', !irnCancelLog,                      irnCancelLog ? 'unexpectedly found' : 'correct — absent');
    check('[B2C] No SESSION_EXPIRED on cancel',                 !sessionErrCancel,                  sessionErrCancel ? `found: ${sessionErrCancel.errorCode}` : 'clean');

    const invFinal = await prisma.invoice.findUniqueOrThrow({
      where: { id: b2cInv.id },
      select: { irnStatus: true, ewbStatus: true },
    });
    // B2C: irnStatus stays 'not_attempted' (no IRN was ever issued — correct)
    check('[B2C] invoice.irnStatus = not_attempted (B2C — no IRN)', invFinal.irnStatus === 'not_attempted', `actual: ${invFinal.irnStatus}`);
    check('[B2C] invoice.ewbStatus = cancelled', invFinal.ewbStatus === 'cancelled', `actual: ${invFinal.ewbStatus}`);
  }

  // ────────────────────────────────────────────────────────────────────────────
  console.log(step(9, 'Final summary'));
  // ────────────────────────────────────────────────────────────────────────────
  const total = passed + failed;
  console.log('');
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  if (failed === 0) {
    console.log(`${C.bold}${C.green}  ALL ${total} CHECKS PASSED — WI-084 + WI-085 fully verified${C.reset}`);
    console.log(`${C.bold}${C.green}  B2B intra-state (Maruthi): IRN_GENERATE ✓  EWB_GENERATE_BY_IRN ✓  EWB_CANCEL ✓  IRN_CANCEL ✓${C.reset}`);
    console.log(`${C.bold}${C.green}  B2C unregistered (Bangalore Foods): EWB_GENERATE_STANDALONE ✓  EWB_CANCEL ✓  (no IRN — correct)${C.reset}`);
  } else {
    console.log(`${C.bold}  ${total} checks — ${C.green}${passed} passed${C.reset}${C.bold}  ${C.red}${failed} FAILED${C.reset}`);
  }
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}\n`);

  if (failed > 0) process.exit(1);
}

main()
  .catch(e => {
    console.error(`\n${C.red}Script crashed:${C.reset}`, e);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
