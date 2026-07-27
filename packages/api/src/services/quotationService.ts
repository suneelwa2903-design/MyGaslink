/**
 * Mini-op #7 (2026-07-27) — Quotation service.
 *
 * Rate-card quotations. Distinct from invoices — a quote sets a RATE,
 * not a value. Per-cylinder and per-KG line items can mix.
 *
 * Tenant scoping: every query includes distributorId from the JWT (route
 * layer). Cross-tenant reads/writes are structurally impossible.
 *
 * Duplication (`duplicateQuotation`): clones a past quote into a fresh
 * draft with a new number and today's date. If the source had a linked
 * customerId, the recipient block is REFRESHED from the current customer
 * record (address changes since the last quote are reflected). Freeform
 * recipients are carried forward as-is. Everything else — line items,
 * subject, cover, terms, credit terms, GST rate — is copied. The
 * `duplicate_from_id` FK preserves lineage so multi-month quote chains
 * are traceable.
 */
import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { QuotationMode, QuotationStatus, QuotationItemKind } from '@prisma/client';
import { toNum } from '../utils/decimal.js';
import type {
  CreateQuotationInput,
  UpdateQuotationInput,
  ListQuotationsQuery,
  QuotationItemInput,
} from '@gaslink/shared';

export class QuotationError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'QuotationError';
  }
}

const quotationInclude = {
  items: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  duplicateFrom: { select: { quotationNumber: true } },
} satisfies Prisma.QuotationInclude;

type QuotationWithJoins = Prisma.QuotationGetPayload<{ include: typeof quotationInclude }>;

// ─── Mapper ──────────────────────────────────────────────────────────────────

function mapItem(item: QuotationWithJoins['items'][number]) {
  return {
    quotationItemId: item.id,
    kind: item.kind,
    cylinderTypeId: item.cylinderTypeId,
    itemName: item.itemName,
    hsnCode: item.hsnCode,
    priceInclGst: item.priceInclGst !== null ? toNum(item.priceInclGst) : null,
    discountInclGst: item.discountInclGst !== null ? toNum(item.discountInclGst) : null,
    cylinderCapacityKg: item.cylinderCapacityKg !== null ? toNum(item.cylinderCapacityKg) : null,
    pricePerKgInclGst: item.pricePerKgInclGst !== null ? toNum(item.pricePerKgInclGst) : null,
    discountPerKgInclGst: item.discountPerKgInclGst !== null ? toNum(item.discountPerKgInclGst) : null,
    sortOrder: item.sortOrder,
    notes: item.notes,
  };
}

function mapQuotation(q: QuotationWithJoins) {
  // Deserialise the JSONB `terms` — Prisma returns Prisma.JsonValue.
  const terms = Array.isArray(q.terms) ? (q.terms as string[]) : [];
  return {
    quotationId: q.id,
    distributorId: q.distributorId,
    quotationNumber: q.quotationNumber,
    year: q.year,
    seq: q.seq,
    quotationDate: q.quotationDate,
    validUntil: q.validUntil,
    customerId: q.customerId,
    recipientName: q.recipientName,
    recipientContactPerson: q.recipientContactPerson,
    recipientAddress: q.recipientAddress,
    recipientCity: q.recipientCity,
    recipientState: q.recipientState,
    recipientPincode: q.recipientPincode,
    recipientEmail: q.recipientEmail,
    recipientPhone: q.recipientPhone,
    recipientGstin: q.recipientGstin,
    subject: q.subject,
    coverText: q.coverText,
    footerNotes: q.footerNotes,
    terms,
    creditTerms: q.creditTerms,
    gstRate: toNum(q.gstRate),
    mode: q.mode,
    status: q.status,
    sentAt: q.sentAt?.toISOString() ?? null,
    acceptedAt: q.acceptedAt?.toISOString() ?? null,
    duplicateFromId: q.duplicateFromId,
    duplicateFromNumber: q.duplicateFrom?.quotationNumber ?? null,
    createdBy: q.createdBy,
    createdAt: q.createdAt.toISOString(),
    updatedAt: q.updatedAt.toISOString(),
    items: q.items.map(mapItem),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function deriveMode(items: QuotationItemInput[]): QuotationMode {
  const kinds = new Set(items.map((it) => it.kind));
  if (kinds.size > 1) return QuotationMode.mixed;
  if (kinds.has('per_kg')) return QuotationMode.per_kg;
  return QuotationMode.per_cylinder;
}

/** Allocate the next (year, seq) inside a transaction — MAX+1. */
async function nextNumber(
  tx: Prisma.TransactionClient,
  distributorId: string,
  quotationDate: string,
): Promise<{ year: number; seq: number; quotationNumber: string }> {
  const year = Number(quotationDate.slice(0, 4));
  const last = await tx.quotation.findFirst({
    where: { distributorId, year },
    orderBy: { seq: 'desc' },
    select: { seq: true },
  });
  const seq = (last?.seq ?? 0) + 1;
  const quotationNumber = `QUO-${year}-${String(seq).padStart(3, '0')}`;
  return { year, seq, quotationNumber };
}

/** Prisma create-data for one item row. */
function itemCreateData(it: QuotationItemInput, idx: number) {
  const base = {
    kind: it.kind === 'per_cylinder' ? QuotationItemKind.per_cylinder : QuotationItemKind.per_kg,
    cylinderTypeId: it.cylinderTypeId ?? null,
    itemName: it.itemName,
    hsnCode: it.hsnCode,
    sortOrder: it.sortOrder ?? idx * 10,
    notes: it.notes ?? null,
  };
  if (it.kind === 'per_cylinder') {
    return {
      ...base,
      priceInclGst: it.priceInclGst,
      discountInclGst: it.discountInclGst,
      cylinderCapacityKg: null,
      pricePerKgInclGst: null,
      discountPerKgInclGst: null,
    };
  }
  return {
    ...base,
    priceInclGst: null,
    discountInclGst: null,
    cylinderCapacityKg: it.cylinderCapacityKg,
    pricePerKgInclGst: it.pricePerKgInclGst,
    discountPerKgInclGst: it.discountPerKgInclGst,
  };
}

/** Verify every cylinderTypeId (if any) belongs to the tenant. */
async function assertCylinderTypesInTenant(
  distributorId: string, items: QuotationItemInput[],
) {
  const ids = Array.from(new Set(items.map((i) => i.cylinderTypeId).filter((id): id is string => !!id)));
  if (ids.length === 0) return;
  const found = await prisma.cylinderType.findMany({
    where: { id: { in: ids }, distributorId },
    select: { id: true },
  });
  const foundIds = new Set(found.map((f) => f.id));
  const missing = ids.filter((id) => !foundIds.has(id));
  if (missing.length > 0) {
    throw new QuotationError(
      `Cylinder type(s) not in this tenant: ${missing.join(', ')}`,
      400, 'CYLINDER_TYPE_NOT_FOUND',
    );
  }
}

async function assertCustomerInTenant(distributorId: string, customerId: string | null | undefined) {
  if (!customerId) return;
  const c = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!c) throw new QuotationError('Customer not in this tenant', 400, 'CUSTOMER_NOT_FOUND');
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function createQuotation(
  distributorId: string,
  userId: string,
  data: CreateQuotationInput,
) {
  await assertCustomerInTenant(distributorId, data.customerId);
  await assertCylinderTypesInTenant(distributorId, data.items);

  const mode = deriveMode(data.items);

  const created = await prisma.$transaction(async (tx) => {
    const { year, seq, quotationNumber } = await nextNumber(tx, distributorId, data.quotationDate);
    return tx.quotation.create({
      data: {
        distributorId,
        quotationNumber,
        year,
        seq,
        quotationDate: data.quotationDate,
        validUntil: data.validUntil,
        customerId: data.customerId ?? null,
        recipientName: data.recipientName,
        recipientContactPerson: data.recipientContactPerson ?? null,
        recipientAddress: data.recipientAddress ?? null,
        recipientCity: data.recipientCity ?? null,
        recipientState: data.recipientState ?? null,
        recipientPincode: data.recipientPincode || null,
        recipientEmail: data.recipientEmail,
        recipientPhone: data.recipientPhone ?? null,
        recipientGstin: data.recipientGstin || null,
        subject: data.subject,
        coverText: data.coverText,
        footerNotes: data.footerNotes ?? null,
        terms: data.terms as Prisma.InputJsonValue,
        creditTerms: data.creditTerms,
        gstRate: data.gstRate,
        mode,
        status: QuotationStatus.draft,
        createdBy: userId,
        items: {
          create: data.items.map((it, idx) => itemCreateData(it, idx)),
        },
      },
      include: quotationInclude,
    });
  });
  return mapQuotation(created);
}

export async function updateQuotation(
  distributorId: string,
  id: string,
  data: UpdateQuotationInput,
) {
  const existing = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  if (existing.status !== QuotationStatus.draft) {
    throw new QuotationError(
      'Only draft quotations can be edited. Duplicate this one to create a new draft.',
      400, 'NOT_EDITABLE',
    );
  }
  if (data.customerId !== undefined) {
    await assertCustomerInTenant(distributorId, data.customerId);
  }
  if (data.items) {
    await assertCylinderTypesInTenant(distributorId, data.items);
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Replace-all semantics for items when the payload includes them.
    if (data.items) {
      await tx.quotationItem.deleteMany({ where: { quotationId: id } });
      await tx.quotationItem.createMany({
        data: data.items.map((it, idx) => ({
          quotationId: id,
          ...itemCreateData(it, idx),
        })),
      });
    }
    return tx.quotation.update({
      where: { id },
      data: {
        quotationDate: data.quotationDate,
        validUntil: data.validUntil,
        customerId: data.customerId,
        recipientName: data.recipientName,
        recipientContactPerson: data.recipientContactPerson,
        recipientAddress: data.recipientAddress,
        recipientCity: data.recipientCity,
        recipientState: data.recipientState,
        recipientPincode: data.recipientPincode || undefined,
        recipientEmail: data.recipientEmail,
        recipientPhone: data.recipientPhone,
        recipientGstin: data.recipientGstin || undefined,
        subject: data.subject,
        coverText: data.coverText,
        footerNotes: data.footerNotes,
        terms: data.terms as Prisma.InputJsonValue | undefined,
        creditTerms: data.creditTerms,
        gstRate: data.gstRate,
        mode: data.items ? deriveMode(data.items) : undefined,
      },
      include: quotationInclude,
    });
  });
  return mapQuotation(updated);
}

export async function getQuotation(distributorId: string, id: string) {
  const row = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: quotationInclude,
  });
  if (!row) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  return mapQuotation(row);
}

export async function listQuotations(distributorId: string, query: ListQuotationsQuery) {
  const where: Prisma.QuotationWhereInput = { distributorId, deletedAt: null };
  if (query.from || query.to) {
    where.quotationDate = {};
    if (query.from) (where.quotationDate as { gte?: string }).gte = query.from;
    if (query.to) (where.quotationDate as { lte?: string }).lte = query.to;
  }
  if (query.status) where.status = query.status as QuotationStatus;
  if (query.customerId) where.customerId = query.customerId;

  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 50;
  const [rows, total] = await Promise.all([
    prisma.quotation.findMany({
      where,
      select: {
        id: true, quotationNumber: true, quotationDate: true, validUntil: true,
        recipientName: true, recipientEmail: true, customerId: true, subject: true,
        mode: true, status: true, gstRate: true, createdAt: true, sentAt: true,
        _count: { select: { items: true } },
      },
      orderBy: [{ quotationDate: 'desc' }, { createdAt: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.quotation.count({ where }),
  ]);

  return {
    quotations: rows.map((r) => ({
      quotationId: r.id,
      quotationNumber: r.quotationNumber,
      quotationDate: r.quotationDate,
      validUntil: r.validUntil,
      recipientName: r.recipientName,
      recipientEmail: r.recipientEmail,
      customerId: r.customerId,
      subject: r.subject,
      mode: r.mode,
      status: r.status,
      gstRate: toNum(r.gstRate),
      itemCount: r._count.items,
      createdAt: r.createdAt.toISOString(),
      sentAt: r.sentAt?.toISOString() ?? null,
    })),
    meta: { page, pageSize, total, pageCount: Math.max(1, Math.ceil(total / pageSize)) },
  };
}

export async function deleteQuotation(distributorId: string, id: string) {
  const existing = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  if (existing.status !== QuotationStatus.draft) {
    throw new QuotationError(
      'Only drafts can be deleted. Sent/accepted quotes are preserved as history.',
      400, 'NOT_DELETABLE',
    );
  }
  await prisma.quotation.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
}

/**
 * Duplicate a past quote into a fresh draft with a new number + today's
 * date. If source had a customerId, refresh the recipient block from the
 * live customer record (so an address update since last month is reflected).
 * Otherwise carry the freeform recipient snapshot forward as-is.
 */
export async function duplicateQuotation(
  distributorId: string, userId: string, sourceId: string,
  today: string,   // YYYY-MM-DD local
  validityDays = 30,
) {
  const source = await prisma.quotation.findFirst({
    where: { id: sourceId, distributorId, deletedAt: null },
    include: quotationInclude,
  });
  if (!source) throw new QuotationError('Source quotation not found', 404, 'NOT_FOUND');

  // Refresh recipient from customer record if linked. If the customer was
  // soft-deleted or reassigned, fall back to the snapshot on the source.
  let recipient = {
    name: source.recipientName,
    contactPerson: source.recipientContactPerson,
    address: source.recipientAddress,
    city: source.recipientCity,
    state: source.recipientState,
    pincode: source.recipientPincode,
    email: source.recipientEmail,
    phone: source.recipientPhone,
    gstin: source.recipientGstin,
  };
  if (source.customerId) {
    const c = await prisma.customer.findFirst({
      where: { id: source.customerId, distributorId, deletedAt: null },
      select: {
        customerName: true, gstin: true, phone: true,
        billingAddressLine1: true, billingAddressLine2: true,
        billingCity: true, billingState: true, billingPincode: true,
        contacts: { where: { isPrimary: true }, select: { email: true, name: true, phone: true }, take: 1 },
      },
    });
    if (c) {
      const primary = c.contacts[0];
      const address = [c.billingAddressLine1, c.billingAddressLine2].filter(Boolean).join(', ');
      recipient = {
        name: c.customerName,
        contactPerson: primary?.name ?? recipient.contactPerson,
        address: address || recipient.address,
        city: c.billingCity ?? recipient.city,
        state: c.billingState ?? recipient.state,
        pincode: c.billingPincode ?? recipient.pincode,
        email: primary?.email ?? recipient.email,
        phone: primary?.phone ?? c.phone ?? recipient.phone,
        gstin: c.gstin ?? recipient.gstin,
      };
    }
  }

  const validUntil = addDays(today, validityDays);

  const created = await prisma.$transaction(async (tx) => {
    const { year, seq, quotationNumber } = await nextNumber(tx, distributorId, today);
    return tx.quotation.create({
      data: {
        distributorId,
        quotationNumber,
        year, seq,
        quotationDate: today,
        validUntil,
        customerId: source.customerId,
        recipientName: recipient.name,
        recipientContactPerson: recipient.contactPerson,
        recipientAddress: recipient.address,
        recipientCity: recipient.city,
        recipientState: recipient.state,
        recipientPincode: recipient.pincode,
        recipientEmail: recipient.email,
        recipientPhone: recipient.phone,
        recipientGstin: recipient.gstin,
        subject: source.subject,
        coverText: source.coverText,
        footerNotes: source.footerNotes,
        terms: source.terms as Prisma.InputJsonValue,
        creditTerms: source.creditTerms,
        gstRate: source.gstRate,
        mode: source.mode,
        status: QuotationStatus.draft,
        duplicateFromId: source.id,
        createdBy: userId,
        items: {
          create: source.items.map((it, idx) => ({
            kind: it.kind,
            cylinderTypeId: it.cylinderTypeId,
            itemName: it.itemName,
            hsnCode: it.hsnCode,
            priceInclGst: it.priceInclGst,
            discountInclGst: it.discountInclGst,
            cylinderCapacityKg: it.cylinderCapacityKg,
            pricePerKgInclGst: it.pricePerKgInclGst,
            discountPerKgInclGst: it.discountPerKgInclGst,
            sortOrder: it.sortOrder ?? idx * 10,
            notes: it.notes,
          })),
        },
      },
      include: quotationInclude,
    });
  });
  return mapQuotation(created);
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

// ─── Status transitions ─────────────────────────────────────────────────────

export async function markSent(distributorId: string, id: string) {
  const existing = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  if (existing.status !== QuotationStatus.draft) {
    throw new QuotationError('Only drafts can be marked sent', 400, 'BAD_TRANSITION');
  }
  const updated = await prisma.quotation.update({
    where: { id },
    data: { status: QuotationStatus.sent, sentAt: new Date() },
    include: quotationInclude,
  });
  return mapQuotation(updated);
}

export async function markAccepted(distributorId: string, id: string) {
  const existing = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  if (existing.status === QuotationStatus.accepted) return getQuotation(distributorId, id);
  if (existing.status !== QuotationStatus.draft && existing.status !== QuotationStatus.sent) {
    throw new QuotationError('Only draft or sent quotes can be marked accepted', 400, 'BAD_TRANSITION');
  }
  const updated = await prisma.quotation.update({
    where: { id },
    data: { status: QuotationStatus.accepted, acceptedAt: new Date() },
    include: quotationInclude,
  });
  return mapQuotation(updated);
}

export async function markRejected(distributorId: string, id: string) {
  const existing = await prisma.quotation.findFirst({
    where: { id, distributorId, deletedAt: null },
    select: { id: true, status: true },
  });
  if (!existing) throw new QuotationError('Quotation not found', 404, 'NOT_FOUND');
  if (existing.status === QuotationStatus.rejected) return getQuotation(distributorId, id);
  if (existing.status !== QuotationStatus.draft && existing.status !== QuotationStatus.sent) {
    throw new QuotationError('Only draft or sent quotes can be marked rejected', 400, 'BAD_TRANSITION');
  }
  const updated = await prisma.quotation.update({
    where: { id },
    data: { status: QuotationStatus.rejected },
    include: quotationInclude,
  });
  return mapQuotation(updated);
}
