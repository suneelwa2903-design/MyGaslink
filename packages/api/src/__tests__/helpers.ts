import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { prisma } from '../lib/prisma.js';
import type { UserRole } from '@gaslink/shared';

/**
 * Generate a JWT token for testing.
 */
export function generateToken(payload: {
  userId: string;
  email: string;
  role: UserRole;
  distributorId: string | null;
  customerId?: string | null;
}): string {
  return jwt.sign(
    {
      userId: payload.userId,
      email: payload.email,
      role: payload.role,
      distributorId: payload.distributorId,
      customerId: payload.customerId ?? null,
    },
    config.jwt.accessSecret,
    { expiresIn: '1h' },
  );
}

/**
 * Login as dist-001 distributor admin and return token + context.
 */
export async function loginAsDistAdmin() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'bhargava@gasagency.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user, distributorId: user.distributorId! };
}

/**
 * Login as finance user and return token + context.
 */
export async function loginAsFinance() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'finance@gasagency.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user, distributorId: user.distributorId! };
}

/**
 * Login as inventory user and return token + context.
 */
export async function loginAsInventory() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'inventory@gasagency.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user, distributorId: user.distributorId! };
}

/**
 * Login as the seeded dist-001 driver (raju@gasagency.com) and return
 * a token + the matched Driver row (resolved via phone-match — same
 * convention used by driversVehicles.resolveDriverFromUser).
 */
export async function loginAsDriver() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'raju@gasagency.com' },
  });
  const driver = await prisma.driver.findFirst({
    where: { distributorId: user.distributorId!, phone: user.phone! },
  });
  if (!driver) throw new Error('Seed missing dist-001 driver matching raju@gasagency.com phone');
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user, driver, distributorId: user.distributorId! };
}

/**
 * Login as the seeded dist-002 driver (driver2@gasdist.com). Used for
 * cross-tenant isolation tests.
 */
export async function loginAsDriverDist002() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'driver2@gasdist.com' },
  });
  const driver = await prisma.driver.findFirst({
    where: { distributorId: user.distributorId!, phone: user.phone! },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user, driver, distributorId: user.distributorId! };
}

/**
 * Login as the seeded dist-001 customer (royal@kitchen.com).
 */
export async function loginAsCustomer() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'royal@kitchen.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
    customerId: user.customerId,
  });
  return { token, user, distributorId: user.distributorId!, customerId: user.customerId! };
}

/**
 * Login as super admin and return token.
 */
export async function loginAsSuperAdmin() {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: 'admin@mygaslink.com' },
  });
  const token = generateToken({
    userId: user.id,
    email: user.email,
    role: user.role as UserRole,
    distributorId: user.distributorId,
  });
  return { token, user };
}

/**
 * Get seed data references for dist-001.
 */
export async function getSeedData() {
  const distributor = await prisma.distributor.findUniqueOrThrow({ where: { id: 'dist-001' } });
  const customers = await prisma.customer.findMany({
    where: { distributorId: 'dist-001' },
    orderBy: { customerName: 'asc' },
  });
  const cylinderTypes = await prisma.cylinderType.findMany({
    where: { distributorId: 'dist-001' },
    orderBy: { capacity: 'asc' },
  });
  const drivers = await prisma.driver.findMany({
    where: { distributorId: 'dist-001' },
    orderBy: { driverName: 'asc' },
  });
  const vehicles = await prisma.vehicle.findMany({
    where: { distributorId: 'dist-001' },
    orderBy: { vehicleNumber: 'asc' },
  });

  return { distributor, customers, cylinderTypes, drivers, vehicles };
}

/**
 * Clean up test orders and related data for a distributor.
 * Use this in afterEach/afterAll to clean test state.
 */
export async function cleanupTestOrders(distributorId: string) {
  // Delete in dependency order
  await prisma.paymentAllocation.deleteMany({
    where: { payment: { distributorId } },
  });
  await prisma.paymentTransaction.deleteMany({ where: { distributorId } });
  await prisma.gstDocument.deleteMany({
    where: { invoice: { distributorId } },
  });
  await prisma.creditNote.deleteMany({ where: { invoice: { distributorId } } });
  await prisma.debitNote.deleteMany({ where: { invoice: { distributorId } } });
  await prisma.invoiceItem.deleteMany({
    where: { invoice: { distributorId } },
  });
  await prisma.invoice.deleteMany({ where: { distributorId } });
  await prisma.cancelledStockEvent.deleteMany({ where: { distributorId } });
  await prisma.inventoryEvent.deleteMany({ where: { distributorId } });
  await prisma.inventorySummary.deleteMany({ where: { distributorId } });
  await prisma.orderStatusLog.deleteMany({
    where: { order: { distributorId } },
  });
  await prisma.driverAssignment.deleteMany({
    where: { order: { distributorId } },
  });
  await prisma.orderItem.deleteMany({
    where: { order: { distributorId } },
  });
  await prisma.order.deleteMany({ where: { distributorId } });
  await prisma.pendingAction.deleteMany({ where: { distributorId } });
  await prisma.vehicleInventory.deleteMany({
    where: { vehicle: { distributorId } },
  });
  // Reset vehicle statuses
  await prisma.vehicle.updateMany({
    where: { distributorId },
    data: { status: 'idle' },
  });
}

/**
 * Today's date as YYYY-MM-DD string in the test process's LOCAL timezone.
 *
 * Why local TZ, not UTC: every API path that validates "today / tomorrow"
 * does so via `new Date(); setHours(0, 0, 0, 0)` which uses local TZ
 * (see customerPortalService.ts:256). Using `toISOString()` here would
 * return the UTC calendar date, which between ~18:30 UTC and 23:59 UTC
 * daily disagrees with the local (IST) date by one day — triggering
 * "Delivery date must be today or tomorrow" 400s in customer-portal
 * tests at the midnight-IST boundary. The local-TZ computation makes
 * test and API agree on what "today" means regardless of wall-clock
 * time. See docs/E2E-MONITOR-DIAGNOSIS.md sibling commit for the broader
 * timezone-flakiness discussion.
 */
export function today(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * WI-090: find-or-create a DEDICATED test vehicle for a distributor.
 *
 * The GST preflight / trip-sheet tests dispatch a vehicle (preflight sets
 * vehicle.status='dispatched') and then reset it in teardown. Previously
 * they grabbed the first SEEDED vehicle via `findFirstOrThrow` and reset
 * ALL of the distributor's vehicles to 'idle' — which corrupted live
 * dispatch state on the shared dev DB (the seeded vehicle is also the one
 * used for manual/live testing). Routing the tests through a dedicated
 * vehicle (recognisable name, never used by live testing) lets teardown
 * scope its reset to `vehicleNumber` and leave the seeded fleet untouched.
 *
 * Idempotent via the (distributorId, vehicleNumber) unique key.
 */
export async function getOrCreateTestVehicle(distributorId: string, vehicleNumber: string) {
  const existing = await prisma.vehicle.findFirst({
    where: { distributorId, vehicleNumber },
  });
  if (existing) {
    if (existing.deletedAt || existing.status === 'inactive') {
      return prisma.vehicle.update({
        where: { id: existing.id },
        data: { deletedAt: null, status: 'idle' },
      });
    }
    return existing;
  }
  return prisma.vehicle.create({
    data: { distributorId, vehicleNumber, vehicleType: 'truck', capacity: 100, status: 'idle' },
  });
}

/**
 * WI-PENDING-PAYMENTS: seed a PaymentSubmission row.
 *
 * Defaults to a pending row dated 2099-12-31 (anti-pattern #7 —
 * far-future date avoids contaminating manual-test data on the
 * shared dev DB). Caller passes distributorId + customerId + role
 * fields; submittedBy defaults to 'driver'.
 */
export async function seedPaymentSubmission(opts: {
  distributorId: string;
  customerId: string;
  amount?: number;
  paymentMethod?: 'cash' | 'cheque' | 'online' | 'upi' | 'bank_transfer' | 'credit';
  transactionDate?: string;
  status?: 'pending_verification' | 'verified' | 'rejected';
  submittedBy?: 'staff' | 'driver' | 'customer';
  submittedByUserId?: string | null;
  submittedByDriverId?: string | null;
  referenceNumber?: string;
  notes?: string;
  attachmentUrl?: string;
  pendingInvoiceIds?: string[];
}) {
  return prisma.paymentSubmission.create({
    data: {
      distributorId: opts.distributorId,
      customerId: opts.customerId,
      amount: opts.amount ?? 1000,
      paymentMethod: opts.paymentMethod ?? 'cash',
      transactionDate: new Date(opts.transactionDate ?? '2099-12-31'),
      status: opts.status ?? 'pending_verification',
      submittedBy: opts.submittedBy ?? 'driver',
      submittedByUserId: opts.submittedByUserId ?? null,
      submittedByDriverId: opts.submittedByDriverId ?? null,
      referenceNumber: opts.referenceNumber ?? null,
      notes: opts.notes ?? null,
      attachmentUrl: opts.attachmentUrl ?? null,
      pendingInvoiceIds: opts.pendingInvoiceIds ?? undefined,
    },
  });
}

/**
 * Clean up payment submissions for a tenant. Safe to call from
 * afterAll. Deletes only — does not touch related PaymentTransactions
 * (the `resulting_payment_id` FK is SET NULL on delete).
 */
export async function cleanupPaymentSubmissions(distributorId: string) {
  await prisma.paymentSubmission.deleteMany({ where: { distributorId } });
}

/**
 * WI-064 follow-up: ensure a confirmed (non-cancelled) DriverVehicleAssignment
 * exists for the given driver + date. orderService.assignDriver now requires
 * one — without it the assign-driver call 400s with
 *   "Driver has no confirmed vehicle mapping for the order delivery date".
 *
 * Idempotent. Safe to call from multiple tests / beforeAll blocks. Uses
 * the model's `(driverId, assignmentDate, tripNumber)` unique key so
 * reruns don't violate the constraint — we look up first, only create
 * when missing, and never touch tripNumber.
 *
 * Returns the assignment row. If the test needs a different vehicle, it
 * can update the row afterwards — but the typical pattern is one driver,
 * one vehicle, one date.
 */
export async function ensureDriverVehicleMapping(opts: {
  distributorId: string;
  driverId: string;
  vehicleId: string;
  date: string; // YYYY-MM-DD
}) {
  const existing = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId: opts.driverId,
      distributorId: opts.distributorId,
      assignmentDate: new Date(opts.date),
    },
    orderBy: { tripNumber: 'desc' },
  });
  if (existing) {
    // If the existing row is cancelled or points at a different vehicle,
    // bring it back online for this test run. We never delete it — that
    // would force a unique-constraint dance for no benefit.
    if (existing.status === 'cancelled' || existing.vehicleId !== opts.vehicleId) {
      return prisma.driverVehicleAssignment.update({
        where: { id: existing.id },
        data: {
          status: 'dispatch_ready',
          vehicleId: opts.vehicleId,
        },
      });
    }
    return existing;
  }
  return prisma.driverVehicleAssignment.create({
    data: {
      driverId: opts.driverId,
      vehicleId: opts.vehicleId,
      distributorId: opts.distributorId,
      assignmentDate: new Date(opts.date),
      tripNumber: 1,
      status: 'dispatch_ready',
    },
  });
}
