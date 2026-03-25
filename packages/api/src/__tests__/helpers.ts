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
 * Today's date as YYYY-MM-DD string.
 */
export function today(): string {
  return new Date().toISOString().split('T')[0];
}
