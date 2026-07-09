/**
 * emptiesReturnService.ts
 *
 * Item 7 (docs/INVESTIGATION-JUL09-B.md) — lightweight "customer X
 * returned N empties of cylinder type Y" flow. NOT a full Returns Order:
 *   - no Order row
 *   - no Invoice
 *   - no schedule / driver / vehicle
 *   - no money movement
 *
 * All this does is (a) write two inventory events dated on the return
 * date — one `returns_collection` for the display aggregator, one
 * `reconciliation_empties_return` for the closing-empties credit (mirrors
 * the godown-pickup synthetic-event pattern in orderService.confirmDelivery
 * so the daily summary math stays right), (b) decrement the customer's
 * `withCustomerQty`, and (c) cascade `recalculateSummariesFromDate`.
 *
 * Past-date entries are supported (up to 90 days back). Locked inventory
 * days silently skip in the cascade — that's correct behaviour (documented
 * in the modal copy).
 */
import { prisma } from '../lib/prisma.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';
import type { EmptiesReturnInput } from '@gaslink/shared';

export class EmptiesReturnError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'EmptiesReturnError';
  }
}

export async function recordEmptiesReturn(
  distributorId: string,
  userId: string,
  data: EmptiesReturnInput,
): Promise<{ eventsWritten: number; customerBalanceUpdated: boolean; returnDate: string }> {
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, customerName: true },
  });
  if (!customer) {
    throw new EmptiesReturnError('Customer not found', 404);
  }

  const cylinderType = await prisma.cylinderType.findFirst({
    where: { id: data.cylinderTypeId, distributorId, isActive: true },
    select: { id: true, typeName: true },
  });
  if (!cylinderType) {
    throw new EmptiesReturnError('Cylinder type not found', 404);
  }

  const returnDate = new Date(`${data.returnDate}T00:00:00.000Z`);
  const notes = data.notes?.trim() || `Empties return: ${data.quantity}× ${cylinderType.typeName} from ${customer.customerName}`;

  await prisma.$transaction(async (tx) => {
    // 1) Display-facing collection event (feeds `collectedEmpties` in
    //    the daily summary aggregator — inventoryService.ts:183-186).
    await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'returns_collection',
      fullsChange: 0,
      emptiesChange: data.quantity,
      eventDate: returnDate,
      referenceId: customer.id,
      referenceType: 'empties_return',
      createdBy: userId,
      notes,
    });

    // 2) Verified-empties event so `closingEmpties` is credited immediately
    //    without waiting on a vehicle reconciliation (mirrors the
    //    godown-pickup pattern in orderService.confirmDelivery). Under the
    //    new inventory model, only `reconciliation_empties_return` drives
    //    `emptiesReturnedVerified` → `closingEmpties`.
    await createInventoryEvent(tx, {
      distributorId,
      cylinderTypeId: data.cylinderTypeId,
      eventType: 'reconciliation_empties_return',
      fullsChange: 0,
      emptiesChange: data.quantity,
      eventDate: returnDate,
      referenceId: customer.id,
      referenceType: 'empties_return',
      createdBy: userId,
      notes,
    });

    // 3) Decrement the customer's held empties count.
    await tx.customerInventoryBalance.upsert({
      where: {
        customerId_cylinderTypeId: {
          customerId: customer.id,
          cylinderTypeId: data.cylinderTypeId,
        },
      },
      create: {
        customerId: customer.id,
        cylinderTypeId: data.cylinderTypeId,
        withCustomerQty: -data.quantity,
      },
      update: {
        withCustomerQty: { decrement: data.quantity },
      },
    });
  });

  // Cascade — outside the tx so events are committed before recomputing.
  await recalculateSummariesFromDate(distributorId, data.cylinderTypeId, returnDate);

  return {
    eventsWritten: 2,
    customerBalanceUpdated: true,
    returnDate: data.returnDate,
  };
}
