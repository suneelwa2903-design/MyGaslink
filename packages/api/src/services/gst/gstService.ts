/**
 * GST Service - Orchestrates e-Invoice (IRN) and e-Way Bill (EWB) generation.
 *
 * Workflow:
 * 1. Invoice created -> check distributor GST mode
 * 2. If GST disabled -> skip (normal flow)
 * 3. If GST sandbox/live:
 *    a. B2B customer (has GSTIN) -> Generate IRN -> Generate EWB from IRN
 *    b. B2C customer (no GSTIN) -> Generate standalone EWB (no IRN needed for B2C under 2.5L)
 * 4. On failure -> create pending_action for manual resolution
 */

import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { apiCall, getCredentials, GstError } from './whitebooksClient.js';
import { buildIrnPayload, buildEwbPayload } from './payloadBuilders.js';
// Distance: minimum 1km (0 causes EWB error 721)

interface TransportDetails {
  vehicleNumber: string;
  transportMode?: string;
  distance?: number;
  transporterName?: string;
  transporterId?: string;
}

function extractStateCode(gstin: string): string {
  return gstin.substring(0, 2);
}

/**
 * Process GST compliance for an invoice.
 * Called after invoice creation. Non-blocking - failures create pending actions.
 */
export async function processInvoiceGst(invoiceId: string, distributorId: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, latitude: true, longitude: true },
  });

  if (!distributor || distributor.gstMode === 'disabled') {
    return { skipped: true, reason: 'GST disabled for distributor' };
  }

  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      items: { include: { cylinderType: true } },
      customer: true,
      order: { include: { vehicle: true } },
    },
  });
  if (!invoice) throw new GstError('Invoice not found', 'NOT_FOUND');

  const isB2B = !!invoice.customer?.gstin && invoice.customer.gstin !== 'URP';
  const sellerStateCode = extractStateCode(distributor.gstin!);
  const buyerStateCode = invoice.customer?.gstin ? extractStateCode(invoice.customer.gstin) : sellerStateCode;
  const isInterState = sellerStateCode !== buyerStateCode;

  const result: { irn?: any; ewb?: any; errors: string[] } = { errors: [] };

  // Build common invoice data
  const invoiceData = {
    docType: 'INV' as const,
    docNumber: invoice.invoiceNumber,
    docDate: invoice.issueDate,
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
      gstin: invoice.customer?.gstin || null,
      legalName: invoice.customer?.businessName || invoice.customer?.customerName || 'Consumer',
      tradeName: invoice.customer?.customerName || undefined,
      address: invoice.customer?.billingAddressLine1 || '',
      address2: invoice.customer?.billingAddressLine2 || undefined,
      city: invoice.customer?.billingCity || '',
      pincode: invoice.customer?.billingPincode || '',
      state: invoice.customer?.billingState || '',
      stateCode: buyerStateCode,
      phone: invoice.customer?.phone || undefined,
      email: invoice.customer?.email || undefined,
    },
    items: invoice.items.map((item, idx) => ({
      slNo: idx + 1,
      description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      unitPrice: item.unitPrice + item.discountPerUnit, // Original price before discount (GST-inclusive)
      discountPerUnit: item.discountPerUnit,
      gstRate: item.gstRate || 18,
    })),
    isInterState,
  };

  // Get credential email once for all GST API calls
  const credEmail = (await getCredentials(distributorId, 'einvoice'))?.email || distributor.email || 'info@mygaslink.com';

  // Step 1: Generate IRN (B2B only)
  if (isB2B) {
    try {
      const irnPayload = buildIrnPayload(invoiceData);
      const email = credEmail;

      const irnResponse = await apiCall(
        distributorId, 'POST',
        `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
        irnPayload, 'einvoice'
      );

      const irn = irnResponse.data?.Irn || irnResponse.Irn;
      const ackNo = irnResponse.data?.AckNo || irnResponse.AckNo;
      const ackDt = irnResponse.data?.AckDt || irnResponse.AckDt;
      const signedQr = irnResponse.data?.SignedQRCode || irnResponse.SignedQRCode;

      // WhiteBooks may return EWB data along with IRN (auto-generated)
      const irnEwbNo = irnResponse.data?.EwbNo || irnResponse.EwbNo;
      const irnEwbDt = irnResponse.data?.EwbDt || irnResponse.EwbDt;
      const irnEwbValidTill = irnResponse.data?.EwbValidTill || irnResponse.EwbValidTill;
      const hasIrnEwb = !!irnEwbNo && irnEwbNo !== 0 && irnEwbNo !== '0';

      // Update invoice with IRN (and EWB if returned)
      await prisma.invoice.update({
        where: { id: invoiceId },
        data: {
          irn, ackNo: ackNo?.toString(), ackDate: ackDt ? new Date(ackDt) : null,
          irnStatus: 'success',
          ...(hasIrnEwb ? { ewbStatus: 'active' } : {}),
        },
      });

      // Create GST document record (include EWB if returned with IRN)
      await prisma.gstDocument.create({
        data: {
          invoiceId, orderId: invoice.orderId, distributorId,
          docType: 'INV', gstDocNo: invoice.invoiceNumber,
          irnStatus: 'success', irn, ackNo: ackNo?.toString(),
          ackDate: ackDt ? new Date(ackDt) : null, signedQr,
          ...(hasIrnEwb ? {
            ewbStatus: 'active',
            ewbNo: irnEwbNo?.toString(),
            ewbDate: irnEwbDt ? new Date(irnEwbDt) : null,
            ewbValidTill: irnEwbValidTill ? new Date(irnEwbValidTill) : null,
          } : {}),
          requestPayload: irnPayload, responsePayload: irnResponse,
          isLatest: true,
        },
      });

      result.irn = { irn, ackNo, status: 'success' };
      if (hasIrnEwb) {
        result.ewb = { ewbNo: irnEwbNo, status: 'active', source: 'irn_auto' };
        logger.info('IRN + EWB generated together', { invoiceId, irn, ackNo, ewbNo: irnEwbNo });
      } else {
        logger.info('IRN generated (no auto EWB)', { invoiceId, irn, ackNo });
      }

      // Step 2: Generate EWB from IRN (if not already returned with IRN and vehicle info available)
      if (hasIrnEwb) {
        // EWB already generated with IRN, also link dispatch EWB if exists
        const existingDispatchEwb = await prisma.gstDocument.findFirst({
          where: { orderId: invoice.orderId, invoiceId: null, ewbStatus: 'active' },
        });
        if (existingDispatchEwb) {
          await prisma.gstDocument.update({
            where: { id: existingDispatchEwb.id },
            data: { invoiceId },
          });
        }
      }
      // Step 2: Generate EWB (skip if already returned with IRN above)
      if (!hasIrnEwb) {
        // Check if dispatch EWB already exists (generated on dispatch)
        const existingEwb = await prisma.gstDocument.findFirst({
          where: { orderId: invoice.orderId, ewbNo: { not: null }, ewbStatus: 'active' },
        });
        if (existingEwb) {
          // Link dispatch EWB to invoice
          await prisma.gstDocument.update({
            where: { id: existingEwb.id },
            data: { invoiceId: invoiceId, irn, irnStatus: 'success', ackNo: ackNo?.toString() },
          });
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
          result.ewb = { ewbNo: existingEwb.ewbNo, status: 'active', source: 'dispatch' };
          logger.info('Linked dispatch EWB to invoice', { invoiceId, ewbNo: existingEwb.ewbNo });
        } else if (invoice.order?.vehicle) {
          try {
            const ewbPayload = buildEwbPayload(irnPayload, {
              vehicleNumber: invoice.order.vehicle.vehicleNumber,
              transportMode: '1',
              distance: 1,
            });

            const ewbResponse = await apiCall(
              distributorId, 'POST',
              `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(email)}`,
              ewbPayload, 'ewaybill'
            );

            const ewbNo = ewbResponse.data?.ewayBillNo;
            const ewbDate = ewbResponse.data?.validFrom;
            const ewbValidTill = ewbResponse.data?.validTo;

            await prisma.invoice.update({
              where: { id: invoiceId },
              data: { ewbStatus: 'active' },
            });

            await prisma.gstDocument.updateMany({
              where: { invoiceId, isLatest: true },
              data: {
                ewbStatus: 'active',
                ewbNo: ewbNo?.toString(),
                ewbDate: ewbDate ? new Date(ewbDate) : null,
                ewbValidTill: ewbValidTill ? new Date(ewbValidTill) : null,
              },
            });

            result.ewb = { ewbNo, status: 'active' };
            logger.info('EWB generated separately', { invoiceId, ewbNo });
          } catch (ewbErr: any) {
            // Handle 620: EWB already exists on portal (common during re-runs)
            if (ewbErr.code === '620' || ewbErr.message?.includes('620')) {
              await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
              await prisma.gstDocument.updateMany({
                where: { invoiceId, isLatest: true },
                data: { ewbStatus: 'active' },
              });
              result.ewb = { status: 'already_exists' };
              logger.info('EWB already exists on portal (620)', { invoiceId });
            } else {
              result.errors.push(`EWB failed: ${ewbErr.message}`);
              await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
              await createPendingAction(distributorId, invoiceId, 'EWB_GENERATION', ewbErr.message);
            }
          }
        }
      }
    } catch (irnErr: any) {
      result.errors.push(`IRN failed: ${irnErr.message}`);

      // Handle duplicate IRN (already exists on portal)
      if (irnErr.code === '2150') {
        await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'success' } });
        result.irn = { status: 'duplicate', message: 'IRN already exists on portal' };

        // Still try to generate EWB even if IRN is duplicate
        if (invoice.order?.vehicle) {
          try {
            const dupIrnPayload = buildIrnPayload(invoiceData);
            const ewbPayload = buildEwbPayload(dupIrnPayload, {
              vehicleNumber: invoice.order.vehicle.vehicleNumber,
              transportMode: '1',
              distance: 1,
            });
            const ewbResponse = await apiCall(distributorId, 'POST',
              `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
              ewbPayload, 'ewaybill');
            const ewbNo = ewbResponse.data?.ewayBillNo;
            await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
            result.ewb = { ewbNo, status: 'active' };
          } catch (ewbErr: any) {
            if (ewbErr.code === '620' || ewbErr.message?.includes('620')) {
              await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
              await prisma.gstDocument.updateMany({
                where: { invoiceId, isLatest: true },
                data: { ewbStatus: 'active' },
              });
              result.ewb = { status: 'already_exists' };
              logger.info('EWB already exists on portal (620, dup IRN path)', { invoiceId });
            } else {
              result.errors.push(`EWB failed: ${ewbErr.message}`);
            }
          }
        }
      } else {
        await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'failed' } });
        await createPendingAction(distributorId, invoiceId, 'IRN_GENERATION', irnErr.message);
      }
    }
  } else {
    // B2C: No IRN needed. Always generate EWB — every vehicle carrying LPG needs one.
    // Check if dispatch EWB already covers this
    const existingDispatchEwb = await prisma.gstDocument.findFirst({
      where: { orderId: invoice.orderId, ewbNo: { not: null }, ewbStatus: 'active' },
    });

    if (existingDispatchEwb) {
      // Link dispatch EWB to invoice
      await prisma.gstDocument.update({
        where: { id: existingDispatchEwb.id },
        data: { invoiceId },
      });
      await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
      result.ewb = { ewbNo: existingDispatchEwb.ewbNo, status: 'active', source: 'dispatch' };
      logger.info('Linked dispatch EWB to B2C invoice', { invoiceId, ewbNo: existingDispatchEwb.ewbNo });
    } else if (invoice.order?.vehicle) {
      try {
        const irnPayload = buildIrnPayload(invoiceData);
        const ewbPayload = buildEwbPayload(irnPayload, {
          vehicleNumber: invoice.order.vehicle.vehicleNumber,
          transportMode: '1',
          distance: 1,
        });

        const ewbResponse = await apiCall(
          distributorId, 'POST',
          `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
          ewbPayload, 'ewaybill'
        );

        const ewbNo = ewbResponse.data?.ewayBillNo;
        await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });

        await prisma.gstDocument.create({
          data: {
            invoiceId, orderId: invoice.orderId, distributorId,
            docType: 'INV', gstDocNo: invoice.invoiceNumber,
            ewbStatus: 'active', ewbNo: ewbNo?.toString(),
            requestPayload: ewbPayload, responsePayload: ewbResponse,
            isLatest: true,
          },
        });

        result.ewb = { ewbNo, status: 'active' };
        logger.info('B2C EWB generated', { invoiceId, ewbNo });
      } catch (ewbErr: any) {
        if (ewbErr.code === '620' || ewbErr.message?.includes('620')) {
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
          result.ewb = { status: 'already_exists' };
          logger.info('B2C EWB already exists on portal (620)', { invoiceId });
        } else {
          result.errors.push(`B2C EWB failed: ${ewbErr.message}`);
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
          await createPendingAction(distributorId, invoiceId, 'EWB_GENERATION', ewbErr.message);
        }
      }
    }
  }

  return result;
}

/**
 * Generate e-Way Bill for dispatch (before delivery).
 * Called when order status changes to pending_delivery.
 * Does NOT generate IRN - just EWB for legal transit compliance.
 */
export async function generateDispatchEwb(orderId: string, distributorId: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, latitude: true, longitude: true },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    return { skipped: true, reason: 'GST disabled' };
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      items: { include: { cylinderType: true } },
      customer: true,
      vehicle: true,
    },
  });
  if (!order || !order.vehicle) return { skipped: true, reason: 'No vehicle assigned' };

  const sellerStateCode = distributor.gstin!.substring(0, 2);
  const buyerStateCode = order.customer?.gstin ? order.customer.gstin.substring(0, 2) : sellerStateCode;
  const isInterState = sellerStateCode !== buyerStateCode;

  // Build a simplified payload for EWB (using order amounts, not invoice)
  const invoiceData = {
    docType: 'INV' as const,
    docNumber: order.orderNumber, // Use order number for dispatch EWB
    docDate: order.orderDate,
    seller: {
      gstin: distributor.gstin!, legalName: distributor.legalName, tradeName: distributor.businessName,
      address: distributor.address || '', city: distributor.city || '', pincode: distributor.pincode || '',
      state: distributor.state || '', stateCode: sellerStateCode,
      phone: distributor.phone || undefined, email: distributor.email || undefined,
    },
    buyer: {
      gstin: order.customer?.gstin || null,
      legalName: order.customer?.businessName || order.customer?.customerName || 'Consumer',
      address: order.customer?.billingAddressLine1 || '', city: order.customer?.billingCity || '',
      pincode: order.customer?.billingPincode || '', state: order.customer?.billingState || '',
      stateCode: buyerStateCode,
    },
    items: order.items.map((item, idx) => ({
      slNo: idx + 1,
      description: item.cylinderType?.typeName || 'LPG Cylinder',
      hsnCode: item.cylinderType?.hsnCode || '27111900',
      quantity: item.quantity,
      unit: 'NOS',
      unitPrice: item.unitPrice,
      discountPerUnit: item.discountPerUnit,
      gstRate: 18,
    })),
    isInterState,
  };

  try {
    const irnPayload = buildIrnPayload(invoiceData);
    const ewbPayload = buildEwbPayload(irnPayload, {
      vehicleNumber: order.vehicle.vehicleNumber,
      transportMode: '1',
      distance: 0, // Auto-populate from PIN database
    });

    const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor.email || 'info@mygaslink.com';

    const ewbResponse = await apiCall(
      distributorId, 'POST',
      `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(email)}`,
      ewbPayload, 'ewaybill'
    );

    const ewbNo = ewbResponse.data?.ewayBillNo;

    // Store EWB in GstDocument (no invoice yet at dispatch)
    await prisma.gstDocument.create({
      data: {
        orderId,
        distributorId,
        docType: 'INV',
        gstDocNo: order.orderNumber,
        ewbStatus: 'active',
        ewbNo: ewbNo?.toString(),
        ewbDate: ewbResponse.data?.validFrom ? new Date(ewbResponse.data.validFrom) : null,
        ewbValidTill: ewbResponse.data?.validTo ? new Date(ewbResponse.data.validTo) : null,
        requestPayload: ewbPayload,
        responsePayload: ewbResponse,
        isLatest: true,
      },
    });

    logger.info('Dispatch EWB generated', { orderId, ewbNo });
    return { ewbNo, status: 'active' };
  } catch (err: any) {
    // Handle error 620: EWB already exists for this document (common in sandbox/re-runs)
    if (err.code === '620' || err.message?.includes('620')) {
      // Ensure a gstDocument record exists with active EWB status
      const existing = await prisma.gstDocument.findFirst({ where: { orderId, isLatest: true } });
      if (existing) {
        await prisma.gstDocument.update({ where: { id: existing.id }, data: { ewbStatus: 'active' } });
      } else {
        await prisma.gstDocument.create({
          data: { orderId, distributorId, docType: 'INV', gstDocNo: order.orderNumber, ewbStatus: 'active', isLatest: true },
        });
      }
      logger.info('Dispatch EWB already exists (620)', { orderId });
      return { status: 'already_exists', message: 'EWB already generated for this document' };
    }
    // Create pending action for EWB failure
    try {
      await prisma.pendingAction.create({
        data: {
          distributorId,
          module: 'gst_compliance',
          actionType: 'DISPATCH_EWB_GENERATION',
          entityId: orderId,
          entityType: 'order',
          description: `Dispatch EWB failed: ${err.message}`.substring(0, 500),
          severity: 'high',
          status: 'open',
        },
      });
    } catch (paErr) {
      logger.error('Failed to create pending action for dispatch EWB', { orderId, err: paErr });
    }
    return { status: 'failed', error: err.message };
  }
}

/**
 * Cancel an IRN for an invoice
 */
export async function cancelIrn(invoiceId: string, distributorId: string, reason: string) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { irn: true, invoiceNumber: true },
  });
  if (!invoice?.irn) throw new GstError('Invoice has no IRN to cancel', 'NO_IRN');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor?.email || 'info@mygaslink.com';

  // CnlRsn: 1=Duplicate, 2=Data Entry Error, 3=Order Cancelled, 4=Others
  const cnlRsn = reason.toLowerCase().includes('duplicate') ? '1'
    : reason.toLowerCase().includes('error') ? '2'
    : reason.toLowerCase().includes('cancel') ? '3' : '4';

  const cancelPayload = {
    Irn: invoice.irn,
    CnlRsn: cnlRsn,
    CnlRem: reason.substring(0, 100),
  };

  const response = await apiCall(
    distributorId, 'POST',
    `/einvoice/type/CANCEL/version/V1_03?email=${encodeURIComponent(email)}`,
    cancelPayload, 'einvoice'
  );

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { irnStatus: 'cancelled', status: 'cancelled' },
  });

  await prisma.gstDocument.updateMany({
    where: { invoiceId, isLatest: true },
    data: { irnStatus: 'cancelled', cancelledAt: new Date() },
  });

  logger.info('IRN cancelled', { invoiceId, irn: invoice.irn });
  return response;
}

/**
 * Cancel an EWB for an invoice
 */
export async function cancelEwb(invoiceId: string, distributorId: string, reason: string) {
  const gstDoc = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, ewbNo: { not: null } },
  });
  if (!gstDoc?.ewbNo) throw new GstError('No e-Way Bill found for this invoice', 'NO_EWB');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor?.email || 'info@mygaslink.com';

  // cancelRsnCode: 1=Duplicate, 2=Data Entry Mistake, 3=Order Cancelled, 4=Others
  const cancelRsnCode = reason.toLowerCase().includes('duplicate') ? 1
    : reason.toLowerCase().includes('error') ? 2
    : reason.toLowerCase().includes('cancel') ? 3 : 4;

  const response = await apiCall(
    distributorId, 'POST',
    `/ewaybillapi/v1.03/ewayapi/canewb?email=${encodeURIComponent(email)}`,
    { ewbNo: parseInt(gstDoc.ewbNo), cancelRsnCode, cancelRmrk: reason.substring(0, 100) },
    'ewaybill'
  );

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { ewbStatus: 'cancelled' },
  });

  await prisma.gstDocument.updateMany({
    where: { invoiceId, isLatest: true },
    data: { ewbStatus: 'cancelled', cancelledAt: new Date() },
  });

  logger.info('EWB cancelled', { invoiceId, ewbNo: gstDoc.ewbNo });
  return response;
}

/**
 * Generate IRN for a credit note
 */
export async function processCreditNoteGst(creditNoteId: string, distributorId: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, latitude: true, longitude: true },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    return { skipped: true, reason: 'GST disabled' };
  }

  const cn = await prisma.creditNote.findUnique({
    where: { id: creditNoteId },
    include: {
      invoice: {
        include: { customer: true, items: { include: { cylinderType: true } } },
      },
    },
  });
  if (!cn) throw new GstError('Credit note not found', 'NOT_FOUND');
  if (!cn.invoice.customer?.gstin) return { skipped: true, reason: 'B2C - no IRN for credit notes' };

  const sellerStateCode = extractStateCode(distributor.gstin!);
  const buyerStateCode = extractStateCode(cn.invoice.customer.gstin);
  const isInterState = sellerStateCode !== buyerStateCode;

  // Build CRN payload - use proportional allocation of credit against invoice items
  const proportion = cn.totalAmount / cn.invoice.totalAmount;
  const items = cn.invoice.items.map((item, idx) => ({
    slNo: idx + 1,
    description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
    hsnCode: item.hsnCode || '27111900',
    quantity: Math.max(1, Math.round(item.quantity * proportion)),
    unit: 'NOS',
    unitPrice: item.unitPrice + item.discountPerUnit,
    discountPerUnit: item.discountPerUnit,
    gstRate: item.gstRate || 18,
  }));

  const data = {
    docType: 'CRN' as const,
    docNumber: cn.creditNoteNumber || `CN-${cn.id.substring(0, 12)}`,
    docDate: cn.issueDate || new Date(),
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
      gstin: cn.invoice.customer.gstin,
      legalName: cn.invoice.customer.businessName || cn.invoice.customer.customerName,
      address: cn.invoice.customer.billingAddressLine1 || '',
      city: cn.invoice.customer.billingCity || '',
      pincode: cn.invoice.customer.billingPincode || '',
      state: cn.invoice.customer.billingState || '',
      stateCode: buyerStateCode,
      phone: cn.invoice.customer.phone || undefined,
      email: cn.invoice.customer.email || undefined,
    },
    items,
    isInterState,
    originalDocNumber: cn.invoice.invoiceNumber,
    originalDocDate: cn.invoice.issueDate,
    reason: cn.reason,
  };

  const payload = buildIrnPayload(data);
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor.email || 'info@mygaslink.com';

  try {
    const response = await apiCall(
      distributorId, 'POST',
      `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
      payload, 'einvoice'
    );

    const irn = response.data?.Irn || response.Irn;
    await prisma.gstDocument.create({
      data: {
        invoiceId: cn.invoiceId, distributorId,
        docType: 'CRN', gstDocNo: data.docNumber,
        irnStatus: 'success', irn, ackNo: (response.data?.AckNo || response.AckNo)?.toString(),
        requestPayload: payload, responsePayload: response, isLatest: true,
      },
    });

    logger.info('Credit note IRN generated', { creditNoteId, irn });
    return { irn, status: 'success' };
  } catch (err: any) {
    await createPendingAction(distributorId, cn.invoiceId, 'CRN_IRN_GENERATION', err.message);
    return { status: 'failed', error: err.message };
  }
}

/**
 * Generate IRN for a debit note
 */
export async function processDebitNoteGst(debitNoteId: string, distributorId: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, gstin: true, legalName: true, businessName: true, address: true, city: true, state: true, pincode: true, phone: true, email: true, latitude: true, longitude: true },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    return { skipped: true, reason: 'GST disabled' };
  }

  const dn = await prisma.debitNote.findUnique({
    where: { id: debitNoteId },
    include: { invoice: { include: { customer: true, items: { include: { cylinderType: true } } } } },
  });
  if (!dn) throw new GstError('Debit note not found', 'NOT_FOUND');
  if (!dn.invoice.customer?.gstin) return { skipped: true, reason: 'B2C - no IRN for debit notes' };

  const sellerStateCode = extractStateCode(distributor.gstin!);
  const buyerStateCode = extractStateCode(dn.invoice.customer.gstin);
  const isInterState = sellerStateCode !== buyerStateCode;

  const proportion = dn.totalAmount / dn.invoice.totalAmount;
  const items = dn.invoice.items.map((item, idx) => ({
    slNo: idx + 1,
    description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
    hsnCode: item.hsnCode || '27111900',
    quantity: Math.max(1, Math.round(item.quantity * proportion)),
    unit: 'NOS',
    unitPrice: item.unitPrice + item.discountPerUnit,
    discountPerUnit: item.discountPerUnit,
    gstRate: item.gstRate || 18,
  }));

  const data = {
    docType: 'DBN' as const,
    docNumber: dn.debitNoteNumber || `DN-${dn.id.substring(0, 12)}`,
    docDate: dn.issueDate || new Date(),
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
      gstin: dn.invoice.customer.gstin,
      legalName: dn.invoice.customer.businessName || dn.invoice.customer.customerName,
      address: dn.invoice.customer.billingAddressLine1 || '',
      city: dn.invoice.customer.billingCity || '',
      pincode: dn.invoice.customer.billingPincode || '',
      state: dn.invoice.customer.billingState || '',
      stateCode: buyerStateCode,
      phone: dn.invoice.customer.phone || undefined,
      email: dn.invoice.customer.email || undefined,
    },
    items,
    isInterState,
    originalDocNumber: dn.invoice.invoiceNumber,
    originalDocDate: dn.invoice.issueDate,
    reason: dn.reason,
  };

  const payload = buildIrnPayload(data);
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor.email || 'info@mygaslink.com';

  try {
    const response = await apiCall(
      distributorId, 'POST',
      `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
      payload, 'einvoice'
    );

    const irn = response.data?.Irn || response.Irn;
    await prisma.gstDocument.create({
      data: {
        invoiceId: dn.invoiceId, distributorId,
        docType: 'DBN', gstDocNo: data.docNumber,
        irnStatus: 'success', irn, ackNo: (response.data?.AckNo || response.AckNo)?.toString(),
        requestPayload: payload, responsePayload: response, isLatest: true,
      },
    });

    logger.info('Debit note IRN generated', { debitNoteId, irn });
    return { irn, status: 'success' };
  } catch (err: any) {
    await createPendingAction(distributorId, dn.invoiceId, 'DBN_IRN_GENERATION', err.message);
    return { status: 'failed', error: err.message };
  }
}

/**
 * Validate a GSTIN using WhiteBooks API
 */
export async function validateGstin(distributorId: string, gstin: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { gstMode: true, email: true },
  });
  if (!distributor || distributor.gstMode === 'disabled') {
    return { valid: true, source: 'local', message: 'GST disabled, skipping validation' };
  }

  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor.email || 'info@mygaslink.com';

  try {
    const response = await apiCall(
      distributorId, 'GET',
      `/einvoice/type/GSTNDETAILS/version/V1_03?param1=${gstin}&email=${encodeURIComponent(email)}`,
      undefined, 'einvoice'
    );

    return {
      valid: true,
      source: 'whitebooks',
      data: response.data,
    };
  } catch (err: any) {
    return { valid: false, source: 'whitebooks', error: err.message };
  }
}

/**
 * Get IRN details from portal
 */
export async function getIrnDetails(distributorId: string, irn: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor?.email || 'info@mygaslink.com';

  return apiCall(
    distributorId, 'GET',
    `/einvoice/type/GETIRN/version/V1_03?param1=${irn}&email=${encodeURIComponent(email)}`,
    undefined, 'einvoice'
  );
}

/**
 * Get EWB status
 */
export async function getEwbStatus(distributorId: string, ewbNo: string) {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))?.email || distributor?.email || 'info@mygaslink.com';

  return apiCall(
    distributorId, 'GET',
    `/ewaybillapi/v1.03/ewayapi/getewaybill?email=${encodeURIComponent(email)}&ewbNo=${ewbNo}`,
    undefined, 'ewaybill'
  );
}

/**
 * Cancel invoice and its GST documents, then create a new invoice
 */
export async function cancelAndRegenerateInvoice(
  invoiceId: string,
  distributorId: string,
  userId: string,
  orderId: string
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { irn: true, irnStatus: true, ewbStatus: true },
  });

  // If IRN was generated, cancel it first
  if (invoice?.irn && invoice.irnStatus === 'success') {
    try {
      await cancelIrn(invoiceId, distributorId, 'Order items changed - regenerating invoice');
    } catch (err: any) {
      logger.warn('Failed to cancel IRN during regeneration', { invoiceId, error: err.message });
    }
  }

  // Cancel the invoice and unlink from order (so new invoice can be created)
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: 'cancelled', deletedAt: new Date(), order: { disconnect: true } },
  });

  // Create new invoice from order
  const { createInvoiceFromOrder } = await import('../invoiceService.js');
  const newInvoice = await prisma.$transaction(async (tx) => {
    return createInvoiceFromOrder(tx, orderId, distributorId, userId);
  });

  // Process GST for new invoice
  if (newInvoice) {
    await processInvoiceGst(newInvoice.id, distributorId);
  }

  return newInvoice;
}

/**
 * Create a pending action for GST failures
 */
async function createPendingAction(
  distributorId: string,
  invoiceId: string,
  actionType: string,
  errorMessage: string
) {
  try {
    await prisma.pendingAction.create({
      data: {
        distributorId,
        module: 'gst_compliance',
        entityId: invoiceId,
        entityType: 'invoice',
        actionType,
        description: errorMessage.substring(0, 500),
        severity: 'high',
        status: 'open',
      },
    });
  } catch (err) {
    logger.error('Failed to create pending action', { distributorId, invoiceId, actionType, err });
  }
}
