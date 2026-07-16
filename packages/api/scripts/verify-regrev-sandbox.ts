/**
 * RCM Phase 1D — sandbox verify probe.
 *
 * Fires ONE fresh B2B IRN through the standard dispatch path against
 * dist-002 Sharma's WhiteBooks sandbox (gstMode='sandbox' in dev DB).
 * Then reads back the latest `gst_api_logs` row and asserts:
 *   1. request_payload.TranDtls.RegRev === 'N'
 *   2. response_payload.status_cd === 1 (NIC accepted)
 *
 * If both pass → the RegRev='Y' → 'N' code fix is confirmed safe on the
 * live sandbox. Go-ahead for Phase 2.
 *
 * REQUIREMENTS to run:
 *   - API on http://localhost:5000 (or SMOKE_API_BASE)
 *   - dev Postgres seeded with dist-002 (Sharma) + Maruthi customer
 *   - WhiteBooks sandbox creds valid for dist-002
 *
 *   pnpm --filter @gaslink/api exec tsx scripts/verify-regrev-sandbox.ts
 */
import { prisma } from '../src/lib/prisma.js';

const BASE_URL = process.env.SMOKE_API_BASE || 'http://localhost:5000/api';
const DISTRIBUTOR_ID = 'dist-002';

// Sharma seed constants (verified in scripts/smoke-test-ewb.ts).
const DRIVER_ID = '23f33fbf-645d-44a4-bf91-4258f80df668';
const VEHICLE_ID = '03a8bfab-23d4-42c2-9adc-a95785fc9e02';
const CYL_19KG = 'f28f393a-6852-4f14-a108-a55fb574b639';
const MARUTHI_ID = '582c85b8-3aed-42a8-ab94-e6f4f9f75bd7';
const LOGIN = { email: 'sharma@gasdist.com', password: 'Gstadmin@123' };
const today = new Date().toISOString().slice(0, 10);

interface ApiJson { data?: any; error?: any; [k: string]: any }

async function api(token: string | null, method: string, path: string, body?: unknown): Promise<ApiJson> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      'X-Distributor-Id': DISTRIBUTOR_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json: ApiJson = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function login(): Promise<string> {
  const r = await api(null, 'POST', '/auth/login', LOGIN);
  const token = r.data?.tokens?.accessToken || r.data?.token || r.token;
  if (!token) throw new Error('No token in login response');
  return token as string;
}

async function main() {
  console.log('=== RCM Phase 1D — sandbox verify ===\n');
  console.log(`API base: ${BASE_URL}`);
  console.log(`Distributor: ${DISTRIBUTOR_ID} (Sharma, sandbox)`);
  console.log(`Fixture buyer: Maruthi (B2B intra-state)\n`);

  const token = await login();
  console.log('✓ Login');

  // Ensure a DVA exists for today (idempotent — swallow already-exists).
  try {
    await api(token, 'POST', '/assignments', {
      driverId: DRIVER_ID, vehicleId: VEHICLE_ID, assignmentDate: today,
    });
  } catch { /* already exists */ }
  console.log('✓ DVA present');

  // Create fresh B2B order. Matches smoke-test-ewb.ts contract — no
  // driver/vehicle on create, separate assign-driver step below.
  const order = await api(token, 'POST', '/orders', {
    customerId: MARUTHI_ID,
    deliveryDate: today,
    items: [{ cylinderTypeId: CYL_19KG, quantity: 1 }],
    specialInstructions: 'RCM Phase 1D verify — RegRev sandbox probe',
  });
  const orderData = order.data ?? order;
  const orderId = orderData?.id ?? orderData?.orderId ?? orderData?.order?.id;
  console.log(`✓ Order created: ${orderData?.orderNumber ?? orderId}`);

  await api(token, 'POST', `/orders/${orderId}/assign-driver`, {
    driverId: DRIVER_ID, vehicleId: VEHICLE_ID,
  });
  console.log('✓ Driver + vehicle assigned');

  // Preflight dispatch — this fires the IRN. Payload matches
  // scripts/smoke-test-ewb.ts contract exactly.
  let preflight: ApiJson;
  const preflightBody = { driverId: DRIVER_ID, assignmentDate: today };
  try {
    preflight = await api(token, 'POST', '/orders/preflight-dispatch', preflightBody);
  } catch (e: any) {
    if (!String(e?.message ?? '').includes('ALREADY_DISPATCHED')) throw e;
    console.log('  Driver already has active trip — falling back to preflight-add-to-trip');
    preflight = await api(token, 'POST', '/orders/preflight-add-to-trip', preflightBody);
  }
  console.log('✓ Preflight fired');
  console.log('  Summary:', JSON.stringify(preflight.data?.summary ?? preflight.summary, null, 2));

  // Read the LATEST IRN_GENERATE gst_api_logs row for dist-002.
  await new Promise((r) => setTimeout(r, 500));  // small settle
  const logRow = await prisma.gstApiLog.findFirst({
    where: { distributorId: DISTRIBUTOR_ID, apiType: 'IRN_GENERATE' },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, createdAt: true, invoiceId: true, httpStatus: true,
      requestPayload: true, responsePayload: true, errorCode: true,
    },
  });
  if (!logRow) throw new Error('No gst_api_logs row found after preflight');

  const req = logRow.requestPayload as any;
  const res = logRow.responsePayload as any;
  const regRev = req?.TranDtls?.RegRev;
  const statusCd = res?.status_cd ?? res?.Status ?? null;
  const irn = res?.data?.Irn ?? res?.Irn ?? null;

  console.log('\n=== gst_api_logs (latest IRN_GENERATE) ===');
  console.log(`log_id:        ${logRow.id}`);
  console.log(`created_at:    ${logRow.createdAt.toISOString()}`);
  console.log(`invoice_id:    ${logRow.invoiceId ?? '(null)'}`);
  console.log(`http_status:   ${logRow.httpStatus}`);
  console.log(`error_code:    ${logRow.errorCode ?? '(none)'}`);
  console.log(`RegRev sent:   ${regRev}`);
  console.log(`SupTyp sent:   ${req?.TranDtls?.SupTyp}`);
  console.log(`status_cd:     ${statusCd}`);
  console.log(`IRN returned:  ${irn ?? '(none)'}`);

  console.log('\n=== NIC response body (full) ===');
  console.log(JSON.stringify(res, null, 2));

  console.log('\n=== Verdict ===');
  const okReg = regRev === 'N';
  const okNic = statusCd === 1 || statusCd === '1';
  console.log(`  RegRev === 'N':       ${okReg ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`  NIC status_cd === 1:  ${okNic ? '✓ PASS' : '✗ FAIL'}`);
  if (okReg && okNic) {
    console.log('\n✅ Phase 1D SANDBOX VERIFY PASSED — safe to proceed to Phase 2.');
  } else {
    console.log('\n⛔ SANDBOX VERIFY FAILED — STOP. Do not proceed to Phase 2.');
    process.exit(1);
  }
}

main()
  .catch((err) => {
    console.error('\n⛔ Probe failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
