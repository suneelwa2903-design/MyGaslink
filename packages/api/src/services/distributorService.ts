import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';

const distributorSelect = {
  id: true,
  businessName: true,
  legalName: true,
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

export async function createDistributor(data: {
  businessName: string;
  legalName: string;
  gstin?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  phone?: string;
  email?: string;
  providerCodes?: string[];
}) {
  return prisma.distributor.create({
    data: {
      businessName: data.businessName,
      legalName: data.legalName,
      gstin: data.gstin || null,
      address: data.address || null,
      city: data.city || null,
      state: data.state || null,
      pincode: data.pincode || null,
      phone: data.phone || null,
      email: data.email || null,
      providerCodes: data.providerCodes || [],
    },
    select: distributorSelect,
  });
}

export async function updateDistributor(id: string, data: Partial<{
  businessName: string;
  legalName: string;
  gstin: string;
  address: string;
  city: string;
  state: string;
  pincode: string;
  phone: string;
  email: string;
  providerCodes: string[];
}>) {
  return prisma.distributor.update({
    where: { id },
    data,
    select: distributorSelect,
  });
}

export async function getDistributorSettings(distributorId: string) {
  return prisma.distributorSetting.findMany({
    where: { distributorId },
    orderBy: { settingKey: 'asc' },
  });
}
