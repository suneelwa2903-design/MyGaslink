/**
 * RCM Phase 2 pre-batch verify — READ-ONLY.
 *
 * Answers Q1-Q4 for IVGS2627000265 (cancelled) + IVGS2627000290 (new)
 * before proceeding to the remaining 6 invoices.
 *
 *   Q1 — sales-report scoped queries on prod DB (dates + double-count guard)
 *   Q2 — old IRN + old EWB status at NIC (expect: cancelled)
 *   Q3 — new IRN status at NIC + decoded RegRev from SignedInvoice payload
 *   Q4 — new EWB status at NIC (expect: active, correct vehicle, valid till)
 *
 * No writes. No mutations. gst_api_logs will grow by up to 4 GET rows.
 */
import { prisma } from '../src/lib/prisma.js';
import { getIrnDetails, getEwbStatus } from '../src/services/gst/gstService.js';
import { Buffer } from 'node:buffer';

const VANASTHALI_DIST_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';

function decodeJwtPayload(jwt: string): any {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    const outer = JSON.parse(payload);
    if (typeof outer.data === 'string') return JSON.parse(outer.data);
    return outer;
  } catch {
    return null;
  }
}

async function main() {
  console.log('=== RCM Phase 2 pre-batch verify (read-only) ===\n');

  // ─── Q1 ─────────────────────────────────────────────────────────────
  console.log('=== Q1 — Sales-report scoped queries ===\n');
  const rows = await prisma.$queryRaw<any[]>`
    SELECT
      i.invoice_number,
      i.issue_date::text  AS issue_date,
      i.total_amount::text AS total_amount,
      i.cgst_value::text  AS cgst,
      i.sgst_value::text  AS sgst,
      c.customer_name,
      i.status::text      AS status,
      i.irn_status::text  AS irn_status,
      i.ewb_status::text  AS ewb_status,
      i.deleted_at IS NOT NULL AS soft_deleted,
      i.order_id
    FROM invoices i
    JOIN customers c ON c.customer_id = i.customer_id
    WHERE i.distributor_id = ${VANASTHALI_DIST_ID}
      AND i.invoice_number IN ('IVGS2627000265','IVGS2627000290')
    ORDER BY i.invoice_number
  `;
  console.log('Both invoices side-by-side:');
  for (const r of rows) {
    console.log(`  ${r.invoice_number}  issue=${r.issue_date}  status=${r.status}  irn=${r.irn_status}  ewb=${r.ewb_status}  soft_deleted=${r.soft_deleted}  order_id=${r.order_id ?? '(null)'}`);
  }

  const oldRow = rows.find((r) => r.invoice_number === 'IVGS2627000265');
  const newRow = rows.find((r) => r.invoice_number === 'IVGS2627000290');
  console.log('\n  Q1 assertions:');
  console.log(`    IVGS2627000290 issue_date=2026-07-09:              ${newRow?.issue_date === '2026-07-09' ? '✓' : '✗'}`);
  console.log(`    IVGS2627000265 soft_deleted=true:                   ${oldRow?.soft_deleted === true ? '✓' : '✗'}`);
  console.log(`    IVGS2627000265 status='cancelled':                   ${oldRow?.status === 'cancelled' ? '✓' : '✗'}`);
  console.log(`    IVGS2627000265 order_id=NULL (disconnected):        ${oldRow?.order_id == null ? '✓' : '✗'}`);
  console.log(`    IVGS2627000290 status='issued', irn=success, ewb=active: ${newRow?.status === 'issued' && newRow?.irn_status === 'success' && newRow?.ewb_status === 'active' ? '✓' : '✗'}`);

  // Sales aggregation for 2026-07-09 — the exact query a reporting view
  // would run (excludes soft-deleted + cancelled → no double-count).
  const agg = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*)::int AS invoice_count,
           COALESCE(SUM(total_amount),0)::text AS total_sales,
           COALESCE(SUM(cgst_value + sgst_value),0)::text AS total_gst
      FROM invoices
     WHERE distributor_id = ${VANASTHALI_DIST_ID}
       AND issue_date::date = DATE '2026-07-09'
       AND deleted_at IS NULL
       AND status != 'cancelled'
  `;
  console.log(`\n  Sales aggregation for 2026-07-09 (deleted_at IS NULL, status != cancelled):`);
  console.log(`    invoice_count: ${agg[0].invoice_count}`);
  console.log(`    total_sales:   ₹${agg[0].total_sales}`);
  console.log(`    total_gst:     ₹${agg[0].total_gst}`);

  // Also count Sri Venkata Sai on that date only.
  const svs = await prisma.$queryRaw<any[]>`
    SELECT COUNT(*)::int AS n
      FROM invoices i
      JOIN customers c ON c.customer_id = i.customer_id
     WHERE i.distributor_id = ${VANASTHALI_DIST_ID}
       AND i.issue_date::date = DATE '2026-07-09'
       AND i.deleted_at IS NULL
       AND i.status != 'cancelled'
       AND c.customer_name ILIKE '%swagruha%'
  `;
  console.log(`    Sri Venkata Sai Swagruha Foods count on 2026-07-09 (visible): ${svs[0].n}   (expected: 1)`);

  // ─── Q2 — old IRN + old EWB status at NIC ──────────────────────────
  console.log('\n=== Q2 — old IRN + old EWB status at NIC ===\n');

  const oldIrnRow = await prisma.$queryRaw<any[]>`
    SELECT irn, ack_no, invoice_id
      FROM invoices
     WHERE invoice_number='IVGS2627000265'
  `;
  const oldIrn = oldIrnRow[0]?.irn as string;
  const oldEwb = '102482289983';   // recorded from smoke test log
  console.log(`Old IRN: ${oldIrn}`);
  console.log(`Old EWB: ${oldEwb}\n`);

  console.log('Fetching old IRN details from NIC...');
  try {
    const oldIrnDetails = await getIrnDetails(VANASTHALI_DIST_ID, oldIrn);
    const d = (oldIrnDetails as any)?.data ?? oldIrnDetails ?? {};
    console.log('  status_cd:      ', (oldIrnDetails as any)?.status_cd ?? '(none)');
    console.log('  status:         ', d?.Status ?? '(none)');
    console.log('  cancelled?:     ', d?.Status === 'CNL' || d?.Status === 'CANCELLED' ? '✓ YES' : (d?.Status ?? 'unknown'));
    console.log('  CnlDt:          ', d?.CnlDt ?? '(none)');
    console.log('  CnlRsn:         ', d?.CnlRsn ?? '(none)');
    console.log('  Irn (echo):     ', d?.Irn?.slice(0, 32) ?? '(none)');
  } catch (err: any) {
    console.log('  ⚠  getIrnDetails failed:', err?.message ?? String(err));
  }

  console.log('\nFetching old EWB status from NIC...');
  try {
    const oldEwbStatus = await getEwbStatus(VANASTHALI_DIST_ID, oldEwb);
    const d = (oldEwbStatus as any)?.data ?? oldEwbStatus ?? {};
    console.log('  status_cd:      ', (oldEwbStatus as any)?.status_cd ?? '(none)');
    console.log('  status:         ', d?.status ?? d?.Status ?? '(none)');
    console.log('  cancelled?:     ', d?.status === 'CNL' || d?.Status === 'CNL' ? '✓ YES' : (d?.status ?? d?.Status ?? 'unknown'));
    console.log('  cancelDate:     ', d?.cancelDate ?? d?.CancelDate ?? '(none)');
    console.log('  cancelReason:   ', d?.cancelRsnCode ?? d?.CancelRsnCode ?? '(none)');
    console.log('  vehicleNo:      ', d?.vehicleNo ?? d?.VehiclNo ?? '(none)');
  } catch (err: any) {
    console.log('  ⚠  getEwbStatus failed:', err?.message ?? String(err));
  }

  // ─── Q3 — new IRN status at NIC + RegRev decode ────────────────────
  console.log('\n=== Q3 — new IRN at NIC + SignedInvoice.RegRev decode ===\n');
  const newIrnRow = await prisma.$queryRaw<any[]>`
    SELECT irn, ack_no, invoice_id
      FROM invoices
     WHERE invoice_number='IVGS2627000290'
  `;
  const newIrn = newIrnRow[0]?.irn as string;
  console.log(`New IRN: ${newIrn}`);
  console.log(`AckNo:   ${newIrnRow[0]?.ack_no}\n`);

  console.log('Fetching new IRN details from NIC...');
  try {
    const newIrnDetails = await getIrnDetails(VANASTHALI_DIST_ID, newIrn);
    const outer = newIrnDetails as any;
    const d = outer?.data ?? outer ?? {};
    console.log('  status_cd:      ', outer?.status_cd ?? '(none)');
    console.log('  status_desc:    ', outer?.status_desc ?? '(none)');
    console.log('  Status:         ', d?.Status ?? '(none)');
    console.log('  AckNo:          ', d?.AckNo ?? '(none)');
    console.log('  AckDt:          ', d?.AckDt ?? '(none)');
    console.log('  SellerGstin:    ', d?.SellerGstin ?? '(none)');
    console.log('  BuyerGstin:     ', d?.BuyerGstin ?? '(none)');
    console.log('  TotInvVal:      ', d?.TotInvVal ?? '(none)');

    // Decode SignedInvoice JWT to prove RegRev='N' was persisted at NIC.
    const signedInv = d?.SignedInvoice ?? d?.SignedQRCode;
    if (typeof signedInv === 'string' && signedInv.split('.').length === 3) {
      const decoded = decodeJwtPayload(signedInv);
      if (decoded?.TranDtls?.RegRev !== undefined) {
        console.log(`\n  SignedInvoice.TranDtls.RegRev = "${decoded.TranDtls.RegRev}"   (must be "N")`);
        console.log(`  SignedInvoice.TranDtls.SupTyp = "${decoded.TranDtls.SupTyp}"`);
        console.log(`  SignedInvoice.DocDtls.No      = "${decoded.DocDtls?.No}"`);
        console.log(`  SignedInvoice.ValDtls.TotInvVal = ${decoded.ValDtls?.TotInvVal}`);
      } else {
        console.log('  SignedInvoice decoded but no TranDtls found. Payload keys:', Object.keys(decoded ?? {}));
      }
    } else {
      console.log('  (SignedInvoice not present in getIrnDetails response — falling back to gst_api_logs)');
      const irnGenLog = await prisma.gstApiLog.findFirst({
        where: { invoiceId: newIrnRow[0].invoice_id, apiType: 'IRN_GENERATE' },
        orderBy: { createdAt: 'desc' },
        select: { responsePayload: true, requestPayload: true },
      });
      const req = (irnGenLog?.requestPayload as any)?.TranDtls;
      console.log(`  request_payload.TranDtls.RegRev (from IRN_GENERATE log): "${req?.RegRev}"`);
      const signedFromGen = (irnGenLog?.responsePayload as any)?.data?.SignedInvoice;
      if (typeof signedFromGen === 'string') {
        const decoded = decodeJwtPayload(signedFromGen);
        if (decoded?.TranDtls?.RegRev !== undefined) {
          console.log(`  SignedInvoice.TranDtls.RegRev (from GENERATE response): "${decoded.TranDtls.RegRev}"`);
        }
      }
    }
  } catch (err: any) {
    console.log('  ⚠  getIrnDetails failed:', err?.message ?? String(err));
  }

  // ─── Q4 — new EWB status at NIC ───────────────────────────────────
  console.log('\n=== Q4 — new EWB status at NIC ===\n');
  const newEwb = '192482668361';
  console.log(`New EWB: ${newEwb}\n`);

  try {
    const newEwbStatus = await getEwbStatus(VANASTHALI_DIST_ID, newEwb);
    const outer = newEwbStatus as any;
    const d = outer?.data ?? outer ?? {};
    console.log('  status_cd:      ', outer?.status_cd ?? '(none)');
    console.log('  status_desc:    ', outer?.status_desc ?? '(none)');
    console.log('  status:         ', d?.status ?? d?.Status ?? '(none)');
    console.log('  ewayBillNo:     ', d?.ewayBillNo ?? d?.EwbNo ?? '(none)');
    console.log('  ewbDate:        ', d?.ewbDate ?? d?.EwbDt ?? '(none)');
    console.log('  validUpto:      ', d?.validUpto ?? d?.EwbValidTill ?? '(none)');
    console.log('  vehicleNo:      ', d?.vehicleNo ?? d?.VehiclNo ?? '(none)');
    console.log('  fromGstin:      ', d?.fromGstin ?? d?.FromGstin ?? '(none)');
    console.log('  toGstin:        ', d?.toGstin ?? d?.ToGstin ?? '(none)');
    console.log('  totInvValue:    ', d?.totInvValue ?? d?.TotInvVal ?? '(none)');
    console.log('  docNo:          ', d?.docNo ?? d?.DocNo ?? '(none)');
  } catch (err: any) {
    console.log('  ⚠  getEwbStatus failed:', err?.message ?? String(err));
  }

  // ─── Cross-check original vehicle number on the order ────────────
  console.log('\n=== Cross-check: original order vehicle number ===');
  const orderRow = await prisma.$queryRaw<any[]>`
    SELECT o.order_number, v.vehicle_number, o.driver_id
      FROM orders o
      LEFT JOIN vehicles v ON v.vehicle_id = o.vehicle_id
     WHERE o.order_id = (
       SELECT order_id FROM invoices WHERE invoice_number='IVGS2627000290'
     )
  `;
  console.log(`  order_number:   ${orderRow[0]?.order_number}`);
  console.log(`  vehicle_number: ${orderRow[0]?.vehicle_number}  (expect NEW EWB to reference the same)`);
}

main()
  .catch((err) => {
    console.error('Verify failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
