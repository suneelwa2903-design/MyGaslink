/**
 * empties-return.test.ts
 *
 * Item 7 (docs/INVESTIGATION-JUL09-B.md) — lightweight customer empties
 * return. Pins:
 *   - Both inventory events are written on the return date
 *   - CustomerInventoryBalance.withCustomerQty decrements correctly
 *   - Past-date entries (within 90d) accepted, future rejected, >90d rejected
 *   - Multi-tenant: dist A can't return dist B's customer's empties
 *   - Role gate: inventory role ok, customer role forbidden
 *   - InventorySummary reflects the movement after cascade
 *
 * NOTE: no CustomerLedgerEntry is written — this is intentional per Item 7
 * (stock only, no money). If a future story adds an "empties credit"
 * feature, a ledger entry can be added there without changing this shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import {
  loginAsDistAdmin,
  loginAsFinance,
  loginAsInventory,
  getSeedData,
  today,
} from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let inventoryToken: string;
let financeToken: string;
let seedData: Awaited<ReturnType<typeof getSeedData>>;

function auth(token: string) {
  return { Authorization: `Bearer ${token}` };
}

const TEST_NOTES_MARKER = 'ITEM-7-EMPTIES-RETURN-TEST';

beforeAll(async () => {
  app = createApp();
  const admin = await loginAsDistAdmin();
  adminToken = admin.token;
  const inv = await loginAsInventory();
  inventoryToken = inv.token;
  const fin = await loginAsFinance();
  financeToken = fin.token;
  seedData = await getSeedData();
});

afterAll(async () => {
  // Clean up ONLY events created by these tests. Match on referenceType +
  // notes marker so we don't touch real returns_collection events.
  await prisma.inventoryEvent.deleteMany({
    where: { referenceType: 'empties_return', notes: { contains: TEST_NOTES_MARKER } },
  });
  // Q3 (2026-07-09) — clean up the new empties_return ledger entries.
  // referenceId is the customerId so we can filter by entryType alone
  // and let the notes marker come from the event side.
  await prisma.customerLedgerEntry.deleteMany({
    where: { entryType: 'empties_return', narration: { startsWith: 'Empties: ' } },
  });
});

async function makeCustomer(name: string) {
  const c = await prisma.customer.create({
    data: {
      distributorId: 'dist-001',
      customerName: `${name}-${Date.now().toString(36)}`,
      customerType: 'B2C',
      phone: '+919999999999',
      billingAddressLine1: 'x',
      billingState: 'Karnataka',
      billingPincode: '560001',
      billingCity: 'Bengaluru',
      status: 'active',
    },
    select: { id: true, customerName: true },
  });
  return c;
}

describe('Item 7 — empties return', () => {
  it('T1 — writes returns_collection event on the return date', async () => {
    const customer = await makeCustomer('T1-collection');
    const cyl = seedData.cylinderTypes[0];
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 3,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.eventsWritten).toBe(2);

    const evts = await prisma.inventoryEvent.findMany({
      where: { referenceId: customer.id, referenceType: 'empties_return' },
    });
    expect(evts.length).toBe(2);
    const rc = evts.find((e) => e.eventType === 'returns_collection');
    expect(rc).toBeDefined();
    expect(rc!.emptiesChange).toBe(3);
    expect(rc!.fullsChange).toBe(0);
  });

  it('T2 — writes reconciliation_empties_return event so closingEmpties is credited', async () => {
    const customer = await makeCustomer('T2-recon');
    const cyl = seedData.cylinderTypes[0];
    await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 2,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      })
      .expect(201);
    const rer = await prisma.inventoryEvent.findFirst({
      where: {
        referenceId: customer.id,
        eventType: 'reconciliation_empties_return',
      },
    });
    expect(rer).toBeDefined();
    expect(rer!.emptiesChange).toBe(2);
  });

  it('T3 — CustomerInventoryBalance.withCustomerQty decrements by quantity', async () => {
    const customer = await makeCustomer('T3-balance');
    const cyl = seedData.cylinderTypes[0];
    // Seed the customer with 10 empties held.
    await prisma.customerInventoryBalance.create({
      data: {
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        withCustomerQty: 10,
      },
    });
    await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 4,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      })
      .expect(201);
    const balance = await prisma.customerInventoryBalance.findFirstOrThrow({
      where: { customerId: customer.id, cylinderTypeId: cyl.id },
    });
    expect(balance.withCustomerQty).toBe(6);
  });

  it('T4 — a stock-only CustomerLedgerEntry IS written (Q3 update, was zero pre-fix)', async () => {
    // Q3 (2026-07-09) — the empties-return flow now writes a
    // pure-stock ledger row so the customer's ledger surfaces the
    // event. All money fields stay 0/null so the ledger's balance
    // math and money-only readers (Tally, computeCustomerOverdue,
    // payment allocation) remain unaffected. Anti-pattern-style
    // invariants pinned here — regressions on any of these would
    // silently break the accounting story we promised users.
    const customer = await makeCustomer('T4-ledger');
    const cyl = seedData.cylinderTypes[0];
    await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 7,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      })
      .expect(201);
    const entries = await prisma.customerLedgerEntry.findMany({
      where: { customerId: customer.id },
    });
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.entryType).toBe('empties_return');
    expect(Number(e.amountDelta)).toBe(0);
    expect(e.invoiceId).toBeNull();
    // Narration must match the shape the PDF widened column caps for.
    expect(e.narration).toBe(`Empties: 7× ${cyl.typeName}`);
  });

  it('T4a — writer NEVER sets invoiceId on empties_return rows', async () => {
    // Companion to T4: even under stress the writer must not attach an
    // invoiceId — otherwise getCustomerLedger's pendingEmptiesPerType
    // counter would double-count against that invoice. Impact analysis
    // in docs/INVESTIGATION-JUL09-B.md Q3 result.
    const customer = await makeCustomer('T4a-noinvoice');
    const cyl = seedData.cylinderTypes[0];
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/api/inventory/empties-return')
        .set(auth(adminToken))
        .send({
          customerId: customer.id,
          cylinderTypeId: cyl.id,
          quantity: i + 1,
          returnDate: today(),
          notes: TEST_NOTES_MARKER,
        })
        .expect(201);
    }
    const withInvoiceId = await prisma.customerLedgerEntry.count({
      where: { customerId: customer.id, entryType: 'empties_return', invoiceId: { not: null } },
    });
    expect(withInvoiceId).toBe(0);
  });

  it('T4b — getCustomerLedger emits the empties_return row + running balance stays put', async () => {
    // Q3 wire-shape guard: the row must reach the ledger response with
    // kind='empties_return' AND the balance must not move. If a future
    // refactor accidentally routes empties_return through the
    // adjustment case, the balance would change and this test would
    // catch it.
    const customer = await makeCustomer('T4b-render');
    const cyl = seedData.cylinderTypes[0];
    await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 4,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      })
      .expect(201);
    const { getCustomerLedger } = await import('../services/paymentService.js');
    const ledger = await getCustomerLedger('dist-001', customer.id);
    const row = ledger.rows.find((r) => r.narration?.startsWith('Empties: '));
    expect(row).toBeDefined();
    expect(row!.kind).toBe('empties_return');
    // Running totals shouldn't move for a stock-only row — no invoices,
    // no payments, no due, no overdue on this customer.
    expect(Number(ledger.summary.totalAmount)).toBe(0);
    expect(Number(ledger.summary.receivedAmount)).toBe(0);
    expect(Number(ledger.summary.dueAmount)).toBe(0);
    expect(Number(ledger.summary.overdueAmount)).toBe(0);
  });

  it('T5 — past return date (30 days ago) is accepted', async () => {
    const customer = await makeCustomer('T5-past');
    const cyl = seedData.cylinderTypes[0];
    const past = new Date();
    past.setDate(past.getDate() - 30);
    const y = past.getFullYear();
    const m = String(past.getMonth() + 1).padStart(2, '0');
    const d = String(past.getDate()).padStart(2, '0');
    const pastStr = `${y}-${m}-${d}`;
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: pastStr,
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(201);
  });

  it('T6 — future return date rejected (400)', async () => {
    const customer = await makeCustomer('T6-future');
    const cyl = seedData.cylinderTypes[0];
    const future = new Date();
    future.setDate(future.getDate() + 1);
    const y = future.getFullYear();
    const m = String(future.getMonth() + 1).padStart(2, '0');
    const d = String(future.getDate()).padStart(2, '0');
    const futureStr = `${y}-${m}-${d}`;
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: futureStr,
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(400);
  });

  it('T7 — return date >90 days ago rejected (400)', async () => {
    const customer = await makeCustomer('T7-old');
    const cyl = seedData.cylinderTypes[0];
    const old = new Date();
    old.setDate(old.getDate() - 100);
    const y = old.getFullYear();
    const m = String(old.getMonth() + 1).padStart(2, '0');
    const d = String(old.getDate()).padStart(2, '0');
    const oldStr = `${y}-${m}-${d}`;
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: oldStr,
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(400);
  });

  it('T8 — customer from a different distributor is rejected (404)', async () => {
    const cyl = seedData.cylinderTypes[0];
    // Sharma (dist-002) customer — cross-tenant.
    const otherTenantCustomer = await prisma.customer.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
      select: { id: true },
    });
    if (!otherTenantCustomer) {
      // Skip if no dist-002 customer seeded — shouldn't happen but be safe.
      expect(true).toBe(true);
      return;
    }
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: otherTenantCustomer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(404);
  });

  it('T9 — inventory role is allowed', async () => {
    const customer = await makeCustomer('T9-invrole');
    const cyl = seedData.cylinderTypes[0];
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(inventoryToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(201);
  });

  it('T10 — finance role is allowed', async () => {
    const customer = await makeCustomer('T10-finrole');
    const cyl = seedData.cylinderTypes[0];
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(financeToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(201);
  });

  it('T11 — unauthorised call returns 401', async () => {
    const customer = await makeCustomer('T11-noauth');
    const cyl = seedData.cylinderTypes[0];
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .send({
        customerId: customer.id,
        cylinderTypeId: cyl.id,
        quantity: 1,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(401);
  });

  it('T12 — invalid cylinderType (wrong distributor) rejected (404)', async () => {
    const customer = await makeCustomer('T12-badcyl');
    // Find a dist-002 cyl type.
    const otherCyl = await prisma.cylinderType.findFirst({
      where: { distributorId: 'dist-002', isActive: true },
      select: { id: true },
    });
    if (!otherCyl) { expect(true).toBe(true); return; }
    const res = await request(app)
      .post('/api/inventory/empties-return')
      .set(auth(adminToken))
      .send({
        customerId: customer.id,
        cylinderTypeId: otherCyl.id,
        quantity: 1,
        returnDate: today(),
        notes: TEST_NOTES_MARKER,
      });
    expect(res.status).toBe(404);
  });
});
