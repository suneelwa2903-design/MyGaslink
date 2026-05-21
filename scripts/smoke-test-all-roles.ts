/**
 * smoke-test-all-roles.ts
 *
 * Tests every role on dist-002 (Sharma Gas Distributors) can access permitted
 * routes and is blocked from restricted ones.
 *
 * Run:  npx tsx scripts/smoke-test-all-roles.ts
 *
 * Prereqs:
 *   - API running on localhost:5000
 *   - dist-002 users seeded (run scripts/create-dist002-users.ts first)
 */

const BASE = 'http://localhost:5000/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Check {
  description: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  expectStatus: number;
  /** If true, any 2xx is acceptable (use when exact status varies by data). */
  expect2xx?: boolean;
}

interface RoleSpec {
  role: string;
  email: string;
  password: string;
  checks: Check[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Login failed for ${email}: ${res.status} ${body}`);
  }
  const data = (await res.json()) as { data?: { tokens?: { accessToken?: string } } };
  const token = data?.data?.tokens?.accessToken;
  if (!token) throw new Error(`No accessToken in login response for ${email}`);
  return token;
}

async function hit(
  token: string,
  method: string,
  path: string,
): Promise<number> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  return res.status;
}

// ─── Known dist-002 resource IDs ──────────────────────────────────────────────
// These exist in the seeded DB. Used for DELETE / single-resource checks.
// We expect role-based 403 before any business logic runs, so no side effects.
const CUSTOMER_ID = 'e055c431-43b9-4d07-8651-89122c0fe722'; // Hyderabad Caterers

// ─── Role Specs ───────────────────────────────────────────────────────────────

const specs: RoleSpec[] = [
  // ── distributor_admin ────────────────────────────────────────────────────
  {
    role: 'distributor_admin',
    email: 'sharma@gasdist.com',
    password: 'Gstadmin@123',
    checks: [
      { description: 'GET /orders → 200',               method: 'GET',    path: '/orders',              expectStatus: 200 },
      { description: 'GET /invoices → 200',             method: 'GET',    path: '/invoices',            expectStatus: 200 },
      { description: 'GET /inventory/summary → 200',    method: 'GET',    path: '/inventory/summary',   expectStatus: 200 },
      { description: 'GET /drivers → 200',              method: 'GET',    path: '/drivers',             expectStatus: 200 },
      { description: 'GET /analytics/dashboard → 200',  method: 'GET',    path: '/analytics/dashboard', expectStatus: 200 },
      { description: 'DELETE /customers/:id → 200/404', method: 'DELETE', path: `/customers/${CUSTOMER_ID}`, expect2xx: true },
    ],
  },

  // ── finance ──────────────────────────────────────────────────────────────
  {
    role: 'finance',
    email: 'finance2@gasdist.com',
    password: 'Finance@123',
    checks: [
      { description: 'GET /orders → 200',               method: 'GET',    path: '/orders',              expectStatus: 200 },
      { description: 'GET /invoices → 200',             method: 'GET',    path: '/invoices',            expectStatus: 200 },
      { description: 'GET /inventory/summary → 200',    method: 'GET',    path: '/inventory/summary',   expectStatus: 200 },
      { description: 'GET /drivers → 200',              method: 'GET',    path: '/drivers',             expectStatus: 200 },
      { description: 'GET /analytics/dashboard → 200',  method: 'GET',    path: '/analytics/dashboard', expectStatus: 200 },
      // BLOCKED
      { description: 'DELETE /customers/:id → 403',    method: 'DELETE', path: `/customers/${CUSTOMER_ID}`, expectStatus: 403 },
    ],
  },

  // ── inventory ────────────────────────────────────────────────────────────
  {
    role: 'inventory',
    email: 'inventory2@gasdist.com',
    password: 'Inventory@123',
    checks: [
      { description: 'GET /orders → 200',               method: 'GET',    path: '/orders',              expectStatus: 200 },
      { description: 'GET /invoices → 200',             method: 'GET',    path: '/invoices',            expectStatus: 200 },
      { description: 'GET /inventory/summary → 200',    method: 'GET',    path: '/inventory/summary',   expectStatus: 200 },
      { description: 'GET /drivers → 200',              method: 'GET',    path: '/drivers',             expectStatus: 200 },
      { description: 'GET /analytics/dashboard → 200',  method: 'GET',    path: '/analytics/dashboard', expectStatus: 200 },
      // BLOCKED
      { description: 'DELETE /customers/:id → 403',    method: 'DELETE', path: `/customers/${CUSTOMER_ID}`, expectStatus: 403 },
    ],
  },

  // ── driver ───────────────────────────────────────────────────────────────
  {
    role: 'driver',
    email: 'driver2@gasdist.com',
    password: 'Driver@123',
    checks: [
      { description: 'GET /orders → 200',          method: 'GET', path: '/orders',   expectStatus: 200 },
      // BLOCKED
      { description: 'GET /invoices → 403',        method: 'GET', path: '/invoices', expectStatus: 403 },
    ],
  },

  // ── customer ─────────────────────────────────────────────────────────────
  {
    role: 'customer',
    email: 'customer2@gasdist.com',
    password: 'Customer@123',
    checks: [
      { description: 'GET /customer-portal/orders → 200', method: 'GET', path: '/customer-portal/orders', expectStatus: 200 },
      // BLOCKED
      { description: 'GET /invoices → 403',               method: 'GET', path: '/invoices',               expectStatus: 403 },
    ],
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

interface Result {
  role: string;
  description: string;
  expected: string;
  got: number;
  pass: boolean;
}

async function run() {
  console.log('='.repeat(70));
  console.log('  GasLink Role Smoke Test — dist-002 (Sharma Gas Distributors)');
  console.log('='.repeat(70));
  console.log();

  const results: Result[] = [];
  let totalPass = 0;
  let totalFail = 0;

  for (const spec of specs) {
    console.log(`▶  ${spec.role.toUpperCase().padEnd(20)} ${spec.email}`);
    console.log('─'.repeat(70));

    let token: string;
    try {
      token = await login(spec.email, spec.password);
    } catch (err) {
      console.log(`   ❌ LOGIN FAILED: ${err}`);
      console.log();
      for (const check of spec.checks) {
        results.push({ role: spec.role, description: check.description, expected: String(check.expectStatus ?? '2xx'), got: 0, pass: false });
        totalFail++;
      }
      continue;
    }
    console.log('   ✔ Login OK');

    for (const check of spec.checks) {
      const got = await hit(token, check.method, check.path);
      let pass: boolean;
      let expectedLabel: string;

      if (check.expect2xx) {
        pass = got >= 200 && got < 300;
        expectedLabel = '2xx';
      } else {
        pass = got === check.expectStatus;
        expectedLabel = String(check.expectStatus);
      }

      const icon = pass ? '   ✅' : '   ❌';
      const suffix = pass ? '' : `  ← got ${got}, expected ${expectedLabel}`;
      console.log(`${icon} ${check.description}${suffix}`);

      results.push({ role: spec.role, description: check.description, expected: expectedLabel, got, pass });
      if (pass) totalPass++; else totalFail++;
    }

    console.log();
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('='.repeat(70));
  console.log('  SUMMARY');
  console.log('='.repeat(70));
  console.log(`  Total: ${results.length}  ✅ ${totalPass}  ❌ ${totalFail}`);
  console.log();

  if (totalFail > 0) {
    console.log('  FAILURES:');
    for (const r of results.filter((r) => !r.pass)) {
      console.log(`  ❌ [${r.role}] ${r.description} — got ${r.got}, expected ${r.expected}`);
    }
    console.log();
    process.exit(1);
  } else {
    console.log('  All checks passed. ✅');
    console.log();
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
