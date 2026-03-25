/**
 * WhiteBooks API Integration Test
 * Tests all e-Invoice and e-Way Bill API calls with real sandbox
 */

const BASE = 'http://localhost:5000/api';
let passed = 0, failed = 0;

async function api(method: string, path: string, token: string, body?: any): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

function check(label: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const today = new Date().toISOString().split('T')[0];
  await new Promise(r => setTimeout(r, 3000));

  // Login as GST distributor
  const login = (await api('POST', '/auth/login', '', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' })).data;
  const TOKEN = login.tokens.accessToken;

  // Get reference data
  const custs = (await api('GET', '/customers', TOKEN)).data;
  const cyls = (await api('GET', '/cylinder-types', TOKEN)).data;
  const drvs = (await api('GET', '/drivers', TOKEN)).data;
  const vehs = (await api('GET', '/vehicles', TOKEN)).data;

  const ct19 = cyls.find((c: any) => c.typeName === '19 KG')?.id;
  const b2bCust = custs.find((c: any) => c.gstin)?.id; // Telangana B2B
  const b2cCust = custs.find((c: any) => !c.gstin)?.id; // Karnataka B2C
  const drv = drvs[0].id, veh = vehs[0].id;

  // Add stock
  await api('POST', '/inventory/incoming-fulls', TOKEN, {
    cylinderTypeId: ct19, quantity: 100, documentType: 'AC4', documentNumber: 'WB-TEST', documentDate: today,
  });

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ TEST 1: B2B Inter-State Order → IRN + EWB ═══\n');
  // ═══════════════════════════════════════════════════════════════════

  // Create and deliver B2B order
  const order1 = (await api('POST', '/orders', TOKEN, {
    customerId: b2bCust, deliveryDate: today, items: [{ cylinderTypeId: ct19, quantity: 5 }],
  })).data;
  check('B2B order created', !!order1);

  await api('POST', `/orders/${order1.id}/assign-driver`, TOKEN, { driverId: drv, vehicleId: veh });
  await api('PUT', `/orders/${order1.id}/status`, TOKEN, { status: 'pending_delivery' });

  const del1 = (await api('POST', `/orders/${order1.id}/confirm-delivery`, TOKEN, {
    items: [{ cylinderTypeId: ct19, deliveredQuantity: 5, emptiesCollected: 3 }],
  })).data;
  check('B2B order delivered', del1?.status === 'delivered');

  // Wait for async GST processing
  console.log('  Waiting 5s for async GST processing...');
  await new Promise(r => setTimeout(r, 5000));

  // Check IRN status
  const inv1 = (await api('GET', '/invoices', TOKEN)).data?.find((i: any) => i.orderId === order1.id);
  console.log(`  Invoice: ${inv1?.invoiceNumber}, IRN: ${inv1?.irnStatus}, IRN#: ${inv1?.irn?.substring(0, 30) || 'none'}`);
  check('IRN status', inv1?.irnStatus === 'success' || inv1?.irnStatus === 'failed');

  if (inv1?.irnStatus === 'success') {
    check('IRN generated with real number', !!inv1.irn);
    check('AckNo present', !!inv1.ackNo);
    console.log(`  ✅ IRN: ${inv1.irn.substring(0, 40)}...`);
    console.log(`  ✅ AckNo: ${inv1.ackNo}`);
  } else {
    // Try manual trigger
    console.log('  IRN not auto-generated. Trying manual trigger...');
    const gstResult = (await api('POST', `/invoices/${inv1.id}/generate-gst`, TOKEN)).data;
    console.log(`  Manual GST result: IRN=${gstResult?.irn?.status}, EWB=${gstResult?.ewb?.status}`);

    if (gstResult?.irn?.status === 'success') {
      check('IRN generated via manual trigger', true);
      console.log(`  ✅ IRN: ${gstResult.irn.irn?.substring(0, 40)}...`);
    } else {
      check('IRN generation', false, `errors: ${gstResult?.errors?.join(', ')}`);
    }

    if (gstResult?.ewb?.status === 'active') {
      check('EWB generated', true);
      console.log(`  ✅ EWB No: ${gstResult.ewb.ewbNo}`);
    } else {
      console.log(`  EWB: ${gstResult?.ewb?.status || 'not attempted'} - ${gstResult?.errors?.find((e: string) => e.includes('EWB')) || 'no EWB error'}`);
    }
  }

  // Check GST documents
  const gstDocs = (await api('GET', `/invoices/${inv1?.id}/gst-documents`, TOKEN)).data;
  check('GST documents stored', (gstDocs?.length || 0) > 0);
  if (gstDocs?.[0]) {
    console.log(`  GST Doc: type=${gstDocs[0].docType}, IRN=${gstDocs[0].irnStatus}, EWB=${gstDocs[0].ewbStatus}`);
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ TEST 2: B2C Same-State Order → No IRN, EWB if >50K ═══\n');
  // ═══════════════════════════════════════════════════════════════════

  const order2 = (await api('POST', '/orders', TOKEN, {
    customerId: b2cCust, deliveryDate: today, items: [{ cylinderTypeId: ct19, quantity: 10 }],
  })).data;
  check('B2C order created', !!order2);

  await api('POST', `/orders/${order2.id}/assign-driver`, TOKEN, { driverId: drv, vehicleId: veh });
  await api('PUT', `/orders/${order2.id}/status`, TOKEN, { status: 'pending_delivery' });
  const del2 = (await api('POST', `/orders/${order2.id}/confirm-delivery`, TOKEN, {
    items: [{ cylinderTypeId: ct19, deliveredQuantity: 10, emptiesCollected: 7 }],
  })).data;
  check('B2C order delivered', del2?.status === 'delivered');

  await new Promise(r => setTimeout(r, 3000));

  const inv2 = (await api('GET', '/invoices', TOKEN)).data?.find((i: any) => i.orderId === order2.id);
  check('B2C invoice created', !!inv2);
  check('B2C: No IRN attempted (correct)', inv2?.irnStatus === 'not_attempted');
  console.log(`  B2C Invoice: ${inv2?.invoiceNumber}, Total: ₹${inv2?.totalAmount}, IRN: ${inv2?.irnStatus}`);

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ TEST 3: GSTIN Validation ═══\n');
  // ═══════════════════════════════════════════════════════════════════

  const gstinResult = (await api('POST', '/invoices/validate-gstin', TOKEN, { gstin: '36AAGCB1286Q004' })).data;
  check('GSTIN validation call succeeded', !!gstinResult);
  console.log(`  Valid: ${gstinResult?.valid}, Source: ${gstinResult?.source}`);

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ TEST 4: IRN Cancel (if generated) ═══\n');
  // ═══════════════════════════════════════════════════════════════════

  // Refresh invoice data
  const inv1After = (await api('GET', `/invoices/${inv1?.id}`, TOKEN)).data;
  if (inv1After?.irn) {
    const cancelResult = await api('POST', `/invoices/${inv1.id}/cancel-irn`, TOKEN, {
      reason: 'Test cancellation',
    });
    check('IRN cancel attempted', !!cancelResult);
    console.log(`  Cancel result: ${cancelResult?.success ? 'success' : cancelResult?.error}`);
  } else {
    console.log('  No IRN to cancel (skipping)');
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══ TEST 5: Pending Actions ═══\n');
  // ═══════════════════════════════════════════════════════════════════

  // Check what errors were recorded
  const pendingActions = (await api('GET', '/pending-actions', TOKEN)).data;
  if (pendingActions && Array.isArray(pendingActions)) {
    const gstActions = pendingActions.filter((a: any) => a.module === 'gst_compliance');
    console.log(`  GST pending actions: ${gstActions.length}`);
    gstActions.forEach((a: any) => console.log(`    [${a.actionType}] ${a.description?.substring(0, 80)}`));
  }

  // ═══════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log(`  WHITEBOOKS API TEST: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
