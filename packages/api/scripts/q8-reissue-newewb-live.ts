/**
 * Q8 — LIVE NIC sandbox forensics for the proposed B2B "full reissue + new EWB"
 * flow. READ-the-answers test; isolated + self-cleaning.
 *
 * Isolation (anti-pattern #7/#8): the test order uses deliveryDate=2099-12-31
 * and a DEDICATED test vehicle, so preflight/dispatch can never sweep real
 * manual-test orders on the shared dev DB.
 *
 * One B2B order (Maruthi Agencies, intra-state Karnataka) answers both:
 *   1. dispatch                       → IRN1 + EWB1 (docNo = INV-A)
 *   2. cancelEwb(invoice)             → EWB_CANCEL  (NIC response captured)
 *   3. cancelIrn(invoice)             → IRN_CANCEL  (validates EWB_ACTIVE guard passes)
 *   4. (Q8b) GENERATE same docNo INV-A→ does NIC accept IRN reuse on a cancelled docNo?
 *   5. bump docNo → INV-A-R1; GENERATE→ new IRN2 on revised doc (expect success)
 *   6. (Q8a) genewaybill on IRN2      → does NIC accept a NEW EWB linked to the new IRN?  ← THE UNKNOWN
 *   7. cleanup: cancel EWB2 + IRN2, soft-cancel the order
 *
 * Raw NIC bodies are read back from gst_api_logs (apiCall persists both
 * success and failure — anti-pattern #11).
 *
 * Run (from packages/api):  pnpm exec tsx --env-file=.env scripts/q8-reissue-newewb-live.ts
 * Requires: API on :5000, WhiteBooks sandbox reachable, NODE_ENV != production, dist-002 sandbox.
 */
import { prisma } from '../src/lib/prisma.js';
import { apiCall, getCredentials, clearTokenCache } from '../src/services/gst/whitebooksClient.js';
import { cancelEwb, cancelIrn, parseEwbResponse } from '../src/services/gst/gstService.js';
import { buildIrnPayload, buildEwbPayload } from '../src/services/gst/payloadBuilders.js';

const BASE = 'http://localhost:5000/api';
const DIST = 'dist-002';
const TEST_DATE = '2099-12-31';
const TEST_VEHICLE_NO = 'KA01TE2099'; // RTO-format plate (NIC EWB rejects non-conforming numbers with error 225)

const C = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m' };
const ts = () => new Date().toISOString().slice(11, 23);
const log = (...a: any[]) => console.log(`${C.dim}[${ts()}]${C.reset}`, ...a);
const hdr = (s: string) => console.log(`\n${C.bold}${C.cyan}${'='.repeat(72)}\n${s}\n${'='.repeat(72)}${C.reset}`);
const stepH = (s: string) => console.log(`\n${C.bold}${C.yellow}-- ${s} --${C.reset}`);
const extractStateCode = (g: string) => g.substring(0, 2);
const toNum = (x: any) => Number(x ?? 0);

async function http(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data: any; try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

function nicSummary(resp: any): string {
  if (resp == null) return `${C.red}NULL${C.reset}`;
  const sc = resp.status_cd;
  if (sc === '1' || sc === 1) return `${C.green}status_cd=1 SUCCESS${C.reset}`;
  let detail = resp.status_desc ?? resp.error?.message ?? JSON.stringify(resp);
  return `${C.red}status_cd=${sc ?? '?'} ${String(detail).slice(0, 200)}${C.reset}`;
}

// Read back the raw NIC body for the most recent log row of a given apiType.
async function lastLog(invoiceId: string, apiType: string) {
  const l = await prisma.gstApiLog.findFirst({
    where: { invoiceId, apiType },
    orderBy: { createdAt: 'desc' },
    select: { status: true, httpStatus: true, errorCode: true, errorMessage: true, requestPayload: true, responsePayload: true },
  });
  return l;
}

// Build the same invoiceData shape processInvoiceGst uses (gstService.ts:140-180).
async function buildInvoiceData(invoiceId: string, distributorId: string) {
  const distributor = await prisma.distributor.findUniqueOrThrow({
    where: { id: distributorId },
    select: { gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true },
  });
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: { items: { include: { cylinderType: true } }, customer: true, order: { include: { vehicle: true } } },
  });
  const sellerStateCode = extractStateCode(distributor.gstin!);
  const buyerStateCode = invoice.customer?.gstin ? extractStateCode(invoice.customer.gstin) : sellerStateCode;
  return {
    invoice,
    distributor,
    invoiceData: {
      docType: 'INV' as const,
      docNumber: invoice.invoiceNumber,
      docDate: invoice.issueDate,
      seller: {
        gstin: distributor.gstin!, legalName: distributor.legalName, tradeName: distributor.businessName,
        address: distributor.address || '', city: distributor.city || '', pincode: distributor.pincode || '',
        state: distributor.state || '', stateCode: sellerStateCode,
        phone: distributor.phone || undefined, email: distributor.email || undefined,
      },
      buyer: {
        gstin: invoice.customer?.gstin || null,
        legalName: invoice.customer?.businessName || invoice.customer?.customerName || 'Consumer',
        tradeName: invoice.customer?.customerName || undefined,
        address: invoice.customer?.billingAddressLine1 || '', address2: invoice.customer?.billingAddressLine2 || undefined,
        city: invoice.customer?.billingCity || '', pincode: invoice.customer?.billingPincode || '',
        state: invoice.customer?.billingState || '', stateCode: buyerStateCode,
        phone: invoice.customer?.phone || undefined, email: invoice.customer?.email || undefined,
      },
      items: invoice.items.map((item, idx) => ({
        slNo: idx + 1,
        description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
        hsnCode: item.hsnCode || '27111900', quantity: item.quantity, unit: 'NOS',
        unitPrice: toNum(item.unitPrice) + toNum(item.discountPerUnit),
        discountPerUnit: toNum(item.discountPerUnit), gstRate: item.gstRate || 18,
      })),
      isInterState: sellerStateCode !== buyerStateCode,
    },
  };
}

function bumpInvoiceNumber(n: string): string {
  const MAX = 16;
  const m = n.match(/^(.*)-R(\d+)$/);
  const base = m ? m[1] : n;
  const next = m ? parseInt(m[2], 10) + 1 : 1;
  const suffix = `-R${next}`;
  const room = Math.max(MAX - suffix.length, 1);
  return `${base.length > room ? base.substring(0, room) : base}${suffix}`;
}

async function main() {
  hdr('  Q8 — LIVE B2B FULL-REISSUE + NEW-EWB FORENSICS (dist-002 sandbox)');
  log(`date=${TEST_DATE} (isolated)  api=${BASE}  distributor=${DIST}`);

  const dist = await prisma.distributor.findUniqueOrThrow({ where: { id: DIST }, select: { gstMode: true } });
  if (dist.gstMode !== 'sandbox') throw new Error(`ABORT: dist-002 gstMode=${dist.gstMode}, expected sandbox`);

  // ── Auth ──
  const loginRes = await http('POST', '/auth/login', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  const token = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken;
  if (!token) throw new Error('login failed');
  log('logged in as sharma@gasdist.com');

  // ── Fixtures ──
  const customer = await prisma.customer.findFirstOrThrow({ where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null }, select: { id: true, customerName: true, gstin: true } });
  const driver = await prisma.driver.findFirstOrThrow({ where: { distributorId: DIST, status: 'active', deletedAt: null }, select: { id: true, driverName: true } });
  const cylType = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST, capacity: 19 }, select: { id: true } });

  // Dedicated test vehicle (anti-pattern #7 isolation)
  let vehicle = await prisma.vehicle.findFirst({ where: { distributorId: DIST, vehicleNumber: TEST_VEHICLE_NO }, select: { id: true, vehicleNumber: true } });
  if (!vehicle) {
    vehicle = await prisma.vehicle.create({ data: { distributorId: DIST, vehicleNumber: TEST_VEHICLE_NO, vehicleType: 'truck', status: 'idle', capacity: 100 }, select: { id: true, vehicleNumber: true } });
  }
  // DVA for the isolated date
  await prisma.driverVehicleAssignment.upsert({
    where: { driverId_assignmentDate_tripNumber: { driverId: driver.id, assignmentDate: new Date(TEST_DATE), tripNumber: 1 } },
    create: { driverId: driver.id, vehicleId: vehicle.id, distributorId: DIST, assignmentDate: new Date(TEST_DATE), tripNumber: 1, status: 'dispatch_ready' },
    update: { vehicleId: vehicle.id, status: 'dispatch_ready' },
  });
  log(`fixtures: customer=${customer.customerName} gstin=${customer.gstin} driver=${driver.driverName} vehicle=${vehicle.vehicleNumber}`);

  // ── 1. Create + dispatch ──
  stepH('1. Create + assign + preflight-dispatch B2B order (isolated date)');
  const cr = await http('POST', '/orders', { customerId: customer.id, deliveryDate: TEST_DATE, items: [{ cylinderTypeId: cylType.id, quantity: 1 }] }, token);
  const orderId = cr.data?.data?.orderId || cr.data?.data?.id;
  if (!orderId) throw new Error(`order create failed: ${JSON.stringify(cr.data).slice(0, 200)}`);
  log(`order ${cr.data?.data?.orderNumber} id=${orderId}`);
  await http('POST', `/orders/${orderId}/assign-driver`, { driverId: driver.id, vehicleId: vehicle.id }, token);
  const pf = await http('POST', '/orders/preflight-dispatch', { driverId: driver.id, assignmentDate: TEST_DATE }, token);
  log(`preflight HTTP ${pf.status}`);

  const orderRow = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } } });
  const inv = orderRow.invoice;
  if (!inv) throw new Error('no invoice created');
  const invoiceId = inv.id;
  const docNoOriginal = inv.invoiceNumber;
  log(`invoice ${docNoOriginal}  irnStatus=${inv.irnStatus}  ewbStatus=${inv.ewbStatus}  IRN1=${inv.irn?.slice(0, 24)}...`);
  if (inv.irnStatus !== 'success' || !inv.irn) throw new Error(`dispatch did not yield IRN (irnStatus=${inv.irnStatus}) — cannot continue`);
  const ewb1Log = await lastLog(invoiceId, 'EWB_GENERATE_BY_IRN');
  log(`EWB1: ${nicSummary(ewb1Log?.responsePayload)}`);

  // ── 2. Cancel EWB ──
  stepH('2. cancelEwb (Step 1 of reissue)');
  clearTokenCache(DIST);
  try { await cancelEwb(invoiceId, DIST, 'Q8 reissue test'); log('cancelEwb returned OK'); }
  catch (e: any) { log(`${C.red}cancelEwb threw: ${e.code} ${e.message}${C.reset}`); }
  log(`EWB_CANCEL NIC: ${nicSummary((await lastLog(invoiceId, 'EWB_CANCEL'))?.responsePayload)}`);

  // ── 3. Cancel IRN ──
  stepH('3. cancelIrn (Step 2 — validates EWB_ACTIVE guard passes after EWB cancel)');
  try { await cancelIrn(invoiceId, DIST, 'Q8 reissue test'); log('cancelIrn returned OK'); }
  catch (e: any) { log(`${C.red}cancelIrn threw: ${e.code} ${e.message}${C.reset}`); }
  log(`IRN_CANCEL NIC: ${nicSummary((await lastLog(invoiceId, 'IRN_CANCEL'))?.responsePayload)}`);

  // ── 4. (Q8b) GENERATE with the SAME docNo ──
  stepH(`4. (Q8b) GENERATE IRN reusing the SAME docNo "${docNoOriginal}" (no bump)`);
  {
    const { invoiceData } = await buildInvoiceData(invoiceId, DIST);
    const irnPayload = buildIrnPayload(invoiceData);
    const credEmail = (await getCredentials(DIST, 'einvoice'))?.email || 'info@mygaslink.com';
    let q8bResp: any = null;
    try {
      q8bResp = await apiCall(DIST, 'POST', `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`, irnPayload, 'einvoice', { apiType: 'Q8B_IRN_SAMEDOC', invoiceId, orderId });
      log(`${C.yellow}Q8b: NIC ACCEPTED reuse of cancelled docNo (unexpected)${C.reset}`);
    } catch (e: any) {
      log(`Q8b GENERATE threw: code=${e.code} msg=${String(e.message).slice(0, 160)}`);
    }
    const q8bLog = await lastLog(invoiceId, 'Q8B_IRN_SAMEDOC');
    log(`Q8b NIC response: ${nicSummary(q8bLog?.responsePayload ?? q8bResp)}`);
  }

  // ── 5. Bump docNo → new IRN ──
  stepH('5. Bump docNo and GENERATE new IRN on revised doc (Step 3)');
  const docNoRevised = bumpInvoiceNumber(docNoOriginal);
  await prisma.invoice.update({ where: { id: invoiceId }, data: { invoiceNumber: docNoRevised } });
  log(`docNo bumped: ${docNoOriginal} -> ${docNoRevised} (${docNoRevised.length} chars)`);
  let irn2: string | null = null;
  {
    const { invoiceData } = await buildInvoiceData(invoiceId, DIST);
    const irnPayload = buildIrnPayload(invoiceData);
    const credEmail = (await getCredentials(DIST, 'einvoice'))?.email || 'info@mygaslink.com';
    try {
      const r: any = await apiCall(DIST, 'POST', `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`, irnPayload, 'einvoice', { apiType: 'Q8_IRN_REVISED', invoiceId, orderId });
      irn2 = r.data?.Irn || r.Irn;
      await prisma.invoice.update({ where: { id: invoiceId }, data: { irn: irn2, irnStatus: 'success', ewbStatus: 'not_attempted' } });
      log(`${C.green}new IRN2 generated: ${irn2?.slice(0, 32)}...${C.reset}`);
    } catch (e: any) {
      log(`${C.red}new IRN GENERATE failed: code=${e.code} ${String(e.message).slice(0, 160)}${C.reset}`);
    }
    log(`IRN2 NIC response: ${nicSummary((await lastLog(invoiceId, 'Q8_IRN_REVISED'))?.responsePayload)}`);
  }

  // ── 6. (Q8a) NEW EWB linked to new IRN ── THE UNKNOWN
  stepH('6. (Q8a) genewaybill — NEW B2B EWB linked to the new IRN (proposed Step 4)');
  if (irn2) {
    const { invoiceData } = await buildInvoiceData(invoiceId, DIST);
    const irnPayload = buildIrnPayload(invoiceData);
    const ewbPayload = buildEwbPayload(irnPayload, { vehicleNumber: vehicle.vehicleNumber, transportMode: '1', distance: 1 });
    log(`EWB payload check: docNo=${ewbPayload.docNo} transactionType=${ewbPayload.transactionType} shipToGSTIN=${ewbPayload.shipToGSTIN ?? 'omitted'} dispatchFromGSTIN=${ewbPayload.dispatchFromGSTIN ?? 'omitted'}`);
    const credEmail = (await getCredentials(DIST, 'einvoice'))?.email || 'info@mygaslink.com';
    try {
      const r: any = await apiCall(DIST, 'POST', `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`, ewbPayload, 'ewaybill', { apiType: 'Q8A_EWB_REVISED', invoiceId, orderId });
      const parsed = parseEwbResponse(r);
      log(`${C.green}>>> Q8a ANSWER: NIC ACCEPTED new EWB. ewbNo=${parsed.ewbNo}${C.reset}`);
      if (parsed.ewbNo) await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
    } catch (e: any) {
      log(`${C.red}>>> Q8a ANSWER: NIC REJECTED new EWB. code=${e.code} ${String(e.message).slice(0, 220)}${C.reset}`);
    }
    log(`Q8a NIC response: ${nicSummary((await lastLog(invoiceId, 'Q8A_EWB_REVISED'))?.responsePayload)}`);
  } else {
    log(`${C.yellow}skipped — no new IRN to link the EWB to${C.reset}`);
  }

  // ── 7. Cleanup: cancel live docs + soft-cancel order ──
  stepH('7. Cleanup (cancel live EWB2/IRN2, soft-cancel order)');
  try { await cancelEwb(invoiceId, DIST, 'Q8 cleanup'); log('cleanup: EWB2 cancelled'); } catch (e: any) { log(`cleanup EWB cancel: ${e.code ?? e.message}`); }
  try { await cancelIrn(invoiceId, DIST, 'Q8 cleanup'); log('cleanup: IRN2 cancelled'); } catch (e: any) { log(`cleanup IRN cancel: ${e.code ?? e.message}`); }
  await prisma.order.update({ where: { id: orderId }, data: { status: 'cancelled' } }).catch(() => {});
  log('cleanup: order marked cancelled');

  hdr('  Q8 COMPLETE — see Q8a / Q8b answers above');
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(`\n${C.red}SCRIPT CRASHED:${C.reset}`, e); await prisma.$disconnect(); process.exit(2); });
