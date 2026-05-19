/**
 * Payload builders for WhiteBooks IRN and EWB generation.
 * Follows NIC v1.03 specification.
 *
 * Key: All prices in our DB are GST-inclusive. We reverse-calculate
 * base price for the payload (WhiteBooks expects GST-exclusive amounts).
 */

import { format } from 'date-fns';
import { getTransDistance } from '../../utils/pincodeDistance.js';

const GST_RATE = 18;
const CGST_RATE = 9;
const SGST_RATE = 9;

interface SellerInfo {
  gstin: string;
  legalName: string;
  tradeName: string;
  address: string;
  address2?: string;
  city: string;
  pincode: string;
  state: string;
  stateCode: string;
  phone?: string;
  email?: string;
}

interface BuyerInfo {
  gstin: string | null; // null for B2C
  legalName: string;
  tradeName?: string;
  address: string;
  address2?: string;
  city: string;
  pincode: string;
  state: string;
  stateCode: string;
  phone?: string;
  email?: string;
}

interface InvoiceItem {
  slNo: number;
  description: string;
  hsnCode: string;
  quantity: number;
  unit: string;
  unitPrice: number;       // GST-inclusive price from DB
  discountPerUnit: number;
  gstRate: number;
}

interface InvoiceData {
  docType: 'INV' | 'CRN' | 'DBN';
  docNumber: string;       // Max 16 chars
  docDate: Date;
  seller: SellerInfo;
  buyer: BuyerInfo;
  items: InvoiceItem[];
  isInterState: boolean;
  // For CRN/DBN
  originalDocNumber?: string;
  originalDocDate?: Date;
  reason?: string;
  // NOTE (2026-05-15): inline EwbDtls support was REMOVED. NIC's
  // /einvoice GENERATE endpoint advertises an inline EWB option in
  // its Postman canonical, but the WhiteBooks sandbox returns generic
  // 5002 "Application error" for every variant we tried (PascalCase,
  // mixed-case, NIC-canonical). We use the proven two-step flow
  // (matches gstService.processInvoiceGst):
  //   1. POST /einvoice/type/GENERATE/version/V1_03 (this builder, no EwbDtls)
  //   2. POST /ewaybillapi/v1.03/ewayapi/genewaybill (buildEwbPayload)
  // Do NOT re-introduce a `transport` field on this interface without
  // first validating against the live sandbox. CLAUDE.md anti-pattern #10.
}

function extractStateCode(gstin: string): string {
  return gstin.substring(0, 2);
}

function sanitize(str: string | null | undefined, maxLen: number, defaultVal: string = ''): string {
  if (!str || str.trim().length === 0) return defaultVal;
  return str.trim().substring(0, maxLen);
}

function sanitizeAddr2(str: string | null | undefined): string {
  const val = sanitize(str, 100);
  return val.length >= 3 ? val : 'N/A';
}

function sanitizePhone(phone: string | null | undefined): string {
  if (!phone) return '919999999999';
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 6 && digits.length <= 12 ? digits : '919999999999';
}

function sanitizeEmail(email: string | null | undefined): string {
  if (!email || email.length < 6 || email.length > 100) return 'info@mygaslink.com';
  return email;
}

function sanitizePin(pin: string | null | undefined): number {
  if (!pin) return 100000;
  const num = parseInt(pin.replace(/\D/g, ''), 10);
  return num >= 100000 && num <= 999999 ? num : 100000;
}

function formatDate(date: Date): string {
  return format(date, 'dd/MM/yyyy');
}

function truncateDocNumber(docNo: string): string {
  // Max 16 chars for NIC
  return docNo.substring(0, 16);
}

/**
 * Build IRN payload for e-Invoice generation
 */
export function buildIrnPayload(data: InvoiceData): any {
  const isB2C = !data.buyer.gstin || data.buyer.gstin === 'URP';
  const sellerStateCode = extractStateCode(data.seller.gstin);

  // Build item list with GST-exclusive calculations
  let totalAssVal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;
  let totalDiscount = 0;

  const itemList = data.items.map(item => {
    // Reverse-calculate GST-exclusive price from inclusive price
    const inclusivePrice = item.unitPrice;
    const exclusivePrice = Math.round((inclusivePrice / (1 + item.gstRate / 100)) * 100) / 100;
    const discountPerUnit = Math.round((item.discountPerUnit / (1 + item.gstRate / 100)) * 100) / 100;

    const totAmt = Math.round(exclusivePrice * item.quantity * 100) / 100;
    const discount = Math.round(discountPerUnit * item.quantity * 100) / 100;
    const assAmt = Math.round((totAmt - discount) * 100) / 100;

    let igstAmt = 0, cgstAmt = 0, sgstAmt = 0;
    if (data.isInterState) {
      igstAmt = Math.round(assAmt * (item.gstRate / 100) * 100) / 100;
    } else {
      cgstAmt = Math.round(assAmt * (CGST_RATE / 100) * 100) / 100;
      sgstAmt = Math.round(assAmt * (SGST_RATE / 100) * 100) / 100;
    }

    const totItemVal = Math.round((assAmt + igstAmt + cgstAmt + sgstAmt) * 100) / 100;

    totalAssVal += assAmt;
    totalCgst += cgstAmt;
    totalSgst += sgstAmt;
    totalIgst += igstAmt;
    totalDiscount += discount;

    return {
      SlNo: String(item.slNo),
      IsServc: 'N',
      PrdDesc: sanitize(item.description, 50, 'LPG Cylinder'),
      HsnCd: item.hsnCode || '27111900',  // Must be string for WhiteBooks API
      Qty: item.quantity,
      Unit: item.unit === 'KG' ? 'NOS' : item.unit, // LPG is sold as units, not weight
      UnitPrice: exclusivePrice,
      TotAmt: totAmt,
      Discount: discount,
      AssAmt: assAmt,
      GstRt: item.gstRate,
      IgstAmt: igstAmt,
      CgstAmt: cgstAmt,
      SgstAmt: sgstAmt,
      CesRt: 0,
      CesAmt: 0,
      CesNonAdvlAmt: 0,
      StateCesRt: 0,
      StateCesAmt: 0,
      StateCesNonAdvlAmt: 0,
      OthChrg: 0,
      TotItemVal: totItemVal,
    };
  });

  // Round totals
  totalAssVal = Math.round(totalAssVal * 100) / 100;
  totalCgst = Math.round(totalCgst * 100) / 100;
  totalSgst = Math.round(totalSgst * 100) / 100;
  totalIgst = Math.round(totalIgst * 100) / 100;
  totalDiscount = Math.round(totalDiscount * 100) / 100;

  const totInvVal = Math.round((totalAssVal + totalCgst + totalSgst + totalIgst) * 100) / 100;

  // Calculate rounding offset (clamp to -99.99 to 99.99)
  const actualTotal = data.items.reduce((sum, item) => {
    const effectivePrice = Math.max(item.unitPrice - item.discountPerUnit, 0);
    return sum + effectivePrice * item.quantity;
  }, 0);
  let rndOffAmt = Math.round((actualTotal - totInvVal) * 100) / 100;
  rndOffAmt = Math.max(-99.99, Math.min(99.99, rndOffAmt));

  const payload: any = {
    Version: '1.1',
    TranDtls: {
      TaxSch: 'GST',
      SupTyp: isB2C ? 'B2C' : 'B2B',
      RegRev: 'Y',
      IgstOnIntra: 'N', // Only 'Y' for special intra-state IGST cases (SEZ etc.)
    },
    DocDtls: {
      Typ: data.docType,
      No: truncateDocNumber(data.docNumber),
      Dt: formatDate(data.docDate),
    },
    SellerDtls: {
      Gstin: data.seller.gstin,
      LglNm: sanitize(data.seller.legalName, 100, data.seller.tradeName),
      TrdNm: sanitize(data.seller.tradeName, 100, data.seller.legalName),
      Addr1: sanitize(data.seller.address, 100, 'Address'),
      Addr2: sanitizeAddr2(data.seller.address2),
      Loc: sanitize(data.seller.city, 100, 'City'),
      Pin: sanitizePin(data.seller.pincode),
      Stcd: sellerStateCode,
      Ph: sanitizePhone(data.seller.phone),
      Em: sanitizeEmail(data.seller.email),
    },
    BuyerDtls: {
      Gstin: isB2C ? 'URP' : data.buyer.gstin!,
      LglNm: sanitize(data.buyer.legalName, 100, 'Consumer'),
      TrdNm: sanitize(data.buyer.tradeName || data.buyer.legalName, 100, 'Consumer'),
      Pos: data.buyer.stateCode || sellerStateCode,
      Addr1: sanitize(data.buyer.address, 100, 'Address'),
      Addr2: sanitizeAddr2(data.buyer.address2),
      Loc: sanitize(data.buyer.city, 100, 'City'),
      Pin: sanitizePin(data.buyer.pincode),
      Stcd: data.buyer.stateCode || sellerStateCode,
      Ph: sanitizePhone(data.buyer.phone),
      Em: sanitizeEmail(data.buyer.email),
    },
    ItemList: itemList,
    ValDtls: {
      AssVal: totalAssVal,
      CgstVal: totalCgst,
      SgstVal: totalSgst,
      IgstVal: totalIgst,
      CesVal: 0,
      StCesVal: 0,
      Discount: totalDiscount,
      OthChrg: 0,
      RndOffAmt: rndOffAmt,
      TotInvVal: Math.round((totInvVal + rndOffAmt) * 100) / 100,
      TotInvValFc: 0,
    },
  };

  // Add reference details for Credit/Debit Notes
  if ((data.docType === 'CRN' || data.docType === 'DBN') && data.originalDocNumber) {
    payload.RefDtls = {
      InvRm: data.docType === 'CRN' ? 'Credit Note' : 'Debit Note',
      PrecDocDtls: [{
        InvNo: truncateDocNumber(data.originalDocNumber),
        InvDt: data.originalDocDate ? formatDate(data.originalDocDate) : formatDate(data.docDate),
        OthRefNo: sanitize(data.reason, 20, data.docType === 'CRN' ? 'Credit Note' : 'Debit Note'),
      }],
    };
  }

  // Inline EwbDtls block intentionally omitted. NIC's sandbox rejected
  // every variant we tried. EWB is generated via a separate call to
  // /ewaybillapi/v1.03/ewayapi/genewaybill after IRN — see
  // gstService.processInvoiceGst and gstPreflightService.runB2bPreflight.
  // CLAUDE.md anti-pattern #10: do not re-introduce this without a live
  // sandbox verification.

  return payload;
}

/**
 * Build EWB payload for e-Way Bill generation
 * Can be built from an existing IRN payload or standalone
 */
export function buildEwbPayload(
  irnPayload: any,
  transportDetails: {
    vehicleNumber: string;
    transportMode?: string; // 1=Road, 2=Rail, 3=Air, 4=Ship
    /** @deprecated WI-067: distance is now derived from the seller/buyer
     *  pincode pair via Haversine; this field is ignored. Kept on the
     *  signature for backward compatibility — callers can be cleaned up
     *  separately. */
    distance?: number;
    transporterName?: string;
    transporterId?: string;
  }
): any {
  const isB2C = irnPayload.TranDtls.SupTyp === 'B2C';
  const seller = irnPayload.SellerDtls;
  const buyer = irnPayload.BuyerDtls;
  const vals = irnPayload.ValDtls;
  const doc = irnPayload.DocDtls;

  // Sanitize vehicle number
  const vehicleNo = transportDetails.vehicleNumber
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .substring(0, 15);

  // WI-067: derive transDistance from the actual pincode pair instead
  // of the legacy `Math.max(1, distance || 1)` clamp. Sending '1' for
  // every dispatch tripped NIC error 702 on inter-state routes
  // (Bangalore 560001 → Hyderabad 500016 in the live failure).
  // getTransDistance handles three cases:
  //   same pincode               → '1' (NIC minimum)
  //   known pair                 → ceil(haversine_km) as a string
  //   missing or unknown pincode → '0' (NIC auto-calc fallback)
  // seller.Pin / buyer.Pin are numbers (sanitizePin); String() them.
  const transDistance = getTransDistance(
    seller.Pin != null ? String(seller.Pin) : null,
    buyer.Pin != null ? String(buyer.Pin) : null,
  );

  return {
    supplyType: 'O',        // Outward
    subSupplyType: '1',     // Supply
    docType: doc.Typ,
    docNo: doc.No,
    docDate: doc.Dt,

    fromGstin: seller.Gstin,
    fromPincode: seller.Pin,
    fromStateCode: parseInt(seller.Stcd),
    fromTrdName: seller.TrdNm || seller.LglNm,
    fromAddr1: seller.Addr1,
    fromAddr2: seller.Addr2,
    fromPlace: seller.Loc,

    // WI-071: for B2C / URP customers, NIC expects the literal 'URP'
    // sentinel here — NOT the seller's own GSTIN. The IRN payload
    // (line 228 — `BuyerDtls.Gstin: isB2C ? 'URP' : ...`) already
    // uses this convention; the EWB builder was inconsistent and
    // sent the seller's GSTIN, producing `toGstin === fromGstin`.
    // Under transactionType=1 ("Regular = single distinct recipient"),
    // NIC's sandbox intermittently rejects that with error 611
    // (live failure ORD-MPCDVUO1USY, 2026-05-19 08:41:40).
    toGstin: isB2C ? 'URP' : buyer.Gstin,
    toPincode: buyer.Pin,
    toStateCode: parseInt(buyer.Stcd),
    toTrdName: buyer.TrdNm || buyer.LglNm,
    toAddr1: buyer.Addr1,
    toAddr2: buyer.Addr2,
    toPlace: buyer.Loc,

    transMode: transportDetails.transportMode || '1', // Road
    transDistance,
    // transporterName / transporterId precedence:
    //   1. Caller-passed values (any caller that has explicit transporter info)
    //   2. For B2C: fall back to seller (depot acts as its own transporter) —
    //      WI-074 re-introduced from the production-proven legacy New_GasLink
    //      builder (line 690-691). Required for NIC to issue a Part-A-capable
    //      e-Way Bill when no third-party transporter is involved.
    //   3. For B2B: omit (current working behaviour preserved).
    ...(transportDetails.transporterName
      ? { transporterName: transportDetails.transporterName }
      : (isB2C ? { transporterName: seller.TrdNm || seller.LglNm } : {})),
    ...(transportDetails.transporterId
      ? { transporterId: transportDetails.transporterId }
      : (isB2C ? { transporterId: seller.Gstin } : {})),

    transDocNo: vehicleNo,
    transDocDate: doc.Dt,
    vehicleNo: vehicleNo,
    vehicleType: 'R', // Regular

    itemList: irnPayload.ItemList.map((item: any) => ({
      hsnCode: item.HsnCd,
      taxableAmount: item.AssAmt,
      productName: item.PrdDesc,
      productDesc: `Supply of ${item.PrdDesc}`,
      quantity: item.Qty,
      qtyUnit: item.Unit,
      cgstRate: item.CgstAmt > 0 ? CGST_RATE : 0,
      sgstRate: item.SgstAmt > 0 ? SGST_RATE : 0,
      igstRate: item.IgstAmt > 0 ? GST_RATE : 0,
      cessRate: 0,
    })),

    actFromStateCode: parseInt(seller.Stcd),
    actToStateCode: parseInt(buyer.Stcd),
    // WI-074 — transactionType semantics (NIC EWB spec):
    //   1 = Regular: Bill-To party and Ship-To party are the SAME
    //                registered legal entity (same GSTIN).
    //   2 = Bill-To different from Ship-To (different registered
    //                entities).
    //   3 = Bill-From different from Dispatch-From.
    //   4 = Both 2 and 3.
    //
    // WI-057 forced this to always 1 on the misreading that "single
    // recipient" = type 1. The correct criterion is "are Bill-To and
    // Ship-To the same registered entity?" A URP customer (no GSTIN)
    // can never be a registered Ship-To — so a B2C dispatch with
    // toGstin='URP' is structurally NOT type 1. NIC's catch-all 240
    // on B2C dispatches with type=1 + URP toGstin (live 2026-05-19
    // ORD-MPCFG9LCQ3W, codes 240 and 240_3) was the symptom.
    //
    // For B2C: URP customer is the Bill-To party, depot/distributor
    // is the Ship-To party (registered entity receiving the goods on
    // behalf of the delivery chain). Two distinct entities → type=2.
    // Bill-From and Dispatch-From remain the same depot → we do NOT
    // claim type=3 or 4, so dispatchFromGSTIN/dispatchFromTradeName
    // are correctly OMITTED.
    //
    // For B2B (real customer GSTIN): Bill-To == Ship-To == customer
    // GSTIN, one registered entity → type=1 (matches NIC's lenient
    // acceptance of the redundant ship-to/dispatch-from fields when
    // they match). Currently working in production — preserved.
    //
    // The legacy New_GasLink/.../gstEwayPayloadBuilder.js used the
    // same type-2 mapping for B2C (line 664) and was production
    // validated. WI-074 brings our payload back in line with that
    // mapping after the WI-057/071/072/073 detour.
    transactionType: isB2C ? 2 : 1,
    subSupplyDesc: sanitize(doc.Typ === 'INV' ? 'Supply of LPG' : 'Return of LPG', 20, 'Supply'),

    // Ship-To / Dispatch-From field handling:
    //   B2C (type=2): MUST send shipToGSTIN/shipToTradeName. Use the
    //                 depot's own GSTIN — the depot is the registered
    //                 entity receiving the goods (URP customer has no
    //                 GSTIN). dispatchFromGSTIN omitted (Bill-From ==
    //                 Dispatch-From, no type-3 claim).
    //   B2B (type=1): OMIT all four fields. Under transactionType=1
    //                 ("Bill-To == Ship-To, same registered entity"),
    //                 these fields are redundant — toGstin already
    //                 IS shipToGSTIN, fromGstin already IS
    //                 dispatchFromGSTIN. WI-076 (2026-05-19): NIC's
    //                 sandbox validator now rejects payloads carrying
    //                 these redundant fields with error 616. Live A/B
    //                 confirmed on fresh docNo INV-MPCJV99K: same
    //                 payload minus the four fields → success
    //                 (ewayBillNo 101012061787). WI-073 made the same
    //                 omission for B2C; this extends it to B2B.
    ...(isB2C
      ? {
          shipToGSTIN: seller.Gstin,
          shipToTradeName: seller.TrdNm || seller.LglNm,
        }
      : {}),

    // NIC EWB validator rule: totInvValue must be >= totalValue + cgstValue +
    // sgstValue + igstValue + cessValue. Violating it returns error 620:
    // "Total invoice value cannot be less than the sum of total assessable
    // value and tax values." This bug was masquerading as 'EWB already
    // exists' — it isn't; the legacy New_GasLink/.../gstEwayPayloadBuilder.js
    // had the right mapping. totalValue uses AssVal (taxable subtotal);
    // totInvValue uses TotInvVal (taxable + all taxes + round-off).
    totalValue: vals.AssVal,
    totInvValue: vals.TotInvVal,
    cgstValue: vals.CgstVal,
    sgstValue: vals.SgstVal,
    igstValue: vals.IgstVal,
    cessValue: vals.CesVal + vals.StCesVal,
    cessNonAdvolValue: 0,
  };
}
