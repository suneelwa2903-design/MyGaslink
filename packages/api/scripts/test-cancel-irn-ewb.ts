/**
 * WI-084 live cancel verification.
 *
 * Creates one B2B order (Maruthi Agencies, 19 KG × 1), dispatches via
 * preflight (real NIC IRN + EWB), then cancels immediately.
 *
 * STEP 1  Create B2B order  — Maruthi Agencies, 19 KG × 1
 * STEP 2  Assign driver + preflight dispatch  → log IRN, EWB, invoiceNumber
 * STEP 3  Cancel the order
 * STEP 4  Inspect gst_api_logs: EWB_CANCEL and IRN_CANCEL raw NIC responses
 * STEP 5  Check DB state: invoice fields, gstDoc fields, pending actions
 * STEP 6  PASS / FAIL report
 *
 * Run:
 *   npx tsx packages/api/scripts/test-cancel-irn-ewb.ts
 * Requires: API on :5000, WhiteBooks sandbox reachable.
 */

import { prisma } from '../src/lib/prisma.js';

const BASE  = 'http://localhost:5000/api';
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

// ─── HTTP helper ──────────────────────────────────────────────────────────────
async function http(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

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

// ─── Utility: extract error string from raw NIC response ─────────────────────
function nicError(resp: any): string {
  if (!resp) return 'null response';
  if (resp.status_cd === '1' || resp.status_cd === 1) return 'success';
  try {
    const msg = resp?.error?.message ?? resp?.message ?? '';
    const parsed = JSON.parse(msg);
    return parsed.errorCodes ?? parsed.message ?? msg;
  } catch {
    return resp?.error?.message ?? resp?.message ?? JSON.stringify(resp).slice(0, 120);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}   WI-084 Cancel IRN + EWB  — Live NIC Sandbox Test     ${C.reset}`);
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  console.log(info(`Date: ${TODAY}   API: ${BASE}   Distributor: ${DIST}`));

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log(step(0, 'Authenticate'));
  const loginRes = await http('POST', '/auth/login', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  check('Login 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  const token: string = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken || '';
  check('Token present', !!token);
  if (!token) throw new Error('Cannot proceed without token');

  // ── Resolve DB entities ────────────────────────────────────────────────────
  console.log(step(0, 'Resolve dist-002 entities'));

  const maruthi = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
    select: { id: true, customerName: true, gstin: true, customerType: true },
  });
  console.log(info(`Customer: ${maruthi.customerName}  id=${maruthi.id}  type=${maruthi.customerType}  gstin=${maruthi.gstin}`));

  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: DIST, status: 'active', deletedAt: null },
    select: { id: true, driverName: true },
  });
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null, status: { not: 'inactive' } },
    select: { id: true, vehicleNumber: true, status: true },
  });
  const cylType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST, capacity: 19 },
    select: { id: true, typeName: true },
  });
  console.log(info(`Driver:  ${driver.driverName}  id=${driver.id}`));
  console.log(info(`Vehicle: ${vehicle.vehicleNumber}  id=${vehicle.id}  status=${vehicle.status}`));
  console.log(info(`CylType: ${cylType.typeName}  id=${cylType.id}`));

  // Upsert DVA (ensure assignment exists; set to dispatch_ready so preflight works)
  const dva = await prisma.driverVehicleAssignment.upsert({
    where: { driverId_assignmentDate_tripNumber: { driverId: driver.id, assignmentDate: new Date(TODAY), tripNumber: 1 } },
    create: {
      driverId: driver.id, vehicleId: vehicle.id,
      distributorId: DIST, assignmentDate: new Date(TODAY),
      tripNumber: 1, status: 'dispatch_ready',
    },
    update: {},  // do NOT reset an active trip — let preflight detect the state
  });
  console.log(info(`DVA id=${dva.id}  status=${dva.status}`));

  // ── STEP 1: Create order ───────────────────────────────────────────────────
  console.log(step(1, 'Create B2B order — Maruthi Agencies, 19 KG × 1'));
  const createRes = await http('POST', '/orders', {
    customerId: maruthi.id,
    deliveryDate: TODAY,
    items: [{ cylinderTypeId: cylType.id, quantity: 1 }],
  }, token);
  check('POST /orders → 201', createRes.status === 201, `HTTP ${createRes.status}`);
  const orderId: string = createRes.data?.data?.orderId || createRes.data?.data?.id || '';
  const orderNumber: string = createRes.data?.data?.orderNumber || '?';
  check('orderId returned', !!orderId, orderId);
  if (!orderId) throw new Error('Cannot proceed without orderId');
  console.log(info(`Order: ${orderNumber}  id=${orderId}`));

  // ── STEP 2: Assign driver + preflight dispatch ─────────────────────────────
  console.log(step(2, 'Assign driver → preflight dispatch (real NIC call)'));

  const assignRes = await http('POST', `/orders/${orderId}/assign-driver`, {
    driverId: driver.id, vehicleId: vehicle.id,
  }, token);
  check('Assign driver → 200', assignRes.status === 200, `HTTP ${assignRes.status}`);

  // Preflight: try fresh trip first; fall back to add-to-trip if ALREADY_DISPATCHED
  let preflightData: any;
  const preflightBody = { driverId: driver.id, assignmentDate: TODAY };
  try {
    const r = await http('POST', '/orders/preflight-dispatch', preflightBody, token);
    if (r.status === 400 && JSON.stringify(r.data).includes('ALREADY_DISPATCHED')) {
      console.log(info('Driver already dispatched — falling back to /preflight-add-to-trip'));
      const r2 = await http('POST', '/orders/preflight-add-to-trip', preflightBody, token);
      check('Preflight add-to-trip 200/207', r2.status === 200 || r2.status === 207, `HTTP ${r2.status}`);
      preflightData = r2.data?.data ?? r2.data;
    } else {
      check('Preflight dispatch 200/207', r.status === 200 || r.status === 207, `HTTP ${r.status}`);
      preflightData = r.data?.data ?? r.data;
    }
  } catch (e: any) {
    console.log(`${C.red}Preflight threw: ${e.message}${C.reset}`);
    preflightData = {};
  }

  // Find this order's preflight result
  const results: any[] = preflightData?.results ?? preflightData?.data?.results ?? [];
  const myResult = results.find((r: any) => r.orderId === orderId);
  if (myResult) {
    console.log(info(`Preflight result: success=${myResult.success}  mode=${myResult.mode ?? '?'}  irn=${myResult.irn ?? 'null'}  ewb=${myResult.ewbNo ?? 'null'}`));
    if (!myResult.success) {
      console.log(`  ${C.red}Preflight for our order failed: ${JSON.stringify(myResult.error ?? myResult.errorMessage ?? '')}${C.reset}`);
    }
  } else {
    console.log(info('Our order not in preflight results array (may be in a different results structure)'));
    console.log(info(`Full preflight data keys: ${Object.keys(preflightData ?? {}).join(', ')}`));
  }

  // Read order + invoice from DB
  const orderRow = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } },
  });
  check('Order status = pending_delivery', orderRow.status === 'pending_delivery', `actual: ${orderRow.status}`);

  const inv = orderRow.invoice;
  const invoiceId: string = inv?.id ?? '';
  check('Invoice created', !!invoiceId, invoiceId || 'missing');
  if (!invoiceId) throw new Error('Invoice not created — cannot proceed with cancel test');

  console.log(info(`Invoice: ${inv!.invoiceNumber}  irnStatus=${inv!.irnStatus}  ewbStatus=${inv!.ewbStatus}`));
  console.log(info(`IRN:     ${inv!.irn ? inv!.irn.slice(0, 32) + '…' : 'null'}`));

  check('IRN generated (irnStatus=success)', inv!.irnStatus === 'success', `actual: ${inv!.irnStatus}`);
  check('EWB active (ewbStatus=active)',     inv!.ewbStatus  === 'active',  `actual: ${inv!.ewbStatus}`);

  const gstDocBefore = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, deletedAt: null },
    select: { irn: true, irnStatus: true, ewbNo: true, ewbStatus: true },
  });
  console.log(info(`gstDoc before cancel: irnStatus=${gstDocBefore?.irnStatus}  ewbStatus=${gstDocBefore?.ewbStatus}  ewbNo=${gstDocBefore?.ewbNo ?? 'null'}`));

  // ── STEP 3: Cancel the order ───────────────────────────────────────────────
  console.log(step(3, 'Cancel the order'));
  const cancelRes = await http('POST', `/orders/${orderId}/cancel`, {
    reason: 'WI-084 cancel IRN+EWB E2E test',
  }, token);
  console.log(info(`Cancel response: HTTP ${cancelRes.status}  status=${cancelRes.data?.data?.status ?? cancelRes.data?.data?.orderStatus ?? '?'}`));
  if (cancelRes.status !== 200) {
    console.log(`  ${C.red}Cancel body: ${JSON.stringify(cancelRes.data).slice(0, 300)}${C.reset}`);
  }
  check('Cancel returns 200', cancelRes.status === 200, `HTTP ${cancelRes.status}`);

  // Brief pause to let async DB writes settle
  await new Promise(r => setTimeout(r, 500));

  // ── STEP 4: Inspect gst_api_logs ──────────────────────────────────────────
  console.log(step(4, 'Inspect gst_api_logs for cancel calls'));

  const allLogs = await prisma.gstApiLog.findMany({
    where: { invoiceId },
    orderBy: { createdAt: 'asc' },
    select: {
      apiType: true, status: true, httpStatus: true,
      errorCode: true, errorMessage: true,
      requestPayload: true, responsePayload: true,
      createdAt: true,
    },
  });

  console.log(info(`Total gst_api_logs for invoice: ${allLogs.length}`));
  console.log('');
  console.log(`  ${'Time'.padEnd(26)} ${'apiType'.padEnd(22)} ${'HTTP'.padEnd(6)} ${'status'.padEnd(10)} errorCode / detail`);
  console.log(`  ${'─'.repeat(90)}`);

  for (const log of allLogs) {
    const resp = log.responsePayload as any;
    const statusCd = resp?.status_cd ?? '?';
    const errDetail = log.status === 'success'
      ? `status_cd=${statusCd}`
      : `status_cd=${statusCd}  err=${nicError(resp).slice(0, 60)}`;
    const colour = log.status === 'success' ? C.green : C.red;
    console.log(
      `  ${log.createdAt.toISOString().replace('T', ' ').slice(0, 22).padEnd(26)}` +
      `${colour}${log.apiType.padEnd(22)}${C.reset}` +
      `${String(log.httpStatus ?? '?').padEnd(6)}` +
      `${log.status.padEnd(10)}` +
      `${errDetail}`,
    );
  }

  // Find cancel-specific logs
  const ewbCancelLog = allLogs.find(l => l.apiType === 'EWB_CANCEL');
  const irnCancelLog = allLogs.find(l => l.apiType === 'IRN_CANCEL');

  // Show raw NIC response bodies for cancel calls
  if (ewbCancelLog) {
    console.log(`\n${C.yellow}EWB_CANCEL raw NIC response:${C.reset}`);
    console.log('  ' + JSON.stringify(ewbCancelLog.responsePayload).slice(0, 400));
  } else {
    console.log(`\n${C.red}EWB_CANCEL log NOT FOUND in gst_api_logs${C.reset}`);
  }

  if (irnCancelLog) {
    console.log(`\n${C.yellow}IRN_CANCEL raw NIC response:${C.reset}`);
    console.log('  ' + JSON.stringify(irnCancelLog.responsePayload).slice(0, 400));
  } else {
    console.log(`\n${C.red}IRN_CANCEL log NOT FOUND in gst_api_logs${C.reset}`);
  }

  // ── STEP 5: Check DB state ─────────────────────────────────────────────────
  console.log(step(5, 'Check final DB state'));

  const invFinal = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { irnStatus: true, ewbStatus: true, status: true },
  });
  console.log(info(`invoice.status:    ${invFinal.status}`));
  console.log(info(`invoice.irnStatus: ${invFinal.irnStatus}`));
  console.log(info(`invoice.ewbStatus: ${invFinal.ewbStatus}`));

  const gstDocFinal = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, deletedAt: null },
    select: { irnStatus: true, ewbStatus: true, cancelledAt: true },
  });
  console.log(info(`gstDoc.irnStatus:  ${gstDocFinal?.irnStatus ?? 'null'}`));
  console.log(info(`gstDoc.ewbStatus:  ${gstDocFinal?.ewbStatus ?? 'null'}`));
  console.log(info(`gstDoc.cancelledAt:${gstDocFinal?.cancelledAt?.toISOString() ?? 'null'}`));

  const pendingActions = await prisma.pendingAction.findMany({
    where: { entityId: { in: [orderId, invoiceId] } },
    orderBy: { createdAt: 'desc' },
    select: { actionType: true, status: true, severity: true, description: true },
  });
  if (pendingActions.length > 0) {
    console.log(info(`PendingActions (${pendingActions.length}):`));
    for (const pa of pendingActions) {
      const colour = pa.status === 'resolved' ? C.green : C.yellow;
      console.log(`    ${colour}[${pa.severity}] ${pa.actionType}  status=${pa.status}  ${pa.description?.slice(0, 70) ?? ''}${C.reset}`);
    }
  } else {
    console.log(info('PendingActions: none (clean cancel)'));
  }

  // ── STEP 6: PASS / FAIL report ─────────────────────────────────────────────
  console.log(step(6, 'PASS / FAIL assertions'));
  console.log('');

  check(
    'EWB cancel attempted at NIC (EWB_CANCEL log exists)',
    !!ewbCancelLog,
    ewbCancelLog ? 'found' : 'not found',
  );
  check(
    'EWB cancelled at NIC (EWB_CANCEL status=success)',
    ewbCancelLog?.status === 'success',
    ewbCancelLog ? `status=${ewbCancelLog.status}  httpStatus=${ewbCancelLog.httpStatus}` : 'no log',
  );
  check(
    'IRN cancel attempted at NIC (IRN_CANCEL log exists)',
    !!irnCancelLog,
    irnCancelLog ? 'found' : 'not found',
  );
  check(
    'IRN cancelled at NIC (IRN_CANCEL status=success)',
    irnCancelLog?.status === 'success',
    irnCancelLog ? `status=${irnCancelLog.status}  httpStatus=${irnCancelLog.httpStatus}` : 'no log',
  );
  check(
    'invoice.irnStatus = cancelled',
    invFinal.irnStatus === 'cancelled',
    `actual: ${invFinal.irnStatus}`,
  );
  check(
    'invoice.ewbStatus = cancelled',
    invFinal.ewbStatus === 'cancelled',
    `actual: ${invFinal.ewbStatus}`,
  );
  check(
    'gstDoc.irnStatus = cancelled',
    gstDocFinal?.irnStatus === 'cancelled',
    `actual: ${gstDocFinal?.irnStatus ?? 'null'}`,
  );
  check(
    'gstDoc.ewbStatus = cancelled',
    gstDocFinal?.ewbStatus === 'cancelled',
    `actual: ${gstDocFinal?.ewbStatus ?? 'null'}`,
  );
  check(
    'No unresolved pending actions',
    !pendingActions.some(pa => pa.status !== 'resolved'),
    pendingActions.length === 0 ? 'no actions' : `${pendingActions.filter(p => p.status !== 'resolved').length} unresolved`,
  );

  // ── Final summary ──────────────────────────────────────────────────────────
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════${C.reset}`);
  const total = passed + failed;
  if (failed === 0) {
    console.log(`${C.bold}${C.green}  ALL ${total} CHECKS PASSED${C.reset}`);
  } else {
    console.log(`${C.bold}  ${total} checks  —  ${C.green}${passed} passed${C.reset}${C.bold}  ${C.red}${failed} FAILED${C.reset}`);
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
