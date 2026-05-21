/**
 * probe-nic-session.ts  (READ-ONLY diagnostic — WI-089 investigation)
 *
 * Goal: verify the hypothesis behind WI-089 before writing any retry code.
 *
 *   Hypothesis: an IMMEDIATE re-auth against WhiteBooks sandbox returns the
 *   SAME auth-token string (so apiCall's existing `newToken === token` guard
 *   fires → SESSION_EXPIRED), whereas a DELAYED re-auth returns a genuinely
 *   FRESH token (which is why clicking Test Connection minutes later "fixes"
 *   it — it's elapsed time, not the click).
 *
 *   If TRUE  → the fix is a delayed/backed-off re-auth, NOT an immediate retry.
 *   If FALSE → SESSION_EXPIRED has a different root cause; a delayed retry
 *              won't help and the design must change.
 *
 * This script does NOT generate IRNs/EWBs and does NOT write to the DB.
 * It only: reads gst_api_logs, calls /authenticate (read-only), and calls
 * GSTNDETAILS (read-only lookup).
 *
 * Run:  npx tsx scripts/probe-nic-session.ts [distributorId]
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const SANDBOX_BASE = 'https://apisandbox.whitebooks.in';
const PROD_BASE = 'https://api.whitebooks.in';
const DEFAULT_IP = '127.0.0.1';
const TARGET_EMAIL = 'mvsuneelkumar2903@gmail.com';

function log(...a: any[]) { console.log(...a); }
function hashish(t: string | undefined): string {
  if (!t) return '(none)';
  if (t === 'no-token-needed') return t;
  // Don't print the raw token; print length + first/last 6 so we can compare
  // identity across calls without leaking the secret into logs.
  return `len=${t.length} ${t.slice(0, 6)}…${t.slice(-6)}`;
}

async function authenticate(creds: any): Promise<{ ok: boolean; token?: string; raw: any }> {
  const emailParam = encodeURIComponent(creds.email || 'info@mygaslink.com');
  const endpoint = `/einvoice/authenticate?email=${emailParam}`;
  const headers: Record<string, string> = {
    username: creds.username,
    password: creds.password || creds.clientSecret,
    ip_address: DEFAULT_IP,
    client_id: creds.clientId,
    gstin: creds.gstin,
    Accept: 'application/json',
  };
  if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;

  const res = await fetch(`${creds.baseUrl}${endpoint}`, { method: 'GET', headers });
  const json = await res.json() as any;
  const ok = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';
  const token = json.data?.AuthToken || json.data?.authtoken;
  return { ok, token, raw: json };
}

async function gstnDetails(creds: any, token: string, gstin: string): Promise<{ ok: boolean; errorCode?: string; raw: any }> {
  const headers: Record<string, string> = {
    ip_address: DEFAULT_IP,
    client_id: creds.clientId,
    gstin: creds.gstin,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    username: creds.username,
  };
  if (creds.clientSecret) headers['client_secret'] = creds.clientSecret;
  if (token && token !== 'no-token-needed') headers['auth-token'] = token;

  const emailParam = encodeURIComponent(creds.email || 'info@mygaslink.com');
  const url = `${creds.baseUrl}/einvoice/type/GSTNDETAILS/version/V1_03?param1=${gstin}&email=${emailParam}`;
  const res = await fetch(url, { method: 'GET', headers });
  const text = await res.text();
  let json: any;
  try { json = JSON.parse(text); } catch { json = { status_cd: 'NONJSON', status_desc: text.slice(0, 300) }; }
  const ok = json.status_cd === '1' || json.status_cd === 1 ||
    json.status_cd === 'Sucess' || json.status_cd === 'Success';
  // Extract error code from status_desc if it's a JSON array of {ErrorCode,...}
  let errorCode: string | undefined;
  if (!ok && typeof json.status_desc === 'string') {
    try {
      const errs = JSON.parse(json.status_desc);
      if (Array.isArray(errs) && errs[0]?.ErrorCode) errorCode = String(errs[0].ErrorCode);
    } catch { /* not json */ }
  }
  return { ok, errorCode, raw: json };
}

async function main() {
  const argId = process.argv[2];

  // 1) Resolve the credential row to probe.
  const cred = await prisma.gstCredential.findFirst({
    where: argId
      ? { distributorId: argId, scope: 'einvoice' }
      : { scope: 'einvoice', email: TARGET_EMAIL },
    include: { distributor: { select: { id: true, businessName: true, gstMode: true } } },
  });

  if (!cred) {
    log('No einvoice gstCredential found for', argId || `email=${TARGET_EMAIL}`);
    log('All einvoice credentials on this DB:');
    const all = await prisma.gstCredential.findMany({
      where: { scope: 'einvoice' },
      include: { distributor: { select: { id: true, businessName: true, gstMode: true } } },
    });
    for (const c of all) {
      log(`  - dist=${c.distributorId} (${c.distributor?.businessName}) mode=${c.distributor?.gstMode} email=${c.email} gstin=${c.gstin} valid=${c.isValid} lastValidated=${c.lastValidated?.toISOString()}`);
    }
    return;
  }

  const isSandbox = cred.distributor?.gstMode === 'sandbox' || !cred.distributor;
  const creds = {
    clientId: cred.clientId,
    clientSecret: cred.clientSecret,
    username: cred.username,
    password: cred.password,
    gstin: cred.gstin,
    email: cred.email || 'info@mygaslink.com',
    baseUrl: isSandbox ? SANDBOX_BASE : PROD_BASE,
  };

  log('═══════════════════════════════════════════════════════════════');
  log('PROBE TARGET');
  log(`  distributor : ${cred.distributorId} (${cred.distributor?.businessName})`);
  log(`  gstMode     : ${cred.distributor?.gstMode}  → baseUrl ${creds.baseUrl}`);
  log(`  gstin       : ${creds.gstin}`);
  log(`  email       : ${creds.email}`);
  log(`  isValid     : ${cred.isValid}  lastValidated=${cred.lastValidated?.toISOString()}`);
  log('═══════════════════════════════════════════════════════════════');

  // 2) Recent GSTNDETAILS / GSTIN_LOOKUP failures from the DB.
  log('\n── Recent GSTIN_LOOKUP rows in gst_api_logs (last 10) ──');
  const logs = await prisma.gstApiLog.findMany({
    where: { distributorId: cred.distributorId, apiType: 'GSTIN_LOOKUP' },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { createdAt: true, status: true, httpStatus: true, errorCode: true, errorMessage: true, latencyMs: true },
  });
  if (logs.length === 0) log('  (none)');
  for (const l of logs) {
    log(`  ${l.createdAt.toISOString()}  ${l.status.padEnd(7)} http=${l.httpStatus ?? '-'} code=${l.errorCode ?? '-'} ${l.latencyMs}ms  ${(l.errorMessage || '').slice(0, 80)}`);
  }

  // 3) LIVE auth-timing test.
  log('\n── LIVE auth-timing test ──');

  log('\n[A] authenticate #1 (cold)…');
  const a = await authenticate(creds);
  log(`    ok=${a.ok}  token=${hashish(a.token)}  status_cd=${a.raw.status_cd}  expiry=${a.raw.data?.TokenExpiry ?? '-'}`);
  if (!a.ok) { log('    auth #1 failed — cannot continue:', JSON.stringify(a.raw).slice(0, 300)); return; }

  log('\n[B] authenticate #2 (IMMEDIATE, ~0s later)…');
  const b = await authenticate(creds);
  log(`    ok=${b.ok}  token=${hashish(b.token)}  status_cd=${b.raw.status_cd}  expiry=${b.raw.data?.TokenExpiry ?? '-'}`);
  const immediateSame = !!a.token && a.token === b.token;
  log(`    >>> IMMEDIATE re-auth returned ${immediateSame ? 'THE SAME' : 'a DIFFERENT'} token`);

  log('\n[B2] GSTNDETAILS using token #2 (probe NIC session health)…');
  if (b.token) {
    const g2 = await gstnDetails(creds, b.token, creds.gstin);
    log(`    ok=${g2.ok}  errorCode=${g2.errorCode ?? '-'}  status_cd=${g2.raw.status_cd}  desc=${(typeof g2.raw.status_desc === 'string' ? g2.raw.status_desc : JSON.stringify(g2.raw.status_desc) || '').slice(0, 120)}`);
  }

  const DELAY_S = 60;
  log(`\n[C] waiting ${DELAY_S}s, then authenticate #3 (DELAYED)…`);
  await new Promise((r) => setTimeout(r, DELAY_S * 1000));
  const c = await authenticate(creds);
  log(`    ok=${c.ok}  token=${hashish(c.token)}  status_cd=${c.raw.status_cd}  expiry=${c.raw.data?.TokenExpiry ?? '-'}`);
  const delayedSame = !!b.token && b.token === c.token;
  log(`    >>> DELAYED (${DELAY_S}s) re-auth returned ${delayedSame ? 'THE SAME' : 'a DIFFERENT'} token vs #2`);

  log('\n[C2] GSTNDETAILS using token #3…');
  if (c.token) {
    const g3 = await gstnDetails(creds, c.token, creds.gstin);
    log(`    ok=${g3.ok}  errorCode=${g3.errorCode ?? '-'}  status_cd=${g3.raw.status_cd}  desc=${(typeof g3.raw.status_desc === 'string' ? g3.raw.status_desc : JSON.stringify(g3.raw.status_desc) || '').slice(0, 120)}`);
  }

  // 4) Verdict.
  log('\n═══════════════════════════════════════════════════════════════');
  log('VERDICT');
  log(`  immediate re-auth same token? ${immediateSame}`);
  log(`  delayed   re-auth same token? ${delayedSame}`);
  if (immediateSame && !delayedSame) {
    log('  → HYPOTHESIS CONFIRMED: immediate=same, delayed=fresh.');
    log('    Fix = delayed/backed-off re-auth on SESSION_EXPIRED, not immediate retry.');
  } else if (!immediateSame) {
    log('  → HYPOTHESIS REJECTED: even an immediate re-auth returns a fresh token.');
    log('    So apiCall\'s `newToken===token` guard should NOT normally fire.');
    log('    SESSION_EXPIRED has another cause — re-examine before designing the fix.');
  } else {
    log('  → INCONCLUSIVE: both same. WhiteBooks may be pinning one token regardless of delay.');
    log('    A delayed retry alone will NOT help; needs a different approach.');
  }
  log('═══════════════════════════════════════════════════════════════');
}

main()
  .catch((e) => { console.error('PROBE ERROR:', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
