import { prisma } from '../lib/prisma.js';
import type { Prisma, $Enums } from '@prisma/client';
import { getEffectivePrice } from './cylinderTypeService.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';
import { isDispatchDebitEnabled } from '../utils/inventoryFlags.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import { generateOrRefreshOtp } from './deliveryProofService.js';
import { logger } from '../utils/logger.js';
import { toNum } from '../utils/decimal.js';
import { allocateNumber } from './numberingService.js';
import { notifyDriver } from '../lib/sseManager.js';

// WI-108: legacy random order-number generator, kept as the fallback when a
// distributor has no docCode set (structured numbering not activated).
const legacyOrderNumber = (prefix: string) =>
  `${prefix}-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

// Order total = cylinder subtotal + (transportRate × Σ qty). Transport rate
// is the customer's GST-inclusive per-cylinder fee. Same basis the invoice
// uses at delivery time — keeps order.totalAmount and invoice.totalAmount
// apples-to-apples whenever the rate and quantities match.
export function computeOrderTotal(
  cylinderItems: Array<{ totalPrice: number; quantity: number }>,
  transportRatePerCylinder: number,
): number {
  const cylinderSubtotal = cylinderItems.reduce((s, it) => s + it.totalPrice, 0);
  const totalQty = cylinderItems.reduce((s, it) => s + it.quantity, 0);
  const transportRate = Math.max(transportRatePerCylinder, 0);
  return cylinderSubtotal + transportRate * totalQty;
}

const orderInclude = {
  // customerType added so mapOrder can flat-alias it onto the order DTO —
  // the web edit-order modal needs it to gate the B2B-only PO number input.
  // requireDeliveryVerification (proof-of-collection Phase 1, 2026-07-15)
  // is flat-aliased as customerRequiresVerification by mapOrder — driver
  // mobile app reads it to decide whether to render the proof-capture
  // section in the confirm-delivery modal. Narrow select only — never
  // include: true (leak risk).
  //
  // _count.users (Phase 3, 2026-07-15): drives the customerHasPortalAccess
  // flat alias — driver UI shows OTP tab only when > 0, otherwise renders
  // an amber "customer doesn't have the app — use Signature or Photo"
  // message. Filter: role='customer', not soft-deleted. Small extra
  // aggregate per order; negligible at typical page sizes.
  customer: {
    select: {
      id: true,
      customerName: true,
      customerType: true,
      stopSupply: true,
      creditPeriodDays: true,
      requireDeliveryVerification: true,
      _count: {
        select: {
          users: { where: { role: 'customer', deletedAt: null } },
        },
      },
    },
  },
  driver: { select: { id: true, driverName: true } },
  vehicle: { select: { id: true, vehicleNumber: true } },
  items: { include: { cylinderType: { select: { typeName: true } } } },
} satisfies Prisma.OrderInclude;

export async function listOrders(
  distributorId: string,
  filters: {
    status?: string; customerId?: string; driverId?: string;
    dateFrom?: string; dateTo?: string; search?: string;
    page?: number; pageSize?: number; sortBy?: string; sortOrder?: string;
  }
) {
  const where: Prisma.OrderWhereInput = { distributorId, deletedAt: null };
  // Pseudo-status filters: the Orders page dropdown surfaces
  // "Godown Pickup" and "On-Demand" as extra choices in the same
  // Statuses select. They translate to boolean-column filters instead
  // of `status`. Real OrderStatus values pass through unchanged.
  if (filters.status === 'godown_pickup') {
    where.isGodownPickup = true;
  } else if (filters.status === 'on_demand') {
    where.isBackdated = true;
  } else if (filters.status) {
    where.status = filters.status as $Enums.OrderStatus;
  }
  if (filters.customerId) where.customerId = filters.customerId;
  if (filters.driverId) where.driverId = filters.driverId;
  if (filters.dateFrom || filters.dateTo) {
    where.deliveryDate = {};
    if (filters.dateFrom) where.deliveryDate.gte = new Date(filters.dateFrom);
    if (filters.dateTo) where.deliveryDate.lte = new Date(filters.dateTo);
  }
  if (filters.search) {
    where.OR = [
      { orderNumber: { contains: filters.search, mode: 'insensitive' } },
      { customer: { customerName: { contains: filters.search, mode: 'insensitive' } } },
    ];
  }

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 25;
  const sortBy = filters.sortBy || 'createdAt';
  const sortOrder = (filters.sortOrder || 'desc') as 'asc' | 'desc';

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: orderInclude,
      orderBy: { [sortBy]: sortOrder },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.order.count({ where }),
  ]);

  return {
    data: orders,
    meta: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
  };
}

export async function getOrderById(id: string, distributorId: string) {
  return prisma.order.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: {
      ...orderInclude,
      statusLogs: { orderBy: { changedAt: 'desc' } },
      invoice: { select: { id: true, invoiceNumber: true, status: true } },
    },
  });
}

export async function createOrder(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    deliveryDate: string;
    specialInstructions?: string;
    // Buyer's PO number (B2B). Max 16 chars enforced upstream at the Zod
    // schema. Persisted on Order.poNumber and snapshotted onto Invoice.poNumber
    // at issue time so IRN + PDF + GSTR-1 stay aligned through reissue.
    poNumber?: string;
    // Customer self-collects from godown (no vehicle/driver/EWB). When true,
    // the order skips the preferred-driver lookup, the DVA INSERT, and the
    // initial pending_driver_assignment / pending_dispatch states; it goes
    // straight to pending_delivery so confirmDelivery can close it via
    // the existing "confirm delivery" flow.
    isGodownPickup?: boolean;
    // Mini-Operator (2026-07-16): free-text driver name for mini-operator
    // tenants that don't maintain Driver records. Optional; unrelated to
    // driverId FK. Max 100 chars enforced upstream at the Zod schema.
    driverNameFreeText?: string;
    items: { cylinderTypeId: string; quantity: number }[];
  },
  options?: {
    commitment?: { promisedDate?: Date; promisedAmount?: number; acknowledged?: boolean };
    // FLOAT-001 (2026-06-17): driver walk-in path. When set, the order is
    // tagged orderSource='walk_in', tied DIRECTLY to the passed driverId+
    // vehicleId (skipping the customer.preferredDriverId lookup), and starts
    // in pending_dispatch ready for an immediate preflightAddToTrip from
    // POST /api/drivers/me/orders. Avoids polluting the admin create flow
    // with role-specific logic.
    walkIn?: { driverId: string; vehicleId: string };
  },
) {
  // Validate customer belongs to distributor and supply is not stopped
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, customerName: true, stopSupply: true, preferredDriverId: true, transportChargePerCylinder: true },
  });
  if (!customer) throw new OrderError('Customer not found', 404);
  if (customer.stopSupply) throw new OrderError('Supply is stopped for this customer', 400);

  // WI-122: payment-commitment gate. Runs at the SERVICE layer so admin-created
  // orders are gated too — not just the customer portal. Single source of truth
  // for overdue is paymentService.computeCustomerOverdue.
  const { computeCustomerOverdue } = await import('./paymentService.js');
  const overdueAmount = await computeCustomerOverdue(distributorId, data.customerId);
  let commitmentToCreate:
    | { escalationLevel: number; promisedDate?: Date; promisedAmount?: number; acknowledged: boolean }
    | null = null;
  if (overdueAmount > 0) {
    const openCommitments = await prisma.paymentCommitment.count({
      where: { customerId: data.customerId, distributorId, status: 'open' },
    });
    const escalationLevel = Math.min(openCommitments + 1, 3);
    const commitment = options?.commitment;

    if (escalationLevel === 3) {
      // Blocked unless an admin granted a one-time override (an approved
      // OVERDUE_ORDER_OVERRIDE pending-action within the last 24h).
      const grant = await prisma.pendingAction.findFirst({
        where: {
          distributorId, entityType: 'customer', entityId: data.customerId,
          actionType: 'OVERDUE_ORDER_OVERRIDE', status: 'in_progress',
          approvedAt: { gte: new Date(Date.now() - 24 * 3600000) },
        },
        orderBy: { approvedAt: 'desc' },
      });
      if (!grant) {
        const existing = await prisma.pendingAction.findFirst({
          where: {
            distributorId, entityType: 'customer', entityId: data.customerId,
            actionType: 'OVERDUE_ORDER_OVERRIDE', status: 'open',
          },
        });
        if (!existing) {
          const { createPendingAction } = await import('./pendingActionsService.js');
          await createPendingAction(distributorId, {
            module: 'collections', entityType: 'customer', entityId: data.customerId,
            actionType: 'OVERDUE_ORDER_OVERRIDE', severity: 'high', requiresApproval: true,
            description: `${customer.customerName} has an overdue balance of ${overdueAmount} and is blocked from placing new orders. Approve to allow one order.`,
          });
        }
        throw new OrderError(JSON.stringify({ blocked: true, overdueAmount, escalationLevel: 3 }), 409);
      }
      // One approved override allows exactly one order — consume it.
      await prisma.pendingAction.update({
        where: { id: grant.id },
        data: { status: 'resolved', resolvedAt: new Date(), resolutionNotes: 'Override consumed by new order' },
      });
      commitmentToCreate = { escalationLevel: 3, acknowledged: true };
    } else if (escalationLevel === 1) {
      if (!commitment?.promisedDate) {
        throw new OrderError(JSON.stringify({ blocked: false, overdueAmount, escalationLevel, requiresCommitment: true }), 409);
      }
      commitmentToCreate = {
        escalationLevel, promisedDate: commitment.promisedDate,
        promisedAmount: commitment.promisedAmount, acknowledged: false,
      };
    } else {
      // Level 2: stricter — requires explicit acknowledgment (date optional).
      if (!commitment?.acknowledged) {
        throw new OrderError(JSON.stringify({ blocked: false, overdueAmount, escalationLevel, requiresAcknowledgment: true }), 409);
      }
      commitmentToCreate = {
        escalationLevel, promisedDate: commitment.promisedDate,
        promisedAmount: commitment.promisedAmount, acknowledged: true,
      };
    }
  }

  const deliveryDate = new Date(data.deliveryDate);
  // WI-108: structured number when docCode is set, else legacy random
  // (allocated inside the tx below so it rolls back with the order).
  // Mini-Operator (2026-07-16): accountType is read alongside docCode
  // so we can skip the driver-assignment path for mini-op tenants.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId }, select: { docCode: true, accountType: true },
  });
  const isMiniOperator = distributor?.accountType === 'mini_operator';

  // Calculate prices for each item
  const itemsWithPrices = await Promise.all(data.items.map(async (item) => {
    const unitPrice = await getEffectivePrice(distributorId, item.cylinderTypeId, deliveryDate);

    // Get customer discount
    const discount = await prisma.customerCylinderDiscount.findUnique({
      where: { customerId_cylinderTypeId: { customerId: data.customerId, cylinderTypeId: item.cylinderTypeId } },
    });
    const discountPerUnit = toNum(discount?.discountPerUnit);
    const effectivePrice = Math.max(unitPrice - discountPerUnit, 0);
    const totalPrice = effectivePrice * item.quantity;

    return {
      cylinderTypeId: item.cylinderTypeId,
      quantity: item.quantity,
      unitPrice,
      discountPerUnit,
      totalPrice,
    };
  }));

  const totalAmount = computeOrderTotal(itemsWithPrices, toNum(customer.transportChargePerCylinder));

  // Godown pickup: customer collects from the depot. No driver, no
  // vehicle, no dispatch. Order goes straight to pending_delivery so
  // confirmDelivery can close it via the existing "confirm delivery"
  // flow. Walk-in and preferred-driver lookups are short-circuited.
  const isGodownPickup = data.isGodownPickup ?? false;

  // Check preferred driver availability
  let driverId: string | null = null;
  let vehicleId: string | null = null;
  let status: string = 'pending_driver_assignment';

  if (isGodownPickup) {
    // Skip the entire driver/vehicle/dispatch path. Stay on null
    // driver+vehicle and land in pending_delivery from the start.
    status = 'pending_delivery';
  } else if (isMiniOperator) {
    // Mini-Operator (2026-07-16): mini-operator tenants have no Driver
    // records + no dispatch flow — every order goes straight to
    // pending_delivery so confirmDelivery can close it. Driver+vehicle
    // stay null (driverNameFreeText is the free-text substitute).
    status = 'pending_delivery';
  } else if (options?.walkIn) {
    // FLOAT-001: walk-in path bypasses the preferredDriverId lookup. The driver
    // is creating this order from their own mobile app for a customer they're
    // standing in front of — the active DVA is the source of truth for which
    // driver+vehicle to attach. Route layer already verified the DVA is
    // loaded_and_dispatched and the customer belongs to the driver's tenant.
    driverId = options.walkIn.driverId;
    vehicleId = options.walkIn.vehicleId;
    status = 'pending_dispatch';
  } else if (customer.preferredDriverId) {
    const assignment = await prisma.driverVehicleAssignment.findFirst({
      where: {
        driverId: customer.preferredDriverId,
        distributorId,
        assignmentDate: deliveryDate,
        isReconciled: false,
        status: 'dispatch_ready',
        driver: { status: 'active', availableToday: true },
      },
      select: { driverId: true, vehicleId: true },
    });
    if (assignment) {
      driverId = assignment.driverId;
      vehicleId = assignment.vehicleId;
      status = 'pending_dispatch';
    }
  }

  return prisma.$transaction(async (tx) => {
    const orderNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'O', deliveryDate, distributor.docCode)
      : legacyOrderNumber('ORD');
    const order = await tx.order.create({
      data: {
        orderNumber,
        distributorId,
        customerId: data.customerId,
        driverId,
        vehicleId,
        orderDate: new Date(),
        deliveryDate,
        status: status as $Enums.OrderStatus,
        // FLOAT-001 (2026-06-17): tag walk-in path; default 'regular' covers
        // every other caller (admin / customer portal / legacy).
        orderSource: options?.walkIn ? 'walk_in' : 'regular',
        totalAmount,
        specialInstructions: data.specialInstructions || null,
        // Trim and null-fold empty strings so the IRN payload-emit gate
        // (data.poNumber?.trim()) is symmetric with what's stored.
        poNumber: data.poNumber?.trim() || null,
        isGodownPickup,
        // Mini-Operator (2026-07-16): trim + null-fold matches the
        // poNumber convention above. Not read by any regular-distributor
        // code path (they use driverId); rendered on invoice PDF for
        // mini_operator tenants.
        driverNameFreeText: data.driverNameFreeText?.trim() || null,
        items: { create: itemsWithPrices },
      },
      include: orderInclude,
    });

    // Log initial status
    await tx.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'new',
        newStatus: status,
        changedBy: userId,
        notes: 'Order created',
      },
    });

    // WI-122: persist the payment commitment captured by the gate above.
    if (commitmentToCreate) {
      await tx.paymentCommitment.create({
        data: {
          distributorId,
          customerId: data.customerId,
          orderId: order.id,
          escalationLevel: commitmentToCreate.escalationLevel,
          overdueAmountSnapshot: overdueAmount,
          promisedDate: commitmentToCreate.promisedDate ?? null,
          promisedAmount: commitmentToCreate.promisedAmount ?? null,
          status: 'open',
          acknowledged: commitmentToCreate.acknowledged,
          createdBy: userId,
        },
      });
    }

    // If driver assigned, create driver assignment record
    if (driverId) {
      await tx.driverAssignment.create({
        data: {
          orderId: order.id,
          driverId,
          assignedBy: userId,
        },
      });
    }

    return order;
  });
}

export async function createReturnsOnlyOrder(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    scheduledDate: string;
    specialInstructions?: string;
    items: { cylinderTypeId: string; expectedQuantity: number }[];
  }
) {
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, stopSupply: true, preferredDriverId: true },
  });
  if (!customer) throw new OrderError('Customer not found', 404);

  const scheduledDate = new Date(data.scheduledDate);
  // WI-108: structured number (type O) when docCode is set, else legacy RET-.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId }, select: { docCode: true },
  });

  // Returns orders have no pricing - just cylinder tracking
  const itemsData = data.items.map(item => ({
    cylinderTypeId: item.cylinderTypeId,
    quantity: item.expectedQuantity,
    unitPrice: 0,
    discountPerUnit: 0,
    totalPrice: 0,
  }));

  // Check preferred driver
  let driverId: string | null = null;
  let vehicleId: string | null = null;
  let status: string = 'pending_driver_assignment';

  if (customer.preferredDriverId) {
    const assignment = await prisma.driverVehicleAssignment.findFirst({
      where: {
        driverId: customer.preferredDriverId,
        distributorId,
        assignmentDate: scheduledDate,
        isReconciled: false,
        status: 'dispatch_ready',
        driver: { status: 'active', availableToday: true },
      },
      select: { driverId: true, vehicleId: true },
    });
    if (assignment) {
      driverId = assignment.driverId;
      vehicleId = assignment.vehicleId;
      status = 'pending_dispatch';
    }
  }

  return prisma.$transaction(async (tx) => {
    const orderNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'O', scheduledDate, distributor.docCode)
      : legacyOrderNumber('RET');
    const order = await tx.order.create({
      data: {
        orderNumber,
        distributorId,
        customerId: data.customerId,
        driverId,
        vehicleId,
        orderDate: new Date(),
        deliveryDate: scheduledDate,
        status: status as $Enums.OrderStatus,
        orderType: 'returns_only',
        totalAmount: 0,
        specialInstructions: data.specialInstructions || null,
        items: { create: itemsData },
      },
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'new',
        newStatus: status,
        changedBy: userId,
        notes: 'Returns-only order created (empty cylinder pickup)',
      },
    });

    if (driverId) {
      await tx.driverAssignment.create({
        data: { orderId: order.id, driverId, assignedBy: userId },
      });
    }

    return order;
  });
}

export async function createOrderFromCancelledStock(
  distributorId: string,
  userId: string,
  data: {
    customerId: string;
    deliveryDate: string;
    cancelledStockEventId: string;
    specialInstructions?: string;
    poNumber?: string;
  }
) {
  // Verify cancelled stock is on a vehicle and available
  const cancelledStock = await prisma.cancelledStockEvent.findFirst({
    where: {
      id: data.cancelledStockEventId,
      distributorId,
      status: { in: ['on_vehicle', 'pending_return'] },
    },
    include: { cylinderType: { select: { id: true, typeName: true } } },
  });
  if (!cancelledStock) throw new OrderError('Cancelled stock not found or not available', 404);

  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, stopSupply: true },
  });
  if (!customer) throw new OrderError('Customer not found', 404);
  if (customer.stopSupply) throw new OrderError('Supply is stopped for this customer', 400);

  const deliveryDate = new Date(data.deliveryDate);
  // WI-108: structured number when docCode is set, else legacy random.
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId }, select: { docCode: true },
  });

  const unitPrice = await getEffectivePrice(distributorId, cancelledStock.cylinderTypeId, deliveryDate);
  const discount = await prisma.customerCylinderDiscount.findUnique({
    where: { customerId_cylinderTypeId: { customerId: data.customerId, cylinderTypeId: cancelledStock.cylinderTypeId } },
  });
  const discountPerUnit = toNum(discount?.discountPerUnit);
  const effectivePrice = Math.max(unitPrice - discountPerUnit, 0);
  const totalPrice = effectivePrice * cancelledStock.quantity;

  return prisma.$transaction(async (tx) => {
    const orderNumber = distributor?.docCode
      ? await allocateNumber(tx, distributorId, 'O', deliveryDate, distributor.docCode)
      : legacyOrderNumber('ORD');
    const order = await tx.order.create({
      data: {
        orderNumber,
        distributorId,
        customerId: data.customerId,
        driverId: cancelledStock.driverId,
        vehicleId: cancelledStock.vehicleId,
        orderDate: new Date(),
        deliveryDate,
        status: 'pending_delivery',  // Already on the vehicle, skip assignment/dispatch
        totalAmount: totalPrice,
        specialInstructions: data.specialInstructions || `From cancelled stock on vehicle`,
        poNumber: data.poNumber?.trim() || null,
        cancelledStockEventId: data.cancelledStockEventId,
        items: {
          create: [{
            cylinderTypeId: cancelledStock.cylinderTypeId,
            quantity: cancelledStock.quantity,
            unitPrice,
            discountPerUnit,
            totalPrice,
          }],
        },
      },
      include: orderInclude,
    });

    // Mark cancelled stock as being used
    await tx.cancelledStockEvent.update({
      where: { id: data.cancelledStockEventId },
      data: { status: 'reconciled', reconciledDate: new Date(), notes: `Tagged to order ${orderNumber}` },
    });

    await tx.orderStatusLog.create({
      data: {
        orderId: order.id,
        oldStatus: 'new',
        newStatus: 'pending_delivery',
        changedBy: userId,
        notes: `Order created from cancelled stock (already on vehicle)`,
      },
    });

    // Proof-of-collection Phase 3 (2026-07-15): auto-generate OTP if
    // the customer requires verification. Fire-and-forget after the
    // tx commits so an OTP hiccup can never block the order create.
    // generateOrRefreshOtp is a no-op when requireDeliveryVerification
    // is false, so this is safe for every customer.
    return order;
  }).then((order) => {
    generateOrRefreshOtp(distributorId, order.id, 'auto').catch((err) => {
      logger.warn('OTP auto-generation failed after cancelled-stock reroute', {
        orderId: order.id, err: (err as Error).message,
      });
    });
    return order;
  });
}

export async function updateOrder(
  id: string,
  distributorId: string,
  userId: string,
  data: {
    deliveryDate?: string;
    specialInstructions?: string;
    poNumber?: string;
    // Mini-Operator (2026-07-16): editable free-text driver name.
    driverNameFreeText?: string;
    items?: { cylinderTypeId: string; quantity: number }[];
  }
) {
  const order = await prisma.order.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: { items: true, customer: { select: { transportChargePerCylinder: true } } },
  });
  if (!order) throw new OrderError('Order not found', 404);
  if (['delivered', 'modified_delivered', 'cancelled'].includes(order.status)) {
    throw new OrderError('Cannot update an order that is delivered or cancelled', 400);
  }

  return prisma.$transaction(async (tx) => {
    const updateData: Prisma.OrderUpdateInput = {};
    if (data.deliveryDate) updateData.deliveryDate = new Date(data.deliveryDate);
    if (data.specialInstructions !== undefined) updateData.specialInstructions = data.specialInstructions;
    // PO is editable until invoice issue. Empty/whitespace input clears the
    // field (null), matching the trim+null-fold convention used at create.
    if (data.poNumber !== undefined) {
      updateData.poNumber = data.poNumber.trim() || null;
    }
    // Mini-Operator (2026-07-16): trim+null-fold mirrors poNumber above.
    if (data.driverNameFreeText !== undefined) {
      updateData.driverNameFreeText = data.driverNameFreeText.trim() || null;
    }

    if (data.items) {
      // Delete old items and create new ones
      await tx.orderItem.deleteMany({ where: { orderId: id } });

      const deliveryDate = data.deliveryDate ? new Date(data.deliveryDate) : order.deliveryDate;
      const itemsWithPrices = await Promise.all(data.items.map(async (item) => {
        const unitPrice = await getEffectivePrice(distributorId, item.cylinderTypeId, deliveryDate);
        const discount = await prisma.customerCylinderDiscount.findUnique({
          where: { customerId_cylinderTypeId: { customerId: order.customerId, cylinderTypeId: item.cylinderTypeId } },
        });
        const discountPerUnit = toNum(discount?.discountPerUnit);
        const totalPrice = Math.max(unitPrice - discountPerUnit, 0) * item.quantity;
        return { cylinderTypeId: item.cylinderTypeId, quantity: item.quantity, unitPrice, discountPerUnit, totalPrice };
      }));

      await tx.orderItem.createMany({
        data: itemsWithPrices.map(item => ({ orderId: id, ...item })),
      });

      updateData.totalAmount = computeOrderTotal(itemsWithPrices, toNum(order.customer?.transportChargePerCylinder));
    }

    const updated = await tx.order.update({
      where: { id },
      data: updateData,
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId: id,
        oldStatus: order.status,
        newStatus: order.status,
        changedBy: userId,
        notes: 'Order updated',
      },
    });

    // Trigger inventory recalculation for affected dates if items changed
    if (data.items) {
      // using static import
      const cylinderTypeIds = new Set([
        ...order.items.map(i => i.cylinderTypeId),
        ...data.items.map(i => i.cylinderTypeId),
      ]);
      const fromDate = data.deliveryDate
        ? new Date(Math.min(order.deliveryDate.getTime(), new Date(data.deliveryDate).getTime()))
        : order.deliveryDate;
      for (const ctId of cylinderTypeIds) {
        await recalculateSummariesFromDate(distributorId, ctId, fromDate);
      }
    }

    return updated;
  });
}

export async function assignDriver(
  orderId: string,
  distributorId: string,
  userId: string,
  data: { driverId: string; vehicleId?: string }
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
  });
  if (!order) throw new OrderError('Order not found', 404);
  if (order.isGodownPickup) {
    // Self-collection orders have no driver. Admin/finance closes them
    // via POST /api/orders/:id/confirm-delivery directly.
    throw new OrderError(
      'Cannot assign a driver to a godown pickup order. Use Confirm Delivery to record the customer collection.',
      400,
    );
  }
  if (!['pending_driver_assignment', 'pending_dispatch'].includes(order.status)) {
    throw new OrderError('Order is not in a state that allows driver assignment', 400);
  }

  // Verify driver belongs to distributor
  const driver = await prisma.driver.findFirst({
    where: { id: data.driverId, distributorId, status: 'active' },
  });
  if (!driver) throw new OrderError('Driver not found or inactive', 404);

  // Driver must have a confirmed vehicle mapping for the order's delivery
  // date before we accept the assignment. "Confirmed" here means a real
  // DriverVehicleAssignment row exists (not cancelled) — same definition the
  // recommendations API uses for status='confirmed'. The web client filters
  // its dropdown the same way; this guard catches direct API calls and
  // stale clients. The vehicle is always taken from the mapping; an explicit
  // vehicleId in the request body must match.
  const mapping = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId: data.driverId,
      distributorId,
      assignmentDate: order.deliveryDate,
      status: { not: 'cancelled' },
    },
    select: { vehicleId: true },
  });
  if (!mapping?.vehicleId) {
    throw new OrderError(
      'Driver has no confirmed vehicle mapping for the order delivery date. Please assign a vehicle in Fleet → Vehicle Mapping first.',
      400,
    );
  }
  if (data.vehicleId && data.vehicleId !== mapping.vehicleId) {
    throw new OrderError(
      "Provided vehicle does not match the driver's confirmed mapping for the delivery date.",
      400,
    );
  }
  const vehicleId = mapping.vehicleId;

  const result = await prisma.$transaction(async (tx) => {
    const oldStatus = order.status;
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        driverId: data.driverId,
        vehicleId,
        status: 'pending_dispatch',
      },
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus,
        newStatus: 'pending_dispatch',
        changedBy: userId,
        notes: `Driver ${driver.driverName} assigned`,
      },
    });

    await tx.driverAssignment.create({
      data: {
        orderId,
        driverId: data.driverId,
        assignedBy: userId,
      },
    });

    return updated;
  });

  // Push an SSE signal AFTER the tx commits. Fire-and-forget — notifyDriver
  // silently no-ops if the driver isn't connected, and a write failure
  // inside it just drops the stale connection. Doing this after commit
  // means a rollback can't cause a phantom signal that the driver would
  // chase with an empty fetch.
  notifyDriver(data.driverId, {
    type: 'order_assigned',
    payload: { orderId },
  });

  return result;
}

export async function bulkAssignDriver(
  distributorId: string,
  userId: string,
  data: { orderIds: string[]; driverId: string; vehicleId?: string }
) {
  const results = [];
  for (const orderId of data.orderIds) {
    try {
      const order = await assignDriver(orderId, distributorId, userId, {
        driverId: data.driverId,
        vehicleId: data.vehicleId,
      });
      results.push({ orderId, success: true, order });
    } catch (err: unknown) {
      results.push({ orderId, success: false, error: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return results;
}

export async function updateOrderStatus(
  orderId: string,
  distributorId: string,
  userId: string,
  newStatus: string,
  notes?: string
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    include: { items: true },
  });
  if (!order) throw new OrderError('Order not found', 404);

  // Validate status transitions
  const validTransitions: Record<string, string[]> = {
    pending_driver_assignment: ['pending_dispatch', 'cancelled'],
    pending_dispatch: ['pending_delivery', 'pending_driver_assignment', 'cancelled'],
    pending_delivery: ['delivered', 'modified_delivered', 'cancelled'],
    delivered: [],
    modified_delivered: [],
    returns_only: [],
    cancelled: [],
  };

  if (!validTransitions[order.status]?.includes(newStatus)) {
    throw new OrderError(`Cannot transition from ${order.status} to ${newStatus}`, 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    const updateData: Prisma.OrderUpdateInput = { status: newStatus as $Enums.OrderStatus };

    if (newStatus === 'cancelled') {
      updateData.cancelledAt = new Date();
      updateData.cancellationReason = notes || null;
    }

    if (['delivered', 'modified_delivered'].includes(newStatus)) {
      updateData.deliveredAt = new Date();
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: updateData,
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: order.status,
        newStatus,
        changedBy: userId,
        notes: notes || `Status changed to ${newStatus}`,
      },
    });

    return updated;
  });

  // Generate e-Way Bill on dispatch for GST-enabled distributors
  if (newStatus === 'pending_delivery') {
    try {
      const { generateDispatchEwb } = await import('./gst/gstService.js');
      generateDispatchEwb(orderId, distributorId).catch(err => {
        logger.warn('Dispatch EWB generation failed (non-blocking)', { orderId, error: err.message });
      });
    } catch { /* non-blocking */ }
  }

  return result;
}

export async function confirmDelivery(
  orderId: string,
  distributorId: string,
  userId: string,
  data: {
    items: { cylinderTypeId: string; deliveredQuantity: number; emptiesCollected: number }[];
    deliveryLatitude?: number;
    deliveryLongitude?: number;
    notes?: string;
  }
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    include: { items: true, customer: { select: { id: true, creditPeriodDays: true, transportChargePerCylinder: true } } },
  });
  if (!order) throw new OrderError('Order not found', 404);
  // Returns-only orders are confirmed through the same endpoint — the
  // confirmation modal in the frontend always POSTs to /confirm-delivery,
  // regardless of order type. Delegate to confirmReturnsCollection with the
  // delivery-shape body mapped to a returns-shape body (the "Return Qty"
  // input on the modal binds to deliveredQuantity for both order types,
  // so that's the value we use as collectedQuantity).
  if (order.orderType === 'returns_only') {
    return confirmReturnsCollection(orderId, distributorId, userId, {
      items: data.items.map((i) => ({
        cylinderTypeId: i.cylinderTypeId,
        collectedQuantity: i.deliveredQuantity,
      })),
      notes: data.notes,
    });
  }

  // Idempotency: a duplicate confirmation (e.g. driver retries after uncertain
  // network) must not create a second delivery record. If the order is already
  // delivered/modified_delivered, compare submitted quantities to the stored
  // delivered quantities.
  //   - exact match → return the existing order (200, no-op)
  //   - mismatch    → 409 conflict
  if (['delivered', 'modified_delivered'].includes(order.status)) {
    const mismatch = data.items.some((di) => {
      const oi = order.items.find((i) => i.cylinderTypeId === di.cylinderTypeId);
      if (!oi) return true;
      return (oi.deliveredQuantity ?? 0) !== di.deliveredQuantity
        || (oi.emptiesCollected ?? 0) !== di.emptiesCollected;
    });
    if (mismatch) {
      throw new OrderError(
        'Order already delivered with different quantities. Cannot reconcile a duplicate confirmation.',
        409,
      );
    }
    // Exact duplicate — return current order without side effects
    return prisma.order.findFirstOrThrow({
      where: { id: orderId, distributorId },
      include: orderInclude,
    });
  }

  if (!['pending_delivery', 'pending_dispatch'].includes(order.status)) {
    throw new OrderError('Order is not in a deliverable state', 400);
  }

  // WI-087 BUG FIX: Block delivery confirmation if vehicle has already been
  // returned to depot. Once returned, undelivered orders must be handled via
  // Inventory → Reconciliation (confirmVehicleReconciliation), not confirmed
  // as delivered — the physical cylinder is back at depot, not delivered.
  if (order.vehicleId) {
    const vehicle = await prisma.vehicle.findFirst({
      where: { id: order.vehicleId, distributorId },
      select: { status: true, vehicleNumber: true },
    });
    if (vehicle?.status === 'returned') {
      throw new OrderError(
        `Cannot confirm delivery — vehicle ${vehicle.vehicleNumber} has already been returned to depot. Process this order via Inventory → Vehicle Reconciliation instead.`,
        409,
      );
    }
  }

  // Per-item bounds check: the delivery payload must not claim a delivered
  // qty greater than what was on the order, must reference items that exist
  // on the order, and emptiesCollected must be non-negative. The Zod schema
  // (deliveryConfirmationSchema) only guarantees min(0) — the upper bound
  // requires the order context, so it lives here. Without this, a driver
  // tap-fumble (or buggy modal) could write delivered=2 against an order
  // of 1, producing physically impossible inventory math (on-vehicle = -1)
  // and leaving inventory_summaries inconsistent. Real incident:
  // OSHD2627000403 on 2026-06-01 (dist-002, 425KG).
  for (const di of data.items) {
    const oi = order.items.find(i => i.cylinderTypeId === di.cylinderTypeId);
    if (!oi) {
      throw new OrderError(
        `Cylinder type ${di.cylinderTypeId} is not on this order`,
        400,
      );
    }
    if (di.deliveredQuantity > oi.quantity) {
      throw new OrderError(
        `Delivered quantity (${di.deliveredQuantity}) cannot exceed ordered quantity (${oi.quantity})`,
        400,
      );
    }
    if (di.emptiesCollected < 0) {
      throw new OrderError('emptiesCollected must be greater than or equal to 0', 400);
    }
  }

  // GODOWN PICKUP — INSUFFICIENT_STOCK gate. The normal flow checks stock
  // at preflight (gstPreflightService.ts) and refuses to dispatch if depot
  // closingFulls < delivered qty. Godown skips preflight, so the only
  // place to catch insufficient stock is here. Without this guard a
  // pickup could drive closingFulls negative.
  if (order.isGodownPickup) {
    for (const item of data.items) {
      if (item.deliveredQuantity <= 0) continue;
      const summary = await prisma.inventorySummary.findFirst({
        where: { distributorId, cylinderTypeId: item.cylinderTypeId },
        orderBy: { summaryDate: 'desc' },
        select: { closingFulls: true },
      });
      const available = summary?.closingFulls ?? 0;
      if (available < item.deliveredQuantity) {
        throw new OrderError(
          `Insufficient stock: ${available} available, ${item.deliveredQuantity} requested`,
          400,
        );
      }
    }
  }

  // `<` (not `!==`) — defence in depth. After the bounds check above,
  // deliveredQuantity > ordered can no longer happen, but the `<`
  // wording makes the intent explicit.
  const isModified = data.items.some(di => {
    const oi = order.items.find(i => i.cylinderTypeId === di.cylinderTypeId);
    return oi && di.deliveredQuantity < oi.quantity;
  });
  const newStatus = isModified ? 'modified_delivered' : 'delivered';

  const result = await prisma.$transaction(async (tx) => {
    // Update order items with delivery data
    for (const item of data.items) {
      const orderItem = order.items.find(i => i.cylinderTypeId === item.cylinderTypeId);
      if (orderItem) {
        await tx.orderItem.update({
          where: { id: orderItem.id },
          data: {
            deliveredQuantity: item.deliveredQuantity,
            emptiesCollected: item.emptiesCollected,
          },
        });
      }
    }

    // Recalculate total based on delivered quantities + transport fee
    // (same basis the invoice line uses at delivery time, so post-delivery
    // order.totalAmount stays apples-to-apples with invoice.totalAmount).
    const deliveredLines = data.items.map((item) => {
      const orderItem = order.items.find(i => i.cylinderTypeId === item.cylinderTypeId);
      const effectivePrice = orderItem
        ? Math.max(toNum(orderItem.unitPrice) - toNum(orderItem.discountPerUnit), 0)
        : 0;
      return {
        quantity: item.deliveredQuantity,
        totalPrice: effectivePrice * item.deliveredQuantity,
      };
    });
    const newTotal = computeOrderTotal(deliveredLines, toNum(order.customer?.transportChargePerCylinder));

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus as $Enums.OrderStatus,
        totalAmount: newTotal,
        deliveredAt: new Date(),
        deliveryLatitude: data.deliveryLatitude || null,
        deliveryLongitude: data.deliveryLongitude || null,
        deliveryNotes: data.notes || null,
      },
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: order.status,
        newStatus,
        changedBy: userId,
        notes: data.notes || 'Delivery confirmed',
      },
    });

    // Create inventory events for delivery
    // using static import
    for (const item of data.items) {
      if (item.deliveredQuantity > 0) {
        // GODOWN PICKUP — write a SYNTHETIC dispatch inventory event here.
        // The normal flow has gstPreflightService.preflightDispatch write
        // the dispatch event (which drives InventorySummary.dispatchedQty).
        // Godown orders skip preflight entirely, so without this synthetic
        // event closingFulls would never debit. Under the production
        // `INVENTORY_DISPATCH_DEBIT=true` flag depot stock would inflate by
        // every godown pickup. Reference: TRANSACTION AUDIT in
        // docs/GODOWN-PICKUP-INVESTIGATION.md, Step C.
        if (order.isGodownPickup) {
          await createInventoryEvent(tx, {
            distributorId,
            cylinderTypeId: item.cylinderTypeId,
            eventType: 'dispatch',
            fullsChange: -item.deliveredQuantity,
            emptiesChange: 0,
            eventDate: order.deliveryDate,
            referenceId: orderId,
            referenceType: 'godown_pickup',
            createdBy: userId,
            notes: `Godown pickup ${order.orderNumber} — synthetic dispatch event`,
          });
        }
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'delivery',
          fullsChange: -item.deliveredQuantity,
          emptiesChange: 0,
          eventDate: order.deliveryDate,
          referenceId: orderId,
          referenceType: 'order',
          createdBy: userId,
          notes: `Order ${order.orderNumber} delivery`,
        });
      }
      if (item.emptiesCollected > 0) {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'collection',
          fullsChange: 0,
          emptiesChange: item.emptiesCollected,
          eventDate: order.deliveryDate,
          referenceId: orderId,
          referenceType: 'order',
          createdBy: userId,
          notes: `Order ${order.orderNumber} empties collected`,
        });
        // GODOWN PICKUP — write a SYNTHETIC reconciliation_empties_return
        // event too. Under the new inventory model (inventoryService.ts:194)
        // closingEmpties is fed ONLY by reconciliation_empties_return events
        // (supervisor-verified at vehicle return). Godown pickup never has
        // a vehicle return, so without this synthetic event the collected
        // empties get stuck in `emptiesOnVehicle` forever (computed as
        // collectedEmpties − emptiesReturnedVerified = N − 0 = N) and
        // closingEmpties never credits.
        //
        // Symptom hit on 2026-06-25 (OSHD2627000747, Maruthi 19 KG):
        // 2 empties collected via godown stayed "on vehicle" while
        // closingEmpties was undercounted by 2.
        if (order.isGodownPickup) {
          await createInventoryEvent(tx, {
            distributorId,
            cylinderTypeId: item.cylinderTypeId,
            eventType: 'reconciliation_empties_return',
            fullsChange: 0,
            emptiesChange: item.emptiesCollected,
            eventDate: order.deliveryDate,
            referenceId: orderId,
            referenceType: 'godown_pickup',
            createdBy: userId,
            notes: `Godown pickup ${order.orderNumber} — synthetic empties return (no vehicle reconcile)`,
          });
        }
      }

      // Update customer inventory balance
      await tx.customerInventoryBalance.upsert({
        where: {
          customerId_cylinderTypeId: {
            customerId: order.customerId,
            cylinderTypeId: item.cylinderTypeId,
          },
        },
        create: {
          customerId: order.customerId,
          cylinderTypeId: item.cylinderTypeId,
          withCustomerQty: item.deliveredQuantity - item.emptiesCollected,
        },
        update: {
          withCustomerQty: { increment: item.deliveredQuantity - item.emptiesCollected },
        },
      });
    }

    // Handle cancelled stock if deliveredQuantity < ordered quantity
    for (const item of data.items) {
      const orderItem = order.items.find(i => i.cylinderTypeId === item.cylinderTypeId);
      if (orderItem && item.deliveredQuantity < orderItem.quantity) {
        const cancelledQty = orderItem.quantity - item.deliveredQuantity;
        // Status precedence:
        //   - godown pickup: cylinders never left the depot, so they go
        //     STRAIGHT to returned_to_depot. There's no vehicle to
        //     reconcile against and no on_vehicle phase ever happened.
        //   - has vehicle: on_vehicle (existing flow — reconciliation
        //     later rolls it to returned_to_depot)
        //   - no vehicle and not godown: legacy pending_return path
        const cancelledStatus = order.isGodownPickup
          ? 'returned_to_depot'
          : order.vehicleId
            ? 'on_vehicle'
            : 'pending_return';
        await tx.cancelledStockEvent.create({
          data: {
            orderId,
            vehicleId: order.vehicleId,
            driverId: order.driverId,
            cylinderTypeId: item.cylinderTypeId,
            distributorId,
            quantity: cancelledQty,
            cancellationDate: order.deliveryDate,
            status: cancelledStatus,
          },
        });
      }
    }

    // Auto-create invoice
    try {
      // using static import
      await createInvoiceFromOrder(tx, orderId, distributorId, userId);
    } catch {
      // Non-blocking - invoice creation failure must not fail delivery
    }

    // WI-096b: the DVA trip roll (tripNumber++ + clear timestamps/trip-sheet,
    // status → dispatch_ready) used to happen HERE, at the last delivery
    // confirmation (WI-068/070). That rolled the trip too early — the instant
    // the driver delivered the last order the DVA snapped to a new EMPTY trip,
    // which (a) hid the "Mark Vehicle Returned" button (DVA was no longer
    // loaded_and_dispatched), (b) cleared dispatchedAt, and (c) mis-scoped the
    // driver app's Compliance Docs / Vehicle Stock to an empty trip.
    //
    // The roll now lives ONLY at the START of the next dispatch
    // (gstPreflightService.preflightDispatch — the loaded_and_dispatched +
    // 0-in-flight branch). After the last delivery the DVA STAYS
    // loaded_and_dispatched at the same tripNumber, preserving the return /
    // reconcile flow and the trip timeline. Safe because the dispatch-vs-add-to-
    // trip decision already keys on in-flight order count, not DVA.status
    // (orders.ts /in-transit, WI-069): a "stuck" loaded_and_dispatched DVA with
    // 0 in-flight orders drops out of "In Transit" and the next Dispatch click
    // self-heals via the preflight roll.

    return updated;
  });

  // Recalculate summaries AFTER transaction commits so events are visible
  for (const item of data.items) {
    await recalculateSummariesFromDate(distributorId, item.cylinderTypeId, order.deliveryDate);
  }

  // Process GST compliance (non-blocking) — only if GST is enabled
  try {
    const invoice = await prisma.invoice.findFirst({
      where: { orderId, deletedAt: null },
      select: { id: true, irnStatus: true, ewbStatus: true },
    });
    if (invoice) {
      // WI-037: if the invoice already has a live IRN or EWB (pre-dispatch
      // preflight ran) AND the delivery is modified, run the reissue flow
      // instead of generating fresh compliance docs from scratch.
      // Otherwise fall back to the original post-delivery GST trigger.
      const hasLiveGstDoc = invoice.irnStatus === 'success' || invoice.ewbStatus === 'active';
      // Fast-path: if preflight already produced full B2B compliance
      // (IRN success + EWB active) AND the delivery is unmodified, skip the
      // duplicate NIC round-trip that would otherwise fire a 2150 error
      // and raise a spurious IRN_GENERATION pending action. Auto-resolve
      // any stale open PAs (usually preflight-era EWB partial-failure rows
      // that were never cleared) since the invoice is now compliant.
      // B2C stays on the processInvoiceGst path (irnStatus='not_attempted'
      // by design — no IRN needed) — processInvoiceGst handles B2C gracefully.
      const fullyCompliant =
        invoice.irnStatus === 'success' && invoice.ewbStatus === 'active';
      if (fullyCompliant && !isModified) {
        prisma.pendingAction.updateMany({
          where: {
            distributorId,
            entityId: invoice.id,
            actionType: { in: ['IRN_GENERATION', 'EWB_GENERATION'] },
            status: 'open',
          },
          data: {
            status: 'resolved',
            resolvedAt: new Date(),
            resolvedBy: 'system',
            resolutionNotes: 'Auto-resolved: IRN+EWB already active at delivery confirmation',
          },
        }).catch((err) => {
          logger.warn('Auto-resolve stale PAs failed (non-blocking)', { orderId, error: err.message });
        });
      } else if (isModified && hasLiveGstDoc) {
        const { reissueForDeliveryMismatch } = await import('./gst/gstReissueService.js');
        reissueForDeliveryMismatch({
          invoiceId: invoice.id,
          distributorId,
          userId,
          mismatchContext: { orderId, source: 'confirmDelivery' },
        }).catch((err) => {
          logger.warn('Delivery-mismatch reissue failed (non-blocking)', { orderId, error: err.message });
        });
      } else {
        const { processInvoiceGst } = await import('./gst/gstService.js');
        // Fire and forget — don't block delivery confirmation on GST
        processInvoiceGst(invoice.id, distributorId).catch(err => {
          logger.warn('GST processing failed (non-blocking)', { orderId, error: err.message });
        });
      }
    }
  } catch { /* GST processing is non-blocking */ }

  // Signal the driver app so the "My Deliveries" list updates without
  // waiting for the next refetch. order.driverId is captured pre-tx and
  // can't have changed (confirmDelivery is the terminal status write).
  if (order.driverId) {
    notifyDriver(order.driverId, {
      type: 'order_updated',
      payload: { orderId, status: 'delivered' },
    });
  }

  return result;
}

export async function confirmReturnsCollection(
  orderId: string,
  distributorId: string,
  userId: string,
  data: {
    items: { cylinderTypeId: string; collectedQuantity: number }[];
    notes?: string;
  }
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null, orderType: 'returns_only' },
    include: { items: true, customer: { select: { id: true } } },
  });
  if (!order) throw new OrderError('Returns order not found', 404);
  if (!['pending_delivery', 'pending_dispatch'].includes(order.status)) {
    throw new OrderError('Order is not in a collectable state', 400);
  }

  const result = await prisma.$transaction(async (tx) => {
    // Update order items with collected data
    for (const item of data.items) {
      const orderItem = order.items.find(i => i.cylinderTypeId === item.cylinderTypeId);
      if (orderItem) {
        await tx.orderItem.update({
          where: { id: orderItem.id },
          data: { emptiesCollected: item.collectedQuantity },
        });
      }
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        // Returns-only and delivery orders share the "completed" final
        // status — orderType already distinguishes the two; doubling that
        // up on status was redundant and gave the order list two terminal
        // states for the same concept.
        status: 'delivered',
        deliveredAt: new Date(),
        deliveryNotes: data.notes || null,
      },
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: order.status,
        newStatus: 'delivered',
        changedBy: userId,
        notes: data.notes || 'Empty cylinders collected',
      },
    });

    // Create inventory events for collection
    // using static import
    for (const item of data.items) {
      if (item.collectedQuantity > 0) {
        await createInventoryEvent(tx, {
          distributorId,
          cylinderTypeId: item.cylinderTypeId,
          eventType: 'returns_collection',
          fullsChange: 0,
          emptiesChange: item.collectedQuantity,
          eventDate: order.deliveryDate,
          referenceId: orderId,
          referenceType: 'order',
          createdBy: userId,
          notes: `Returns order ${order.orderNumber} - empties collected`,
        });

        // Update customer inventory balance (reduce empties with customer)
        await tx.customerInventoryBalance.upsert({
          where: {
            customerId_cylinderTypeId: {
              customerId: order.customerId,
              cylinderTypeId: item.cylinderTypeId,
            },
          },
          create: {
            customerId: order.customerId,
            cylinderTypeId: item.cylinderTypeId,
            withCustomerQty: -item.collectedQuantity,
          },
          update: {
            withCustomerQty: { decrement: item.collectedQuantity },
          },
        });
      }
    }

    // NO invoice creation for returns-only orders

    return updated;
  });

  // Recalculate summaries AFTER transaction commits so events are visible
  for (const item of data.items) {
    await recalculateSummariesFromDate(distributorId, item.cylinderTypeId, order.deliveryDate);
  }

  if (order.driverId) {
    notifyDriver(order.driverId, {
      type: 'order_updated',
      payload: { orderId, status: 'delivered' },
    });
  }

  return result;
}

export async function cancelOrder(
  orderId: string,
  distributorId: string,
  userId: string,
  reason: string
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    include: {
      items: true,
      invoice: { select: { id: true, status: true, irnStatus: true, ewbStatus: true } },
    },
  });
  if (!order) throw new OrderError('Order not found', 404);
  if (['delivered', 'modified_delivered', 'cancelled'].includes(order.status)) {
    throw new OrderError('Cannot cancel a delivered or already cancelled order', 400);
  }

  // STEP 1: Block if payment allocation exists (before any changes)
  const invoiceId = order.invoice?.id ?? null;
  if (invoiceId) {
    const paymentCount = await prisma.paymentAllocation.count({
      where: { invoiceId },
    });
    if (paymentCount > 0) {
      throw new OrderError(
        'Cannot cancel order with recorded payments. Please handle the payment in Billing & Payments first.',
        409,
      );
    }
  }

  // STEP 2: Cancel EWB at NIC (outside TX — external API)
  // WI-086: Evict the token cache ONCE before the whole EWB+IRN cancel
  // sequence. Both cancel calls then share the same fresh NIC session.
  // Doing it inside each function separately caused two auth calls <1 s
  // apart — NIC rejected the second token with 1004 (SESSION_EXPIRED).
  if (invoiceId && (order.invoice?.ewbStatus === 'active' || order.invoice?.irnStatus === 'success')) {
    const { clearTokenCache } = await import('./gst/whitebooksClient.js');
    clearTokenCache(distributorId);
  }

  if (invoiceId && order.invoice?.ewbStatus === 'active') {
    try {
      const { cancelEwb } = await import('./gst/gstService.js');
      // Order-cancel path uses NIC code '3' (Order Cancelled) — that's
      // the most accurate semantic mapping for this code path.
      await cancelEwb(invoiceId, distributorId, `Order cancelled: ${reason}`, '3', userId);
    } catch (_ewbErr) {
      await prisma.pendingAction.create({
        data: {
          distributorId,
          module: 'gst_compliance',
          actionType: 'EWB_CANCEL_FAILED',
          entityId: invoiceId,
          entityType: 'invoice',
          description: `EWB cancellation failed for cancelled order ${order.orderNumber}. Manual cancellation required at NIC portal.`,
          severity: 'high',
          status: 'open',
        },
      });
    }
  }

  // STEP 3: Cancel IRN at NIC (outside TX — external API)
  if (invoiceId && order.invoice?.irnStatus === 'success') {
    const freshInvoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { ewbStatus: true },
    });
    if (freshInvoice?.ewbStatus === 'active') {
      await prisma.pendingAction.create({
        data: {
          distributorId,
          module: 'gst_compliance',
          actionType: 'IRN_CANCEL_SKIPPED',
          entityId: invoiceId,
          entityType: 'invoice',
          description: `IRN cancellation skipped — EWB still active for cancelled order ${order.orderNumber}. Handle manually.`,
          severity: 'high',
          status: 'open',
        },
      });
    } else {
      try {
        const { cancelIrn } = await import('./gst/gstService.js');
        await cancelIrn(invoiceId, distributorId, `Order cancelled: ${reason}`, '3', userId);
      } catch (_irnErr) {
        // Mark invoice so the PDF shows an amber badge and the UI shows a warning pill.
        await prisma.invoice.update({
          where: { id: invoiceId },
          data: { irnStatus: 'cancel_failed' },
        });
        await prisma.pendingAction.create({
          data: {
            distributorId,
            module: 'gst_compliance',
            actionType: 'IRN_CANCEL_FAILED',
            entityId: invoiceId,
            entityType: 'invoice',
            description: `IRN cancellation failed for cancelled order ${order.orderNumber}. Raise credit note manually if within same financial year.`,
            severity: 'high',
            status: 'open',
          },
        });
      }
    }
  }

  // STEPS 4-6 + original cancel logic: single TX
  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: 'cancelled',
        cancelledAt: new Date(),
        cancellationReason: reason,
        vehicleId: null, // STEP 6: detach vehicle from order
      },
      include: orderInclude,
    });

    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: order.status,
        newStatus: 'cancelled',
        changedBy: userId,
        notes: `Cancelled: ${reason}`,
      },
    });

    // Create cancelled stock events if order was in dispatch/delivery state.
    // WI-083a2 — GAP 2: CSE MUST be created as 'on_vehicle'. The only code
    // that may write 'returned_to_depot' is returnCancelledStock (manual return)
    // or reconcileVehicle Step 1 (end-of-trip). Never set it here directly.
    if (['pending_dispatch', 'pending_delivery'].includes(order.status) && order.vehicleId) {
      // WI-106: under the dispatch-debit model, `order.status` (the pre-cancel
      // status) discriminates physical location — NOT order.vehicleId, which is
      // set at assign time (pending_dispatch) before any dispatch.
      //   - pending_delivery (Case A): cylinders were dispatched (already
      //     debited). Keep the CSE so reconciliation's cancellation_return
      //     credits them back; SKIP the +qty cancellation event (would double).
      //   - pending_dispatch (Case B): assigned but never dispatched — cylinders
      //     never left the depot. Create NEITHER a CSE nor a cancellation event.
      // Flag OFF: both branches below run unchanged (CSE + cancellation event).
      const dispatchDebit = isDispatchDebitEnabled(distributorId);
      for (const item of order.items) {
        if (dispatchDebit && order.status === 'pending_dispatch') {
          continue; // Case B — nothing physically on the vehicle.
        }

        await tx.cancelledStockEvent.create({
          data: {
            orderId,
            vehicleId: order.vehicleId,
            driverId: order.driverId,
            cylinderTypeId: item.cylinderTypeId,
            distributorId,
            quantity: item.quantity,
            cancellationDate: order.deliveryDate,
            status: 'on_vehicle',
          },
        });

        if (!dispatchDebit) {
          await createInventoryEvent(tx, {
            distributorId,
            cylinderTypeId: item.cylinderTypeId,
            eventType: 'cancellation',
            fullsChange: item.quantity,
            emptiesChange: 0,
            eventDate: order.deliveryDate,
            referenceId: orderId,
            referenceType: 'order',
            createdBy: userId,
            notes: `Order ${order.orderNumber} cancelled`,
          });
        }
      }
    }

    // STEP 4: Void the invoice (preserve irnStatus/ewbStatus already updated by GST calls)
    // WI-123: a cancelled invoice owes nothing — zero its outstanding so it
    // never shows a balance in the portal/collections.
    if (invoiceId) {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'cancelled', outstandingAmount: 0 },
      });
    }

    // STEP 5: Reverse CustomerLedgerEntry
    if (invoiceId) {
      const ledgerEntry = await tx.customerLedgerEntry.findFirst({
        where: { invoiceId, entryType: 'invoice_entry' as $Enums.LedgerEntryType },
      });
      if (ledgerEntry) {
        await tx.customerLedgerEntry.create({
          data: {
            customerId: ledgerEntry.customerId,
            distributorId: ledgerEntry.distributorId,
            entryType: 'adjustment' as $Enums.LedgerEntryType,
            referenceId: orderId,
            invoiceId: ledgerEntry.invoiceId,
            amountDelta: -(toNum(ledgerEntry.amountDelta)),
            narration: `Order cancelled: ${order.orderNumber}`,
            entryDate: new Date(),
            createdBy: userId,
          },
        });
      }
    }

    // STEP 6: Release DVA / trip
    if (order.driverId) {
      const dva = await tx.driverVehicleAssignment.findFirst({
        where: {
          driverId: order.driverId,
          distributorId,
          assignmentDate: order.deliveryDate,
          isReconciled: false,
          status: { notIn: ['cancelled'] as $Enums.AssignmentStatus[] },
        },
      });
      if (dva) {
        const activeOrders = await tx.order.count({
          where: {
            distributorId,
            driverId: order.driverId,
            deliveryDate: order.deliveryDate,
            status: { in: ['pending_dispatch', 'pending_delivery', 'preflight_in_progress'] as $Enums.OrderStatus[] },
            id: { not: orderId },
            deletedAt: null,
          },
        });
        // WI-130: don't roll the DVA closed while cancelled cylinders are still
        // physically on the vehicle. Cancelling the LAST live order used to flip
        // the DVA to dispatch_ready even though this cancel may have just put a
        // cylinder on the truck (CSE status on_vehicle, created above in this
        // same tx) — stranding it because mark-vehicle-returned then 409s on an
        // already-"completed" trip. Keep the DVA loaded_and_dispatched so the
        // normal return → reconcile flow processes the CSE. `order.vehicleId` is
        // the pre-cancel value (the in-memory order is untouched by the cancel
        // update above). Counts within the tx so it sees the just-created CSE.
        const capturedVehicleId = order.vehicleId;
        const onVehicleCse = capturedVehicleId
          ? await tx.cancelledStockEvent.count({
              where: { vehicleId: capturedVehicleId, distributorId, status: 'on_vehicle' },
            })
          : 0;
        const dvaUpdates: Record<string, unknown> = {};
        // WI-102: do NOT decrement tripNumber here. Under WI-096b's per-order
        // tripNumber scoping, decrementing makes the DVA point at trip N-1,
        // hiding other live orders still on trip N. Only flip status to
        // dispatch_ready once no live orders remain (trip genuinely complete)
        // AND no cancelled stock is still on the vehicle (WI-130).
        if (activeOrders === 0 && onVehicleCse === 0 && ['loaded_and_dispatched', 'dispatch_ready'].includes(dva.status as string)) {
          dvaUpdates.status = 'dispatch_ready';
        }
        if (Object.keys(dvaUpdates).length > 0) {
          await tx.driverVehicleAssignment.update({
            where: { id: dva.id },
            data: dvaUpdates,
          });
        }
      }
    }

    return updated;
  });
}

/**
 * WI-127: admin resolves a customer dispute on an order, optionally issuing a
 * credit note. Stamps disputeResolvedAt + disputeResolutionNote and resolves
 * the linked CUSTOMER_DISPUTE pending action.
 */
export async function resolveDispute(
  orderId: string,
  distributorId: string,
  userId: string,
  data: {
    resolutionNote: string;
    issueCreditNote?: boolean;
    creditNoteAmount?: number;
    creditNoteReason?: string;
  },
) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, distributorId, deletedAt: null },
    include: { invoice: { select: { id: true } } },
  });
  if (!order) throw new OrderError('Order not found', 404);
  if (!order.customerDisputeReason || order.disputeResolvedAt != null) {
    throw new OrderError('No open dispute on this order', 400);
  }

  let creditNoteId: string | undefined;
  let note = data.resolutionNote;

  if (data.issueCreditNote) {
    if (!order.invoice) throw new OrderError('No invoice exists for this order to credit', 400);
    if (!data.creditNoteAmount || data.creditNoteAmount <= 0) {
      throw new OrderError('A positive credit note amount is required', 400);
    }
    if (!data.creditNoteReason) throw new OrderError('A credit note reason is required', 400);
    const { createCreditNote, approveCreditNote } = await import('./invoiceService.js');
    const cn = await createCreditNote(distributorId, userId, {
      invoiceId: order.invoice.id,
      reason: data.creditNoteReason,
      amount: data.creditNoteAmount,
    });
    await approveCreditNote(cn.id, distributorId, userId);
    creditNoteId = cn.id;
    note = `${note}\nCredit note of ₹${data.creditNoteAmount} issued.`;
  }

  const now = new Date();
  await prisma.order.update({
    where: { id: orderId },
    data: { disputeResolvedAt: now, disputeResolutionNote: note },
  });
  await prisma.pendingAction.updateMany({
    where: {
      distributorId, entityType: 'order', entityId: orderId,
      actionType: 'CUSTOMER_DISPUTE', status: { in: ['open', 'in_progress'] },
    },
    data: { status: 'resolved', resolvedBy: userId, resolvedAt: now, resolutionNotes: note },
  });

  return { resolvedAt: now, creditNoteId };
}

export class OrderError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'OrderError';
  }
}
