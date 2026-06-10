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

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { toNum } from '../../utils/decimal.js';
import { getCredentials, GstError } from './whitebooksClient.js';
import { callWithLog } from './apiLogger.js';
import { buildIrnPayload, buildEwbPayload, type IrnPayload } from './payloadBuilders.js';
import type { EwbResponse, IrnResponse, WhiteBooksEnvelope } from './nicTypes.js';

// Prisma JSON columns (requestPayload/responsePayload) reject our precise
// payload/response interfaces because optional fields widen to `| undefined`,
// which is not a valid JSON input. The values are genuinely JSON-serialisable,
// so we narrow to Prisma.InputJsonValue at the column boundary.
const toJson = (v: unknown): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

/** Narrow an unknown caught value to the error code/message shape the GST
 *  flow relies on (GstError sets `.code`; all Errors set `.message`). */
function errInfo(err: unknown): { code: string; message: string } {
  if (err instanceof GstError) return { code: err.code, message: err.message };
  if (err instanceof Error) return { code: '', message: err.message };
  return { code: '', message: String(err) };
}
// Distance: minimum 1km (0 causes EWB error 721)

function extractStateCode(gstin: string): string {
  return gstin.substring(0, 2);
}

/**
 * Parse a WhiteBooks date string. Real sandbox EWB responses use
 * Indian-format dates like "15/05/2026 12:32:00 PM" which JavaScript's
 * Date constructor mis-parses. Falls back to native Date if the format
 * is unfamiliar (e.g. an ISO string).
 */
export function parseWhitebooksDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  // DD/MM/YYYY hh:mm:ss AM/PM  OR  DD/MM/YYYY HH:mm:ss  OR  DD/MM/YYYY
  const m = String(s).trim().match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM|am|pm)?)?$/,
  );
  if (m) {
    const [, dd, mm, yyyy, hh, mi, ss, ampm] = m;
    let hour = hh ? parseInt(hh, 10) : 0;
    if (ampm) {
      const upper = ampm.toUpperCase();
      if (upper === 'PM' && hour < 12) hour += 12;
      if (upper === 'AM' && hour === 12) hour = 0;
    }
    const iso = `${yyyy}-${mm.padStart(2, '0')}-${dd.padStart(2, '0')}T${String(hour).padStart(2, '0')}:${(mi ?? '00').padStart(2, '0')}:${(ss ?? '00').padStart(2, '0')}`;
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  const fallback = new Date(s);
  return Number.isNaN(fallback.getTime()) ? null : fallback;
}

/**
 * Extract EWB number + validity dates from a WhiteBooks /genewaybill
 * response. WhiteBooks ships the same data under multiple field-name
 * conventions: data.ewayBillNo, data.ewbNo, data.EwbNo, top-level
 * ewayBillNo, and sometimes data is a raw string of the number.
 * Dates use either validFrom/validTo (older docs), validUpto +
 * ewayBillDate (current sandbox), or capitalized variants.
 *
 * Checking only one path silently drops the data when the API shape
 * shifts — exactly what happened to us on INV-MP6KJ9E57P5.
 * Mirrors the legacy New_GasLink/.../whitebooksEinvoiceClient.js
 * fallback chain.
 */
export function parseEwbResponse(resp: EwbResponse | null | undefined): {
  ewbNo: string | null;
  validFromDate: Date | null;
  validToDate: Date | null;
} {
  // data may be an object or a JSON-encoded string of the body
  let data: EwbResponse['data'] = resp?.data;
  if (typeof data === 'string') {
    try { data = JSON.parse(data) as EwbResponse['data']; } catch { /* leave as string */ }
  }
  const dataObj = data && typeof data === 'object' ? data : undefined;
  const ewbNoRaw =
    dataObj?.ewayBillNo ?? dataObj?.ewbNo ?? dataObj?.EwbNo ??
    resp?.ewayBillNo ?? resp?.ewbNo ?? resp?.EwbNo ??
    (typeof resp?.data === 'string' && resp.data.match(/^\d+$/) ? resp.data : null);
  const ewbNo = ewbNoRaw != null && ewbNoRaw !== 0 && ewbNoRaw !== '0'
    ? String(ewbNoRaw)
    : null;
  // EWB issue date — current sandbox uses ewayBillDate; older docs use validFrom
  const fromRaw =
    dataObj?.ewayBillDate ?? dataObj?.EwayBillDate ??
    dataObj?.validFrom ?? dataObj?.ValidFrom ??
    resp?.ewayBillDate ?? resp?.validFrom ?? resp?.ValidFrom ?? null;
  // EWB expiry — current sandbox uses validUpto; older docs use validTo
  const toRaw =
    dataObj?.validUpto ?? dataObj?.ValidUpto ??
    dataObj?.validTo ?? dataObj?.ValidTo ??
    resp?.validUpto ?? resp?.validTo ?? resp?.ValidTo ?? null;
  return {
    ewbNo,
    validFromDate: parseWhitebooksDate(fromRaw),
    validToDate: parseWhitebooksDate(toRaw),
  };
}

/**
 * Process GST compliance for an invoice.
 * Called after invoice creation. Non-blocking - failures create pending actions.
 */
/**
 * Generate a NEW EWB linked to an already-generated IRN, and persist it
 * onto the invoice's latest gst_documents row.
 *
 * WI-107: extracted from the EWB-by-IRN block that previously lived inline
 * inside processInvoiceGst, so the SAME logic is reused by both the
 * dispatch path (processInvoiceGst) and the post-modified-delivery B2B
 * reissue path (gstReissueService.regenerateB2bEwb). The live NIC test
 * (Q8) confirmed NIC accepts a fresh EWB on the new IRN after the full
 * cancel-EWB → cancel-IRN → new-IRN sequence.
 *
 * Non-fatal by contract: on a NIC failure it marks ewbStatus='failed' and
 * raises an EWB_GENERATION pending action, then returns
 * { status: 'failed' } — it never throws for a NIC-side error, so a
 * caller's already-committed IRN is never rolled back. A 604 ("EWB already
 * exists") is recovered via the IRN-details endpoint.
 *
 * Clears any stale `cancelledAt` on the latest gst_documents row — the
 * reissue path cancels the prior EWB in Step 1, and that timestamp must
 * not survive onto the new active EWB.
 */
export async function generateEwbFromIrn(
  distributorId: string,
  invoiceId: string,
  irnData: {
    irnPayload: IrnPayload;
    vehicleNumber: string;
    email: string;
    irn: string;
    orderId?: string | null;
    apiType?: string;
  },
): Promise<{ ewbNo?: string | null; status: 'active' | 'already_exists' | 'failed'; source?: string; error?: string }> {
  const { irnPayload, vehicleNumber, email, irn, orderId, apiType = 'EWB_GENERATE_BY_IRN' } = irnData;
  try {
    const ewbPayload = buildEwbPayload(irnPayload, {
      vehicleNumber,
      transportMode: '1',
      distance: 1,
    });

    const ewbResponse = await callWithLog<EwbResponse>(
      distributorId, 'POST',
      `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(email)}`,
      ewbPayload, 'ewaybill',
      { apiType, invoiceId, orderId: orderId ?? undefined },
    );

    const parsed = parseEwbResponse(ewbResponse);
    if (!parsed.ewbNo) {
      logger.warn('EWB response missing ewayBillNo', {
        invoiceId, responseKeys: Object.keys(ewbResponse ?? {}),
        dataKeys: ewbResponse?.data && typeof ewbResponse.data === 'object'
          ? Object.keys(ewbResponse.data) : null,
      });
    }

    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'active' },
    });

    await prisma.gstDocument.updateMany({
      where: { invoiceId, isLatest: true },
      data: {
        ewbStatus: 'active',
        ewbNo: parsed.ewbNo,
        ewbDate: parsed.validFromDate,
        ewbValidTill: parsed.validToDate,
        // WI-107: clear stale cancelledAt left by a prior EWB cancel
        // (reissue Step 1) so the row reflects the new live EWB.
        cancelledAt: null,
        // Keep raw EWB response so we can audit response-shape drift.
        responsePayload: toJson(ewbResponse),
      },
    });

    logger.info('EWB generated from IRN', { invoiceId, ewbNo: parsed.ewbNo, apiType });
    return { ewbNo: parsed.ewbNo, status: 'active' };
  } catch (ewbErr: unknown) {
    const { code: errCode, message: errMsg } = errInfo(ewbErr);
    // Per NIC: 604 = "EWB already exists for this document". The EWB exists
    // on the portal but the API doesn't return it — recover via IRN-details.
    const isAlreadyExists = errCode === '604' || errMsg.includes('604');
    if (isAlreadyExists) {
      await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
      await prisma.gstDocument.updateMany({
        where: { invoiceId, isLatest: true },
        data: { ewbStatus: 'active', cancelledAt: null },
      });
      const recovered = await recoverEwbFromIrn(invoiceId, distributorId, irn);
      logger.info('EWB already exists on portal (604)', { invoiceId, recovered: !!recovered });
      return recovered
        ? { ewbNo: recovered.ewbNo, status: 'active', source: 'recovered_from_irn' }
        : { status: 'already_exists' };
    }
    // Non-fatal: surface the failure, mark EWB failed, raise pending action.
    // (Includes 620 "Total invoice value < assessable + taxes", a payload
    // bug we want surfaced rather than silently marked active.)
    await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
    await createPendingAction(distributorId, invoiceId, 'EWB_GENERATION', errMsg);
    return { status: 'failed', error: errMsg };
  }
}

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

  const result: {
    irn?: {
      irn?: string;
      ackNo?: string | number;
      status: string;
      message?: string;
      recoveredIrn?: string | null;
    };
    ewb?: {
      ewbNo?: string | number | null;
      status: string;
      source?: string;
    };
    errors: string[];
  } = { errors: [] };

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
      // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-inclusive,
      // BEFORE discount. payloadBuilders applies the single /1.18 itself.
      unitPrice: toNum(item.unitPrice),
      discountPerUnit: toNum(item.discountPerUnit),
      gstRate: item.gstRate || 18,
    })),
    isInterState,
  };

  // Get credential email once for all GST API calls
  const credEmail = (await getCredentials(distributorId, 'einvoice'))!.email;

  // Step 1: Generate IRN (B2B only)
  //
  // CRITICAL: track IRN success in a local flag. The historical bug here
  // (INV-MP6FSGSNM1N, INV-MP6JW3EH46T on 2026-05-15) was that an error in
  // the EWB sub-block (e.g. recoverEwbFromIrn throw) escaped the inner
  // catch and landed in the outer IRN catch at the bottom — which then
  // overwrote invoice.irnStatus to 'failed' even though NIC had already
  // issued the IRN. The flag lets the outer catch see "IRN succeeded,
  // only EWB blew up" and skip the destructive overwrite.
  let irnPersisted = false;
  if (isB2B) {
    try {
      const irnPayload = buildIrnPayload(invoiceData);
      const email = credEmail;

      const irnResponse = await callWithLog<IrnResponse>(
        distributorId, 'POST',
        `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
        irnPayload, 'einvoice',
        { apiType: 'IRN_GENERATE', invoiceId, orderId: invoice.orderId },
      );

      const irn = irnResponse.data?.Irn || irnResponse.Irn;
      const ackNo = irnResponse.data?.AckNo || irnResponse.AckNo;
      const ackDt = irnResponse.data?.AckDt || irnResponse.AckDt;
      const signedQr = irnResponse.data?.SignedQRCode || irnResponse.SignedQRCode;

      // Blank-IRN phantom-success guard. Mirrors the EWB equivalent at the
      // post-delivery branch below (search "phantom-success guard"). NIC /
      // WhiteBooks sandbox occasionally returns `{status_cd:'Sucess'}` with
      // NO Irn — pre-guard the old code wrote `irnStatus='success'` with
      // `irn=NULL`, then every downstream feature (PDF, EWB recovery, CN/DN
      // linkage) that reads `invoice.irn` silently broke despite the green
      // badge. Throw here so the outer catch (search "catch (irnErr") runs
      // the `!irnPersisted` branch and (a) stamps `irnStatus='failed'`,
      // (b) creates the IRN_GENERATION pending action, (c) pushes the
      // error into `result.errors`. Dispatch is NOT blocked by this guard —
      // the outer catch returns normally so the trip still proceeds.
      if (!irn) {
        throw new GstError(
          'IRN generation returned status_cd=success but no Irn — retry from Billing',
          'IRN_PHANTOM_SUCCESS',
        );
      }

      // WhiteBooks may return EWB data along with IRN (auto-generated).
      // The sandbox has been observed to use both naming conventions for
      // dates — the IRN-style keys (EwbDt / EwbValidTill) and the EWB-style
      // keys (validFrom / validTo). Try both so we don't silently drop the
      // dates when only one set is present.
      const irnEwbNo = irnResponse.data?.EwbNo ?? irnResponse.EwbNo;
      const irnEwbDt = irnResponse.data?.EwbDt ?? irnResponse.EwbDt
        ?? irnResponse.data?.validFrom ?? irnResponse.validFrom;
      const irnEwbValidTill = irnResponse.data?.EwbValidTill ?? irnResponse.EwbValidTill
        ?? irnResponse.data?.validTo ?? irnResponse.validTo;
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
      // From this point on, IRN is committed to the DB. Any thrown error
      // in the EWB step MUST NOT cause the outer catch to overwrite
      // irnStatus back to 'failed' — see comment on `irnPersisted` above.
      irnPersisted = true;

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
          requestPayload: toJson(irnPayload), responsePayload: toJson(irnResponse),
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
          // WI-107: delegate to the shared helper (also used by the B2B
          // reissue path). Non-fatal — never throws for a NIC error.
          const ewbResult = await generateEwbFromIrn(distributorId, invoiceId, {
            irnPayload,
            vehicleNumber: invoice.order.vehicle.vehicleNumber,
            email,
            irn: irn!, // committed above (irnStatus='success'); never undefined here
            orderId: invoice.orderId,
            apiType: 'EWB_GENERATE_BY_IRN',
          });
          if (ewbResult.status === 'failed') {
            result.errors.push(`EWB failed: ${ewbResult.error ?? 'unknown error'}`);
          } else {
            result.ewb = {
              ewbNo: ewbResult.ewbNo,
              status: ewbResult.status === 'already_exists' ? 'already_exists' : 'active',
              ...(ewbResult.source ? { source: ewbResult.source } : {}),
            };
          }
        }
      }
    } catch (irnErr: unknown) {
      const { code: irnErrCode, message: irnErrMessage } = errInfo(irnErr);
      result.errors.push(`IRN failed: ${irnErrMessage}`);

      // Handle duplicate IRN (already exists on portal)
      if (irnErrCode === '2150') {
        // WI-057 gap G2 — recover the existing IRN from the portal
        // instead of leaving invoice.irn NULL. Without this every
        // downstream feature (PDF, EWB recovery, CN/DN linkage) that
        // reads invoice.irn silently breaks despite irnStatus='success'.
        let recoveredIrn: string | null = null;
        try {
          const recovered = await getIrnByDocDetails(
            distributorId,
            'INV',
            invoice.invoiceNumber,
            invoice.issueDate ?? invoice.createdAt,
          );
          if (recovered?.irn) {
            recoveredIrn = recovered.irn;
            await prisma.invoice.update({
              where: { id: invoiceId },
              data: {
                irn: recovered.irn,
                ackNo: recovered.ackNo,
                ackDate: recovered.ackDate ?? null,
                irnStatus: 'success',
              },
            });
            // Also persist a gst_documents row so PDF + EWB recovery
            // can read the IRN from there. If a row already exists
            // (race), upsert via gstDocNo uniqueness on the index.
            const existingDoc = await prisma.gstDocument.findFirst({
              where: { invoiceId, isLatest: true, deletedAt: null },
            });
            if (existingDoc) {
              await prisma.gstDocument.update({
                where: { id: existingDoc.id },
                data: {
                  irn: recovered.irn,
                  ackNo: recovered.ackNo,
                  ackDate: recovered.ackDate ?? null,
                  signedQr: recovered.signedQr,
                  irnStatus: 'success',
                },
              });
            } else {
              await prisma.gstDocument.create({
                data: {
                  invoiceId,
                  orderId: invoice.orderId,
                  distributorId,
                  docType: 'INV',
                  gstDocNo: invoice.invoiceNumber,
                  irnStatus: 'success',
                  irn: recovered.irn,
                  ackNo: recovered.ackNo,
                  ackDate: recovered.ackDate ?? null,
                  signedQr: recovered.signedQr,
                  isLatest: true,
                },
              });
            }
            irnPersisted = true;
          } else {
            // Couldn't recover — portal accepts the doc but we have no
            // local IRN. Mark success so the dispatch isn't blocked but
            // flag a pending action so an admin can chase it.
            await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'success' } });
            await createPendingAction(
              distributorId, invoiceId, 'IRN_GENERATION',
              `2150 duplicate but GETIRNBYDOCDETAILS returned no IRN — manual lookup needed`,
            );
          }
        } catch (recoverErr: unknown) {
          logger.error('2150 recovery: GETIRNBYDOCDETAILS itself threw', {
            invoiceId, err: errInfo(recoverErr).message,
          });
          await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'success' } });
        }
        result.irn = {
          status: 'duplicate',
          message: 'IRN already exists on portal',
          recoveredIrn,
        };

        // Still try to generate EWB even if IRN is duplicate
        if (invoice.order?.vehicle) {
          try {
            const dupIrnPayload = buildIrnPayload(invoiceData);
            const ewbPayload = buildEwbPayload(dupIrnPayload, {
              vehicleNumber: invoice.order.vehicle.vehicleNumber,
              transportMode: '1',
              distance: 1,
            });
            const ewbResponse = await callWithLog<EwbResponse>(distributorId, 'POST',
              `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
              ewbPayload, 'ewaybill',
              { apiType: 'EWB_GENERATE_BY_IRN_DUP', invoiceId, orderId: invoice.orderId });
            const ewbData = ewbResponse.data && typeof ewbResponse.data === 'object'
              ? ewbResponse.data : undefined;
            const ewbNo = ewbData?.ewayBillNo;
            const ewbDate = ewbData?.validFrom;
            const ewbValidTill = ewbData?.validTo;
            await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
            // Ensure there's a gstDocument row to hold the EWB details
            // (the dup-IRN branch entered the catch block before creating
            // the row, so we either upsert it or create it now).
            const existingDoc = await prisma.gstDocument.findFirst({
              where: { invoiceId, isLatest: true },
            });
            if (existingDoc) {
              await prisma.gstDocument.update({
                where: { id: existingDoc.id },
                data: {
                  ewbStatus: 'active',
                  ewbNo: ewbNo?.toString(),
                  ewbDate: ewbDate ? new Date(ewbDate) : null,
                  ewbValidTill: ewbValidTill ? new Date(ewbValidTill) : null,
                },
              });
            } else {
              await prisma.gstDocument.create({
                data: {
                  invoiceId, orderId: invoice.orderId, distributorId,
                  docType: 'INV', gstDocNo: invoice.invoiceNumber,
                  irnStatus: 'success',
                  ewbStatus: 'active',
                  ewbNo: ewbNo?.toString(),
                  ewbDate: ewbDate ? new Date(ewbDate) : null,
                  ewbValidTill: ewbValidTill ? new Date(ewbValidTill) : null,
                  responsePayload: toJson(ewbResponse),
                  isLatest: true,
                },
              });
            }
            result.ewb = { ewbNo, status: 'active' };
          } catch (ewbErr: unknown) {
            const { code: dupEwbCode, message: dupEwbMessage } = errInfo(ewbErr);
            if (dupEwbCode === '620' || dupEwbMessage.includes('620')) {
              await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
              await prisma.gstDocument.updateMany({
                where: { invoiceId, isLatest: true },
                data: { ewbStatus: 'active' },
              });
              result.ewb = { status: 'already_exists' };
              logger.info('EWB already exists on portal (620, dup IRN path)', { invoiceId });
            } else {
              result.errors.push(`EWB failed: ${dupEwbMessage}`);
            }
          }
        }
      } else if (!irnPersisted) {
        // WI-084 FIX 1: Before stamping irnStatus='failed', guard against
        // the retry-corruption pattern. When the admin re-dispatches an
        // already-succeeded invoice (e.g. after a SESSION_EXPIRED UI error),
        // processInvoiceGst starts fresh with irnPersisted=false. If this
        // second call then throws, the outer catch must NOT overwrite the
        // committed IRN/irnStatus='success' from the first call.
        // Symptom: INV-MPE5ZM628T4 — real IRN in gst_documents but
        // invoices.irn_status='failed' from the retry SESSION_EXPIRED.
        const alreadyCommitted = await prisma.invoice.findUnique({
          where: { id: invoiceId },
          select: { irn: true },
        });
        if (alreadyCommitted?.irn) {
          logger.warn(
            'processInvoiceGst retry failed but real IRN already committed — preserving success state',
            { invoiceId, irn: alreadyCommitted.irn.substring(0, 16) + '…', err: irnErrMessage },
          );
          return result;
        }
        await prisma.invoice.update({ where: { id: invoiceId }, data: { irnStatus: 'failed' } });
        await createPendingAction(distributorId, invoiceId, 'IRN_GENERATION', irnErrMessage);
      } else {
        // IRN was already persisted; the error came from the EWB sub-step.
        // Surface the EWB failure but DO NOT touch invoice.irnStatus.
        logger.error('IRN succeeded but EWB sub-step threw — leaving irnStatus=success', {
          invoiceId, err: irnErrMessage,
        });
        result.errors.push(`EWB failed after IRN success: ${irnErrMessage}`);
        // Mark EWB as failed since we never finished generating it.
        try {
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
        } catch (uErr) {
          logger.error('Failed to mark ewbStatus=failed after IRN-success EWB throw', { invoiceId, err: (uErr as Error).message });
        }
        await createPendingAction(distributorId, invoiceId, 'EWB_GENERATION', irnErrMessage);
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

        // WI-074 debug: log full payload BEFORE the WhiteBooks call so
        // the actual wire shape is visible in the dev console (not just
        // in gst_api_logs). Strip on next iteration if WI-074 verifies.
        logger.info('[WI-074-DEBUG] B2C post-delivery EWB request payload', {
          invoiceId, orderId: invoice.orderId,
          payload: JSON.stringify(ewbPayload, null, 2),
        });

        const ewbResponse = await callWithLog<EwbResponse>(
          distributorId, 'POST',
          `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(credEmail)}`,
          ewbPayload, 'ewaybill',
          { apiType: 'EWB_GENERATE_B2C', invoiceId, orderId: invoice.orderId },
        );

        // WI-074 debug: log full NIC response (including any info[]
        // array that NIC sometimes includes with field-level details)
        // BEFORE any error handling swallows or normalises it.
        logger.info('[WI-074-DEBUG] B2C post-delivery EWB response', {
          invoiceId, orderId: invoice.orderId,
          response: JSON.stringify(ewbResponse, null, 2),
        });

        const ewbNo = ewbResponse.data && typeof ewbResponse.data === 'object'
          ? ewbResponse.data.ewayBillNo : undefined;
        if (!ewbNo) {
          // WI-071 Defect B — WhiteBooks/NIC sandbox occasionally returns
          // `{status_cd:'1', status_desc:'Sucess'}` with NO data block /
          // NO ewayBillNo. The old code wrote `ewb_status='active'` +
          // `ewb_no=NULL` to gst_documents (phantom EWB), the UI then
          // displayed a green "active" badge with no real e-Way Bill
          // behind it. Live case: INV-MPCDW7DR6F7, 2026-05-19 08:42:58.
          // Treat as failure — pending action + ewb_status='failed'.
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
          await createPendingAction(
            distributorId, invoiceId, 'EWB_GENERATION',
            'EWB generation returned status_cd=1 but no ewayBillNo — retry from Billing',
          );
          result.errors.push('B2C EWB: success response without ewayBillNo');
          logger.warn('B2C EWB phantom-success (no ewayBillNo) — marked failed', { invoiceId });
        } else {
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });

          await prisma.gstDocument.create({
            data: {
              invoiceId, orderId: invoice.orderId, distributorId,
              docType: 'INV', gstDocNo: invoice.invoiceNumber,
              ewbStatus: 'active', ewbNo: ewbNo.toString(),
              requestPayload: toJson(ewbPayload), responsePayload: toJson(ewbResponse),
              isLatest: true,
            },
          });

          result.ewb = { ewbNo, status: 'active' };
          logger.info('B2C EWB generated', { invoiceId, ewbNo });
        }
      } catch (ewbErr: unknown) {
        const { code: b2cEwbCode, message: b2cEwbMessage } = errInfo(ewbErr);
        if (b2cEwbCode === '620' || b2cEwbMessage.includes('620')) {
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'active' } });
          result.ewb = { status: 'already_exists' };
          logger.info('B2C EWB already exists on portal (620)', { invoiceId });
        } else {
          result.errors.push(`B2C EWB failed: ${b2cEwbMessage}`);
          await prisma.invoice.update({ where: { id: invoiceId }, data: { ewbStatus: 'failed' } });
          await createPendingAction(distributorId, invoiceId, 'EWB_GENERATION', b2cEwbMessage);
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
      unitPrice: toNum(item.unitPrice),
      discountPerUnit: toNum(item.discountPerUnit),
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

    const email = (await getCredentials(distributorId, 'einvoice'))!.email;

    const ewbResponse = await callWithLog<EwbResponse>(
      distributorId, 'POST',
      `/ewaybillapi/v1.03/ewayapi/genewaybill?email=${encodeURIComponent(email)}`,
      ewbPayload, 'ewaybill',
      { apiType: 'EWB_GENERATE_DISPATCH', orderId },
    );

    const ewbData = ewbResponse.data && typeof ewbResponse.data === 'object'
      ? ewbResponse.data : undefined;
    const ewbNo = ewbData?.ewayBillNo;

    // Store EWB in GstDocument (no invoice yet at dispatch)
    await prisma.gstDocument.create({
      data: {
        orderId,
        distributorId,
        docType: 'INV',
        gstDocNo: order.orderNumber,
        ewbStatus: 'active',
        ewbNo: ewbNo?.toString(),
        ewbDate: ewbData?.validFrom ? new Date(ewbData.validFrom) : null,
        ewbValidTill: ewbData?.validTo ? new Date(ewbData.validTo) : null,
        requestPayload: toJson(ewbPayload),
        responsePayload: toJson(ewbResponse),
        isLatest: true,
      },
    });

    logger.info('Dispatch EWB generated', { orderId, ewbNo });
    return { ewbNo, status: 'active' };
  } catch (err: unknown) {
    const { code: dispatchEwbCode, message: dispatchEwbMessage } = errInfo(err);
    // Handle error 620: EWB already exists for this document (common in sandbox/re-runs)
    if (dispatchEwbCode === '620' || dispatchEwbMessage.includes('620')) {
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
          description: `Dispatch EWB failed: ${dispatchEwbMessage}`.substring(0, 500),
          severity: 'high',
          status: 'open',
        },
      });
    } catch (paErr) {
      logger.error('Failed to create pending action for dispatch EWB', { orderId, err: paErr });
    }
    return { status: 'failed', error: dispatchEwbMessage };
  }
}

/**
 * NIC reason codes for IRN/EWB cancellation:
 *   '1' = Duplicate
 *   '2' = Data Entry Mistake
 *   '3' = Order Cancelled
 *   '4' = Others
 * Always passed in explicitly by the caller (web modal dropdown). The
 * older keyword-matching path that guessed a code from the free text
 * (e.g. "duplicate" → 1) was unreliable — every "Wrong GSTIN" got code 4.
 */
export type GstCancelReasonCode = '1' | '2' | '3' | '4';

/**
 * Persist cancellation context on the `gst_documents` row. Typed
 * Prisma update — the three new columns (cancelReason,
 * cancelReasonCode, cancelledByUserId) are part of the GstDocument
 * model as of migration 20260601000000_gst_document_cancel_fields.
 */
async function persistCancellation(
  invoiceId: string,
  fields: { reason: string; reasonCode: GstCancelReasonCode; userId: string | null },
) {
  await prisma.gstDocument.updateMany({
    where: { invoiceId, isLatest: true },
    data: {
      cancelReason: fields.reason,
      cancelReasonCode: fields.reasonCode,
      cancelledByUserId: fields.userId,
    },
  });
}

/**
 * Cancel an IRN for an invoice.
 * @param reasonCode NIC code ('1'-'4'). Required as of GROUP-7S.
 * @param userId optional — the user who clicked Cancel in the web modal.
 */
export async function cancelIrn(
  invoiceId: string,
  distributorId: string,
  reason: string,
  reasonCode: GstCancelReasonCode,
  userId: string | null = null,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: { irn: true, invoiceNumber: true, orderId: true },
  });
  if (!invoice?.irn) throw new GstError('Invoice has no IRN to cancel', 'NO_IRN');

  // NIC enforces a hard cancel order: EWB must be cancelled BEFORE IRN.
  // Attempting to cancel an IRN that still has an active EWB returns a
  // portal error and leaves both documents in an inconsistent state.
  // Pattern lifted from the legacy einvoiceService.js. Caller should
  // call cancelEwb() first, then cancelIrn().
  const activeEwb = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, ewbStatus: 'active', ewbNo: { not: null } },
    select: { ewbNo: true },
  });
  if (activeEwb?.ewbNo) {
    throw new GstError(
      `Cannot cancel IRN: an active e-way bill exists for this invoice (EWB No: ${activeEwb.ewbNo}). Cancel the e-way bill first.`,
      'EWB_ACTIVE',
    );
  }

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  const cancelPayload = {
    Irn: invoice.irn,
    CnlRsn: reasonCode,
    CnlRem: reason.substring(0, 100),
  };

  // WI-086 FIX: clearTokenCache removed from here. It is now called once
  // by the cancel orchestrator (cancelOrder in orderService) before the
  // EWB+IRN sequence, so both cancel calls share the same fresh NIC
  // session. Standalone retries via POST /invoices/:id/cancel-irn evict
  // in the route handler.
  const response = await callWithLog<IrnResponse>(
    distributorId, 'POST',
    `/einvoice/type/CANCEL/version/V1_03?email=${encodeURIComponent(email)}`,
    cancelPayload, 'einvoice',
    { apiType: 'IRN_CANCEL', invoiceId, orderId: invoice.orderId },
  );

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { irnStatus: 'cancelled', status: 'cancelled' },
  });

  await prisma.gstDocument.updateMany({
    where: { invoiceId, isLatest: true },
    data: { irnStatus: 'cancelled', cancelledAt: new Date() },
  });

  // GROUP-7S: persist the operator-supplied reason + structured code +
  // user — until now they were dropped from the domain row and only
  // available via gst_api_logs.request_payload.
  await persistCancellation(invoiceId, { reason, reasonCode, userId });

  logger.info('IRN cancelled', { invoiceId, irn: invoice.irn, reasonCode });
  return response;
}

/**
 * Cancel an EWB for an invoice. Same reasonCode semantics as cancelIrn.
 */
export async function cancelEwb(
  invoiceId: string,
  distributorId: string,
  reason: string,
  reasonCode: GstCancelReasonCode,
  userId: string | null = null,
) {
  const gstDoc = await prisma.gstDocument.findFirst({
    where: { invoiceId, isLatest: true, ewbNo: { not: null } },
  });
  if (!gstDoc?.ewbNo) throw new GstError('No e-Way Bill found for this invoice', 'NO_EWB');

  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  // WI-086 FIX: clearTokenCache removed from here — see note in cancelIrn.
  const response = await callWithLog<EwbResponse>(
    distributorId, 'POST',
    `/ewaybillapi/v1.03/ewayapi/canewb?email=${encodeURIComponent(email)}`,
    { ewbNo: parseInt(gstDoc.ewbNo), cancelRsnCode: parseInt(reasonCode, 10), cancelRmrk: reason.substring(0, 100) },
    'ewaybill',
    { apiType: 'EWB_CANCEL', invoiceId, orderId: gstDoc.orderId },
  );

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { ewbStatus: 'cancelled' },
  });

  await prisma.gstDocument.updateMany({
    where: { invoiceId, isLatest: true },
    data: { ewbStatus: 'cancelled', cancelledAt: new Date() },
  });

  await persistCancellation(invoiceId, { reason, reasonCode, userId });

  logger.info('EWB cancelled', { invoiceId, ewbNo: gstDoc.ewbNo, reasonCode });
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
  // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-inclusive, before discount.
  const proportion = toNum(cn.totalAmount) / toNum(cn.invoice.totalAmount);
  const items = cn.invoice.items.map((item, idx) => ({
    slNo: idx + 1,
    description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
    hsnCode: item.hsnCode || '27111900',
    quantity: Math.max(1, Math.round(item.quantity * proportion)),
    unit: 'NOS',
    unitPrice: toNum(item.unitPrice),
    discountPerUnit: toNum(item.discountPerUnit),
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
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  try {
    const response = await callWithLog<IrnResponse>(
      distributorId, 'POST',
      `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
      payload, 'einvoice',
      { apiType: 'IRN_GENERATE_CRN', invoiceId: cn.invoiceId },
    );

    const irn = response.data?.Irn || response.Irn;
    await prisma.gstDocument.create({
      data: {
        invoiceId: cn.invoiceId, distributorId,
        docType: 'CRN', gstDocNo: data.docNumber,
        irnStatus: 'success', irn, ackNo: (response.data?.AckNo || response.AckNo)?.toString(),
        requestPayload: toJson(payload), responsePayload: toJson(response), isLatest: true,
      },
    });

    logger.info('Credit note IRN generated', { creditNoteId, irn });
    return { irn, status: 'success' };
  } catch (err: unknown) {
    const message = errInfo(err).message;
    await createPendingAction(distributorId, cn.invoiceId, 'CRN_IRN_GENERATION', message);
    return { status: 'failed', error: message };
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

  // CLAUDE.md anti-pattern #16: InvoiceItem.unitPrice is GST-inclusive, before discount.
  const proportion = toNum(dn.totalAmount) / toNum(dn.invoice.totalAmount);
  const items = dn.invoice.items.map((item, idx) => ({
    slNo: idx + 1,
    description: item.description || item.cylinderType?.typeName || 'LPG Cylinder',
    hsnCode: item.hsnCode || '27111900',
    quantity: Math.max(1, Math.round(item.quantity * proportion)),
    unit: 'NOS',
    unitPrice: toNum(item.unitPrice),
    discountPerUnit: toNum(item.discountPerUnit),
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
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  try {
    const response = await callWithLog<IrnResponse>(
      distributorId, 'POST',
      `/einvoice/type/GENERATE/version/V1_03?email=${encodeURIComponent(email)}`,
      payload, 'einvoice',
      { apiType: 'IRN_GENERATE_DBN', invoiceId: dn.invoiceId },
    );

    const irn = response.data?.Irn || response.Irn;
    await prisma.gstDocument.create({
      data: {
        invoiceId: dn.invoiceId, distributorId,
        docType: 'DBN', gstDocNo: data.docNumber,
        irnStatus: 'success', irn, ackNo: (response.data?.AckNo || response.AckNo)?.toString(),
        requestPayload: toJson(payload), responsePayload: toJson(response), isLatest: true,
      },
    });

    logger.info('Debit note IRN generated', { debitNoteId, irn });
    return { irn, status: 'success' };
  } catch (err: unknown) {
    const message = errInfo(err).message;
    await createPendingAction(distributorId, dn.invoiceId, 'DBN_IRN_GENERATION', message);
    return { status: 'failed', error: message };
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

  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  try {
    const response = await callWithLog<WhiteBooksEnvelope>(
      distributorId, 'GET',
      `/einvoice/type/GSTNDETAILS/version/V1_03?param1=${gstin}&email=${encodeURIComponent(email)}`,
      undefined, 'einvoice',
      { apiType: 'GSTIN_LOOKUP' },
    );

    return {
      valid: true,
      source: 'whitebooks',
      data: response.data,
    };
  } catch (err: unknown) {
    return { valid: false, source: 'whitebooks', error: errInfo(err).message };
  }
}

/**
 * WI-057 gap G2 — recover an IRN by document details after error 2150.
 *
 * NIC returns 2150 ("duplicate IRN — already exists on portal") when we
 * try to GENERATE an IRN for a docNo/docType/docDate that's already been
 * issued. The error response does NOT echo back the existing IRN value,
 * so without this lookup we set irnStatus='success' but leave invoice.irn
 * NULL — every downstream feature (PDF, EWB recovery, CN/DN linkage)
 * silently breaks.
 *
 * GETIRNBYDOCDETAILS returns the existing IRN + ack metadata so we can
 * persist them as if the GENERATE call had succeeded.
 *
 * `docDate` is formatted as DD/MM/YYYY per NIC convention.
 */
export async function getIrnByDocDetails(
  distributorId: string,
  docType: 'INV' | 'CRN' | 'DBN',
  docNo: string,
  docDate: Date,
): Promise<{ irn?: string; ackNo?: string; ackDate?: Date; signedQr?: string } | null> {
  const distributor = await prisma.distributor.findUnique({
    where: { id: distributorId },
    select: { email: true },
  });
  const email =
    (await getCredentials(distributorId, 'einvoice'))!.email;

  const dd = docDate.getUTCDate().toString().padStart(2, '0');
  const mm = (docDate.getUTCMonth() + 1).toString().padStart(2, '0');
  const yyyy = docDate.getUTCFullYear();
  const param1 = `${docType}:${docNo}:${dd}/${mm}/${yyyy}`;

  try {
    const response = await callWithLog<IrnResponse>(
      distributorId,
      'GET',
      `/einvoice/type/GETIRNBYDOCDETAILS/version/V1_03?param1=${encodeURIComponent(param1)}&email=${encodeURIComponent(email)}`,
      undefined,
      'einvoice',
      { apiType: 'IRN_GET_BY_DOC' },
    );
    const d = response?.data ?? response ?? {};
    const irn = d.Irn ?? d.irn;
    if (!irn) return null;
    return {
      irn,
      ackNo: (d.AckNo ?? d.ackNo)?.toString(),
      ackDate: d.AckDt
        ? new Date(d.AckDt)
        : d.ackDate
          ? new Date(d.ackDate)
          : undefined,
      signedQr: d.SignedQRCode ?? d.signedQr,
    };
  } catch (err: unknown) {
    logger.warn('GETIRNBYDOCDETAILS lookup failed', {
      distributorId, docType, docNo, err: errInfo(err).message,
    });
    return null;
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
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  return callWithLog<IrnResponse>(
    distributorId, 'GET',
    `/einvoice/type/GETIRN/version/V1_03?param1=${irn}&email=${encodeURIComponent(email)}`,
    undefined, 'einvoice',
    { apiType: 'IRN_GET_DETAILS' },
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
  const email = (await getCredentials(distributorId, 'einvoice'))!.email;

  return callWithLog<EwbResponse>(
    distributorId, 'GET',
    `/ewaybillapi/v1.03/ewayapi/getewaybill?email=${encodeURIComponent(email)}&ewbNo=${ewbNo}`,
    undefined, 'ewaybill',
    { apiType: 'EWB_GET_STATUS' },
  );
}

/**
 * After hitting error 620 ("EWB already exists on portal"), the portal
 * doesn't echo back the existing ewb number — but the IRN-details endpoint
 * does, because WhiteBooks links the EWB to the IRN at the portal level.
 * Fetch the IRN record and, if it carries EWB fields, persist them onto
 * the invoice + gst_document so users see a real number instead of just
 * a green pill with no detail.
 *
 * Idempotent: safe to call even when nothing comes back; just leaves
 * the rows untouched.
 */
export async function recoverEwbFromIrn(invoiceId: string, distributorId: string, irn: string) {
  try {
    const details = await getIrnDetails(distributorId, irn);
    const d = details?.data ?? details ?? {};
    const ewbNo = d.EwbNo ?? d.ewbNo;
    const ewbDt = d.EwbDt ?? d.ewbDt ?? d.validFrom;
    const ewbValidTill = d.EwbValidTill ?? d.ewbValidTill ?? d.validTo;
    if (!ewbNo || ewbNo === 0 || ewbNo === '0') {
      logger.info('IRN details had no EWB info to recover', { invoiceId, irn });
      return null;
    }
    // NIC returns dates in DD/MM/YYYY hh:mm:ss AM/PM — parseWhitebooksDate
    // handles that format. Plain new Date() returns Invalid Date.
    const ewbDate = parseWhitebooksDate(ewbDt);
    const ewbValidTillDate = parseWhitebooksDate(ewbValidTill);
    await prisma.gstDocument.updateMany({
      where: { invoiceId, isLatest: true },
      data: {
        ewbStatus: 'active',
        ewbNo: ewbNo.toString(),
        ewbDate,
        ewbValidTill: ewbValidTillDate,
      },
    });
    await prisma.invoice.update({
      where: { id: invoiceId },
      data: { ewbStatus: 'active' },
    });
    logger.info('Recovered EWB from IRN details after 620', { invoiceId, ewbNo });
    return { ewbNo: ewbNo.toString(), ewbDate, ewbValidTill: ewbValidTillDate?.toISOString() ?? null };
  } catch (err: unknown) {
    logger.warn('Failed to recover EWB from IRN after 620', { invoiceId, irn, error: errInfo(err).message });
    return null;
  }
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
      await cancelIrn(invoiceId, distributorId, 'Order items changed - regenerating invoice', '4');
    } catch (err: unknown) {
      logger.warn('Failed to cancel IRN during regeneration', { invoiceId, error: errInfo(err).message });
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
// WI-105 PART 1 — raw-error classifiers. NIC rarely echoes the offending field,
// so we pattern-match the message we captured at the call site.
const DUPLICATE_IRN_PATTERNS = /\b2150\b|duplicate irn|already exists/i;
const GSTIN_INVALID_PATTERNS = /invalid gstin|gstin[^.]*invalid|\b3028\b|\b3029\b|gstin.*not.*valid/i;
const NIC_OUTAGE_PATTERNS = /\b5002\b|\b503\b|temporarily unavailable|service unavailable|timed?\s*out|timeout|session expired|ENOTFOUND|ECONNRESET|gateway/i;

/**
 * WI-105 PART 1 — turn a raw GST/NIC error into an admin-readable description
 * plus a normalized cause code (the web uses the code to pick the action-button
 * label). `ctx` carries the invoice / order / customer identifiers that make the
 * message actionable. Pure function (no I/O) so it is unit-testable.
 */
// NIC error-code surface (added 2026-05-30 after the demo IRN+EWB session
// surfaced error 225 — invalid vehicle plate — as a useless "failed
// unexpectedly" pending action). NIC echoes the numeric code in its
// `{"errorCodes":"NNN,"}` envelope; we pull it out and look up a human-
// readable remedy. The glossary is intentionally NOT exhaustive — every
// unknown code falls back to "NIC error N. Raw: …" so the operator at
// least sees the code and the original message instead of silence.
const NIC_CODE_RE = /"errorCodes"\s*:\s*"(\d+)/i;
const NIC_GLOSSARY: Record<string, string> = {
  '225': 'Invalid vehicle registration number. Update in Fleet → Vehicles to a valid Indian RTO format (e.g. KA01-AB-1234), then click Retry.',
  '226': 'Invalid transport document number. Contact support.',
  '616': 'GST JSON validation failed. Check customer GSTIN, pincode and address, then Retry.',
  '619': 'GST JSON validation failed. Check customer GSTIN, pincode and address, then Retry.',
  '702': 'NIC could not calculate distance between pincodes. Set transport distance manually, then Retry.',
  '720': 'Distance exceeds 4000 km limit. Verify pincodes are correct.',
  '721': 'Zero distance between pincodes. Verify depot and delivery pincodes differ.',
  '2150': 'Duplicate IRN — already generated for this invoice.',
  '3028': 'Supplier GSTIN invalid or inactive. Verify GSTIN on the GST portal.',
  '3029': 'Recipient GSTIN invalid or inactive. Check customer GSTIN in Customers settings.',
};
// Backward compat: for codes that overlap with the legacy DUPLICATE / GSTIN /
// OUTAGE pattern branches, preserve the legacy errorCode value the web pages
// already consume to pick action-button labels. New codes get `NIC_<code>`.
const NIC_CODE_LEGACY_ERROR_CODE: Record<string, string> = {
  '2150': 'DUPLICATE_IRN',
  '3028': 'GSTIN_INVALID',
  '3029': 'GSTIN_INVALID',
  '5002': 'NIC_OUTAGE',
};

export function buildPendingActionDescription(
  actionType: string,
  rawMessage: string,
  ctx: { invoiceNumber?: string | null; orderNumber?: string | null; customerName?: string | null },
): { description: string; errorCode: string | null } {
  const inv = ctx.invoiceNumber ?? 'this invoice';
  const ord = ctx.orderNumber ?? 'this order';
  const who = ctx.customerName ?? 'customer';
  const raw = rawMessage ?? '';

  // First pass: numeric NIC code in the envelope. Matches before the
  // pattern-bucket checks below so the operator sees the specific remedy.
  // Falls through to existing patterns when no numeric code is present
  // (transport-layer errors, locally-raised messages, etc.).
  const nicMatch = raw.match(NIC_CODE_RE);
  const nicCode = nicMatch?.[1];
  if (nicCode) {
    const remedy = NIC_GLOSSARY[nicCode];
    const errorCode = NIC_CODE_LEGACY_ERROR_CODE[nicCode] ?? `NIC_${nicCode}`;
    if (remedy) {
      return {
        description: `Invoice ${inv} for ${who}: NIC error ${nicCode} — ${remedy}`,
        errorCode,
      };
    }
    // Unknown code — still useful: code + raw excerpt so the operator can
    // search support docs or file a ticket without digging into gst_api_logs.
    return {
      description: `Invoice ${inv} for ${who}: NIC error ${nicCode}. Message: ${raw.slice(0, 150)}. Click Retry or contact support.`,
      errorCode,
    };
  }

  // Duplicate IRN (NIC 2150) — the IRN likely already exists; admin links it.
  if (DUPLICATE_IRN_PATTERNS.test(raw)) {
    return {
      description: `Invoice ${inv} for ${who}: NIC flagged this as a duplicate IRN. The IRN may already exist — click Look Up IRN to find and link it.`,
      errorCode: 'DUPLICATE_IRN',
    };
  }

  // Invalid customer GSTIN — admin fixes the GSTIN, then retries.
  if (GSTIN_INVALID_PATTERNS.test(raw)) {
    return {
      description: `Order ${ord} for ${who}: GSTIN on file is invalid. Update the customer GSTIN in Customers → ${who} → Edit, then click Retry.`,
      errorCode: 'GSTIN_INVALID',
    };
  }

  // NIC portal outage / 5002 — no admin action, just retry once NIC is back.
  if (NIC_OUTAGE_PATTERNS.test(raw)) {
    return {
      description: `Invoice ${inv}: NIC portal is temporarily unavailable. No action needed — click Retry when NIC is back online.`,
      errorCode: 'NIC_OUTAGE',
    };
  }

  // IRN cancellation could not complete at NIC — manual portal action.
  if (actionType === 'IRN_CANCEL_BLOCKED') {
    return {
      description: `Invoice ${inv}: Could not cancel the original IRN on NIC. Manual cancellation required on the NIC portal before the revised invoice is valid.`,
      errorCode: 'IRN_CANCEL_BLOCKED',
    };
  }

  // e-Way Bill generation crashed / returned an undefined error — retry.
  if (
    actionType === 'EWB_GENERATION' ||
    actionType === 'EWB_REGENERATION_FAILED' ||
    actionType === 'CONSOLIDATED_EWB_FAILED' ||
    actionType === 'DISPATCH_EWB_GENERATION'
  ) {
    return {
      description: `Invoice ${inv} for ${who}: e-Way Bill generation failed unexpectedly. Click Retry to attempt again.`,
      errorCode: null,
    };
  }

  // WI-099 prep — the MODIFIED_DELIVERY_REVIEW call site does NOT exist yet.
  // When WI-099 adds it, format the description as:
  //   `Order ${ord} for ${who}: Driver delivered [X] [KG], ordered [Y] [KG]. ` +
  //   `Review the difference and approve to update the GST invoice.`
  // (X/Y/UOM come from the order's delivered vs ordered quantities.)

  // IRN generation (incl. CN/DN IRN) — retry.
  if (
    actionType === 'IRN_GENERATION' ||
    actionType === 'IRN_REGENERATION_FAILED' ||
    actionType === 'CRN_IRN_GENERATION' ||
    actionType === 'DBN_IRN_GENERATION'
  ) {
    return {
      description: `Invoice ${inv} for ${who}: e-Invoice (IRN) generation failed. Click Retry to attempt again.`,
      errorCode: null,
    };
  }

  // Unknown actionType — prefix the invoice number onto the raw message.
  return {
    description: `Invoice ${inv} for ${who}: ${raw || 'Action required.'}`.substring(0, 500),
    errorCode: null,
  };
}

export async function createPendingAction(
  distributorId: string,
  invoiceId: string,
  actionType: string,
  errorMessage: string,
  severity: 'low' | 'medium' | 'high' | 'critical' = 'high',
): Promise<{ id: string } | null> {
  try {
    // Look up invoice context (number, customer, order) so the message is
    // actionable. entityId is usually an invoiceId, but some callers (e.g.
    // CONSOLIDATED_EWB_FAILED passes a DVA id) won't match — degrade gracefully.
    const invoice = await prisma.invoice.findFirst({
      where: { id: invoiceId, distributorId },
      select: {
        invoiceNumber: true,
        customer: { select: { customerName: true } },
        order: { select: { orderNumber: true } },
      },
    });
    const { description, errorCode } = buildPendingActionDescription(actionType, errorMessage, {
      invoiceNumber: invoice?.invoiceNumber,
      orderNumber: invoice?.order?.orderNumber,
      customerName: invoice?.customer?.customerName,
    });

    // WI-105 PART 2 — dedup. No DB unique constraint exists on
    // (distributorId, entityId, actionType, status), so findFirst the OPEN row
    // and refresh it instead of piling up a new row on every retry.
    const existing = await prisma.pendingAction.findFirst({
      where: { distributorId, entityId: invoiceId, actionType, status: 'open' },
      select: { id: true },
    });
    if (existing) {
      await prisma.pendingAction.update({
        where: { id: existing.id },
        data: {
          description: description.substring(0, 500),
          errorCode,
          errorMessage: errorMessage.substring(0, 500),
          // updatedAt is bumped automatically (@updatedAt).
        },
      });
      return existing;
    }

    // Consolidated EWB (gencewb) is optional and non-blocking — the dispatch
    // and per-order EWBs already succeeded. Record it for audit but create it
    // pre-resolved so it never surfaces as an open action item to the distributor.
    const nonBlocking = actionType === 'CONSOLIDATED_EWB_FAILED';
    const row = await prisma.pendingAction.create({
      data: {
        distributorId,
        module: 'gst_compliance',
        entityId: invoiceId,
        entityType: 'invoice',
        actionType,
        description: description.substring(0, 500),
        errorCode,
        errorMessage: errorMessage.substring(0, 500),
        severity,
        status: nonBlocking ? 'resolved' : 'open',
        ...(nonBlocking
          ? { resolutionNotes: 'Non-blocking — consolidated EWB is optional.', resolvedAt: new Date(), resolvedBy: 'system' }
          : {}),
      },
      select: { id: true },
    });
    return row;
  } catch (err) {
    logger.error('Failed to create pending action', { distributorId, invoiceId, actionType, err });
    return null;
  }
}
