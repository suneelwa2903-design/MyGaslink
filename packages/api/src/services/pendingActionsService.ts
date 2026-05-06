import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { DEFAULT_SLA_HOURS } from '@gaslink/shared';

export async function listPendingActions(
  distributorId?: string,
  filters: { module?: string; status?: string; severity?: string } = {}
) {
  const where: Prisma.PendingActionWhereInput = {};
  if (distributorId) where.distributorId = distributorId;
  if (filters.module) where.module = filters.module as any;
  if (filters.status) where.status = filters.status as any;
  if (filters.severity) where.severity = filters.severity as any;

  return prisma.pendingAction.findMany({
    where,
    orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function createPendingAction(
  distributorId: string,
  data: {
    module: string; entityType: string; entityId: string;
    actionType: string; description: string;
    severity?: string; requiresApproval?: boolean;
    errorCode?: string; errorMessage?: string; errorContext?: any;
  }
) {
  const severity = (data.severity || 'medium') as keyof typeof DEFAULT_SLA_HOURS;
  const slaHours = DEFAULT_SLA_HOURS[severity] || DEFAULT_SLA_HOURS.medium;
  const slaDeadline = new Date(Date.now() + slaHours * 3600000);

  return prisma.pendingAction.create({
    data: {
      distributorId,
      module: data.module as any,
      entityType: data.entityType,
      entityId: data.entityId,
      actionType: data.actionType,
      description: data.description,
      severity: severity as any,
      requiresApproval: data.requiresApproval ?? false,
      slaDeadline,
      errorCode: data.errorCode || null,
      errorMessage: data.errorMessage || null,
      errorContext: data.errorContext || null,
    },
  });
}

export async function approvePendingAction(actionId: string, distributorId: string, userId: string) {
  const action = await prisma.pendingAction.findFirst({ where: { id: actionId, distributorId } });
  if (!action) return null;
  return prisma.pendingAction.update({
    where: { id: actionId },
    data: { approvedBy: userId, approvedAt: new Date(), status: 'in_progress' },
  });
}

export async function resolvePendingAction(actionId: string, distributorId: string, userId: string, notes?: string) {
  const action = await prisma.pendingAction.findFirst({ where: { id: actionId, distributorId } });
  if (!action) return null;
  return prisma.pendingAction.update({
    where: { id: actionId },
    data: {
      status: 'resolved', resolvedBy: userId,
      resolvedAt: new Date(), resolutionNotes: notes || null,
    },
  });
}

export async function rejectPendingAction(actionId: string, distributorId: string, userId: string, notes?: string) {
  const action = await prisma.pendingAction.findFirst({ where: { id: actionId, distributorId } });
  if (!action) return null;
  return prisma.pendingAction.update({
    where: { id: actionId },
    data: {
      status: 'skipped', resolvedBy: userId,
      resolvedAt: new Date(), resolutionNotes: notes || 'Rejected',
    },
  });
}

export async function getOverdueSlaActions(distributorId: string) {
  return prisma.pendingAction.findMany({
    where: {
      distributorId,
      status: { in: ['open', 'in_progress'] },
      slaDeadline: { lt: new Date() },
    },
    orderBy: { slaDeadline: 'asc' },
  });
}
