import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import type { $Enums } from '@prisma/client';
import { GSTIN_REGEX } from '@gaslink/shared';

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
  contacts?: Array<{ name: string; phone?: string; email?: string | null; isPrimary?: boolean }>;
  cylinderDiscounts?: Array<{ cylinderTypeId: string; discountPerUnit: number }>;
}

const customerInclude = {
  contacts: true,
  cylinderDiscounts: {
    include: { cylinderType: { select: { typeName: true } } },
  },
} satisfies Prisma.CustomerInclude;

export async function listCustomers(
  distributorId: string,
  filters: { status?: string; search?: string; page?: number; pageSize?: number; unlinked?: string }
) {
  const where: Prisma.CustomerWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.status) where.status = filters.status as $Enums.CustomerStatus;
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
  return prisma.customer.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: {
      ...customerInclude,
      inventoryBalances: {
        include: { cylinderType: { select: { typeName: true } } },
      },
    },
  });
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
    contacts?: { name: string; phone?: string; email?: string; isPrimary?: boolean }[];
    cylinderDiscounts?: { cylinderTypeId: string; discountPerUnit: number }[];
  }
) {
  // Validate GSTIN format if provided
  if (data.gstin && data.gstin.length > 0) {
    if (!GSTIN_REGEX.test(data.gstin)) {
      throw new CustomerError('Invalid GSTIN format', 400);
    }
    // Check uniqueness within distributor
    const existing = await prisma.customer.findFirst({
      where: { distributorId, gstin: data.gstin, deletedAt: null },
    });
    if (existing) {
      throw new CustomerError('A customer with this GSTIN already exists', 409);
    }
  }

  const customerType = data.gstin && data.gstin.length > 0 ? 'B2B' : 'B2C';

  return prisma.customer.create({
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
      contacts: data.contacts && data.contacts.length > 0
        ? { create: data.contacts.map(c => ({ name: c.name, phone: c.phone || '', email: c.email || null, isPrimary: c.isPrimary ?? false })) }
        : undefined,
      cylinderDiscounts: data.cylinderDiscounts && data.cylinderDiscounts.length > 0
        ? { create: data.cylinderDiscounts.map(d => ({ cylinderTypeId: d.cylinderTypeId, discountPerUnit: d.discountPerUnit })) }
        : undefined,
    },
    include: customerInclude,
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

  // Validate GSTIN if changing
  if (data.gstin && data.gstin !== existing.gstin) {
    if (!GSTIN_REGEX.test(data.gstin)) {
      throw new CustomerError('Invalid GSTIN format', 400);
    }
    const dup = await prisma.customer.findFirst({
      where: { distributorId, gstin: data.gstin, deletedAt: null, id: { not: id } },
    });
    if (dup) throw new CustomerError('A customer with this GSTIN already exists', 409);
  }

  return prisma.$transaction(async (tx) => {
    // Log audit trail for changed fields
    const trackFields: (keyof CustomerUpdateData)[] = [
      'customerName', 'businessName', 'gstin', 'phone', 'email', 'transportChargePerCylinder',
      'billingAddressLine1', 'billingCity', 'billingState', 'billingPincode',
      'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPincode',
      'creditPeriodDays',
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

    const updated = await tx.customer.update({
      where: { id },
      data: updateData,
      include: customerInclude,
    });
    return updated;
  });
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
    if (request.modificationType === 'stop_supply') {
      await tx.customer.update({
        where: { id: request.customerId },
        data: { stopSupply: true },
      });
    } else if (request.modificationType === 'resume_supply') {
      await tx.customer.update({
        where: { id: request.customerId },
        data: { stopSupply: false },
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
    await tx.customer.update({
      where: { id: customerId },
      data: { stopSupply: true },
    });
    await tx.customerAuditTrail.create({
      data: {
        customerId,
        distributorId,
        performedBy,
        actionType: 'stop_supply',
        fieldName: 'stopSupply',
        oldValue: false,
        newValue: true,
      },
    });
    return { message: 'Supply stopped' };
  });
}

export async function resumeSupply(customerId: string, distributorId: string, performedBy: string) {
  return prisma.$transaction(async (tx) => {
    await tx.customer.update({
      where: { id: customerId },
      data: { stopSupply: false },
    });
    await tx.customerAuditTrail.create({
      data: {
        customerId,
        distributorId,
        performedBy,
        actionType: 'resume_supply',
        fieldName: 'stopSupply',
        oldValue: true,
        newValue: false,
      },
    });
    return { message: 'Supply resumed' };
  });
}

export async function setupCustomerBalance(
  customerId: string,
  balances: { cylinderTypeId: string; withCustomerQty: number; pendingReturns: number }[]
) {
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
    return prisma.customerInventoryBalance.findMany({
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
  address?: string;
  gstin?: string;
  creditPeriodDays?: number;
  customerType?: string;
};

export type CustomerImportResult = {
  imported: number;
  failures: Array<{ row: number; name?: string; phone?: string; reason: string }>;
};

/**
 * Bulk-create customers from CSV-parsed rows. Each row succeeds or fails
 * independently so a single bad line never aborts the batch. Returns counts +
 * per-row failures the UI can render.
 */
export async function importCustomers(
  distributorId: string,
  rows: CustomerImportRow[],
): Promise<CustomerImportResult> {
  const failures: CustomerImportResult['failures'] = [];
  let imported = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;

    if (!r.name || !r.name.trim()) {
      failures.push({ row: rowNum, reason: 'name is required' });
      continue;
    }
    if (!r.phone || !r.phone.trim()) {
      failures.push({ row: rowNum, name: r.name, reason: 'phone is required' });
      continue;
    }
    if (r.gstin && r.gstin.trim() && !GSTIN_REGEX.test(r.gstin.trim())) {
      failures.push({ row: rowNum, name: r.name, phone: r.phone, reason: 'invalid GSTIN format' });
      continue;
    }

    try {
      const dupPhone = await prisma.customer.findFirst({
        where: { distributorId, phone: r.phone.trim(), deletedAt: null },
        select: { id: true },
      });
      if (dupPhone) {
        failures.push({ row: rowNum, name: r.name, phone: r.phone, reason: 'duplicate phone — customer already exists' });
        continue;
      }

      await prisma.customer.create({
        data: {
          distributorId,
          customerName: r.name.trim(),
          phone: r.phone.trim(),
          gstin: r.gstin?.trim() || null,
          customerType: r.gstin && r.gstin.trim() ? 'B2B' : (r.customerType?.trim() || 'B2C'),
          billingAddressLine1: r.address?.trim() || null,
          creditPeriodDays: typeof r.creditPeriodDays === 'number' ? r.creditPeriodDays : 0,
        },
      });
      imported += 1;
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      failures.push({ row: rowNum, name: r.name, phone: r.phone, reason });
    }
  }

  return { imported, failures };
}

// ─── CSV import: opening balances ──────────────────────────────────────────

export type OpeningBalanceImportRow = {
  customerName?: string;
  phone?: string;
  openingBalance: number;
  notes?: string;
};

export type OpeningBalanceImportResult = {
  imported: number;
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
): Promise<OpeningBalanceImportResult> {
  const failures: OpeningBalanceImportResult['failures'] = [];
  let imported = 0;
  const today = new Date();
  const todayIso = today.toISOString().split('T')[0];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 1;
    const amount = Number(r.openingBalance);

    if (!Number.isFinite(amount) || amount < 0) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'opening_balance must be a non-negative number' });
      continue;
    }
    if (amount === 0) continue; // nothing to import

    let customer: { id: string } | null = null;
    if (r.customerName && r.customerName.trim()) {
      customer = await prisma.customer.findFirst({
        where: {
          distributorId,
          deletedAt: null,
          customerName: { equals: r.customerName.trim(), mode: 'insensitive' },
        },
        select: { id: true },
      });
    }
    if (!customer && r.phone && r.phone.trim()) {
      customer = await prisma.customer.findFirst({
        where: { distributorId, deletedAt: null, phone: r.phone.trim() },
        select: { id: true },
      });
    }
    if (!customer) {
      failures.push({ row: rowNum, name: r.customerName, reason: 'customer not found by name or phone' });
      continue;
    }

    try {
      await prisma.$transaction(async (tx) => {
        // Use a per-call random suffix so the per-customer slug stays unique
        // even if a customer is imported more than once across batches.
        const invoiceNumber = `OB-${customer!.id.slice(0, 8)}-${todayIso}-${Math.random().toString(36).slice(2, 6)}`;
        const invoice = await tx.invoice.create({
          data: {
            invoiceNumber,
            distributorId,
            customerId: customer!.id,
            issueDate: today,
            dueDate: today, // overdue from day 1 by design
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
            narration: `Opening balance import — ${r.notes?.trim() || 'imported'}`,
            entryDate: today,
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

  return { imported, failures };
}

// ─── Onboarding progress ───────────────────────────────────────────────────

export async function getOnboardingProgress(distributorId: string) {
  const [
    cylinderTypeCount,
    driverCount,
    customerCount,
    initialBalanceCount,
    openingBalanceImportCount,
    gstCredentialCount,
    orderCount,
    inventoryEventCount,
    dismissedSetting,
  ] = await Promise.all([
    prisma.cylinderType.count({ where: { distributorId, isActive: true } }),
    prisma.driver.count({ where: { distributorId, deletedAt: null } }),
    prisma.customer.count({ where: { distributorId, deletedAt: null } }),
    prisma.inventoryEvent.count({ where: { distributorId, eventType: 'initial_balance' } }),
    prisma.invoice.count({
      where: { distributorId, deletedAt: null, isOpeningBalance: true },
    }),
    prisma.gstCredential.count({ where: { distributorId } }),
    prisma.order.count({ where: { distributorId, deletedAt: null } }),
    prisma.inventoryEvent.count({ where: { distributorId } }),
    prisma.distributorSetting.findUnique({
      where: { distributorId_settingKey: { distributorId, settingKey: 'dismissedOnboarding' } },
    }),
  ]);

  const dismissed = dismissedSetting?.settingValue === true;

  const steps = [
    { key: 'cylinder_types', label: 'Add cylinder types and prices', done: cylinderTypeCount > 0, link: '/app/settings?tab=cylinders' },
    { key: 'drivers', label: 'Add your drivers and vehicles', done: driverCount > 0, link: '/app/fleet' },
    { key: 'customers', label: 'Add your customers', done: customerCount > 0, link: '/app/customers' },
    { key: 'opening_stock', label: 'Enter opening stock balance', done: initialBalanceCount > 0, link: '/app/inventory' },
    { key: 'opening_balances', label: 'Import customer opening balances (CSV)', done: openingBalanceImportCount > 0, link: '/app/settings?tab=onboarding' },
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
