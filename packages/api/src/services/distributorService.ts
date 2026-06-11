import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

const distributorSelect = {
  id: true,
  businessName: true,
  legalName: true,
  // Group L2 (2026-06-11): docCode is read by the create/edit form
  // and by downstream invoice numbering.
  docCode: true,
  gstin: true,
  address: true,
  city: true,
  state: true,
  pincode: true,
  phone: true,
  email: true,
  status: true,
  gstMode: true,
  providerCodes: true,
  subscriptionPlan: true,
  billingTier: true,
  billingSuspended: true,
  gaslinkBillingEnabled: true,
  gaslinkBillingStartDate: true,
  latitude: true,
  longitude: true,
  godownAddress: true,
  godownCity: true,
  godownState: true,
  godownPincode: true,
  godownLatitude: true,
  godownLongitude: true,
  officeAddress: true,
  officeCity: true,
  officeState: true,
  officePincode: true,
  // Group A: surfaced to the GST Activation page so the sandbox option is
  // disabled in the UI when the tenant is not allowlisted.
  isTestTenant: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.DistributorSelect;

export async function listDistributors() {
  return prisma.distributor.findMany({
    where: { deletedAt: null },
    select: distributorSelect,
    orderBy: { createdAt: 'desc' },
  });
}

export async function getDistributorById(id: string) {
  return prisma.distributor.findFirst({
    where: { id, deletedAt: null },
    select: {
      ...distributorSelect,
      settings: true,
    },
  });
}

export class DistributorError extends Error {
  constructor(message: string, public statusCode: number, public code?: string) {
    super(message);
    this.name = 'DistributorError';
  }
}

// Group L2 (2026-06-11): docCode case-insensitive uniqueness check. The
// underlying column has a unique index (schema.prisma:341) but Postgres
// unique is case-sensitive, and the Zod regex already forces uppercase,
// so we still do a defensive case-insensitive check here so a future
// schema relaxation doesn't silently allow collisions. excludeId lets
// the update path skip the row being edited.
async function assertDocCodeUnique(docCode: string, excludeId?: string) {
  const upper = docCode.trim().toUpperCase();
  if (!upper) return;
  const existing = await prisma.distributor.findFirst({
    where: {
      docCode: { equals: upper, mode: 'insensitive' },
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, businessName: true },
  });
  if (existing) {
    throw new DistributorError(
      `This document code is already in use by another distributor (${existing.businessName}).`,
      409,
      'DOC_CODE_CONFLICT',
    );
  }
}

export async function createDistributor(data: {
  businessName: string;
  legalName: string;
  docCode?: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  providerCodes?: string[];
  latitude?: number;
  longitude?: number;
  godownAddress?: string;
  godownCity?: string;
  godownState?: string;
  godownPincode?: string;
  godownLatitude?: number;
  godownLongitude?: number;
  officeAddress?: string;
  officeCity?: string;
  officeState?: string;
  officePincode?: string;
}) {
  const docCode = data.docCode?.trim().toUpperCase() || null;
  if (docCode) await assertDocCodeUnique(docCode);

  return prisma.distributor.create({
    data: {
      businessName: data.businessName,
      legalName: data.legalName,
      docCode,
      gstin: data.gstin || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      pincode: data.pincode || null,
      phone: data.phone || null,
      email: data.email || null,
      providerCodes: data.providerCodes || [],
      latitude: data.latitude ?? null,
      longitude: data.longitude ?? null,
      godownAddress: data.godownAddress || null,
      godownCity: data.godownCity || null,
      godownState: data.godownState || null,
      godownPincode: data.godownPincode || null,
      godownLatitude: data.godownLatitude ?? null,
      godownLongitude: data.godownLongitude ?? null,
      officeAddress: data.officeAddress || null,
      officeCity: data.officeCity || null,
      officeState: data.officeState || null,
      officePincode: data.officePincode || null,
    },
    select: distributorSelect,
  });
}

export async function updateDistributor(id: string, data: Partial<{
  businessName: string;
  legalName: string;
  docCode: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  providerCodes: string[];
  gstMode: string;
  status: string;
  subscriptionPlan: string | null;
  billingTier: string | null;
  gaslinkBillingEnabled: boolean;
  godownAddress: string;
  godownCity: string;
  godownState: string;
  godownPincode: string;
  godownLatitude: number;
  godownLongitude: number;
  officeAddress: string;
  officeCity: string;
  officeState: string;
  officePincode: string;
  latitude: number;
  longitude: number;
  // Group L5 (2026-06-11): see note in routes/distributors.ts PUT /:id.
  isTestTenant: boolean;
}>) {
  // Group L2 (2026-06-11): normalise + uniqueness-check docCode before
  // hitting the DB so the 409 reply happens in this service, not as a
  // raw Postgres unique-constraint violation surfacing through Prisma.
  const writeData: Record<string, unknown> = { ...data };
  if (typeof data.docCode === 'string') {
    const upper = data.docCode.trim().toUpperCase();
    if (upper) {
      await assertDocCodeUnique(upper, id);
      writeData.docCode = upper;
    } else {
      writeData.docCode = null;
    }
  }
  return prisma.distributor.update({
    where: { id },
    data: writeData as Prisma.DistributorUpdateInput,
    select: distributorSelect,
  });
}

export async function getDistributorSettings(distributorId: string) {
  return prisma.distributorSetting.findMany({
    where: { distributorId },
    orderBy: { settingKey: 'asc' },
  });
}
