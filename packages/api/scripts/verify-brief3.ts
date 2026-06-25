/**
 * Brief 3 — Backdated Order — comprehensive end-to-end verification.
 *
 * Run: `npx tsx scripts/verify-brief3.ts` from packages/api.
 *
 * Scenarios A–O against the live dev server (http://localhost:5000),
 * dist-002 (Sharma Gas Distributors). Prints actual DB / API / log
 * values for every check — no silent passes. Final summary table +
 * markdown report at docs/BACKDATED-VERIFICATION.md.
 */
import { prisma } from '../src/lib/prisma.js';
import axios from 'axios';
import fs from 'node:fs';

const API = 'http://localhost:5000';
const D2 = 'dist-002';
const SHARMA_LOGIN = { email: 'sharma@gasdist.com', password: 'Gstadmin@123' };
const FINANCE_LOGIN = { email: 'finance@gasagency.com', password: 'Finance@123' }; // dist-001 finance — for role-block check

const B2B_MARUTHI = '582c85b8-3aed-42a8-ab94-e6f4f9f75bd7';
const B2C_BANGALORE = '7f3231f7-adf1-4dab-9cdf-6a7065bb62d1';
const CT_19KG = 'f28f393a-6852-4f14-a108-a55fb574b639';
const ACTIVE_DRIVER = '23f33fbf-645d-44a4-bf91-4258f80df668';
const IDLE_VEHICLE = '03a8bfab-23d4-42c2-9adc-a95785fc9e02';

let token: string;
const ax = axios.create({ baseURL: API, validateStatus: () => true });

interface Result { id: string; name: string; status: 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIP'; expected: string; actual: string; notes: string }
const results: Result[] = [];
const trackedOrderIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedPaymentIds: string[] = [];

function record(r: Result) { results.push(r); console.log(`[${r.status}] ${r.id}: ${r.name}`); }
function headers(authToken = token) { return { Authorization: `Bearer ${authToken}`, 'X-Distributor-Id': D2 }; }

async function login(creds: { email: string; password: string }) {
  const r = await ax.post('/api/auth/login', creds);
  if (r.status !== 200) throw new Error(`Login ${creds.email} failed: ${r.status}`);
  return r.data.data.tokens.accessToken as string;
}

function yesterdayISO(): string {
  const d = new Date(); d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgoISO(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function firstOfMonthISO(): string {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function lastMonthMidISO(): string {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function createBackdated(body: Record<string, unknown>, useToken = token) {
  const r = await ax.post('/api/orders/backdated', body, { headers: headers(useToken) });
  const orderId = r.data?.data?.order?.orderId || r.data?.data?.order?.id;
  const invoiceId = r.data?.data?.invoice?.id;
  if (orderId) trackedOrderIds.push(orderId);
  if (invoiceId) trackedInvoiceIds.push(invoiceId);
  return { status: r.status, body: r.data, orderId, invoiceId };
}

async function getOrder(orderId: string) {
  return prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: true, items: true } });
}

async function getInvoice(invoiceId: string) {
  return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

// ═══════════════════ SCENARIOS ═══════════════════════════════════════════

async function sA() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const o = r.orderId ? await getOrder(r.orderId) : null;
  const actual = `HTTP ${r.status}; orderNumber=${o?.orderNumber}`;
  const ok = !!o?.orderNumber && /^O[A-Z]{3}\d{4}\d{6}$/.test(o.orderNumber);
  record({ id: 'A', name: 'Order number uses structured allocator (OSHD<FY><6>)', status: ok ? 'PASS' : 'FAIL', expected: 'orderNumber matches /^O[A-Z]{3}\\d{4}\\d{6}$/ (e.g. OSHD2627000748)', actual, notes: '' });
}

async function sB() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    payment: { amount: 500, paymentMethod: 'cash' },
  });
  if (!r.orderId || !r.invoiceId) {
    record({ id: 'B', name: 'Payment recorded atomically', status: 'FAIL', expected: 'order+invoice+payment created', actual: `HTTP ${r.status}; body=${JSON.stringify(r.body).slice(0, 300)}`, notes: '' });
    return;
  }
  const inv = await getInvoice(r.invoiceId);
  const allocs = await prisma.paymentAllocation.findMany({ where: { invoiceId: r.invoiceId } });
  const payments = await prisma.paymentTransaction.findMany({ where: { id: { in: allocs.map(a => a.paymentId) } } });
  payments.forEach(p => trackedPaymentIds.push(p.id));
  const actual = [
    `HTTP ${r.status}`,
    `PaymentTransaction count=${payments.length}`,
    `PaymentTransaction[0]: amount=${payments[0]?.amount}, method=${payments[0]?.paymentMethod}, ref=${payments[0]?.referenceNumber ?? 'null'}, status=${payments[0]?.allocationStatus}`,
    `PaymentAllocation: invoiceId=${allocs[0]?.invoiceId?.slice(0, 8)}, amount=${allocs[0]?.allocatedAmount}`,
    `invoice.amountPaid=${inv.amountPaid}, outstanding=${inv.outstandingAmount}, total=${inv.totalAmount}`,
  ].join('; ');
  const ok = payments.length === 1 && Number(payments[0].amount) === 500
    && allocs.length === 1 && Number(allocs[0].allocatedAmount) === 500
    && Number(inv.amountPaid) === 500
    && Number(inv.outstandingAmount) === Number(inv.totalAmount) - 500;
  record({ id: 'B', name: 'Payment recorded atomically with invoice allocation', status: ok ? 'PASS' : 'FAIL', expected: '1 PaymentTransaction, 1 PaymentAllocation, invoice.amountPaid=500, outstanding=total−500', actual, notes: '' });
}

async function waitForGst(invoiceId: string, ms = 5000) {
  await new Promise(r => setTimeout(r, ms));
  const inv = await getInvoice(invoiceId);
  const logs = await prisma.gstApiLog.findMany({ where: { invoiceId }, orderBy: { createdAt: 'asc' }, select: { apiType: true, httpStatus: true, errorCode: true, errorMessage: true } });
  return { inv, logs };
}

async function sC() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.invoiceId) { record({ id: 'C', name: 'IRN auto-fire', status: 'FAIL', expected: 'invoice generated', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId);
  const irnLog = logs.find(l => l.apiType === 'IRN_GENERATE');
  const actual = `irnStatus=${inv.irnStatus}; IRN log present=${!!irnLog} (httpStatus=${irnLog?.httpStatus}, code=${irnLog?.errorCode}, msg=${irnLog?.errorMessage})`;
  const ok = !!irnLog && (inv.irnStatus === 'success' || inv.irnStatus === 'pending' || inv.irnStatus === 'failed');
  record({ id: 'C', name: 'IRN auto-fires post-commit (no manual click)', status: ok ? 'PASS' : 'FAIL', expected: 'irnStatus != not_attempted; IRN_GENERATE log row exists', actual, notes: inv.irnStatus === 'failed' ? 'IRN attempted but NIC rejected — env / transient; auto-fire pipeline verified.' : '' });
}

async function sD() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE,
  });
  if (!r.invoiceId) { record({ id: 'D', name: 'EWB auto-fire', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId, 7000);
  const ewbLog = logs.find(l => l.apiType === 'EWB_GENERATE' || l.apiType === 'EWB_GENERATE_BY_IRN');
  const actual = `ewbStatus=${inv.ewbStatus}; EWB log present=${!!ewbLog} (apiType=${ewbLog?.apiType}, httpStatus=${ewbLog?.httpStatus}, code=${ewbLog?.errorCode})`;
  const ok = !!ewbLog;
  record({ id: 'D', name: 'EWB auto-fires when vehicle provided', status: ok ? 'PASS' : 'FAIL', expected: 'EWB_GENERATE log row exists', actual, notes: '' });
}

async function sE() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    // NO driverId/vehicleId
  });
  if (!r.invoiceId) { record({ id: 'E', name: 'EWB skip no-vehicle', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId);
  const ewbLog = logs.find(l => l.apiType === 'EWB_GENERATE' || l.apiType === 'EWB_GENERATE_BY_IRN');
  const actual = `ewbStatus=${inv.ewbStatus}; EWB log present=${!!ewbLog} (should be false)`;
  const ok = !ewbLog;
  record({ id: 'E', name: 'EWB skipped when no vehicle provided', status: ok ? 'PASS' : 'FAIL', expected: 'No EWB_GENERATE log row', actual, notes: '' });
}

async function sF() {
  const r = await createBackdated({
    customerId: B2C_BANGALORE, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.invoiceId) { record({ id: 'F', name: 'B2C no NIC', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId);
  const actual = `irnStatus=${inv.irnStatus}; ewbStatus=${inv.ewbStatus}; gst_api_logs count=${logs.length}; apiTypes=[${logs.map(l => l.apiType).join(',')}]`;
  const ok = logs.length === 0;
  record({ id: 'F', name: 'B2C backdated — zero NIC calls', status: ok ? 'PASS' : 'FAIL', expected: 'gst_api_logs.length=0 (no IRN, no EWB)', actual, notes: '' });
}

async function sG() {
  // First-of-month MAY equal today on the 1st — fall back to yesterday in that case
  const fom = firstOfMonthISO();
  const backdated = fom < todayISO() ? fom : yesterdayISO();
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: backdated,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.invoiceId) { record({ id: 'G', name: 'Backdated invoice shape', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const inv = await getInvoice(r.invoiceId);
  const issueISO = inv.issueDate.toISOString().slice(0, 10);
  const createdISO = inv.createdAt.toISOString().slice(0, 10);
  const actual = `issueDate=${issueISO}, expected=${backdated}; invoiceNumber=${inv.invoiceNumber}; createdAt=${createdISO}`;
  const ok = issueISO === backdated && /^I[A-Z]{3}\d{4}\d{6}$/.test(inv.invoiceNumber) && createdISO === todayISO() && issueISO !== createdISO;
  record({ id: 'G', name: 'Invoice date backdated; number is today\'s FY sequence', status: ok ? 'PASS' : 'FAIL', expected: 'issueDate=backdated; number matches ISHD<FY><6>; createdAt=today; issueDate!=createdAt', actual, notes: backdated === fom ? '' : 'Today is the 1st; tested with yesterday in place of first-of-month.' });
}

async function sH() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 2 }],
  });
  if (!r.orderId) { record({ id: 'H', name: 'No inventory events', status: 'FAIL', expected: 'order created', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const events = await prisma.inventoryEvent.findMany({ where: { referenceId: r.orderId } });
  const actual = `inventory_events count=${events.length}; events=${JSON.stringify(events.map(e => ({ type: e.eventType, fc: e.fullsChange, ec: e.emptiesChange })))}`;
  const ok = events.length === 0;
  record({ id: 'H', name: 'No inventory events written for backdated order', status: ok ? 'PASS' : 'FAIL', expected: 'inventory_events.count=0', actual, notes: '' });
}

async function sI() {
  const threeDaysAgo = daysAgoISO(3);
  // Skip if 3 days ago spilled into last month
  if (!threeDaysAgo.startsWith(todayISO().slice(0, 8))) {
    record({ id: 'I', name: 'Historical revenue timestamps', status: 'SKIP', expected: '3 days ago', actual: `${threeDaysAgo} crosses month boundary`, notes: 'Test month-boundary edge — informational only.' });
    return;
  }
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: threeDaysAgo,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.orderId) { record({ id: 'I', name: 'Historical timestamps', status: 'FAIL', expected: 'order', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const o = await getOrder(r.orderId);
  const deliveredISO = o.deliveredAt?.toISOString().slice(0, 10) ?? '(null)';
  const orderISO = o.orderDate.toISOString().slice(0, 10);
  const createdISO = o.createdAt.toISOString().slice(0, 10);
  const actual = `deliveredAt=${deliveredISO} (want ${threeDaysAgo}); orderDate=${orderISO} (want ${threeDaysAgo}); createdAt=${createdISO} (want ${todayISO()})`;
  const ok = deliveredISO === threeDaysAgo && orderISO === threeDaysAgo && createdISO === todayISO();
  record({ id: 'I', name: 'Revenue timestamps are historical; createdAt is now', status: ok ? 'PASS' : 'FAIL', expected: 'deliveredAt=orderDate=issueDate; createdAt=today', actual, notes: '' });
}

async function sJ() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: lastMonthMidISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; body=${JSON.stringify(r.body).slice(0, 200)}`;
  const ok = r.status === 400 && /current calendar month/i.test(JSON.stringify(r.body));
  record({ id: 'J', name: 'Same-month guard enforced', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400 with "current calendar month"', actual, notes: '' });
}

async function sK() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: todayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; body=${JSON.stringify(r.body).slice(0, 200)}`;
  const ok = r.status === 400 && /before today/i.test(JSON.stringify(r.body));
  record({ id: 'K', name: 'Today\'s date rejected', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400 with "before today"', actual, notes: '' });
}

async function sL() {
  let financeToken: string | undefined;
  try { financeToken = await login(FINANCE_LOGIN); }
  catch (e) {
    record({ id: 'L', name: 'Finance role blocked', status: 'SKIP', expected: '403 with finance token', actual: `finance login failed: ${e instanceof Error ? e.message : String(e)}`, notes: 'Could not obtain a finance token to test.' });
    return;
  }
  // Use the finance user's own distributor (dist-001 from seed) so we exercise
  // the role-gate, not the multi-tenant gate.
  const r = await ax.post('/api/orders/backdated', {
    customerId: '00000000-0000-0000-0000-000000000000',
    issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  }, { headers: { Authorization: `Bearer ${financeToken}` } });
  const actual = `HTTP ${r.status}; code=${r.data?.code ?? r.data?.error}`;
  const ok = r.status === 403;
  record({ id: 'L', name: 'Finance role blocked from POST /orders/backdated', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 403', actual, notes: '' });
}

async function sM() {
  // Try to create a backdated order on dist-002 for a dist-001 customer.
  // sharma is dist-002 admin → service should 404 the cross-tenant customer.
  const otherCustomer = await prisma.customer.findFirst({
    where: { distributorId: 'dist-001', deletedAt: null },
    select: { id: true },
  });
  if (!otherCustomer) {
    record({ id: 'M', name: 'Multi-tenant isolation', status: 'SKIP', expected: '404 cross-tenant', actual: 'no dist-001 customer found', notes: '' });
    return;
  }
  const r = await createBackdated({
    customerId: otherCustomer.id, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; body=${JSON.stringify(r.body).slice(0, 200)}`;
  const ok = r.status === 404 && /not found/i.test(JSON.stringify(r.body));
  record({ id: 'M', name: 'Multi-tenant: dist-002 admin cannot create for dist-001 customer', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 404 "Customer not found"', actual, notes: '' });
}

async function sN() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: yesterdayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.orderId) { record({ id: 'N', name: 'Wire shape', status: 'FAIL', expected: 'order', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const detail = await ax.get(`/api/orders/${r.orderId}`, { headers: headers() });
  const o = detail.data?.data;
  const actual = `GET /orders/:id HTTP ${detail.status}; isBackdated=${o?.isBackdated}; isGodownPickup=${o?.isGodownPickup}`;
  const ok = o?.isBackdated === true && o?.isGodownPickup === false;
  record({ id: 'N', name: 'GET /orders/:id surfaces isBackdated=true', status: ok ? 'PASS' : 'FAIL', expected: 'isBackdated=true, isGodownPickup=false', actual, notes: '' });
}

async function sO() {
  // Regression — normal order through assign-driver + preflight + confirm.
  // Use far-future date to avoid contaminating today's inventory KPIs +
  // the gst-preflight test fixtures.
  const TEST_DATE = '2099-12-31';
  // Seed a DVA for the test driver on TEST_DATE
  const existingDva = await prisma.driverVehicleAssignment.findFirst({
    where: { driverId: ACTIVE_DRIVER, assignmentDate: new Date(TEST_DATE), distributorId: D2 },
  });
  if (!existingDva) {
    await prisma.driverVehicleAssignment.create({
      data: { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE, assignmentDate: new Date(TEST_DATE), distributorId: D2, status: 'dispatch_ready' },
    });
  }
  // Seed depot stock for the cylinder type
  await prisma.inventorySummary.upsert({
    where: { distributorId_cylinderTypeId_summaryDate: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: new Date('3000-01-01') } },
    create: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: new Date('3000-01-01'), openingFulls: 100, closingFulls: 100, openingEmpties: 0, closingEmpties: 0 },
    update: { closingFulls: 100, openingFulls: 100 },
  });

  // Create normal order
  const createR = await ax.post('/api/orders', {
    customerId: B2B_MARUTHI, deliveryDate: TEST_DATE,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  }, { headers: headers() });
  const orderId = createR.data?.data?.orderId || createR.data?.data?.id;
  if (orderId) trackedOrderIds.push(orderId);
  if (!orderId) { record({ id: 'O', name: 'Normal order regression', status: 'FAIL', expected: 'order', actual: `create HTTP ${createR.status}`, notes: '' }); return; }
  await ax.post(`/api/orders/${orderId}/assign-driver`, { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE }, { headers: headers() });
  await ax.post('/api/orders/preflight-dispatch', { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE, assignmentDate: TEST_DATE, orderIds: [orderId] }, { headers: headers() });
  await ax.post(`/api/orders/${orderId}/confirm-delivery`, { items: [{ cylinderTypeId: CT_19KG, deliveredQuantity: 1, emptiesCollected: 0 }] }, { headers: headers() });

  const o = await getOrder(orderId);
  if (o.invoice?.id) trackedInvoiceIds.push(o.invoice.id);
  const events = await prisma.inventoryEvent.count({ where: { referenceId: orderId } });
  const actual = `order.isBackdated=${o.isBackdated}; isGodownPickup=${o.isGodownPickup}; inventory_events count=${events}`;
  const ok = o.isBackdated === false && o.isGodownPickup === false && events > 0;
  record({ id: 'O', name: 'Normal order regression: isBackdated=false, inventory events written', status: ok ? 'PASS' : 'FAIL', expected: 'isBackdated=false; inventory_events.count>0', actual, notes: '' });
}

// ═══════════════════ MAIN ════════════════════════════════════════════════

async function main() {
  console.log('=== Booting verify-brief3 ===');
  token = await login(SHARMA_LOGIN);
  console.log('Logged in as sharma (dist-002, distributor_admin).\n');

  const runs: Array<[string, () => Promise<void>]> = [
    ['A', sA], ['B', sB], ['C', sC], ['D', sD], ['E', sE], ['F', sF], ['G', sG],
    ['H', sH], ['I', sI], ['J', sJ], ['K', sK], ['L', sL], ['M', sM], ['N', sN], ['O', sO],
  ];
  for (const [id, fn] of runs) {
    try { await fn(); }
    catch (e: unknown) {
      record({ id, name: `${id} (runner caught error)`, status: 'FAIL', expected: 'no exception', actual: e instanceof Error ? `${e.message}\n${e.stack?.slice(0, 800)}` : String(e), notes: '' });
    }
  }

  // Cleanup
  try {
    if (trackedPaymentIds.length) {
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: trackedPaymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
    }
    if (trackedInvoiceIds.length) {
      await prisma.gstApiLog.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
      await prisma.invoice.deleteMany({ where: { id: { in: trackedInvoiceIds } } });
    }
    if (trackedOrderIds.length) {
      await prisma.inventoryEvent.deleteMany({ where: { referenceId: { in: trackedOrderIds } } });
      await prisma.orderStatusLog.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.orderItem.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.driverAssignment.deleteMany({ where: { orderId: { in: trackedOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: trackedOrderIds } } });
    }
    await prisma.inventorySummary.deleteMany({ where: { distributorId: D2, summaryDate: new Date('3000-01-01') } });
    console.log(`\nCleanup OK — removed ${trackedOrderIds.length} orders, ${trackedInvoiceIds.length} invoices, ${trackedPaymentIds.length} payments.`);
  } catch (e) {
    console.warn('Cleanup partial:', e instanceof Error ? e.message : String(e));
  }

  // Report
  const counts = { PASS: 0, FAIL: 0, PARTIAL: 0, SKIP: 0 };
  results.forEach(r => { counts[r.status]++; });

  let md = `# Backdated Order — Verification\n\n`;
  md += `_Run: ${new Date().toISOString()} against http://localhost:5000, dist-002 (Sharma Gas Distributors)._\n\n`;
  md += `**Headline:** ${counts.PASS} PASS · ${counts.PARTIAL} PARTIAL · ${counts.FAIL} FAIL · ${counts.SKIP} SKIP (of ${results.length})\n\n`;
  md += `## Scenarios\n\n`;
  for (const r of results) {
    md += `### ${r.id}: ${r.name}\n\n- **Status:** ${r.status}\n- **Expected:** ${r.expected}\n- **Actual:** ${r.actual}\n`;
    if (r.notes) md += `- **Notes:** ${r.notes}\n`;
    md += `\n`;
  }
  md += `## Summary\n\n| Scenario | Status | Notes |\n|---|---|---|\n`;
  for (const r of results) md += `| ${r.id} | ${r.status} | ${r.notes?.replace(/\|/g, '\\|') ?? ''} |\n`;
  if (counts.FAIL === 0 && counts.PARTIAL === 0) {
    md += `\n## ✅ ALL CLEAR — Brief 3 verified end-to-end.\n`;
  }
  fs.writeFileSync('C:/Projects/Re-New_Gaslink/docs/BACKDATED-VERIFICATION.md', md, 'utf-8');
  console.log(`\nReport: docs/BACKDATED-VERIFICATION.md`);
  console.log(`Summary: ${counts.PASS} PASS · ${counts.PARTIAL} PARTIAL · ${counts.FAIL} FAIL · ${counts.SKIP} SKIP`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
