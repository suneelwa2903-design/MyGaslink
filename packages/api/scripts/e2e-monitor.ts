import { writeFileSync } from 'node:fs';

/**
 * E2E Production Monitor
 *
 * Runs critical workflow tests against the API and outputs a JSON summary.
 * Designed to be executed from CI (GitHub Actions) with a seeded database.
 *
 * Tests cover:
 *   - Health check + DB connectivity
 *   - Auth flow (login, token refresh)
 *   - CRUD for customers, orders, drivers, vehicles, cylinder types
 *   - Full order lifecycle: create -> assign driver -> confirm delivery
 *   - Invoice + payment flow
 *   - Response time assertions (< 2s per endpoint)
 *
 * Environment variables:
 *   BASE_URL               API root (default http://localhost:5000/api)
 *   PROD_ADMIN_EMAIL       Login email
 *   PROD_ADMIN_PASSWORD    Login password
 *
 * Exit codes:
 *   0 – all tests passed
 *   1 – one or more tests failed
 *   2 – script crashed
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');
const EMAIL    = process.env.PROD_ADMIN_EMAIL    || '';
const PASSWORD = process.env.PROD_ADMIN_PASSWORD || '';
const RESPONSE_TIME_LIMIT = 2000; // 2s

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  group: string;
  status: 'pass' | 'fail' | 'skip';
  durationMs: number;
  error?: string;
}

interface TestSummary {
  runAt: string;
  baseUrl: string;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  totalDurationMs: number;
  results: TestResult[];
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  expectBinary = false,
): Promise<{ status: number; data: any; durationMs: number }> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const start = Date.now();
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const durationMs = Date.now() - start;

  let data: any;
  if (expectBinary) {
    data = { contentType: res.headers.get('content-type'), size: res.headers.get('content-length') };
  } else {
    try {
      data = await res.json();
    } catch {
      data = { raw: await res.text().catch(() => '') };
    }
  }
  return { status: res.status, data, durationMs };
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

const results: TestResult[] = [];

async function test(group: string, name: string, fn: () => Promise<void>): Promise<void> {
  const start = Date.now();
  try {
    await fn();
    results.push({ name, group, status: 'pass', durationMs: Date.now() - start });
  } catch (err: any) {
    results.push({
      name,
      group,
      status: 'fail',
      durationMs: Date.now() - start,
      error: err?.message || String(err),
    });
  }
}

function skip(group: string, name: string, reason: string): void {
  results.push({ name, group, status: 'skip', durationMs: 0, error: reason });
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function assertResponseTime(durationMs: number, label: string): void {
  assert(durationMs < RESPONSE_TIME_LIMIT, `${label} took ${durationMs}ms (limit: ${RESPONSE_TIME_LIMIT}ms)`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function run(): Promise<TestSummary> {
  const runStart = Date.now();

  // ── 1. Health check ──────────────────────────────────────────────────────

  await test('health', 'API responds with 200', async () => {
    const { status, data, durationMs } = await api('GET', '/health');
    assert(status === 200, `Expected 200, got ${status}`);
    assert(data?.data?.status === 'healthy', 'Health status not healthy');
    assertResponseTime(durationMs, 'Health');
  });

  await test('health', 'Database is connected', async () => {
    const { data } = await api('GET', '/health');
    assert(data?.data?.database?.status === 'connected', 'DB not connected');
  });

  await test('health', 'DB latency under 500ms', async () => {
    const { data } = await api('GET', '/health');
    const latency = data?.data?.database?.latencyMs ?? 9999;
    assert(latency < 500, `DB latency ${latency}ms exceeds 500ms threshold`);
  });

  // ── 2. Authentication ───────────────────────────────────────────────────

  let accessToken = '';
  let refreshToken = '';

  if (!EMAIL || !PASSWORD) {
    skip('auth', 'Login', 'PROD_ADMIN_EMAIL / PROD_ADMIN_PASSWORD not set');
    skip('auth', 'Token refresh', 'No credentials');
  } else {
    await test('auth', 'Login with admin credentials', async () => {
      const { status, data, durationMs } = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
      assert(status === 200, `Login failed: ${status} — ${JSON.stringify(data?.error)}`);
      accessToken = data?.data?.tokens?.accessToken || data?.data?.accessToken;
      refreshToken = data?.data?.tokens?.refreshToken || data?.data?.refreshToken;
      assert(!!accessToken, 'No access token returned');
      assertResponseTime(durationMs, 'Login');
    });

    await test('auth', 'Token refresh', async () => {
      assert(!!refreshToken, 'No refresh token from login');
      const { status, data, durationMs } = await api('POST', '/auth/refresh', { refreshToken });
      assert(status === 200, `Refresh failed: ${status}`);
      if (data?.data?.tokens?.accessToken) accessToken = data.data.tokens.accessToken;
      else if (data?.data?.accessToken) accessToken = data.data.accessToken;
      if (data?.data?.tokens?.refreshToken) refreshToken = data.data.tokens.refreshToken;
      else if (data?.data?.refreshToken) refreshToken = data.data.refreshToken;
      assertResponseTime(durationMs, 'Token refresh');
    });
  }

  // Gate: remaining tests require authentication
  if (!accessToken) {
    const gated = [
      'List customers', 'Create customer', 'Update customer',
      'List cylinder types', 'List drivers', 'Create driver', 'Delete driver',
      'List vehicles', 'Create vehicle', 'Delete vehicle',
      'List orders', 'Create order', 'Assign driver to order', 'Confirm delivery',
      'List invoices', 'Generate invoice from order', 'Invoice PDF download',
      'Record payment', 'Customer ledger',
    ];
    for (const t of gated) skip('workflow', t, 'Skipped – no auth token');
    return buildSummary(runStart);
  }

  // ── 3. Customers CRUD ────────────────────────────────────────────────────

  let customerId = '';

  await test('customers', 'List customers', async () => {
    const { status, data, durationMs } = await api('GET', '/customers?page=1&pageSize=5', undefined, accessToken);
    assert(status === 200, `List customers failed: ${status}`);
    const customers = data?.data?.customers || [];
    assert(Array.isArray(customers), 'Not an array');
    if (customers.length > 0) {
      customerId = customers[0].customerId || customers[0].id;
    }
    assertResponseTime(durationMs, 'List customers');
  });

  let createdCustomerId = '';

  await test('customers', 'Create customer', async () => {
    const { status, data, durationMs } = await api('POST', '/customers', {
      customerName: 'E2E Test Customer',
      phone: '9999900000',
      customerType: 'B2C',
      billingState: 'Telangana',
    }, accessToken);
    assert(status === 201 || status === 200, `Create customer failed: ${status} — ${JSON.stringify(data?.error)}`);
    createdCustomerId = data?.data?.customerId || data?.data?.id || '';
    assert(!!createdCustomerId, 'No customer ID returned');
    assertResponseTime(durationMs, 'Create customer');
  });

  if (createdCustomerId) {
    await test('customers', 'Update customer', async () => {
      const { status, durationMs } = await api('PUT', `/customers/${createdCustomerId}`, {
        customerName: 'E2E Test Customer Updated',
      }, accessToken);
      assert(status === 200, `Update customer failed: ${status}`);
      assertResponseTime(durationMs, 'Update customer');
    });
  } else {
    skip('customers', 'Update customer', 'No customer to update');
  }

  // ── 4. Cylinder types ─────────────────────────────────────────────────────

  let cylinderTypeId = '';

  await test('entities', 'List cylinder types', async () => {
    const { status, data, durationMs } = await api('GET', '/cylinder-types', undefined, accessToken);
    assert(status === 200, `Cylinder types failed: ${status}`);
    const types = data?.data?.cylinderTypes || [];
    assert(Array.isArray(types) && types.length > 0, 'No cylinder types found');
    cylinderTypeId = types[0].cylinderTypeId || types[0].id;
    assertResponseTime(durationMs, 'List cylinder types');
  });

  // ── 5. Drivers CRUD ───────────────────────────────────────────────────────

  let driverId = '';
  let createdDriverId = '';

  await test('entities', 'List drivers', async () => {
    const { status, data, durationMs } = await api('GET', '/drivers', undefined, accessToken);
    assert(status === 200, `List drivers failed: ${status}`);
    const drivers = data?.data?.drivers || [];
    assert(Array.isArray(drivers), 'Not an array');
    if (drivers.length > 0) {
      driverId = drivers[0].driverId || drivers[0].id;
    }
    assertResponseTime(durationMs, 'List drivers');
  });

  await test('entities', 'Create driver', async () => {
    const { status, data, durationMs } = await api('POST', '/drivers', {
      driverName: 'E2E Test Driver',
      phone: '9999911111',
    }, accessToken);
    assert(status === 201 || status === 200, `Create driver failed: ${status} — ${JSON.stringify(data?.error)}`);
    createdDriverId = data?.data?.driverId || data?.data?.id || '';
    assert(!!createdDriverId, 'No driver ID returned');
    assertResponseTime(durationMs, 'Create driver');
  });

  // ── 6. Vehicles CRUD ──────────────────────────────────────────────────────

  let vehicleId = '';
  let createdVehicleId = '';

  await test('entities', 'List vehicles', async () => {
    const { status, data, durationMs } = await api('GET', '/vehicles', undefined, accessToken);
    assert(status === 200, `List vehicles failed: ${status}`);
    const vehicles = data?.data?.vehicles || [];
    assert(Array.isArray(vehicles), 'Not an array');
    if (vehicles.length > 0) {
      vehicleId = vehicles[0].vehicleId || vehicles[0].id;
    }
    assertResponseTime(durationMs, 'List vehicles');
  });

  await test('entities', 'Create vehicle', async () => {
    const { status, data, durationMs } = await api('POST', '/vehicles', {
      vehicleNumber: 'E2E-TS99-ZZ-0001',
      vehicleType: 'Tempo',
      capacity: 40,
    }, accessToken);
    assert(status === 201 || status === 200, `Create vehicle failed: ${status} — ${JSON.stringify(data?.error)}`);
    createdVehicleId = data?.data?.vehicleId || data?.data?.id || '';
    assert(!!createdVehicleId, 'No vehicle ID returned');
    assertResponseTime(durationMs, 'Create vehicle');
  });

  // ── 7. Orders – full lifecycle ────────────────────────────────────────────

  const orderCustomerId = customerId || createdCustomerId;
  const orderDriverId = driverId || createdDriverId;
  const orderVehicleId = vehicleId || createdVehicleId;
  let orderId = '';

  await test('orders', 'List orders', async () => {
    const { status, durationMs } = await api('GET', '/orders?page=1&pageSize=5', undefined, accessToken);
    assert(status === 200, `List orders failed: ${status}`);
    assertResponseTime(durationMs, 'List orders');
  });

  if (orderCustomerId && cylinderTypeId) {
    const today = new Date().toISOString().split('T')[0];

    await test('orders', 'Create order', async () => {
      const { status, data, durationMs } = await api('POST', '/orders', {
        customerId: orderCustomerId,
        deliveryDate: today,
        items: [{ cylinderTypeId, quantity: 2 }],
      }, accessToken);
      assert(status === 201 || status === 200, `Create order failed: ${status} — ${JSON.stringify(data?.error)}`);
      orderId = data?.data?.orderId || data?.data?.id || '';
      assert(!!orderId, 'No order ID returned');
      assertResponseTime(durationMs, 'Create order');
    });

    if (orderId && orderDriverId) {
      await test('orders', 'Assign driver to order', async () => {
        const { status, data, durationMs } = await api('POST', `/orders/${orderId}/assign-driver`, {
          driverId: orderDriverId,
          vehicleId: orderVehicleId || undefined,
        }, accessToken);
        assert(status === 200, `Assign driver failed: ${status} — ${JSON.stringify(data?.error)}`);
        assertResponseTime(durationMs, 'Assign driver');
      });

      await test('orders', 'Confirm delivery', async () => {
        const { status, data, durationMs } = await api('POST', `/orders/${orderId}/confirm-delivery`, {
          items: [{ cylinderTypeId, deliveredQuantity: 2, emptiesCollected: 1 }],
          notes: 'E2E monitor test delivery',
        }, accessToken);
        assert(status === 200, `Confirm delivery failed: ${status} — ${JSON.stringify(data?.error)}`);
        const orderStatus = data?.data?.status;
        assert(orderStatus === 'delivered', `Expected delivered, got ${orderStatus}`);
        assertResponseTime(durationMs, 'Confirm delivery');
      });
    } else {
      if (!orderId) skip('orders', 'Assign driver to order', 'No order created');
      if (!orderDriverId) skip('orders', 'Assign driver to order', 'No driver available');
      skip('orders', 'Confirm delivery', 'Cannot proceed without assigned order');
    }
  } else {
    skip('orders', 'Create order', `Missing customer(${!!orderCustomerId}) or cylinderType(${!!cylinderTypeId})`);
    skip('orders', 'Assign driver to order', 'No order created');
    skip('orders', 'Confirm delivery', 'No order created');
  }

  // ── 8. Invoices + Payment flow ────────────────────────────────────────────

  let invoiceId = '';

  if (orderId) {
    await test('invoices', 'Generate invoice from order', async () => {
      const { status, data, durationMs } = await api('POST', `/invoices/from-order/${orderId}`, undefined, accessToken);
      assert(status === 201 || status === 200, `Invoice creation failed: ${status} — ${JSON.stringify(data?.error)}`);
      invoiceId = data?.data?.invoiceId || data?.data?.id || '';
      assert(!!invoiceId, 'No invoice ID returned');
      assertResponseTime(durationMs, 'Generate invoice');
    });
  }

  await test('invoices', 'List invoices', async () => {
    const { status, data, durationMs } = await api('GET', '/invoices?page=1&pageSize=5', undefined, accessToken);
    assert(status === 200, `List invoices failed: ${status}`);
    if (!invoiceId) {
      const invoices = data?.data?.invoices || [];
      if (Array.isArray(invoices) && invoices.length > 0) {
        invoiceId = invoices[0].invoiceId || invoices[0].id;
      }
    }
    assertResponseTime(durationMs, 'List invoices');
  });

  if (invoiceId) {
    await test('invoices', 'Invoice PDF download', async () => {
      const { status, data, durationMs } = await api('GET', `/invoices/${invoiceId}/pdf`, undefined, accessToken, true);
      assert(status === 200, `PDF download failed: ${status}`);
      const ct = (data?.contentType || '').toLowerCase();
      assert(ct.includes('pdf'), `Expected PDF content-type, got ${ct}`);
      assertResponseTime(durationMs, 'Invoice PDF');
    });
  } else {
    skip('invoices', 'Invoice PDF download', 'No invoice to download');
  }

  // Payment
  if (invoiceId && orderCustomerId) {
    const today = new Date().toISOString().split('T')[0];
    await test('payments', 'Record payment', async () => {
      const { status, data, durationMs } = await api('POST', '/payments', {
        customerId: orderCustomerId,
        amount: 100,
        paymentMethod: 'cash',
        transactionDate: today,
        allocations: [{ invoiceId, amount: 100 }],
      }, accessToken);
      assert(status === 201 || status === 200, `Payment failed: ${status} — ${JSON.stringify(data?.error)}`);
      assertResponseTime(durationMs, 'Record payment');
    });
  } else {
    skip('payments', 'Record payment', 'No invoice or customer');
  }

  // Customer ledger
  if (orderCustomerId) {
    await test('payments', 'Customer ledger', async () => {
      const { status, data, durationMs } = await api('GET', `/payments/ledger/${orderCustomerId}`, undefined, accessToken);
      assert(status === 200, `Ledger failed: ${status}`);
      assert(data?.data?.summary !== undefined || data?.data?.balance !== undefined, 'No balance data');
      assertResponseTime(durationMs, 'Customer ledger');
    });
  } else {
    skip('payments', 'Customer ledger', 'No customer');
  }

  // ── 9. Additional endpoints ───────────────────────────────────────────────

  await test('endpoints', 'Analytics responds', async () => {
    const { status, durationMs } = await api('GET', '/analytics/dashboard', undefined, accessToken);
    assert(status < 500, `Analytics server error: ${status}`);
    assertResponseTime(durationMs, 'Analytics');
  });

  await test('endpoints', 'Inventory responds', async () => {
    const { status, durationMs } = await api('GET', '/inventory', undefined, accessToken);
    assert(status < 500, `Inventory server error: ${status}`);
    assertResponseTime(durationMs, 'Inventory');
  });

  await test('endpoints', 'Settings responds', async () => {
    const { status, durationMs } = await api('GET', '/settings', undefined, accessToken);
    assert(status < 500, `Settings server error: ${status}`);
    assertResponseTime(durationMs, 'Settings');
  });

  // ── 10. Cleanup test data ─────────────────────────────────────────────────

  if (createdDriverId) {
    await test('cleanup', 'Delete test driver', async () => {
      const { status } = await api('DELETE', `/drivers/${createdDriverId}`, undefined, accessToken);
      assert(status === 200 || status === 204 || status === 404, `Delete driver failed: ${status}`);
    });
  }

  if (createdVehicleId) {
    await test('cleanup', 'Delete test vehicle', async () => {
      const { status } = await api('DELETE', `/vehicles/${createdVehicleId}`, undefined, accessToken);
      assert(status === 200 || status === 204 || status === 404, `Delete vehicle failed: ${status}`);
    });
  }

  return buildSummary(runStart);
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

function buildSummary(runStart: number): TestSummary {
  const passed  = results.filter(r => r.status === 'pass').length;
  const failed  = results.filter(r => r.status === 'fail').length;
  const skipped = results.filter(r => r.status === 'skip').length;

  return {
    runAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    totalTests: results.length,
    passed,
    failed,
    skipped,
    totalDurationMs: Date.now() - runStart,
    results,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

run()
  .then(summary => {
    console.log('\n' + '='.repeat(60));
    console.log('  E2E MONITOR RESULTS');
    console.log('='.repeat(60));
    console.log(`  Run at:    ${summary.runAt}`);
    console.log(`  Base URL:  ${summary.baseUrl}`);
    console.log(`  Duration:  ${summary.totalDurationMs}ms`);
    console.log(`  Passed:    ${summary.passed}`);
    console.log(`  Failed:    ${summary.failed}`);
    console.log(`  Skipped:   ${summary.skipped}`);
    console.log('='.repeat(60));

    for (const r of summary.results) {
      const icon = r.status === 'pass' ? 'OK' : r.status === 'fail' ? 'FAIL' : 'SKIP';
      const pad = icon === 'OK' ? '  ' : icon === 'SKIP' ? '' : '';
      console.log(`  [${icon}]${pad} ${r.group} > ${r.name} (${r.durationMs}ms)${r.error ? ` — ${r.error}` : ''}`);
    }
    console.log('');

    const jsonPath = 'e2e-results.json';
    writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
    console.log(`JSON summary written to ${jsonPath}`);

    if (summary.failed > 0) {
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('E2E monitor crashed:', err);
    process.exit(2);
  });
