import { prisma } from '../lib/prisma.js';

export async function getSettings(distributorId: string) {
  return prisma.distributorSetting.findMany({
    where: { distributorId },
    orderBy: { settingKey: 'asc' },
  });
}

export async function getSetting(distributorId: string, key: string) {
  return prisma.distributorSetting.findUnique({
    where: { distributorId_settingKey: { distributorId, settingKey: key } },
  });
}

export async function upsertSetting(distributorId: string, key: string, value: any) {
  return prisma.distributorSetting.upsert({
    where: { distributorId_settingKey: { distributorId, settingKey: key } },
    create: { distributorId, settingKey: key, settingValue: value },
    update: { settingValue: value },
  });
}

export async function deleteSetting(distributorId: string, key: string) {
  return prisma.distributorSetting.deleteMany({
    where: { distributorId, settingKey: key },
  });
}

export async function getGstCredentials(distributorId: string, scope?: 'einvoice' | 'ewaybill') {
  if (scope) {
    return prisma.gstCredential.findUnique({
      where: { distributorId_scope: { distributorId, scope } },
      select: {
        id: true, clientId: true, username: true, gstin: true, scope: true,
        email: true, isValid: true, lastValidated: true,
      },
    });
  }
  // Return all scopes for this distributor
  return prisma.gstCredential.findMany({
    where: { distributorId },
    select: {
      id: true, clientId: true, username: true, gstin: true, scope: true,
      email: true, isValid: true, lastValidated: true,
    },
  });
}

export async function upsertGstCredentials(
  distributorId: string,
  data: { clientId: string; clientSecret: string; username: string; gstin: string; password?: string; email?: string; scope?: 'einvoice' | 'ewaybill' }
) {
  const scope = data.scope || 'einvoice';
  const { scope: _scope, ...rest } = data;
  return prisma.gstCredential.upsert({
    where: { distributorId_scope: { distributorId, scope } },
    create: { distributorId, scope, ...rest },
    update: { ...rest, isValid: false },
  });
}

// WI-042: roll back isValid when a Test & Save call's authenticate()
// step fails after the upsert. Keeps the credential row but flags it
// so getGstCredentials surfaces the correct status to the UI.
export async function markGstCredentialsInvalid(
  distributorId: string,
  scope: 'einvoice' | 'ewaybill',
) {
  return prisma.gstCredential.updateMany({
    where: { distributorId, scope },
    data: { isValid: false, lastValidated: new Date() },
  });
}

/**
 * Used by Test Connection (WI-054) to ping NIC via a read-only
 * GSTNDETAILS lookup on the distributor's own GSTIN. Returns null if
 * the distributor has no GSTIN configured (cannot probe).
 */
export async function getDistributorGstin(distributorId: string): Promise<string | null> {
  const d = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstin: true },
  });
  return d?.gstin ?? null;
}

export async function updateGstMode(distributorId: string, mode: string) {
  return prisma.distributor.update({
    where: { id: distributorId },
    data: { gstMode: mode as any },
    select: { id: true, gstMode: true },
  });
}

export async function getThresholds(distributorId: string) {
  return prisma.cylinderThreshold.findMany({
    where: { distributorId },
    include: { cylinderType: { select: { typeName: true } } },
  });
}

export async function getApprovalWorkflows(distributorId: string) {
  const setting = await prisma.distributorSetting.findUnique({
    where: { distributorId_settingKey: { distributorId, settingKey: 'approval_workflows' } },
  });
  return setting?.settingValue || [];
}

export async function updateApprovalWorkflows(distributorId: string, workflows: any[]) {
  return prisma.distributorSetting.upsert({
    where: { distributorId_settingKey: { distributorId, settingKey: 'approval_workflows' } },
    create: { distributorId, settingKey: 'approval_workflows', settingValue: workflows as any },
    update: { settingValue: workflows as any },
  });
}

export async function listLicenses(distributorId: string) {
  const licenses = await prisma.license.findMany({
    where: { distributorId },
    orderBy: { expiryDate: 'asc' },
  });
  return licenses.map(l => {
    const isExpired = l.expiryDate ? l.expiryDate < new Date() : false;
    const daysUntilExpiry = l.expiryDate
      ? Math.ceil((l.expiryDate.getTime() - Date.now()) / 86400000) : null;
    return { ...l, isExpired, daysUntilExpiry };
  });
}

export async function createLicense(distributorId: string, data: {
  licenseType: string; licenseName: string; licenseNumber?: string;
  expiryDate?: string; documentUrl?: string;
}) {
  return prisma.license.create({
    data: {
      distributorId,
      licenseType: data.licenseType as any,
      licenseName: data.licenseName,
      licenseNumber: data.licenseNumber || null,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : null,
      documentUrl: data.documentUrl || null,
    },
  });
}

export async function updateLicense(id: string, distributorId: string, data: Record<string, any>) {
  const existing = await prisma.license.findFirst({ where: { id, distributorId } });
  if (!existing) return null;
  return prisma.license.update({
    where: { id },
    data: {
      licenseName: data.licenseName,
      licenseNumber: data.licenseNumber,
      expiryDate: data.expiryDate ? new Date(data.expiryDate) : existing.expiryDate,
      documentUrl: data.documentUrl,
    },
  });
}

export async function deleteLicense(id: string, distributorId: string) {
  const existing = await prisma.license.findFirst({ where: { id, distributorId } });
  if (!existing) return null;
  return prisma.license.delete({ where: { id } });
}
