import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient } from '@prisma/client';
import { GST_RATES } from '@gaslink/shared';
import { toNum } from '../utils/decimal.js';

type TxClient = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

// WI-056: list responses now ship counts, not full CN/DN arrays. The View
// modal fetches the full lists from /invoices/:id/credit-notes when needed.
// listInvoiceInclude → bandwidth-conscious shape for the table view.
// detailInvoiceInclude → keeps the existing full arrays for /invoices/:id.
const listInvoiceInclude = {
  customer: { select: { id: true, customerName: true, gstin: true, billingState: true, customerType: true } },
  items: { include: { cylinderType: { select: { typeName: true } } } },
  order: { select: { id: true, orderNumber: true } },
  paymentAllocations: { include: { payment: { select: { id: true, paymentMethod: true } } } },
  _count: { select: { creditNotes: true, debitNotes: true } },
} satisfies Prisma.InvoiceInclude;

const detailInvoiceInclude = {
  customer: { select: { id: true, customerName: true, gstin: true, billingState: true } },
  items: { include: { cylinderType: { select: { typeName: true } } } },
  order: { select: { id: true, orderNumber: true } },
  paymentAllocations: { include: { payment: { select: { id: true, paymentMethod: true } } } },
  creditNotes: true,
  debitNotes: true,
} satisfies Prisma.InvoiceInclude;

// Compat alias for any imports that still reference the old name.
const invoiceInclude = detailInvoiceInclude;

export async function listInvoices(
  distributorId: string,
  filters: {
    status?: string; customerId?: string; irnStatus?: string;
    dateFrom?: string; dateTo?: string;
    page?: number; pageSize?: number; sortBy?: string; sortOrder?: string;
  }
) {
  const where: Prisma.InvoiceWhereInput = { distributorId, deletedAt: null };
  if (filters.status) where.status = filters.status as any;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.irnStatus) where.irnStatus = filters.irnStatus as any;
  if (filters.dateFrom || filters.dateTo) {
    where.issueDate = {};
    if (filters.dateFrom) where.issueDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.issueDate.lte = new Date(filters.dateTo);
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;

  const [invoices, total] = await Promise.all([
    prisma.invoice.findMany({
      where,
      include: listInvoiceInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.invoice.count({ where }),
  ]);

  return {
    data: invoices,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getInvoiceById(id: string, distributorId: string) {
  return prisma.invoice.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: invoiceInclude,
  });
}

/**
 * Create invoice from a delivered order. Auto-calculates GST.
 */
export async function createInvoiceFromOrder(
  tx: TxClient,
  orderId: string,
  distributorId: string,
  userId: string
) {
  const order = await tx.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    include: {
      items: { include: { cylinderType: true } },
      customer: { select: { creditPeriodDays: true, gstin: true, billingState: true } },
    },
  });

  if (!order) throw new InvoiceError('Order not found', 404);
  if (!['delivered', 'modified_delivered'].includes(order.status)) {
    throw new InvoiceError('Order must be delivered to create invoice', 400);
  }

  // Check existing invoice
  const existing = await tx.invoice.findFirst({
    where: { orderId, distributorId, deletedAt: null },
  });
  if (existing) throw new InvoiceError('Invoice already exists for this order', 400);

  // Get distributor state and GST mode for calculation
  const distributor = await tx.distributor.findUnique({
    where: { id: distributorId },
    select: { state: true, gstin: true, gstMode: true },
  });

  const gstEnabled = distributor?.gstMode === 'sandbox' || distributor?.gstMode === 'live';
  const isInterState = gstEnabled && distributor?.state && order.customer?.billingState
    ? distributor.state !== order.customer.billingState
    : false;

  const invoiceNumber = `INV-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;
  const issueDate = new Date();
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (order.customer?.creditPeriodDays ?? 30));

  // Build invoice items from order items using delivered quantities
  // Prices are GST-inclusive. When GST is enabled, reverse-calculate the base price.
  let totalAmount = 0;
  let totalBaseAmount = 0;
  const invoiceItems: Prisma.InvoiceItemCreateManyInvoiceInput[] = [];

  for (const oi of order.items) {
    const qty = oi.deliveredQuantity ?? oi.quantity;
    const effectivePrice = Math.max(toNum(oi.unitPrice) - toNum(oi.discountPerUnit), 0);
    const lineTotal = effectivePrice * qty;
    totalAmount += lineTotal;

    if (gstEnabled) {
      // Reverse-calculate base price from GST-inclusive price
      const basePrice = effectivePrice / (1 + GST_RATES.IGST);
      totalBaseAmount += basePrice * qty;

      invoiceItems.push({
        cylinderTypeId: oi.cylinderTypeId,
        description: oi.cylinderType.typeName,
        hsnCode: oi.cylinderType.hsnCode,
        quantity: qty,
        unitPrice: Math.round(basePrice * 100) / 100,
        discountPerUnit: oi.discountPerUnit,
        gstRate: 18,
        totalPrice: lineTotal,
      });
    } else {
      // GST disabled - no GST breakup, price is the full price
      invoiceItems.push({
        cylinderTypeId: oi.cylinderTypeId,
        description: oi.cylinderType.typeName,
        hsnCode: oi.cylinderType.hsnCode,
        quantity: qty,
        unitPrice: oi.unitPrice,
        discountPerUnit: oi.discountPerUnit,
        gstRate: 0,
        totalPrice: lineTotal,
      });
    }
  }

  // GST breakup: customer pays the same totalAmount either way (prices are inclusive).
  // When GST is enabled, we show the tax breakup extracted from the inclusive price.
  let cgstValue = 0;
  let sgstValue = 0;
  let igstValue = 0;

  if (gstEnabled) {
    if (isInterState) {
      igstValue = Math.round(totalBaseAmount * GST_RATES.IGST * 100) / 100;
    } else {
      cgstValue = Math.round(totalBaseAmount * GST_RATES.CGST * 100) / 100;
      sgstValue = Math.round(totalBaseAmount * GST_RATES.SGST * 100) / 100;
    }
  }

  const invoice = await tx.invoice.create({
    data: {
      invoiceNumber,
      distributorId,
      customerId: order.customerId,
      orderId,
      issueDate,
      dueDate,
      totalAmount,
      outstandingAmount: totalAmount,
      status: 'issued',
      cgstValue,
      sgstValue,
      igstValue,
      issuedBy: userId,
      items: { create: invoiceItems },
    },
  });

  // Create ledger entry
  await tx.customerLedgerEntry.create({
    data: {
      distributorId,
      customerId: order.customerId,
      entryType: 'invoice_entry',
      referenceId: invoice.id,
      invoiceId: invoice.id,
      amountDelta: totalAmount,
      narration: `Invoice ${invoiceNumber} for order ${order.orderNumber}`,
      entryDate: issueDate,
      createdBy: userId,
    },
  });

  return invoice;
}

/**
 * Create manual invoice (not from order).
 */
export async function createManualInvoice(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    issueDate: string;
    dueDate: string;
    items: {
      cylinderTypeId?: string;
      description: string;
      hsnCode?: string;
      quantity: number;
      unitPrice: number;
      discountPerUnit?: number;
      gstRate?: number;
    }[];
  }
) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { state: true },
  });
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { billingState: true },
  });

  if (!customer) throw new InvoiceError('Customer not found', 404);

  const isInterState = distributor?.state && customer.billingState
    ? distributor.state !== customer.billingState
    : false;

  const invoiceNumber = `INV-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;
  let totalBeforeGst = 0;

  const invoiceItems = data.items.map(item => {
    const discount = item.discountPerUnit ?? 0;
    const effectivePrice = Math.max(item.unitPrice - discount, 0);
    const lineTotal = effectivePrice * item.quantity;
    totalBeforeGst += lineTotal;
    return {
      cylinderTypeId: item.cylinderTypeId || null,
      description: item.description,
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      discountPerUnit: discount,
      gstRate: item.gstRate ?? 18,
      totalPrice: lineTotal,
    };
  });

  const cgstValue = isInterState ? 0 : totalBeforeGst * GST_RATES.CGST;
  const sgstValue = isInterState ? 0 : totalBeforeGst * GST_RATES.SGST;
  const igstValue = isInterState ? totalBeforeGst * GST_RATES.IGST : 0;
  const totalAmount = totalBeforeGst + cgstValue + sgstValue + igstValue;

  const invoice = await prisma.$transaction(async (tx) => {
    const created = await tx.invoice.create({
      data: {
        invoiceNumber,
        distributorId,
        customerId: data.customerId,
        issueDate: new Date(data.issueDate),
        dueDate: new Date(data.dueDate),
        totalAmount,
        outstandingAmount: totalAmount,
        status: 'issued',
        cgstValue,
        sgstValue,
        igstValue,
        issuedBy: userId,
        items: { create: invoiceItems },
      },
      include: invoiceInclude,
    });

    await tx.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId: data.customerId,
        entryType: 'invoice_entry',
        referenceId: created.id,
        invoiceId: created.id,
        amountDelta: totalAmount,
        narration: `Invoice ${invoiceNumber}`,
        entryDate: new Date(data.issueDate),
        createdBy: userId,
      },
    });

    return created;
  });

  // Auto-trigger GST compliance (IRN + EWB) for GST-enabled tenants. Same
  // pattern as orderService.confirmDelivery — dynamic import avoids a
  // require cycle, fire-and-forget so a WhiteBooks outage never blocks
  // invoice creation. processInvoiceGst itself returns early when
  // distributor.gstMode === 'disabled'.
  try {
    const { processInvoiceGst } = await import('./gst/gstService.js');
    processInvoiceGst(invoice.id, distributorId).catch(() => {
      // intentionally swallowed — failures land in the invoice's irnStatus
      // / ewbStatus columns and the pending-actions queue
    });
  } catch { /* non-blocking */ }

  return invoice;
}

/**
 * Create credit note with approval workflow.
 *
 * WI-055: amount-based — the request carries a single `amount` and an
 * optional `note` instead of the prior items[] grid. Credit notes are
 * bounded to the invoice total because crediting more than was billed
 * has no real-world meaning (use a debit/credit reversal pair instead).
 */
export async function createCreditNote(
  distributorId: string,
  userId: string,
  data: {
    invoiceId: string;
    reason: string;
    amount: number;
    note?: string;
  }
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: data.invoiceId, distributorId, deletedAt: null },
  });
  if (!invoice) throw new InvoiceError('Invoice not found', 404);

  if (data.amount <= 0) {
    throw new InvoiceError('Credit amount must be greater than 0', 400);
  }
  if (data.amount > toNum(invoice.totalAmount)) {
    throw new InvoiceError(
      `Credit amount (₹${data.amount}) cannot exceed invoice total (₹${toNum(invoice.totalAmount)})`,
      400,
    );
  }

  const creditNoteNumber = `CN-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

  return prisma.creditNote.create({
    data: {
      invoiceId: data.invoiceId,
      creditNoteNumber,
      totalAmount: data.amount,
      reason: data.reason,
      note: data.note ?? null,
      status: 'pending_cn',
      issuedBy: userId,
    },
  });
}

export async function approveCreditNote(creditNoteId: string, distributorId: string, userId: string) {
  const cn = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, invoice: { distributorId } },
  });
  if (!cn) throw new InvoiceError('Credit note not found', 404);
  if (cn.status !== 'pending_cn') throw new InvoiceError('Credit note is not pending', 400);

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.creditNote.update({
      where: { id: creditNoteId },
      data: {
        status: 'approved_cn',
        approvedBy: userId,
        approvedAt: new Date(),
        issueDate: new Date(),
      },
    });

    // Reduce invoice outstanding
    const invoice = await tx.invoice.findUnique({ where: { id: cn.invoiceId } });
    if (invoice) {
      const newOutstanding = Math.max(toNum(invoice.outstandingAmount) - toNum(cn.totalAmount), 0);
      await tx.invoice.update({
        where: { id: cn.invoiceId },
        data: {
          outstandingAmount: newOutstanding,
          status: newOutstanding <= 0 ? 'paid' : invoice.status,
        },
      });

      // Ledger entry
      if (invoice.customerId) {
        await tx.customerLedgerEntry.create({
          data: {
            distributorId: invoice.distributorId,
            customerId: invoice.customerId,
            entryType: 'credit_note',
            referenceId: creditNoteId,
            invoiceId: cn.invoiceId,
            amountDelta: -cn.totalAmount,
            narration: `Credit note ${cn.creditNoteNumber}: ${cn.reason}`,
            entryDate: new Date(),
            createdBy: userId,
          },
        });
      }
    }

    return updated;
  });

  // Process GST for credit note (non-blocking)
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: cn.invoiceId }, select: { distributorId: true } });
    if (invoice) {
      const { processCreditNoteGst } = await import('./gst/gstService.js');
      processCreditNoteGst(creditNoteId, invoice.distributorId).catch(() => {});
    }
  } catch { /* non-blocking */ }

  return result;
}

export async function rejectCreditNote(creditNoteId: string, distributorId: string, userId: string) {
  const cn = await prisma.creditNote.findFirst({
    where: { id: creditNoteId, invoice: { distributorId } },
  });
  if (!cn) throw new InvoiceError('Credit note not found', 404);
  return prisma.creditNote.update({
    where: { id: creditNoteId },
    data: { status: 'rejected_cn', approvedBy: userId, approvedAt: new Date() },
  });
}

/**
 * Create debit note with approval workflow.
 *
 * WI-055: amount-based — see createCreditNote(). Unlike credit notes,
 * debit notes are NOT bounded by the invoice total: surcharges, delivery
 * fees, or fuel adjustments can legitimately exceed the original bill.
 */
export async function createDebitNote(
  distributorId: string,
  userId: string,
  data: {
    invoiceId: string;
    reason: string;
    amount: number;
    note?: string;
  }
) {
  const invoice = await prisma.invoice.findFirst({
    where: { id: data.invoiceId, distributorId, deletedAt: null },
  });
  if (!invoice) throw new InvoiceError('Invoice not found', 404);

  if (data.amount <= 0) {
    throw new InvoiceError('Debit amount must be greater than 0', 400);
  }

  const debitNoteNumber = `DN-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

  return prisma.debitNote.create({
    data: {
      invoiceId: data.invoiceId,
      debitNoteNumber,
      totalAmount: data.amount,
      reason: data.reason,
      note: data.note ?? null,
      status: 'pending_dn',
      issuedBy: userId,
    },
  });
}

export async function approveDebitNote(debitNoteId: string, distributorId: string, userId: string) {
  const dn = await prisma.debitNote.findFirst({
    where: { id: debitNoteId, invoice: { distributorId } },
  });
  if (!dn) throw new InvoiceError('Debit note not found', 404);
  if (dn.status !== 'pending_dn') throw new InvoiceError('Debit note is not pending', 400);

  const result = await prisma.$transaction(async (tx) => {
    const updated = await tx.debitNote.update({
      where: { id: debitNoteId },
      data: {
        status: 'approved_dn',
        approvedBy: userId,
        approvedAt: new Date(),
        issueDate: new Date(),
      },
    });

    // Increase invoice outstanding
    const invoice = await tx.invoice.findUnique({ where: { id: dn.invoiceId } });
    if (invoice) {
      await tx.invoice.update({
        where: { id: dn.invoiceId },
        data: {
          outstandingAmount: { increment: dn.totalAmount },
          totalAmount: { increment: dn.totalAmount },
        },
      });

      if (invoice.customerId) {
        await tx.customerLedgerEntry.create({
          data: {
            distributorId: invoice.distributorId,
            customerId: invoice.customerId,
            entryType: 'debit_note',
            referenceId: debitNoteId,
            invoiceId: dn.invoiceId,
            amountDelta: dn.totalAmount,
            narration: `Debit note ${dn.debitNoteNumber}: ${dn.reason}`,
            entryDate: new Date(),
            createdBy: userId,
          },
        });
      }
    }

    return updated;
  });

  // Process GST for debit note (non-blocking)
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: dn.invoiceId }, select: { distributorId: true } });
    if (invoice) {
      const { processDebitNoteGst } = await import('./gst/gstService.js');
      processDebitNoteGst(debitNoteId, invoice.distributorId).catch(() => {});
    }
  } catch { /* non-blocking */ }

  return result;
}

export async function rejectDebitNote(debitNoteId: string, distributorId: string, userId: string) {
  const dn = await prisma.debitNote.findFirst({
    where: { id: debitNoteId, invoice: { distributorId } },
  });
  if (!dn) throw new InvoiceError('Debit note not found', 404);
  return prisma.debitNote.update({
    where: { id: debitNoteId },
    data: { status: 'rejected_dn', approvedBy: userId, approvedAt: new Date() },
  });
}

export async function updateInvoiceStatus(id: string, distributorId: string, status: string) {
  const invoice = await prisma.invoice.findFirst({
    where: { id, distributorId, deletedAt: null },
  });
  if (!invoice) throw new InvoiceError('Invoice not found', 404);
  return prisma.invoice.update({
    where: { id },
    data: { status: status as any },
  });
}

/**
 * Mark overdue invoices (for cron job usage).
 */
export async function markOverdueInvoices(distributorId?: string) {
  const where: Prisma.InvoiceWhereInput = {
    status: { in: ['issued', 'partially_paid'] },
    dueDate: { lt: new Date() },
    outstandingAmount: { gt: 0 },
    deletedAt: null,
  };
  if (distributorId) where.distributorId = distributorId;

  const result = await prisma.invoice.updateMany({
    where,
    data: { status: 'overdue' },
  });
  return { markedOverdue: result.count };
}

/**
 * Generate GST invoices for orders that were placed before GST was toggled on.
 * This finds all invoices with gstRate = 0 and re-calculates with GST breakup.
 * The total amount stays the same (GST-inclusive) - we just add the tax breakup.
 */
export async function generateRetroactiveGstInvoices(
  distributorId: string,
  userId: string,
  fromDate?: string,
  toDate?: string
) {
  // Verify distributor has GST enabled
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, state: true, gstin: true },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    throw new InvoiceError('GST must be enabled before generating retroactive invoices', 400);
  }

  // Find all non-GST invoices (gstRate = 0 on items) that haven't been cancelled
  const where: any = {
    distributorId,
    deletedAt: null,
    status: { not: 'cancelled' },
    isGaslinkBilling: false,
    items: { some: { gstRate: 0 } },
  };
  if (fromDate) where.issueDate = { ...where.issueDate, gte: new Date(fromDate) };
  if (toDate) where.issueDate = { ...where.issueDate, lte: new Date(toDate) };

  const invoices = await prisma.invoice.findMany({
    where,
    include: {
      items: true,
      customer: { select: { billingState: true } },
    },
  });

  let updated = 0;
  const results: { invoiceId: string; invoiceNumber: string; cgst: number; sgst: number; igst: number }[] = [];

  for (const invoice of invoices) {
    const isInterState = distributor.state && invoice.customer?.billingState
      ? distributor.state !== invoice.customer.billingState
      : false;

    let totalBaseAmount = 0;

    await prisma.$transaction(async (tx) => {
      // Update each item with GST breakup
      for (const item of invoice.items) {
        if (item.gstRate === 0) {
          const effectivePrice = Math.max(toNum(item.unitPrice) - toNum(item.discountPerUnit), 0);
          const lineTotal = effectivePrice * item.quantity;
          const basePrice = effectivePrice / 1.18;
          totalBaseAmount += basePrice * item.quantity;

          await tx.invoiceItem.update({
            where: { id: item.id },
            data: {
              unitPrice: Math.round(basePrice * 100) / 100,
              gstRate: 18,
              // totalPrice stays the same - it was already inclusive
            },
          });
        }
      }

      let cgst = 0, sgst = 0, igst = 0;
      if (isInterState) {
        igst = Math.round(totalBaseAmount * 0.18 * 100) / 100;
      } else {
        cgst = Math.round(totalBaseAmount * 0.09 * 100) / 100;
        sgst = Math.round(totalBaseAmount * 0.09 * 100) / 100;
      }

      await tx.invoice.update({
        where: { id: invoice.id },
        data: { cgstValue: cgst, sgstValue: sgst, igstValue: igst },
      });

      results.push({ invoiceId: invoice.id, invoiceNumber: invoice.invoiceNumber, cgst, sgst, igst });
      updated++;
    });
  }

  return {
    totalProcessed: updated,
    totalSkipped: invoices.length - updated,
    invoices: results,
  };
}

export class InvoiceError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'InvoiceError';
  }
}
