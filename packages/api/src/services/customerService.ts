import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { GSTIN_REGEX } from '@gaslink/shared';

const customerInclude = {
  contacts: true,
  cylinderDiscounts: {
    include: { cylinderType: { select: { typeName: true } } },
  },
} satisfies Prisma.CustomerInclude;

export async function listCustomers(
  distributorId: string,
  filters: { status?: string; search?: string; page?: number; pageSize?: number }
) {
  const where: Prisma.CustomerWhereInput = {
    distributorId,
    deletedAt: null,
  };
  if (filters.status) where.status = filters.status as any;
  if (filters.search) {
    where.OR = [
      { customerName: { contains: filters.search, mode: 'insensitive' } },
      { businessName: { contains: filters.search, mode: 'insensitive' } },
      { phone: { contains: filters.search } },
      { gstin: { contains: filters.search, mode: 'insensitive' } },
    ];
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

export async function getCustomerById(id: string, distributorId?: string) {
  const where: Prisma.CustomerWhereInput = { id, deletedAt: null };
  if (distributorId) where.distributorId = distributorId;
  return prisma.customer.findFirst({
    where,
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
    contacts?: { name: string; phone: string; email?: string; isPrimary?: boolean }[];
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
      contacts: data.contacts && data.contacts.length > 0
        ? { create: data.contacts.map(c => ({ name: c.name, phone: c.phone, email: c.email || null, isPrimary: c.isPrimary ?? false })) }
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
  data: Record<string, any>,
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
    const trackFields = [
      'customerName', 'businessName', 'gstin', 'phone', 'email',
      'billingAddressLine1', 'billingCity', 'billingState', 'billingPincode',
      'shippingAddressLine1', 'shippingCity', 'shippingState', 'shippingPincode',
      'creditPeriodDays',
    ];
    for (const field of trackFields) {
      if (data[field] !== undefined && data[field] !== (existing as any)[field]) {
        await tx.customerAuditTrail.create({
          data: {
            customerId: id,
            distributorId,
            performedBy,
            actionType: 'field_update',
            fieldName: field,
            oldValue: (existing as any)[field],
            newValue: data[field],
          },
        });
      }
    }

    // Handle contacts replacement
    if (data.contacts !== undefined) {
      await tx.customerContact.deleteMany({ where: { customerId: id } });
      if (data.contacts.length > 0) {
        await tx.customerContact.createMany({
          data: data.contacts.map((c: any) => ({
            customerId: id,
            name: c.name,
            phone: c.phone,
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
          data: data.cylinderDiscounts.map((d: any) => ({
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
  data: { modificationType: string; reason?: string; changes?: any }
) {
  return prisma.customerModificationRequest.create({
    data: {
      customerId,
      distributorId,
      modificationType: data.modificationType as any,
      requestedBy,
      reason: data.reason || null,
      changes: data.changes || null,
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
        data: request.changes as any,
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

export class CustomerError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'CustomerError';
  }
}
