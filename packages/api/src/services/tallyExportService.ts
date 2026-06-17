/**
 * Tally Setup — XML export builder (WI 2026-06-17).
 *
 * Produces a Tally XML payload that imports cleanly into Tally Prime (and
 * back-compatible with ERP 9) via Tally's "Import Data" XML interface.
 * Four voucher types are emitted, one per document class in the date range:
 *   1. Sales      — one per Invoice (issueDate in [from, to], not deleted)
 *   2. Receipt    — one per PaymentTransaction (transactionDate in [from, to])
 *   3. Credit Note — one per CreditNote (issueDate in [from, to])
 *   4. Debit Note — one per DebitNote  (issueDate in [from, to])
 *
 * Cross-tenant guarantee: every Prisma query in this file filters on
 * distributorId — directly or via a joined relation's `where: { invoice:
 * { distributorId } }` predicate (anti-pattern #1/#13).
 *
 * Tax distribution:
 *   - Intrastate (intra-state): emit CGST + SGST ledger entries; omit IGST.
 *   - Interstate (inter-state): emit IGST ledger entry; omit CGST + SGST.
 *   Decided per voucher by `igstValue > 0`. This is robust: createInvoice
 *   from Order sets exactly one of (cgst+sgst) OR igst based on the
 *   distributor's gstin state-code vs customer's place-of-supply.
 *
 * Round-off:
 *   sum(taxableValue + cgst + sgst + igst) should equal totalAmount. When
 *   integer / sub-rupee rounding leaves a sub-rupee gap (|diff| < 1), we
 *   add a round-off ledger entry against `ledgerRoundOff` so the voucher's
 *   debits = credits and Tally accepts the import. The diff sign drives
 *   ISDEEMEDPOSITIVE per spec: diff > 0 → "Yes" (round-off as a debit),
 *   diff < 0 → "No" (round-off as a credit).
 *
 * Stock items:
 *   Per invoice line, we look up settings.cylinderStockItems[cylinderTypeId]
 *   for the Tally stock-item name. If absent (or if cylinderTypeId is NULL
 *   — legitimate for transport-charge / ad-hoc lines), fall back to
 *   invoiceItem.description. Either way the line emits with `stockUnit`
 *   from settings as the UOM.
 *
 * Debit notes have no Phase 5 GSTR-1 tax columns (see
 * docs/INVOICE-NUMBERS-AUDIT.md / migration phase5_gstr1_columns). We
 * derive tax splits proportionally from the original invoice:
 *   ratio = DebitNote.totalAmount / Invoice.totalAmount
 *   taxableValue / cgst / sgst / igst on the DN voucher = original × ratio
 * — keeps NIC GSTR-1 9B export internally consistent with the original
 * invoice when the user later re-files.
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  TALLY_DEFAULTS,
  type TallySettingsValues,
} from './tallySettingsService.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Minimal XML escape — covers what Tally's parser rejects in attr + content. */
export function escapeXml(value: string | number | null | undefined): string {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Prisma Decimal | Decimal-string | number → number (rupees). */
function dec(value: Prisma.Decimal | number | string | null | undefined): number {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return value.toNumber();
}

/** Tally date format: YYYYMMDD (no separators). */
function tallyDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

/** Round to 2dp — Tally accepts more, but two is the conventional precision. */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Ledger entry shape ──────────────────────────────────────────────────────

interface LedgerEntry {
  /** Tally ledger name. */
  name: string;
  /** Positive number; sign comes from `isDeemedPositive`. */
  amount: number;
  /** "Yes" = debit, "No" = credit (Tally convention). */
  isDeemedPositive: boolean;
}

interface InventoryEntry {
  stockItemName: string;
  quantity: number;
  rate: number;
  amount: number;
  unit: string;
}

// ─── XML builders ────────────────────────────────────────────────────────────

function ledgerEntryXml(e: LedgerEntry): string {
  // Tally signs amounts in the AMOUNT element: debits are positive in source,
  // credits are negative. ISDEEMEDPOSITIVE mirrors that sign so the importer
  // can sanity-check.
  const signed = e.isDeemedPositive ? r2(e.amount) : -r2(e.amount);
  return [
    '      <LEDGERENTRIES.LIST>',
    `        <LEDGERNAME>${escapeXml(e.name)}</LEDGERNAME>`,
    `        <ISDEEMEDPOSITIVE>${e.isDeemedPositive ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>`,
    `        <AMOUNT>${signed}</AMOUNT>`,
    '      </LEDGERENTRIES.LIST>',
  ].join('\n');
}

function inventoryEntryXml(i: InventoryEntry): string {
  return [
    '      <ALLINVENTORYENTRIES.LIST>',
    `        <STOCKITEMNAME>${escapeXml(i.stockItemName)}</STOCKITEMNAME>`,
    '        <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>',
    `        <RATE>${r2(i.rate)}/${escapeXml(i.unit)}</RATE>`,
    `        <AMOUNT>${-r2(i.amount)}</AMOUNT>`,
    `        <ACTUALQTY>${i.quantity} ${escapeXml(i.unit)}</ACTUALQTY>`,
    `        <BILLEDQTY>${i.quantity} ${escapeXml(i.unit)}</BILLEDQTY>`,
    '      </ALLINVENTORYENTRIES.LIST>',
  ].join('\n');
}

interface VoucherInput {
  vchType: string;
  date: Date;
  voucherNumber: string;
  partyLedgerName: string;
  /** Optional narration shown in Tally's voucher view. */
  narration?: string;
  ledgerEntries: LedgerEntry[];
  inventoryEntries?: InventoryEntry[];
}

function voucherXml(v: VoucherInput): string {
  const parts: string[] = [
    `    <VOUCHER VCHTYPE="${escapeXml(v.vchType)}" ACTION="Create">`,
    `      <DATE>${tallyDate(v.date)}</DATE>`,
    `      <VOUCHERTYPENAME>${escapeXml(v.vchType)}</VOUCHERTYPENAME>`,
    `      <VOUCHERNUMBER>${escapeXml(v.voucherNumber)}</VOUCHERNUMBER>`,
    `      <PARTYLEDGERNAME>${escapeXml(v.partyLedgerName)}</PARTYLEDGERNAME>`,
  ];
  if (v.narration) parts.push(`      <NARRATION>${escapeXml(v.narration)}</NARRATION>`);
  for (const e of v.ledgerEntries) parts.push(ledgerEntryXml(e));
  for (const i of v.inventoryEntries ?? []) parts.push(inventoryEntryXml(i));
  parts.push('    </VOUCHER>');
  return parts.join('\n');
}

// ─── Voucher builders ────────────────────────────────────────────────────────

interface InvoiceWithItems {
  id: string;
  invoiceNumber: string;
  issueDate: Date;
  totalAmount: Prisma.Decimal;
  taxableValue: Prisma.Decimal | null;
  cgstValue: Prisma.Decimal;
  sgstValue: Prisma.Decimal;
  igstValue: Prisma.Decimal;
  customer: { customerName: string; businessName: string | null } | null;
  items: Array<{
    cylinderTypeId: string | null;
    description: string;
    quantity: number;
    unitPrice: Prisma.Decimal;
    discountPerUnit: Prisma.Decimal;
    totalPrice: Prisma.Decimal;
  }>;
}

/**
 * Build the ledger-entry set for a sales / credit-note / debit-note voucher.
 * Caller decides which sign convention to use — for sales, the party is
 * debited (Yes) and sales/tax credited (No); for credit notes the roles
 * invert (party credited, sales/tax debited). The `isReturn` flag flips
 * every entry's sign at once so the SAME helper covers both cases.
 *
 * Returns: ledger entries (including round-off when needed) plus the
 * diff that was rounded so tests can pin both presence + balance.
 */
function buildLedgerEntries(opts: {
  partyName: string;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  settings: TallySettingsValues;
  isReturn: boolean;
}): { entries: LedgerEntry[]; roundOffDiff: number } {
  const { partyName, taxableValue, cgst, sgst, igst, total, settings, isReturn } = opts;
  const partyPositive = !isReturn; // sales = debit party; return = credit party.

  const entries: LedgerEntry[] = [
    // Party (customer ledger). Amount = invoice total.
    { name: partyName, amount: total, isDeemedPositive: partyPositive },
    // Sales income (opposite sign to party).
    { name: settings.ledgerSales, amount: taxableValue, isDeemedPositive: !partyPositive },
  ];

  if (igst > 0) {
    entries.push({ name: settings.ledgerIgst, amount: igst, isDeemedPositive: !partyPositive });
  } else if (cgst > 0 || sgst > 0) {
    entries.push({ name: settings.ledgerCgst, amount: cgst, isDeemedPositive: !partyPositive });
    entries.push({ name: settings.ledgerSgst, amount: sgst, isDeemedPositive: !partyPositive });
  }

  // Round-off: when |total - (taxable + cgst + sgst + igst)| is non-zero
  // but sub-rupee, add a round-off entry. Tally rejects vouchers whose
  // debits != credits ("Difference in voucher" import error), so this is
  // non-optional for the 1–99 paise gap that Decimal(18,4) → display
  // rounding leaves behind.
  //
  // The spec's literal "diff > 0 ? 'Yes' : 'No'" mapping produces an
  // unbalanced voucher — Tally rejects it on import. The correct sign
  // for a balanced voucher: round-off sits OPPOSITE to the party. Sales
  // = party Dr, round-off Cr (No) when total exceeds components, Dr (Yes)
  // when components exceed total. Returns invert. Test #13 asserts the
  // balanced outcome; deviating from the spec here is the only way to
  // satisfy it AND have the XML actually import.
  const componentSum = taxableValue + cgst + sgst + igst;
  const diff = r2(total - componentSum);
  if (diff !== 0 && Math.abs(diff) < 1) {
    const roundOffIsDeemedPositive = isReturn ? diff > 0 : diff < 0;
    entries.push({
      name: settings.ledgerRoundOff,
      amount: Math.abs(diff),
      isDeemedPositive: roundOffIsDeemedPositive,
    });
  }
  return { entries, roundOffDiff: diff };
}

/** Build inventory entries for an invoice with stock-item mapping fallback. */
function buildInventoryEntries(
  inv: InvoiceWithItems,
  settings: TallySettingsValues,
): InventoryEntry[] {
  return inv.items.map((it) => {
    const mapped = it.cylinderTypeId
      ? settings.cylinderStockItems[it.cylinderTypeId]?.trim()
      : undefined;
    const stockItemName = mapped && mapped.length > 0 ? mapped : it.description;
    const qty = it.quantity;
    const lineTotal = dec(it.totalPrice);
    // Rate = lineTotal / qty so qty × rate === lineTotal even when the
    // invoice carried a per-unit discount (anti-pattern #16 — `unitPrice`
    // is post-discount inclusive on the customer mapper but raw on the
    // schema, so we drive off totalPrice to avoid the divergence).
    const rate = qty > 0 ? r2(lineTotal / qty) : 0;
    return {
      stockItemName,
      quantity: qty,
      rate,
      amount: lineTotal,
      unit: settings.stockUnit,
    };
  });
}

function partyLedgerName(c: { customerName: string; businessName: string | null } | null): string {
  // Prefer the businessName (matches how Tally users typically name their
  // Sundry-Debtor ledgers — by business, not by contact person). Fall back
  // to customerName, then a stable placeholder.
  return c?.businessName?.trim() || c?.customerName?.trim() || 'Unknown Customer';
}

// ─── Top-level: build the full export XML ────────────────────────────────────

export interface TallyExportFilters {
  dateFrom?: string; // YYYY-MM-DD
  dateTo?: string;   // YYYY-MM-DD
}

export interface TallyExportResult {
  xml: string;
  /** Counts for log / debug — not user-visible. */
  meta: {
    invoices: number;
    payments: number;
    creditNotes: number;
    debitNotes: number;
  };
}

export async function buildTallyExport(
  distributorId: string,
  filters: TallyExportFilters,
): Promise<TallyExportResult> {
  const dateFrom = filters.dateFrom ? new Date(filters.dateFrom) : undefined;
  const dateTo = filters.dateTo ? new Date(filters.dateTo) : undefined;

  // Load distributor + settings concurrently.
  const [distributor, settingsRow] = await Promise.all([
    prisma.distributor.findUniqueOrThrow({
      where: { id: distributorId },
      select: { legalName: true, businessName: true, gstin: true },
    }),
    prisma.tallySettings.findUnique({ where: { distributorId } }),
  ]);

  const settings: TallySettingsValues = settingsRow
    ? {
        tallyVersion: settingsRow.tallyVersion as 'prime' | 'erp9',
        tallyCompanyName: settingsRow.tallyCompanyName,
        ledgerSales: settingsRow.ledgerSales,
        ledgerCgst: settingsRow.ledgerCgst,
        ledgerSgst: settingsRow.ledgerSgst,
        ledgerIgst: settingsRow.ledgerIgst,
        ledgerCash: settingsRow.ledgerCash,
        ledgerBank: settingsRow.ledgerBank,
        ledgerSundryDebtors: settingsRow.ledgerSundryDebtors,
        ledgerRoundOff: settingsRow.ledgerRoundOff,
        voucherTypeSales: settingsRow.voucherTypeSales,
        voucherTypeReceipt: settingsRow.voucherTypeReceipt,
        voucherTypeCreditNote: settingsRow.voucherTypeCreditNote,
        voucherTypeDebitNote: settingsRow.voucherTypeDebitNote,
        stockUnit: settingsRow.stockUnit,
        cylinderStockItems:
          (settingsRow.cylinderStockItems as Record<string, string>) ?? {},
      }
    : { ...TALLY_DEFAULTS };

  const companyName = settings.tallyCompanyName?.trim() || distributor.legalName;

  // Date predicates.
  const issueDateRange =
    dateFrom || dateTo
      ? {
          gte: dateFrom,
          lte: dateTo,
        }
      : undefined;

  // 1. Sales vouchers — every issued invoice in the date range.
  const invoices = await prisma.invoice.findMany({
    where: {
      distributorId,
      deletedAt: null,
      status: { not: 'draft' },
      ...(issueDateRange ? { issueDate: issueDateRange } : {}),
    },
    select: {
      id: true,
      invoiceNumber: true,
      issueDate: true,
      totalAmount: true,
      taxableValue: true,
      cgstValue: true,
      sgstValue: true,
      igstValue: true,
      customer: { select: { customerName: true, businessName: true } },
      items: {
        select: {
          cylinderTypeId: true,
          description: true,
          quantity: true,
          unitPrice: true,
          discountPerUnit: true,
          totalPrice: true,
        },
      },
    },
    orderBy: { issueDate: 'asc' },
  });

  // 2. Payment receipts — every PaymentTransaction in the range.
  const payments = await prisma.paymentTransaction.findMany({
    where: {
      distributorId,
      deletedAt: null,
      ...(dateFrom || dateTo
        ? { transactionDate: { gte: dateFrom, lte: dateTo } }
        : {}),
    },
    select: {
      id: true,
      amount: true,
      paymentMethod: true,
      referenceNumber: true,
      transactionDate: true,
      customer: { select: { customerName: true, businessName: true } },
    },
    orderBy: { transactionDate: 'asc' },
  });

  // 3. Credit notes — joined via Invoice for tenant scoping (no own distributorId).
  const creditNotes = await prisma.creditNote.findMany({
    where: {
      invoice: { distributorId },
      issueDate: { not: null },
      ...(dateFrom || dateTo
        ? { issueDate: { gte: dateFrom, lte: dateTo } }
        : {}),
    },
    select: {
      id: true,
      creditNoteNumber: true,
      issueDate: true,
      totalAmount: true,
      taxableValue: true,
      cgstValue: true,
      sgstValue: true,
      igstValue: true,
      reason: true,
      invoice: {
        select: {
          invoiceNumber: true,
          totalAmount: true,
          taxableValue: true,
          cgstValue: true,
          sgstValue: true,
          igstValue: true,
          customer: { select: { customerName: true, businessName: true } },
        },
      },
    },
    orderBy: { issueDate: 'asc' },
  });

  // 4. Debit notes — no Phase 5 tax columns; derive proportional split.
  const debitNotes = await prisma.debitNote.findMany({
    where: {
      invoice: { distributorId },
      issueDate: { not: null },
      ...(dateFrom || dateTo
        ? { issueDate: { gte: dateFrom, lte: dateTo } }
        : {}),
    },
    select: {
      id: true,
      debitNoteNumber: true,
      issueDate: true,
      totalAmount: true,
      reason: true,
      invoice: {
        select: {
          invoiceNumber: true,
          totalAmount: true,
          taxableValue: true,
          cgstValue: true,
          sgstValue: true,
          igstValue: true,
          customer: { select: { customerName: true, businessName: true } },
        },
      },
    },
    orderBy: { issueDate: 'asc' },
  });

  // ─── Emit vouchers ────────────────────────────────────────────────────

  const vouchers: string[] = [];

  // Sales
  for (const inv of invoices) {
    const total = dec(inv.totalAmount);
    const cgst = dec(inv.cgstValue);
    const sgst = dec(inv.sgstValue);
    const igst = dec(inv.igstValue);
    // taxableValue is nullable on historical rows (pre-Phase-5). Derive
    // from total - taxes if missing so we never emit a degenerate voucher.
    const taxable = inv.taxableValue != null
      ? dec(inv.taxableValue)
      : r2(total - cgst - sgst - igst);
    const { entries } = buildLedgerEntries({
      partyName: partyLedgerName(inv.customer),
      taxableValue: taxable,
      cgst,
      sgst,
      igst,
      total,
      settings,
      isReturn: false,
    });
    vouchers.push(
      voucherXml({
        vchType: settings.voucherTypeSales,
        date: inv.issueDate,
        voucherNumber: inv.invoiceNumber,
        partyLedgerName: partyLedgerName(inv.customer),
        ledgerEntries: entries,
        inventoryEntries: buildInventoryEntries(inv, settings),
      }),
    );
  }

  // Receipts. CASH → ledgerCash; everything else (UPI / bank / cheque / etc) → ledgerBank.
  for (const p of payments) {
    const amount = dec(p.amount);
    const intoLedger =
      p.paymentMethod === 'cash' ? settings.ledgerCash : settings.ledgerBank;
    vouchers.push(
      voucherXml({
        vchType: settings.voucherTypeReceipt,
        date: p.transactionDate,
        voucherNumber: p.referenceNumber || `PMT-${p.id.slice(0, 8)}`,
        partyLedgerName: partyLedgerName(p.customer),
        narration: p.referenceNumber ? `Ref: ${p.referenceNumber}` : undefined,
        ledgerEntries: [
          // Debit the receiving account (cash / bank).
          { name: intoLedger, amount, isDeemedPositive: true },
          // Credit the customer.
          { name: partyLedgerName(p.customer), amount, isDeemedPositive: false },
        ],
      }),
    );
  }

  // Credit notes — Phase 5 columns present; null tax columns → derive.
  for (const cn of creditNotes) {
    if (!cn.issueDate) continue;
    const total = dec(cn.totalAmount);
    const cgst = cn.cgstValue != null ? dec(cn.cgstValue) : 0;
    const sgst = cn.sgstValue != null ? dec(cn.sgstValue) : 0;
    const igst = cn.igstValue != null ? dec(cn.igstValue) : 0;
    const taxable = cn.taxableValue != null
      ? dec(cn.taxableValue)
      : r2(total - cgst - sgst - igst);
    const { entries } = buildLedgerEntries({
      partyName: partyLedgerName(cn.invoice.customer),
      taxableValue: taxable,
      cgst,
      sgst,
      igst,
      total,
      settings,
      isReturn: true,
    });
    vouchers.push(
      voucherXml({
        vchType: settings.voucherTypeCreditNote,
        date: cn.issueDate,
        voucherNumber: cn.creditNoteNumber || `CN-${cn.id.slice(0, 8)}`,
        partyLedgerName: partyLedgerName(cn.invoice.customer),
        narration: `Against invoice ${cn.invoice.invoiceNumber}: ${cn.reason}`,
        ledgerEntries: entries,
      }),
    );
  }

  // Debit notes — no own tax columns; proportional split off the parent invoice.
  for (const dn of debitNotes) {
    if (!dn.issueDate) continue;
    const dnTotal = dec(dn.totalAmount);
    const invTotal = dec(dn.invoice.totalAmount);
    const ratio = invTotal > 0 ? dnTotal / invTotal : 0;
    const invCgst = dec(dn.invoice.cgstValue);
    const invSgst = dec(dn.invoice.sgstValue);
    const invIgst = dec(dn.invoice.igstValue);
    const invTaxable = dn.invoice.taxableValue != null
      ? dec(dn.invoice.taxableValue)
      : r2(invTotal - invCgst - invSgst - invIgst);
    const cgst = r2(invCgst * ratio);
    const sgst = r2(invSgst * ratio);
    const igst = r2(invIgst * ratio);
    const taxable = r2(invTaxable * ratio);
    const { entries } = buildLedgerEntries({
      partyName: partyLedgerName(dn.invoice.customer),
      taxableValue: taxable,
      cgst,
      sgst,
      igst,
      total: dnTotal,
      settings,
      // Debit notes from seller perspective: party is debited again (more
      // owed). Sign matches a sales voucher, not a return.
      isReturn: false,
    });
    vouchers.push(
      voucherXml({
        vchType: settings.voucherTypeDebitNote,
        date: dn.issueDate,
        voucherNumber: dn.debitNoteNumber || `DN-${dn.id.slice(0, 8)}`,
        partyLedgerName: partyLedgerName(dn.invoice.customer),
        narration: `Against invoice ${dn.invoice.invoiceNumber}: ${dn.reason}`,
        ledgerEntries: entries,
      }),
    );
  }

  // ─── Wrap envelope ────────────────────────────────────────────────────

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<ENVELOPE>',
    '  <HEADER>',
    '    <TALLYREQUEST>Import Data</TALLYREQUEST>',
    '  </HEADER>',
    '  <BODY>',
    '    <IMPORTDATA>',
    '      <REQUESTDESC>',
    '        <REPORTNAME>Vouchers</REPORTNAME>',
    '        <STATICVARIABLES>',
    `          <SVCURRENTCOMPANY>${escapeXml(companyName)}</SVCURRENTCOMPANY>`,
    '        </STATICVARIABLES>',
    '      </REQUESTDESC>',
    '      <REQUESTDATA>',
    '  <TALLYMESSAGE>',
    ...vouchers,
    '  </TALLYMESSAGE>',
    '      </REQUESTDATA>',
    '    </IMPORTDATA>',
    '  </BODY>',
    '</ENVELOPE>',
    '',
  ].join('\n');

  return {
    xml,
    meta: {
      invoices: invoices.length,
      payments: payments.length,
      creditNotes: creditNotes.length,
      debitNotes: debitNotes.length,
    },
  };
}
