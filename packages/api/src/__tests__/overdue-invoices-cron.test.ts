import { describe, it, expect, afterEach } from 'vitest';
import type { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { runOverdueSweep } from '../jobs/overdueInvoicesJob.js';

// WI-132: the daily cron just wraps runOverdueSweep(). We test the sweep
// directly (no scheduler, no fake timers) — it's the part with logic.
describe('WI-132 — overdue invoices daily sweep', () => {
  const createdIds: string[] = [];

  afterEach(async () => {
    if (createdIds.length) {
      await prisma.invoice.deleteMany({ where: { id: { in: createdIds } } });
      createdIds.length = 0;
    }
  });

  async function seedInvoice(over: Partial<Prisma.InvoiceUncheckedCreateInput>) {
    const inv = await prisma.invoice.create({
      data: {
        invoiceNumber: `WI132-${Math.random().toString(36).slice(2, 10)}`,
        distributorId: 'dist-002',
        issueDate: new Date('2099-01-01'),
        dueDate: new Date('2099-12-31'),
        totalAmount: 1000,
        outstandingAmount: 1000,
        status: 'issued',
        ...over,
      },
    });
    createdIds.push(inv.id);
    return inv;
  }

  it('flips a past-due issued invoice with outstanding balance to overdue', async () => {
    const inv = await seedInvoice({
      dueDate: new Date('2020-01-01'), // far past
      status: 'issued',
      outstandingAmount: 1000,
    });

    await runOverdueSweep();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe('overdue');
  });

  it('leaves a not-yet-due invoice untouched', async () => {
    const inv = await seedInvoice({
      dueDate: new Date('2099-12-31'), // future
      status: 'issued',
      outstandingAmount: 1000,
    });

    await runOverdueSweep();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe('issued');
  });

  it('leaves a fully-paid past-due invoice untouched (zero outstanding)', async () => {
    const inv = await seedInvoice({
      dueDate: new Date('2020-01-01'),
      status: 'paid',
      outstandingAmount: 0,
    });

    await runOverdueSweep();

    const after = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.status).toBe('paid');
  });
});
