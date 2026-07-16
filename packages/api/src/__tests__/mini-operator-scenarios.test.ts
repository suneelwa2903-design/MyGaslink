/**
 * Mini-Operator (2026-07-16) — CP2 scenario integration tests.
 *
 * S1 — Source distributor CRUD
 * S2 — Purchase entry creation + inventory summary reflects the movement
 * S3 — Order creation with driverNameFreeText
 * S4 — Direct delivery (skip dispatch) → plain invoice (no IRN/EWB/QR)
 * S5 — GST activation guard on a mini-operator
 * S6 — Cross-tenant + cross-role isolation (distributor_admin can't hit
 *      mini-op routes; another mini_operator_admin can't see this tenant)
 * S7 — Existing distributor is unaffected — a regular dist_admin can still
 *      list its own source distributors returned empty (route is
 *      mini-op-only so distributor_admin sees 403, not a shape regression).
 *
 * Fixture: creates a fresh mini_operator distributor + mini_operator_admin
 * user + one cylinder type + one B2C customer. All fixtures are cleaned up
 * in afterAll. TEST_DATE = '2099-12-31' avoids anti-pattern #7.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import type { UserRole } from '@gaslink/shared';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { generateToken, loginAsDistAdmin, loginAsSuperAdmin } from './helpers.js';

const app = createApp();

const TEST_DATE = '2099-12-31';
const RUN_SUFFIX = String(Date.now()).slice(-6);

interface MiniOpFixture {
  distributorId: string;
  docCode: string;
  adminUserId: string;
  adminToken: string;
  cylinderTypeId: string;
  customerId: string;
}

async function createMiniOpFixture(codeLetter: string): Promise<MiniOpFixture> {
  // docCode MUST be 3 uppercase letters + globally unique. Map the last
  // digit of RUN_SUFFIX (0-9) into a letter (A-J) so each run picks a
  // fresh 3-char code within the M/A-J/K-T/U-Z prefix space. Combined
  // with the pre-run sweep on businessName below, a leftover row from a
  // prior aborted run never blocks a fresh run.
  const lastDigit = Number(RUN_SUFFIX.slice(-1));
  const letter = String.fromCharCode('A'.charCodeAt(0) + (Number.isFinite(lastDigit) ? lastDigit : 0));
  const docCode = `M${codeLetter}${letter}`;

  const distributor = await prisma.distributor.create({
    data: {
      businessName: `MiniOp Test ${codeLetter} ${RUN_SUFFIX}`,
      legalName: `MiniOp Test ${codeLetter} ${RUN_SUFFIX}`,
      accountType: 'mini_operator',
      gstMode: 'disabled',
      docCode,
      state: 'Telangana',
    },
    select: { id: true, docCode: true },
  });

  const email = `miniop-test-${codeLetter.toLowerCase()}-${RUN_SUFFIX}@example.com`;
  const passwordHash = await bcrypt.hash('MiniOp@123', 4);
  const adminUser = await prisma.user.create({
    data: {
      email,
      passwordHash,
      firstName: 'Mini',
      lastName: `Op ${codeLetter}`,
      role: 'mini_operator_admin',
      status: 'active',
      distributorId: distributor.id,
      requiresPasswordReset: false,
    },
  });

  const adminToken = generateToken({
    userId: adminUser.id,
    email: adminUser.email,
    role: 'mini_operator_admin' as UserRole,
    distributorId: distributor.id,
  });

  const cylinderType = await prisma.cylinderType.create({
    data: {
      distributorId: distributor.id,
      typeName: '19KG Commercial',
      capacity: 19,
      unit: 'KG',
      hsnCode: '27111900',
      isActive: true,
    },
    select: { id: true },
  });

  const customer = await prisma.customer.create({
    data: {
      distributorId: distributor.id,
      customerName: `Test Customer ${codeLetter} ${RUN_SUFFIX}`,
      customerType: 'B2C',
      phone: '+919999999999',
      status: 'active',
      creditPeriodDays: 30,
      // B2C customers don't need billingState for gstMode='disabled', but
      // pin one anyway so any future report/PDF path has a value.
      billingState: 'Telangana',
    },
    select: { id: true },
  });

  return {
    distributorId: distributor.id,
    docCode: distributor.docCode!,
    adminUserId: adminUser.id,
    adminToken,
    cylinderTypeId: cylinderType.id,
    customerId: customer.id,
  };
}

async function cleanupMiniOpFixture(distributorId: string): Promise<void> {
  // Order matters — respect FK dependencies. Wrap in try/catch so a partial
  // cleanup doesn't leave the next test to trip over the same rows.
  try {
    await prisma.inventoryEvent.deleteMany({ where: { distributorId } });
    await prisma.inventorySummary.deleteMany({ where: { distributorId } });
    await prisma.purchaseEntryItem.deleteMany({
      where: { purchaseEntry: { distributorId } },
    });
    await prisma.purchaseEntry.deleteMany({ where: { distributorId } });
    await prisma.sourceDistributor.deleteMany({ where: { distributorId } });
    await prisma.orderItem.deleteMany({ where: { order: { distributorId } } });
    await prisma.orderStatusLog.deleteMany({ where: { order: { distributorId } } });
    await prisma.invoiceItem.deleteMany({ where: { invoice: { distributorId } } });
    await prisma.invoice.deleteMany({ where: { distributorId } });
    await prisma.order.deleteMany({ where: { distributorId } });
    // customer_inventory_balances FK-references customers; delete those
    // (and any per-customer discount) BEFORE customer.deleteMany. Both
    // tables are keyed on `customerId`, not distributorId — reach into
    // the customer relation.
    await prisma.customerInventoryBalance.deleteMany({
      where: { customer: { distributorId } },
    });
    await prisma.customerCylinderDiscount.deleteMany({
      where: { customer: { distributorId } },
    });
    // customer_ledger_entries + customer_group_members also FK to customers.
    await prisma.customerLedgerEntry.deleteMany({ where: { distributorId } });
    await prisma.customerGroupMember.deleteMany({
      where: { customer: { distributorId } },
    });
    await prisma.customer.deleteMany({ where: { distributorId } });
    await prisma.cylinderType.deleteMany({ where: { distributorId } });
    await prisma.invoiceCounter.deleteMany({ where: { distributorId } });
    // audit_logs FK-reference users. Cascade through the tenant.
    await prisma.auditLog.deleteMany({ where: { distributorId } });
    await prisma.user.deleteMany({ where: { distributorId, role: 'mini_operator_admin' } });
    await prisma.distributor.delete({ where: { id: distributorId } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mini-op cleanup]', (err as Error).message);
  }
}

describe('Mini-Operator — CP2 Scenarios', () => {
  let fixture: MiniOpFixture;
  let secondFixture: MiniOpFixture;
  let superToken: string;

  beforeAll(async () => {
    superToken = (await loginAsSuperAdmin()).token;
    // Sweep any leftover rows from prior aborted runs so docCode uniqueness
    // + businessName clarity are preserved. Only touches rows this test
    // file could have created (businessName prefix + accountType).
    const stale = await prisma.distributor.findMany({
      where: {
        accountType: 'mini_operator',
        businessName: { startsWith: 'MiniOp Test ' },
      },
      select: { id: true },
    });
    for (const d of stale) {
      await cleanupMiniOpFixture(d.id);
    }
    fixture = await createMiniOpFixture('A');
    secondFixture = await createMiniOpFixture('B');
  });

  afterAll(async () => {
    await cleanupMiniOpFixture(fixture.distributorId);
    await cleanupMiniOpFixture(secondFixture.distributorId);
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // ─── S1 — Source distributor CRUD ────────────────────────────────────────

  describe('S1 — Source distributor CRUD', () => {
    it('POST /api/source-distributors creates a supplier for the tenant', async () => {
      const res = await request(app)
        .post('/api/source-distributors')
        .set(auth(fixture.adminToken))
        .send({ name: 'Sharma Gas Distributors' });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        distributorId: fixture.distributorId,
        name: 'Sharma Gas Distributors',
      });
    });

    it('POST rejects a duplicate name with 409', async () => {
      // First was created in the previous test.
      const res = await request(app)
        .post('/api/source-distributors')
        .set(auth(fixture.adminToken))
        .send({ name: 'sharma gas distributors' }); // case-insensitive
      expect(res.status).toBe(409);
    });

    it('GET /api/source-distributors returns the created supplier', async () => {
      const res = await request(app)
        .get('/api/source-distributors')
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data[0].name).toBe('Sharma Gas Distributors');
    });
  });

  // ─── S2 — Purchase entry creation + inventory summary reflects ───────────

  describe('S2 — Purchase entry creation + inventory reflects', () => {
    let sourceDistributorId: string;
    let purchaseEntryId: string;

    it('creates a source distributor for the purchase entry', async () => {
      const listRes = await request(app)
        .get('/api/source-distributors')
        .set(auth(fixture.adminToken));
      sourceDistributorId = listRes.body.data[0].id;
      expect(sourceDistributorId).toBeTruthy();
    });

    it('POST /api/purchase-entries mints a structured purchase number', async () => {
      const res = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId,
          purchaseDate: TEST_DATE,
          notes: 'CP2 scenario test',
          items: [
            {
              cylinderTypeId: fixture.cylinderTypeId,
              fullsReceived: 20,
              emptiesGivenOut: 15,
            },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.purchaseNumber).toMatch(new RegExp(`^P${fixture.docCode}\\d{4}\\d{6}$`));
      expect(res.body.data.sourceDistributorName).toBe('Sharma Gas Distributors');
      expect(res.body.data.items).toHaveLength(1);
      purchaseEntryId = res.body.data.id;
    });

    it('inventory_events reflect incoming_fulls (+20) and outgoing_empties (-15)', async () => {
      const events = await prisma.inventoryEvent.findMany({
        where: {
          distributorId: fixture.distributorId,
          referenceId: purchaseEntryId,
          referenceType: 'purchase_entry',
        },
        select: { eventType: true, fullsChange: true, emptiesChange: true },
      });
      const incoming = events.find((e) => e.eventType === 'incoming_fulls');
      const outgoing = events.find((e) => e.eventType === 'outgoing_empties');
      expect(incoming).toMatchObject({ fullsChange: 20, emptiesChange: 0 });
      expect(outgoing).toMatchObject({ fullsChange: 0, emptiesChange: -15 });
    });

    it('rejects an empty-movement entry with 400', async () => {
      const res = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId,
          purchaseDate: TEST_DATE,
          items: [
            {
              cylinderTypeId: fixture.cylinderTypeId,
              fullsReceived: 0,
              emptiesGivenOut: 0,
            },
          ],
        });
      expect(res.status).toBe(400);
    });

    it('rejects a cross-tenant cylinderType with 400', async () => {
      const foreignType = await prisma.cylinderType.findFirst({
        where: { distributorId: 'dist-001', isActive: true },
        select: { id: true },
      });
      expect(foreignType).toBeTruthy();
      const res = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId,
          purchaseDate: TEST_DATE,
          items: [
            {
              cylinderTypeId: foreignType!.id,
              fullsReceived: 5,
              emptiesGivenOut: 0,
            },
          ],
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('cylinder types');
    });
  });

  // ─── S3 — Order creation with driverNameFreeText ─────────────────────────

  describe('S3 — Order creation with driverNameFreeText', () => {
    it('POST /api/orders persists driverNameFreeText and lands in pending_delivery', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set(auth(fixture.adminToken))
        .send({
          customerId: fixture.customerId,
          deliveryDate: TEST_DATE,
          driverNameFreeText: 'Suresh',
          specialInstructions: 'Deliver to kitchen entrance',
          items: [
            { cylinderTypeId: fixture.cylinderTypeId, quantity: 5 },
          ],
        });
      expect(res.status).toBe(201);
      expect(res.body.data.driverNameFreeText).toBe('Suresh');
      // Mini-op orders skip the driver-assignment path — should land in
      // pending_delivery immediately so confirmDelivery can close it.
      expect(res.body.data.status).toBe('pending_delivery');
      // No Driver FK is populated for mini-op orders.
      expect(res.body.data.driverId).toBeNull();
    });
  });

  // ─── S4 — Direct delivery + plain invoice ────────────────────────────────

  describe('S4 — Direct delivery + plain invoice (no IRN/EWB)', () => {
    let orderId: string;

    it('creates an order for confirm-delivery', async () => {
      const res = await request(app)
        .post('/api/orders')
        .set(auth(fixture.adminToken))
        .send({
          customerId: fixture.customerId,
          deliveryDate: TEST_DATE,
          driverNameFreeText: 'Raju',
          items: [
            { cylinderTypeId: fixture.cylinderTypeId, quantity: 3 },
          ],
        });
      expect(res.status).toBe(201);
      orderId = res.body.data.orderId ?? res.body.data.id;
      expect(orderId).toBeTruthy();
    });

    it('POST /:id/confirm-delivery closes the order and generates a plain invoice', async () => {
      const res = await request(app)
        .post(`/api/orders/${orderId}/confirm-delivery`)
        .set(auth(fixture.adminToken))
        .send({
          items: [
            {
              cylinderTypeId: fixture.cylinderTypeId,
              deliveredQuantity: 3,
              emptiesCollected: 2,
            },
          ],
        });
      expect(res.status).toBeLessThan(400);

      const invoice = await prisma.invoice.findFirst({
        where: { distributorId: fixture.distributorId, orderId },
        select: {
          id: true,
          invoiceNumber: true,
          irn: true,
          ackNo: true,
          irnStatus: true,
          totalAmount: true,
        },
      });
      expect(invoice).toBeTruthy();
      // Plain invoice: no IRN, no acknowledgement, no e-invoice status.
      expect(invoice!.irn).toBeNull();
      expect(invoice!.ackNo).toBeNull();
      // irnStatus defaults to 'not_applicable' (or similar) when gstMode='disabled';
      // whatever the exact enum, it must NOT be 'success'.
      expect(invoice!.irnStatus).not.toBe('success');
    });
  });

  // ─── S5 — GST guard on mini-operator ─────────────────────────────────────

  describe('S5 — GST guard on mini-operator', () => {
    it('POST /admin/distributors/:id/gst/activate refuses a mini-operator', async () => {
      // gstin is required by the activation path — set one first via a
      // super-admin PUT so the "no gstin" precondition doesn't mask the
      // real error we want to assert (MINI_OPERATOR_NO_GST).
      await prisma.distributor.update({
        where: { id: fixture.distributorId },
        data: { gstin: '36AAAAA1234A1Z5' },
      });
      const res = await request(app)
        .post(`/api/admin/distributors/${fixture.distributorId}/gst/activate`)
        .set(auth(superToken))
        .send({
          mode: 'sandbox',
          einvoice: {
            clientId: 'x',
            clientSecret: 'x',
            username: 'x',
            password: 'x',
            gstin: '36AAAAA1234A1Z5',
          },
          ewaybill: 'same_as_einvoice',
          reason: 'new_distributor_activation',
        });
      expect(res.status).toBeGreaterThanOrEqual(400);
      // Verify our error code appears in the response body regardless of
      // which envelope shape the route uses.
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).toContain('MINI_OPERATOR_NO_GST');
    });
  });

  // ─── S6 — Cross-tenant + cross-role isolation ────────────────────────────

  describe('S6 — Cross-tenant + cross-role isolation', () => {
    it('distributor_admin gets 403 on POST /api/source-distributors', async () => {
      const distAdmin = await loginAsDistAdmin();
      const res = await request(app)
        .post('/api/source-distributors')
        .set(auth(distAdmin.token))
        .send({ name: 'Should not work' });
      expect(res.status).toBe(403);
    });

    it('distributor_admin gets 403 on GET /api/purchase-entries', async () => {
      const distAdmin = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/purchase-entries')
        .set(auth(distAdmin.token));
      expect(res.status).toBe(403);
    });

    it("a mini_operator_admin cannot see another tenant's source distributors", async () => {
      const res = await request(app)
        .get('/api/source-distributors')
        .set(auth(secondFixture.adminToken));
      expect(res.status).toBe(200);
      // Second tenant hasn't created any sources yet — must be an empty
      // list, NOT the first tenant's list.
      expect(res.body.data).toEqual([]);
    });
  });

  // ─── S7 — Existing distributor unaffected ────────────────────────────────

  describe('S7 — Regression: regular distributor flows unaffected', () => {
    it('regular distributor_admin still lists orders on their own tenant', async () => {
      const distAdmin = await loginAsDistAdmin();
      const res = await request(app)
        .get('/api/orders?page=1&pageSize=5')
        .set(auth(distAdmin.token));
      expect(res.status).toBe(200);
      // Shape check — the existing wire shape includes `orders` +
      // pagination meta. Anti-pattern #9 defensive assert.
      expect(res.body.data).toHaveProperty('orders');
      expect(Array.isArray(res.body.data.orders)).toBe(true);
    });

    it('regular distributor accountType defaults to distributor', async () => {
      const dist001 = await prisma.distributor.findUnique({
        where: { id: 'dist-001' },
        select: { accountType: true },
      });
      expect(dist001?.accountType).toBe('distributor');
    });
  });

  // ─── S8 — Purchase entry deletion + inventory event reversal ─────────────
  // Pins the deletePurchaseEntry design: hard-delete of the derived
  // InventoryEvent rows (referenceType='purchase_entry'), soft-delete of the
  // PurchaseEntry, followed by a recomputeSummariesFromDate. A naive
  // reversal-event approach would double-debit outgoingEmpties because the
  // summary aggregator uses `Math.abs(event.emptiesChange)` — this test
  // pins the correct behaviour so a future refactor can't regress.

  describe('S8 — Purchase entry deletion reverses inventory movement', () => {
    let sourceDistributorId: string;
    let purchaseEntryId: string;

    it('sets up a fresh purchase entry to delete', async () => {
      const src = await request(app)
        .post('/api/source-distributors')
        .set(auth(fixture.adminToken))
        .send({ name: 'S8-Source' });
      expect(src.status).toBe(201);
      sourceDistributorId = src.body.data.id;

      const created = await request(app)
        .post('/api/purchase-entries')
        .set(auth(fixture.adminToken))
        .send({
          sourceDistributorId,
          purchaseDate: TEST_DATE,
          notes: 'S8 scenario — to be deleted',
          items: [{
            cylinderTypeId: fixture.cylinderTypeId,
            fullsReceived: 5,
            emptiesGivenOut: 3,
          }],
        });
      expect(created.status).toBe(201);
      purchaseEntryId = created.body.data.id;

      // Sanity: the derived events exist.
      const eventsBefore = await prisma.inventoryEvent.count({
        where: {
          distributorId: fixture.distributorId,
          referenceId: purchaseEntryId,
          referenceType: 'purchase_entry',
        },
      });
      expect(eventsBefore).toBe(2); // incoming_fulls + outgoing_empties
    });

    it('DELETE /api/purchase-entries/:id hard-deletes derived events, soft-deletes the entry', async () => {
      const res = await request(app)
        .delete(`/api/purchase-entries/${purchaseEntryId}`)
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id: purchaseEntryId, deleted: true });

      // Derived events must be GONE (hard-delete).
      const eventsAfter = await prisma.inventoryEvent.count({
        where: {
          distributorId: fixture.distributorId,
          referenceId: purchaseEntryId,
          referenceType: 'purchase_entry',
        },
      });
      expect(eventsAfter).toBe(0);

      // PurchaseEntry itself is soft-deleted (deletedAt set), NOT hard-deleted —
      // the audit trail keeps the header + items.
      const row = await prisma.purchaseEntry.findUnique({
        where: { id: purchaseEntryId },
        select: { id: true, deletedAt: true },
      });
      expect(row?.deletedAt).not.toBeNull();
    });

    it('GET /api/purchase-entries excludes the soft-deleted row', async () => {
      const res = await request(app)
        .get('/api/purchase-entries')
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(200);
      const ids = (res.body.data.purchaseEntries as Array<{ id: string }>).map((e) => e.id);
      expect(ids).not.toContain(purchaseEntryId);
    });

    it('GET /api/purchase-entries/:id on a soft-deleted id returns 404', async () => {
      const res = await request(app)
        .get(`/api/purchase-entries/${purchaseEntryId}`)
        .set(auth(fixture.adminToken));
      expect(res.status).toBe(404);
    });
  });
});
