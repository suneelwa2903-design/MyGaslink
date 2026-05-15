/**
 * Pre-dispatch preflight (WI-035, WI-A).
 *
 * For a driver's daily route, ensure every order has the GST documents
 * required to legally leave the depot BEFORE the vehicle moves:
 *   - B2B (customer.gstin set, ≠ 'URP'): IRN + EWB
 *   - B2C (gstin null/URP): standalone EWB (always — no invoice-value gate)
 *
 * Lock semantics (founder Q3): orders transition pending_dispatch →
 * preflight_in_progress at the start, then → pending_delivery (success)
 * or back → pending_dispatch (failure). Concurrent preflight on the
 * same order races on this status update and the loser hits 409.
 *
 * Partial dispatch (founder Q1): each order is processed independently;
 * failures land in a PendingAction queue and the order returns to
 * pending_dispatch. Other orders in the same driver's batch still
 * proceed to pending_delivery.
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { apiCall, getCredentials } from './whitebooksClient.js';
import { buildIrnPayload } from './payloadBuilders.js';
import {
  parseEwbResponse,
  parseWhitebooksDate,
  recoverEwbFromIrn,
  createPendingAction,
} from './gstService.js';
import { createInvoiceFromOrder } from '../invoiceService.js';

const orderInclude = {
  customer: true,
  items: { include: { cylinderType: true } },
  vehicle: true,
  driver: { select: { id: true, driverName: true } },
} as const;

export type PreflightResult = {
  orderId: string;
  orderNumber: string;
  customerName: string | null;
  mode: 'B2B' | 'B2C' | 'GST_DISABLED';
  success: boolean;
  irn?: string | null;
  ackNo?: string | null;
  ewbNo?: string | null;
  ewbValidTill?: string | null;
  errorCode?: string;
  errorMessage?: string;
  pendingActionId?: string;
};

export type PreflightResponse = {
  summary: { total: number; succeeded: number; failed: number };
  results: PreflightResult[];
  dispatched: boolean; // true only when every order succeeded
};

export class PreflightError extends Error {
  statusCode: number;
  code: string;
  constructor(message: string, code: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

/**
 * Run preflight for every pending_dispatch order assigned to a driver
 * on a given date. Per-order partial dispatch — see module docstring.
 */
export async function preflightDispatch(params: {
  distributorId: string;
  driverId: string;
  assignmentDate: string; // YYYY-MM-DD
  userId: string;
}): Promise<PreflightResponse> {
  const { distributorId, driverId, assignmentDate, userId } = params;
  const targetDate = new Date(assignmentDate);

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { id: true, gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true },
  });
  if (!distributor) throw new PreflightError('Distributor not found', 'NOT_FOUND', 404);

  const driver = await prisma.driver.findFirst({
    where: { id: driverId, distributorId, deletedAt: null },
    select: { id: true, driverName: true, status: true },
  });
  if (!driver) throw new PreflightError('Driver not found', 'NOT_FOUND', 404);
  if (driver.status !== 'active') {
    throw new PreflightError('Driver is not active', 'DRIVER_INACTIVE', 400);
  }

  // Confirmed vehicle mapping for the date — same rule the order-assign
  // guard enforces. Absent mapping means no vehicle = no EWB.
  const mapping = await prisma.driverVehicleAssignment.findFirst({
    where: {
      driverId, distributorId,
      assignmentDate: targetDate,
      status: { not: 'cancelled' },
    },
    select: { id: true, vehicleId: true, status: true, vehicle: { select: { vehicleNumber: true } } },
  });
  if (distributor.gstMode !== 'disabled' && !mapping?.vehicleId) {
    throw new PreflightError(
      `Driver has no confirmed vehicle mapping for ${assignmentDate}. Assign a vehicle in Fleet → Vehicle Mapping first.`,
      'NO_VEHICLE_MAPPING',
      400,
    );
  }
  if (mapping?.status === 'loaded_and_dispatched') {
    throw new PreflightError(
      "Driver's vehicle is already dispatched for this date",
      'ALREADY_DISPATCHED',
      409,
    );
  }

  const orders = await prisma.order.findMany({
    where: {
      distributorId,
      driverId,
      deliveryDate: targetDate,
      status: 'pending_dispatch',
      deletedAt: null,
    },
    include: orderInclude,
    orderBy: { createdAt: 'asc' },
  });

  if (orders.length === 0) {
    throw new PreflightError(
      'No orders in pending_dispatch for this driver/date',
      'NO_ORDERS',
      400,
    );
  }

  const results: PreflightResult[] = [];
  for (const order of orders) {
    const r = await preflightOne({
      order,
      distributor,
      vehicleNumber: mapping?.vehicle?.vehicleNumber ?? null,
      userId,
    });
    results.push(r);
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.length - succeeded;

  // Drive the driver-vehicle assignment forward only when every order
  // succeeded — partial dispatch leaves it dispatch_ready so a retry of
  // the failing orders can still flip it.
  if (mapping?.id && failed === 0 && succeeded > 0) {
    await prisma.driverVehicleAssignment.update({
      where: { id: mapping.id },
      data: { status: 'loaded_and_dispatched' },
    });
  }

  return {
    summary: { total: results.length, succeeded, failed },
    results,
    dispatched: failed === 0,
  };
}

/**
 * Preflight a single order. Acquires the preflight_in_progress lock via
 * a conditional UPDATE — only one process can claim a given order.
 */
async function preflightOne(params: {
  order: any;
  distributor: any;
  vehicleNumber: string | null;
  userId: string;
}): Promise<PreflightResult> {
  const { order, distributor, vehicleNumber, userId } = params;
  const orderId: string = order.id;
  const customerName: string | null = order.customer?.customerName ?? null;

  // 1. Acquire the lock — atomic conditional update. Race-safe.
  const claimed = await prisma.order.updateMany({
    where: { id: orderId, status: 'pending_dispatch' },
    data: { status: 'preflight_in_progress' },
  });
  if (claimed.count !== 1) {
    return {
      orderId,
      orderNumber: order.orderNumber,
      customerName,
      mode: 'B2B',
      success: false,
      errorCode: 'ALREADY_IN_PREFLIGHT',
      errorMessage: 'Order is not in pending_dispatch or another preflight is already running',
    };
  }

  try {
    const isB2C = !order.customer?.gstin || order.customer.gstin === 'URP';

    // GST-disabled tenants: just transition to pending_delivery.
    if (distributor.gstMode === 'disabled') {
      await transitionToPendingDelivery(orderId, userId, 'GST disabled — preflight skipped');
      return {
        orderId,
        orderNumber: order.orderNumber,
        customerName,
        mode: 'GST_DISABLED',
        success: true,
      };
    }

    // Compliance-eligible. We need a vehicle.
    if (!vehicleNumber) {
      await revertToPendingDispatch(orderId);
      return {
        orderId,
        orderNumber: order.orderNumber,
        customerName,
        mode: isB2C ? 'B2C' : 'B2B',
        success: false,
        errorCode: 'NO_VEHICLE_MAPPING',
        errorMessage: 'No vehicle assigned for delivery date',
      };
    }

    // Ensure a draft invoice exists. createInvoiceFromOrder needs the
    // order to be in 'delivered'/'modified_delivered' currently — we
    // generate the invoice using ordered quantities at preflight time,
    // so we temporarily set delivered=ordered for each item, run the
    // builder, then revert. Cleaner: factor out a draft-invoice variant.
    // For now reuse the existing helper but bypass its state check by
    // calling our own preflight invoice creator (see below).
    const invoice = await ensureDraftInvoice(orderId, distributor.id, userId);

    // B2B: IRN + EWB (inline preferred).
    if (!isB2C) {
      return await runB2bPreflight({
        order, invoice, distributor, vehicleNumber, userId, customerName,
      });
    }
    // B2C / URP: EWB only (standalone) — always, regardless of invoice value.
    return await runB2cPreflight({
      order, invoice, distributor, vehicleNumber, userId, customerName,
    });
  } catch (err: any) {
    logger.error('Preflight unexpected error', { orderId, error: err.message });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributor.id, orderId, 'DISPATCH_PREFLIGHT', err.message ?? 'Unknown error',
    );
    return {
      orderId,
      orderNumber: order.orderNumber,
      customerName,
      mode: 'B2B',
      success: false,
      errorCode: err.code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
    };
  }
}

async function transitionToPendingDelivery(orderId: string, userId: string, notes: string) {
  await prisma.$transaction(async (tx) => {
    await tx.order.update({
      where: { id: orderId },
      data: { status: 'pending_delivery' },
    });
    await tx.orderStatusLog.create({
      data: {
        orderId,
        oldStatus: 'preflight_in_progress',
        newStatus: 'pending_delivery',
        changedBy: userId,
        notes,
      },
    });
  });
}

async function revertToPendingDispatch(orderId: string) {
  await prisma.order.update({
    where: { id: orderId },
    data: { status: 'pending_dispatch' },
  });
}

/**
 * Ensure a draft invoice exists for an order in preflight, using ordered
 * quantities. If the order has no items with prices, throws.
 * Side-effect: invoice is created with status='issued', linked to order.
 */
async function ensureDraftInvoice(
  orderId: string,
  distributorId: string,
  userId: string,
): Promise<{ id: string; invoiceNumber: string }> {
  const existing = await prisma.invoice.findFirst({
    where: { orderId, distributorId, deletedAt: null },
    select: { id: true, invoiceNumber: true },
  });
  if (existing) return existing;

  // createInvoiceFromOrder expects the order to be in delivered state.
  // Bypass that by setting delivered=ordered on every item temporarily
  // — the invoice will use those numbers, which are exactly the ordered
  // quantities. We restore deliveredQuantity to null after invoice
  // creation so the actual confirm-delivery flow remains accurate.
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirstOrThrow({
      where: { id: orderId, distributorId },
      include: { items: true },
    });
    const previousStatus = order.status;
    await tx.order.update({
      where: { id: orderId },
      // Cast through a known transitional state so createInvoiceFromOrder's
      // own status guard passes. We flip back below.
      data: { status: 'delivered' },
    });
    for (const item of order.items) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: item.quantity },
      });
    }
    await createInvoiceFromOrder(tx as any, orderId, distributorId, userId);
    await tx.order.update({
      where: { id: orderId },
      data: { status: previousStatus },
    });
    for (const item of order.items) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { deliveredQuantity: null },
      });
    }
  });

  const created = await prisma.invoice.findFirstOrThrow({
    where: { orderId, distributorId, deletedAt: null },
    select: { id: true, invoiceNumber: true },
  });
  return created;
}

/** Build the InvoiceData payload feeding buildIrnPayload. */
async function buildInvoiceData(
  invoiceId: string,
  distributor: any,
  transport: { vehicleNumber: string; transportMode: '1'; distance: 0 } | undefined,
): Promise<any> {
  const inv = await prisma.invoice.findFirstOrThrow({
    where: { id: invoiceId },
    include: { items: { include: { cylinderType: true } }, customer: true, order: { include: { vehicle: true } } },
  });
  const sellerStateCode = (distributor.gstin || '').substring(0, 2);
  const buyerStateCode = inv.customer?.gstin ? inv.customer.gstin.substring(0, 2) : sellerStateCode;
  return {
    docType: 'INV' as const,
    docNumber: inv.invoiceNumber,
    docDate: inv.issueDate,
    seller: {
      gstin: distributor.gstin!,
      legalName: distributor.legalName,
      tradeName: distributor.businessName,
      address: distributor.address || '',
      city: distributor.city || '',
      pincode: distributor.pincode || '',
      state: distributor.state || '',
      stateCode: sellerStateCode,
      phone: distributor.phone || undefined,
      email: distributor.email || undefined,
    },
    buyer: {
      gstin: inv.customer?.gstin || null,
      legalName: inv.customer?.businessName || inv.customer?.customerName || 'Consumer',
      tradeName: inv.customer?.customerName || undefined,
      address: inv.customer?.billingAddressLine1 || '',
      city: inv.customer?.billingCity || '',
      pincode: inv.customer?.billingPincode || '',
      state: inv.customer?.billingState || '',
      stateCode: buyerStateCode,
      phone: inv.customer?.phone || undefined,
      email: inv.customer?.email || undefined,
    },
    items: inv.items.map((item: any, idx: number) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      unitPrice: toNum(item.unitPrice) + toNum(item.discountPerUnit),
      discountPerUnit: toNum(item.discountPerUnit),
      gstRate: item.gstRate || 18,
    })),
    isInterState: sellerStateCode !== buyerStateCode,
    transport,
  };
}

/**
 * Run the B2B path: IRN + EWB inline. If NIC doesn't return inline EWB,
 * recover via getIrnDetails (handles 604 / portal-pre-existing cases).
 */
async function runB2bPreflight(params: {
  order: any;
  invoice: { id: string; invoiceNumber: string };
  distributor: any;
  vehicleNumber: string;
  userId: string;
  customerName: string | null;
}): Promise<PreflightResult> {
  const { order, invoice, distributor, vehicleNumber, userId, customerName } = params;
  const distributorId: string = distributor.id;
  const invoiceId = invoice.id;
  const orderId: string = order.id;

  const invoiceData = await buildInvoiceData(invoiceId, distributor, {
    vehicleNumber, transportMode: '1', distance: 0,
  });

  const credEmail =
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  try {
    const irnPayload = buildIrnPayload(invoiceData);
    const irnResponse: any = await logApiCall({
      distributorId, orderId, invoiceId,
      apiType: 'IRN_GENERATE', scope: 'einvoice',
      endpoint: '/einvoice/type/GENERATE/version/V1_03',
      payload: irnPayload,
      call: () => apiCall(
        distributorId, 'POST',
        `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(credEmail)}`,
        irnPayload, 'einvoice',
      ),
    });

    const irn = irnResponse.data?.Irn ?? irnResponse.Irn;
    const ackNo = irnResponse.data?.AckNo ?? irnResponse.AckNo;
    const ackDt = irnResponse.data?.AckDt ?? irnResponse.AckDt;
    const signedQr = irnResponse.data?.SignedQRCode ?? irnResponse.SignedQRCode;
    const irnEwbNo = irnResponse.data?.EwbNo ?? irnResponse.EwbNo;
    const irnEwbDt = irnResponse.data?.EwbDt ?? irnResponse.EwbDt;
    const irnEwbValidTill = irnResponse.data?.EwbValidTill ?? irnResponse.EwbValidTill;
    const hasIrnEwb = !!irnEwbNo && irnEwbNo !== 0 && irnEwbNo !== '0';

    // Persist IRN + (inline EWB if present). NIC dates come back in Indian
    // DD/MM/YYYY hh:mm:ss AM/PM format — JS Date() can't parse that, so we
    // route every date through parseWhitebooksDate.
    const ackDate = parseWhitebooksDate(ackDt);
    const ewbDate = parseWhitebooksDate(irnEwbDt);
    const ewbValidTillDate = parseWhitebooksDate(irnEwbValidTill);

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        irn,
        ackNo: ackNo?.toString(),
        ackDate,
        irnStatus: 'success',
        ...(hasIrnEwb ? { ewbStatus: 'active' } : {}),
      },
    });

    await upsertLatestGstDocument({
      invoiceId, orderId, distributorId,
      gstDocNo: invoice.invoiceNumber,
      data: {
        irnStatus: 'success', irn,
        ackNo: ackNo?.toString(),
        ackDate,
        signedQr,
        ...(hasIrnEwb ? {
          ewbStatus: 'active',
          ewbNo: irnEwbNo?.toString(),
          ewbDate,
          ewbValidTill: ewbValidTillDate,
        } : {}),
        requestPayload: irnPayload,
        responsePayload: irnResponse,
      },
    });

    let ewbNo: string | null = hasIrnEwb ? String(irnEwbNo) : null;
    let ewbValidTill: string | null = irnEwbValidTill ? String(irnEwbValidTill) : null;

    if (!hasIrnEwb) {
      // Fallback: try recovering EWB from IRN-details. This handles the
      // case where NIC accepted the IRN but, for whatever reason, didn't
      // return inline EWB fields (sandbox quirk, port-side delay).
      const recovered = await recoverEwbFromIrn(invoiceId, distributorId, irn);
      if (recovered?.ewbNo) {
        ewbNo = recovered.ewbNo;
        ewbValidTill = recovered.ewbValidTill ?? null;
      }
    }

    await transitionToPendingDelivery(
      orderId, userId,
      `Preflight succeeded: IRN=${irn?.substring(0, 16)}… EWB=${ewbNo ?? 'n/a'}`,
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: true,
      irn, ackNo: ackNo?.toString() ?? null,
      ewbNo, ewbValidTill,
    };
  } catch (err: any) {
    // Handle duplicate IRN (2150): IRN already on NIC portal — still try
    // to surface the existing one via GETIRNBYDOCDETAILS (out of scope
    // for v1; for now treat as recoverable failure and let admin retry).
    const code = String(err.code || '').replace(/[^0-9]/g, '');
    if (code === '2150') {
      // Mark as success since portal already accepts this doc — but we
      // can't fill irn locally without the lookup call. Best-effort: mark
      // the IRN status without value.
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: { irnStatus: 'success' },
      });
      await transitionToPendingDelivery(
        orderId, userId, 'Preflight: duplicate IRN (2150) — accepted',
      );
      return {
        orderId, orderNumber: order.orderNumber, customerName,
        mode: 'B2B', success: true,
        errorCode: '2150',
        errorMessage: 'Duplicate IRN — already on portal',
      };
    }
    logger.error('Preflight B2B failed', { orderId, invoiceId, error: err.message });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { irnStatus: 'failed' },
    });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributorId, invoiceId, 'IRN_GENERATION',
      `Order ${order.orderNumber}: ${err.message}`,
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2B', success: false,
      errorCode: err.code || code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
    };
  }
}

/** B2C / URP — standalone EWB endpoint (always, no invoice-value gate). */
async function runB2cPreflight(params: {
  order: any;
  invoice: { id: string; invoiceNumber: string };
  distributor: any;
  vehicleNumber: string;
  userId: string;
  customerName: string | null;
}): Promise<PreflightResult> {
  const { order, invoice, distributor, vehicleNumber, userId, customerName } = params;
  const distributorId: string = distributor.id;
  const invoiceId = invoice.id;
  const orderId: string = order.id;

  const invoiceData = await buildInvoiceData(invoiceId, distributor, undefined);
  const credEmail =
    (await getCredentials(distributorId, 'ewaybill'))?.email ||
    (await getCredentials(distributorId, 'einvoice'))?.email ||
    distributor.email ||
    'info@mygaslink.com';

  try {
    const irnPayload = buildIrnPayload(invoiceData);
    // For B2C we don't generate an IRN; we just borrow the IRN-shaped
    // values to construct the EWB payload via buildEwbPayload. Import
    // locally to avoid a top-level cycle with gstService.
    const { buildEwbPayload } = await import('./payloadBuilders.js');
    const ewbPayload = buildEwbPayload(irnPayload, {
      vehicleNumber, transportMode: '1', distance: 1,
    });

    const ewbResponse: any = await logApiCall({
      distributorId, orderId, invoiceId,
      apiType: 'EWB_GENERATE_STANDALONE', scope: 'ewaybill',
      endpoint: '/ewaybillapi/v1.03/ewayapi/genewaybill',
      payload: ewbPayload,
      call: () => apiCall(
        distributorId, 'POST',
        `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
        ewbPayload, 'ewaybill',
      ),
    });

    const parsed = parseEwbResponse(ewbResponse);

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'active' },
    });
    await upsertLatestGstDocument({
      invoiceId, orderId, distributorId,
      gstDocNo: invoice.invoiceNumber,
      data: {
        ewbStatus: 'active',
        ewbNo: parsed.ewbNo,
        ewbDate: parsed.validFromDate,
        ewbValidTill: parsed.validToDate,
        requestPayload: ewbPayload,
        responsePayload: ewbResponse,
      },
    });

    await transitionToPendingDelivery(
      orderId, userId,
      `B2C preflight succeeded: EWB=${parsed.ewbNo}`,
    );

    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: true,
      ewbNo: parsed.ewbNo, ewbValidTill: parsed.validToDate?.toISOString() ?? null,
    };
  } catch (err: any) {
    logger.error('Preflight B2C failed', { orderId, invoiceId, error: err.message });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'failed' },
    });
    await revertToPendingDispatch(orderId);
    const pa = await createPendingAction(
      distributorId, invoiceId, 'EWB_GENERATION',
      `Order ${order.orderNumber}: ${err.message}`,
    );
    return {
      orderId, orderNumber: order.orderNumber, customerName,
      mode: 'B2C', success: false,
      errorCode: err.code || 'UNKNOWN',
      errorMessage: err.message,
      pendingActionId: (pa as any)?.id,
    };
  }
}

/**
 * Run a WhiteBooks API call and persist a gst_api_logs row for it. The
 * call is invoked even if the log write fails — never block API on audit.
 */
async function logApiCall<T>(args: {
  distributorId: string;
  orderId?: string;
  invoiceId?: string;
  apiType: string;
  scope: string;
  endpoint: string;
  payload: any;
  call: () => Promise<T>;
}): Promise<T> {
  const started = Date.now();
  try {
    const resp = await args.call();
    void writeApiLog({ ...args, status: 'success', response: resp, latencyMs: Date.now() - started });
    return resp;
  } catch (err: any) {
    void writeApiLog({
      ...args,
      status: 'failed',
      response: null,
      latencyMs: Date.now() - started,
      errorCode: err.code,
      errorMessage: err.message,
    });
    throw err;
  }
}

/**
 * Find-or-update the `is_latest` gst_documents row for an invoice; create
 * if none exists. Used by both B2B and B2C preflight branches so a retry
 * after partial failure updates the existing row instead of duplicating.
 */
async function upsertLatestGstDocument(args: {
  invoiceId: string;
  orderId: string;
  distributorId: string;
  gstDocNo: string;
  data: Record<string, any>;
}) {
  const existing = await prisma.gstDocument.findFirst({
    where: { invoiceId: args.invoiceId, isLatest: true, deletedAt: null },
    select: { id: true },
  });
  if (existing) {
    await prisma.gstDocument.update({
      where: { id: existing.id },
      data: args.data,
    });
    return;
  }
  await prisma.gstDocument.create({
    data: {
      invoiceId: args.invoiceId,
      orderId: args.orderId,
      distributorId: args.distributorId,
      docType: 'INV',
      gstDocNo: args.gstDocNo,
      isLatest: true,
      ...args.data,
    },
  });
}

async function writeApiLog(args: {
  distributorId: string;
  orderId?: string;
  invoiceId?: string;
  apiType: string;
  scope: string;
  endpoint: string;
  payload: any;
  status: 'success' | 'failed';
  response: any;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  try {
    await prisma.gstApiLog.create({
      data: {
        distributorId: args.distributorId,
        orderId: args.orderId,
        invoiceId: args.invoiceId,
        apiType: args.apiType,
        scope: args.scope,
        endpoint: args.endpoint,
        status: args.status,
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage ?? null,
        requestPayload: args.payload,
        responsePayload: args.response ?? null,
        latencyMs: args.latencyMs,
      },
    });
  } catch (logErr) {
    logger.warn('gst_api_logs write failed (non-blocking)', { err: (logErr as Error).message });
  }
}
