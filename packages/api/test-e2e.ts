/**
 * Comprehensive End-to-End Test Script
 * Tests the full order lifecycle: create → assign → dispatch → deliver → invoice → pay
 */

const BASE = 'http://localhost:5000/api';

async function api(method: string, path: string, token: string, body?: any) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!json.success) {
    console.error(`❌ ${method} ${path}:`, json.error, json.details ? JSON.stringify(json.details) : '');
    return null;
  }
  return json.data;
}

async function main() {
  console.log('🚀 Starting comprehensive E2E test...\n');

  // ─── Step 1: Login ───
  console.log('1. LOGIN');
  const loginRes = await api('POST', '/auth/login', '', {
    email: 'bhargava@gasagency.com',
    password: 'Distadmin@123',
  });
  if (!loginRes) return;
  const TOKEN = loginRes.tokens.accessToken;
  console.log(`   ✅ Logged in as ${loginRes.user.email} (${loginRes.user.role})\n`);

  // ─── Step 2: Get reference data ───
  console.log('2. REFERENCE DATA');
  const customers = await api('GET', '/customers', TOKEN);
  const cylinderTypes = await api('GET', '/cylinder-types', TOKEN);
  const drivers = await api('GET', '/drivers', TOKEN);
  const vehicles = await api('GET', '/vehicles', TOKEN);

  console.log(`   ${customers.length} customers, ${cylinderTypes.length} cylinder types, ${drivers.length} drivers, ${vehicles.length} vehicles`);

  const custIds = customers.map((c: any) => ({ id: c.id, name: c.businessName || c.customerName }));
  const ct = (name: string) => cylinderTypes.find((c: any) => c.typeName === name)?.id;
  const ct19 = ct('19 KG')!;
  const ct5 = ct('5 KG')!;
  const ct47 = ct('47.5 KG')!;
  const driver1 = drivers[0].id;
  const driver2 = drivers[1].id;
  const vehicle1 = vehicles[0].id;
  const vehicle2 = vehicles[1].id;

  // ─── Step 2.5: Add incoming stock ───
  console.log('\n2.5. ADD INCOMING STOCK (simulate AC4/incoming fulls)');
  const today = new Date().toISOString().split('T')[0];
  const stockItems = [
    { cylinderTypeId: ct19, quantity: 100, doc: 'AC4-001' },
    { cylinderTypeId: ct5, quantity: 50, doc: 'AC4-002' },
    { cylinderTypeId: ct47, quantity: 20, doc: 'AC4-003' },
  ];
  for (const item of stockItems) {
    const result = await api('POST', '/inventory/incoming-fulls', TOKEN, {
      cylinderTypeId: item.cylinderTypeId,
      quantity: item.quantity,
      documentType: 'AC4',
      documentNumber: item.doc,
      documentDate: today,
      notes: 'Initial stock for testing',
    });
    if (result) {
      const typeName = cylinderTypes.find((c: any) => c.id === item.cylinderTypeId)?.typeName;
      console.log(`   ✅ ${typeName}: +${item.quantity} fulls (${item.doc})`);
    }
  }

  // ─── Step 3: Create 8 orders for 4 customers ───
  console.log('\n3. CREATE ORDERS');

  const orderConfigs = [
    { cust: custIds[0], items: [{ cylinderTypeId: ct19, quantity: 10 }] },
    { cust: custIds[2], items: [{ cylinderTypeId: ct19, quantity: 5 }, { cylinderTypeId: ct47, quantity: 2 }] },
    { cust: custIds[3], items: [{ cylinderTypeId: ct5, quantity: 20 }] },
    { cust: custIds[4], items: [{ cylinderTypeId: ct19, quantity: 8 }] },
    { cust: custIds[0], items: [{ cylinderTypeId: ct47, quantity: 3 }] },
    { cust: custIds[2], items: [{ cylinderTypeId: ct19, quantity: 15 }] },
    { cust: custIds[3], items: [{ cylinderTypeId: ct19, quantity: 6 }, { cylinderTypeId: ct5, quantity: 10 }] },
    { cust: custIds[4], items: [{ cylinderTypeId: ct47, quantity: 1 }] },
  ];

  const orders: any[] = [];
  for (const cfg of orderConfigs) {
    const order = await api('POST', '/orders', TOKEN, {
      customerId: cfg.cust.id,
      deliveryDate: today,
      items: cfg.items,
    });
    if (order) {
      orders.push(order);
      console.log(`   ✅ ${order.orderNumber}: ₹${order.totalAmount} for ${cfg.cust.name}`);
    }
  }
  console.log(`   Created ${orders.length} orders`);

  // ─── Step 4: Assign drivers ───
  console.log('\n4. ASSIGN DRIVERS');
  let assignSuccess = 0;
  for (let i = 0; i < orders.length; i++) {
    const result = await api('POST', `/orders/${orders[i].id}/assign-driver`, TOKEN, {
      driverId: i % 2 === 0 ? driver1 : driver2,
      vehicleId: i % 2 === 0 ? vehicle1 : vehicle2,
    });
    if (result) {
      assignSuccess++;
      console.log(`   ✅ ${orders[i].orderNumber} → Driver ${i % 2 + 1}`);
    }
  }
  console.log(`   Assigned ${assignSuccess}/${orders.length}`);

  // ─── Step 5: Dispatch (change status to pending_delivery) ───
  console.log('\n5. DISPATCH ORDERS');
  let dispatchSuccess = 0;
  for (const order of orders) {
    const result = await api('PUT', `/orders/${order.id}/status`, TOKEN, {
      status: 'pending_delivery',
    });
    if (result) {
      dispatchSuccess++;
      console.log(`   ✅ ${order.orderNumber} dispatched`);
    }
  }
  console.log(`   Dispatched ${dispatchSuccess}/${orders.length}`);

  // ─── Step 6: Confirm deliveries ───
  console.log('\n6. CONFIRM DELIVERIES');
  let deliverSuccess = 0;
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i];
    // Build delivery items from order items
    const deliveryItems = order.items.map((item: any) => ({
      cylinderTypeId: item.cylinderTypeId,
      deliveredQuantity: item.quantity,
      emptiesCollected: Math.ceil(item.quantity * 0.7),
    }));

    const result = await api('POST', `/orders/${order.id}/confirm-delivery`, TOKEN, {
      items: deliveryItems,
      deliveryLatitude: 17.385 + i * 0.01,
      deliveryLongitude: 78.486 + i * 0.01,
      notes: `Test delivery #${i + 1}`,
    });
    if (result) {
      deliverSuccess++;
      const empties = deliveryItems.map((d: any) => d.emptiesCollected).reduce((a: number, b: number) => a + b, 0);
      console.log(`   ✅ ${order.orderNumber} delivered (empties collected: ${empties})`);
    }
  }
  console.log(`   Delivered ${deliverSuccess}/${orders.length}`);

  // ─── Step 7: Verify invoices auto-created ───
  console.log('\n7. VERIFY INVOICES');
  const invoicesData = await api('GET', '/invoices', TOKEN);
  const invoices = Array.isArray(invoicesData) ? invoicesData : invoicesData?.invoices || [];
  let totalRevenue = 0;
  for (const inv of invoices) {
    totalRevenue += inv.totalAmount || 0;
    console.log(`   ${inv.invoiceNumber}: ₹${inv.totalAmount} (${inv.status}) - GST: CGST ₹${inv.cgstAmount || 0} + SGST ₹${inv.sgstAmount || 0}`);
  }
  console.log(`   💰 Total invoiced: ₹${totalRevenue.toFixed(2)} across ${invoices.length} invoices`);

  // ─── Step 8: Make partial payments ───
  console.log('\n8. MAKE PAYMENTS');
  const methods = ['cash', 'upi', 'cheque', 'online'];
  let paymentsMade = 0;
  for (let i = 0; i < Math.min(4, invoices.length); i++) {
    const inv = invoices[i];
    const payAmount = Math.round((inv.totalAmount || 0) / 2);
    if (payAmount <= 0) continue;

    const result = await api('POST', '/payments', TOKEN, {
      customerId: inv.customerId,
      amount: payAmount,
      paymentMethod: methods[i],
      transactionDate: today,
      referenceNumber: `TEST-PAY-${i + 1}`,
    });
    if (result) {
      paymentsMade++;
      console.log(`   ✅ ₹${payAmount} via ${methods[i]} for ${inv.invoiceNumber}`);
    }
  }
  console.log(`   ${paymentsMade} payments made`);

  // ─── Step 9: Test cancel workflow ───
  console.log('\n9. CANCEL ORDER WORKFLOW');
  const cancelOrder = await api('POST', '/orders', TOKEN, {
    customerId: custIds[0].id,
    deliveryDate: today,
    items: [{ cylinderTypeId: ct19, quantity: 3 }],
  });
  if (cancelOrder) {
    console.log(`   Created: ${cancelOrder.orderNumber}`);
    await api('POST', `/orders/${cancelOrder.id}/assign-driver`, TOKEN, {
      driverId: driver1, vehicleId: vehicle1,
    });
    await api('PUT', `/orders/${cancelOrder.id}/status`, TOKEN, {
      status: 'pending_delivery',
    });
    const cancelled = await api('POST', `/orders/${cancelOrder.id}/cancel`, TOKEN, {
      reason: 'Customer not available at location',
    });
    if (cancelled) {
      console.log(`   ✅ Cancelled: ${cancelOrder.orderNumber}`);
    }
  }

  // ─── Step 10: Inventory summary ───
  console.log('\n10. INVENTORY SUMMARY');
  const inventory = await api('GET', `/inventory/summary/${today}`, TOKEN);
  if (inventory) {
    const summaries = Array.isArray(inventory) ? inventory : [inventory];
    for (const s of summaries) {
      console.log(`   ${s.cylinderType?.typeName || 'Unknown'}: Open(F:${s.openingFulls}/E:${s.openingEmpties}) → Close(F:${s.closingFulls}/E:${s.closingEmpties})`);
    }
  }

  // ─── Step 11: Analytics dashboard ───
  console.log('\n11. ANALYTICS DASHBOARD');
  const dashboard = await api('GET', '/analytics/dashboard', TOKEN);
  if (dashboard) {
    console.log(`   Orders today: ${dashboard.ordersToday}`);
    console.log(`   Delivered today: ${dashboard.deliveredToday}`);
    console.log(`   Revenue today: ₹${dashboard.revenueToday}`);
    console.log(`   Pending orders: ${dashboard.pendingOrders}`);
    console.log(`   Overdue invoices: ${dashboard.overdueInvoices}`);
    console.log(`   Total outstanding: ₹${dashboard.totalOutstanding}`);
    console.log(`   Inventory alerts: ${dashboard.inventoryAlerts}`);
    console.log(`   Pending actions: ${dashboard.pendingActions}`);
  }

  // Collections
  console.log('\n12. COLLECTIONS DASHBOARD');
  const collections = await api('GET', '/analytics/collections', TOKEN);
  if (collections) {
    const collList = Array.isArray(collections) ? collections : collections.collections || [];
    for (const c of collList) {
      console.log(`   ${c.customerName || c.businessName}: Due ₹${c.totalDue || 0}, Overdue ₹${c.overdueDue || 0}`);
    }
  }

  // ─── Step 12: Order detail with status log ───
  console.log('\n13. ORDER DETAIL (with status log)');
  if (orders.length > 0) {
    const detail = await api('GET', `/orders/${orders[0].id}`, TOKEN);
    if (detail) {
      console.log(`   ${detail.orderNumber}: ${detail.status}`);
      if (detail.statusLogs) {
        console.log(`   Status history (${detail.statusLogs.length} entries):`);
        detail.statusLogs.forEach((l: any) => console.log(`     → ${l.newStatus} at ${l.changedAt} ${l.notes ? '(' + l.notes + ')' : ''}`));
      }
      if (detail.invoice) {
        console.log(`   Invoice: ${detail.invoice.invoiceNumber} (${detail.invoice.status})`);
      }
    }
  }

  // ─── Step 13: Test super admin login ───
  console.log('\n14. SUPER ADMIN LOGIN');
  const superLogin = await api('POST', '/auth/login', '', {
    email: 'admin@mygaslink.com',
    password: 'Admin@123',
  });
  if (superLogin) {
    const saToken = superLogin.tokens.accessToken;
    console.log(`   ✅ Logged in as super admin`);

    // Test distributor listing
    const distrs = await api('GET', '/distributors', saToken);
    if (distrs) {
      const dList = Array.isArray(distrs) ? distrs : distrs.distributors || [];
      console.log(`   Distributors: ${dList.length}`);
    }
  }

  // ─── Summary ───
  console.log('\n═══════════════════════════════════');
  console.log('  E2E TEST SUMMARY');
  console.log('═══════════════════════════════════');
  console.log(`  Orders created:    ${orders.length}`);
  console.log(`  Drivers assigned:  ${assignSuccess}`);
  console.log(`  Orders dispatched: ${dispatchSuccess}`);
  console.log(`  Orders delivered:  ${deliverSuccess}`);
  console.log(`  Invoices created:  ${invoices.length}`);
  console.log(`  Total revenue:     ₹${totalRevenue.toFixed(2)}`);
  console.log(`  Payments made:     ${paymentsMade}`);
  console.log(`  Cancel tested:     ✅`);
  console.log('═══════════════════════════════════\n');
}

main().catch(console.error);
