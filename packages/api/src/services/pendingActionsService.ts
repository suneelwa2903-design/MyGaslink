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
    // WI-127: optional explicit SLA deadline (e.g. CUSTOMER_DISPUTE = end of
    // today). When omitted, derived from severity via DEFAULT_SLA_HOURS.
    slaDeadline?: Date;
  }
) {
  const severity = (data.severity || 'medium') as keyof typeof DEFAULT_SLA_HOURS;
  const slaHours = DEFAULT_SLA_HOURS[severity] || DEFAULT_SLA_HOURS.medium;
  const slaDeadline = data.slaDeadline ?? new Date(Date.now() + slaHours * 3600000);

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

// WI-105 PART 3 — resolving one of these is the admin's "retry the NIC call"
// signal, so we pre-flight NIC health first and refuse if the portal is down.
const NIC_RETRY_ACTION_TYPES = new Set(['IRN_GENERATION', 'EWB_GENERATION', 'IRN_CANCEL_BLOCKED']);

export class NicUnavailableError extends Error {
  code = 'NIC_UNAVAILABLE';
  constructor(message: string) {
    super(message);
    this.name = 'NicUnavailableError';
  }
}

export async function resolvePendingAction(actionId: string, distributorId: string, userId: string, notes?: string) {
  const action = await prisma.pendingAction.findFirst({ where: { id: actionId, distributorId } });
  if (!action) return null;

  // WI-105 PART 3 — NIC pre-flight on the resolve (retry) path only. The
  // approve path is intentionally NOT gated: it routes through the dispatch
  // flow, which runs its own pre-dispatch NIC probe.
  if (NIC_RETRY_ACTION_TYPES.has(action.actionType)) {
    const distributor = await prisma.distributor.findUnique({
      where: { id: distributorId },
      select: { gstin: true },
    });
    const { pingEinvoiceSession } = await import('./gst/whitebooksClient.js');
    try {
      await pingEinvoiceSession(distributorId, distributor?.gstin ?? '');
    } catch {
      throw new NicUnavailableError('NIC portal is currently unavailable. Please try again in a few minutes.');
    }
  }

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
