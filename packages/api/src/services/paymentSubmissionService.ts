/**
 * WI-PENDING-PAYMENTS: PaymentSubmission service.
 *
 * Self-reported payment claims (driver / customer / staff) live in a
 * SEPARATE table from `payment_transactions` so unverified rows cannot
 * leak into any existing payment reader. The verify path calls into
 * `paymentService.createPaymentInTx` inside a single transaction so the
 * payment_transactions write + submission status flip + ledger entry are
 * all atomic.
 *
 * Tenant isolation: every read/write below is keyed on `distributorId`
 * sourced from the caller's authenticated session — never trusted from
 * the request body.
 */
import { prisma } from '../lib/prisma.js';
import { Prisma } from '@prisma/client';
import type { $Enums } from '@prisma/client';
import { createPaymentInTx, PaymentError } from './paymentService.js';
import { toNum } from '../utils/decimal.js';

export interface CreateSubmissionInput {
  customerId: string;
  amount: number;
  paymentMethod: $Enums.PaymentMethod;
  transactionDate: string; // YYYY-MM-DD
  referenceNumber?: string;
  notes?: string;
  attachmentUrl?: string;
  pendingInvoiceIds?: string[];
  submittedBy: $Enums.PaymentSubmittedBy;
  submittedByUserId?: string | null;
  submittedByDriverId?: string | null;
}

/**
 * Create a pending submission. Validates tenant ownership of customer
 * and any provided pendingInvoiceIds. Throws PaymentError(403) on
 * cross-tenant attempts so the route returns 403 not 400.
 */
export async function createSubmission(
  distributorId: string,
  input: CreateSubmissionInput,
) {
  if (!(input.amount > 0)) {
    throw new PaymentError('Amount must be positive', 400);
  }
  // Reject paymentDate more than 1 day in the future (allows a small
  // timezone-drift cushion, blocks gross errors).
  const txnDate = new Date(input.transactionDate);
  if (Number.isNaN(txnDate.getTime())) {
    throw new PaymentError('Invalid transactionDate', 400);
  }
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(23, 59, 59, 999);
  if (txnDate > tomorrow) {
    throw new PaymentError('transactionDate cannot be in the future', 400);
  }

  // Tenant check on customer.
  const customer = await prisma.customer.findFirst({
    where: { id: input.customerId, distributorId, deletedAt: null },
    select: { id: true },
  });
  if (!customer) {
    throw new PaymentError('Customer not found in this distributor', 403);
  }

  // Tenant + customer check on pendingInvoiceIds, if provided.
  if (input.pendingInvoiceIds && input.pendingInvoiceIds.length > 0) {
    const count = await prisma.invoice.count({
      where: {
        id: { in: input.pendingInvoiceIds },
        distributorId,
        customerId: input.customerId,
        deletedAt: null,
      },
    });
    if (count !== input.pendingInvoiceIds.length) {
      throw new PaymentError(
        'One or more pendingInvoiceIds do not belong to this customer',
        403,
      );
    }
  }

  return prisma.paymentSubmission.create({
    data: {
      distributorId,
      customerId: input.customerId,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      transactionDate: txnDate,
      referenceNumber: input.referenceNumber ?? null,
      notes: input.notes ?? null,
      attachmentUrl: input.attachmentUrl ?? null,
      pendingInvoiceIds:
        input.pendingInvoiceIds && input.pendingInvoiceIds.length > 0
          ? (input.pendingInvoiceIds as Prisma.InputJsonValue)
          : Prisma.JsonNull,
      status: 'pending_verification',
      submittedBy: input.submittedBy,
      submittedByUserId: input.submittedByUserId ?? null,
      submittedByDriverId: input.submittedByDriverId ?? null,
    },
  });
}

/**
 * List pending submissions for the office approval queue. Enriches each
 * row with:
 *   - customer: { id, name, currentOutstanding }
 *   - submittedByDriver: { id, name } | null
 *   - otherPendingCount: how many OTHER pending rows exist for the
 *     same customer (double-entry-risk indicator)
 */
export async function listPending(
  distributorId: string,
  options: { page?: number; pageSize?: number } = {},
) {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 25, 100);

  const [submissions, total] = await Promise.all([
    prisma.paymentSubmission.findMany({
      where: { distributorId, status: 'pending_verification' },
      include: {
        customer: { select: { id: true, customerName: true } },
        submittedByDriver: { select: { id: true, driverName: true } },
      },
      orderBy: { createdAt: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentSubmission.count({
      where: { distributorId, status: 'pending_verification' },
    }),
  ]);

  // Bulk-compute customer outstanding totals (sum of unpaid invoice
  // outstanding amounts) and per-customer pending-submission counts so
  // we avoid N+1 lookups.
  const customerIds = Array.from(new Set(submissions.map((s) => s.customerId)));

  const [outstandingRows, pendingByCustomerRows] = await Promise.all([
    customerIds.length === 0
      ? Promise.resolve([] as Array<{ customerId: string; _sum: { outstandingAmount: Prisma.Decimal | null } }>)
      : prisma.invoice.groupBy({
          by: ['customerId'],
          where: {
            distributorId,
            customerId: { in: customerIds },
            deletedAt: null,
            status: { in: ['issued', 'partially_paid', 'overdue'] },
          },
          _sum: { outstandingAmount: true },
        }),
    customerIds.length === 0
      ? Promise.resolve([] as Array<{ customerId: string; _count: { _all: number } }>)
      : prisma.paymentSubmission.groupBy({
          by: ['customerId'],
          where: {
            distributorId,
            customerId: { in: customerIds },
            status: 'pending_verification',
          },
          _count: { _all: true },
        }),
  ]);

  const outstandingMap = new Map(
    outstandingRows.map((r) => [r.customerId, toNum(r._sum.outstandingAmount ?? 0)]),
  );
  const pendingCountMap = new Map(
    pendingByCustomerRows.map((r) => [r.customerId, r._count._all]),
  );

  const enriched = submissions.map((s) => {
    const pendingForThisCustomer = pendingCountMap.get(s.customerId) ?? 0;
    return {
      ...s,
      amount: toNum(s.amount),
      customer: {
        id: s.customer.id,
        customerName: s.customer.customerName,
        currentOutstanding: outstandingMap.get(s.customerId) ?? 0,
      },
      otherPendingCount: Math.max(0, pendingForThisCustomer - 1),
    };
  });

  return {
    submissions: enriched,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/** Badge count — pending submissions for the office. */
export async function countPending(distributorId: string): Promise<number> {
  return prisma.paymentSubmission.count({
    where: { distributorId, status: 'pending_verification' },
  });
}

/** Driver's own submission history (pending + verified + rejected). */
export async function listByDriver(
  distributorId: string,
  driverId: string,
  options: { page?: number; pageSize?: number } = {},
) {
  const page = options.page ?? 1;
  const pageSize = Math.min(options.pageSize ?? 50, 200);

  const [submissions, total] = await Promise.all([
    prisma.paymentSubmission.findMany({
      where: { distributorId, submittedByDriverId: driverId },
      include: {
        customer: { select: { id: true, customerName: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.paymentSubmission.count({
      where: { distributorId, submittedByDriverId: driverId },
    }),
  ]);

  return {
    submissions: submissions.map((s) => ({ ...s, amount: toNum(s.amount) })),
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

/** Customer's own submission history. */
export async function listByCustomer(
  distributorId: string,
  customerId: string,
) {
  const submissions = await prisma.paymentSubmission.findMany({
    where: { distributorId, customerId },
    orderBy: { createdAt: 'desc' },
  });
  return submissions.map((s) => ({ ...s, amount: toNum(s.amount) }));
}

/**
 * Fetch a single submission scoped to the caller's tenant. Returns null
 * (not throws) when not found / wrong tenant so the route layer can
 * decide between 404 and other responses.
 */
export async function getSubmission(distributorId: string, submissionId: string) {
  return prisma.paymentSubmission.findFirst({
    where: { id: submissionId, distributorId },
    include: {
      customer: { select: { id: true, customerName: true } },
      submittedByDriver: { select: { id: true, driverName: true } },
    },
  });
}

/**
 * VERIFY a pending submission. Inside a single $transaction:
 *   1. Recheck submission state under tx (defends against double-approve).
 *   2. Call paymentService.createPaymentInTx → cleared PaymentTransaction.
 *   3. Update submission: status=verified, verifiedByUserId, verifiedAt,
 *      resultingPaymentId.
 *
 * Atomicity guarantee: if any step throws, all three writes roll back.
 * No orphan PaymentTransaction can exist without a back-link to the
 * submission row.
 */
export async function verifySubmission(
  distributorId: string,
  submissionId: string,
  verifiedByUserId: string,
  allocations?: { invoiceId: string; amount: number }[],
) {
  return prisma.$transaction(async (tx) => {
    const submission = await tx.paymentSubmission.findFirst({
      where: { id: submissionId, distributorId },
    });
    if (!submission) {
      throw new PaymentError('Submission not found', 404);
    }
    if (submission.status !== 'pending_verification') {
      throw new PaymentError(
        `Submission has already been ${submission.status === 'verified' ? 'verified' : 'rejected'}`,
        400,
      );
    }

    // Create the cleared payment via the existing money-recording
    // service. createPaymentInTx itself revalidates customer tenancy.
    const payment = await createPaymentInTx(tx, distributorId, verifiedByUserId, {
      customerId: submission.customerId,
      amount: toNum(submission.amount),
      paymentMethod: submission.paymentMethod,
      referenceNumber: submission.referenceNumber ?? undefined,
      transactionDate: submission.transactionDate.toISOString().slice(0, 10),
      allocations,
    });

    const updated = await tx.paymentSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'verified',
        verifiedByUserId,
        verifiedAt: new Date(),
        resultingPaymentId: payment.id,
      },
    });

    return { submission: { ...updated, amount: toNum(updated.amount) }, payment };
  });
}

/**
 * REJECT a pending submission. No ledger writes. The rejectionReason is
 * shown to the submitter on next-app-open via their my-submissions list.
 */
export async function rejectSubmission(
  distributorId: string,
  submissionId: string,
  rejectedByUserId: string,
  rejectionReason: string,
) {
  const trimmed = rejectionReason.trim();
  if (trimmed.length < 5) {
    throw new PaymentError('rejectionReason must be at least 5 characters', 400);
  }

  return prisma.$transaction(async (tx) => {
    const submission = await tx.paymentSubmission.findFirst({
      where: { id: submissionId, distributorId },
    });
    if (!submission) {
      throw new PaymentError('Submission not found', 404);
    }
    if (submission.status !== 'pending_verification') {
      throw new PaymentError(
        `Submission has already been ${submission.status === 'verified' ? 'verified' : 'rejected'}`,
        400,
      );
    }
    const updated = await tx.paymentSubmission.update({
      where: { id: submission.id },
      data: {
        status: 'rejected',
        verifiedByUserId: rejectedByUserId,
        verifiedAt: new Date(),
        rejectionReason: trimmed,
      },
    });
    return { ...updated, amount: toNum(updated.amount) };
  });
}
