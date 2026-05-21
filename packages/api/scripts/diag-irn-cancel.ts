/**
 * diag-irn-cancel.ts — Definitive live IRN-cancel forensics (2026-05-21).
 *
 * Answers the exact questions in the WI-090 brief, with timestamps:
 *   - What token was used for EWB_CANCEL vs IRN_CANCEL? Same or different?
 *   - What did NIC return for IRN_CANCEL?
 *   - ms between EWB_CANCEL and IRN_CANCEL?
 *   - Was clearTokenCache called before IRN_CANCEL?
 *   - Is responsePayload=NULL caused by the newToken===token guard?
 *
 * Method — two independent B2B orders, each dispatched to a REAL NIC IRN+EWB:
 *   ORDER A → cancel via the PRODUCTION endpoint POST /orders/:id/cancel
 *             (exercises the real cancelOrder orchestrator + apiCall guard).
 *   ORDER B → cancel via DIRECT NIC fetch from this script, bypassing the
 *             apiCall guard entirely — GROUND TRUTH on whether NIC accepts
 *             the cancel with the (pinned) einvoice token RIGHT NOW.
 *
 * Contrast:
 *   A fails (SESSION_EXPIRED, responsePayload NULL) + B succeeds  → the GUARD is the bug.
 *   A and B both succeed                                          → session healthy, guard latent.
 *   B fails with 1004/1005                                        → token genuinely rejected by NIC.
 *
 * WhiteBooks pins ONE token per session window (proven by probe-nic-session),
 * so the einvoice token this out-of-process script fetches is the SAME string
 * the server used — making cross-process token comparison valid.
 *
 * Run (from packages/api):
 *   pnpm exec tsx --env-file=.env scripts/diag-irn-cancel.ts
 * Requires: API on :5000, WhiteBooks sandbox reachable, NODE_ENV != production.
 */

import { prisma } from '../src/lib/prisma.js';
import {
  getAuthToken,
  getCredentials,
  clearTokenCache,
} from '../src/services/gst/whitebooksClient.js';

const BASE = 'http://localhost:5000/api';
const TODAY = new Date().toISOString().split('T')[0];
const DIST = 'dist-002';

const C = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m', dim: '\x1b[2m',
};
const ts = () => new Date().toISOString().replace('T', ' ').slice(11, 23);
const log = (...a: any[]) => console.log(`${C.dim}[${ts()}]${C.reset}`, ...a);
const hdr = (s: string) => console.log(`\n${C.bold}${C.cyan}${'═'.repeat(70)}\n${s}\n${'═'.repeat(70)}${C.reset}`);
const stepH = (s: string) => console.log(`\n${C.bold}${C.yellow}── ${s} ──${C.reset}`);
function tok(t: string | undefined): string {
  if (!t) return '(none)';
  if (t === 'no-token-needed') return t;
  return `len=${t.length} ${t.slice(0, 6)}…${t.slice(-6)}`;
}

async function http(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  let data: any;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

function nicSummary(resp: any): string {
  if (resp === null || resp === undefined) return `${C.red}NULL (code threw before NIC reply was stored)${C.reset}`;
  const sc = resp.status_cd;
  if (sc === '1' || sc === 1) return `${C.green}status_cd=1 SUCCESS${C.reset}`;
  let detail = resp.status_desc ?? resp.error?.message ?? '';
  try { const p = JSON.parse(detail); detail = JSON.stringify(p); } catch { /* keep */ }
  return `${C.red}status_cd=${sc} ${String(detail).slice(0, 140)}${C.reset}`;
}

// ─── Direct NIC fetch (bypasses apiCall + its guard) ───────────────────────────
async function directIrnCancel(distributorId: string, irn: string, token: string, reason: string) {
  const creds = await getCredentials(distributorId, 'einvoice');
  if (!creds) throw new Error('no einvoice creds');
  const email = encodeURIComponent(creds.email || 'info@mygaslink.com');
  const url = `${creds.baseUrl}/einvoice/type/CANCEL/version/V1_03?email=${email}`;
  const headers: Record<string, string> = {
    ip_address: '127.0.0.1',
    client_id: creds.clientId,
    gstin: creds.gstin,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    username: creds.username,
  };
  if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  if (token !== 'no-token-needed') headers['auth-token'] = token;
  const cnlRsn = reason.toLowerCase().includes('cancel') ? '3' : '4';
  const body = { Irn: irn, CnlRsn: cnlRsn, CnlRem: reason.slice(0, 100) };
  const t0 = Date.now();
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  return { httpStatus: res.status, json, latencyMs: Date.now() - t0 };
}

// ─── Create + dispatch one B2B order, return ids + IRN/EWB ──────────────────────
async function createAndDispatch(token: string, label: string, driver: any, vehicle: any, cylType: any, customer: any) {
  stepH(`${label}: create B2B order (${customer.customerName}, 19KG ×1) + dispatch`);
  const createRes = await http('POST', '/orders', {
    customerId: customer.id, deliveryDate: TODAY,
    items: [{ cylinderTypeId: cylType.id, quantity: 1 }],
  }, token);
  const orderId = createRes.data?.data?.orderId || createRes.data?.data?.id;
  const orderNumber = createRes.data?.data?.orderNumber || '?';
  log(`order created: ${orderNumber} id=${orderId} (HTTP ${createRes.status})`);
  if (!orderId) throw new Error(`order create failed: ${JSON.stringify(createRes.data).slice(0, 200)}`);

  await http('POST', `/orders/${orderId}/assign-driver`, { driverId: driver.id, vehicleId: vehicle.id }, token);

  const body = { driverId: driver.id, assignmentDate: TODAY };
  let r = await http('POST', '/orders/preflight-dispatch', body, token);
  if (r.status !== 200 && r.status !== 207) {
    log(`preflight-dispatch HTTP ${r.status} (${JSON.stringify(r.data?.code ?? r.data?.error ?? '').slice(0, 60)}) — falling back to preflight-add-to-trip`);
    r = await http('POST', '/orders/preflight-add-to-trip', body, token);
  }
  log(`preflight HTTP ${r.status}`);

  const orderRow = await prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: { invoice: { select: { id: true, invoiceNumber: true, irn: true, irnStatus: true, ewbStatus: true } } },
  });
  const inv = orderRow.invoice;
  log(`invoice ${inv?.invoiceNumber} irnStatus=${inv?.irnStatus} ewbStatus=${inv?.ewbStatus}`);
  log(`IRN: ${inv?.irn ? inv.irn.slice(0, 32) + '…' : 'null'}`);
  if (inv?.irnStatus !== 'success') throw new Error(`${label}: IRN not generated (irnStatus=${inv?.irnStatus}) — cannot test cancel`);
  return { orderId, orderNumber, invoiceId: inv.id, irn: inv.irn!, ewbStatus: inv.ewbStatus };
}

async function dumpCancelLogs(invoiceId: string) {
  const logs = await prisma.gstApiLog.findMany({
    where: { invoiceId, apiType: { in: ['EWB_CANCEL', 'IRN_CANCEL'] } },
    orderBy: { createdAt: 'asc' },
    select: { apiType: true, status: true, httpStatus: true, errorCode: true, errorMessage: true, responsePayload: true, createdAt: true, latencyMs: true },
  });
  const ewb = logs.find(l => l.apiType === 'EWB_CANCEL');
  const irn = logs.find(l => l.apiType === 'IRN_CANCEL');
  for (const l of logs) {
    log(`${C.bold}${l.apiType}${C.reset} @ ${l.createdAt.toISOString().slice(11, 23)} status=${l.status} http=${l.httpStatus ?? '-'} code=${l.errorCode ?? '-'} ${l.latencyMs}ms`);
    log(`    NIC response: ${nicSummary(l.responsePayload)}`);
  }
  let gapMs: number | null = null;
  if (ewb && irn) gapMs = irn.createdAt.getTime() - ewb.createdAt.getTime();
  return { ewb, irn, gapMs };
}

async function main() {
  hdr('  WI-090 — DEFINITIVE LIVE IRN-CANCEL FORENSICS');
  log(`date=${TODAY} api=${BASE} distributor=${DIST}`);

  // ── Auth ──
  const loginRes = await http('POST', '/auth/login', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  const token = loginRes.data?.data?.tokens?.accessToken || loginRes.data?.data?.accessToken;
  if (!token) throw new Error('login failed');
  log(`logged in as sharma@gasdist.com`);

  // ── Ground-truth: is the einvoice token valid at NIC right now? ──
  stepH('PRE-FLIGHT: einvoice token identity + NIC health (this process)');
  clearTokenCache(DIST);
  const einvoiceTokenScript = await getAuthToken(DIST, 'einvoice');
  const ewbTokenScript = await getAuthToken(DIST, 'ewaybill');
  log(`einvoice token (scope=einvoice): ${tok(einvoiceTokenScript)}`);
  log(`ewaybill token (scope=ewaybill): ${tok(ewbTokenScript)}`);
  log(`${C.bold}EWB and IRN tokens are ${einvoiceTokenScript === ewbTokenScript ? 'THE SAME' : 'DIFFERENT'}${C.reset} (different scopes → expected DIFFERENT)`);

  // ── Resolve entities ──
  const customer = await prisma.customer.findFirstOrThrow({
    where: { distributorId: DIST, customerName: 'Maruthi Agencies', deletedAt: null },
    select: { id: true, customerName: true, gstin: true, customerType: true },
  });
  const driver = await prisma.driver.findFirstOrThrow({ where: { distributorId: DIST, status: 'active', deletedAt: null }, select: { id: true, driverName: true } });
  const cylType = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST, capacity: 19 }, select: { id: true, typeName: true } });
  // assign-driver requires the vehicle to MATCH the driver's confirmed DVA
  // mapping for the delivery date (orderService.ts:485). Derive the vehicle
  // from the existing DVA; create one (status dispatch_ready) if none exists.
  let dva = await prisma.driverVehicleAssignment.findFirst({
    where: { driverId: driver.id, distributorId: DIST, assignmentDate: new Date(TODAY), status: { not: 'cancelled' } },
    select: { id: true, vehicleId: true, status: true, tripNumber: true },
  });
  if (!dva?.vehicleId) {
    const v = await prisma.vehicle.findFirstOrThrow({ where: { distributorId: DIST, deletedAt: null, status: { not: 'inactive' } }, select: { id: true } });
    dva = await prisma.driverVehicleAssignment.create({
      data: { driverId: driver.id, vehicleId: v.id, distributorId: DIST, assignmentDate: new Date(TODAY), tripNumber: 1, status: 'dispatch_ready' },
      select: { id: true, vehicleId: true, status: true, tripNumber: true },
    });
  }
  const vehicle = await prisma.vehicle.findUniqueOrThrow({ where: { id: dva.vehicleId! }, select: { id: true, vehicleNumber: true } });
  log(`entities: customer=${customer.customerName} driver=${driver.driverName} vehicle=${vehicle.vehicleNumber} dva=${dva.tripNumber}/${dva.status}`);

  // ═══════════════ ORDER A — production cancel path (guard in play) ═══════════════
  hdr('  ORDER A — cancel via PRODUCTION /orders/:id/cancel');
  const A = await createAndDispatch(token, 'ORDER A', driver, vehicle, cylType, customer);

  stepH('ORDER A: POST /orders/:id/cancel (real orchestrator: clearTokenCache once → EWB cancel → IRN cancel)');
  const tCancelStart = Date.now();
  const cancelRes = await http('POST', `/orders/${A.orderId}/cancel`, { reason: 'WI-090 diag cancel A' }, token);
  log(`cancel endpoint returned HTTP ${cancelRes.status} after ${Date.now() - tCancelStart}ms`);
  await new Promise(r => setTimeout(r, 600));

  stepH('ORDER A: gst_api_logs forensics');
  const aLogs = await dumpCancelLogs(A.invoiceId);
  if (aLogs.gapMs !== null) log(`${C.bold}EWB_CANCEL → IRN_CANCEL gap: ${aLogs.gapMs}ms${C.reset}`);
  const invA = await prisma.invoice.findUniqueOrThrow({ where: { id: A.invoiceId }, select: { irnStatus: true, ewbStatus: true, status: true } });
  log(`ORDER A final DB: invoice.status=${invA.status} irnStatus=${invA.irnStatus} ewbStatus=${invA.ewbStatus}`);

  const aIrnNull = aLogs.irn ? (aLogs.irn.responsePayload === null || aLogs.irn.responsePayload === undefined) : true;
  const aIrnOk = aLogs.irn?.status === 'success';
  const aGuardFired = aIrnNull && aLogs.irn?.errorCode === 'SESSION_EXPIRED';

  // ═══════════════ ORDER B — direct NIC fetch (guard bypassed) ═══════════════
  hdr('  ORDER B — cancel via DIRECT NIC fetch (apiCall guard BYPASSED)');
  const B = await createAndDispatch(token, 'ORDER B', driver, vehicle, cylType, customer);

  stepH('ORDER B: cancel EWB via production helper (NIC requires EWB cancelled before IRN)');
  // EWB cancel goes through the normal service so the EWB is properly retired at NIC.
  clearTokenCache(DIST);
  const { cancelEwb } = await import('../src/services/gst/gstService.js');
  let ewbCancelOk = false;
  try { await cancelEwb(B.invoiceId, DIST, 'WI-090 diag cancel B'); ewbCancelOk = true; log(`EWB cancelled via service`); }
  catch (e: any) { log(`${C.red}EWB cancel threw: ${e.code} ${e.message}${C.reset}`); }

  stepH('ORDER B: DIRECT IRN cancel against NIC (ground truth — no guard)');
  // Fetch the einvoice token exactly as the server would, then hit NIC directly.
  const einvoiceTokenB = await getAuthToken(DIST, 'einvoice');
  log(`token used for DIRECT IRN_CANCEL: ${tok(einvoiceTokenB)}`);
  log(`same string as pre-flight einvoice token? ${einvoiceTokenB === einvoiceTokenScript ? `${C.yellow}YES (pinned)${C.reset}` : 'NO (fresh)'}`);
  const tIrn0 = Date.now();
  const direct = await directIrnCancel(DIST, B.irn, einvoiceTokenB, 'WI-090 diag cancel B');
  log(`DIRECT IRN_CANCEL → HTTP ${direct.httpStatus} in ${direct.latencyMs}ms (${Date.now() - tIrn0}ms wall)`);
  log(`    NIC response: ${nicSummary(direct.json)}`);
  log(`    raw: ${JSON.stringify(direct.json).slice(0, 300)}`);

  const directOk = direct.json?.status_cd === '1' || direct.json?.status_cd === 1;
  if (directOk) {
    // Persist the genuine cancel so DB matches NIC.
    await prisma.invoice.update({ where: { id: B.invoiceId }, data: { irnStatus: 'cancelled', status: 'cancelled' } });
    await prisma.gstDocument.updateMany({ where: { invoiceId: B.invoiceId, isLatest: true }, data: { irnStatus: 'cancelled', cancelledAt: new Date() } });
    log(`ORDER B: DB updated to cancelled (NIC accepted the cancel)`);
  }

  // ═══════════════ VERDICT ═══════════════
  hdr('  ROOT-CAUSE VERDICT');
  console.log(`${C.bold}ORDER A (production path):${C.reset}`);
  console.log(`  IRN_CANCEL result   : ${aIrnOk ? C.green + 'SUCCESS' + C.reset : C.red + (aLogs.irn?.errorCode ?? 'n/a') + C.reset}`);
  console.log(`  responsePayload NULL: ${aIrnNull}`);
  console.log(`  guard (SESSION_EXPIRED + null payload) fired: ${aGuardFired ? C.red + 'YES' + C.reset : 'no'}`);
  console.log(`  EWB→IRN gap         : ${aLogs.gapMs ?? '?'}ms`);
  console.log(`${C.bold}ORDER B (direct NIC, guard bypassed):${C.reset}`);
  console.log(`  EWB cancel          : ${ewbCancelOk ? C.green + 'success' + C.reset : C.red + 'failed' + C.reset}`);
  console.log(`  DIRECT IRN_CANCEL   : ${directOk ? C.green + 'SUCCESS at NIC' + C.reset : C.red + nicSummary(direct.json) + C.reset}`);
  console.log('');
  if (aGuardFired && directOk) {
    console.log(`${C.bold}${C.red}>>> ROOT CAUSE (b): OUR CODE blocks the cancel.${C.reset}`);
    console.log(`    The newToken===token guard in apiCall throws SESSION_EXPIRED before the`);
    console.log(`    NIC CANCEL retry. The very same pinned einvoice token cancels successfully`);
    console.log(`    when sent directly to NIC (Order B). The guard's premise — "same token ⇒`);
    console.log(`    NIC will reject again" — is FALSE for the cancel path. FIX: let cancel retry`);
    console.log(`    hit NIC with the pinned token instead of short-circuiting.`);
  } else if (aIrnOk && directOk) {
    console.log(`${C.bold}${C.green}>>> Both paths succeeded. NIC session healthy; guard did not misfire this run.${C.reset}`);
    console.log(`    Guard remains LATENT: if NIC returns a transient 1004/1005 it will still`);
    console.log(`    short-circuit. Recommend hardening anyway.`);
  } else if (!directOk && (direct.json?.status_desc?.includes('1004') || direct.json?.status_desc?.includes('1005') || JSON.stringify(direct.json).includes('1005') || JSON.stringify(direct.json).includes('1004'))) {
    console.log(`${C.bold}${C.red}>>> ROOT CAUSE (a/c): NIC genuinely rejects the token for CANCEL (1004/1005).${C.reset}`);
    console.log(`    Even a direct call with the pinned token fails. This is an upstream NIC`);
    console.log(`    einvoice-session issue, not our guard. Needs delayed re-auth / NIC recovery.`);
  } else {
    console.log(`${C.bold}${C.yellow}>>> Mixed/!inconclusive. A.irnOk=${aIrnOk} A.guard=${aGuardFired} B.directOk=${directOk}${C.reset}`);
    console.log(`    Inspect raw responses above.`);
  }
  hdr('  END');
}

main()
  .catch(e => { console.error(`\n${C.red}SCRIPT CRASHED:${C.reset}`, e); process.exit(2); })
  .finally(() => prisma.$disconnect());
