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

/** A single line item in the NIC IRN payload (`ItemList[]`). */
export interface IrnPayloadItem {
  SlNo: string;
  IsServc: string;
  PrdDesc: string;
  HsnCd: string;
  Qty: number;
  Unit: string;
  UnitPrice: number;
  TotAmt: number;
  Discount: number;
  AssAmt: number;
  GstRt: number;
  IgstAmt: number;
  CgstAmt: number;
  SgstAmt: number;
  CesRt: number;
  CesAmt: number;
  CesNonAdvlAmt: number;
  StateCesRt: number;
  StateCesAmt: number;
  StateCesNonAdvlAmt: number;
  OthChrg: number;
  TotItemVal: number;
}

/** The NIC IRN GENERATE request payload (v1.1) produced by buildIrnPayload. */
export interface IrnPayload {
  Version: string;
  TranDtls: { TaxSch: string; SupTyp: string; RegRev: string; IgstOnIntra: string };
  DocDtls: { Typ: string; No: string; Dt: string };
  SellerDtls: {
    Gstin: string; LglNm: string; TrdNm: string; Addr1: string; Addr2: string;
    Loc: string; Pin: number; Stcd: string; Ph: string; Em: string;
  };
  BuyerDtls: {
    Gstin: string; LglNm: string; TrdNm: string; Pos: string; Addr1: string;
    Addr2: string; Loc: string; Pin: number; Stcd: string; Ph: string; Em: string;
  };
  ItemList: IrnPayloadItem[];
  ValDtls: {
    AssVal: number; CgstVal: number; SgstVal: number; IgstVal: number;
    CesVal: number; StCesVal: number; Discount: number; OthChrg: number;
    RndOffAmt: number; TotInvVal: number; TotInvValFc: number;
  };
  RefDtls?: {
    InvRm: string;
    PrecDocDtls: Array<{ InvNo: string; InvDt: string; OthRefNo: string }>;
  };
  // Inline EwbDtls is intentionally never emitted (anti-pattern #10 — the
  // two-step IRN→EWB pattern is used instead). Declared optional only so the
  // payload-shape guard test can assert it is absent.
  EwbDtls?: never;
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
  // WI-108: NIC caps DocDtls.No at 16 chars. Previously this silently
  // truncated, which could collapse two distinct DB numbers onto the same
  // NIC document (re-tripping the 2278 duplicate trap). Fail loud instead —
  // both the structured 14-char format and the legacy random/revision
  // numbers stay ≤16, so a >16 value is a configuration bug, not data.
  if (docNo.length > 16) {
    throw new Error(
      `Doc number '${docNo}' exceeds the NIC 16-char limit. This is a configuration error.`,
    );
  }
  return docNo;
}

/**
 * Build IRN payload for e-Invoice generation
 */
export function buildIrnPayload(data: InvoiceData): IrnPayload {
  const isB2C = !data.buyer.gstin || data.buyer.gstin === 'URP';
  const sellerStateCode = extractStateCode(data.seller.gstin);

  // Build item list with GST-exclusive calculations
  let totalAssVal = 0;
  let totalCgst = 0;
  let totalSgst = 0;
  let totalIgst = 0;

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

    return {
      SlNo: String(item.slNo),
      // SAC service codes (99xxxx, e.g. 996511 transport) must be flagged as a
      // service — NIC rejects them as goods with error 3047 otherwise.
      IsServc: item.hsnCode?.startsWith('99') ? 'Y' : 'N',
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

  const totInvVal = Math.round((totalAssVal + totalCgst + totalSgst + totalIgst) * 100) / 100;

  // Calculate rounding offset (clamp to -99.99 to 99.99)
  const actualTotal = data.items.reduce((sum, item) => {
    const effectivePrice = Math.max(item.unitPrice - item.discountPerUnit, 0);
    return sum + effectivePrice * item.quantity;
  }, 0);
  let rndOffAmt = Math.round((actualTotal - totInvVal) * 100) / 100;
  rndOffAmt = Math.max(-99.99, Math.min(99.99, rndOffAmt));

  const payload: IrnPayload = {
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
      // WI-XXX: ValDtls.Discount is invoice-level (additional) discount, NOT
      // the sum of per-item discounts. NIC validates:
      //   TotInvVal = AssVal + ΣTaxes + OthChrg − ValDtls.Discount + RndOffAmt
      // Per-line discounts are already reflected in each item's AssAmt (and
      // therefore in AssVal). Putting ΣitemDiscount into ValDtls.Discount
      // makes NIC subtract those discounts a SECOND time, producing error
      // 2189 ("Total Invoice Value is not matching with calculated value")
      // on every invoice that has any non-zero per-item discount. Proven
      // live on 2026-05-28 with invoice ISHD2627001690 (Maruthi Agencies,
      // dist-002): payload TotInvVal=37754.20, NIC's expected=32076.23,
      // diff=5677.97 == exactly ΣitemDiscount.
      Discount: 0,
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

/** A single line item in the NIC EWB payload (`itemList[]`). */
export interface EwbPayloadItem {
  hsnCode: string;
  taxableAmount: number;
  productName: string;
  productDesc: string;
  quantity: number;
  qtyUnit: string;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cessRate: number;
}

/** The NIC genewaybill request payload produced by buildEwbPayload. */
export interface EwbPayload {
  supplyType: string;
  subSupplyType: string;
  docType: string;
  docNo: string;
  docDate: string;
  fromGstin: string;
  fromPincode: number;
  fromStateCode: number;
  fromTrdName: string;
  fromAddr1: string;
  fromAddr2: string;
  fromPlace: string;
  toGstin: string;
  toPincode: number;
  toStateCode: number;
  toTrdName: string;
  toAddr1: string;
  toAddr2: string;
  toPlace: string;
  transMode: string;
  transDistance: string;
  transporterName?: string;
  transporterId?: string;
  transDocNo: string;
  transDocDate: string;
  vehicleNo: string;
  vehicleType: string;
  itemList: EwbPayloadItem[];
  actFromStateCode: number;
  actToStateCode: number;
  transactionType: number;
  subSupplyDesc: string;
  totalValue: number;
  totInvValue: number;
  cgstValue: number;
  sgstValue: number;
  igstValue: number;
  cessValue: number;
  cessNonAdvolValue: number;
  // Ship-To / Dispatch-From are valid only on transactionType 2/3/4 and are
  // intentionally never emitted under type 1 (anti-pattern #14). Declared
  // optional so guard tests can assert their absence on B2B/B2C output.
  shipToGSTIN?: string;
  shipToTradeName?: string;
  dispatchFromGSTIN?: string;
  dispatchFromTradeName?: string;
}

/**
 * Build EWB payload for e-Way Bill generation
 * Can be built from an existing IRN payload or standalone
 */
export function buildEwbPayload(
  irnPayload: IrnPayload,
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
): EwbPayload {
  const isB2C = irnPayload.TranDtls.SupTyp === 'B2C';
  const seller = irnPayload.SellerDtls;
  const buyer = irnPayload.BuyerDtls;
  const vals = irnPayload.ValDtls;
  const doc = irnPayload.DocDtls;

  // Sanitize vehicle number to NIC's expected shape: uppercase, alphanumeric
  // only, max 15 chars. Hyphens / spaces in the human-friendly form
  // ("KA01-AB-1234") get stripped here.
  const vehicleNo = transportDetails.vehicleNumber
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase()
    .substring(0, 15);

  // Pre-validate against the Indian RTO plate shape BEFORE NIC sees it. NIC
  // otherwise responds with the cryptic error 225 (encountered live on
  // 2026-05-29 with the demo vehicle 'DEMO-MN-0001' → 'DEMOMN0001' — "DEMO" is
  // not a valid state code). The regex covers the standard format:
  //   [state code: 2 letters][RTO district: 1-2 digits][series: 1-3 letters][number: 4 digits]
  // e.g. KA01AB1234, MH12ABC1234, TS09AB1234. BH-series ("BH01A1234") and
  // diplomatic/CD plates are not covered — they're unusual on commercial fleets
  // and worth surfacing as a manual override if they ever come up.
  const VALID_PLATE = /^[A-Z]{2}\d{1,2}[A-Z]{1,3}\d{4}$/;
  if (!VALID_PLATE.test(vehicleNo)) {
    throw new Error(
      `Invalid vehicle registration number "${transportDetails.vehicleNumber}". ` +
        'Expected Indian RTO format e.g. KA01-AB-1234. Update in ' +
        'Fleet → Vehicles and retry.',
    );
  }

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
    // Use the legal name (LglNm) on the EWB so the supplier name on the
    // printed bill matches the GST-registered legal entity (e.g.
    // "Vanasthali Gas Service") rather than the shorter trade / business
    // display name (e.g. "Vanasthali Gas"). LglNm is sanitized non-empty
    // upstream; the `|| TrdNm` fallback covers any future shape change.
    fromTrdName: seller.LglNm || seller.TrdNm,
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

    // transDocNo is intended for the transporter's document (LR / bilty /
    // consignment note). Own-vehicle deliveries have no separate transport
    // document, so leave this empty — matches the CEWB path's behaviour at
    // gstPreflightService.ts:676. Previously this field was set to vehicleNo
    // which duplicated the truck number on the printed EWB. transDocDate
    // stays populated (NIC's schema couples them but tolerates a blank
    // transDocNo + a date for the road mode).
    transDocNo: '',
    transDocDate: doc.Dt,
    vehicleNo: vehicleNo,
    vehicleType: 'R', // Regular

    itemList: irnPayload.ItemList.map((item) => ({
      hsnCode: item.HsnCd,
      taxableAmount: item.AssAmt,
      productName: item.PrdDesc,
      // Include the commodity ("LPG") explicitly in the description so the
      // EWB line reads e.g. "Supply of LPG - 19 KG" instead of "Supply of
      // 19 KG", which omits the actual goods type. productName keeps the
      // short cylinder type_name for legacy consumers.
      productDesc: `Supply of LPG - ${item.PrdDesc}`,
      quantity: item.Qty,
      qtyUnit: item.Unit,
      cgstRate: item.CgstAmt > 0 ? CGST_RATE : 0,
      sgstRate: item.SgstAmt > 0 ? SGST_RATE : 0,
      igstRate: item.IgstAmt > 0 ? GST_RATE : 0,
      cessRate: 0,
    })),

    actFromStateCode: parseInt(seller.Stcd),
    actToStateCode: parseInt(buyer.Stcd),
    // WI-077 (2026-05-23) — transactionType is 1 (Regular) for BOTH B2C and
    // B2B. NIC EWB spec: type 1 = Bill-To and Ship-To are the same party AND
    // Bill-From == Dispatch-From; 2/3/4 are for genuinely DIFFERENT ship-to /
    // dispatch-from parties. In our flow the customer (registered OR URP) is
    // simultaneously Bill-To and Ship-To, and the depot is both Bill-From and
    // Dispatch-From — no distinct parties → Regular (1).
    //
    // NIC-sandbox flip-flop history on the B2C/URP path (do NOT re-toggle
    // without a fresh live A/B):
    //   - 2026-05-19: type=1 + URP started returning 240 → WI-074 switched
    //     B2C to type=2 + shipToGSTIN=seller; worked 05-19 → 05-22.
    //   - 2026-05-23: type=2 now returns 863, type=1 succeeds. Proven by a
    //     live sandbox A/B matrix on dist-002:
    //       S1 type=1, no shipTo            → ewayBillNo 181012065220 ✅
    //       S2 type=2, shipToGSTIN=seller   → 863 ✗  (was our code)
    //       S3 type=2, shipToGSTIN=URP      → JSON-schema reject (needs 15-char GSTIN)
    //       S4 type=1, WITH shipTo=seller   → 616 ✗  (redundant ship-to)
    //       S6 registered buyer, type=1     → ewayBillNo 151012065221 ✅
    //   Corroborated by: our already-working B2B path (type=1), a real
    //   production IndianOil e-Way Bill (Bhargavi Gas — "Transaction Type:
    //   Regular"), and NIC's own genewaybill sample (URP ship-to carries
    //   shipToTradeName WITHOUT shipToGSTIN; never the literal 'URP' or the
    //   seller's GSTIN).
    transactionType: 1,
    subSupplyDesc: sanitize(doc.Typ === 'INV' ? 'Supply of LPG' : 'Return of LPG', 20, 'Supply'),

    // Ship-To / Dispatch-From: OMITTED for both B2C and B2B. Under
    // transactionType=1 they are redundant (toGstin already IS shipTo,
    // fromGstin already IS dispatchFrom) and NIC rejects the redundant fields
    // with 616 (proven live: S4 above). Re-introduce ONLY with type 2/3/4 for
    // a genuine different-site ship-to — and for a URP ship-to send
    // shipToTradeName WITHOUT shipToGSTIN (per the NIC sample).

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
