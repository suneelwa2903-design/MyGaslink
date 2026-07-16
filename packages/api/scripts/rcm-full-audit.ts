/**
 * RCM Phase 2 — batch audit probe. READ-ONLY.
 *
 * For all 7 old→new invoice pairs, fetches live status from NIC for:
 *   - Old IRN + Old EWB → expected CNL
 *   - New IRN + New EWB → expected ACT
 *   - Decodes new IRN's SignedInvoice JWT and asserts TranDtls.RegRev = 'N'
 *
 * Prints machine-readable output that the audit doc + Excel build off.
 */
import { prisma } from '../src/lib/prisma.js';
import { getIrnDetails, getEwbStatus } from '../src/services/gst/gstService.js';
import { Buffer } from 'node:buffer';

const VANASTHALI_DIST_ID = '6a749f20-5a82-4b74-9977-51eac69049f2';

// Old -> New map (from batch run)
const PAIRS: Array<{ old: string; newInv: string }> = [
  { old: 'IVGS2627000265', newInv: 'IVGS2627000290' },
  { old: 'IVGS2627000270', newInv: 'IVGS2627000291' },
  { old: 'IVGS2627000288', newInv: 'IVGS2627000292' },
  { old: 'IVGS2627000268', newInv: 'IVGS2627000293' },
  { old: 'IVGS2627000278', newInv: 'IVGS2627000294' },
  { old: 'IVGS2627000262', newInv: 'IVGS2627000295' },
  { old: 'IVGS2627000277', newInv: 'IVGS2627000296' },
];

function decodeJwtPayload(jwt: string): any {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    const outer = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    return typeof outer.data === 'string' ? JSON.parse(outer.data) : outer;
  } catch { return null; }
}

async function irnStatusAt(dist: string, irn: string): Promise<string> {
  try {
    const r = await getIrnDetails(dist, irn);
    return ((r as any)?.data?.Status ?? (r as any)?.Status ?? '?') as string;
  } catch (e: any) { return `ERR:${e?.message?.slice(0, 40) ?? '?'}`; }
}

async function ewbStatusAt(dist: string, ewbNo: string): Promise<{ status: string; validUpto?: string; vehicleNo?: string; docNo?: string }> {
  try {
    const r = await getEwbStatus(dist, ewbNo);
    const d = (r as any)?.data ?? r ?? {};
    return {
      status: (d.status ?? d.Status ?? '?') as string,
      validUpto: d.validUpto ?? d.EwbValidTill,
      vehicleNo: d.vehicleNo ?? d.VehiclNo,
      docNo: d.docNo ?? d.DocNo,
    };
  } catch (e: any) { return { status: `ERR:${e?.message?.slice(0, 40) ?? '?'}` }; }
}

async function decodeRegRevFromNic(dist: string, irn: string): Promise<string> {
  try {
    const r = await getIrnDetails(dist, irn);
    const d = (r as any)?.data ?? r ?? {};
    const signed = d?.SignedInvoice;
    if (typeof signed !== 'string') return '?';
    const decoded = decodeJwtPayload(signed);
    return decoded?.TranDtls?.RegRev ?? '?';
  } catch { return '?'; }
}

async function main() {
  console.log('=== RCM Phase 2 batch audit — NIC live verification ===\n');

  const rows: any[] = [];

  for (const p of PAIRS) {
    const oldRow = await prisma.invoice.findFirstOrThrow({
      where: { invoiceNumber: p.old, distributorId: VANASTHALI_DIST_ID },
      select: {
        id: true, irn: true, ackNo: true, totalAmount: true,
        cgstValue: true, sgstValue: true, igstValue: true,
        issueDate: true,
        customer: { select: { customerName: true, businessName: true, gstin: true } },
      },
    });
    const newRow = await prisma.invoice.findFirstOrThrow({
      where: { invoiceNumber: p.newInv, distributorId: VANASTHALI_DIST_ID },
      select: { id: true, irn: true, ackNo: true, issueDate: true },
    });
    const oldGstDoc = await prisma.gstDocument.findFirst({
      where: { invoiceId: oldRow.id, isLatest: false }, // may not have latest flag if the row was superseded
      orderBy: { createdAt: 'desc' },
      select: { ewbNo: true },
    });
    const newGstDoc = await prisma.gstDocument.findFirstOrThrow({
      where: { invoiceId: newRow.id, isLatest: true },
      select: { ewbNo: true, ewbValidTill: true },
    });

    const oldEwbFromLog = await prisma.gstApiLog.findFirst({
      where: {
        invoiceId: oldRow.id,
        apiType: 'EWB_CANCEL',
      },
      orderBy: { createdAt: 'desc' },
      select: { requestPayload: true },
    });
    const oldEwbNo = (oldEwbFromLog?.requestPayload as any)?.ewbNo?.toString?.() ?? oldGstDoc?.ewbNo ?? '?';

    console.log(`--- ${p.old} → ${p.newInv} ---`);

    const oldIrnStatus = oldRow.irn ? await irnStatusAt(VANASTHALI_DIST_ID, oldRow.irn) : '?';
    const oldEwbInfo = oldEwbNo && oldEwbNo !== '?' ? await ewbStatusAt(VANASTHALI_DIST_ID, oldEwbNo) : { status: '?' };
    const newIrnStatus = newRow.irn ? await irnStatusAt(VANASTHALI_DIST_ID, newRow.irn) : '?';
    const newRegRev = newRow.irn ? await decodeRegRevFromNic(VANASTHALI_DIST_ID, newRow.irn) : '?';
    const newEwbInfo = newGstDoc.ewbNo ? await ewbStatusAt(VANASTHALI_DIST_ID, newGstDoc.ewbNo) : { status: '?' };

    console.log(`  OLD IRN ${oldRow.irn?.slice(0, 16)}…  NIC=${oldIrnStatus}   (expect CNL)`);
    console.log(`  OLD EWB ${oldEwbNo}                       NIC=${oldEwbInfo.status}   (expect CNL)`);
    console.log(`  NEW IRN ${newRow.irn?.slice(0, 16)}…  NIC=${newIrnStatus}   RegRev=${newRegRev}   (expect ACT, N)`);
    console.log(`  NEW EWB ${newGstDoc.ewbNo}                       NIC=${newEwbInfo.status} validUpto=${newEwbInfo.validUpto} vehicle=${newEwbInfo.vehicleNo ?? '(hidden)'}`);
    console.log();

    rows.push({
      oldInv: p.old,
      newInv: p.newInv,
      oldIrn: oldRow.irn,
      oldIrnStatusNic: oldIrnStatus,
      oldEwbNo,
      oldEwbStatusNic: oldEwbInfo.status,
      newIrn: newRow.irn,
      newAckNo: newRow.ackNo,
      newIrnStatusNic: newIrnStatus,
      newRegRev,
      newEwbNo: newGstDoc.ewbNo,
      newEwbStatusNic: newEwbInfo.status,
      newEwbValidTill: newEwbInfo.validUpto,
      newEwbVehicle: newEwbInfo.vehicleNo,
      newEwbDocNo: newEwbInfo.docNo,
      buyer: oldRow.customer?.businessName ?? oldRow.customer?.customerName,
      gstin: oldRow.customer?.gstin,
      issueDate: oldRow.issueDate.toISOString().slice(0, 10),
      newIssueDate: newRow.issueDate.toISOString().slice(0, 10),
      amount: oldRow.totalAmount.toString(),
      cgst: oldRow.cgstValue.toString(),
      sgst: oldRow.sgstValue.toString(),
      gst: (Number(oldRow.cgstValue) + Number(oldRow.sgstValue) + Number(oldRow.igstValue)).toFixed(2),
    });
  }

  console.log('=== SUMMARY ===');
  console.log(`old IRN CNL: ${rows.filter(r => r.oldIrnStatusNic === 'CNL').length}/7`);
  console.log(`old EWB CNL: ${rows.filter(r => r.oldEwbStatusNic === 'CNL').length}/7`);
  console.log(`new IRN ACT: ${rows.filter(r => r.newIrnStatusNic === 'ACT').length}/7`);
  console.log(`new EWB ACT: ${rows.filter(r => r.newEwbStatusNic === 'ACT').length}/7`);
  console.log(`RegRev='N':   ${rows.filter(r => r.newRegRev === 'N').length}/7`);

  console.log('\n=== MACHINE-READABLE JSON ===');
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
