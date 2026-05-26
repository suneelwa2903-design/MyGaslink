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
}>) {
  return prisma.distributor.update({
    where: { id },
    data: data as Prisma.DistributorUpdateInput,
    select: distributorSelect,
  });
}

export async function getDistributorSettings(distributorId: string) {
  return prisma.distributorSetting.findMany({
    where: { distributorId },
    orderBy: { settingKey: 'asc' },
  });
}
