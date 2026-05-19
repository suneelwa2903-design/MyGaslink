/**
 * WI-076 smoke test — create one B2B + one B2C order via the live API,
 * run preflight dispatch, report the NIC IRN/EWB result and any error
 * codes for each. Designed to be run twice: BEFORE the fix (current
 * payload — expect 616 on B2B) and AFTER (expect success on both).
 *
 *   npx tsx packages/api/scripts/smoke-test-ewb.ts
 *
 * Assumes:
 *   - API running on http://localhost:5000
 *   - Postgres seeded with dist-002 (Sharma) + customers/vehicles/drivers
 *   - WhiteBooks sandbox creds live for dist-002
 */

import { prisma } from '../src/lib/prisma.js';

const BASE_URL = process.env.SMOKE_API_BASE || 'http://localhost:5000/api';
const DISTRIBUTOR_ID = 'dist-002';

// Hard-coded IDs from the dist-002 seed (verified before writing).
const DRIVER_ID = '23f33fbf-645d-44a4-bf91-4258f80df668';     // Kiran Reddy
const VEHICLE_ID = '03a8bfab-23d4-42c2-9adc-a95785fc9e02';     // KA01-MN-9999
const CYL_19KG = 'f28f393a-6852-4f14-a108-a55fb574b639';
const MARUTHI_ID = '582c85b8-3aed-42a8-ab94-e6f4f9f75bd7';        // B2B intra-state (KA→KA)
const HYDERABAD_CATERERS_ID = 'e055c431-43b9-4d07-8651-89122c0fe722'; // B2B inter-state (KA→TS)
const BANGALORE_FOODS_ID = '7f3231f7-adf1-4dab-9cdf-6a7065bb62d1';    // B2C URP

const LOGIN = { email: 'sharma@gasdist.com', password: 'Gstadmin@123' };

const today = new Date().toISOString().slice(0, 10);

async function api(token: string | null, method: string, path: string, body?: any) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Distributor-Id': DISTRIBUTOR_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function login(): Promise<string> {
  const r = await api(null, 'POST', '/auth/login', LOGIN);
  const token = r.data?.tokens?.accessToken || r.data?.token || r.token;
  if (!token) throw new Error('No token in login response: ' + JSON.stringify(r));
  return token;
}

async function ensureAssignment(token: string) {
  // Best-effort: create today's DVA. Ignore "already exists".
  try {
    await api(token, 'POST', '/assignments', {
      driverId: DRIVER_ID, vehicleId: VEHICLE_ID, assignmentDate: today,
    });
    console.log(`  DVA created for ${today}`);
  } catch (e: any) {
    console.log(`  DVA already exists (or skipped): ${e.message.slice(0, 100)}`);
  }
}

async function createOrder(token: string, label: string, customerId: string) {
  const r = await api(token, 'POST', '/orders', {
    customerId,
    deliveryDate: today,
    items: [{ cylinderTypeId: CYL_19KG, quantity: 1 }],
  });
  const order = r.data || r;
  const id = order.id || order.orderId;
  console.log(`  [${label}] order created: ${order.orderNumber} (${id})`);
  return { ...order, id };
}

async function assignDriver(token: string, orderId: string, label: string) {
  await api(token, 'POST', `/orders/${orderId}/assign-driver`, {
    driverId: DRIVER_ID, vehicleId: VEHICLE_ID,
  });
  console.log(`  [${label}] driver assigned`);
}

async function preflight(token: string) {
  // Try preflight-dispatch first; if driver already has an active trip,
  // fall back to add-to-trip (same payload builders → same fix surface).
  const body = { driverId: DRIVER_ID, assignmentDate: today };
  try {
    console.log('\n--- Calling POST /orders/preflight-dispatch ---');
    const r = await api(token, 'POST', '/orders/preflight-dispatch', body);
    return r.data || r;
  } catch (e: any) {
    if (!e.message.includes('ALREADY_DISPATCHED')) throw e;
    console.log('  Driver already has active trip — falling back to /preflight-add-to-trip');
    const r = await api(token, 'POST', '/orders/preflight-add-to-trip', body);
    return r.data || r;
  }
}

async function reportPerOrder(orderId: string, label: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { orderNumber: true, status: true, customer: { select: { customerName: true, gstin: true, customerType: true } } },
  });
  const invoice = await prisma.invoice.findFirst({
    where: { orderId },
    select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true },
  });
  const gstDoc = invoice ? await prisma.gstDocument.findFirst({
    where: { invoiceId: invoice.id, isLatest: true, deletedAt: null },
    select: { irn: true, irnStatus: true, ewbNo: true, ewbStatus: true, ewbDate: true },
  }) : null;
  const recentLogs = invoice ? await prisma.gstApiLog.findMany({
    where: { invoiceId: invoice.id },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { apiType: true, createdAt: true, responsePayload: true },
  }) : [];

  console.log(`\n[${label}] ${order?.orderNumber} → ${order?.customer?.customerName} (${order?.customer?.customerType}, gstin=${order?.customer?.gstin ?? 'URP'})`);
  console.log(`  order.status:       ${order?.status}`);
  console.log(`  invoice.number:     ${invoice?.invoiceNumber ?? '—'}`);
  console.log(`  invoice.irnStatus:  ${invoice?.irnStatus ?? '—'}  | irn=${invoice?.irn ? invoice.irn.slice(0, 16) + '…' : 'null'}`);
  console.log(`  invoice.ewbStatus:  ${invoice?.ewbStatus ?? '—'}`);
  console.log(`  gstDoc.ewbNo:       ${gstDoc?.ewbNo ?? 'null'}`);
  console.log(`  gstDoc.ewbStatus:   ${gstDoc?.ewbStatus ?? '—'}`);
  console.log(`  recent api calls (newest first):`);
  for (const log of recentLogs) {
    const resp = log.responsePayload as any;
    const status = resp?.status_cd;
    const ok = status === '1' || status === 1;
    const errCode = resp?.error?.message
      ? (() => { try { return JSON.parse(resp.error.message).errorCodes?.replace(/,\s*$/, '') ?? ''; } catch { return resp.error.message; } })()
      : '';
    const errSummary = ok ? '' : ` errorCode=${errCode}`;
    console.log(`    ${log.createdAt.toISOString()}  ${log.apiType.padEnd(28)} status_cd=${status}${errSummary}`);
  }
}

async function main() {
  console.log(`\n========== WI-076 SMOKE TEST ==========`);
  console.log(`date:        ${today}`);
  console.log(`distributor: ${DISTRIBUTOR_ID}`);
  console.log(`api base:    ${BASE_URL}\n`);

  console.log('Step 1: login');
  const token = await login();
  console.log('  token acquired\n');

  console.log('Step 2: ensure DVA');
  await ensureAssignment(token);

  console.log('\nStep 3: create orders');
  const b2bIntraOrder = await createOrder(token, 'B2B-INTRA', MARUTHI_ID);
  const b2bInterOrder = await createOrder(token, 'B2B-INTER', HYDERABAD_CATERERS_ID);
  const b2cOrder = await createOrder(token, 'B2C', BANGALORE_FOODS_ID);

  console.log('\nStep 4: assign driver+vehicle');
  await assignDriver(token, b2bIntraOrder.id, 'B2B-INTRA');
  await assignDriver(token, b2bInterOrder.id, 'B2B-INTER');
  await assignDriver(token, b2cOrder.id, 'B2C');

  console.log('\nStep 5: run preflight');
  const preflightResult = await preflight(token);
  console.log('\nPreflight summary:', JSON.stringify(preflightResult.summary ?? preflightResult, null, 2));
  console.log('\nPer-order preflight results:');
  for (const r of (preflightResult.results ?? [])) {
    console.log(`  ${r.orderNumber}: success=${r.success} mode=${r.mode} irn=${r.irn?.slice(0, 16) ?? 'null'}… ewb=${r.ewbNo ?? 'null'} ${r.errorCode ? `err=${r.errorCode}` : ''}`);
  }

  console.log('\n========== DB STATE AFTER PREFLIGHT ==========');
  await reportPerOrder(b2bIntraOrder.id, 'B2B-INTRA');
  await reportPerOrder(b2bInterOrder.id, 'B2B-INTER');
  await reportPerOrder(b2cOrder.id, 'B2C');

  console.log('\n========== END ==========\n');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('\nSmoke test crashed:', e);
  await prisma.$disconnect();
  process.exit(1);
});
