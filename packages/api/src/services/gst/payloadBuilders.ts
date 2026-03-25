/**
 * Payload builders for WhiteBooks IRN and EWB generation.
 * Follows NIC v1.03 specification.
 *
 * Key: All prices in our DB are GST-inclusive. We reverse-calculate
 * base price for the payload (WhiteBooks expects GST-exclusive amounts).
 */

import { format } from 'date-fns';

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
    distance?: number;      // km
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

  // EWB API requires distance >= 1 (0 causes error 721)
  // Use 1 as minimum — EWB system rounds up based on PIN codes
  const distance = Math.max(1, Math.min(4000, transportDetails.distance || 1));

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

    toGstin: isB2C ? seller.Gstin : buyer.Gstin, // B2C: use seller GSTIN
    toPincode: buyer.Pin,
    toStateCode: parseInt(buyer.Stcd),
    toTrdName: buyer.TrdNm || buyer.LglNm,
    toAddr1: buyer.Addr1,
    toAddr2: buyer.Addr2,
    toPlace: buyer.Loc,

    transMode: transportDetails.transportMode || '1', // Road
    transDistance: String(distance),
    // Only include transporterName/Id if provided (empty string causes validation error)
    ...(transportDetails.transporterName ? { transporterName: transportDetails.transporterName } : {}),
    ...(transportDetails.transporterId ? { transporterId: transportDetails.transporterId } : {}),

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
    transactionType: isB2C ? 2 : 1,
    subSupplyDesc: sanitize(doc.Typ === 'INV' ? 'Supply of LPG' : 'Return of LPG', 20, 'Supply'),

    dispatchFromGSTIN: seller.Gstin,
    dispatchFromTradeName: seller.TrdNm || seller.LglNm,
    shipToGSTIN: isB2C ? seller.Gstin : buyer.Gstin,
    shipToTradeName: buyer.TrdNm || buyer.LglNm,

    totInvValue: vals.AssVal,
    totalValue: vals.AssVal,
    cgstValue: vals.CgstVal,
    sgstValue: vals.SgstVal,
    igstValue: vals.IgstVal,
    cessValue: vals.CesVal + vals.StCesVal,
    cessNonAdvolValue: 0,
  };
}
