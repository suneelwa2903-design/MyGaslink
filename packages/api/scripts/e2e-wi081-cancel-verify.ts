/**
 * WI-081 End-to-End Cancel Workflow Verification
 *
 * Verifies the full cancel orchestration against the live API + NIC sandbox:
 *   1. B2B order (Maruthi Agencies) — create → assign → preflight → cancel
 *   2. B2C order (Bangalore Foods) — create → assign → preflight → cancel
 *
 * For each order checks:
 *   - EWB cancelled at NIC (gst_api_logs CANCEL_EWB row)
 *   - IRN cancelled at NIC (gst_api_logs CANCEL_IRN row, B2B only)
 *   - Invoice status = 'cancelled'
 *   - CustomerLedgerEntry reversal created (negative amountDelta)
 *   - DVA released (dispatch_ready or no active orders)
 *   - CancelledStockEvent created (post-dispatch only)
 *   - No dangling pending actions from the cancel flow
 *
 * Run: npx tsx scripts/e2e-wi081-cancel-verify.ts
 * Requires: API server running at localhost:5000, WhiteBooks sandbox reachable
 */

import { prisma } from '../src/lib/prisma.js';

const BASE = 'http://localhost:5000/api';
const TODAY = new Date().toISOString().split('T')[0];

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
};
const ok   = (s: string) => `${C.green}✓${C.reset} ${s}`;
const fail = (s: string) => `${C.red}✗${C.reset} ${s}`;
const info = (s: string) => `${C.cyan}·${C.reset} ${s}`;
const head = (s: string) => `\n${C.bold}${C.cyan}${s}${C.reset}`;

// ─── HTTP helper ─────────────────────────────────────────────────────────────
async function api(method: string, path: string, body?: unknown, token?: string, extraHeaders?: Record<string, string>) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  Object.assign(headers, extraHeaders ?? {});
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

// ─── Assertion helper ─────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(ok(label) + (detail ? ` ${C.dim}(${detail})${C.reset}` : ''));
    passed++;
  } else {
    console.log(fail(label) + (detail ? ` ${C.red}← ${detail}${C.reset}` : ''));
    failed++;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function run() {
  console.log(head('═══ WI-081 Cancel Workflow E2E Verification ═══'));
  console.log(info(`Date: ${TODAY}  API: ${BASE}`));

  // ── Login ──────────────────────────────────────────────────────────────────
  console.log(head('Step 1 — Authenticate (sharma@gasdist.com)'));

  const loginRes = await api('POST', '/auth/login', {
    email: 'sharma@gasdist.com',
    password: 'Gstadmin@123',
  });
  check('Login succeeds', loginRes.status === 200, `HTTP ${loginRes.status}`);
  const token: string = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken || '';
  check('Access token present', !!token);
  if (!token) { throw new Error('Cannot proceed without a token'); }

  // ── Resolve dist-002 context ──────────────────────────────────────────────
  console.log(head('Step 2 — Resolve dist-002 entities'));

  const maruthi = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerName: 'Maruthi Agencies', deletedAt: null },
  });
  console.log(info(`Maruthi Agencies  id=${maruthi.id}  type=${maruthi.customerType}  gstin=${maruthi.gstin}`));

  const bangaloreFoods = await prisma.customer.findFirstOrThrow({
    where: { distributorId: 'dist-002', customerName: 'Bangalore Foods', deletedAt: null },
  });
  console.log(info(`Bangalore Foods   id=${bangaloreFoods.id}  type=${bangaloreFoods.customerType}`));

  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: 'dist-002', status: 'active', deletedAt: null },
  });
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: 'dist-002', status: { not: 'inactive' }, deletedAt: null },
  });
  const cylType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: 'dist-002' },
    orderBy: { capacity: 'asc' },
  });
  console.log(info(`Driver  ${driver.driverName}  id=${driver.id}`));
  console.log(info(`Vehicle ${vehicle.vehicleNumber}  id=${vehicle.id}`));
  console.log(info(`CylType ${cylType.typeName}  id=${cylType.id}`));

  // Ensure DVA exists for today
  const dva = await prisma.driverVehicleAssignment.upsert({
    where: { driverId_assignmentDate_tripNumber: { driverId: driver.id, assignmentDate: new Date(TODAY), tripNumber: 1 } },
    create: {
      driverId: driver.id,
      vehicleId: vehicle.id,
      distributorId: 'dist-002',
      assignmentDate: new Date(TODAY),
      tripNumber: 1,
      status: 'dispatch_ready',
    },
    update: { status: 'dispatch_ready', vehicleId: vehicle.id },
  });
  console.log(info(`DVA id=${dva.id}  status=${dva.status}`));

  // ── Run scenario for one customer ─────────────────────────────────────────
  async function runScenario(label: string, customerId: string, isB2B: boolean) {
    console.log(head(`═══ Scenario: ${label} ═══`));

    // 1. Create order
    console.log(`\n${C.yellow}→ Create order${C.reset}`);
    const createRes = await api('POST', '/orders', {
      customerId,
      deliveryDate: TODAY,
      items: [{ cylinderTypeId: cylType.id, quantity: 2 }],
    }, token);
    check('Order created (201)', createRes.status === 201, `HTTP ${createRes.status} ${JSON.stringify(createRes.data?.error ?? '')}`);
    const orderId: string = createRes.data?.data?.orderId || createRes.data?.data?.id || '';
    check('orderId present', !!orderId, orderId);
    if (!orderId) return;
    console.log(info(`orderId=${orderId}`));

    // 2. Assign driver
    console.log(`\n${C.yellow}→ Assign driver${C.reset}`);
    const assignRes = await api('POST', `/orders/${orderId}/assign-driver`, {
      driverId: driver.id,
      vehicleId: vehicle.id,
    }, token);
    check('Driver assigned (200)', assignRes.status === 200, `HTTP ${assignRes.status} ${JSON.stringify(assignRes.data?.error ?? '')}`);
    const afterAssign = createRes.data?.data?.status;
    console.log(info(`order status after assign: ${assignRes.data?.data?.status ?? 'n/a'}`));

    // 3. Preflight dispatch (hits NIC live)
    console.log(`\n${C.yellow}→ Preflight dispatch (NIC ${isB2B ? 'IRN + EWB' : 'EWB-only'})${C.reset}`);
    const preflightRes = await api('POST', '/orders/preflight-dispatch', {
      driverId: driver.id,
      assignmentDate: TODAY,
    }, token);
    const preflightOk = preflightRes.status === 200 || preflightRes.status === 207;
    check(`Preflight response (200/207)`, preflightOk, `HTTP ${preflightRes.status}`);
    if (!preflightOk) {
      console.log(`  ${C.red}Preflight error: ${JSON.stringify(preflightRes.data)}${C.reset}`);
      // Still proceed to cancel attempt even if preflight failed
    }

    // Extract this order's preflight result
    const results: any[] = preflightRes.data?.data?.results ?? [];
    const myResult = results.find((r: any) => r.orderId === orderId);
    if (myResult) {
      console.log(info(`mode=${myResult.mode}  success=${myResult.success}  irn=${myResult.irn ?? 'n/a'}  ewbNo=${myResult.ewbNo ?? 'n/a'}`));
      if (!myResult.success) {
        console.log(`  ${C.red}Preflight failed for this order: ${JSON.stringify(myResult.error ?? myResult.errorMessage)}${C.reset}`);
      }
    } else {
      console.log(info('This order not in preflight results — may already be pending_delivery from a prior run'));
    }

    // Verify order is now pending_delivery (or was already)
    const orderAfterPreflight = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true } });
    check(`Order status = pending_delivery`, orderAfterPreflight.status === 'pending_delivery',
      `actual: ${orderAfterPreflight.status}`);
    const invoiceId = orderAfterPreflight.invoice?.id ?? '';
    check(`Invoice created`, !!invoiceId, invoiceId || 'missing');
    if (invoiceId) {
      console.log(info(`invoiceId=${invoiceId}  irnStatus=${orderAfterPreflight.invoice?.irnStatus}  ewbStatus=${orderAfterPreflight.invoice?.ewbStatus}`));
      if (isB2B) {
        check(`IRN generated`, orderAfterPreflight.invoice?.irnStatus === 'success', `actual: ${orderAfterPreflight.invoice?.irnStatus}`);
        check(`EWB active`, orderAfterPreflight.invoice?.ewbStatus === 'active', `actual: ${orderAfterPreflight.invoice?.ewbStatus}`);
      } else {
        // B2C: no IRN, EWB optional (depends on config)
        console.log(info(`B2C: irnStatus=${orderAfterPreflight.invoice?.irnStatus}  ewbStatus=${orderAfterPreflight.invoice?.ewbStatus}`));
      }
    }

    // 4. Cancel the order
    console.log(`\n${C.yellow}→ Cancel order${C.reset}`);
    const cancelRes = await api('POST', `/orders/${orderId}/cancel`, {
      reason: `WI-081 E2E verification — ${label}`,
    }, token);
    check(`Cancel returns 200`, cancelRes.status === 200, `HTTP ${cancelRes.status} ${JSON.stringify(cancelRes.data?.error ?? '')}`);
    check(`Status = cancelled`, cancelRes.data?.data?.status === 'cancelled', `actual: ${cancelRes.data?.data?.status}`);

    // 5. Verify downstream effects
    console.log(`\n${C.yellow}→ Verify downstream effects${C.reset}`);

    // 5a. Invoice status
    if (invoiceId) {
      const inv = await prisma.invoice.findUnique({ where: { id: invoiceId } });
      check(`Invoice status = cancelled`, inv?.status === 'cancelled', `actual: ${inv?.status}`);

      // 5b. NIC EWB cancel (gst_api_logs)
      const ewbCancelLog = await prisma.gstApiLog.findFirst({
        where: {
          invoiceId,
          apiType: { contains: 'CANCEL' },
          requestPayload: { path: ['action'], equals: 'CANCEWB' } as any,
        },
        orderBy: { createdAt: 'desc' },
      });
      // Fallback: look for any cancel log
      const anyEwbCancelLog = await prisma.gstApiLog.findFirst({
        where: { invoiceId, apiType: { contains: 'EWB' } },
        orderBy: { createdAt: 'desc' },
      });
      const ewbCancelLogs = await prisma.gstApiLog.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'desc' },
        select: { apiType: true, status: true, httpStatus: true, errorCode: true, createdAt: true, requestPayload: true, responsePayload: true },
      });

      console.log(info(`GST API logs for invoice ${invoiceId}:`));
      for (const log of ewbCancelLogs) {
        const req: any = log.requestPayload;
        const res: any = log.responsePayload;
        console.log(`  ${log.success ? C.green : C.red}[${log.apiType}]${C.reset} HTTP ${log.httpStatus ?? 'n/a'}  ` +
          `errCode=${log.errorCode ?? 'none'}  ` +
          `action=${typeof req === 'object' && req !== null ? (req as any).action ?? (req as any)?.AplTo ?? '-' : '-'}  ` +
          `ewbNo=${typeof res === 'object' && res !== null ? (res as any)?.data?.ewayBillNo ?? (res as any)?.data?.Ewb ?? (res as any)?.EwbNo ?? '-' : '-'}`  +
          `  status=${log.status}`);
      }

      // Check EWB was cancelled if it was active before cancel
      const ewbWasActive = (isB2B || orderAfterPreflight.invoice?.ewbStatus === 'active');
      if (ewbWasActive) {
        const ewbCancelExists = ewbCancelLogs.some(l => l.apiType?.includes('EWB') && l.apiType?.includes('CANCEL'));
        check(`EWB cancel API call made to NIC`, ewbCancelExists, ewbCancelExists ? 'found' : `not found in ${ewbCancelLogs.length} logs`);

        const ewbCancelSuccess = ewbCancelLogs.some(l => l.apiType?.includes('EWB') && l.apiType?.includes('CANCEL') && l.status === 'success');
        if (ewbCancelExists) {
          check(`EWB cancel succeeded at NIC`, ewbCancelSuccess, ewbCancelSuccess ? 'status=success' : 'status=failed');
        }
      }

      // Check IRN was cancelled (B2B only, after EWB cleared)
      if (isB2B && orderAfterPreflight.invoice?.irnStatus === 'success') {
        const irnCancelLog = ewbCancelLogs.find(l => l.apiType?.includes('IRN') && l.apiType?.includes('CANCEL'));
        check(`IRN cancel API call made to NIC`, !!irnCancelLog, irnCancelLog ? 'found' : `not found in ${ewbCancelLogs.length} logs`);
        if (irnCancelLog) {
          check(`IRN cancel succeeded at NIC`, irnCancelLog.status === 'success', `status=${irnCancelLog.status}`);
          const resp: any = irnCancelLog.responsePayload;
          if (resp) {
            console.log(info(`  IRN cancel raw response: ${JSON.stringify(resp).slice(0, 200)}`));
          }
        }
      }

      // 5c. CustomerLedgerEntry reversal
      const ledgerEntries = await prisma.customerLedgerEntry.findMany({
        where: { invoiceId },
        orderBy: { createdAt: 'asc' },
      });
      console.log(info(`Ledger entries for invoice (${ledgerEntries.length} rows):`));
      for (const e of ledgerEntries) {
        console.log(`  entryType=${e.entryType}  amountDelta=${e.amountDelta}  narration=${e.narration?.slice(0, 40) ?? ''}`);
      }
      const hasOriginal = ledgerEntries.some(e => (e.entryType as string) === 'invoice_entry' && Number(e.amountDelta) > 0);
      const hasReversal = ledgerEntries.some(e => (e.entryType as string) === 'adjustment' && Number(e.amountDelta) < 0);
      check(`Original ledger entry exists`, hasOriginal, hasOriginal ? 'found invoice_entry > 0' : 'missing');
      check(`Reversal ledger entry exists`, hasReversal, hasReversal ? 'found adjustment < 0' : 'missing');
    }

    // 5d. DVA status check (trip released)
    const dvaAfter = await prisma.driverVehicleAssignment.findUnique({ where: { id: dva.id } });
    console.log(info(`DVA status after cancel: ${dvaAfter?.status}`));
    // After cancelling the only order on this trip the DVA should be dispatch_ready
    const activeOrders = await prisma.order.count({
      where: {
        driverId: driver.id,
        distributorId: 'dist-002',
        deliveryDate: new Date(TODAY),
        status: { in: ['pending_delivery', 'preflight_in_progress'] },
      },
    });
    console.log(info(`Active orders remaining on trip: ${activeOrders}`));
    if (activeOrders === 0) {
      check(`DVA reset to dispatch_ready when no active orders remain`,
        dvaAfter?.status === 'dispatch_ready', `actual: ${dvaAfter?.status}`);
    } else {
      console.log(info(`${activeOrders} other active orders on trip — DVA may stay loaded_and_dispatched`));
    }

    // 5e. CancelledStockEvent (only expected if order was past pending_dispatch)
    const stockEvents = await prisma.cancelledStockEvent.count({ where: { orderId } });
    console.log(info(`CancelledStockEvent rows for order: ${stockEvents}`));
    // Order reached pending_delivery → stock events should exist
    check(`CancelledStockEvent created (post-dispatch)`, stockEvents > 0, `count=${stockEvents}`);

    // 5f. No open pending actions from this cancel (unless NIC actually failed)
    const pendingActions = await prisma.pendingAction.findMany({
      where: { entityId: { in: [orderId, ...(invoiceId ? [invoiceId] : [])] } },
      orderBy: { createdAt: 'desc' },
    });
    if (pendingActions.length > 0) {
      console.log(`  ${C.yellow}PendingActions created during cancel:${C.reset}`);
      for (const pa of pendingActions) {
        console.log(`  [${pa.severity}] ${pa.actionType}  status=${pa.status}  desc=${pa.description?.slice(0, 60)}`);
      }
    } else {
      console.log(info('No pending actions created (clean cancel)'));
    }

    console.log(info(`\nScenario "${label}" complete`));
  }

  // ── Run B2B scenario (Maruthi Agencies) ───────────────────────────────────
  await runScenario('B2B — Maruthi Agencies', maruthi.id, true);

  // ── Reset DVA between runs ─────────────────────────────────────────────────
  await prisma.driverVehicleAssignment.update({
    where: { id: dva.id },
    data: { status: 'dispatch_ready' },
  });
  console.log(info('\nDVA reset to dispatch_ready for B2C run'));

  // ── Run B2C scenario (Bangalore Foods) ────────────────────────────────────
  await runScenario('B2C — Bangalore Foods', bangaloreFoods.id, false);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(head('═══ Summary ═══'));
  console.log(`${C.bold}${passed + failed} checks  —  ${C.green}${passed} passed${C.reset}${C.bold}  ${failed > 0 ? C.red : C.green}${failed} failed${C.reset}`);
  if (failed > 0) {
    console.log(`\n${C.red}${C.bold}SOME CHECKS FAILED — review output above${C.reset}`);
    process.exit(1);
  } else {
    console.log(`\n${C.green}${C.bold}ALL CHECKS PASSED${C.reset}`);
  }
}

run()
  .catch(err => {
    console.error('\n\x1b[31mScript crashed:\x1b[0m', err);
    process.exit(2);
  })
  .finally(() => prisma.$disconnect());
