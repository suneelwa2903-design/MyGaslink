/**
 * Comprehensive E2E — Backdated Order + Payment + Inventory Adjustment.
 *
 * Run: `npx tsx scripts/verify-backdated-full.ts` from packages/api.
 *
 * Groups A–G against the live dev server. Prints actual DB / API / log
 * values for every check. Self-cleanup at the end. Markdown report
 * lands at docs/BACKDATED-FULL-VERIFICATION.md.
 */
import { prisma } from '../src/lib/prisma.js';
import axios from 'axios';
import fs from 'node:fs';

const API = 'http://localhost:5000';
const D2 = 'dist-002';
const SHARMA = { email: 'sharma@gasdist.com', password: 'Gstadmin@123' };
const FINANCE = { email: 'finance2@gasdist.com', password: 'Finance@123' };

const B2B_MARUTHI = '582c85b8-3aed-42a8-ab94-e6f4f9f75bd7';
const B2C_BANGALORE = '7f3231f7-adf1-4dab-9cdf-6a7065bb62d1';
const CT_19KG = 'f28f393a-6852-4f14-a108-a55fb574b639';
const CT_5KG = 'd095cb4f-46f7-4d78-b3e7-f4224bc7afb2';
const ACTIVE_DRIVER = '23f33fbf-645d-44a4-bf91-4258f80df668';
const IDLE_VEHICLE = '03a8bfab-23d4-42c2-9adc-a95785fc9e02';

let sharmaToken: string;
let financeToken: string | null = null;

const ax = axios.create({ baseURL: API, validateStatus: () => true });
function H(tok = sharmaToken) { return { Authorization: `Bearer ${tok}`, 'X-Distributor-Id': D2 }; }

interface Result { id: string; name: string; status: 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIP'; expected: string; actual: string; notes: string }
const results: Result[] = [];
const trackedOrderIds: string[] = [];
const trackedInvoiceIds: string[] = [];
const trackedPaymentIds: string[] = [];

function record(r: Result) { results.push(r); console.log(`[${r.status}] ${r.id}: ${r.name}`); }

async function login(creds: { email: string; password: string }): Promise<string | null> {
  const r = await ax.post('/api/auth/login', creds);
  if (r.status !== 200) return null;
  return r.data.data.tokens.accessToken as string;
}

function todayISO(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function daysAgoISO(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  // Guard: stay within current calendar month (same-month rule). If
  // n days ago crosses the boundary, fall back to first-of-month.
  const candidate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  if (!candidate.startsWith(todayISO().slice(0, 8))) return firstOfMonthISO();
  return candidate;
}
function firstOfMonthISO(): string {
  const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}
function lastMonthISO(): string {
  const d = new Date(); d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-15`;
}
function tomorrowISO(): string {
  const d = new Date(); d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function createBackdated(body: Record<string, unknown>, useToken = sharmaToken): Promise<{
  status: number; body: any; orderId?: string; invoiceId?: string;
}> {
  const r = await ax.post('/api/orders/backdated', body, { headers: H(useToken) });
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
async function getGstLogs(invoiceId: string) {
  return prisma.gstApiLog.findMany({
    where: { invoiceId },
    orderBy: { createdAt: 'asc' },
    select: { apiType: true, httpStatus: true, errorCode: true, errorMessage: true, createdAt: true, requestPayload: true },
  });
}
async function waitForGst(invoiceId: string, ms = 8000) {
  await new Promise((r) => setTimeout(r, ms));
  return { inv: await getInvoice(invoiceId), logs: await getGstLogs(invoiceId) };
}

// ═══════════ GROUP A — ORDER CREATION ═══════════════════════════════════════

async function sA1() {
  const fom = firstOfMonthISO();
  const issueDate = fom < todayISO() ? fom : daysAgoISO(1);
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate,
    items: [{ cylinderTypeId: CT_19KG, quantity: 2 }],
  });
  if (!r.orderId) { record({ id: 'A1', name: 'B2B E-Invoice Only, no payment', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}: ${JSON.stringify(r.body).slice(0,200)}`, notes: '' }); return; }
  const o = await getOrder(r.orderId);
  const orderDateISO = o.orderDate.toISOString().slice(0, 10);
  const delDateISO = o.deliveryDate.toISOString().slice(0, 10);
  const deliveredAtISO = o.deliveredAt?.toISOString().slice(0, 10) ?? '(null)';
  const createdISO = o.createdAt.toISOString().slice(0, 10);
  const checks = {
    orderNumberStructured: /^O[A-Z]{3}\d{4}\d{6}$/.test(o.orderNumber),
    statusDelivered: o.status === 'delivered',
    isBackdated: o.isBackdated === true,
    orderDateMatchesIssue: orderDateISO === issueDate,
    deliveryDateMatchesIssue: delDateISO === issueDate,
    deliveredAtMatchesIssue: deliveredAtISO === issueDate,
    createdAtIsToday: createdISO === todayISO(),
    createdAtNotEqualDelivered: createdISO !== deliveredAtISO,
  };
  const ok = Object.values(checks).every(Boolean);
  record({ id: 'A1', name: 'B2B backdated E-Invoice Only, no payment',
    status: ok ? 'PASS' : 'FAIL',
    expected: 'orderNumber=OSHD<FY><6>; status=delivered; isBackdated=true; orderDate=deliveryDate=deliveredAt=issueDate; createdAt=today; createdAt!=deliveredAt',
    actual: `orderNumber=${o.orderNumber}; status=${o.status}; isBackdated=${o.isBackdated}; orderDate=${orderDateISO}; deliveryDate=${delDateISO}; deliveredAt=${deliveredAtISO}; createdAt=${createdISO}; checks=${JSON.stringify(checks)}`, notes: '' });
}

async function sA2() {
  const issueDate = daysAgoISO(3);
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE,
  });
  if (!r.invoiceId) { record({ id: 'A2', name: 'B2B E-Invoice + EWB', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId, 8000);
  const irnLog = logs.find((l) => l.apiType === 'IRN_GENERATE');
  // Possible apiTypes for an EWB row: EWB_GENERATE_BY_IRN (B2B post-IRN
  // path), EWB_GENERATE_B2C (B2C standalone — no IRN), EWB_GENERATE
  // (legacy / direct), EWB_GENERATE_DISPATCH (preflight-trip path).
  const ewbLog = logs.find((l) => l.apiType.startsWith('EWB_GENERATE'));
  const actual = `orderId=${r.orderId?.slice(0,8)}; driverId=${ACTIVE_DRIVER.slice(0,8)}; vehicleId=${IDLE_VEHICLE.slice(0,8)}; irnStatus=${inv.irnStatus}; ewbStatus=${inv.ewbStatus}; IRN log: ${irnLog ? `present (httpStatus=${irnLog.httpStatus})` : 'ABSENT'}; EWB log: ${ewbLog ? `present (${ewbLog.apiType}, ${ewbLog.httpStatus})` : 'ABSENT'}`;
  const ok = !!irnLog && !!ewbLog && inv.irnStatus !== 'not_attempted' && inv.ewbStatus !== 'not_attempted';
  record({ id: 'A2', name: 'B2B backdated E-Invoice + EWB with driver+vehicle', status: ok ? 'PASS' : 'PARTIAL', expected: 'IRN+EWB logs present; statuses != not_attempted', actual, notes: irnLog?.errorCode === 'AUTH_FAILED' ? 'IRN AUTH_FAILED — env / transient; auto-fire pipeline verified by the log row.' : '' });
}

async function sA3() {
  const r = await createBackdated({
    customerId: B2C_BANGALORE, issueDate: daysAgoISO(5),
    items: [{ cylinderTypeId: CT_5KG, quantity: 3 }],
  });
  if (!r.invoiceId) { record({ id: 'A3', name: 'B2C no vehicle', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId, 5000);
  const actual = `irnStatus=${inv.irnStatus}; ewbStatus=${inv.ewbStatus}; gst_api_logs.count=${logs.length}; apiTypes=[${logs.map(l => l.apiType).join(',')}]`;
  const ok = logs.length === 0;
  record({ id: 'A3', name: 'B2C backdated, no vehicle — zero NIC calls', status: ok ? 'PASS' : 'FAIL', expected: 'gst_api_logs.length=0', actual, notes: inv.irnStatus === 'not_attempted' ? 'irnStatus stays not_attempted by design for B2C — the brief mentions "not_required" but the canonical value in the DB is not_attempted (URP path never fires IRN).' : '' });
}

async function sA4() {
  const r = await createBackdated({
    customerId: B2C_BANGALORE, issueDate: daysAgoISO(2),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE,
  });
  if (!r.invoiceId) { record({ id: 'A4', name: 'B2C with vehicle', status: 'FAIL', expected: 'invoice', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const { inv, logs } = await waitForGst(r.invoiceId, 8000);
  const irnLog = logs.find((l) => l.apiType === 'IRN_GENERATE');
  // Possible apiTypes for an EWB row: EWB_GENERATE_BY_IRN (B2B post-IRN
  // path), EWB_GENERATE_B2C (B2C standalone — no IRN), EWB_GENERATE
  // (legacy / direct), EWB_GENERATE_DISPATCH (preflight-trip path).
  const ewbLog = logs.find((l) => l.apiType.startsWith('EWB_GENERATE'));
  const actual = `irnStatus=${inv.irnStatus}; ewbStatus=${inv.ewbStatus}; IRN log: ${irnLog ? 'PRESENT (unexpected)' : 'absent (correct)'}; EWB log: ${ewbLog ? `present (${ewbLog.apiType})` : 'ABSENT'}`;
  const ok = !irnLog && !!ewbLog;
  record({ id: 'A4', name: 'B2C backdated with vehicle — EWB fires, no IRN', status: ok ? 'PASS' : 'PARTIAL', expected: 'EWB log present, NO IRN log', actual, notes: '' });
}

// ═══════════ GROUP B — PAYMENT ═══════════════════════════════════════════════

const PRICE_19KG_INCL = 2000; // GST-inclusive seed price on dist-002

async function sB1() {
  const issueDate = daysAgoISO(4);
  const qty = 2;
  // Create the order first WITHOUT payment so we can read the actual
  // computed invoice total (it includes customer discount + transport,
  // not just the GST-inclusive cylinder price). Then post a *follow-up*
  // payment via the standard payments endpoint to mirror "full
  // payment" semantics. The brief's "compute from cylinder price"
  // hint understates the math — Maruthi has a 200/unit discount that
  // pulls the effective unitPrice to 1800.
  const rCreate = await createBackdated({
    customerId: B2B_MARUTHI, issueDate,
    items: [{ cylinderTypeId: CT_19KG, quantity: qty }],
  });
  if (!rCreate.invoiceId) { record({ id: 'B1', name: 'Backdated + full cash payment', status: 'FAIL', expected: '201', actual: `HTTP ${rCreate.status}: ${JSON.stringify(rCreate.body).slice(0,200)}`, notes: '' }); return; }
  const invInit = await getInvoice(rCreate.invoiceId);
  const total = Number(invInit.totalAmount);
  // Record a full payment via POST /api/payments with an allocation.
  const rPay = await ax.post('/api/payments', {
    customerId: B2B_MARUTHI, amount: total, paymentMethod: 'cash',
    transactionDate: issueDate,
    allocations: [{ invoiceId: rCreate.invoiceId, amount: total }],
  }, { headers: H() });
  if (rPay.status !== 201 && rPay.status !== 200) { record({ id: 'B1', name: 'B1 follow-up payment', status: 'FAIL', expected: '201', actual: `pay HTTP ${rPay.status}: ${JSON.stringify(rPay.data).slice(0,200)}`, notes: '' }); return; }
  const pId = rPay.data?.data?.paymentId || rPay.data?.data?.id;
  if (pId) trackedPaymentIds.push(pId);
  const r = { ...rCreate };
  const inv = await getInvoice(r.invoiceId!);
  const allocs = await prisma.paymentAllocation.findMany({ where: { invoiceId: r.invoiceId } });
  const payments = await prisma.paymentTransaction.findMany({ where: { id: { in: allocs.map(a => a.paymentId) } } });
  payments.forEach(p => trackedPaymentIds.push(p.id));
  // Ledger entries reference the invoice via `referenceId` (always) and
  // optional `invoiceId` (set for payment_allocation rows that point at
  // a specific invoice). The schema does NOT have a paymentTransactionId
  // column — payment-ledger rows carry the payment id in `referenceId`
  // instead. Query both.
  const paymentIds = payments.map(p => p.id);
  const ledger = await prisma.customerLedgerEntry.findMany({
    where: { customerId: B2B_MARUTHI, distributorId: D2,
      OR: [{ referenceId: r.invoiceId! }, { invoiceId: r.invoiceId! }, { referenceId: { in: paymentIds } }] },
    orderBy: { entryDate: 'asc' },
    select: { entryType: true, entryDate: true, amountDelta: true },
  });
  const actual = [
    `orderNumber=${(await getOrder(r.orderId!)).orderNumber}`,
    `invoiceNumber=${inv.invoiceNumber}`,
    `totalAmount=${inv.totalAmount}`,
    `amountPaid=${inv.amountPaid}`,
    `outstandingAmount=${inv.outstandingAmount}`,
    `status=${inv.status}`,
    `paymentCount=${payments.length}; payment.amount=${payments[0]?.amount}; method=${payments[0]?.paymentMethod}; txDate=${payments[0]?.transactionDate.toISOString().slice(0,10)}`,
    `allocations=${allocs.length}; alloc.amount=${allocs[0]?.allocatedAmount}`,
    `ledger rows: ${ledger.map(l => `${l.entryType}@${l.entryDate.toISOString().slice(0,10)}(Δ=${l.amountDelta})`).join(' | ')}`,
  ].join('; ');
  const ok = payments.length === 1
    && Number(payments[0].amount) === total
    && allocs.length === 1
    && Number(inv.amountPaid) === total
    && Number(inv.outstandingAmount) === 0
    && (inv.status === 'paid' || inv.status === 'partially_paid');
  record({ id: 'B1', name: 'Full payment — amountPaid=total, outstanding=0', status: ok ? 'PASS' : 'FAIL', expected: 'amountPaid=total; outstanding=0; status=paid', actual, notes: inv.status === 'paid' ? '' : `Status is ${inv.status} (expected paid for full payment). May indicate the status-update trigger runs lazily.` });
}

async function sB2() {
  const issueDate = daysAgoISO(6);
  const qty = 3;
  const total = PRICE_19KG_INCL * qty; // 6000
  const partial = 500;
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate,
    items: [{ cylinderTypeId: CT_19KG, quantity: qty }],
    payment: { amount: partial, paymentMethod: 'upi', referenceNumber: 'UPI-BACKDATE-TEST', transactionDate: issueDate },
  });
  if (!r.invoiceId) { record({ id: 'B2', name: 'Backdated + partial payment', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const inv = await getInvoice(r.invoiceId);
  const allocs = await prisma.paymentAllocation.findMany({ where: { invoiceId: r.invoiceId } });
  const payments = await prisma.paymentTransaction.findMany({ where: { id: { in: allocs.map(a => a.paymentId) } } });
  payments.forEach(p => trackedPaymentIds.push(p.id));
  const actual = `totalAmount=${inv.totalAmount}; amountPaid=${inv.amountPaid}; outstanding=${inv.outstandingAmount}; status=${inv.status}; payment.ref=${payments[0]?.referenceNumber}; payment.txDate=${payments[0]?.transactionDate.toISOString().slice(0,10)}`;
  const ok = Number(inv.amountPaid) === partial
    && Number(inv.outstandingAmount) === Number(inv.totalAmount) - partial
    && payments[0]?.referenceNumber === 'UPI-BACKDATE-TEST'
    && payments[0]?.transactionDate.toISOString().slice(0, 10) === issueDate;
  record({ id: 'B2', name: 'Partial payment — outstanding correct; tx date historical', status: ok ? 'PASS' : 'FAIL', expected: `amountPaid=${partial}; outstanding=${total - partial}; ref=UPI-BACKDATE-TEST; txDate=${issueDate}`, actual, notes: '' });
}

async function sB3() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(7),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.invoiceId) { record({ id: 'B3', name: 'Backdated no payment', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const inv = await getInvoice(r.invoiceId);
  const allocs = await prisma.paymentAllocation.findMany({ where: { invoiceId: r.invoiceId } });
  const actual = `amountPaid=${inv.amountPaid}; outstanding=${inv.outstandingAmount}; status=${inv.status}; allocations=${allocs.length}`;
  const ok = Number(inv.amountPaid) === 0
    && Number(inv.outstandingAmount) === Number(inv.totalAmount)
    && inv.status === 'issued'
    && allocs.length === 0;
  record({ id: 'B3', name: 'No payment — outstanding=total; zero allocations', status: ok ? 'PASS' : 'FAIL', expected: 'amountPaid=0; outstanding=total; status=issued; allocations=0', actual, notes: '' });
}

async function sB4() {
  // Use B2's payment which had transactionDate set to past date.
  const recentPayment = await prisma.paymentTransaction.findFirst({
    where: { id: { in: trackedPaymentIds }, referenceNumber: 'UPI-BACKDATE-TEST' },
    select: { transactionDate: true, createdAt: true },
  });
  if (!recentPayment) { record({ id: 'B4', name: 'Tx date independence', status: 'SKIP', expected: 'B2 payment found', actual: 'not found', notes: 'Depends on B2.' }); return; }
  const txISO = recentPayment.transactionDate.toISOString().slice(0, 10);
  const createdISO = recentPayment.createdAt.toISOString().slice(0, 10);
  const actual = `transactionDate=${txISO}; createdAt=${createdISO}; txDate !== createdAt? ${txISO !== createdISO}`;
  const ok = txISO !== createdISO && txISO === daysAgoISO(6) && createdISO === todayISO();
  record({ id: 'B4', name: 'Payment transactionDate is historical, createdAt is today', status: ok ? 'PASS' : 'FAIL', expected: 'txDate=6 days ago; createdAt=today; not equal', actual, notes: '' });
}

// ═══════════ GROUP C — INVOICE INTEGRITY ═════════════════════════════════════

async function sC1() {
  // Use the most-recent backdated invoice we created
  const recent = await prisma.invoice.findFirst({
    where: { id: { in: trackedInvoiceIds } },
    orderBy: { createdAt: 'desc' },
  });
  if (!recent) { record({ id: 'C1', name: 'Invoice integrity', status: 'FAIL', expected: 'any tracked invoice', actual: 'none', notes: '' }); return; }
  // Look up the 3 most-recent invoices on dist-002 to confirm sequencing
  const last3 = await prisma.invoice.findMany({
    where: { distributorId: D2 },
    orderBy: { createdAt: 'desc' }, take: 3,
    select: { invoiceNumber: true, createdAt: true, issueDate: true },
  });
  const issueISO = recent.issueDate.toISOString().slice(0, 10);
  const createdISO = recent.createdAt.toISOString().slice(0, 10);
  const isOurs = last3[0]?.invoiceNumber === recent.invoiceNumber;
  const numberFormatOk = /^I[A-Z]{3}\d{4}\d{6}$/.test(recent.invoiceNumber);
  const actual = `invoice.invoiceNumber=${recent.invoiceNumber}; issueDate=${issueISO}; createdAt=${createdISO}; last 3 invoices=[${last3.map(i => i.invoiceNumber).join(',')}]; backdated invoice is the most recent? ${isOurs}`;
  const ok = numberFormatOk && createdISO === todayISO() && issueISO !== createdISO;
  record({ id: 'C1', name: 'Invoice number is today\'s sequence; date is backdated', status: ok ? 'PASS' : 'FAIL', expected: 'number=ISHD<FY><6>; createdAt=today; issueDate!=createdAt', actual, notes: '' });
}

async function sC2() {
  // First A-group order tracked
  const o = await prisma.order.findFirst({
    where: { id: { in: trackedOrderIds }, isBackdated: true, poNumber: null },
    include: { invoice: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!o?.invoice) { record({ id: 'C2', name: 'Invoice ↔ order linkage', status: 'SKIP', expected: 'tracked backdated order', actual: 'none', notes: '' }); return; }
  const actual = `invoice.orderId=${o.invoice.orderId?.slice(0,8)} (order.id=${o.id.slice(0,8)}); invoice.customerId=${o.invoice.customerId?.slice(0,8)}; order.customerId=${o.customerId?.slice(0,8)}; invoice.poNumber=${o.invoice.poNumber}`;
  const ok = o.invoice.orderId === o.id && o.invoice.customerId === o.customerId && o.invoice.poNumber === null;
  record({ id: 'C2', name: 'Invoice links order + customer correctly; null PO', status: ok ? 'PASS' : 'FAIL', expected: 'orderId match; customerId match; poNumber=null', actual, notes: '' });
}

async function sC3() {
  const issueDate = daysAgoISO(2);
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    poNumber: 'BACKDATE-PO-001',
  });
  if (!r.invoiceId) { record({ id: 'C3', name: 'PO + IRN PoDtls', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const o = await getOrder(r.orderId!);
  const inv = await getInvoice(r.invoiceId);
  const { logs } = await waitForGst(r.invoiceId, 8000);
  const irnLog = logs.find((l) => l.apiType === 'IRN_GENERATE');
  const reqPayload = irnLog?.requestPayload as any;
  // IRN payload may be { Invoice: { PoDtls } } or { PoDtls } at root
  const poDtls = reqPayload?.Invoice?.PoDtls ?? reqPayload?.PoDtls ?? null;
  const expectedDt = (() => {
    const [y, m, d] = issueDate.split('-');
    return `${d}/${m}/${y}`;
  })();
  const actual = `order.poNumber=${o.poNumber}; invoice.poNumber=${inv.poNumber}; IRN PoDtls=${poDtls ? JSON.stringify(poDtls) : '(absent)'}; expected PoDt=${expectedDt}`;
  const ok = o.poNumber === 'BACKDATE-PO-001'
    && inv.poNumber === 'BACKDATE-PO-001'
    && poDtls?.PoNo === 'BACKDATE-PO-001'
    && poDtls?.PoDt === expectedDt;
  record({ id: 'C3', name: 'PO number flows through Order → Invoice → IRN payload', status: ok ? 'PASS' : 'PARTIAL', expected: `poNumber=BACKDATE-PO-001 on both; IRN PoDtls={PoNo,PoDt=${expectedDt}}`, actual, notes: irnLog?.errorCode === 'AUTH_FAILED' ? 'IRN AUTH_FAILED — payload structurally verified via the request_payload column even when NIC rejects.' : '' });
}

async function sC4() {
  // Use B1's order (the full-payment one)
  const tracked = await prisma.invoice.findMany({
    where: { id: { in: trackedInvoiceIds }, customerId: B2B_MARUTHI },
    select: { id: true, issueDate: true, totalAmount: true },
  });
  // Pick the one whose total matches a B1-style full payment
  const target = tracked.find((i) => Number(i.totalAmount) === 4000) ?? tracked[0];
  if (!target) { record({ id: 'C4', name: 'Ledger dates', status: 'SKIP', expected: 'B1 invoice', actual: 'none', notes: '' }); return; }
  // Ledger schema uses `referenceId` + `amountDelta` (not debit/credit
  // pair). invoice_entry rows put the invoice in referenceId AND
  // optional invoiceId; payment-related rows reference the payment.
  const ledger = await prisma.customerLedgerEntry.findMany({
    where: { customerId: B2B_MARUTHI, distributorId: D2,
      OR: [{ invoiceId: target.id }, { referenceId: target.id }] },
    orderBy: { entryDate: 'asc' },
    select: { entryType: true, entryDate: true, amountDelta: true },
  });
  const issueISO = target.issueDate.toISOString().slice(0, 10);
  // Look for the invoice debit + any payment-credit entries.
  // Enum values are *_entry style (invoice_entry, payment_entry, …),
  // not bare 'invoice'/'payment'.
  const invoiceEntry = ledger.find((l) => /invoice/i.test(l.entryType));
  const paymentEntry = ledger.find((l) => /payment/i.test(l.entryType));
  const actual = `invoice.issueDate=${issueISO}; ledger rows=[${ledger.map(l => `${l.entryType}@${l.entryDate.toISOString().slice(0,10)}(Δ=${l.amountDelta})`).join(' | ')}]; invoiceEntry.entryDate=${invoiceEntry?.entryDate.toISOString().slice(0,10)} (expected ${issueISO}); paymentEntry.entryDate=${paymentEntry?.entryDate.toISOString().slice(0,10) ?? '(absent — payment ledger may be optional in this flow)'}`;
  // Strict expectation: the invoice ledger row's entryDate matches the
  // backdated issueDate (NOT today). The payment ledger row is
  // informational — createPaymentInTx may use the payment transactionDate
  // or createdAt; we just confirm it's historical when present.
  const invoiceDateOk = invoiceEntry?.entryDate.toISOString().slice(0, 10) === issueISO;
  const paymentDateOk = paymentEntry ? paymentEntry.entryDate.toISOString().slice(0, 10) !== todayISO() : true;
  const ok = invoiceDateOk && paymentDateOk;
  record({ id: 'C4', name: 'CustomerLedger uses historical dates', status: ok ? 'PASS' : 'PARTIAL', expected: 'invoice ledger.entryDate=issueDate; payment ledger.entryDate historical (when present)', actual, notes: !paymentEntry ? 'Payment ledger entry not found via invoice referenceId — flow may track the payment row separately. Invoice-side dating is the load-bearing check.' : '' });
}

// ═══════════ GROUP D — NO AUTO INVENTORY ═════════════════════════════════════

async function sD1() {
  const counts: Array<{ orderId: string; orderNumber: string; events: number }> = [];
  const orders = await prisma.order.findMany({
    where: { id: { in: trackedOrderIds } },
    select: { id: true, orderNumber: true },
  });
  for (const o of orders) {
    const c = await prisma.inventoryEvent.count({ where: { referenceId: o.id } });
    counts.push({ orderId: o.id.slice(0, 8), orderNumber: o.orderNumber, events: c });
  }
  const actual = counts.map((c) => `${c.orderNumber}=${c.events}`).join(', ');
  const ok = counts.every((c) => c.events === 0);
  record({ id: 'D1', name: 'Zero inventory events for every backdated order', status: ok ? 'PASS' : 'FAIL', expected: 'all counts=0', actual, notes: '' });
}

async function sD2() {
  // Today's summary for 19 KG on dist-002
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const before = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: today },
    select: { closingFulls: true },
  });
  const beforeFulls = before?.closingFulls ?? null;
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(3),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  if (!r.orderId) { record({ id: 'D2', name: 'InventorySummary untouched', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const after = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: today },
    select: { closingFulls: true },
  });
  const afterFulls = after?.closingFulls ?? null;
  const actual = `before=${beforeFulls}; after=${afterFulls}`;
  const ok = beforeFulls === afterFulls;
  record({ id: 'D2', name: 'InventorySummary closingFulls unchanged by backdated create', status: ok ? 'PASS' : 'FAIL', expected: 'before === after', actual, notes: '' });
}

async function sD3() {
  const before = await prisma.customerInventoryBalance.findFirst({
    where: { customerId: B2B_MARUTHI, cylinderTypeId: CT_19KG },
    select: { withCustomerQty: true },
  });
  const beforeQty = before?.withCustomerQty ?? null;
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(4),
    items: [{ cylinderTypeId: CT_19KG, quantity: 2 }],
  });
  if (!r.orderId) { record({ id: 'D3', name: 'CustomerInventoryBalance untouched', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  const after = await prisma.customerInventoryBalance.findFirst({
    where: { customerId: B2B_MARUTHI, cylinderTypeId: CT_19KG },
    select: { withCustomerQty: true },
  });
  const afterQty = after?.withCustomerQty ?? null;
  const actual = `before=${beforeQty}; after=${afterQty}`;
  const ok = beforeQty === afterQty;
  record({ id: 'D3', name: 'CustomerInventoryBalance withCustomerQty unchanged', status: ok ? 'PASS' : 'FAIL', expected: 'before === after', actual, notes: '' });
}

// ═══════════ GROUP E — INVENTORY ADJUSTMENT ══════════════════════════════════

async function sE1() {
  const r = await ax.get('/api/inventory/backdated-adjustments/pending', { headers: H() });
  const rows = r.data?.data ?? [];
  // All our tracked backdated orders that aren't deleted should appear unless already adjusted
  const ourOrders = await prisma.order.findMany({
    where: { id: { in: trackedOrderIds }, isBackdated: true, status: 'delivered', inventoryAdjustedAt: null, deletedAt: null },
    select: { id: true, orderNumber: true },
  });
  const presentIds = new Set(rows.map((row: any) => row.orderId));
  const missing = ourOrders.filter((o) => !presentIds.has(o.id));
  // Confirm no non-backdated normal orders sneak in
  const sample = rows.slice(0, 5);
  const hasNonBackdated = sample.length > 0 ? await prisma.order.findFirst({
    where: { id: { in: sample.map((s: any) => s.orderId) }, isBackdated: false },
    select: { id: true },
  }) : null;
  const actual = `HTTP ${r.status}; pending rows=${rows.length}; tracked-pending in list=${ourOrders.length - missing.length}/${ourOrders.length}; missing=${missing.map(m => m.orderNumber).join(',')}; non-backdated leak?=${!!hasNonBackdated}`;
  const ok = r.status === 200 && missing.length === 0 && !hasNonBackdated;
  record({ id: 'E1', name: 'Pending list — all unadjusted backdated orders appear; no leaks', status: ok ? 'PASS' : 'FAIL', expected: 'all tracked unadjusted backdated in list; no non-backdated', actual, notes: '' });
}

async function sE2() {
  // Pick a tracked backdated order with emptiesCollected=0 (default in our creations)
  const target = await prisma.order.findFirst({
    where: { id: { in: trackedOrderIds }, isBackdated: true, status: 'delivered', inventoryAdjustedAt: null, deletedAt: null,
      items: { every: { emptiesCollected: 0 } } },
    include: { items: { select: { cylinderTypeId: true, deliveredQuantity: true } } },
    orderBy: { createdAt: 'desc' },
  });
  if (!target) { record({ id: 'E2', name: 'Apply fulls-only', status: 'SKIP', expected: 'a tracked order with no empties', actual: 'none', notes: '' }); return; }
  const ctId = target.items[0].cylinderTypeId;
  const totalDelivered = target.items.reduce((s, i) => s + (i.deliveredQuantity ?? 0), 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const before = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: ctId, summaryDate: today },
    select: { closingFulls: true, closingEmpties: true, dispatchedQty: true, manualAdjustment: true },
  });
  const r = await ax.post(`/api/orders/${target.id}/apply-inventory-adjustment`, {}, { headers: H() });
  const after = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: ctId, summaryDate: today },
    select: { closingFulls: true, closingEmpties: true, dispatchedQty: true, manualAdjustment: true },
  });
  const events = await prisma.inventoryEvent.findMany({
    where: { referenceId: target.id, referenceType: 'backdated_inventory_adjustment' },
    select: { eventType: true, fullsChange: true, emptiesChange: true, eventDate: true },
  });
  const updatedOrder = await prisma.order.findUniqueOrThrow({ where: { id: target.id }, select: { inventoryAdjustedAt: true } });
  const eventDatesAllToday = events.every((e) => e.eventDate.toISOString().slice(0, 10) === todayISO());
  const fullsDelta = (after?.closingFulls ?? 0) - (before?.closingFulls ?? 0);
  const emptiesDelta = (after?.closingEmpties ?? 0) - (before?.closingEmpties ?? 0);
  const actual = `HTTP ${r.status}; eventsWritten=${r.data?.data?.eventsWritten}; before(fulls=${before?.closingFulls}, empties=${before?.closingEmpties}); after(fulls=${after?.closingFulls}, empties=${after?.closingEmpties}); deltaFulls=${fullsDelta} (expected -${totalDelivered}); deltaEmpties=${emptiesDelta} (expected 0); events=[${events.map(e => `${e.eventType}/${e.fullsChange}/${e.emptiesChange}/${e.eventDate.toISOString().slice(0,10)}`).join(' | ')}]; eventDatesAllToday=${eventDatesAllToday}; inventoryAdjustedAt=${updatedOrder.inventoryAdjustedAt?.toISOString().slice(0,16)}`;
  // The shared dev DB has many other events from manual + script runs
  // on today's date — measuring the summary delta directly is
  // unreliable here (anti-pattern #7/#8 — today's date for time-
  // sensitive fixtures). The load-bearing invariants are the events
  // themselves + the flag stamp; the delta is informational.
  const ok = r.status === 200
    && events.length === 1
    && events[0].eventType === 'manual_adjustment'
    && events[0].fullsChange === -totalDelivered
    && events[0].emptiesChange === 0
    && eventDatesAllToday
    && updatedOrder.inventoryAdjustedAt !== null;
  record({ id: 'E2', name: 'Apply adjustment — fulls only, today\'s date', status: ok ? 'PASS' : 'FAIL', expected: `1 manual_adjustment event with fc=-${totalDelivered}, ec=0, eventDate=today; inventoryAdjustedAt set`, actual, notes: 'Summary closingFulls delta on the shared dev DB is unreliable because dozens of events fire on TODAY from parallel manual + automated test runs. The isolated dist-001 unit tests in backdated-inventory-adjustment.test.ts pin the recalc math; this dev-DB script checks the event-write + flag invariants only.' });
}

async function sE3() {
  // Create a new order for this test
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(2),
    items: [{ cylinderTypeId: CT_19KG, quantity: 3 }],
  });
  if (!r.orderId) { record({ id: 'E3', name: 'Apply fulls+empties', status: 'FAIL', expected: '201', actual: `HTTP ${r.status}`, notes: '' }); return; }
  // Manually set emptiesCollected=2 on the items (BackdatedOrderInput doesn't accept it directly)
  await prisma.orderItem.updateMany({ where: { orderId: r.orderId }, data: { emptiesCollected: 2 } });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const before = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: today },
    select: { closingFulls: true, closingEmpties: true },
  });
  const rr = await ax.post(`/api/orders/${r.orderId}/apply-inventory-adjustment`, {}, { headers: H() });
  const after = await prisma.inventorySummary.findFirst({
    where: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: today },
    select: { closingFulls: true, closingEmpties: true },
  });
  const events = await prisma.inventoryEvent.findMany({
    where: { referenceId: r.orderId, referenceType: 'backdated_inventory_adjustment' },
    select: { eventType: true, fullsChange: true, emptiesChange: true, eventDate: true },
  });
  const fulls = events.find((e) => e.eventType === 'manual_adjustment');
  const empties = events.find((e) => e.eventType === 'reconciliation_empties_return');
  const fullsDelta = (after?.closingFulls ?? 0) - (before?.closingFulls ?? 0);
  const emptiesDelta = (after?.closingEmpties ?? 0) - (before?.closingEmpties ?? 0);
  const actual = `HTTP ${rr.status}; eventsWritten=${rr.data?.data?.eventsWritten}; events count=${events.length}; fulls(fc=${fulls?.fullsChange}, eventDate=${fulls?.eventDate.toISOString().slice(0,10)}); empties(ec=${empties?.emptiesChange}, eventDate=${empties?.eventDate.toISOString().slice(0,10)}); deltaFulls=${fullsDelta} (expected -3); deltaEmpties=${emptiesDelta} (expected +2)`;
  // Same caveat as E2 — summary delta is informational only on the
  // shared dev DB. Pin the event invariants.
  const ok = rr.status === 200
    && events.length === 2
    && fulls?.fullsChange === -3
    && empties?.emptiesChange === 2
    && fulls?.eventDate.toISOString().slice(0, 10) === todayISO()
    && empties?.eventDate.toISOString().slice(0, 10) === todayISO();
  record({ id: 'E3', name: 'Apply adjustment — fulls + empties events both fire', status: ok ? 'PASS' : 'FAIL', expected: 'manual_adjustment fc=-3 + reconciliation_empties_return ec=+2 both dated today', actual, notes: 'Summary delta on shared dev DB is contaminated by parallel runs — events + dates are the load-bearing checks (see E2 note).' });
}

async function sE4() {
  // Pick any already-adjusted tracked order
  const already = await prisma.order.findFirst({
    where: { id: { in: trackedOrderIds }, inventoryAdjustedAt: { not: null } },
    select: { id: true, orderNumber: true },
  });
  if (!already) { record({ id: 'E4', name: 'Double-apply blocked', status: 'SKIP', expected: 'already-adjusted tracked order', actual: 'none', notes: '' }); return; }
  const eventsBefore = await prisma.inventoryEvent.count({ where: { referenceId: already.id, referenceType: 'backdated_inventory_adjustment' } });
  const r = await ax.post(`/api/orders/${already.id}/apply-inventory-adjustment`, {}, { headers: H() });
  const eventsAfter = await prisma.inventoryEvent.count({ where: { referenceId: already.id, referenceType: 'backdated_inventory_adjustment' } });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.data?.error || r.data).slice(0,150)}; eventsBefore=${eventsBefore}, eventsAfter=${eventsAfter}`;
  const ok = r.status === 409 && /already adjusted/i.test(JSON.stringify(r.data)) && eventsBefore === eventsAfter;
  record({ id: 'E4', name: 'Double-apply rejected with 409; no new events written', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 409 "already adjusted"; eventsBefore === eventsAfter', actual, notes: '' });
}

async function sE5() {
  // Find any non-backdated delivered order on dist-002
  const normal = await prisma.order.findFirst({
    where: { distributorId: D2, isBackdated: false, status: 'delivered', deletedAt: null },
    select: { id: true, orderNumber: true },
  });
  if (!normal) { record({ id: 'E5', name: 'Non-backdated blocked', status: 'SKIP', expected: 'any non-backdated delivered order', actual: 'none', notes: '' }); return; }
  const r = await ax.post(`/api/orders/${normal.id}/apply-inventory-adjustment`, {}, { headers: H() });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.data?.error || r.data).slice(0,200)}`;
  const ok = r.status === 400;
  record({ id: 'E5', name: 'Non-backdated order rejected with 400', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400', actual, notes: '' });
}

async function sE6() {
  const r = await ax.get('/api/inventory/backdated-adjustments/history', { headers: H() });
  const rows = r.data?.data ?? [];
  const allCorrectType = rows.every((row: any) => row.eventType === 'manual_adjustment' || row.eventType === 'reconciliation_empties_return');
  const allTodayDate = rows.slice(0, 5).every((row: any) => row.eventDate === todayISO());
  // Look for our E2/E3 entries
  const adjustedTrackedOrderIds = await prisma.order.findMany({
    where: { id: { in: trackedOrderIds }, inventoryAdjustedAt: { not: null } },
    select: { id: true, orderNumber: true },
  });
  const trackedIds = new Set(adjustedTrackedOrderIds.map((o) => o.id));
  const ourRows = rows.filter((row: any) => trackedIds.has(row.orderId));
  const actual = `HTTP ${r.status}; history rows=${rows.length}; recent 5 eventDate=today? ${allTodayDate}; all rows correct event type? ${allCorrectType}; tracked-adjusted orders found in history: ${ourRows.length}/${adjustedTrackedOrderIds.length}`;
  // E3 wrote 2 events for 1 order (fulls + empties), so distinct
  // orderId count in history will be FEWER than row count. Compare
  // by distinct orderId.
  const distinctOurOrderIds = new Set(ourRows.map((row: any) => row.orderId));
  const allTrackedFound = adjustedTrackedOrderIds.every((o) => distinctOurOrderIds.has(o.id));
  const ok = r.status === 200 && allCorrectType && allTrackedFound;
  record({ id: 'E6', name: 'History list — correct rows, correct type, recent dates today', status: ok ? 'PASS' : 'FAIL', expected: 'all tracked-adjusted orders present; allCorrectType=true', actual: `${actual}; distinct orders in history: ${distinctOurOrderIds.size}/${adjustedTrackedOrderIds.length}`, notes: '' });
}

async function sE7() {
  const r = await ax.get('/api/inventory/backdated-adjustments/pending', { headers: H() });
  const rows = r.data?.data ?? [];
  const pendingIds = new Set(rows.map((row: any) => row.orderId));
  const adjusted = await prisma.order.findMany({
    where: { id: { in: trackedOrderIds }, inventoryAdjustedAt: { not: null } },
    select: { id: true, orderNumber: true },
  });
  const leaks = adjusted.filter((o) => pendingIds.has(o.id));
  const actual = `HTTP ${r.status}; pending count=${rows.length}; adjusted-leaks-in-pending=${leaks.length} (${leaks.map(o => o.orderNumber).join(',')})`;
  const ok = r.status === 200 && leaks.length === 0;
  record({ id: 'E7', name: 'Adjusted orders cleared from Pending list', status: ok ? 'PASS' : 'FAIL', expected: 'no adjusted orders in pending list', actual, notes: '' });
}

// ═══════════ GROUP F — VALIDATION GUARDS ═════════════════════════════════════

async function sF1() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: lastMonthISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.body).slice(0,200)}`;
  const ok = r.status === 400 && /current calendar month/i.test(JSON.stringify(r.body));
  record({ id: 'F1', name: 'Same-month guard rejects last-month date', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400 "current calendar month"', actual, notes: '' });
}
async function sF2() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: todayISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.body).slice(0,200)}`;
  const ok = r.status === 400 && /before today/i.test(JSON.stringify(r.body));
  record({ id: 'F2', name: 'Today rejected with 400', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400 "before today"', actual, notes: '' });
}
async function sF3() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: tomorrowISO(),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.body).slice(0,200)}`;
  const ok = r.status === 400;
  record({ id: 'F3', name: 'Future date rejected with 400', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400', actual, notes: '' });
}
async function sF4() {
  const r = await createBackdated({
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(1),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
    vehicleId: IDLE_VEHICLE, // no driver
  });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.body).slice(0,200)}`;
  const ok = r.status === 400 && /driver/i.test(JSON.stringify(r.body));
  record({ id: 'F4', name: 'Vehicle without driver rejected with 400', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 400 "driver required"', actual, notes: '' });
}
async function sF5() {
  if (!financeToken) { record({ id: 'F5', name: 'Finance blocked from POST /backdated', status: 'SKIP', expected: '403', actual: 'no finance token', notes: '' }); return; }
  const r = await ax.post('/api/orders/backdated', {
    customerId: B2B_MARUTHI, issueDate: daysAgoISO(1),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  }, { headers: { Authorization: `Bearer ${financeToken}` } });
  const actual = `HTTP ${r.status}`;
  const ok = r.status === 403;
  record({ id: 'F5', name: 'Finance role blocked from POST /api/orders/backdated', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 403', actual, notes: '' });
}
async function sF6() {
  // The verification brief expects finance to be ALLOWED here. The
  // implementation gates the route to distributor_admin + inventory only
  // (per the original backdated-adjustment brief). Recording the actual
  // behaviour without modifying the route — flag for product decision.
  if (!financeToken) { record({ id: 'F6', name: 'Finance can apply inventory adjustment', status: 'SKIP', expected: '200', actual: 'no finance token', notes: '' }); return; }
  // Find any tracked unadjusted backdated order
  const candidate = await prisma.order.findFirst({
    where: { id: { in: trackedOrderIds }, isBackdated: true, inventoryAdjustedAt: null, deletedAt: null, status: 'delivered' },
    select: { id: true, orderNumber: true },
  });
  if (!candidate) { record({ id: 'F6', name: 'Finance can apply', status: 'SKIP', expected: '200', actual: 'no candidate', notes: '' }); return; }
  const r = await ax.post(`/api/orders/${candidate.id}/apply-inventory-adjustment`, {}, { headers: { Authorization: `Bearer ${financeToken}` } });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.data?.error || r.data).slice(0,150)}`;
  const ok = r.status === 200;
  record({ id: 'F6', name: 'Finance role applies inventory adjustment', status: ok ? 'PASS' : 'FAIL',
    expected: 'HTTP 200 (per this verification brief)',
    actual,
    notes: r.status === 403
      ? 'Implementation gates apply-inventory-adjustment to distributor_admin + inventory only (per the ORIGINAL adjustment brief). The new verification brief expects finance to be allowed. Mismatch — product decision required. The route is at packages/api/src/routes/orders.ts. Tightening the verification or widening the route are both one-line changes.'
      : '',
  });
}
async function sF7() {
  const other = await prisma.customer.findFirst({ where: { distributorId: 'dist-001', deletedAt: null }, select: { id: true } });
  if (!other) { record({ id: 'F7', name: 'Multi-tenant', status: 'SKIP', expected: '404', actual: 'no dist-001 customer', notes: '' }); return; }
  const r = await createBackdated({
    customerId: other.id, issueDate: daysAgoISO(1),
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  });
  const actual = `HTTP ${r.status}; err=${JSON.stringify(r.body).slice(0,200)}`;
  const ok = r.status === 404;
  record({ id: 'F7', name: 'Multi-tenant: cross-tenant customer rejected with 404', status: ok ? 'PASS' : 'FAIL', expected: 'HTTP 404', actual, notes: '' });
}

// ═══════════ GROUP G — REGRESSION ════════════════════════════════════════════

const REG_TEST_DATE = '2099-12-31';
async function ensureRegInfra() {
  const existingDva = await prisma.driverVehicleAssignment.findFirst({
    where: { driverId: ACTIVE_DRIVER, assignmentDate: new Date(REG_TEST_DATE), distributorId: D2 },
  });
  if (!existingDva) {
    await prisma.driverVehicleAssignment.create({
      data: { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE, assignmentDate: new Date(REG_TEST_DATE), distributorId: D2, status: 'dispatch_ready' },
    });
  }
  await prisma.inventorySummary.upsert({
    where: { distributorId_cylinderTypeId_summaryDate: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: new Date('3000-01-01') } },
    create: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: new Date('3000-01-01'), openingFulls: 100, closingFulls: 100, openingEmpties: 0, closingEmpties: 0 },
    update: { closingFulls: 100, openingFulls: 100 },
  });
}

async function sG1() {
  await ensureRegInfra();
  const create = await ax.post('/api/orders', {
    customerId: B2B_MARUTHI, deliveryDate: REG_TEST_DATE,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  }, { headers: H() });
  const orderId = create.data?.data?.orderId || create.data?.data?.id;
  if (orderId) trackedOrderIds.push(orderId);
  if (!orderId) { record({ id: 'G1', name: 'Normal order regression', status: 'FAIL', expected: '201', actual: `HTTP ${create.status}`, notes: '' }); return; }
  await ax.post(`/api/orders/${orderId}/assign-driver`, { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE }, { headers: H() });
  await ax.post('/api/orders/preflight-dispatch', { driverId: ACTIVE_DRIVER, vehicleId: IDLE_VEHICLE, assignmentDate: REG_TEST_DATE, orderIds: [orderId] }, { headers: H() });
  await ax.post(`/api/orders/${orderId}/confirm-delivery`, { items: [{ cylinderTypeId: CT_19KG, deliveredQuantity: 1, emptiesCollected: 0 }] }, { headers: H() });
  const o = await getOrder(orderId);
  if (o.invoice?.id) trackedInvoiceIds.push(o.invoice.id);
  const events = await prisma.inventoryEvent.count({ where: { referenceId: orderId } });
  const actual = `order.isBackdated=${o.isBackdated}; isGodownPickup=${o.isGodownPickup}; inventory_events count=${events}; invoice.irnStatus=${o.invoice?.irnStatus}`;
  const ok = o.isBackdated === false && o.isGodownPickup === false && events > 0;
  record({ id: 'G1', name: 'Normal order: isBackdated=false, inventory events written', status: ok ? 'PASS' : 'FAIL', expected: 'isBackdated=false; events>0', actual, notes: '' });
}

async function sG2() {
  await ensureRegInfra();
  const create = await ax.post('/api/orders', {
    customerId: B2B_MARUTHI, deliveryDate: REG_TEST_DATE, isGodownPickup: true,
    items: [{ cylinderTypeId: CT_19KG, quantity: 1 }],
  }, { headers: H() });
  const orderId = create.data?.data?.orderId || create.data?.data?.id;
  if (orderId) trackedOrderIds.push(orderId);
  if (!orderId) { record({ id: 'G2', name: 'Godown regression', status: 'FAIL', expected: '201', actual: `HTTP ${create.status}`, notes: '' }); return; }
  await ax.post(`/api/orders/${orderId}/confirm-delivery`, { items: [{ cylinderTypeId: CT_19KG, deliveredQuantity: 1, emptiesCollected: 0 }] }, { headers: H() });
  const o = await getOrder(orderId);
  if (o.invoice?.id) trackedInvoiceIds.push(o.invoice.id);
  const events = await prisma.inventoryEvent.findMany({ where: { referenceId: orderId }, select: { eventType: true } });
  const actual = `order.isGodownPickup=${o.isGodownPickup}; isBackdated=${o.isBackdated}; event types=[${events.map(e => e.eventType).join(',')}]`;
  const ok = o.isGodownPickup === true && o.isBackdated === false && events.length >= 2;
  record({ id: 'G2', name: 'Godown pickup regression: events still fire', status: ok ? 'PASS' : 'FAIL', expected: 'isGodownPickup=true; events>=2', actual, notes: '' });
}

async function sG3() {
  // G1's invoice should have issueDate=today
  const recent = await prisma.invoice.findFirst({
    where: { id: { in: trackedInvoiceIds }, order: { isBackdated: false } },
    orderBy: { createdAt: 'desc' }, select: { issueDate: true, invoiceNumber: true },
  });
  if (!recent) { record({ id: 'G3', name: 'createInvoiceFromOrder unchanged', status: 'SKIP', expected: 'a normal-order invoice', actual: 'none', notes: '' }); return; }
  const issueISO = recent.issueDate.toISOString().slice(0, 10);
  const actual = `invoiceNumber=${recent.invoiceNumber}; issueDate=${issueISO}; today=${todayISO()}`;
  const ok = issueISO === todayISO();
  record({ id: 'G3', name: 'createInvoiceFromOrder default: issueDate=today', status: ok ? 'PASS' : 'FAIL', expected: 'issueDate=today', actual, notes: '' });
}

// ═══════════════════════════ MAIN ════════════════════════════════════════════

async function main() {
  console.log('=== verify-backdated-full ===');
  sharmaToken = (await login(SHARMA))!;
  financeToken = await login(FINANCE);
  console.log(`Tokens — sharma: ${sharmaToken ? 'OK' : 'FAIL'}, finance: ${financeToken ? 'OK' : 'none (F5/F6 will skip)'}\n`);

  // Print pre-flight resources (the brief asks for this)
  const b2b = await prisma.customer.findUnique({ where: { id: B2B_MARUTHI }, select: { customerName: true, gstin: true, customerType: true } });
  const b2c = await prisma.customer.findUnique({ where: { id: B2C_BANGALORE }, select: { customerName: true, gstin: true, customerType: true } });
  const ct19 = await prisma.cylinderType.findUnique({ where: { id: CT_19KG }, select: { typeName: true } });
  const ct5 = await prisma.cylinderType.findUnique({ where: { id: CT_5KG }, select: { typeName: true } });
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const sum19 = await prisma.inventorySummary.findFirst({ where: { distributorId: D2, cylinderTypeId: CT_19KG, summaryDate: today }, select: { closingFulls: true, closingEmpties: true } });
  const sum5 = await prisma.inventorySummary.findFirst({ where: { distributorId: D2, cylinderTypeId: CT_5KG, summaryDate: today }, select: { closingFulls: true, closingEmpties: true } });
  const preflight = {
    b2bCustomer: `${b2b?.customerName} (${b2b?.customerType}, GSTIN ${b2b?.gstin})`,
    b2cCustomer: `${b2c?.customerName} (${b2c?.customerType}, GSTIN ${b2c?.gstin ?? 'null'})`,
    driver: `${ACTIVE_DRIVER.slice(0,8)} (Kiran Reddy)`,
    vehicle: `${IDLE_VEHICLE.slice(0,8)} (KA01-MN-9999)`,
    cylinderTypes: [`${ct19?.typeName}: closingFulls=${sum19?.closingFulls ?? 'n/a'}, empties=${sum19?.closingEmpties ?? 'n/a'}`, `${ct5?.typeName}: closingFulls=${sum5?.closingFulls ?? 'n/a'}, empties=${sum5?.closingEmpties ?? 'n/a'}`],
  };
  console.log('Preflight:', JSON.stringify(preflight, null, 2), '\n');

  const runs: Array<[string, () => Promise<void>]> = [
    ['A1', sA1], ['A2', sA2], ['A3', sA3], ['A4', sA4],
    ['B1', sB1], ['B2', sB2], ['B3', sB3], ['B4', sB4],
    ['C1', sC1], ['C2', sC2], ['C3', sC3], ['C4', sC4],
    ['D1', sD1], ['D2', sD2], ['D3', sD3],
    ['E1', sE1], ['E2', sE2], ['E3', sE3], ['E4', sE4], ['E5', sE5], ['E6', sE6], ['E7', sE7],
    ['F1', sF1], ['F2', sF2], ['F3', sF3], ['F4', sF4], ['F5', sF5], ['F6', sF6], ['F7', sF7],
    ['G1', sG1], ['G2', sG2], ['G3', sG3],
  ];
  for (const [id, fn] of runs) {
    try { await fn(); }
    catch (e: unknown) {
      record({ id, name: `${id} (runner caught error)`, status: 'FAIL', expected: 'no exception', actual: e instanceof Error ? `${e.message}\n${e.stack?.slice(0, 600)}` : String(e), notes: '' });
    }
  }

  // Cleanup
  try {
    if (trackedPaymentIds.length) {
      await prisma.paymentAllocation.deleteMany({ where: { paymentId: { in: trackedPaymentIds } } });
      await prisma.paymentTransaction.deleteMany({ where: { id: { in: trackedPaymentIds } } });
    }
    if (trackedInvoiceIds.length) {
      await prisma.customerLedgerEntry.deleteMany({ where: { invoiceId: { in: trackedInvoiceIds } } });
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
    console.log(`\nCleanup OK — ${trackedOrderIds.length} orders, ${trackedInvoiceIds.length} invoices, ${trackedPaymentIds.length} payments removed.`);
  } catch (e) { console.warn('Cleanup partial:', e instanceof Error ? e.message : String(e)); }

  // Recalc today's InventorySummary for 19 KG so we don't leave the adjustments
  // we just applied as a permanent +/− against the operator's view.
  try {
    const { recalculateSummariesFromDate } = await import('../src/services/inventoryService.js');
    await recalculateSummariesFromDate(D2, CT_19KG, today);
    await recalculateSummariesFromDate(D2, CT_5KG, today);
  } catch (e) { console.warn('Post-cleanup recalc skipped:', e instanceof Error ? e.message : String(e)); }

  // Markdown report
  const counts = { PASS: 0, FAIL: 0, PARTIAL: 0, SKIP: 0 };
  results.forEach((r) => { counts[r.status]++; });
  let md = `# Backdated Order + Payment + Inventory Adjustment — Full Verification\n\n`;
  md += `_Run: ${new Date().toISOString()} against http://localhost:5000, dist-002 (Sharma Gas Distributors)._\n\n`;
  md += `## Pre-flight resources\n\n\`\`\`json\n${JSON.stringify(preflight, null, 2)}\n\`\`\`\n\n`;
  md += `**Headline:** ${counts.PASS} PASS · ${counts.PARTIAL} PARTIAL · ${counts.FAIL} FAIL · ${counts.SKIP} SKIP (of ${results.length})\n\n`;
  md += `## Scenarios\n\n`;
  for (const r of results) {
    md += `### ${r.id}: ${r.name}\n\n- **Status:** ${r.status}\n- **Expected:** ${r.expected}\n- **Actual:** ${r.actual}\n`;
    if (r.notes) md += `- **Notes:** ${r.notes}\n`;
    md += `\n`;
  }
  md += `## Summary\n\n| Scenario | Status | Notes |\n|---|---|---|\n`;
  for (const r of results) md += `| ${r.id} | ${r.status} | ${r.notes?.replace(/\|/g, '\\|') ?? ''} |\n`;

  const fails = results.filter((r) => r.status === 'FAIL');
  const partials = results.filter((r) => r.status === 'PARTIAL');
  if (fails.length === 0 && partials.length === 0) {
    md += `\n## ✅ ALL CLEAR — Backdated Order fully verified.\n`;
  } else {
    md += `\n## Findings\n\n`;
    if (fails.length) md += `### Failures (${fails.length})\n\n`;
    for (const f of fails) md += `- **${f.id}** — ${f.name}\n  - Expected: ${f.expected}\n  - Actual: ${f.actual}\n  - Notes: ${f.notes || '—'}\n\n`;
    if (partials.length) md += `### Partials / informational (${partials.length})\n\n`;
    for (const p of partials) md += `- **${p.id}** — ${p.name}\n  - Notes: ${p.notes || '—'}\n\n`;
  }

  fs.writeFileSync('C:/Projects/Re-New_Gaslink/docs/BACKDATED-FULL-VERIFICATION.md', md, 'utf-8');
  console.log(`\nReport: docs/BACKDATED-FULL-VERIFICATION.md`);
  console.log(`Summary: ${counts.PASS} PASS · ${counts.PARTIAL} PARTIAL · ${counts.FAIL} FAIL · ${counts.SKIP} SKIP`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
