/**
 * WI-087 Vehicle Workflow Guard Verification
 *
 * Verifies two new safety guards introduced in WI-087:
 *   Bug 1 — markVehicleReturned must block if any pending_delivery orders exist
 *   Bug 2 — confirmDelivery must block (409) if the vehicle is already returned
 *
 * Uses Prisma directly for fixture setup (no full GST flow needed).
 * Calls real API endpoints to exercise the route → service path.
 *
 * Run:
 *   pnpm --filter api tsx scripts/test-vehicle-workflow.ts
 * Requires: API on :5000, NODE_ENV != production.
 */

import { prisma } from '../src/lib/prisma.js';

const BASE  = 'http://localhost:5000';
const APIB  = `${BASE}/api`;
const DIST  = 'dist-002';
// Far-future date so fixtures never collide with real manual-test data (Anti-pattern #7)
const TEST_DATE = '2099-12-31';

// ─── Colours ─────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',  green: '\x1b[32m', red:    '\x1b[31m',
  yellow: '\x1b[33m', cyan:  '\x1b[36m', bold:   '\x1b[1m',  dim: '\x1b[2m',
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
const api = (m: string, p: string, b?: unknown, t?: string) =>
  http(m, `${APIB}${p}`, b, t);

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

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}${C.cyan}   WI-087 Vehicle Workflow Guard Verification                   ${C.reset}`);
  console.log(`${C.bold}${C.cyan}═══════════════════════════════════════════════════════════════${C.reset}`);
  console.log(info(`Dist: ${DIST}   API: ${APIB}   Test date: ${TEST_DATE}`));

  // ── Auth ───────────────────────────────────────────────────────────────────
  const loginRes = await api('POST', '/auth/login', {
    email: 'sharma@gasdist.com', password: 'Gstadmin@123',
  });
  check('Login 200', loginRes.status === 200, `HTTP ${loginRes.status}`);
  const authToken: string =
    loginRes.data?.data?.tokens?.accessToken ||
    loginRes.data?.data?.accessToken || '';
  check('Auth token present', !!authToken);
  if (!authToken) throw new Error('Cannot proceed without auth token');

  // ── Resolve fixtures ───────────────────────────────────────────────────────
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: DIST, status: 'active', deletedAt: null },
    select: { id: true, driverName: true },
  });
  const vehicle = await prisma.vehicle.findFirstOrThrow({
    where: { distributorId: DIST, status: { not: 'inactive' }, deletedAt: null },
    select: { id: true, vehicleNumber: true, status: true },
  });
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, deletedAt: null },
    select: { id: true, customerName: true },
  });
  const cylType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: DIST },
    select: { id: true, typeName: true },
  });

  const originalVehicleStatus = vehicle.status as string;
  console.log(info(`Driver: ${driver.driverName}`));
  console.log(info(`Vehicle: ${vehicle.vehicleNumber} (status=${originalVehicleStatus})`));
  console.log(info(`Customer: ${customer.customerName}`));
  console.log(info(`CylinderType: ${cylType.typeName}`));

  // Track fixture IDs for cleanup
  const createdOrderIds: string[] = [];

  try {

    // ──────────────────────────────────────────────────────────────────────────
    console.log(step(1, 'Setup — reset vehicle to dispatched'));
    // ──────────────────────────────────────────────────────────────────────────
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: 'dispatched' },
    });
    const v1 = await prisma.vehicle.findFirstOrThrow({
      where: { id: vehicle.id }, select: { status: true },
    });
    check('Vehicle reset to dispatched', v1.status === 'dispatched', `status=${v1.status}`);

    // ──────────────────────────────────────────────────────────────────────────
    console.log(step(2, 'Bug 1 — markVehicleReturned BLOCKS on pending_delivery order'));
    // ──────────────────────────────────────────────────────────────────────────
    // Seed an order in pending_delivery state (as if already dispatched with IRN/EWB)
    const order1 = await prisma.order.create({
      data: {
        distributorId: DIST,
        customerId:    customer.id,
        driverId:      driver.id,
        vehicleId:     vehicle.id,
        orderDate:     new Date(),
        deliveryDate:  new Date(TEST_DATE),
        status:        'pending_delivery',
        orderType:     'delivery',
        orderNumber:   `WI087-A-${Date.now()}`,
        totalAmount:   0,
        items: {
          create: [{
            cylinderTypeId: cylType.id,
            quantity: 1,
            unitPrice: 0,
            totalPrice: 0,
          }],
        },
      },
    });
    createdOrderIds.push(order1.id);
    console.log(info(`Seeded order ${order1.orderNumber} (status=pending_delivery)`));

    const vr1 = await api('POST', '/delivery/driver/vehicle-returned',
      { vehicleId: vehicle.id }, authToken);
    check(
      'Bug 1: vehicle-returned returns 409 (not 200/500)',
      vr1.status === 409,
      `HTTP ${vr1.status}`,
    );
    const msg1: string = (typeof vr1.data?.error === 'string' ? vr1.data.error : '') || vr1.data?.message || '';
    check(
      'Bug 1: error mentions "out for delivery"',
      msg1.toLowerCase().includes('out for delivery'),
      `msg: ${msg1.slice(0, 120)}`,
    );
    console.log(info(`Response: HTTP ${vr1.status} — "${msg1.slice(0, 100)}"`));

    // Verify vehicle status unchanged after blocked return
    const v2 = await prisma.vehicle.findFirstOrThrow({
      where: { id: vehicle.id }, select: { status: true },
    });
    check(
      'Bug 1: vehicle status unchanged after blocked return',
      v2.status === 'dispatched',
      `status=${v2.status}`,
    );

    // ──────────────────────────────────────────────────────────────────────────
    console.log(step(3, 'Vehicle return SUCCEEDS with only pending_dispatch orders'));
    // ──────────────────────────────────────────────────────────────────────────
    // Downgrade order1 to pending_dispatch (not yet dispatched — no IRN/EWB committed)
    await prisma.order.update({
      where: { id: order1.id },
      data: { status: 'pending_dispatch' },
    });
    console.log(info(`Downgraded order to pending_dispatch`));

    const vr2 = await api('POST', '/delivery/driver/vehicle-returned',
      { vehicleId: vehicle.id }, authToken);
    check(
      'Vehicle return succeeds when only pending_dispatch exists',
      vr2.status === 200,
      `HTTP ${vr2.status}`,
    );

    // Vehicle is now 'returned'
    const v3 = await prisma.vehicle.findFirstOrThrow({
      where: { id: vehicle.id }, select: { status: true },
    });
    check(
      'Vehicle status is now returned',
      v3.status === 'returned',
      `status=${v3.status}`,
    );
    console.log(info(`Vehicle status after return: ${v3.status}`));

    // ──────────────────────────────────────────────────────────────────────────
    console.log(step(4, 'Bug 2 — confirmDelivery BLOCKS when vehicle is returned'));
    // ──────────────────────────────────────────────────────────────────────────
    // Seed a second order in pending_delivery with the same (now-returned) vehicle
    const order2 = await prisma.order.create({
      data: {
        distributorId: DIST,
        customerId:    customer.id,
        driverId:      driver.id,
        vehicleId:     vehicle.id,
        orderDate:     new Date(),
        deliveryDate:  new Date(TEST_DATE),
        status:        'pending_delivery',
        orderType:     'delivery',
        orderNumber:   `WI087-B-${Date.now()}`,
        totalAmount:   0,
        items: {
          create: [{
            cylinderTypeId: cylType.id,
            quantity: 1,
            unitPrice: 0,
            totalPrice: 0,
          }],
        },
      },
    });
    createdOrderIds.push(order2.id);
    console.log(info(`Seeded order ${order2.orderNumber} (status=pending_delivery, vehicle=returned)`));

    const cd = await api(
      'POST',
      `/orders/${order2.id}/confirm-delivery`,
      { items: [{ cylinderTypeId: cylType.id, deliveredQuantity: 1, emptiesCollected: 0 }] },
      authToken,
    );
    check(
      'Bug 2: confirm-delivery returns 409 when vehicle is returned',
      cd.status === 409,
      `HTTP ${cd.status}`,
    );
    const msg2: string = (typeof cd.data?.error === 'string' ? cd.data.error : '') || cd.data?.message || '';
    check(
      'Bug 2: error mentions "returned to depot"',
      msg2.toLowerCase().includes('returned to depot'),
      `msg: ${msg2.slice(0, 120)}`,
    );
    console.log(info(`Response: HTTP ${cd.status} — "${msg2.slice(0, 100)}"`));

    // ──────────────────────────────────────────────────────────────────────────
    console.log(step(5, 'Confirm delivery succeeds for dispatched vehicle (control)'));
    // ──────────────────────────────────────────────────────────────────────────
    // Reset vehicle to dispatched and confirm delivery — should work
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: 'dispatched' },
    });
    const cdOk = await api(
      'POST',
      `/orders/${order2.id}/confirm-delivery`,
      { items: [{ cylinderTypeId: cylType.id, deliveredQuantity: 1, emptiesCollected: 0 }] },
      authToken,
    );
    check(
      'confirm-delivery succeeds when vehicle is dispatched',
      cdOk.status === 200,
      `HTTP ${cdOk.status}`,
    );

  } finally {
    // ── Cleanup ──────────────────────────────────────────────────────────────
    console.log(`\n${C.dim}Cleaning up ${createdOrderIds.length} test order(s)...${C.reset}`);
    if (createdOrderIds.length > 0) {
      await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
      await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
    }
    // Restore original vehicle status
    await prisma.vehicle.update({
      where: { id: vehicle.id },
      data: { status: originalVehicleStatus as any },
    });
    console.log(info(`Vehicle restored to ${originalVehicleStatus}`));
    console.log(info('Cleanup done'));
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}${'─'.repeat(65)}${C.reset}`);
  const allPassed = failed === 0;
  const colour    = allPassed ? C.green : C.red;
  console.log(`${colour}${C.bold}  ${passed} passed  ·  ${failed} failed${C.reset}`);
  console.log(`${C.bold}${'─'.repeat(65)}${C.reset}\n`);
  if (!allPassed) process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
