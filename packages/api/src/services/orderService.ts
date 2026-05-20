import { prisma } from '../lib/prisma.js';
import type { Prisma } from '@prisma/client';
import { getEffectivePrice } from './cylinderTypeService.js';
import { createInventoryEvent, recalculateSummariesFromDate } from './inventoryService.js';
import { createInvoiceFromOrder } from './invoiceService.js';
import { logger } from '../utils/logger.js';
import { toNum } from '../utils/decimal.js';

const orderInclude = {
  customer: { select: { id: true, customerName: true, stopSupply: true, creditPeriodDays: true } },
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
  if (filters.status) where.status = filters.status as any;
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
    items: { cylinderTypeId: string; quantity: number }[];
  }
) {
  // Validate customer belongs to distributor and supply is not stopped
  const customer = await prisma.customer.findFirst({
    where: { id: data.customerId, distributorId, deletedAt: null },
    select: { id: true, stopSupply: true, preferredDriverId: true },
  });
  if (!customer) throw new OrderError('Customer not found', 404);
  if (customer.stopSupply) throw new OrderError('Supply is stopped for this customer', 400);

  const deliveryDate = new Date(data.deliveryDate);
  const orderNumber = `ORD-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

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

  const totalAmount = itemsWithPrices.reduce((sum, item) => sum + item.totalPrice, 0);

  // Check preferred driver availability
  let driverId: string | null = null;
  let vehicleId: string | null = null;
  let status: string = 'pending_driver_assignment';

  if (customer.preferredDriverId) {
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
    const order = await tx.order.create({
      data: {
        orderNumber,
        distributorId,
        customerId: data.customerId,
        driverId,
        vehicleId,
        orderDate: new Date(),
        deliveryDate,
        status: status as any,
        totalAmount,
        specialInstructions: data.specialInstructions || null,
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
  const orderNumber = `RET-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

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
    const order = await tx.order.create({
      data: {
        orderNumber,
        distributorId,
        customerId: data.customerId,
        driverId,
        vehicleId,
        orderDate: new Date(),
        deliveryDate: scheduledDate,
        status: status as any,
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
  const orderNumber = `ORD-${(Date.now().toString(36) + Math.random().toString(36).substring(2, 5)).toUpperCase()}`;

  const unitPrice = await getEffectivePrice(distributorId, cancelledStock.cylinderTypeId, deliveryDate);
  const discount = await prisma.customerCylinderDiscount.findUnique({
    where: { customerId_cylinderTypeId: { customerId: data.customerId, cylinderTypeId: cancelledStock.cylinderTypeId } },
  });
  const discountPerUnit = toNum(discount?.discountPerUnit);
  const effectivePrice = Math.max(unitPrice - discountPerUnit, 0);
  const totalPrice = effectivePrice * cancelledStock.quantity;

  return prisma.$transaction(async (tx) => {
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
    items?: { cylinderTypeId: string; quantity: number }[];
  }
) {
  const order = await prisma.order.findFirst({
    where: { id, distributorId, deletedAt: null },
    include: { items: true },
  });
  if (!order) throw new OrderError('Order not found', 404);
  if (['delivered', 'modified_delivered', 'cancelled'].includes(order.status)) {
    throw new OrderError('Cannot update an order that is delivered or cancelled', 400);
  }

  return prisma.$transaction(async (tx) => {
    const updateData: Prisma.OrderUpdateInput = {};
    if (data.deliveryDate) updateData.deliveryDate = new Date(data.deliveryDate);
    if (data.specialInstructions !== undefined) updateData.specialInstructions = data.specialInstructions;

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

      updateData.totalAmount = itemsWithPrices.reduce((sum, item) => sum + item.totalPrice, 0);
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

  return prisma.$transaction(async (tx) => {
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
    } catch (err: any) {
      results.push({ orderId, success: false, error: err.message });
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
    const updateData: Prisma.OrderUpdateInput = { status: newStatus as any };

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
    include: { items: true, customer: { select: { id: true, creditPeriodDays: true } } },
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

  const isModified = data.items.some(di => {
    const oi = order.items.find(i => i.cylinderTypeId === di.cylinderTypeId);
    return oi && di.deliveredQuantity !== oi.quantity;
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

    // Recalculate total based on delivered quantities
    let newTotal = 0;
    for (const item of data.items) {
      const orderItem = order.items.find(i => i.cylinderTypeId === item.cylinderTypeId);
      if (orderItem) {
        const effectivePrice = Math.max(toNum(orderItem.unitPrice) - toNum(orderItem.discountPerUnit), 0);
        newTotal += effectivePrice * item.deliveredQuantity;
      }
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: {
        status: newStatus as any,
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
        await tx.cancelledStockEvent.create({
          data: {
            orderId,
            vehicleId: order.vehicleId,
            driverId: order.driverId,
            cylinderTypeId: item.cylinderTypeId,
            distributorId,
            quantity: cancelledQty,
            cancellationDate: order.deliveryDate,
            status: order.vehicleId ? 'on_vehicle' : 'pending_return',
          },
        });
      }
    }

    // Auto-create invoice
    try {
      // using static import
      await createInvoiceFromOrder(tx, orderId, distributorId, userId);
    } catch (invoiceErr) {
      // Non-blocking - log but don't fail delivery
    }

    // WI-068: auto-reset DVA when this was the LAST in-flight order of
    // the trip. Without this, the DVA sits in 'loaded_and_dispatched'
    // forever after the last delivery, so the next dispatch click
    // shows "+ Add to Trip" instead of "Dispatch ▶". The investigation
    // report on 2026-05-19 traced today's 3 orders all stamped with
    // tripNumber=1 to exactly this gap: each dispatch went through
    // /preflight-add-to-trip because the DVA never advanced.
    //
    // Scope: count pending_delivery + preflight_in_progress for the
    // SAME (driverId, distributorId, deliveryDate, tripNumber). If zero
    // remain (i.e. this update we just committed was the last one),
    // bump the DVA back to dispatch_ready inside the same transaction.
    // tripNumber filter ensures we don't false-positive on a different
    // trip on the same day (rare but possible if a driver does two
    // trips on the same date).
    if (order.driverId && updated.tripNumber != null) {
      const remainingInFlight = await tx.order.count({
        where: {
          distributorId,
          driverId: order.driverId,
          deliveryDate: order.deliveryDate,
          tripNumber: updated.tripNumber,
          status: { in: ['pending_delivery', 'preflight_in_progress'] },
          deletedAt: null,
        },
      });
      if (remainingInFlight === 0) {
        // WI-070: also bump tripNumber and clear trip-sheet fields
        // here. WI-065 originally lived the increment inside
        // preflightDispatch's `if (mapping.status ===
        // loaded_and_dispatched)` branch — but WI-068 split the trip
        // lifecycle so the DVA reaches dispatch_ready BEFORE the next
        // dispatch click, which left the increment unreachable. Every
        // dispatch after the first then stamped orders with the same
        // tripNumber=1 forever (live evidence: dist-002 2026-05-19,
        // 9 orders all tripNumber=1 across 4 dispatch cycles).
        //
        // The next preflightDispatch picks the already-incremented
        // tripNumber up from the dispatch_ready DVA. The legacy
        // increment branch in gstPreflightService.ts:171-188 is
        // retained as defence-in-depth for any DVA that ends up stuck
        // in loaded_and_dispatched without going through this path
        // (historical pre-WI-068 rows, a future non-transactional
        // confirmDelivery variant, etc.).
        await tx.driverVehicleAssignment.updateMany({
          where: {
            distributorId,
            driverId: order.driverId,
            assignmentDate: order.deliveryDate,
            status: 'loaded_and_dispatched',
          },
          data: {
            status: 'dispatch_ready',
            tripNumber: { increment: 1 },
            tripSheetNo: null,
            tripSheetGeneratedAt: null,
            tripSheetNo2: null,
            tripSheetNo2GeneratedAt: null,
          },
        });
      }
    }

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
      if (isModified && hasLiveGstDoc) {
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
      await cancelEwb(invoiceId, distributorId, `Order cancelled: ${reason}`);
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
        await cancelIrn(invoiceId, distributorId, `Order cancelled: ${reason}`);
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
      for (const item of order.items) {
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

    // STEP 4: Void the invoice (preserve irnStatus/ewbStatus already updated by GST calls)
    if (invoiceId) {
      await tx.invoice.update({
        where: { id: invoiceId },
        data: { status: 'cancelled' },
      });
    }

    // STEP 5: Reverse CustomerLedgerEntry
    if (invoiceId) {
      const ledgerEntry = await tx.customerLedgerEntry.findFirst({
        where: { invoiceId, entryType: 'invoice_entry' as any },
      });
      if (ledgerEntry) {
        await tx.customerLedgerEntry.create({
          data: {
            customerId: ledgerEntry.customerId,
            distributorId: ledgerEntry.distributorId,
            entryType: 'adjustment' as any,
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
          status: { notIn: ['cancelled'] as any[] },
        },
      });
      if (dva) {
        const activeOrders = await tx.order.count({
          where: {
            distributorId,
            driverId: order.driverId,
            deliveryDate: order.deliveryDate,
            status: { in: ['pending_dispatch', 'pending_delivery', 'preflight_in_progress'] as any[] },
            id: { not: orderId },
            deletedAt: null,
          },
        });
        const dvaUpdates: Record<string, unknown> = {};
        if (dva.status === 'loaded_and_dispatched' as any) {
          dvaUpdates.tripNumber = Math.max(1, dva.tripNumber - 1);
        }
        if (activeOrders === 0 && ['loaded_and_dispatched', 'dispatch_ready'].includes(dva.status as string)) {
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

export class OrderError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'OrderError';
  }
}
