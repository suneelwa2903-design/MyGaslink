/**
 * GST Filing Export — multi-sheet .xlsx workbook for a distributor's monthly
 * GST return preparation.
 *
 * One export = 6 sheets:
 *   1. GST_Summary       — HSN-wise roll-up (feeds GSTR-1 Table 12 + 3B)
 *   2. Invoices          — one row per (non-cancelled) invoice in the month
 *   3. InvoiceLines      — one row per invoice-item; multi-cylinder-type
 *                          invoices span multiple rows sharing invoice #/date
 *   4. Customers         — customer master for customers with activity
 *   5. Payments          — receipts in the month
 *   6. CylinderBalances  — long format: (customer × cylinder-type)
 *
 * Exclusions applied to every sheet:
 *   - invoices:              status <> 'cancelled' AND cancelled_at IS NULL
 *                            AND deleted_at IS NULL AND is_opening_balance = false
 *   - orders (when joined):  status <> 'cancelled' AND deleted_at IS NULL
 *   - payments:              deleted_at IS NULL
 *   - customers:             only those with at least one non-cancelled invoice
 *                            OR one payment in the month
 *
 * Tenant-scoped by distributorId (anti-pattern #1 / #13). Never accepts
 * distributorId from user input — always from req.user.
 */
import ExcelJS from 'exceljs';
import { prisma } from '../lib/prisma.js';

export interface GstFilingExportInput {
  distributorId: string;
  /** 'YYYY-MM' — the calendar month to include (based on invoice issue_date / payment transaction_date). */
  month: string;
}

export interface GstFilingExportResult {
  buffer: Buffer;
  filename: string;
}

/**
 * Parse 'YYYY-MM' into a [dateFrom, dateToExclusive) window as UTC midnight
 * timestamps. UTC (not local TZ) is critical: Prisma truncates @db.Date filter
 * values by their UTC calendar date — a local-TZ midnight from a UTC+5:30
 * server truncates to the previous day, silently dropping every row whose
 * issue_date equals the month's last day. Anti-pattern #21 companion, DB side.
 */
function monthWindow(month: string): { from: Date; toExclusive: Date; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month '${month}' — expected YYYY-MM`);
  const year = Number(m[1]);
  const mon = Number(m[2]);
  if (mon < 1 || mon > 12) throw new Error(`Invalid month '${month}' — month must be 01–12`);
  const from = new Date(Date.UTC(year, mon - 1, 1));
  const toExclusive = new Date(Date.UTC(year, mon, 1));
  const label = `${m[1]}-${m[2]}`;
  return { from, toExclusive, label };
}

/** Format a Date (or nullable) as YYYY-MM-DD in local time. */
function d(v: Date | null | undefined): string {
  if (!v) return '';
  const y = v.getFullYear();
  const m = String(v.getMonth() + 1).padStart(2, '0');
  const day = String(v.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Coerce Prisma Decimal | number | null to a plain number. */
function n(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return Number(v);
  if (typeof v === 'object' && v !== null && 'toNumber' in v && typeof (v as { toNumber: () => number }).toNumber === 'function') {
    return (v as { toNumber: () => number }).toNumber();
  }
  return Number(v);
}

/** Round to 2 dp. */
function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Style helper — light-grey bold header row across N columns. */
function styleHeader(ws: ExcelJS.Worksheet, columnCount: number) {
  const row = ws.getRow(1);
  row.font = { bold: true };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };
  for (let c = 1; c <= columnCount; c++) {
    row.getCell(c).border = { bottom: { style: 'thin', color: { argb: 'FF9CA3AF' } } };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
}

export async function buildGstFilingExport(
  input: GstFilingExportInput,
): Promise<GstFilingExportResult> {
  const { distributorId, month } = input;
  if (!distributorId) throw new Error('distributorId is required');
  const { from, toExclusive, label } = monthWindow(month);

  const distributor = await prisma.distributor.findFirst({
    where: { id: distributorId },
    select: { businessName: true, docCode: true, gstin: true, state: true },
  });
  if (!distributor) throw new Error(`Distributor ${distributorId} not found`);

  // ── Invoices (non-cancelled, non-OB, in-month). Joined to Customer + Order + Items(CylinderType).
  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      issueDate: { gte: from, lt: toExclusive },
      status: { not: 'cancelled' },
      cancelledAt: null,
      deletedAt: null,
      isOpeningBalance: false,
    },
    include: {
      customer: {
        select: {
          id: true,
          customerName: true,
          businessName: true,
          customerType: true,
          gstin: true,
          phone: true,
          billingAddressLine1: true,
          billingAddressLine2: true,
          billingCity: true,
          billingState: true,
          billingPincode: true,
        },
      },
      order: {
        select: {
          orderNumber: true,
          deliveryDate: true,
          driverNameFreeText: true,
          status: true,
          cancelledAt: true,
          deletedAt: true,
          driver: { select: { driverName: true } },
          vehicle: { select: { vehicleNumber: true } },
        },
      },
      items: {
        include: {
          cylinderType: { select: { id: true, typeName: true, capacity: true, hsnCode: true } },
        },
      },
    },
    orderBy: { invoiceNumber: 'asc' },
  });

  // Defensive: if the parent Order was cancelled after the invoice was created,
  // skip the invoice. (Cancel flow normally cancels both, but this belt+braces
  // matches the user's ask "ensure to rightly check cancellations".)
  const activeInvoices = invoices.filter(
    (i) => !i.order || (i.order.status !== 'cancelled' && i.order.cancelledAt === null && i.order.deletedAt === null),
  );

  // ── Payments (non-deleted, in-month).
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      distributorId,
      transactionDate: { gte: from, lt: toExclusive },
      deletedAt: null,
    },
    include: {
      customer: { select: { id: true, customerName: true, businessName: true, gstin: true } },
      allocations: { select: { invoice: { select: { invoiceNumber: true } }, allocatedAmount: true } },
    },
    orderBy: { transactionDate: 'asc' },
  });

  // ── Distinct customers with activity in the month (invoice or payment).
  const customerIds = new Set<string>();
  for (const inv of activeInvoices) if (inv.customerId) customerIds.add(inv.customerId);
  for (const p of payments) customerIds.add(p.customerId);

  const activeCustomers = customerIds.size
    ? await prisma.customer.findMany({
        where: { id: { in: [...customerIds] }, distributorId, deletedAt: null },
        orderBy: { customerName: 'asc' },
      })
    : [];

  // ── Current cylinder balances for customers with activity.
  const customerBalances = customerIds.size
    ? await prisma.customerInventoryBalance.findMany({
        where: { customerId: { in: [...customerIds] } },
        include: {
          cylinderType: { select: { id: true, typeName: true, capacity: true } },
          customer: { select: { id: true, customerName: true, businessName: true, gstin: true } },
        },
      })
    : [];

  // ── Aggregate delivered-this-month per (customer, cylinderType) from invoice items.
  type DeliveryKey = string; // `${customerId}::${cylinderTypeId}`
  const deliveredMap = new Map<DeliveryKey, { customerId: string; cylinderTypeId: string; typeName: string; qty: number }>();
  for (const inv of activeInvoices) {
    if (!inv.customerId) continue;
    for (const item of inv.items) {
      if (!item.cylinderTypeId || !item.cylinderType) continue;
      const key = `${inv.customerId}::${item.cylinderTypeId}`;
      const existing = deliveredMap.get(key);
      if (existing) existing.qty += item.quantity;
      else
        deliveredMap.set(key, {
          customerId: inv.customerId,
          cylinderTypeId: item.cylinderTypeId,
          typeName: item.cylinderType.typeName,
          qty: item.quantity,
        });
    }
  }

  const wb = new ExcelJS.Workbook();
  wb.creator = 'MyGasLink';
  wb.created = new Date();

  // ── Sheet 1: GST_Summary (roll-up per cylinder-type, feeds GSTR-1 Table 12 + 3B).
  const summary = wb.addWorksheet('GST_Summary');
  summary.columns = [
    { header: 'Cylinder Type', key: 'type', width: 22 },
    { header: 'HSN', key: 'hsn', width: 12 },
    { header: 'UOM', key: 'uom', width: 8 },
    { header: 'Qty', key: 'qty', width: 10 },
    { header: 'Taxable Value', key: 'taxable', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'CGST ₹', key: 'cgst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Total Invoice Value', key: 'total', width: 18, style: { numFmt: '#,##0.00' } },
  ];
  const perType = new Map<string, { typeName: string; hsn: string; uom: string; qty: number; taxable: number; cgst: number; sgst: number; igst: number; total: number }>();
  for (const inv of activeInvoices) {
    for (const it of inv.items) {
      const typeName = it.cylinderType?.typeName ?? it.description ?? 'Unknown';
      const hsn = it.hsnCode ?? it.cylinderType?.hsnCode ?? '27111900';
      const key = `${typeName}::${hsn}`;
      const line = it.taxableValue !== null && it.taxableValue !== undefined
        ? n(it.taxableValue)
        : n(it.totalPrice) / (1 + n(it.gstRate) / 100);
      const gstRate = n(it.gstRate);
      // Per-line CGST/SGST/IGST proportional split from Invoice totals is
      // fiddly; use the assessable × rate/2 formula and let the header check
      // catch drift.
      const halfGst = line * (gstRate / 2 / 100);
      // We don't know intra vs inter-state at the LINE level; use Invoice-level
      // igstValue==0 as a marker of intra-state and split the line into cgst/sgst.
      // If any igstValue is set on the invoice, treat that line as igst.
      const invIsInterState = n(inv.igstValue) > 0;
      const existing = perType.get(key) ?? { typeName, hsn, uom: it.uom, qty: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0, total: 0 };
      existing.qty += it.quantity;
      existing.taxable += line;
      if (invIsInterState) existing.igst += line * (gstRate / 100);
      else {
        existing.cgst += halfGst;
        existing.sgst += halfGst;
      }
      existing.total += n(it.totalPrice);
      perType.set(key, existing);
    }
  }
  for (const s of perType.values()) {
    summary.addRow({
      type: s.typeName,
      hsn: s.hsn,
      uom: s.uom,
      qty: s.qty,
      taxable: r2(s.taxable),
      cgst: r2(s.cgst),
      sgst: r2(s.sgst),
      igst: r2(s.igst),
      total: r2(s.total),
    });
  }
  // Grand total row.
  if (perType.size > 0) {
    const totalRow = summary.addRow({
      type: 'GRAND TOTAL',
      hsn: '',
      uom: '',
      qty: [...perType.values()].reduce((a, b) => a + b.qty, 0),
      taxable: r2([...perType.values()].reduce((a, b) => a + b.taxable, 0)),
      cgst: r2([...perType.values()].reduce((a, b) => a + b.cgst, 0)),
      sgst: r2([...perType.values()].reduce((a, b) => a + b.sgst, 0)),
      igst: r2([...perType.values()].reduce((a, b) => a + b.igst, 0)),
      total: r2([...perType.values()].reduce((a, b) => a + b.total, 0)),
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((c) => {
      c.border = { top: { style: 'thin', color: { argb: 'FF6B7280' } } };
    });
  }
  styleHeader(summary, summary.columns.length);

  // ── Sheet 2: Invoices (one row per invoice).
  const invSheet = wb.addWorksheet('Invoices');
  invSheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Invoice No', key: 'no', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Delivery Date', key: 'ddate', width: 12 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 26 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'Customer Type', key: 'ctype', width: 8 },
    { header: 'State', key: 'state', width: 16 },
    { header: 'Order No', key: 'order', width: 16 },
    { header: 'Vehicle No', key: 'veh', width: 12 },
    { header: 'Driver', key: 'driver', width: 20 },
    { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Total (incl GST)', key: 'total', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Amount Paid', key: 'paid', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Outstanding', key: 'out', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'PO Number', key: 'po', width: 14 },
  ];
  activeInvoices.forEach((inv, idx) => {
    const vehicle = inv.order?.vehicle?.vehicleNumber ?? '';
    const driver = inv.order?.driver?.driverName ?? inv.order?.driverNameFreeText ?? '';
    invSheet.addRow({
      sl: idx + 1,
      no: inv.invoiceNumber,
      date: d(inv.issueDate),
      ddate: d(inv.order?.deliveryDate ?? null),
      cust: inv.customer?.customerName ?? '',
      biz: inv.customer?.businessName ?? '',
      gstin: inv.customerGstinSnapshot ?? inv.customer?.gstin ?? '',
      ctype: inv.customer?.customerType ?? '',
      state: inv.customer?.billingState ?? '',
      order: inv.order?.orderNumber ?? '',
      veh: vehicle,
      driver,
      taxable: r2(
        n(inv.taxableValue) ||
          inv.items.reduce((sum, it) => sum + (n(it.taxableValue) || n(it.totalPrice) / (1 + n(it.gstRate) / 100)), 0),
      ),
      cgst: r2(n(inv.cgstValue)),
      sgst: r2(n(inv.sgstValue)),
      igst: r2(n(inv.igstValue)),
      total: r2(n(inv.totalAmount)),
      paid: r2(n(inv.amountPaid)),
      out: r2(n(inv.outstandingAmount)),
      status: inv.status,
      po: inv.poNumber ?? '',
    });
  });
  styleHeader(invSheet, invSheet.columns.length);

  // ── Sheet 3: InvoiceLines (row per line-item; multi-cylinder-type long-format).
  const lines = wb.addWorksheet('InvoiceLines');
  lines.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Invoice No', key: 'no', width: 18 },
    { header: 'Invoice Date', key: 'date', width: 12 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'Cylinder Type', key: 'type', width: 18 },
    { header: 'HSN', key: 'hsn', width: 12 },
    { header: 'UOM', key: 'uom', width: 8 },
    { header: 'Qty', key: 'qty', width: 8 },
    { header: 'Rate (incl GST)', key: 'rate', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Discount/unit', key: 'disc', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'Line Total (incl GST)', key: 'lineTot', width: 16, style: { numFmt: '#,##0.00' } },
    { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'GST %', key: 'rate%', width: 7 },
    { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
    { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
  ];
  let sl = 0;
  for (const inv of activeInvoices) {
    const invIsInterState = n(inv.igstValue) > 0;
    for (const it of inv.items) {
      sl += 1;
      const gstRate = n(it.gstRate);
      const lineTot = n(it.totalPrice);
      const taxable = n(it.taxableValue) || lineTot / (1 + gstRate / 100);
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
        'rate%': gstRate,
        cgst: invIsInterState ? 0 : r2(gstAmt / 2),
        sgst: invIsInterState ? 0 : r2(gstAmt / 2),
        igst: invIsInterState ? r2(gstAmt) : 0,
      });
    }
  }
  styleHeader(lines, lines.columns.length);

  // ── Per-cylinder-type sheets (one sheet per SKU with July activity).
  //
  // Auditor's cross-check view: the client's historical May-2026 .xlsm had
  // one sheet per KG (19KG / 35KG / 47.5KG / 425KG / 5KG). Their GST
  // consultant ties the HSN summary back to physical stock movement by
  // reading these per-SKU sheets. Rows are grouped by customer (their
  // "customer-wise cylinder-wise split" ask) then chronological within
  // each customer, with a bold TOTAL footer.
  //
  // Only cylinder-type-backed items get their own sheet — service lines
  // like "Inward Transportation Charges" already live in InvoiceLines +
  // GST_Summary.
  type PerTypeLine = {
    inv: (typeof activeInvoices)[number];
    it: (typeof activeInvoices)[number]['items'][number];
    invIsInterState: boolean;
  };
  const perTypeLines = new Map<string, { typeName: string; hsn: string; rows: PerTypeLine[] }>();
  for (const inv of activeInvoices) {
    const invIsInterState = n(inv.igstValue) > 0;
    for (const it of inv.items) {
      if (!it.cylinderTypeId || !it.cylinderType) continue; // skip service lines
      const key = it.cylinderTypeId;
      const bucket = perTypeLines.get(key) ?? {
        typeName: it.cylinderType.typeName,
        hsn: it.hsnCode ?? it.cylinderType.hsnCode ?? '27111900',
        rows: [] as PerTypeLine[],
      };
      bucket.rows.push({ inv, it, invIsInterState });
      perTypeLines.set(key, bucket);
    }
  }
  // Deterministic sheet order: alphabetical by type name so 5 KG / 19 KG /
  // 47.5 LOT / 47.5 VOT always land in the same tab positions across months.
  const orderedTypes = [...perTypeLines.entries()].sort((a, b) =>
    a[1].typeName.localeCompare(b[1].typeName),
  );
  for (const [, bucket] of orderedTypes) {
    // Excel sheet-name cap = 31 chars; strip disallowed characters. Cylinder
    // type names in this codebase are short + safe but guard anyway.
    const safeName = bucket.typeName.replace(/[\\/?*[\]]/g, ' ').slice(0, 31);
    const ws = wb.addWorksheet(safeName);
    ws.columns = [
      { header: 'Sl No', key: 'sl', width: 6 },
      { header: 'Invoice No', key: 'no', width: 18 },
      { header: 'Invoice Date', key: 'date', width: 12 },
      { header: 'Customer Name', key: 'cust', width: 30 },
      { header: 'Business Name', key: 'biz', width: 26 },
      { header: 'GSTIN', key: 'gstin', width: 18 },
      { header: 'HSN', key: 'hsn', width: 12 },
      { header: 'UOM', key: 'uom', width: 8 },
      { header: 'Qty', key: 'qty', width: 8 },
      { header: 'Rate (incl GST)', key: 'rate', width: 14, style: { numFmt: '#,##0.00' } },
      { header: 'Discount/unit', key: 'disc', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'Line Total (incl GST)', key: 'lineTot', width: 16, style: { numFmt: '#,##0.00' } },
      { header: 'Taxable Value', key: 'taxable', width: 14, style: { numFmt: '#,##0.00' } },
      { header: 'GST %', key: 'rate%', width: 7 },
      { header: 'CGST ₹', key: 'cgst', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'SGST ₹', key: 'sgst', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'IGST ₹', key: 'igst', width: 12, style: { numFmt: '#,##0.00' } },
      { header: 'Total (incl GST)', key: 'lineTot2', width: 16, style: { numFmt: '#,##0.00' } },
    ];
    // Sort by (customer name, invoice date, invoice number) so a reader
    // scanning the sheet sees each customer's block together.
    bucket.rows.sort((a, b) => {
      const cn = (a.inv.customer?.customerName ?? '').localeCompare(b.inv.customer?.customerName ?? '');
      if (cn !== 0) return cn;
      const dt = a.inv.issueDate.getTime() - b.inv.issueDate.getTime();
      if (dt !== 0) return dt;
      return a.inv.invoiceNumber.localeCompare(b.inv.invoiceNumber);
    });
    let totalQty = 0, totalTaxable = 0, totalCgst = 0, totalSgst = 0, totalIgst = 0, totalLineTot = 0;
    bucket.rows.forEach((r, idx) => {
      const gstRate = n(r.it.gstRate);
      const lineTot = n(r.it.totalPrice);
      const taxable = n(r.it.taxableValue) || lineTot / (1 + gstRate / 100);
      const gstAmt = lineTot - taxable;
      const cgstV = r.invIsInterState ? 0 : r2(gstAmt / 2);
      const sgstV = r.invIsInterState ? 0 : r2(gstAmt / 2);
      const igstV = r.invIsInterState ? r2(gstAmt) : 0;
      ws.addRow({
        sl: idx + 1,
        no: r.inv.invoiceNumber,
        date: d(r.inv.issueDate),
        cust: r.inv.customer?.customerName ?? '',
        biz: r.inv.customer?.businessName ?? '',
        gstin: r.inv.customerGstinSnapshot ?? r.inv.customer?.gstin ?? '',
        hsn: r.it.hsnCode ?? r.it.cylinderType?.hsnCode ?? bucket.hsn,
        uom: r.it.uom,
        qty: r.it.quantity,
        rate: r2(n(r.it.unitPrice)),
        disc: r2(n(r.it.discountPerUnit)),
        lineTot: r2(lineTot),
        taxable: r2(taxable),
        'rate%': gstRate,
        cgst: cgstV,
        sgst: sgstV,
        igst: igstV,
        lineTot2: r2(lineTot),
      });
      totalQty += r.it.quantity;
      totalTaxable += taxable;
      totalCgst += cgstV;
      totalSgst += sgstV;
      totalIgst += igstV;
      totalLineTot += lineTot;
    });
    if (bucket.rows.length > 0) {
      const totalRow = ws.addRow({
        sl: '',
        no: '',
        date: '',
        cust: 'TOTAL',
        biz: '',
        gstin: '',
        hsn: '',
        uom: '',
        qty: totalQty,
        rate: '',
        disc: '',
        lineTot: r2(totalLineTot),
        taxable: r2(totalTaxable),
        'rate%': '',
        cgst: r2(totalCgst),
        sgst: r2(totalSgst),
        igst: r2(totalIgst),
        lineTot2: r2(totalLineTot),
      });
      totalRow.font = { bold: true };
      totalRow.eachCell((c) => {
        c.border = { top: { style: 'thin', color: { argb: 'FF6B7280' } } };
      });
    }
    styleHeader(ws, ws.columns.length);
  }

  // ── Sheet 4: Customers (master; only those with activity).
  const custSheet = wb.addWorksheet('Customers');
  custSheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 26 },
    { header: 'Customer Type', key: 'ctype', width: 8 },
    { header: 'Phone', key: 'phone', width: 14 },
    { header: 'Address', key: 'addr', width: 40 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'State', key: 'state', width: 16 },
    { header: 'Pincode', key: 'pin', width: 10 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
  ];
  activeCustomers.forEach((c, idx) => {
    const addr = [c.billingAddressLine1, c.billingAddressLine2].filter(Boolean).join(', ');
    custSheet.addRow({
      sl: idx + 1,
      cust: c.customerName,
      biz: c.businessName ?? '',
      ctype: c.customerType,
      phone: c.phone,
      addr,
      city: c.billingCity ?? '',
      state: c.billingState ?? '',
      pin: c.billingPincode ?? '',
      gstin: c.gstin ?? '',
    });
  });
  styleHeader(custSheet, custSheet.columns.length);

  // ── Sheet 5: Payments (receipts in month).
  const paySheet = wb.addWorksheet('Payments');
  paySheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Payment Date', key: 'date', width: 12 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 26 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'Method', key: 'method', width: 12 },
    { header: 'Reference No', key: 'ref', width: 20 },
    { header: 'Amount ₹', key: 'amount', width: 14, style: { numFmt: '#,##0.00' } },
    { header: 'Allocated To', key: 'allocs', width: 40 },
    { header: 'Notes', key: 'notes', width: 30 },
  ];
  payments.forEach((p, idx) => {
    const allocs = p.allocations
      .map((a) => `${a.invoice?.invoiceNumber ?? '?'}: ${r2(n(a.allocatedAmount)).toFixed(2)}`)
      .join('; ');
    paySheet.addRow({
      sl: idx + 1,
      date: d(p.transactionDate),
      cust: p.customer?.customerName ?? '',
      biz: p.customer?.businessName ?? '',
      gstin: p.customer?.gstin ?? '',
      method: p.paymentMethod,
      ref: p.referenceNumber ?? '',
      amount: r2(n(p.amount)),
      allocs,
      notes: p.notes ?? '',
    });
  });
  styleHeader(paySheet, paySheet.columns.length);

  // ── Sheet 6: CylinderBalances (long-format: customer × cylinder-type).
  const balSheet = wb.addWorksheet('CylinderBalances');
  balSheet.columns = [
    { header: 'Sl No', key: 'sl', width: 6 },
    { header: 'Customer Name', key: 'cust', width: 30 },
    { header: 'Business Name', key: 'biz', width: 26 },
    { header: 'GSTIN', key: 'gstin', width: 18 },
    { header: 'Cylinder Type', key: 'type', width: 18 },
    { header: 'Delivered This Month', key: 'del', width: 14 },
    { header: 'With Customer (Current)', key: 'held', width: 16 },
  ];
  // Build union of (customer × cylinder-type) rows from balances OR from delivered activity.
  type BalRow = { customerId: string; customerName: string; businessName: string | null; gstin: string | null; cylinderTypeId: string; typeName: string; delivered: number; held: number };
  const balMap = new Map<string, BalRow>();
  for (const b of customerBalances) {
    const key = `${b.customerId}::${b.cylinderTypeId}`;
    balMap.set(key, {
      customerId: b.customerId,
      customerName: b.customer.customerName,
      businessName: b.customer.businessName,
      gstin: b.customer.gstin,
      cylinderTypeId: b.cylinderTypeId,
      typeName: b.cylinderType.typeName,
      delivered: 0,
      held: b.withCustomerQty,
    });
  }
  for (const del of deliveredMap.values()) {
    const key = `${del.customerId}::${del.cylinderTypeId}`;
    const existing = balMap.get(key);
    if (existing) existing.delivered = del.qty;
    else {
      // Customer has deliveries but no CustomerInventoryBalance row for this type.
      const cust = activeCustomers.find((c) => c.id === del.customerId);
      balMap.set(key, {
        customerId: del.customerId,
        customerName: cust?.customerName ?? '',
        businessName: cust?.businessName ?? null,
        gstin: cust?.gstin ?? null,
        cylinderTypeId: del.cylinderTypeId,
        typeName: del.typeName,
        delivered: del.qty,
        held: 0,
      });
    }
  }
  const balRows = [...balMap.values()]
    .filter((r) => r.delivered > 0 || r.held !== 0) // drop zero rows
    .sort((a, b) => a.customerName.localeCompare(b.customerName) || a.typeName.localeCompare(b.typeName));
  balRows.forEach((r, idx) => {
    balSheet.addRow({
      sl: idx + 1,
      cust: r.customerName,
      biz: r.businessName ?? '',
      gstin: r.gstin ?? '',
      type: r.typeName,
      del: r.delivered,
      held: r.held,
    });
  });
  styleHeader(balSheet, balSheet.columns.length);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
  const docCode = distributor.docCode ?? 'DIST';
  const filename = `gst-filing-${docCode.toLowerCase()}-${label}.xlsx`;
  return { buffer, filename };
}
