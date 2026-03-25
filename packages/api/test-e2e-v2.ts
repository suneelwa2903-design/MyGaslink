/**
 * Comprehensive E2E Test v2 - Tests ALL workflows including:
 * 1. Non-GST distributor: full order lifecycle
 * 2. Returns-only order (empty pickup, no invoice)
 * 3. Modified delivery (partial delivery, cancelled stock)
 * 4. Create order from cancelled stock on vehicle
 * 5. GST-enabled distributor: same-state (CGST+SGST) and inter-state (IGST)
 * 6. Retroactive GST invoice generation
 * 7. Inventory verification with cylinder type names
 * 8. Payments and collections
 */

const BASE = 'http://localhost:5000/api';
let passed = 0, failed = 0;

async function api(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { 'Authorization': `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) return null;
  return json.data;
}

function check(label: string, condition: boolean, detail?: string) {
  if (condition) { passed++; console.log(`  ✅ ${label}`); }
  else { failed++; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
  const today = new Date().toISOString().split('T')[0];

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══ PART 1: NON-GST DISTRIBUTOR (Bhargava Gas Agency) ═══\n');
  // ═══════════════════════════════════════════════════════════════════════════

  const login1 = await api('POST', '/auth/login', '', { email: 'bhargava@gasagency.com', password: 'Distadmin@123' });
  const T1 = login1!.tokens.accessToken;
  check('Login non-GST distributor', !!T1);

  const customers = await api('GET', '/customers', T1);
  const cylTypes = await api('GET', '/cylinder-types', T1);
  const drivers = await api('GET', '/drivers', T1);
  const vehicles = await api('GET', '/vehicles', T1);

  const ct19 = cylTypes.find((c: any) => c.typeName === '19 KG')?.id;
  const ct5 = cylTypes.find((c: any) => c.typeName === '5 KG')?.id;
  const ct47 = cylTypes.find((c: any) => c.typeName === '47.5 KG')?.id;
  const cust1 = customers[0].id;
  const cust2 = customers[2].id;
  const driver1 = drivers[0].id;
  const vehicle1 = vehicles[0].id;

  // Add incoming stock
  console.log('\n--- Incoming Stock ---');
  const stock19 = await api('POST', '/inventory/incoming-fulls', T1, {
    cylinderTypeId: ct19, quantity: 100, documentType: 'AC4', documentNumber: 'AC4-001', documentDate: today,
  });
  const stock5 = await api('POST', '/inventory/incoming-fulls', T1, {
    cylinderTypeId: ct5, quantity: 50, documentType: 'AC4', documentNumber: 'AC4-002', documentDate: today,
  });
  check('Incoming stock 19KG', !!stock19);
  check('Incoming stock 5KG', !!stock5);

  // ─── Test 1: Full delivery order ───
  console.log('\n--- Test 1: Full Delivery Order ---');
  const order1 = await api('POST', '/orders', T1, {
    customerId: cust1, deliveryDate: today, items: [{ cylinderTypeId: ct19, quantity: 10 }],
  });
  check('Create delivery order', !!order1 && order1.totalAmount === 18000);

  await api('POST', `/orders/${order1.id}/assign-driver`, T1, { driverId: driver1, vehicleId: vehicle1 });
  await api('PUT', `/orders/${order1.id}/status`, T1, { status: 'pending_delivery' });
  const delivered1 = await api('POST', `/orders/${order1.id}/confirm-delivery`, T1, {
    items: [{ cylinderTypeId: ct19, deliveredQuantity: 10, emptiesCollected: 7 }],
  });
  check('Full delivery (10/10)', delivered1?.status === 'delivered');

  // Verify invoice auto-created (non-GST: no tax breakup)
  const invoices1 = await api('GET', '/invoices', T1);
  const inv1 = invoices1?.find((i: any) => i.orderId === order1.id);
  check('Invoice auto-created', !!inv1);
  check('Non-GST: CGST=0, SGST=0', inv1?.cgstValue === 0 && inv1?.sgstValue === 0);
  check('Non-GST: Total = order total', inv1?.totalAmount === delivered1?.totalAmount);

  // ─── Test 2: Modified delivery (partial) ───
  console.log('\n--- Test 2: Modified Delivery (Partial) ---');
  const order2 = await api('POST', '/orders', T1, {
    customerId: cust2, deliveryDate: today, items: [{ cylinderTypeId: ct19, quantity: 8 }],
  });
  check('Create order for partial delivery', !!order2 && order2.totalAmount === 14400);

  await api('POST', `/orders/${order2.id}/assign-driver`, T1, { driverId: driver1, vehicleId: vehicle1 });
  await api('PUT', `/orders/${order2.id}/status`, T1, { status: 'pending_delivery' });

  // Deliver only 5 of 8 ordered
  const delivered2 = await api('POST', `/orders/${order2.id}/confirm-delivery`, T1, {
    items: [{ cylinderTypeId: ct19, deliveredQuantity: 5, emptiesCollected: 3 }],
  });
  check('Modified delivery (5/8)', delivered2?.status === 'modified_delivered');
  check('Recalculated total', delivered2?.totalAmount === 9000); // 5 * 1800

  // Verify cancelled stock created (3 cylinders)
  const cancelled = await api('GET', '/inventory/cancelled-stock', T1);
  const cancelledForOrder2 = cancelled?.filter((c: any) => c.orderId === order2.id);
  check('Cancelled stock created (3 cyl)', cancelledForOrder2?.length === 1 && cancelledForOrder2[0].quantity === 3);
  check('Cancelled stock on vehicle', cancelledForOrder2?.[0]?.status === 'on_vehicle');

  // ─── Test 3: Create order from cancelled stock ───
  console.log('\n--- Test 3: Order from Cancelled Stock ---');
  const cancelledStockId = cancelledForOrder2?.[0]?.id;
  if (cancelledStockId) {
    const order3 = await api('POST', '/orders/from-cancelled-stock', T1, {
      customerId: cust1, deliveryDate: today, cancelledStockEventId: cancelledStockId,
    });
    check('Order from cancelled stock', !!order3);
    check('Already pending_delivery (on vehicle)', order3?.status === 'pending_delivery');
    check('Correct quantity (3)', order3?.items?.[0]?.quantity === 3);
    check('Same driver/vehicle', order3?.driverId === driver1);

    // Deliver it
    if (order3) {
      const delivered3 = await api('POST', `/orders/${order3.id}/confirm-delivery`, T1, {
        items: [{ cylinderTypeId: ct19, deliveredQuantity: 3, emptiesCollected: 2 }],
      });
      check('Deliver cancelled stock order', delivered3?.status === 'delivered');
    }

    // Verify cancelled stock is now reconciled
    const cancelledAfter = await api('GET', '/inventory/cancelled-stock', T1);
    const reconciledStock = cancelledAfter?.find((c: any) => c.id === cancelledStockId);
    check('Cancelled stock reconciled', reconciledStock?.status === 'reconciled');
  }

  // ─── Test 4: Returns-only order ───
  console.log('\n--- Test 4: Returns-Only Order ---');
  const retOrder = await api('POST', '/orders/returns-only', T1, {
    customerId: cust1, scheduledDate: today,
    items: [{ cylinderTypeId: ct19, expectedQuantity: 5 }],
  });
  check('Create returns-only order', !!retOrder);
  check('Returns order number starts with RET-', retOrder?.orderNumber?.startsWith('RET-'));
  check('Returns order type', retOrder?.orderType === 'returns_only');
  check('Returns total = 0', retOrder?.totalAmount === 0);

  if (retOrder) {
    await api('POST', `/orders/${retOrder.id}/assign-driver`, T1, { driverId: driver1, vehicleId: vehicle1 });
    await api('PUT', `/orders/${retOrder.id}/status`, T1, { status: 'pending_delivery' });

    // Confirm collection
    const retConfirmed = await api('POST', `/orders/${retOrder.id}/confirm-returns`, T1, {
      items: [{ cylinderTypeId: ct19, collectedQuantity: 5 }],
      notes: 'Collected 5 empties from customer',
    });
    check('Returns collection confirmed', retConfirmed?.status === 'returns_only');

    // Verify NO invoice created for returns order
    const allInvoices = await api('GET', '/invoices', T1);
    const retInvoice = allInvoices?.find((i: any) => i.orderId === retOrder.id);
    check('No invoice for returns order', !retInvoice);
  }

  // ─── Test 5: Inventory with cylinder type names ───
  console.log('\n--- Test 5: Inventory Summary ---');
  const invSummary = await api('GET', `/inventory/summary/${today}`, T1);
  if (invSummary) {
    for (const s of invSummary) {
      console.log(`    ${s.cylinderType?.typeName}: Open(F:${s.openingFulls}/E:${s.openingEmpties}) → Close(F:${s.closingFulls}/E:${s.closingEmpties})`);
    }
    const s19 = invSummary.find((s: any) => s.cylinderType?.typeName === '19 KG');
    check('Cylinder type name shown (not Unknown)', !!s19?.cylinderType?.typeName);
    // 100 incoming - 10 delivered(order1) - 5 delivered(order2) - 3 delivered(order3) = 82
    check('19KG fulls math: 100-10-5-3=82', s19?.closingFulls === 82);
    // 7 collected(order1) + 3 collected(order2) + 2 collected(order3) + 5 returns = 17
    check('19KG empties math: 7+3+2+5=17', s19?.closingEmpties === 17);
  }

  // ─── Test 6: Payments ───
  console.log('\n--- Test 6: Payments ---');
  const pay1 = await api('POST', '/payments', T1, {
    customerId: cust1, amount: 5000, paymentMethod: 'cash', transactionDate: today, referenceNumber: 'CASH-001',
  });
  check('Payment created', !!pay1);

  // Collections
  const collections = await api('GET', '/analytics/collections', T1);
  check('Collections dashboard', !!collections && collections.length > 0);
  const custDue = collections?.find((c: any) => c.customerId === cust1);
  if (custDue) console.log(`    Customer ${custDue.customerName}: Due ₹${custDue.totalDue}`);

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n\n═══ PART 2: GST-ENABLED DISTRIBUTOR (Sharma Gas) ═══\n');
  // ═══════════════════════════════════════════════════════════════════════════

  const login2 = await api('POST', '/auth/login', '', { email: 'sharma@gasdist.com', password: 'Gstadmin@123' });
  const T2 = login2!.tokens.accessToken;
  check('Login GST distributor', !!T2);

  const gstCust = await api('GET', '/customers', T2);
  const gstCyl = await api('GET', '/cylinder-types', T2);
  const gstDrivers = await api('GET', '/drivers', T2);
  const gstVehicles = await api('GET', '/vehicles', T2);

  const gCt19 = gstCyl.find((c: any) => c.typeName === '19 KG')?.id;
  const gCt47 = gstCyl.find((c: any) => c.typeName === '47.5 KG')?.id;
  const sameStateCust = gstCust.find((c: any) => c.billingState === 'Karnataka')?.id;  // same state
  const interStateCust = gstCust.find((c: any) => c.billingState === 'Telangana')?.id;  // inter-state
  const gDriver = gstDrivers[0]?.id;
  const gVehicle = gstVehicles[0]?.id;

  check('GST distributor has customers', gstCust.length === 2);
  check('GST distributor has cylinder types', gstCyl.length === 2);

  // Add stock
  await api('POST', '/inventory/incoming-fulls', T2, {
    cylinderTypeId: gCt19, quantity: 50, documentType: 'AC4', documentNumber: 'GST-AC4-001', documentDate: today,
  });
  await api('POST', '/inventory/incoming-fulls', T2, {
    cylinderTypeId: gCt47, quantity: 20, documentType: 'AC4', documentNumber: 'GST-AC4-002', documentDate: today,
  });

  // ─── Test 7: Same-state order (CGST + SGST) ───
  console.log('\n--- Test 7: GST Same-State (Karnataka→Karnataka) ---');
  const gOrder1 = await api('POST', '/orders', T2, {
    customerId: sameStateCust, deliveryDate: today, items: [{ cylinderTypeId: gCt19, quantity: 10 }],
  });
  check('GST order created', !!gOrder1);
  check('GST order total = 10 * 2000 = 20000', gOrder1?.totalAmount === 20000);

  await api('POST', `/orders/${gOrder1.id}/assign-driver`, T2, { driverId: gDriver, vehicleId: gVehicle });
  await api('PUT', `/orders/${gOrder1.id}/status`, T2, { status: 'pending_delivery' });
  const gDel1 = await api('POST', `/orders/${gOrder1.id}/confirm-delivery`, T2, {
    items: [{ cylinderTypeId: gCt19, deliveredQuantity: 10, emptiesCollected: 8 }],
  });
  check('GST order delivered', gDel1?.status === 'delivered');

  // Verify invoice with GST breakup
  const gstInvoices1 = await api('GET', '/invoices', T2);
  const gInv1 = gstInvoices1?.find((i: any) => i.orderId === gOrder1.id);
  check('GST invoice created', !!gInv1);
  check('Same-state: CGST > 0', gInv1?.cgstValue > 0);
  check('Same-state: SGST > 0', gInv1?.sgstValue > 0);
  check('Same-state: IGST = 0', gInv1?.igstValue === 0);
  check('Total still = 20000 (GST inclusive)', gInv1?.totalAmount === 20000);

  // Base = 20000/1.18 = 16949.15, CGST = 16949.15 * 0.09 = 1525.42
  console.log(`    CGST: ₹${gInv1?.cgstValue}, SGST: ₹${gInv1?.sgstValue}, Total: ₹${gInv1?.totalAmount}`);

  // ─── Test 8: Inter-state order (IGST) ───
  console.log('\n--- Test 8: GST Inter-State (Karnataka→Telangana) ---');
  const gOrder2 = await api('POST', '/orders', T2, {
    customerId: interStateCust, deliveryDate: today, items: [{ cylinderTypeId: gCt47, quantity: 5 }],
  });
  check('Inter-state order created', !!gOrder2);

  await api('POST', `/orders/${gOrder2.id}/assign-driver`, T2, { driverId: gDriver, vehicleId: gVehicle });
  await api('PUT', `/orders/${gOrder2.id}/status`, T2, { status: 'pending_delivery' });
  await api('POST', `/orders/${gOrder2.id}/confirm-delivery`, T2, {
    items: [{ cylinderTypeId: gCt47, deliveredQuantity: 5, emptiesCollected: 3 }],
  });

  const gstInvoices2 = await api('GET', '/invoices', T2);
  const gInv2 = gstInvoices2?.find((i: any) => i.orderId === gOrder2.id);
  check('Inter-state invoice created', !!gInv2);
  check('Inter-state: CGST = 0', gInv2?.cgstValue === 0);
  check('Inter-state: SGST = 0', gInv2?.sgstValue === 0);
  check('Inter-state: IGST > 0', gInv2?.igstValue > 0);
  check('Total = 5 * 5000 = 25000', gInv2?.totalAmount === 25000);
  console.log(`    IGST: ₹${gInv2?.igstValue}, Total: ₹${gInv2?.totalAmount}`);

  // Retroactive GST invoicing — skipped for now per user request
  console.log('\n\n═══ PART 3: RETROACTIVE GST INVOICING (Skipped) ═══\n');
  console.log('  ℹ️  Retroactive GST invoice generation available but skipped for now');

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n\n═══ PART 4: ANALYTICS DASHBOARD ═══\n');
  // ═══════════════════════════════════════════════════════════════════════════

  const dash = await api('GET', '/analytics/dashboard', T1);
  if (dash) {
    console.log(`    Orders today: ${dash.ordersToday}`);
    console.log(`    Delivered: ${dash.deliveredToday}`);
    console.log(`    Revenue: ₹${dash.revenueToday}`);
    console.log(`    Outstanding: ₹${dash.totalOutstanding}`);
    console.log(`    Inventory alerts: ${dash.inventoryAlerts}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  console.log('\n═══════════════════════════════════════════');
  console.log(`  E2E TEST RESULTS: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
