/**
 * Comprehensive E-Way Bill (EWB) End-to-End Test
 *
 * Scenarios tested:
 * 1. B2B Intra-state: Order → Dispatch EWB → Deliver → IRN + EWB
 * 2. B2C: Order → Dispatch EWB → Deliver → EWB only (no IRN)
 * 3. Cancel EWB on an active invoice
 * 4. Cancel IRN on an active invoice
 * 5. Re-issue: Cancel invoice → New invoice → New IRN + EWB
 */
// Point to your running server (default dev port)
const BASE = `http://localhost:${process.env.PORT || 5000}/api`;

async function api(m: string, p: string, t: string, b?: any) {
  const r = await fetch(BASE + p, {
    method: m,
    headers: { 'Content-Type': 'application/json', ...(t ? { 'Authorization': 'Bearer ' + t } : {}) },
    body: b ? JSON.stringify(b) : undefined,
  });
  return (await r.json() as any);
}

function log(label: string) {
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${label}`);
  console.log('━'.repeat(70));
}
function ok(msg: string) { console.log(`  ✅ ${msg}`); }
function fail(msg: string) { console.log(`  ❌ ${msg}`); }
function info(msg: string) { console.log(`     ${msg}`); }
function warn(msg: string) { console.log(`  ⚠️  ${msg}`); }

async function sleep(ms: number, label?: string) {
  if (label) console.log(`  ⏳ ${label} (${ms / 1000}s)...`);
  await new Promise(r => setTimeout(r, ms));
}

// Track results across scenarios
const results: { scenario: string; irn: string; ewb: string; errors: string[] }[] = [];

async function createOrderAndDeliver(
  T: string,
  ct19Id: string,
  customerId: string,
  customerName: string,
  drvId: string,
  vehId: string,
  scenarioLabel: string,
): Promise<{ orderId: string; orderNumber: string; invoiceId?: string; invoiceNumber?: string } | null> {
  const today = new Date().toISOString().split('T')[0];

  // Stock up
  await api('POST', '/inventory/incoming-fulls', T, {
    cylinderTypeId: ct19Id, quantity: 20, documentType: 'AC4',
    documentNumber: `TEST-${Date.now()}`, documentDate: today,
  });

  // Create order
  const orderRes = await api('POST', '/orders', T, {
    customerId, deliveryDate: today, items: [{ cylinderTypeId: ct19Id, quantity: 3 }],
  });
  if (!orderRes.data?.id) { fail(`Order creation failed: ${JSON.stringify(orderRes)}`); return null; }
  const order = orderRes.data;
  ok(`Order: ${order.orderNumber}`);

  // Assign driver + vehicle
  const assignRes = await api('POST', `/orders/${order.id}/assign-driver`, T, {
    driverId: drvId, vehicleId: vehId,
  });
  if (!assignRes.success) { fail(`Assign failed: ${JSON.stringify(assignRes)}`); return null; }
  ok(`Assigned driver + vehicle`);

  // Dispatch
  const dispatchRes = await api('PUT', `/orders/${order.id}/status`, T, { status: 'pending_delivery' });
  if (!dispatchRes.success) { fail(`Dispatch failed: ${JSON.stringify(dispatchRes)}`); return null; }
  ok(`Dispatched → pending_delivery`);

  await sleep(6000, 'Waiting for dispatch EWB');

  // Check dispatch EWB errors
  const pa = (await api('GET', '/pending-actions', T)).data;
  const dispatchErrors = (Array.isArray(pa) ? pa : []).filter(
    (a: any) => a.actionType === 'DISPATCH_EWB_GENERATION' && a.entityId === order.id
  );
  if (dispatchErrors.length > 0) {
    warn(`Dispatch EWB error: ${dispatchErrors[0].description?.substring(0, 100)}`);
  } else {
    ok('Dispatch EWB: no errors');
  }

  // Confirm delivery
  const deliverRes = await api('POST', `/orders/${order.id}/confirm-delivery`, T, {
    items: [{ cylinderTypeId: ct19Id, deliveredQuantity: 3, emptiesCollected: 2 }],
  });
  if (!deliverRes.success) { fail(`Delivery failed: ${JSON.stringify(deliverRes)}`); return null; }
  ok(`Delivered`);

  await sleep(8000, 'Waiting for IRN + EWB generation');

  // Find invoice
  const invoices = (await api('GET', '/invoices', T)).data;
  const inv = invoices?.find((i: any) => i.orderId === order.id);
  if (!inv) { fail('No invoice found'); return null; }

  ok(`Invoice: ${inv.invoiceNumber}`);
  info(`IRN: ${inv.irnStatus || 'none'} ${inv.irn ? '(' + inv.irn.substring(0, 30) + '...)' : ''}`);
  info(`EWB: ${inv.ewbStatus || 'none'}`);

  // Check GST documents
  const docsRes = await api('GET', `/invoices/${inv.id}/gst-documents`, T);
  const docs = docsRes.data || [];
  info(`GST Documents: ${docs.length}`);
  docs.forEach((d: any) => {
    info(`  DocType:${d.docType} IRN:${d.irnStatus || '-'} EWB:${d.ewbStatus || '-'} EWB#:${d.ewbNo || '-'}`);
  });

  // If EWB not active, try manual trigger
  if (inv.ewbStatus !== 'active') {
    warn('EWB not active, trying manual trigger...');
    const gstRes = await api('POST', `/invoices/${inv.id}/generate-gst`, T);
    info(`Manual trigger: ${JSON.stringify(gstRes.data?.ewb || gstRes.data?.errors || 'no result')}`);
    await sleep(2000);
    // Re-fetch
    const inv2 = (await api('GET', `/invoices/${inv.id}`, T)).data;
    if (inv2) {
      info(`After trigger - IRN: ${inv2.irnStatus}, EWB: ${inv2.ewbStatus}`);
    }
  }

  // Record result
  const finalInv = (await api('GET', `/invoices/${inv.id}`, T)).data || inv;
  results.push({
    scenario: scenarioLabel,
    irn: finalInv.irnStatus || 'none',
    ewb: finalInv.ewbStatus || 'none',
    errors: dispatchErrors.map((e: any) => e.description?.substring(0, 60)),
  });

  return { orderId: order.id, orderNumber: order.orderNumber, invoiceId: inv.id, invoiceNumber: inv.invoiceNumber };
}

async function main() {
  // ──────────────────────────────────────────────────────────────
  // SETUP
  // ──────────────────────────────────────────────────────────────
  log('SETUP: Login & fetch reference data');

  const loginRes = await api('POST', '/auth/login', '', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  if (!loginRes.data?.tokens) { fail('Login failed'); console.log(loginRes); return; }
  const T = loginRes.data.tokens.accessToken;
  ok('Logged in as sharma@gasdist.com (dist-002)');

  const custs = (await api('GET', '/customers', T)).data;
  const cyls = (await api('GET', '/cylinder-types', T)).data;
  const drvs = (await api('GET', '/drivers', T)).data;
  const vehs = (await api('GET', '/vehicles', T)).data;

  const ct19 = cyls?.find((c: any) => c.typeName === '19 KG');
  if (!ct19) { fail('No 19 KG cylinder type'); return; }

  const b2bIntra = custs?.find((c: any) => c.gstin?.startsWith('29')); // Maruthi Agencies (Karnataka)
  const b2c = custs?.find((c: any) => !c.gstin);                       // Bangalore Foods (no GSTIN)
  const drv = drvs?.[0];
  const veh = vehs?.[0];

  if (!drv || !veh) { fail('No driver or vehicle'); return; }

  info(`B2B Intra: ${b2bIntra?.customerName || 'NONE'} (${b2bIntra?.gstin || '-'})`);
  info(`B2C:       ${b2c?.customerName || 'NONE'}`);
  info(`Driver:    ${drv.id}`);
  info(`Vehicle:   ${veh.vehicleNumber}`);

  // Clean up stale pending actions
  // (We check via API, can't delete via API but they won't affect new tests)

  // ──────────────────────────────────────────────────────────────
  // SCENARIO 1: B2B Intra-state (IRN + EWB)
  // ──────────────────────────────────────────────────────────────
  if (b2bIntra) {
    log('SCENARIO 1: B2B Intra-state (IRN + EWB)');
    info(`Customer: ${b2bIntra.customerName} GSTIN:${b2bIntra.gstin}`);
    info('Expected: Dispatch EWB → IRN + EWB on delivery');

    var scenario1 = await createOrderAndDeliver(
      T, ct19.id, b2bIntra.id, b2bIntra.customerName, drv.id, veh.id,
      'B2B Intra-state'
    );
  } else {
    warn('No B2B intra-state customer found, skipping scenario 1');
  }

  // ──────────────────────────────────────────────────────────────
  // SCENARIO 2: B2C (EWB only, no IRN)
  // ──────────────────────────────────────────────────────────────
  if (b2c) {
    log('SCENARIO 2: B2C - No GSTIN (EWB only, no IRN)');
    info(`Customer: ${b2c.customerName} (no GSTIN)`);
    info('Expected: Dispatch EWB → EWB only on delivery (no IRN for B2C)');

    var scenario2 = await createOrderAndDeliver(
      T, ct19.id, b2c.id, b2c.customerName, drv.id, veh.id,
      'B2C (no GSTIN)'
    );
  } else {
    warn('No B2C customer found, skipping scenario 2');
  }

  // ──────────────────────────────────────────────────────────────
  // SCENARIO 3: Cancel EWB
  // ──────────────────────────────────────────────────────────────
  log('SCENARIO 3: Cancel EWB');

  // Use scenario 1's invoice if it has an active EWB
  if (scenario1?.invoiceId) {
    const inv = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
    if (inv?.ewbStatus === 'active') {
      info(`Cancelling EWB on ${inv.invoiceNumber}...`);
      const cancelRes = await api('POST', `/invoices/${scenario1.invoiceId}/cancel-ewb`, T, {
        reason: 'Order cancelled - test scenario',
      });
      if (cancelRes.success) {
        ok(`EWB cancelled`);
        info(`Response: ${JSON.stringify(cancelRes.data?.status_cd || cancelRes.data)}`);
      } else {
        // On sandbox, cancel may fail if EWB was auto-generated or sandbox limitations
        warn(`EWB cancel response: ${JSON.stringify(cancelRes)}`);
      }

      // Verify
      await sleep(1000);
      const inv2 = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
      info(`After cancel - EWB status: ${inv2?.ewbStatus}`);

      results.push({
        scenario: 'Cancel EWB',
        irn: inv2?.irnStatus || 'none',
        ewb: inv2?.ewbStatus || 'none',
        errors: cancelRes.success ? [] : [cancelRes.error?.substring(0, 60) || 'cancel failed'],
      });
    } else {
      warn(`Scenario 1 invoice EWB status is "${inv?.ewbStatus}", skipping cancel test`);
    }
  } else {
    warn('No scenario 1 invoice available for EWB cancel test');
  }

  // ──────────────────────────────────────────────────────────────
  // SCENARIO 4: Cancel IRN
  // ──────────────────────────────────────────────────────────────
  log('SCENARIO 4: Cancel IRN');

  if (scenario1?.invoiceId) {
    const inv = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
    if (inv?.irnStatus === 'success' && inv?.irn) {
      info(`Cancelling IRN on ${inv.invoiceNumber}...`);
      const cancelRes = await api('POST', `/invoices/${scenario1.invoiceId}/cancel-irn`, T, {
        reason: 'Data entry error - test scenario',
      });
      if (cancelRes.success) {
        ok(`IRN cancelled`);
      } else {
        warn(`IRN cancel response: ${JSON.stringify(cancelRes)}`);
      }

      await sleep(1000);
      const inv2 = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
      info(`After cancel - IRN status: ${inv2?.irnStatus}`);

      results.push({
        scenario: 'Cancel IRN',
        irn: inv2?.irnStatus || 'none',
        ewb: inv2?.ewbStatus || 'none',
        errors: cancelRes.success ? [] : [cancelRes.error?.substring(0, 60) || 'cancel failed'],
      });
    } else {
      warn(`Scenario 1 invoice IRN status is "${inv?.irnStatus}", skipping cancel test`);
    }
  } else {
    warn('No scenario 1 invoice available for IRN cancel test');
  }

  // ──────────────────────────────────────────────────────────────
  // SCENARIO 5: Re-issue (manual GST trigger after cancel)
  // ──────────────────────────────────────────────────────────────
  log('SCENARIO 5: Re-issue GST after cancel');

  if (scenario1?.invoiceId) {
    const inv = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
    if (inv?.irnStatus === 'cancelled' || inv?.ewbStatus === 'cancelled') {
      info(`Re-triggering GST on cancelled invoice ${inv.invoiceNumber}...`);
      const gstRes = await api('POST', `/invoices/${scenario1.invoiceId}/generate-gst`, T);
      info(`Re-issue result: ${JSON.stringify(gstRes.data || gstRes, null, 2)}`);

      await sleep(3000, 'Waiting for re-issue');
      const inv2 = (await api('GET', `/invoices/${scenario1.invoiceId}`, T)).data;
      info(`After re-issue - IRN: ${inv2?.irnStatus}, EWB: ${inv2?.ewbStatus}`);

      results.push({
        scenario: 'Re-issue after cancel',
        irn: inv2?.irnStatus || 'none',
        ewb: inv2?.ewbStatus || 'none',
        errors: gstRes.data?.errors || [],
      });
    } else {
      warn('Invoice not in cancelled state, skipping re-issue test');
      info(`Current state - IRN: ${inv?.irnStatus}, EWB: ${inv?.ewbStatus}`);
    }
  } else {
    warn('No scenario 1 invoice available for re-issue test');
  }

  // ──────────────────────────────────────────────────────────────
  // FINAL: Pending Actions Summary
  // ──────────────────────────────────────────────────────────────
  log('FINAL: Pending Actions Check');

  const allPa = (await api('GET', '/pending-actions', T)).data;
  const gstPa = (Array.isArray(allPa) ? allPa : []).filter((a: any) => a.module === 'gst_compliance');
  if (gstPa.length > 0) {
    warn(`${gstPa.length} GST pending actions:`);
    gstPa.forEach((a: any) => info(`[${a.actionType}] ${a.description?.substring(0, 100)}`));
  } else {
    ok('No GST pending actions');
  }

  // ──────────────────────────────────────────────────────────────
  // RESULTS TABLE
  // ──────────────────────────────────────────────────────────────
  log('RESULTS SUMMARY');
  console.log();
  console.log('  Scenario                    │ IRN        │ EWB        │ Errors');
  console.log('  ────────────────────────────┼────────────┼────────────┼──────────────');
  for (const r of results) {
    const name = r.scenario.padEnd(28);
    const irn = r.irn.padEnd(10);
    const ewb = r.ewb.padEnd(10);
    const errs = r.errors.length > 0 ? r.errors.join('; ').substring(0, 40) : 'none';
    console.log(`  ${name}│ ${irn} │ ${ewb} │ ${errs}`);
  }
  console.log();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
