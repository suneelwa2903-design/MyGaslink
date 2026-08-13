/**
 * One-shot B2B-only GST export.
 *
 * Filters to invoices where the customer is B2B AND the parent order is
 * `delivered` / `modified_delivered`. GSTR-1 Table 4A shape.
 *
 * Usage:
 *   pnpm --filter @gaslink/api exec tsx scripts/gst-b2b-export-oneshot.ts \
 *     --doc-code KRU --month 2026-07 --out ./kruthee-b2b-jul.xlsx
 */
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { prisma } from '../src/lib/prisma.js';

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx === -1 ? undefined : process.argv[idx + 1];
}

function d(v: Date | null | undefined): string {
  if (!v) return '';
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const day = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as { toNumber: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}
const r2 = (v: number) => Math.round(v * 100) / 100;

function styleHeader(ws: ExcelJS.Worksheet, cols: number) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBEAFE' } };
  for (let c = 1; c <= cols; c++) {
    row.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FF60A5FA' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

async function main() {
  const docCode = arg('doc-code');
  const month = arg('month');
  const out = arg('out');
  if (!docCode || !month || !out) {
    console.error('Usage: --doc-code XXX --month YYYY-MM --out <path>');
    process.exit(1);
  }
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month '${month}'`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const from = new Date(Date.UTC(year, mon - 1, 1));
  const toExclusive = new Date(Date.UTC(year, mon, 1));

  const distributor = await prisma.distributor.findFirst({
    where: { docCode: docCode.toUpperCase() },
    select: { id: true, businessName: true, docCode: true, gstin: true, state: true },
  });
  if (!distributor) throw new Error(`No distributor with docCode='${docCode}'`);
  console.log(`Distributor: ${distributor.businessName} (${distributor.id})`);

  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId: distributor.id,
      issueDate: { gte: from, lt: toExclusive },
      status: { not: 'cancelled' },
      cancelledAt: null,
      deletedAt: null,
      isOpeningBalance: false,
      order: { status: { in: ['delivered', 'modified_delivered'] }, cancelledAt: null, deletedAt: null },
      customer: { customerType: 'B2B' },
    },
    include: {
      customer: {
        select: {
          customerName: true, businessName: true, gstin: true, phone: true,
          billingAddressLine1: true, billingAddressLine2: true, billingCity: true, billingState: true, billingPincode: true,
        },
      },
      order: {
        select: { orderNumber: true, deliveryDate: true,
          driver: { select: { driverName: true } }, driverNameFreeText: true,
          vehicle: { select: { vehicleNumber: true } },
        },
      },
      items: { include: { cylinderType: { select: { typeName: true, hsnCode: true } } } },
    },
    orderBy: { invoiceNumber: 'asc' },
  });
  console.log(`Found ${invoices.length} B2B delivered invoices for ${month}`);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyGasLink';
  wb.created = new Date();

  // ── Sheet 1: B2B_Summary (per cylinder-type roll-up) ──
  const summary = wb.addWorksheet('B2B_Summary');
  summary.columns = [
    { header: 'Cylinder Type', key: 'type', width: 22 },
    { header: 'HSN', key: 'hsn', width: 12 },
    { header: 'UOM', key: 'uom', width: 8 },
    { header: 'Invoices', key: 'inv', width: 10 },
    { header: 'Qty', key: 'qty', width: 10 },
    { header: 'Taxable Value', key: 'taxable', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'CGST ₹', key: 'cgst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total Invoice Value', key: 'total', width: 18, style: { numFmt: '#,##0.00' } },
  ];
  const perType = new Map<string, { typeName: string; hsn: string; uom: string; invSet: Set<string>; qty: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }>();
  for (const inv of invoices) {
    const invIsInter = n(inv.igstValue) > 0;
    for (const it of inv.items) {
      const typeName = it.cylinderType?.typeName ?? it.description ?? 'Unknown';
      const hsn = it.hsnCode ?? it.cylinderType?.hsnCode ?? '27111900';
      const key = `${typeName}::${hsn}`;
      const line = n(it.taxableValue) || n(it.totalPrice) / (1 + n(it.gstRate) / 100);
      const gstAmt = n(it.totalPrice) - line;
      const bucket = perType.get(key) ?? { typeName, hsn, uom: it.uom, invSet: new Set(), qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
      bucket.invSet.add(inv.id);
      bucket.qty += it.quantity;
      bucket.taxable += line;
      if (invIsInter) bucket.igst += gstAmt;
      else { bucket.cgst += gstAmt / 2; bucket.sgst += gstAmt / 2; }
      bucket.total += n(it.totalPrice);
      perType.set(key, bucket);
    }
  }
  for (const b of perType.values()) {
    summary.addRow({
      type: b.typeName, hsn: b.hsn, uom: b.uom,
      inv: b.invSet.size, qty: b.qty,
      taxable: r2(b.taxable), cgst: r2(b.cgst), sgst: r2(b.sgst), igst: r2(b.igst), total: r2(b.total),
    });
  }
  if (perType.size > 0) {
    const tot = summary.addRow({
      type: 'GRAND TOTAL', hsn: '', uom: '',
      inv: invoices.length,
      qty: [...perType.values()].reduce((a, b) => a + b.qty, 0),
      taxable: r2([...perType.values()].reduce((a, b) => a + b.taxable, 0)),
      cgst: r2([...perType.values()].reduce((a, b) => a + b.cgst, 0)),
      sgst: r2([...perType.values()].reduce((a, b) => a + b.sgst, 0)),
      igst: r2([...perType.values()].reduce((a, b) => a + b.igst, 0)),
      total: r2([...perType.values()].reduce((a, b) => a + b.total, 0)),
    });
    tot.font = { bold: true };
    tot.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FF6B7280' } } }; });
  }
  styleHeader(summary, summary.columns.length);

  // ── Sheet 2: B2B_Invoices (GSTR-1 Table 4A format — one row per invoice) ──
  const invSheet = wb.addWorksheet('B2B_Invoices');
  invSheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Invoice No', key: 'no', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Delivery Date', key: 'ddate', width: 12 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 30 },
    { header: 'Recipient GSTIN', key: 'gstin', width: 18 },
    { header: 'Place of Supply', key: 'pos', width: 16 },
    { header: 'Order No', key: 'order', width: 16 },
    { header: 'Vehicle No', key: 'veh', width: 12 },
    { header: 'Driver', key: 'driver', width: 20 },
    { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Total (incl GST)', key: 'total', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'IRN Status', key: 'irn_status', width: 14 },
    { header: 'IRN', key: 'irn', width: 68 },
    { header: 'EWB Status', key: 'ewb_status', width: 12 },
    { header: 'EWB Number', key: 'ewb', width: 14 },
    { header: 'Payment Status', key: 'pstatus', width: 14 },
    { header: 'Amount Paid', key: 'paid', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Outstanding', key: 'out', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'PO Number', key: 'po', width: 14 },
  ];
  invoices.forEach((inv, idx) => {
    const veh = inv.order?.vehicle?.vehicleNumber ?? '';
    const drv = inv.order?.driver?.driverName ?? inv.order?.driverNameFreeText ?? '';
    invSheet.addRow({
      sl: idx + 1,
      no: inv.invoiceNumber,
      date: d(inv.issueDate),
      ddate: d(inv.order?.deliveryDate ?? null),
      cust: inv.customer?.customerName ?? '',
      biz: inv.customer?.businessName ?? '',
      gstin: inv.customerGstinSnapshot ?? inv.customer?.gstin ?? '',
      pos: inv.placeOfSupplyCode ?? inv.customer?.billingState ?? '',
      order: inv.order?.orderNumber ?? '',
      veh, driver: drv,
      taxable: r2(n(inv.taxableValue)),
      cgst: r2(n(inv.cgstValue)),
      sgst: r2(n(inv.sgstValue)),
      igst: r2(n(inv.igstValue)),
      total: r2(n(inv.totalAmount)),
      irn_status: inv.irnStatus,
      irn: inv.irn ?? '',
      ewb_status: inv.ewbStatus,
      ewb: '', // ewb_number lives in gst_documents; too fiddly to join here
      pstatus: inv.status,
      paid: r2(n(inv.amountPaid)),
      out: r2(n(inv.outstandingAmount)),
      po: inv.poNumber ?? '',
    });
  });
  styleHeader(invSheet, invSheet.columns.length);

  // ── Sheet 3: B2B_By_GSTIN (customer roll-up) ──
  const gstinSheet = wb.addWorksheet('B2B_By_GSTIN');
  gstinSheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Recipient GSTIN', key: 'gstin', width: 18 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 30 },
    { header: 'Invoices', key: 'inv', width: 10 },
    { header: 'Cylinder Qty', key: 'qty', width: 12 },
    { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Total (incl GST)', key: 'total', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'IRN Success', key: 'irn_ok', width: 12 },
    { header: 'IRN Missing', key: 'irn_miss', width: 12 },
  ];
  const byGstin = new Map<string, { gstin: string; cust: string; biz: string; invSet: Set<string>; qty: number; taxable: number; cgst: number; sgst: number; igst: number; total: number; irnOk: number; irnMiss: number }>();
  for (const inv of invoices) {
    const gstin = inv.customerGstinSnapshot ?? inv.customer?.gstin ?? '(no GSTIN)';
    const bucket = byGstin.get(gstin) ?? {
      gstin, cust: inv.customer?.customerName ?? '', biz: inv.customer?.businessName ?? '',
      invSet: new Set(), qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0, irnOk: 0, irnMiss: 0,
    };
    bucket.invSet.add(inv.id);
    for (const it of inv.items) bucket.qty += it.quantity;
    bucket.taxable += n(inv.taxableValue);
    bucket.cgst += n(inv.cgstValue);
    bucket.sgst += n(inv.sgstValue);
    bucket.igst += n(inv.igstValue);
    bucket.total += n(inv.totalAmount);
    if (inv.irnStatus === 'success') bucket.irnOk += 1; else bucket.irnMiss += 1;
    byGstin.set(gstin, bucket);
  }
  [...byGstin.values()]
    .sort((a, b) => b.total - a.total)
    .forEach((b, idx) => {
      gstinSheet.addRow({
        sl: idx + 1, gstin: b.gstin, cust: b.cust, biz: b.biz,
        inv: b.invSet.size, qty: b.qty,
        taxable: r2(b.taxable), cgst: r2(b.cgst), sgst: r2(b.sgst), igst: r2(b.igst), total: r2(b.total),
        irn_ok: b.irnOk, irn_miss: b.irnMiss,
      });
    });
  styleHeader(gstinSheet, gstinSheet.columns.length);

  // ── Sheet 4: B2B_InvoiceLines (audit trail for CA to verify) ──
  const lines = wb.addWorksheet('B2B_InvoiceLines');
  lines.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Invoice No', key: 'no', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'Cylinder Type', key: 'type', width: 16 },
    { header: 'HSN', key: 'hsn', width: 12 },
    { header: 'UOM', key: 'uom', width: 8 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Rate (incl GST)', key: 'rate', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Discount/unit', key: 'disc', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Line Total', key: 'lineTot', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'GST %', key: 'rate%', width: 7 },
    { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
  ];
  let sl = 0;
  for (const inv of invoices) {
    const invIsInter = n(inv.igstValue) > 0;
    for (const it of inv.items) {
      sl += 1;
      const rate = n(it.gstRate);
      const lineTot = n(it.totalPrice);
      const taxable = n(it.taxableValue) || lineTot / (1 + rate / 100);
      const gstAmt = lineTot - taxable;
      lines.addRow({
        sl,
        no: inv.invoiceNumber,
        date: d(inv.issueDate),
        cust: inv.customer?.customerName ?? '',
        gstin: inv.customerGstinSnapshot ?? inv.customer?.gstin ?? '',
        type: it.cylinderType?.typeName ?? it.description ?? '',
        hsn: it.hsnCode ?? it.cylinderType?.hsnCode ?? '27111900',
        uom: it.uom,
        qty: it.quantity,
        rate: r2(n(it.unitPrice)),
        disc: r2(n(it.discountPerUnit)),
        lineTot: r2(lineTot),
        taxable: r2(taxable),
        'rate%': rate,
        cgst: invIsInter ? 0 : r2(gstAmt / 2),
        sgst: invIsInter ? 0 : r2(gstAmt / 2),
        igst: invIsInter ? r2(gstAmt) : 0,
      });
    }
  }
  styleHeader(lines, lines.columns.length);

  const buf = Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer);
  writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length} bytes)`);
  await prisma.$disconnect();
}

main().catch(async (e) => { console.error('FAILED:', e); await prisma.$disconnect(); process.exit(1); });
