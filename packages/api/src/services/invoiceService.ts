import { prisma } from '../lib/prisma.js';
import type { Prisma, PrismaClient, $Enums } from '@prisma/client';
import { GST_RATES, deriveStateCode } from '@gaslink/shared';
import { toNum } from '../utils/decimal.js';
import { allocateNumber } from './numberingService.js';

// WI-108: legacy random number generators, kept as the fallback when a
// distributor has no docCode set (structured numbering not activated).
const legacyNumber = (prefix: string) =>
  `${prefix}-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

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
  if (filters.status) where.status = filters.status as $Enums.InvoiceStatus;
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.irnStatus) where.irnStatus = filters.irnStatus as $Enums.IrnStatus;
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
      customer: { select: { creditPeriodDays: true, gstin: true, billingState: true, transportChargePerCylinder: true } },
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
    select: { state: true, gstin: true, gstMode: true, docCode: true },
  });

  const gstEnabled = distributor?.gstMode === 'sandbox' || distributor?.gstMode === 'live';
  const isInterState = gstEnabled && distributor?.state && order.customer?.billingState
    ? distributor.state !== order.customer.billingState
    : false;

  const issueDate = new Date();
  // WI-108: structured number when docCode is set, else legacy random.
  // Allocated on `tx` so it rolls back with the invoice on failure.
  const invoiceNumber = distributor?.docCode
    ? await allocateNumber(tx, distributorId, 'I', issueDate, distributor.docCode)
    : legacyNumber('INV');
  const dueDate = new Date();
  dueDate.setDate(dueDate.getDate() + (order.customer?.creditPeriodDays ?? 30));

  // Build invoice items from order items using delivered quantities
  // Prices are GST-inclusive. When GST is enabled, reverse-calculate the base price.
  let totalAmount = 0;
  let totalBaseAmount = 0;
  let totalDeliveredQty = 0;
  const invoiceItems: Prisma.InvoiceItemCreateManyInvoiceInput[] = [];

  for (const oi of order.items) {
    const qty = oi.deliveredQuantity ?? oi.quantity;
    // Skip cylinder types the driver delivered zero of. The order may have
    // included the line, but a qty=0 invoice line is visual noise on the PDF
    // and a junk row in the IRN ItemList (NIC tolerates it but it shouldn't
    // be there per business logic). Live case: Maruthi RSHD2627000659
    // (2026-05-28) — 5 KG ordered=2 delivered=0 produced a "5 KG qty=0
    // ₹0.00" line on the invoice PDF.
    if (qty <= 0) continue;
    totalDeliveredQty += qty;
    const effectivePrice = Math.max(toNum(oi.unitPrice) - toNum(oi.discountPerUnit), 0);
    const lineTotal = effectivePrice * qty;
    totalAmount += lineTotal;

    if (gstEnabled) {
      // CLAUDE.md anti-pattern #16/#17: InvoiceItem.unitPrice is GST-INCLUSIVE
      // end to end (matches OrderItem.unitPrice and CylinderPrice.price). The
      // base is computed ONCE here, only for the Invoice.cgstValue/sgstValue/
      // igstValue aggregates. Downstream readers (invoicePdfService.computeItems
      // and gst/payloadBuilders.buildIrnPayload) assume inclusive and apply a
      // single /1.18 of their own. Storing base here was the historical bug
      // that produced ₹42,000 → ₹30,163.75 (= /1.18²) in IRN AssAmt.
      const basePrice = effectivePrice / (1 + GST_RATES.IGST);
      totalBaseAmount += basePrice * qty;

      invoiceItems.push({
        cylinderTypeId: oi.cylinderTypeId,
        description: oi.cylinderType.typeName,
        hsnCode: oi.cylinderType.hsnCode,
        quantity: qty,
        unitPrice: toNum(oi.unitPrice), // GST-inclusive, BEFORE discount
        discountPerUnit: oi.discountPerUnit, // GST-inclusive
        gstRate: 18,
        totalPrice: lineTotal, // GST-inclusive, AFTER discount = (unitPrice − discountPerUnit) × qty
        // Phase 5 (2026-06-12): GSTR-1 Table 12 (HSN summary) inputs.
        // taxableValue = post-discount inclusive line total / (1 + 18%).
        // uom defaults to 'NOS' in schema; left implicit here.
        taxableValue: basePrice * qty,
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
        // Phase 5: with gstRate=0 the taxable value equals the line total.
        taxableValue: lineTotal,
      });
    }
  }

  // Inward transport charge (HSN 996511, 18%): optional per-customer fee of
  // ₹X (GST-inclusive) per delivered cylinder. Stored as a separate invoice
  // line, identical shape to cylinder lines so it flows through the PDF, IRN
  // (IsServc='Y' for 99xxxx) and EWB the same way. Skipped when rate is 0.
  const transportRate = toNum(order.customer?.transportChargePerCylinder);
  if (transportRate > 0 && totalDeliveredQty > 0) {
    const transportTotal = transportRate * totalDeliveredQty; // GST-inclusive
    totalAmount += transportTotal;
    if (gstEnabled) {
      const transportBase = transportRate / (1 + GST_RATES.IGST);
      totalBaseAmount += transportBase * totalDeliveredQty;
      invoiceItems.push({
        cylinderTypeId: null,
        description: 'Inward Transportation Charges',
        hsnCode: '996511',
        quantity: totalDeliveredQty,
        unitPrice: transportRate, // GST-inclusive — see anti-pattern #16
        discountPerUnit: 0,
        gstRate: 18,
        totalPrice: transportTotal,
        // Phase 5: HSN 996511 (services) — taxable value pre-tax.
        taxableValue: transportBase * totalDeliveredQty,
      });
    } else {
      invoiceItems.push({
        cylinderTypeId: null,
        description: 'Inward Transportation Charges',
        hsnCode: '996511',
        quantity: totalDeliveredQty,
        unitPrice: transportRate,
        discountPerUnit: 0,
        gstRate: 0,
        totalPrice: transportTotal,
        taxableValue: transportTotal,
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

  // Phase 5 (2026-06-12): GSTR-1 export columns (Tables 4/5/7).
  //   - taxableValue: assessable amount = totalBaseAmount (already
  //     calculated above; equals totalAmount when GST is disabled).
  //   - placeOfSupplyCode: 2-digit state code — see deriveStateCode.
  //   - reverseCharge: false — LPG retail is NOT reverse charge.
  //   - customerGstinSnapshot: snapshot at issue so a future customer
  //     GSTIN edit doesn't drift the GSTR-1 record (CLAUDE.md anti-
  //     pattern #16-style write-time discipline).
  const taxableValue = gstEnabled ? Math.round(totalBaseAmount * 100) / 100 : totalAmount;
  const placeOfSupplyCode = deriveStateCode(order.customer?.gstin, order.customer?.billingState);
  const customerGstinSnapshot = order.customer?.gstin || null;

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
      taxableValue,
      placeOfSupplyCode,
      reverseCharge: false,
      customerGstinSnapshot,
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
    select: { state: true, docCode: true },
  });
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    // Phase 5: pull gstin for placeOfSupplyCode + customerGstinSnapshot.
    select: { billingState: true, gstin: true },
  });

  if (!customer) throw new InvoiceError('Customer not found', 404);

  const isInterState = distributor?.state && customer.billingState
    ? distributor.state !== customer.billingState
    : false;

  // createManualInvoice accepts EXCLUSIVE input prices at the API boundary
  // (caller specifies pre-tax unit price + gstRate). To keep the storage
  // convention identical to createInvoiceFromOrder (CLAUDE.md anti-pattern
  // #16: InvoiceItem.unitPrice is GST-INCLUSIVE), we convert per-item to
  // inclusive units before persisting. Total math (base → cgst/sgst/igst →
  // total) stays exactly as before.
  let totalBeforeGst = 0;

  const invoiceItems = data.items.map(item => {
    const discount = item.discountPerUnit ?? 0;
    const effectivePrice = Math.max(item.unitPrice - discount, 0);
    const exclLineTotal = effectivePrice * item.quantity;
    totalBeforeGst += exclLineTotal;
    const rate = item.gstRate ?? 18;
    const mult = 1 + rate / 100;
    const inclUnitPrice = Math.round(item.unitPrice * mult * 100) / 100;
    const inclDiscount = Math.round(discount * mult * 100) / 100;
    const inclLineTotal = Math.round(exclLineTotal * mult * 100) / 100;
    return {
      cylinderTypeId: item.cylinderTypeId || null,
      description: item.description,
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unitPrice: inclUnitPrice, // GST-inclusive (storage invariant)
      discountPerUnit: inclDiscount, // GST-inclusive
      gstRate: rate,
      totalPrice: inclLineTotal, // GST-inclusive line total
      // Phase 5: per-line assessable amount (pre-tax) for GSTR-1 Table 12.
      taxableValue: Math.round(exclLineTotal * 100) / 100,
    };
  });

  const cgstValue = isInterState ? 0 : totalBeforeGst * GST_RATES.CGST;
  const sgstValue = isInterState ? 0 : totalBeforeGst * GST_RATES.SGST;
  const igstValue = isInterState ? totalBeforeGst * GST_RATES.IGST : 0;
  const totalAmount = totalBeforeGst + cgstValue + sgstValue + igstValue;

  const invoice = await prisma.$transaction(async (tx) => {
    // WI-108: structured number when docCode is set, else legacy random.
    const invoiceNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'I', new Date(data.issueDate), distributor.docCode)
      : legacyNumber('INV');
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
        // Phase 5 (2026-06-12): GSTR-1 export columns (Tables 4/5/7).
        taxableValue: Math.round(totalBeforeGst * 100) / 100,
        placeOfSupplyCode: deriveStateCode(customer.gstin, customer.billingState),
        reverseCharge: false,
        customerGstinSnapshot: customer.gstin,
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

  // WI-108: structured number when docCode is set, else legacy random.
  // Allocated inside the same tx as the create so the counter rolls back on failure.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId }, select: { docCode: true },
  });

  return prisma.$transaction(async (tx) => {
    const creditNoteNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'C', new Date(), distributor.docCode)
      : legacyNumber('CN');
    // Phase 5 (2026-06-12): GSTR-1 Table 9B (Credit / Debit Notes) tax
    // splits. The credit applies proportionally across cgst/sgst/igst on
    // the parent invoice: ratio = creditAmount / invoiceTotal. We use the
    // invoice's stored tax columns rather than re-deriving from items so a
    // reissued invoice's revised splits are honoured automatically.
    const totalInv = toNum(invoice.totalAmount);
    const ratio = totalInv > 0 ? data.amount / totalInv : 0;
    const cnCgst = Math.round(toNum(invoice.cgstValue) * ratio * 100) / 100;
    const cnSgst = Math.round(toNum(invoice.sgstValue) * ratio * 100) / 100;
    const cnIgst = Math.round(toNum(invoice.igstValue) * ratio * 100) / 100;
    const cnTaxable = Math.round((data.amount - (cnCgst + cnSgst + cnIgst)) * 100) / 100;

    return tx.creditNote.create({
      data: {
        invoiceId: data.invoiceId,
        creditNoteNumber,
        totalAmount: data.amount,
        reason: data.reason,
        note: data.note ?? null,
        status: 'pending_cn',
        // Phase 5: tax splits + reason classification. reasonCode is null
        // here because the create-CN modal doesn't capture it yet; the
        // GSTR-1 export defaults nulls to 'C' (Correction). UI surface for
        // explicit reasonCode lands in a follow-up.
        taxableValue: cnTaxable,
        cgstValue: cnCgst,
        sgstValue: cnSgst,
        igstValue: cnIgst,
        reasonCode: null,
        issuedBy: userId,
      },
    });
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

  // WI-108: structured number when docCode is set, else legacy random.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId }, select: { docCode: true },
  });

  return prisma.$transaction(async (tx) => {
    const debitNoteNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'D', new Date(), distributor.docCode)
      : legacyNumber('DN');
    return tx.debitNote.create({
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
    data: { status: status as $Enums.InvoiceStatus },
  });
}

/**
 * Mark overdue invoices (for cron job usage).
 *
 * WI-122: this is now SUPPLEMENTARY. The canonical "overdue" amount is the
 * ledger formula in paymentService.computeCustomerOverdue (used by the
 * dashboard, collections, and the order-placement gate). This flag only
 * affects the invoice.status badge and the admin "overdue invoice count".
 * TODO: wire a daily cron to call this so the status badge stays fresh.
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
  const where: Prisma.InvoiceWhereInput = {
    distributorId,
    deletedAt: null,
    status: { not: 'cancelled' },
    isGaslinkBilling: false,
    items: { some: { gstRate: 0 } },
  };
  if (fromDate || toDate) {
    const issueDate: Prisma.DateTimeFilter = {};
    if (fromDate) issueDate.gte = new Date(fromDate);
    if (toDate) issueDate.lte = new Date(toDate);
    where.issueDate = issueDate;
  }

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
      // Update each item with GST breakup.
      // CLAUDE.md anti-pattern #16: unitPrice is GST-INCLUSIVE in storage.
      // A gstRate=0 item already has its inclusive price stored in unitPrice
      // (the non-GST branch in createInvoiceFromOrder stores raw inclusive).
      // Retroactive activation only computes the base for tax aggregation
      // and flips gstRate to 18 — unitPrice MUST NOT be re-divided here.
      for (const item of invoice.items) {
        if (item.gstRate === 0) {
          const effectivePrice = Math.max(toNum(item.unitPrice) - toNum(item.discountPerUnit), 0);
          const basePrice = effectivePrice / 1.18;
          totalBaseAmount += basePrice * item.quantity;

          await tx.invoiceItem.update({
            where: { id: item.id },
            data: {
              gstRate: 18,
              // unitPrice and totalPrice stay as stored (both inclusive)
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
