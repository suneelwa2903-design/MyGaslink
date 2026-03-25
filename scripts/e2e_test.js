const BASE = 'http://localhost:5000/api';

async function api(method, path, body, token) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opts.headers.Authorization = 'Bearer ' + token;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(BASE + path, opts);
  const j = await r.json().catch(() => ({ success: false, error: 'Non-JSON response: ' + r.status }));
  return j;
}

async function login(email, password) {
  const r = await api('POST', '/auth/login', { email, password });
  if (!r.success) throw new Error('Login failed: ' + r.error);
  return r.data.tokens.accessToken;
}

async function test() {
  console.log('=== E2E GST WORKFLOW TESTS ===\n');

  // --- GST OFF: Bhargava Gas Agency ---
  console.log('--- ROUND 1: GST OFF (Bhargava Gas Agency) ---');
  const bhToken = await login('bhargava@gasagency.com', 'Distadmin@123');
  console.log('OK Login');

  const cust = await api('GET', '/customers', null, bhToken);
  const customers = cust.data.customers;
  console.log('OK Customers:', customers.length);
  const b2bCust = customers.find(c => c.customerType === 'B2B');
  const b2cCust = customers.find(c => c.customerType === 'B2C');
  console.log('  B2B:', b2bCust?.customerName, '| B2C:', b2cCust?.customerName);

  const ct = await api('GET', '/cylinder-types', null, bhToken);
  const types = ct.data?.cylinderTypes || ct.data;
  const typeArr = Array.isArray(types) ? types : [];
  const type19 = typeArr.find(t => t.typeName?.includes('19'));
  console.log('OK Cylinder types:', typeArr.length, '| 19KG id:', type19?.cylinderTypeId);

  // Create B2B order (GST OFF)
  const b2bOrder = await api('POST', '/orders', {
    customerId: b2bCust.customerId,
    deliveryDate: new Date().toISOString().split('T')[0],
    items: [{ cylinderTypeId: type19.cylinderTypeId, quantity: 5 }],
  }, bhToken);
  console.log('OK B2B Order (GST OFF):', b2bOrder.success ? b2bOrder.data?.orderNumber : 'FAIL: ' + b2bOrder.error);

  // Create B2C order (GST OFF)
  const b2cOrder = await api('POST', '/orders', {
    customerId: b2cCust.customerId,
    deliveryDate: new Date().toISOString().split('T')[0],
    items: [{ cylinderTypeId: type19.cylinderTypeId, quantity: 2 }],
  }, bhToken);
  console.log('OK B2C Order (GST OFF):', b2cOrder.success ? b2cOrder.data?.orderNumber : 'FAIL: ' + b2cOrder.error);

  // Get drivers & vehicles
  const drv = await api('GET', '/drivers', null, bhToken);
  const drivers = drv.data?.drivers || [];
  const driver = drivers[0];
  const veh = await api('GET', '/vehicles', null, bhToken);
  const vehicles = veh.data?.vehicles || [];
  const vehicle = vehicles[0];

  // Assign + deliver B2B order
  if (b2bOrder.data?.orderId) {
    await api('POST', '/orders/' + b2bOrder.data.orderId + '/assign-driver', {
      driverId: driver.driverId, vehicleId: vehicle.vehicleId
    }, bhToken);

    const deliver = await api('POST', '/orders/' + b2bOrder.data.orderId + '/confirm-delivery', {
      items: [{ cylinderTypeId: type19.cylinderTypeId, deliveredQuantity: 5, emptiesCollected: 3 }],
      notes: 'E2E test'
    }, bhToken);
    console.log('OK Delivery (B2B GST OFF):', deliver.success ? 'OK' : 'FAIL: ' + deliver.error);

    if (deliver.success && deliver.data?.invoice) {
      const inv = deliver.data.invoice;
      console.log('  Invoice:', inv.invoiceNumber, '| Amount:', inv.totalAmount, '| CGST:', inv.cgstValue, '| SGST:', inv.sgstValue);
      console.log('  IRN:', inv.irnStatus, '| EWB:', inv.ewbStatus);

      // PDF test
      const pdfRes = await fetch(BASE + '/invoices/' + inv.invoiceId + '/pdf', {
        headers: { Authorization: 'Bearer ' + bhToken }
      });
      console.log('OK Invoice PDF:', pdfRes.status === 200 ? 'OK (' + pdfRes.headers.get('content-type') + ')' : 'FAIL: ' + pdfRes.status);
    }
  }

  // --- GST ON: Sharma Gas Distributors ---
  console.log('\n--- ROUND 2: GST SANDBOX (Sharma Gas Distributors) ---');
  const shToken = await login('sharma@gasdist.com', 'Gstadmin@123');
  console.log('OK Login');

  const shCust = await api('GET', '/customers', null, shToken);
  const shCustomers = shCust.data.customers;
  const shB2B = shCustomers.find(c => c.customerType === 'B2B');
  const shB2C = shCustomers.find(c => c.customerType === 'B2C');
  console.log('OK Customers:', shCustomers.length, '| B2B:', shB2B?.customerName, '| B2C:', shB2C?.customerName);

  const shCt = await api('GET', '/cylinder-types', null, shToken);
  const shTypes = shCt.data?.cylinderTypes || shCt.data || [];
  const sh19 = (Array.isArray(shTypes) ? shTypes : []).find(t => t.typeName?.includes('19'));

  const shDrv = await api('GET', '/drivers', null, shToken);
  const shDriver = (shDrv.data?.drivers || [])[0];
  const shVeh = await api('GET', '/vehicles', null, shToken);
  const shVehicle = (shVeh.data?.vehicles || [])[0];

  // B2B order (GST ON)
  if (shB2B && sh19) {
    const gstOrder = await api('POST', '/orders', {
      customerId: shB2B.customerId,
      deliveryDate: new Date().toISOString().split('T')[0],
      items: [{ cylinderTypeId: sh19.cylinderTypeId, quantity: 10 }],
    }, shToken);
    console.log('OK B2B Order (GST ON):', gstOrder.success ? gstOrder.data?.orderNumber : 'FAIL: ' + gstOrder.error);

    if (gstOrder.data?.orderId) {
      await api('POST', '/orders/' + gstOrder.data.orderId + '/assign-driver', {
        driverId: shDriver.driverId, vehicleId: shVehicle.vehicleId
      }, shToken);

      const gstDeliver = await api('POST', '/orders/' + gstOrder.data.orderId + '/confirm-delivery', {
        items: [{ cylinderTypeId: sh19.cylinderTypeId, deliveredQuantity: 10, emptiesCollected: 8 }],
      }, shToken);
      console.log('OK Delivery (B2B GST ON):', gstDeliver.success ? 'OK' : 'FAIL: ' + gstDeliver.error);

      if (gstDeliver.data?.invoice) {
        const gInv = gstDeliver.data.invoice;
        console.log('  Invoice:', gInv.invoiceNumber, '| Amount:', gInv.totalAmount);
        console.log('  CGST:', gInv.cgstValue, '| SGST:', gInv.sgstValue, '| IGST:', gInv.igstValue);
        console.log('  IRN:', gInv.irnStatus, '| EWB:', gInv.ewbStatus);
      }
    }
  }

  // B2C order (GST ON)
  if (shB2C && sh19) {
    const b2cGstOrder = await api('POST', '/orders', {
      customerId: shB2C.customerId,
      deliveryDate: new Date().toISOString().split('T')[0],
      items: [{ cylinderTypeId: sh19.cylinderTypeId, quantity: 3 }],
    }, shToken);
    console.log('OK B2C Order (GST ON):', b2cGstOrder.success ? b2cGstOrder.data?.orderNumber : 'FAIL: ' + b2cGstOrder.error);

    if (b2cGstOrder.data?.orderId) {
      await api('POST', '/orders/' + b2cGstOrder.data.orderId + '/assign-driver', {
        driverId: shDriver.driverId, vehicleId: shVehicle.vehicleId
      }, shToken);

      const b2cDeliver = await api('POST', '/orders/' + b2cGstOrder.data.orderId + '/confirm-delivery', {
        items: [{ cylinderTypeId: sh19.cylinderTypeId, deliveredQuantity: 3, emptiesCollected: 2 }],
      }, shToken);
      console.log('OK Delivery (B2C GST ON):', b2cDeliver.success ? 'OK' : 'FAIL: ' + b2cDeliver.error);

      if (b2cDeliver.data?.invoice) {
        const b2cInv = b2cDeliver.data.invoice;
        console.log('  Invoice:', b2cInv.invoiceNumber, '| CGST:', b2cInv.cgstValue, '| SGST:', b2cInv.sgstValue);
        console.log('  IRN:', b2cInv.irnStatus, '(B2C = no IRN expected)');
      }
    }
  }

  // --- Ledger ---
  console.log('\n--- ROUND 3: CUSTOMER LEDGER ---');
  const ledger = await api('GET', '/payments/ledger/' + b2bCust.customerId, null, bhToken);
  console.log('OK Ledger entries:', Array.isArray(ledger.data) ? ledger.data.length : 'FAIL: ' + ledger.error);

  // --- Returns Order ---
  console.log('\n--- ROUND 4: RETURNS ORDER ---');
  const retOrder = await api('POST', '/orders/returns-only', {
    customerId: b2bCust.customerId,
    scheduledDate: new Date().toISOString().split('T')[0],
    items: [{ cylinderTypeId: type19.cylinderTypeId, expectedQuantity: 5 }],
  }, bhToken);
  console.log('OK Returns:', retOrder.success ? retOrder.data?.orderNumber : 'FAIL: ' + retOrder.error);

  // --- Payment ---
  console.log('\n--- ROUND 5: PAYMENT ---');
  const payment = await api('POST', '/payments', {
    customerId: b2bCust.customerId,
    amount: 5000,
    paymentMethod: 'upi',
    referenceNumber: 'UPI-E2E-001',
    transactionDate: new Date().toISOString().split('T')[0],
  }, bhToken);
  console.log('OK Payment:', payment.success ? 'Rs.' + payment.data?.amount : 'FAIL: ' + payment.error);

  // --- Swagger ---
  console.log('\n--- ROUND 6: SWAGGER ---');
  const adminToken = await login('admin@mygaslink.com', 'Admin@123');
  const swaggerOk = await fetch(BASE + '/docs/?token=' + adminToken);
  console.log('OK Swagger (super_admin):', swaggerOk.status);
  const swaggerDeny = await fetch(BASE + '/docs/?token=' + bhToken);
  console.log('OK Swagger (dist_admin blocked):', swaggerDeny.status);

  console.log('\n=== ALL E2E TESTS COMPLETE ===');
}

test().catch(e => console.error('FATAL:', e.message));
