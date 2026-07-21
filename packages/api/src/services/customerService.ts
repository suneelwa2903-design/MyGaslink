import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import type { $Enums } from '@prisma/client';
import { GSTIN_REGEX, INDIAN_STATE_NAMES } from '@gaslink/shared';

// Group D2 (2026-06-11): case-insensitive lookup so a CSV value like
// "telangana" or "TELANGANA" matches "Telangana" without a warning.
const STATE_NAMES_LOWER = new Set(INDIAN_STATE_NAMES.map((s) => s.toLowerCase()));

/** Loosely-validated customer update payload (validation runs in the route's Zod schema). */
interface CustomerUpdateData {
  customerName?: string;
  businessName?: string | null;
  gstin?: string | null;
  phone?: string;
  email?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingState?: string | null;
  billingPincode?: string | null;
  shippingAddressLine1?: string | null;
  shippingAddressLine2?: string | null;
  shippingCity?: string | null;
  shippingState?: string | null;
  shippingPincode?: string | null;
  creditPeriodDays?: number;
  transportChargePerCylinder?: number;
  // 5 or 18 only (enforced by createCustomerSchema). null → use platform default 18%.
  gstRateOverride?: number | null;
  status?: $Enums.CustomerStatus;
  // Proof-of-collection Phase 1 (2026-07-15): when true, driver's
  // confirm-delivery flow requires proof capture.
  requireDeliveryVerification?: boolean;
  contacts?: Array<{ name: string; phone?: string; email?: string | null; isPrimary?: boolean }>;
  cylinderDiscounts?: Array<{ cylinderTypeId: string; discountPerUnit: number }>;
}

const customerInclude = {
  contacts: true,
  cylinderDiscounts: {
    include: { cylinderType: { select: { typeName: true } } },
  },
} satisfies Prisma.CustomerInclude;

// 2026-07-21 opening-state seed: heavier include used ONLY on the
// customer-detail path (`getCustomerById`). Avoided on `listCustomers`
// so the customers table load stays cheap; the flat wire field
// `preferredCylinderTypeIds` just returns [] when the join wasn't
// fetched (mapper defensive path).
const customerDetailInclude = {
  ...customerInclude,
  allowedCylinderTypes: {
    include: { cylinderType: { select: { typeName: true } } },
  },
  inventoryBalances: {
    include: { cylinderType: { select: { typeName: true } } },
  },
} satisfies Prisma.CustomerInclude;

export async function listCustomers(
  distributorId: string,
  filters: { status?: string; customerType?: string; search?: string; page?: number; pageSize?: number; unlinked?: string }
) {
  const where: Prisma.CustomerWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.status) where.status = filters.status as $Enums.CustomerStatus;
  if (filters.customerType) where.customerType = filters.customerType;
  if (filters.search) {
    where.OR = [
      { customerName: { contains: filters.search, mode: 'insensitive' } },
      { businessName: { contains: filters.search, mode: 'insensitive' } },
      { phone: { contains: filters.search } },
      { gstin: { contains: filters.search, mode: 'insensitive' } },
    ];
  }
  // Group B Part 3 — used by the smart Add User modal when role=customer.
  // `users: { none: { deletedAt: null } }` returns customers whose User[]
  // back-relation (1:N via User.customerId) is empty — i.e. no app login.
  if (filters.unlinked === 'true' || filters.unlinked === '1') {
    where.users = { none: { deletedAt: null } };
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;
  const [customers, total] = await Promise.all([
    prisma.customer.findMany({
      where,
      include: customerInclude,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.customer.count({ where }),
  ]);

  return {
    data: customers,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getCustomerById(id: string, distributorId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: customerDetailInclude,
  });
  if (!customer) return null;
  // 2026-07-21 opening-state seed: also fetch the linked OB invoice so
  // the Edit-Customer form can prefill the ₹ amount + notes. Only one
  // OB invoice per customer at a time (guaranteed by the seed flow).
  const openingInvoice = customer.openingStateSeededAt
    ? await prisma.invoice.findFirst({
        where: { distributorId, customerId: id, isOpeningBalance: true, deletedAt: null },
        select: { id: true, totalAmount: true, amountPaid: true, notes: true, issueDate: true },
      })
    : null;
  return { ...customer, openingInvoice };
}

export async function createCustomer(
  distributorId: string,
  data: {
    customerName: string;
    businessName?: string;
    gstin?: string;
    phone: string;
    email?: string;
    billingAddressLine1?: string;
    billingAddressLine2?: string;
    billingCity?: string;
    billingState?: string;
    billingPincode?: string;
    shippingAddressLine1?: string;
    shippingAddressLine2?: string;
    shippingCity?: string;
    shippingState?: string;
    shippingPincode?: string;
    creditPeriodDays?: number;
    transportChargePerCylinder?: number;
    // 5 or 18 only (enforced by createCustomerSchema upstream).
    gstRateOverride?: number | null;
    contacts?: { name: string; phone?: string; email?: string; isPrimary?: boolean }[];
    cylinderDiscounts?: { cylinderTypeId: string; discountPerUnit: number }[];
    // Proof-of-collection Phase 1 (2026-07-15): driver confirm-delivery
    // proof-capture toggle. Default false = existing behaviour.
    requireDeliveryVerification?: boolean;
  }
) {
  const warnings: string[] = [];

  // Validate GSTIN format if provided
  if (data.gstin && data.gstin.length > 0) {
    if (!GSTIN_REGEX.test(data.gstin)) {
      throw new CustomerError('Invalid GSTIN format', 400);
    }
    // Group E1 (2026-06-11): duplicate GSTIN is NO LONGER a hard 409.
    // Multi-branch customers (same legal entity, different physical sites)
    // legitimately share a GSTIN — Vanasthali's KINARA GRAND is the
    // canonical example. We let the row save and surface a soft warning
    // so the operator knows other branches exist. The IRN/EWB pipeline
    // resolves per-customer-row already (each branch carries its own
    // billing address into BuyerDtls — see anti-pattern note in
    // CLAUDE.md and gstPreflightService.ts:981-991).
    const existing = await prisma.customer.findFirst({
      where: { distributorId, gstin: data.gstin, deletedAt: null },
      select: { customerName: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      warnings.push(
        `This GSTIN is already used by "${existing.customerName}". This customer will be treated as a separate branch.`,
      );
    }
  }

  const customerType = data.gstin && data.gstin.length > 0 ? 'B2B' : 'B2C';

  const customer = await prisma.customer.create({
    data: {
      distributorId,
      customerName: data.customerName,
      businessName: data.businessName || null,
      gstin: data.gstin || null,
      customerType,
      phone: data.phone,
      email: data.email || null,
      billingAddressLine1: data.billingAddressLine1 || null,
      billingAddressLine2: data.billingAddressLine2 || null,
      billingCity: data.billingCity || null,
      billingState: data.billingState || null,
      billingPincode: data.billingPincode || null,
      shippingAddressLine1: data.shippingAddressLine1 || null,
      shippingAddressLine2: data.shippingAddressLine2 || null,
      shippingCity: data.shippingCity || null,
      shippingState: data.shippingState || null,
      shippingPincode: data.shippingPincode || null,
      creditPeriodDays: data.creditPeriodDays ?? 30,
      transportChargePerCylinder: data.transportChargePerCylinder ?? 0,
      // null when omitted → invoice paths fall back to platform default 18%.
      gstRateOverride: data.gstRateOverride ?? null,
      requireDeliveryVerification: data.requireDeliveryVerification ?? false,
      contacts: data.contacts && data.contacts.length > 0
        ? { create: data.contacts.map(c => ({ name: c.name, phone: c.phone || '', email: c.email || null, isPrimary: c.isPrimary ?? false })) }
        : undefined,
      cylinderDiscounts: data.cylinderDiscounts && data.cylinderDiscounts.length > 0
        ? { create: data.cylinderDiscounts.map(d => ({ cylinderTypeId: d.cylinderTypeId, discountPerUnit: d.discountPerUnit })) }
        : undefined,
    },
    include: customerInclude,
  });
  return { customer, warnings };
}

// ─── Opening-state seed (2026-07-21) ──────────────────────────────────────
//
// Universal customer-onboarding seed — one atomic transaction that
// writes the customer's starting ledger anchor: preferred cylinder-
// type list + empties held + ₹ opening balance. Available to ANY
// tenant (regular distributor OR mini-operator) via three paths:
//
//   1. Nested `openingState` on POST /api/customers          (this file)
//   2. POST /api/customers/:id/seed-opening-state             (Edit path)
//   3. CSV row on POST /api/customers/import-opening-balances (bulk)
//
// All three flow through `applySeedInTx()` — one implementation, one
// invariant set, one ledger contract. Idempotent: refuses to run a
// second time on a customer whose `opening_state_seeded_at` is set.
//
// Ledger contract (matches processLedgerEntries + PDF renderer):
//   - Opening balance ₹  → Invoice(isOpeningBalance=true, status=overdue)
//                           + CustomerLedgerEntry(entry_type='invoice')
//   - Seeded empties     → CustomerInventoryBalance.with_customer_qty
//                           per (customer, cylinder_type)
//                          + The ledger's OB row surfaces "b/f" empties
//                            via the linked balance rows (see
//                            processLedgerEntries opening-empties init).
//   - Preferred types    → CustomerAllowedCylinderType rows; order-form
//                           picker floats these to the top with a
//                           "usual" tag. NOT a hard filter.
//   - Audit anchor       → customers.opening_state_seeded_at = NOW()
export interface OpeningStateSeed {
  preferredCylinderTypeIds?: string[];
  empties?: Array<{ cylinderTypeId: string; qty: number }>;
  openingBalance?: {
    amount: number;
    asOfDate: string;
    notes?: string;
  };
}

export interface OpeningStateSeedResult {
  seededAt: string;
  preferredCylinderTypeCount: number;
  emptiesRowCount: number;
  openingInvoiceId: string | null;
}

// Internal helper — runs INSIDE an existing prisma.$transaction. All
// three entry points share this so the ledger anchor writes are
// identical across create / seed-later / CSV import.
async function applySeedInTx(
  tx: Prisma.TransactionClient,
  distributorId: string,
  userId: string,
  customerId: string,
  seed: OpeningStateSeed,
): Promise<OpeningStateSeedResult> {
  // Preferred cylinder types (sort hints on order form).
  const preferredIds = Array.from(new Set(seed.preferredCylinderTypeIds ?? []));
  if (preferredIds.length > 0) {
    await tx.customerAllowedCylinderType.createMany({
      data: preferredIds.map((cylinderTypeId) => ({
        customerId,
        cylinderTypeId,
      })),
      skipDuplicates: true,
    });
  }

  // Seeded empties held (state-current dashboard, and OB-row b/f in
  // ledger). Skip qty=0 rows to keep the table lean. Uses upsert
  // because a fresh customer has no balance row yet, but the CSV/
  // Edit path may run against a customer that already had zero rows.
  const emptiesRows = (seed.empties ?? []).filter((e) => e.qty > 0);
  for (const e of emptiesRows) {
    await tx.customerInventoryBalance.upsert({
      where: {
        customerId_cylinderTypeId: {
          customerId,
          cylinderTypeId: e.cylinderTypeId,
        },
      },
      create: {
        customerId,
        cylinderTypeId: e.cylinderTypeId,
        withCustomerQty: e.qty,
        openingSeedQty: e.qty,
      },
      // Ledger OB row reads openingSeedQty to render the "b/f" empties
      // count. Preserved immutably after the first seed — if the
      // caller reruns (only possible via the CSV bulk path today), we
      // only advance withCustomerQty; openingSeedQty stays.
      update: {
        withCustomerQty: e.qty,
        openingSeedQty: e.qty,
      },
    });
  }

  // Opening balance ₹ — synthetic Invoice + item + ledger entry.
  // Mirrors importOpeningBalances line-by-line so the reader path
  // stays identical.
  let openingInvoiceId: string | null = null;
  if (seed.openingBalance && seed.openingBalance.amount > 0) {
    const ob = seed.openingBalance;
    const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(ob.asOfDate)
      ? new Date(ob.asOfDate)
      : new Date();
    const invoiceNumber = `OB-${customerId.slice(0, 8)}-${asOfDate.toISOString().split('T')[0]}-${Math.random().toString(36).slice(2, 6)}`;
    const invoice = await tx.invoice.create({
      data: {
        invoiceNumber,
        distributorId,
        customerId,
        issueDate: asOfDate,
        dueDate: asOfDate,
        totalAmount: ob.amount,
        outstandingAmount: ob.amount,
        amountPaid: 0,
        status: 'overdue',
        isOpeningBalance: true,
        notes: ob.notes?.trim() || 'Opening balance seeded via customer setup',
        issuedBy: userId,
      },
    });
    openingInvoiceId = invoice.id;
    await tx.customerLedgerEntry.create({
      data: {
        distributorId,
        customerId,
        entryType: 'invoice_entry',
        referenceId: invoice.id,
        invoiceId: invoice.id,
        amountDelta: ob.amount,
        narration: ob.notes?.trim()
          ? `Opening Balance b/f — ${ob.notes.trim()}`
          : 'Opening Balance b/f',
        entryDate: asOfDate,
        createdBy: userId,
      },
    });
  }

  const seededAt = new Date();
  await tx.customer.update({
    where: { id: customerId },
    data: { openingStateSeededAt: seededAt },
  });

  return {
    seededAt: seededAt.toISOString(),
    preferredCylinderTypeCount: preferredIds.length,
    emptiesRowCount: emptiesRows.length,
    openingInvoiceId,
  };
}

// Validate every referenced cylinderTypeId belongs to THIS distributor
// and is active + not deleted. Runs OUTSIDE the tx so the tx body
// stays small. Returns 400-shaped CustomerError with all missing ids.
async function validateSeedCylinderTypes(
  distributorId: string,
  seed: OpeningStateSeed,
): Promise<void> {
  const referencedTypeIds = Array.from(new Set([
    ...(seed.preferredCylinderTypeIds ?? []),
    ...(seed.empties ?? []).map((e) => e.cylinderTypeId),
  ]));
  if (referencedTypeIds.length === 0) return;
  const found = await prisma.cylinderType.findMany({
    where: {
      id: { in: referencedTypeIds },
      distributorId,
      isActive: true,
    },
    select: { id: true },
  });
  const foundSet = new Set(found.map((f) => f.id));
  const missing = referencedTypeIds.filter((id) => !foundSet.has(id));
  if (missing.length > 0) {
    throw new CustomerError(
      `Cylinder type(s) not found in your catalog or inactive: ${missing.join(', ')}`,
      400,
    );
  }
}

// Path 1: POST /api/customers — customer create + optional seed in
// one atomic tx. If no `openingState`, delegates to the existing
// createCustomer (zero extra DB work, no tx wrap).
export async function createCustomerWithOpeningState(
  distributorId: string,
  userId: string,
  data: Parameters<typeof createCustomer>[1] & { openingState?: OpeningStateSeed },
): Promise<{
  customer: Awaited<ReturnType<typeof createCustomer>>['customer'];
  warnings: string[];
  seeded: OpeningStateSeedResult | null;
}> {
  const { openingState, ...baseData } = data;
  if (!openingState) {
    const { customer, warnings } = await createCustomer(distributorId, baseData);
    return { customer, warnings, seeded: null };
  }

  // 2026-07-21 mini-op-only gate: opening-state seed is a reseller
  // onboarding tool. Regular distributors already have the CSV
  // importer at Settings → Onboarding → Import opening balances;
  // exposing this second path would duplicate/conflict with that.
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { accountType: true },
  });
  if (!dist) throw new CustomerError('Distributor not found', 404);
  if (dist.accountType !== 'mini_operator') {
    throw new CustomerError(
      'Opening state seed is a mini-operator feature. Regular distributors should use Settings → Onboarding → Import opening balances.',
      400,
    );
  }

  await validateSeedCylinderTypes(distributorId, openingState);

  // GSTIN soft-warning (mirrors createCustomer; inlined so the whole
  // create+seed lands in one tx).
  const warnings: string[] = [];
  if (baseData.gstin && baseData.gstin.length > 0) {
    if (!GSTIN_REGEX.test(baseData.gstin)) {
      throw new CustomerError('Invalid GSTIN format', 400);
    }
    const existing = await prisma.customer.findFirst({
      where: { distributorId, gstin: baseData.gstin, deletedAt: null },
      select: { customerName: true },
      orderBy: { createdAt: 'asc' },
    });
    if (existing) {
      warnings.push(
        `This GSTIN is already used by "${existing.customerName}". This customer will be treated as a separate branch.`,
      );
    }
  }
  const customerType = baseData.gstin && baseData.gstin.length > 0 ? 'B2B' : 'B2C';

  const result = await prisma.$transaction(async (tx) => {
    const customer = await tx.customer.create({
      data: {
        distributorId,
        customerName: baseData.customerName,
        businessName: baseData.businessName || null,
        gstin: baseData.gstin || null,
        customerType,
        phone: baseData.phone,
        email: baseData.email || null,
        billingAddressLine1: baseData.billingAddressLine1 || null,
        billingAddressLine2: baseData.billingAddressLine2 || null,
        billingCity: baseData.billingCity || null,
        billingState: baseData.billingState || null,
        billingPincode: baseData.billingPincode || null,
        shippingAddressLine1: baseData.shippingAddressLine1 || null,
        shippingAddressLine2: baseData.shippingAddressLine2 || null,
        shippingCity: baseData.shippingCity || null,
        shippingState: baseData.shippingState || null,
        shippingPincode: baseData.shippingPincode || null,
        creditPeriodDays: baseData.creditPeriodDays ?? 30,
        transportChargePerCylinder: baseData.transportChargePerCylinder ?? 0,
        gstRateOverride: baseData.gstRateOverride ?? null,
        requireDeliveryVerification: baseData.requireDeliveryVerification ?? false,
        contacts: baseData.contacts && baseData.contacts.length > 0
          ? { create: baseData.contacts.map((c) => ({
              name: c.name, phone: c.phone || '', email: c.email || null, isPrimary: c.isPrimary ?? false,
            })) }
          : undefined,
        cylinderDiscounts: baseData.cylinderDiscounts && baseData.cylinderDiscounts.length > 0
          ? { create: baseData.cylinderDiscounts.map((d) => ({
              cylinderTypeId: d.cylinderTypeId, discountPerUnit: d.discountPerUnit,
            })) }
          : undefined,
      },
      include: customerInclude,
    });
    const seeded = await applySeedInTx(tx, distributorId, userId, customer.id, openingState);
    return { customer, seeded };
  });
  return { customer: result.customer, warnings, seeded: result.seeded };
}

// Path 2: POST /api/customers/:id/seed-opening-state — Edit-Customer
// "seed later" flow. Universal. Guarded by opening_state_seeded_at IS
// NULL so a second call throws 400 (the ledger cannot be re-anchored
// safely).
export async function seedOpeningStateOnCustomer(
  distributorId: string,
  userId: string,
  customerId: string,
  seed: OpeningStateSeed,
): Promise<OpeningStateSeedResult> {
  // 2026-07-21 mini-op-only gate (same rationale as
  // createCustomerWithOpeningState above).
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { accountType: true },
  });
  if (!dist) throw new CustomerError('Distributor not found', 404);
  if (dist.accountType !== 'mini_operator') {
    throw new CustomerError(
      'Opening state seed is a mini-operator feature. Regular distributors should use Settings → Onboarding → Import opening balances.',
      400,
    );
  }
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, openingStateSeededAt: true },
  });
  if (!customer) throw new CustomerError('Customer not found', 404);
  if (customer.openingStateSeededAt) {
    throw new CustomerError(
      'This customer has already been seeded. Use credit / debit note flows to adjust the balance.',
      400,
    );
  }
  await validateSeedCylinderTypes(distributorId, seed);
  return prisma.$transaction(async (tx) => applySeedInTx(tx, distributorId, userId, customerId, seed));
}

// Path 3: PUT /api/customers/:id/opening-state — edit an already-seeded
// customer's opening state. Mini-op only. Refuses when the customer was
// never seeded (POST /:id/seed-opening-state handles first-time seed).
//
// Semantics per axis:
//   • preferredCylinderTypeIds — full replace (deleteMany + createMany).
//   • empties[]                 — full replace snapshot. opening_seed_qty
//                                 becomes the new value; with_customer_qty
//                                 is adjusted by the DELTA so the physical
//                                 stock reading stays consistent with
//                                 activity since the last seed.
//   • openingBalance            — mutate the linked OB invoice + ledger
//                                 entry in place. Payments already applied
//                                 to the OB are preserved: outstanding =
//                                 new_total − amountPaid. Refuses to
//                                 lower total below amountPaid. Absent /
//                                 amount=0 → delete the OB (refuses if any
//                                 payments were applied).
export async function updateOpeningStateOnCustomer(
  distributorId: string,
  userId: string,
  customerId: string,
  seed: OpeningStateSeed,
): Promise<OpeningStateSeedResult> {
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { accountType: true },
  });
  if (!dist) throw new CustomerError('Distributor not found', 404);
  if (dist.accountType !== 'mini_operator') {
    throw new CustomerError(
      'Opening state edit is a mini-operator feature. Regular distributors should use credit / debit note flows.',
      400,
    );
  }
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true, openingStateSeededAt: true },
  });
  if (!customer) throw new CustomerError('Customer not found', 404);
  if (!customer.openingStateSeededAt) {
    throw new CustomerError(
      'This customer has never been seeded. Use POST /customers/:id/seed-opening-state to seed it first.',
      400,
    );
  }
  await validateSeedCylinderTypes(distributorId, seed);

  // Snapshot current OB invoice + amountPaid BEFORE opening the tx so
  // the guard messages are readable and we can decide delete-vs-update
  // deterministically.
  const existingOb = await prisma.invoice.findFirst({
    where: { distributorId, customerId, isOpeningBalance: true, deletedAt: null },
    select: { id: true, totalAmount: true, amountPaid: true },
  });
  const wantAmount = seed.openingBalance?.amount ?? 0;
  const paid = existingOb ? Number(existingOb.amountPaid) : 0;
  if (existingOb && wantAmount > 0 && wantAmount < paid) {
    throw new CustomerError(
      `Cannot reduce opening balance below payments already applied (₹${paid.toFixed(2)}). Reverse the payments first.`,
      400,
    );
  }
  if (existingOb && wantAmount === 0 && paid > 0) {
    throw new CustomerError(
      `Cannot delete the opening balance while payments are applied to it (₹${paid.toFixed(2)}). Reverse the payments first.`,
      400,
    );
  }

  const asOf = seed.openingBalance?.asOfDate;
  const asOfDate = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? new Date(asOf) : new Date();

  return prisma.$transaction(async (tx) => {
    // 1. Preferred cylinder types — full replace.
    const preferredIds = Array.from(new Set(seed.preferredCylinderTypeIds ?? []));
    await tx.customerAllowedCylinderType.deleteMany({ where: { customerId } });
    if (preferredIds.length > 0) {
      await tx.customerAllowedCylinderType.createMany({
        data: preferredIds.map((cylinderTypeId) => ({ customerId, cylinderTypeId })),
      });
    }

    // 2. Empties — delta-apply per cylinder type. Pull current snapshot,
    // compute per-type delta = newQty - oldSeedQty, then advance
    // with_customer_qty by that delta. Types absent from the new list
    // fall to opening_seed_qty=0 (physical stock also decremented by
    // the old snapshot).
    const currentBalances = await tx.customerInventoryBalance.findMany({
      where: { customerId },
      select: { id: true, cylinderTypeId: true, withCustomerQty: true, openingSeedQty: true },
    });
    const currentByType = new Map(currentBalances.map((b) => [b.cylinderTypeId, b]));
    const newEmpties = new Map(
      (seed.empties ?? [])
        .filter((e) => e.qty > 0)
        .map((e) => [e.cylinderTypeId, e.qty]),
    );

    // Types that were in the old snapshot but not in the new → clear.
    for (const [typeId, cur] of currentByType) {
      if (!newEmpties.has(typeId) && cur.openingSeedQty > 0) {
        const delta = -cur.openingSeedQty;
        await tx.customerInventoryBalance.update({
          where: { id: cur.id },
          data: {
            openingSeedQty: 0,
            withCustomerQty: Math.max(0, cur.withCustomerQty + delta),
          },
        });
      }
    }
    // Types in the new snapshot — upsert with delta.
    for (const [typeId, newQty] of newEmpties) {
      const cur = currentByType.get(typeId);
      if (cur) {
        const delta = newQty - cur.openingSeedQty;
        await tx.customerInventoryBalance.update({
          where: { id: cur.id },
          data: {
            openingSeedQty: newQty,
            withCustomerQty: Math.max(0, cur.withCustomerQty + delta),
          },
        });
      } else {
        // First time seeing this type — treat as a fresh seed.
        await tx.customerInventoryBalance.create({
          data: {
            customerId,
            cylinderTypeId: typeId,
            withCustomerQty: newQty,
            openingSeedQty: newQty,
          },
        });
      }
    }

    // 3. Opening balance — update-in-place, create fresh, or delete.
    let openingInvoiceId: string | null = existingOb?.id ?? null;
    if (existingOb && wantAmount === 0) {
      // Delete path — guard already confirmed no payments applied.
      await tx.customerLedgerEntry.deleteMany({
        where: { invoiceId: existingOb.id, entryType: 'invoice_entry' },
      });
      await tx.invoice.delete({ where: { id: existingOb.id } });
      openingInvoiceId = null;
    } else if (existingOb && wantAmount > 0) {
      // Update in place. Preserve amountPaid; outstanding = new - paid.
      const ob = seed.openingBalance!;
      await tx.invoice.update({
        where: { id: existingOb.id },
        data: {
          totalAmount: ob.amount,
          outstandingAmount: ob.amount - paid,
          issueDate: asOfDate,
          dueDate: asOfDate,
          notes: ob.notes?.trim() || 'Opening balance edited via customer setup',
          status: ob.amount - paid > 0 ? 'overdue' : 'paid',
        },
      });
      await tx.customerLedgerEntry.updateMany({
        where: { invoiceId: existingOb.id, entryType: 'invoice_entry' },
        data: {
          amountDelta: ob.amount,
          narration: ob.notes?.trim()
            ? `Opening Balance b/f — ${ob.notes.trim()}`
            : 'Opening Balance b/f',
          entryDate: asOfDate,
        },
      });
    } else if (!existingOb && wantAmount > 0) {
      // No prior OB but they want one now — create fresh.
      const ob = seed.openingBalance!;
      const invoiceNumber = `OB-${customerId.slice(0, 8)}-${asOfDate.toISOString().split('T')[0]}-${Math.random().toString(36).slice(2, 6)}`;
      const invoice = await tx.invoice.create({
        data: {
          invoiceNumber,
          distributorId,
          customerId,
          issueDate: asOfDate,
          dueDate: asOfDate,
          totalAmount: ob.amount,
          outstandingAmount: ob.amount,
          amountPaid: 0,
          status: 'overdue',
          isOpeningBalance: true,
          notes: ob.notes?.trim() || 'Opening balance added via customer edit',
          issuedBy: userId,
        },
      });
      openingInvoiceId = invoice.id;
      await tx.customerLedgerEntry.create({
        data: {
          distributorId,
          customerId,
          entryType: 'invoice_entry',
          referenceId: invoice.id,
          invoiceId: invoice.id,
          amountDelta: ob.amount,
          narration: ob.notes?.trim()
            ? `Opening Balance b/f — ${ob.notes.trim()}`
            : 'Opening Balance b/f',
          entryDate: asOfDate,
          createdBy: userId,
        },
      });
    }

    // 4. Bump opening_state_seeded_at so callers can see it was
    // touched. Keep the marker set (never nulls out).
    await tx.customer.update({
      where: { id: customerId },
      data: { openingStateSeededAt: new Date() },
    });

    return {
      seededAt: new Date().toISOString(),
      preferredCylinderTypeCount: preferredIds.length,
      emptiesRowCount: newEmpties.size,
      openingInvoiceId,
    };
  });
}

export async function updateCustomer(
  id: string,
  distributorId: string,
  data: CustomerUpdateData,
  performedBy: string
) {
  const existing = await prisma.customer.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: customerInclude,
  });
  if (!existing) throw new CustomerError('Customer not found', 404);

  const warnings: string[] = [];

  // Validate GSTIN if changing
  if (data.gstin && data.gstin !== existing.gstin) {
    if (!GSTIN_REGEX.test(data.gstin)) {
      throw new CustomerError('Invalid GSTIN format', 400);
    }
    // Group E1 (2026-06-11): see createCustomer. Duplicate GSTIN is a
    // soft warning, not a hard block.
    const dup = await prisma.customer.findFirst({
      where: { distributorId, gstin: data.gstin, deletedAt: null, id: { not: id } },
      select: { customerName: true },
      orderBy: { createdAt: 'asc' },
    });
    if (dup) {
      warnings.push(
        `This GSTIN is already used by "${dup.customerName}". This customer will be treated as a separate branch.`,
      );
    }
  }

  const updatedCustomer = await prisma.$transaction(async (tx) => {
    // Log audit trail for changed fields
    const trackFields: (keyof CustomerUpdateData)[] = [
      'customerName', 'businessName', 'gstin', 'phone', 'email', 'transportChargePerCylinder',
      'billingAddressLine1', 'billingCity', 'billingState', 'billingPincode',
      'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPincode',
      'creditPeriodDays', 'gstRateOverride', 'status', 'requireDeliveryVerification',
    ];
    const existingRecord = existing as Record<string, unknown>;
    for (const field of trackFields) {
      if (data[field] !== undefined && data[field] !== existingRecord[field]) {
        await tx.customerAuditTrail.create({
          data: {
            customerId: id,
            distributorId,
            performedBy,
            actionType: 'field_update',
            fieldName: field,
            oldValue: existingRecord[field] as Prisma.InputJsonValue,
            newValue: data[field] as Prisma.InputJsonValue,
          },
        });
      }
    }

    // Handle contacts replacement
    if (data.contacts !== undefined) {
      await tx.customerContact.deleteMany({ where: { customerId: id } });
      if (data.contacts.length > 0) {
        await tx.customerContact.createMany({
          data: data.contacts.map((c) => ({
            customerId: id,
            name: c.name,
            phone: c.phone || '',
            email: c.email || null,
            isPrimary: c.isPrimary ?? false,
          })),
        });
      }
    }

    // Handle cylinder discounts replacement
    if (data.cylinderDiscounts !== undefined) {
      await tx.customerCylinderDiscount.deleteMany({ where: { customerId: id } });
      if (data.cylinderDiscounts.length > 0) {
        await tx.customerCylinderDiscount.createMany({
          data: data.cylinderDiscounts.map((d) => ({
            customerId: id,
            cylinderTypeId: d.cylinderTypeId,
            discountPerUnit: d.discountPerUnit,
          })),
        });
      }
    }

    const customerType = data.gstin && data.gstin.length > 0 ? 'B2B' : (existing.gstin ? existing.customerType : 'B2C');

    const updateData: Prisma.CustomerUpdateInput = {};
    if (data.customerName !== undefined) updateData.customerName = data.customerName;
    if (data.businessName !== undefined) updateData.businessName = data.businessName;
    if (data.gstin !== undefined) { updateData.gstin = data.gstin || null; updateData.customerType = customerType; }
    if (data.phone !== undefined) updateData.phone = data.phone;
    if (data.email !== undefined) updateData.email = data.email || null;
    if (data.billingAddressLine1 !== undefined) updateData.billingAddressLine1 = data.billingAddressLine1;
    if (data.billingAddressLine2 !== undefined) updateData.billingAddressLine2 = data.billingAddressLine2;
    if (data.billingCity !== undefined) updateData.billingCity = data.billingCity;
    if (data.billingState !== undefined) updateData.billingState = data.billingState;
    if (data.billingPincode !== undefined) updateData.billingPincode = data.billingPincode;
    if (data.shippingAddressLine1 !== undefined) updateData.shippingAddressLine1 = data.shippingAddressLine1;
    if (data.shippingAddressLine2 !== undefined) updateData.shippingAddressLine2 = data.shippingAddressLine2;
    if (data.shippingCity !== undefined) updateData.shippingCity = data.shippingCity;
    if (data.shippingState !== undefined) updateData.shippingState = data.shippingState;
    if (data.shippingPincode !== undefined) updateData.shippingPincode = data.shippingPincode;
    if (data.creditPeriodDays !== undefined) updateData.creditPeriodDays = data.creditPeriodDays;
    if (data.transportChargePerCylinder !== undefined) updateData.transportChargePerCylinder = data.transportChargePerCylinder;
    // gstRateOverride (5 | 18 | null): only changes future invoices'
    // InvoiceItem.gstRate snapshots — historic invoices keep their original
    // rates regardless. Schema validation guarantees 5 / 18 / null only.
    if (data.gstRateOverride !== undefined) updateData.gstRateOverride = data.gstRateOverride;
    // Status (active/suspended/inactive) — also mirrored to stopSupply so the
    // legacy boolean stays consistent with the new canonical field. Route
    // handler enforces the role guard before this point.
    if (data.status !== undefined) {
      updateData.status = data.status;
      updateData.stopSupply = data.status === 'suspended';
    }
    if (data.requireDeliveryVerification !== undefined) {
      updateData.requireDeliveryVerification = data.requireDeliveryVerification;
    }

    const updated = await tx.customer.update({
      where: { id },
      data: updateData,
      include: customerInclude,
    });
    return updated;
  });
  return { customer: updatedCustomer, warnings };
}

export async function softDeleteCustomer(id: string, distributorId: string) {
  const existing = await prisma.customer.findFirst({
    where: { id, distributorId, deletedAt: null },
  });
  if (!existing) throw new CustomerError('Customer not found', 404);

  return prisma.customer.update({
    where: { id },
    data: { deletedAt: new Date(), status: 'inactive' },
    select: { id: true },
  });
}

export async function createModificationRequest(
  customerId: string,
  distributorId: string,
  requestedBy: string,
  data: { modificationType: string; reason?: string; changes?: Prisma.InputJsonValue }
) {
  return prisma.customerModificationRequest.create({
    data: {
      customerId,
      distributorId,
      modificationType: data.modificationType as $Enums.ModificationType,
      requestedBy,
      reason: data.reason || null,
      changes: data.changes ?? Prisma.JsonNull,
    },
  });
}

export async function approveModificationRequest(requestId: string, distributorId: string, reviewedBy: string) {
  const request = await prisma.customerModificationRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new CustomerError('Modification request not found', 404);
  if (request.distributorId !== distributorId) throw new CustomerError('Forbidden', 403);
  if (request.status !== 'pending') throw new CustomerError('Request is not pending', 400);

  return prisma.$transaction(async (tx) => {
    const updated = await tx.customerModificationRequest.update({
      where: { id: requestId },
      data: { status: 'approved', reviewedBy },
    });

    // Apply changes based on modification type
    // Status mirror: stopSupply ↔ status='suspended' / 'active'. Same contract
    // as the direct stopSupply()/resumeSupply() service functions — must stay
    // in lock-step so the approval workflow doesn't leave an inconsistent
    // (status='active', stopSupply=true) state that hides a suspended customer
    // from CustomerSearchInput.
    if (request.modificationType === 'stop_supply') {
      await tx.customer.update({
        where: { id: request.customerId },
        data: { stopSupply: true, status: 'suspended' },
      });
    } else if (request.modificationType === 'resume_supply') {
      await tx.customer.update({
        where: { id: request.customerId },
        data: { stopSupply: false, status: 'active' },
      });
    } else if (request.modificationType === 'update_info' && request.changes) {
      await tx.customer.update({
        where: { id: request.customerId },
        data: request.changes as Prisma.CustomerUpdateInput,
      });
    }

    return updated;
  });
}

export async function rejectModificationRequest(requestId: string, distributorId: string, reviewedBy: string, reason?: string) {
  const request = await prisma.customerModificationRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new CustomerError('Modification request not found', 404);
  if (request.distributorId !== distributorId) throw new CustomerError('Forbidden', 403);
  if (request.status !== 'pending') throw new CustomerError('Request is not pending', 400);

  return prisma.customerModificationRequest.update({
    where: { id: requestId },
    data: { status: 'rejected', reviewedBy, reason: reason || request.reason },
  });
}

export async function getCustomerAuditTrail(customerId: string, distributorId: string) {
  return prisma.customerAuditTrail.findMany({
    where: { customerId, distributorId },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });
}

export async function stopSupply(customerId: string, distributorId: string, performedBy: string) {
  return prisma.$transaction(async (tx) => {
    // status is the canonical field going forward; stopSupply stays as a
    // mirror until a future cleanup pass removes it.
    await tx.customer.update({
      where: { id: customerId },
      data: { stopSupply: true, status: 'suspended' },
    });
    await tx.customerAuditTrail.create({
      data: {
        customerId,
        distributorId,
        performedBy,
        actionType: 'stop_supply',
        fieldName: 'status',
        oldValue: 'active',
        newValue: 'suspended',
      },
    });
    return { message: 'Supply stopped' };
  });
}

export async function resumeSupply(customerId: string, distributorId: string, performedBy: string) {
  return prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: { stopSupply: false, status: 'active' },
    });
    await tx.customerAuditTrail.create({
      data: {
        customerId,
        distributorId,
        performedBy,
        actionType: 'resume_supply',
        fieldName: 'status',
        oldValue: 'suspended',
        newValue: 'active',
      },
    });
    return { message: 'Supply resumed' };
  });
}

/**
 * Group 4 (2026-06-11): setupCustomerBalance now requires `distributorId`
 * and verifies the target customer belongs to the caller's tenant before
 * touching any row. Empirically confirmed in K7 validation:
 *
 *   POST /api/customers/:id/balance-setup
 *
 * with a dist-001 admin token and a dist-002 customer id returned 200 and
 * wrote the row. CVSS-medium IDOR. Fix: tenant-scoped existence check on
 * Customer, return a structured CrossTenantError so the route can map to
 * 403 with CROSS_TENANT_ACCESS instead of leaking via 404.
 */
export class CrossTenantError extends Error {
  constructor(message = 'Customer does not belong to this distributor') {
    super(message);
    this.name = 'CrossTenantError';
  }
}

export async function setupCustomerBalance(
  customerId: string,
  distributorId: string,
  balances: { cylinderTypeId: string; withCustomerQty: number; pendingReturns: number }[]
) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!customer) throw new CrossTenantError();

  // Also pin: every cylinderTypeId in the payload must belong to the
  // same distributor — otherwise a dist-001 admin could attach a
  // dist-002 type's id to one of their own customers.
  if (balances.length > 0) {
    const typeIds = Array.from(new Set(balances.map((b) => b.cylinderTypeId)));
    const types = await prisma.cylinderType.findMany({
      where: { id: { in: typeIds }, distributorId },
      select: { id: true },
    });
    if (types.length !== typeIds.length) {
      throw new CrossTenantError('One or more cylinder types do not belong to this distributor');
    }
  }

  return prisma.$transaction(async (tx) => {
    for (const b of balances) {
      await tx.customerInventoryBalance.upsert({
        where: { customerId_cylinderTypeId: { customerId, cylinderTypeId: b.cylinderTypeId } },
        create: {
          customerId,
          cylinderTypeId: b.cylinderTypeId,
          withCustomerQty: b.withCustomerQty,
          pendingReturns: b.pendingReturns,
        },
        update: {
          withCustomerQty: b.withCustomerQty,
          pendingReturns: b.pendingReturns,
        },
      });
    }
    // Read via `tx` so the just-upserted rows are visible. The old code
    // used the outer `prisma` client and silently returned pre-tx state.
    return tx.customerInventoryBalance.findMany({
      where: { customerId },
      include: { cylinderType: { select: { typeName: true } } },
    });
  });
}

export async function provisionPortalAccess(
  customerId: string,
  distributorId: string,
  data: { email: string; password: string; firstName: string; lastName: string }
) {
  const { hashPassword } = await import('./authService.js');
  const passwordHash = await hashPassword(data.password);

  return prisma.user.create({
    data: {
      email: data.email.toLowerCase(),
      passwordHash,
      firstName: data.firstName,
      lastName: data.lastName,
      role: 'customer',
      distributorId,
      customerId,
      requiresPasswordReset: true,
    },
    select: { id: true, email: true, role: true },
  });
}

// ─── CSV import: customers ──────────────────────────────────────────────────

export type CustomerImportRow = {
  name: string;
  phone: string;
  // 2026-06-11: optional `business_name` column for the legal / billing
  // entity name on B2B customers. Maps to Customer.businessName.
  businessName?: string;
  address?: string;
  // Group 3 (2026-06-11): the CSV template now accepts structured address
  // columns. When provided, they take precedence over the auto-parse of a
  // single `address` field.
  line1?: string;
  line2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  // Group D2 (2026-06-11): optional shipping address columns. Absent →
  // delivery uses the billing address. Present → customer ships to a
  // separate location (chain stores, commercial sites with central
  // billing). No auto-parse fallback: shipping needs an EXPLICIT signal
  // because the legacy `address` field is interpreted as billing-only.
  shippingLine1?: string;
  shippingLine2?: string;
  shippingCity?: string;
  shippingState?: string;
  shippingPincode?: string;
  gstin?: string;
  email?: string;
  creditPeriodDays?: number;
  customerType?: string;
  transportChargePerCylinder?: number;
};

export type CustomerImportResult = {
  // `imported` kept for backward compatibility (Bhargava's existing UI).
  // New consumers should read `created`/`updated` directly.
  imported: number;
  created: number;
  updated: number;
  failures: Array<{ row: number; name?: string; phone?: string; reason: string }>;
  // Group D2 (2026-06-11): soft warnings — the row WAS imported, but
  // something is worth surfacing to the operator. State-name doesn't
  // match the INDIAN_STATE_NAMES list, etc. Empty when nothing flagged.
  warnings: Array<{ row: number; name?: string; message: string }>;
};

/**
 * Group 3 (2026-06-11): tolerate Excel's "scientific notation" mangling of
 * phone numbers. When a 10-digit Indian mobile is opened in Excel and the
 * column auto-formats to "Number", the value lands in the CSV as e.g.
 * `9.88E+09`. parseFloat → round → toString yields the original digits.
 *
 * Also strips whitespace, leading apostrophes (Excel's text-as-number
 * escape), and `+91` country prefixes. Returns the cleaned string or null
 * if the result is empty.
 */
export function normalisePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^'/, ''); // Excel escape apostrophe
  if (!s) return null;
  // Scientific notation: parseFloat → round → string. Only treat as
  // scientific if the input actually contains 'e' / 'E'.
  if (/[eE]/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n) && n > 0) s = String(Math.round(n));
  }
  // Strip +91 / 91- / spaces / hyphens
  s = s.replace(/\s|-/g, '');
  if (s.startsWith('+91')) s = s.slice(3);
  else if (s.startsWith('91') && s.length === 12) s = s.slice(2);
  return s || null;
}

const STATE_NAMES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh',
  'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh', 'Jharkhand', 'Karnataka',
  'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
  'Mizoram', 'Nagaland', 'Odisha', 'Punjab', 'Rajasthan', 'Sikkim',
  'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal',
  // UTs
  'Andaman and Nicobar Islands', 'Chandigarh',
  'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
];

/**
 * Group 3 (2026-06-11): best-effort parse of a concatenated Indian address
 * into structured components. Strategy:
 *   - trailing 6-digit pincode regex (most reliable)
 *   - suffix-match against known state names (case-insensitive)
 *   - remainder → line1 (we don't try to split city out reliably because
 *     the failure modes are too messy without an authoritative list)
 *
 * If parsing fails any step, the unconsumed remainder still lands in
 * line1 so content is never silently dropped.
 */
export function autoParseAddress(raw: string | null | undefined): {
  line1: string | null; city: string | null; state: string | null; pincode: string | null;
} {
  if (!raw || !raw.trim()) return { line1: null, city: null, state: null, pincode: null };
  let rest = raw.trim();

  // Pincode
  let pincode: string | null = null;
  const pinMatch = rest.match(/\b(\d{6})\b\s*$/);
  if (pinMatch) {
    pincode = pinMatch[1];
    rest = rest.slice(0, pinMatch.index).replace(/[,\s]+$/, '');
  }

  // State (case-insensitive suffix match)
  let state: string | null = null;
  for (const s of STATE_NAMES) {
    const re = new RegExp('(?:^|[,\\s])' + s.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&') + '\\s*$', 'i');
    const m = rest.match(re);
    if (m) {
      state = s;
      rest = rest.slice(0, m.index).replace(/[,\s]+$/, '');
      break;
    }
  }

  // City: take the trailing comma-segment if there's a comma in the
  // remainder; otherwise leave city null and put everything in line1.
  let city: string | null = null;
  const commaIdx = rest.lastIndexOf(',');
  if (commaIdx > 0) {
    const tail = rest.slice(commaIdx + 1).trim();
    if (tail) {
      city = tail;
      rest = rest.slice(0, commaIdx).replace(/[,\s]+$/, '');
    }
  }

  const line1 = rest.trim() || null;
  return { line1, city, state, pincode };
}

/**
 * Bulk-create OR update customers from CSV-parsed rows. Each row succeeds
 * or fails independently so a single bad line never aborts the batch.
 *
 * Group 3 (2026-06-11) upsert behavior:
 *   - Match an existing customer by normalised phone first, then by
 *     (distributorId, customerName case-insensitive).
 *   - If matched, UPDATE only the columns whose CSV value is non-empty —
 *     blank CSV columns never overwrite stored data. Safe to re-run the
 *     same file (idempotent for unchanged rows) and to run a "delta"
 *     CSV containing only the customers + fields that need updating.
 *   - If unmatched, CREATE a new customer.
 *
 * Returns `{ created, updated, failures }`. `imported` is kept as
 * `created + updated` for backward compatibility with the existing UI.
 */
export async function importCustomers(
  distributorId: string,
  rows: CustomerImportRow[],
): Promise<CustomerImportResult> {
  const failures: CustomerImportResult['failures'] = [];
  const warnings: CustomerImportResult['warnings'] = [];
  let created = 0;
  let updated = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;

    if (!r.name || !r.name.trim()) {
      failures.push({ row: rowNum, reason: 'name is required' });
      continue;
    }
    const normalisedPhone = normalisePhone(r.phone);
    if (!normalisedPhone) {
      failures.push({ row: rowNum, name: r.name, reason: 'phone is required' });
      continue;
    }
    if (r.gstin && r.gstin.trim() && !GSTIN_REGEX.test(r.gstin.trim())) {
      failures.push({ row: rowNum, name: r.name, phone: normalisedPhone, reason: 'invalid GSTIN format' });
      continue;
    }

    try {
      // Address columns: prefer explicit structured fields, fall back to
      // auto-parsing the legacy single `address` column.
      const hasStructured = !!(r.line1 || r.city || r.state || r.pincode);
      let billingLine1 = r.line1?.trim() || null;
      const billingLine2 = r.line2?.trim() || null;
      let billingCity = r.city?.trim() || null;
      let billingState = r.state?.trim() || null;
      let billingPincode = r.pincode?.trim() || null;
      if (!hasStructured && r.address?.trim()) {
        const parsed = autoParseAddress(r.address);
        billingLine1 = parsed.line1;
        billingCity = parsed.city;
        billingState = parsed.state;
        billingPincode = parsed.pincode;
      } else if (hasStructured && !billingLine1 && r.address?.trim()) {
        // Structured columns present but line1 blank — fall back to the
        // raw `address` value for line1 so content isn't lost.
        billingLine1 = r.address.trim();
      }

      // Group D2 (2026-06-11): shipping address columns. No auto-parse
      // fallback — only the explicit shipping_* columns populate these
      // fields. Blank → leave NULL (delivery flows still fall back to
      // billing through their own logic).
      const shippingLine1 = r.shippingLine1?.trim() || null;
      const shippingLine2 = r.shippingLine2?.trim() || null;
      const shippingCity = r.shippingCity?.trim() || null;
      const shippingState = r.shippingState?.trim() || null;
      const shippingPincode = r.shippingPincode?.trim() || null;

      // Group D2 (2026-06-11): state-name validation. Stores as-is
      // regardless (content is never silently dropped) but pushes a
      // warning so the operator can see which rows look misspelt or
      // outside the 37-state list. Case-insensitive match — "telangana"
      // and "TELANGANA" both pass.
      if (billingState && !STATE_NAMES_LOWER.has(billingState.toLowerCase())) {
        warnings.push({
          row: rowNum,
          name: r.name,
          message: `billing state "${billingState}" is not in the standard 37-state list — stored as-is`,
        });
      }
      if (shippingState && !STATE_NAMES_LOWER.has(shippingState.toLowerCase())) {
        warnings.push({
          row: rowNum,
          name: r.name,
          message: `shipping state "${shippingState}" is not in the standard 37-state list — stored as-is`,
        });
      }

      // Upsert: try phone first (most stable identifier), then name fallback.
      let existing = await prisma.customer.findFirst({
        where: { distributorId, phone: normalisedPhone, deletedAt: null },
        select: { id: true },
      });
      if (!existing) {
        existing = await prisma.customer.findFirst({
          where: {
            distributorId,
            deletedAt: null,
            customerName: { equals: r.name.trim(), mode: 'insensitive' },
          },
          select: { id: true },
        });
      }

      // Group E1 (2026-06-11): if this row will CREATE a new customer
      // AND another existing customer already shares the GSTIN, surface a
      // soft warning. Multi-branch (Vanasthali's KINARA GRAND) is legal;
      // operator just needs visibility. On UPDATE paths the GSTIN is
      // already on the same row, so this check is skipped to avoid
      // self-match noise.
      if (!existing && r.gstin && r.gstin.trim()) {
        const dupGstin = await prisma.customer.findFirst({
          where: { distributorId, gstin: r.gstin.trim(), deletedAt: null },
          select: { customerName: true },
          orderBy: { createdAt: 'asc' },
        });
        if (dupGstin) {
          warnings.push({
            row: rowNum,
            name: r.name,
            message: `GSTIN ${r.gstin.trim()} already exists on "${dupGstin.customerName}" — this customer will be treated as a separate branch`,
          });
        }
      }

      if (existing) {
        // UPDATE — only non-blank CSV columns. Never overwrite stored
        // data with blanks.
        const data: Prisma.CustomerUpdateInput = {};
        if (r.name?.trim()) data.customerName = r.name.trim();
        if (r.phone?.trim()) data.phone = normalisedPhone;
        if (r.gstin?.trim()) {
          data.gstin = r.gstin.trim();
          // Re-derive customerType when GSTIN is supplied.
          data.customerType = 'B2B';
        } else if (r.customerType?.trim()) {
          data.customerType = r.customerType.trim();
        }
        if (r.businessName?.trim()) data.businessName = r.businessName.trim();
        if (r.email?.trim()) data.email = r.email.trim();
        if (typeof r.creditPeriodDays === 'number') data.creditPeriodDays = r.creditPeriodDays;
        if (typeof r.transportChargePerCylinder === 'number') {
          data.transportChargePerCylinder = r.transportChargePerCylinder;
        }
        if (billingLine1) data.billingAddressLine1 = billingLine1;
        if (billingLine2) data.billingAddressLine2 = billingLine2;
        if (billingCity) data.billingCity = billingCity;
        if (billingState) data.billingState = billingState;
        if (billingPincode) data.billingPincode = billingPincode;
        // Group D2 (2026-06-11): only overwrite shipping fields when the
        // CSV provided a non-empty value (same rule as billing).
        if (shippingLine1) data.shippingAddressLine1 = shippingLine1;
        if (shippingLine2) data.shippingAddressLine2 = shippingLine2;
        if (shippingCity) data.shippingCity = shippingCity;
        if (shippingState) data.shippingState = shippingState;
        if (shippingPincode) data.shippingPincode = shippingPincode;
        await prisma.customer.update({ where: { id: existing.id }, data });
        updated += 1;
      } else {
        await prisma.customer.create({
          data: {
            distributorId,
            customerName: r.name.trim(),
            businessName: r.businessName?.trim() || null,
            phone: normalisedPhone,
            gstin: r.gstin?.trim() || null,
            email: r.email?.trim() || null,
            customerType: r.gstin && r.gstin.trim() ? 'B2B' : (r.customerType?.trim() || 'B2C'),
            billingAddressLine1: billingLine1,
            billingAddressLine2: billingLine2,
            billingCity,
            billingState,
            billingPincode,
            shippingAddressLine1: shippingLine1,
            shippingAddressLine2: shippingLine2,
            shippingCity,
            shippingState,
            shippingPincode,
            creditPeriodDays: typeof r.creditPeriodDays === 'number' ? r.creditPeriodDays : 0,
            transportChargePerCylinder: typeof r.transportChargePerCylinder === 'number'
              ? r.transportChargePerCylinder
              : undefined,
          } as Prisma.CustomerUncheckedCreateInput,
        });
        created += 1;
      }
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      failures.push({ row: rowNum, name: r.name, phone: r.phone, reason });
    }
  }

  return { imported: created + updated, created, updated, failures, warnings };
}

// ─── CSV import: empty-cylinder opening balances (Group 4) ────────────────

export type EmptyBalanceImportRow = {
  customerName?: string;
  phone?: string;
  cylinderType: string;
  emptyQuantity: number;
};

export type EmptyBalanceImportResult = {
  imported: number;
  updated: number;
  failures: Array<{ row: number; name?: string; reason: string }>;
};

/**
 * Group 4 (2026-06-11): bulk-import per-customer opening empty cylinder
 * counts so a paper distributor like Vanasthali can seed "who holds how
 * many empties" before going live. Looks up customer by name (case-
 * insensitive) then phone fallback, looks up cylinder type by exact
 * typeName for the distributor, then upserts CustomerInventoryBalance.
 * Idempotent: re-running the same CSV updates in place.
 */
export async function importEmptyBalances(
  distributorId: string,
  rows: EmptyBalanceImportRow[],
): Promise<EmptyBalanceImportResult> {
  const failures: EmptyBalanceImportResult['failures'] = [];
  let imported = 0;
  let updated = 0;

  // Preload distributor's cylinder types by typeName for fast lookup.
  const types = await prisma.cylinderType.findMany({
    where: { distributorId, isActive: true },
    select: { id: true, typeName: true },
  });
  const typeByName = new Map(types.map((t) => [t.typeName.toLowerCase(), t.id]));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;
    const qty = Math.floor(Number(r.emptyQuantity));

    if (!r.cylinderType?.trim()) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'cylinder_type is required' });
      continue;
    }
    if (!Number.isFinite(qty) || qty < 0) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'empty_quantity must be a non-negative integer' });
      continue;
    }

    const cylinderTypeId = typeByName.get(r.cylinderType.trim().toLowerCase());
    if (!cylinderTypeId) {
      failures.push({
        row: rowNum, name: r.customerName,
        reason: `cylinder type "${r.cylinderType}" not found for this distributor`,
      });
      continue;
    }

    let customer: { id: string } | null = null;
    if (r.customerName?.trim()) {
      customer = await prisma.customer.findFirst({
        where: {
          distributorId, deletedAt: null,
          customerName: { equals: r.customerName.trim(), mode: 'insensitive' },
        },
        select: { id: true },
      });
    }
    if (!customer && r.phone) {
      const phone = normalisePhone(r.phone);
      if (phone) {
        customer = await prisma.customer.findFirst({
          where: { distributorId, deletedAt: null, phone },
          select: { id: true },
        });
      }
    }
    if (!customer) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'customer not found by name or phone' });
      continue;
    }

    try {
      const existing = await prisma.customerInventoryBalance.findUnique({
        where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId } },
        select: { id: true },
      });
      await prisma.customerInventoryBalance.upsert({
        where: { customerId_cylinderTypeId: { customerId: customer.id, cylinderTypeId } },
        create: {
          customerId: customer.id, cylinderTypeId,
          withCustomerQty: qty, pendingReturns: 0,
        },
        update: { withCustomerQty: qty },
      });
      if (existing) updated += 1; else imported += 1;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      failures.push({ row: rowNum, name: r.customerName, reason });
    }
  }

  return { imported, updated, failures };
}

// ─── CSV import: opening balances ──────────────────────────────────────────

export type OpeningBalanceImportRow = {
  customerName?: string;
  phone?: string;
  openingBalance: number;
  notes?: string;
  // Group 3 (2026-06-11): per-row as-of-date (YYYY-MM-DD). When supplied,
  // becomes the invoice's issueDate / dueDate / ledger entryDate so the
  // statement shows the balance as carried forward from that date — not
  // today. Distributor.goLiveDate (Group 5) takes precedence if set.
  asOfDate?: string;
};

export type OpeningBalanceImportResult = {
  imported: number;
  // Group 3: skipped customers when an OB already exists and replaceExisting=false.
  skipped: number;
  skippedCustomers: string[];
  failures: Array<{ row: number; name?: string; reason: string }>;
};

/**
 * Bulk-import customer opening balances. For each row:
 *   - Resolve customer by name (case-insensitive) or fall back to phone.
 *   - Skip if balance ≤ 0.
 *   - Create a synthetic overdue Invoice (isOpeningBalance=true, no items,
 *     no GST, due today) so the balance appears in Collections,
 *     overdue-call-list, and customer portal invoices automatically.
 *   - Record a CustomerLedgerEntry debit referencing the invoice for the
 *     account ledger.
 */
export async function importOpeningBalances(
  distributorId: string,
  userId: string,
  rows: OpeningBalanceImportRow[],
  opts: { replaceExisting?: boolean } = {},
): Promise<OpeningBalanceImportResult> {
  const failures: OpeningBalanceImportResult['failures'] = [];
  const skippedCustomers: string[] = [];
  let imported = 0;
  let skipped = 0;
  const today = new Date();
  const todayIso = today.toISOString().split('T')[0];
  const replace = opts.replaceExisting === true;

  // Group 5 (2026-06-11): when the distributor has a goLiveDate set, OB
  // invoices get backdated to goLiveDate - 1 day so they sit chronologically
  // BEFORE the first live transaction. Per-row asOfDate still wins if both
  // are present (operator override). Otherwise: today.
  const dist = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { goLiveDate: true },
  });
  const goLiveMinus1 = dist?.goLiveDate
    ? new Date(new Date(dist.goLiveDate).getTime() - 86400000)
    : null;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;
    const amount = Number(r.openingBalance);

    if (!Number.isFinite(amount) || amount < 0) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'opening_balance must be a non-negative number' });
      continue;
    }
    if (amount === 0) continue; // nothing to import

    let customer: { id: string; customerName: string } | null = null;
    if (r.customerName && r.customerName.trim()) {
      customer = await prisma.customer.findFirst({
        where: {
          distributorId,
          deletedAt: null,
          customerName: { equals: r.customerName.trim(), mode: 'insensitive' },
        },
        select: { id: true, customerName: true },
      });
    }
    if (!customer && r.phone) {
      const phone = normalisePhone(r.phone);
      if (phone) {
        customer = await prisma.customer.findFirst({
          where: { distributorId, deletedAt: null, phone },
          select: { id: true, customerName: true },
        });
      }
    }
    if (!customer) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'customer not found by name or phone' });
      continue;
    }

    // Group 3 (2026-06-11): idempotency guard.
    // If an OB invoice already exists for this customer and replace is OFF,
    // skip — the operator can re-run the same CSV without doubling balances.
    const existingOb = await prisma.invoice.findFirst({
      where: { distributorId, customerId: customer.id, isOpeningBalance: true, deletedAt: null },
      select: { id: true },
    });
    if (existingOb && !replace) {
      skipped += 1;
      skippedCustomers.push(customer.customerName);
      continue;
    }

    // Pick the effective entry/issue/due date for this row.
    // Precedence: per-row asOfDate > distributor.goLiveDate−1 > today.
    let entryDate = today;
    if (r.asOfDate && /^\d{4}-\d{2}-\d{2}$/.test(r.asOfDate)) {
      entryDate = new Date(r.asOfDate);
    } else if (goLiveMinus1) {
      entryDate = goLiveMinus1;
    }
    const entryDateIso = entryDate.toISOString().split('T')[0];

    try {
      await prisma.$transaction(async (tx) => {
        if (existingOb && replace) {
          // Clean delete of the prior OB invoice + its ledger entry. We
          // hard-delete because the OB invoice was a synthetic record (no
          // GST exchange, no order). Hard-delete keeps the ledger clean
          // when the operator is correcting a typo.
          await tx.customerLedgerEntry.deleteMany({
            where: { distributorId, customerId: customer!.id, invoiceId: existingOb.id },
          });
          await tx.invoice.delete({ where: { id: existingOb.id } });
        }

        const invoiceNumber = `OB-${customer!.id.slice(0, 8)}-${entryDateIso}-${Math.random().toString(36).slice(2, 6)}`;
        const invoice = await tx.invoice.create({
          data: {
            invoiceNumber,
            distributorId,
            customerId: customer!.id,
            issueDate: entryDate,
            dueDate: entryDate,
            totalAmount: amount,
            outstandingAmount: amount,
            amountPaid: 0,
            status: 'overdue',
            isOpeningBalance: true,
            notes: r.notes?.trim() || `Opening balance imported on ${todayIso}`,
            issuedBy: userId,
          },
        });
        await tx.customerLedgerEntry.create({
          data: {
            distributorId,
            customerId: customer!.id,
            entryType: 'invoice_entry',
            referenceId: invoice.id,
            invoiceId: invoice.id,
            amountDelta: amount,
            narration: r.notes?.trim()
              ? `Opening Balance b/f — ${r.notes.trim()}`
              : 'Opening Balance b/f',
            entryDate,
            createdBy: userId,
          },
        });
      });
      imported += 1;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      failures.push({ row: rowNum, name: r.customerName, reason });
    }
  }

  return { imported, skipped, skippedCustomers, failures };
}

// ─── Onboarding progress ───────────────────────────────────────────────────

export async function getOnboardingProgress(distributorId: string) {
  const [
    cylinderTypeCount,
    cylinderPriceCount,
    driverCount,
    // Group 6 (2026-06-11): count drivers that ALSO have a User login.
    // A driver row without a User can't actually sign in to the mobile app
    // — the old check was misleading.
    driverWithLoginCount,
    customerCount,
    initialBalanceCount,
    openingBalanceImportCount,
    emptyBalanceCount,
    gstCredentialCount,
    orderCount,
    deliveredOrderCount,
    inventoryEventCount,
    distributor,
    dismissedSetting,
  ] = await Promise.all([
    prisma.cylinderType.count({ where: { distributorId, isActive: true } }),
    prisma.cylinderPrice.count({ where: { distributorId } }),
    prisma.driver.count({ where: { distributorId, deletedAt: null } }),
    prisma.user.count({
      where: { distributorId, role: 'driver', status: 'active', deletedAt: null },
    }),
    prisma.customer.count({ where: { distributorId, deletedAt: null } }),
    prisma.inventoryEvent.count({ where: { distributorId, eventType: 'initial_balance' } }),
    prisma.invoice.count({
      where: { distributorId, deletedAt: null, isOpeningBalance: true },
    }),
    prisma.customerInventoryBalance.count({
      where: { customer: { distributorId, deletedAt: null } },
    }),
    prisma.gstCredential.count({ where: { distributorId } }),
    prisma.order.count({ where: { distributorId, deletedAt: null } }),
    prisma.order.count({
      where: { distributorId, deletedAt: null, status: { in: ['delivered', 'modified_delivered'] } },
    }),
    prisma.inventoryEvent.count({ where: { distributorId } }),
    prisma.distributor.findUnique({
      where: { id: distributorId },
      select: { docCode: true, goLiveDate: true, godownAddress: true },
    }),
    prisma.distributorSetting.findUnique({
      where: { distributorId_settingKey: { distributorId, settingKey: 'dismissedOnboarding' } },
    }),
  ]);

  const dismissed = dismissedSetting?.settingValue === true;
  const docCodeSet = !!distributor?.docCode?.trim();
  const goLiveDateSet = !!distributor?.goLiveDate;
  const godownAddressSet = !!distributor?.godownAddress?.trim();

  // Group 6 (2026-06-11): the checklist now mirrors what a paper-
  // distributor like Vanasthali actually needs on Day-0. Several previous
  // checks were misleading:
  //   - "cylinder_types" was green when types existed even without prices,
  //     so a distributor could "complete" the step but no order could be
  //     placed because pricing wasn't set.
  //   - "drivers" counted Driver rows, but a Driver without a User has no
  //     way to sign into the mobile app — the step was passing while
  //     drivers couldn't actually deliver.
  //   - "opening_empties", "doc_code", "go_live_date" were not surfaced at
  //     all — gaps confirmed in the K-audit.
  const steps = [
    {
      key: 'cylinder_types',
      label: 'Add cylinder types and prices',
      done: cylinderTypeCount > 0 && cylinderPriceCount > 0,
      link: '/app/settings?tab=cylinders',
    },
    {
      key: 'drivers',
      label: 'Add drivers and create their logins',
      done: driverCount > 0 && driverWithLoginCount > 0,
      link: '/app/fleet',
    },
    { key: 'customers', label: 'Add your customers', done: customerCount > 0, link: '/app/customers' },
    { key: 'opening_stock', label: 'Enter opening stock balance', done: initialBalanceCount > 0, link: '/app/inventory' },
    { key: 'opening_balances', label: 'Import customer opening balances (CSV)', done: openingBalanceImportCount > 0, link: '/app/settings?tab=onboarding' },
    { key: 'opening_empties', label: 'Import opening empty cylinders per customer (CSV)', done: emptyBalanceCount > 0, link: '/app/settings?tab=onboarding' },
    { key: 'doc_code', label: 'Set your 3-letter invoice code', done: docCodeSet, link: '/app/settings' },
    { key: 'godown_address', label: 'Set your godown / warehouse address', done: godownAddressSet, link: '/app/settings' },
    { key: 'go_live_date', label: 'Go-live date (set by platform admin)', done: goLiveDateSet, optional: true, link: '/app/settings' },
    { key: 'test_order', label: 'Complete at least one delivery end-to-end', done: deliveredOrderCount > 0, optional: true, link: '/app/orders' },
    { key: 'gst', label: 'Configure GST (optional)', done: gstCredentialCount > 0, optional: true, link: '/app/settings?tab=gst' },
  ];

  // "newly created" heuristic from the spec
  const isNewlyCreated = orderCount === 0 && customerCount < 5 && inventoryEventCount === 0;
  const requiredSteps = steps.filter((s) => !s.optional);
  const requiredDoneCount = requiredSteps.filter((s) => s.done).length;
  const completedRequired = requiredDoneCount === requiredSteps.length;

  return {
    steps,
    completedRequired,
    requiredDoneCount,
    requiredTotal: requiredSteps.length,
    dismissed,
    show: !dismissed && (isNewlyCreated || !completedRequired),
  };
}

export async function dismissOnboarding(distributorId: string) {
  return prisma.distributorSetting.upsert({
    where: { distributorId_settingKey: { distributorId, settingKey: 'dismissedOnboarding' } },
    create: { distributorId, settingKey: 'dismissedOnboarding', settingValue: true },
    update: { settingValue: true },
  });
}

export class CustomerError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'CustomerError';
  }
}
