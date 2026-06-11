import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../lib/prisma.js';
import { loginAsDistAdmin, loginAsSuperAdmin, loginAsFinance } from './helpers.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
let saToken: string;
let financeToken: string;

const TEST_EMAIL = 'test-pricing-user@example.com';
const TEST_EMAIL_2 = 'test-pricing-user-2@example.com';

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
  saToken = (await loginAsSuperAdmin()).token;
  financeToken = (await loginAsFinance()).token;

  // Clean up any leftover users from prior runs
  await prisma.user.deleteMany({
    where: { email: { in: [TEST_EMAIL, TEST_EMAIL_2] } },
  });
});

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { email: { in: [TEST_EMAIL, TEST_EMAIL_2] } },
  });
});

function auth(token: string, distId?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (distId) headers['X-Distributor-Id'] = distId;
  return headers;
}

describe('Users — Auth', () => {
  it('rejects unauthenticated GET / with 401', async () => {
    const res = await request(app).get('/api/users');
    expect(res.status).toBe(401);
  });

  it('rejects POST for finance role (403)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(financeToken))
      .send({ email: TEST_EMAIL, password: 'Test@123', firstName: 'X', lastName: 'Y', role: 'finance' });
    expect(res.status).toBe(403);
  });
});

describe('Users — GET /profile', () => {
  it('returns the caller\'s own profile', async () => {
    const res = await request(app).get('/api/users/profile').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.email).toBe('bhargava@gasagency.com');
  });
});

describe('Users — Distributor admin scope', () => {
  it('lists ONLY users from caller\'s distributor', async () => {
    const res = await request(app).get('/api/users').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.users)).toBe(true);
    for (const u of res.body.data.users) {
      // Super admins (distributorId null) shouldn't appear in dist-001 admin's list
      expect(u.distributorId).toBe('dist-001');
    }
  });
});

describe('Users — Super admin scope', () => {
  it('lists users across distributors when no header is set', async () => {
    const res = await request(app).get('/api/users').set(auth(saToken));
    expect(res.status).toBe(200);
    const distIds = new Set<string | null>();
    for (const u of res.body.data.users) {
      distIds.add(u.distributorId);
    }
    // Should include dist-001 + dist-002 + nulls (super admin)
    expect(distIds.size).toBeGreaterThanOrEqual(2);
  });
});

describe('Users — Create / update / delete (CRUD with ownership)', () => {
  let createdId: string;

  it('distributor_admin creates a user — distributorId forced from JWT', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL,
        password: 'Test@1234',
        firstName: 'Test',
        lastName: 'User',
        phone: '9100000333',
        // Phase 4a (2026-06-12): role flipped from 'finance' to 'driver'
        // because the new pricing tier seed caps business plan at 2
        // finance seats. Bhargava already has 1 seeded finance user
        // (finance@gasagency.com), so a test that creates a 2nd then
        // tries to insert a 3rd would hit SeatLimitError before the
        // email uniqueness check fires — making the 409 duplicate test
        // below 500 out instead. Drivers have 8 seats on business, so
        // the test fits comfortably under the limit.
        role: 'driver',
        // No distributorId in body; routes/users.ts forces req.user.distributorId
        // for non-super_admin callers regardless of what's sent.
      });
    if (res.status !== 201) console.log('create user error:', res.body);
    expect(res.status).toBe(201);
    // Group B Part 2 — POST /api/users now returns `{ user, tempPassword }`.
    // tempPassword is the plaintext the caller submitted, echoed back so the
    // Add User modal can render a copyable banner. Every other endpoint
    // omits this field.
    expect(res.body.data.user.distributorId).toBe('dist-001');
    expect(res.body.data.user.email).toBe(TEST_EMAIL);
    expect(res.body.data.tempPassword).toBe('Test@1234');
    expect(res.body.data.user.requiresPasswordReset).toBe(true);
    createdId = res.body.data.user.userId;
  });

  it('rejects POST with missing required fields (400)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({ email: 'incomplete@example.com' });
    expect(res.status).toBe(400);
  });

  it('returns 409 on duplicate email', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL,
        password: 'Test@1234',
        firstName: 'Dup',
        lastName: 'User',
        phone: '9100000334',
        // Matches the role used in the create test above so the dupe
        // attempt actually exercises the email uniqueness path. See the
        // Phase 4a note in that test for the role-choice rationale.
        role: 'driver',
      });
    expect(res.status).toBe(409);
  });

  it('admin updates a user', async () => {
    const res = await request(app)
      .put(`/api/users/${createdId}`)
      .set(auth(adminToken))
      .send({ firstName: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body.data.firstName).toBe('Updated');
  });

  it('soft-deletes a user', async () => {
    const res = await request(app)
      .delete(`/api/users/${createdId}`)
      .set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('cannot self-delete', async () => {
    // Find the dist-001 admin ID (the caller).
    const me = await prisma.user.findUniqueOrThrow({
      where: { email: 'bhargava@gasagency.com' },
    });
    const res = await request(app)
      .delete(`/api/users/${me.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(400);
  });
});

// Group B Part 2 — POST /api/users wires a fire-and-forget welcome email
// and writes an `email_logs` row regardless of outcome. The dev DB has no
// SMTP_HOST configured, so the welcome path takes the 'skipped' branch.
// Test asserts:
//   1. response shape carries `{ user, tempPassword }`
//   2. an `email_logs` row exists with type=welcome, status=skipped, userId set
//   3. SMTP failures (would-be 'failed' status) NEVER block user creation
// The third assertion is implicit — every prior CRUD test creating a user
// already proved POST /api/users returns 201 with SMTP unconfigured.
describe('Users — Welcome email + audit log (Group B Part 2)', () => {
  const TEST_EMAIL_3 = 'welcome-test@example.com';

  afterAll(async () => {
    // emailLog rows cascade away when we drop the user, but the FK is
    // nullable + best-effort, so clean them explicitly to keep the table
    // tidy across test runs.
    await prisma.emailLog.deleteMany({
      where: { toEmail: TEST_EMAIL_3 },
    });
    await prisma.user.deleteMany({
      where: { email: TEST_EMAIL_3 },
    });
  });

  it('POST /api/users writes an email_logs row (type=welcome, status=skipped when SMTP unconfigured)', async () => {
    const before = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(before).toBe(0);

    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_EMAIL_3,
        password: 'Welcome@1234',
        firstName: 'Welcome',
        lastName: 'Tester',
        phone: '9100000444',
        role: 'inventory',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.tempPassword).toBe('Welcome@1234');
    const newUserId: string = res.body.data.user.userId;

    // The route schedules sendWelcomeEmail via `void` — give the microtask
    // a couple of ticks to drain before we assert on the audit row.
    await new Promise((r) => setTimeout(r, 50));

    const logs = await prisma.emailLog.findMany({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe('skipped');
    expect(logs[0].errorText).toBe('SMTP not configured');
    expect(logs[0].userId).toBe(newUserId);
    expect(logs[0].subject).toBe('Welcome to MyGasLink — Your login credentials');
  });

  it('PUT /api/users/:id (update) does NOT send a welcome email', async () => {
    const existing = await prisma.user.findFirstOrThrow({
      where: { email: TEST_EMAIL_3 },
    });
    await request(app)
      .put(`/api/users/${existing.id}`)
      .set(auth(adminToken))
      .send({ firstName: 'Renamed' });
    // No new welcome row should be written on update.
    const logs = await prisma.emailLog.count({
      where: { toEmail: TEST_EMAIL_3, type: 'welcome' },
    });
    expect(logs).toBe(1);
  });
});

// Group B Part 3 — `?unlinked=true` filter on GET /api/drivers and
// GET /api/customers, plus the new POST /api/users { driverId } wiring
// that atomically sets Driver.userId after the user row is created.
describe('Users — Driver ↔ User FK + unlinked filter (Group B Part 3)', () => {
  let testDriverId: string;
  let testCustomerId: string;
  const TEST_DRIVER_USER_EMAIL = 'driver-fk-test@example.com';
  const TEST_CUSTOMER_USER_EMAIL = 'customer-fk-test@example.com';

  beforeAll(async () => {
    // Drop any leftover rows from a previously failed run before seeding.
    const leftoverEmails = [
      TEST_DRIVER_USER_EMAIL,
      TEST_CUSTOMER_USER_EMAIL,
      'driver-fk-x-tenant@example.com',
    ];
    await prisma.emailLog.deleteMany({ where: { toEmail: { in: leftoverEmails } } });
    // Detach drivers that still point at a soon-to-be-deleted user, else
    // the FK blocks the user delete.
    const leftoverUsers = await prisma.user.findMany({
      where: { email: { in: leftoverEmails } },
      select: { id: true },
    });
    if (leftoverUsers.length > 0) {
      await prisma.driver.updateMany({
        where: { userId: { in: leftoverUsers.map((u) => u.id) } },
        data: { userId: null },
      });
    }
    await prisma.user.deleteMany({ where: { email: { in: leftoverEmails } } });
    await prisma.driver.deleteMany({
      where: { distributorId: 'dist-001', driverName: 'FK Test Driver' },
    });
    await prisma.customer.deleteMany({
      where: { distributorId: 'dist-001', customerName: 'FK Test Customer' },
    });

    // Seed a fresh unlinked driver + customer on dist-001 so we can pick
    // them via the modal flow and assert the link.
    const driver = await prisma.driver.create({
      data: {
        distributorId: 'dist-001',
        driverName: 'FK Test Driver',
        phone: '9100012345',
        licenseNumber: 'DL-FK-TEST-001',
      },
    });
    testDriverId = driver.id;

    const customer = await prisma.customer.create({
      data: {
        distributorId: 'dist-001',
        customerName: 'FK Test Customer',
        phone: '9100023456',
        email: 'fkcustomer@example.com',
      },
    });
    testCustomerId = customer.id;
  });

  afterAll(async () => {
    await prisma.emailLog.deleteMany({
      where: { toEmail: { in: [TEST_DRIVER_USER_EMAIL, TEST_CUSTOMER_USER_EMAIL] } },
    });
    // Detach the driver before deleting the user it points at, so the FK
    // doesn't dangle.
    if (testDriverId) {
      await prisma.driver.update({
        where: { id: testDriverId },
        data: { userId: null },
      });
      await prisma.driver.delete({ where: { id: testDriverId } });
    }
    await prisma.user.deleteMany({
      where: { email: { in: [TEST_DRIVER_USER_EMAIL, TEST_CUSTOMER_USER_EMAIL] } },
    });
    if (testCustomerId) {
      await prisma.customer.delete({ where: { id: testCustomerId } });
    }
  });

  it('GET /api/drivers?unlinked=true includes our fresh unlinked driver', async () => {
    const res = await request(app)
      .get('/api/drivers?unlinked=true')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.drivers.map((d: { driverId: string }) => d.driverId);
    expect(ids).toContain(testDriverId);
  });

  it('GET /api/customers?unlinked=true includes our fresh unlinked customer', async () => {
    const res = await request(app)
      .get('/api/customers?unlinked=true')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.customers.map((c: { customerId: string }) => c.customerId);
    expect(ids).toContain(testCustomerId);
  });

  it('POST /api/users with driverId wires Driver.userId on success', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_DRIVER_USER_EMAIL,
        password: 'DriverFK@123',
        firstName: 'FK',
        lastName: 'Driver',
        phone: '9100012345',
        role: 'driver',
        driverId: testDriverId,
      });
    expect(res.status).toBe(201);
    const newUserId: string = res.body.data.user.userId;
    const driver = await prisma.driver.findUniqueOrThrow({ where: { id: testDriverId } });
    expect(driver.userId).toBe(newUserId);
  });

  it('GET /api/drivers?unlinked=true now EXCLUDES the linked driver', async () => {
    const res = await request(app)
      .get('/api/drivers?unlinked=true')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.drivers.map((d: { driverId: string }) => d.driverId);
    expect(ids).not.toContain(testDriverId);
  });

  it('POST /api/users with customerId sets User.customerId (existing pattern, sanity-check)', async () => {
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: TEST_CUSTOMER_USER_EMAIL,
        password: 'CustomerFK@123',
        firstName: 'FK',
        lastName: 'Customer',
        phone: '9100023456',
        role: 'customer',
        customerId: testCustomerId,
      });
    expect(res.status).toBe(201);
    expect(res.body.data.user.customerId).toBe(testCustomerId);
  });

  it('GET /api/customers?unlinked=true now EXCLUDES the linked customer', async () => {
    const res = await request(app)
      .get('/api/customers?unlinked=true')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const ids = res.body.data.customers.map((c: { customerId: string }) => c.customerId);
    expect(ids).not.toContain(testCustomerId);
  });

  it('POST /api/users with driverId belonging to ANOTHER distributor silently skips the link (does NOT 403)', async () => {
    const dist2Driver = await prisma.driver.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2Driver) throw new Error('Seed expected at least one dist-002 driver');
    // Snapshot the dist-002 driver's userId BEFORE the cross-tenant attempt.
    // It may already be non-null from the FK migration's backfill (a
    // dist-002 driver-role User with matching phone). The invariant we're
    // testing isn't "userId stays NULL" — it's "userId does NOT become the
    // newly-created cross-tenant user's id".
    const userIdBefore = dist2Driver.userId ?? null;

    const xTenantEmail = 'driver-fk-x-tenant@example.com';
    const res = await request(app)
      .post('/api/users')
      .set(auth(adminToken))
      .send({
        email: xTenantEmail,
        password: 'CrossT@123',
        firstName: 'X',
        lastName: 'Tenant',
        phone: '9100099999',
        role: 'driver',
        driverId: dist2Driver.id, // belongs to dist-002, caller is dist-001
      });
    // User creation succeeds in dist-001; link silently fails because the
    // driver's distributorId doesn't match.
    expect(res.status).toBe(201);
    const newUserId: string = res.body.data.user.userId;
    const reread = await prisma.driver.findUniqueOrThrow({ where: { id: dist2Driver.id } });
    expect(reread.userId).toBe(userIdBefore);
    expect(reread.userId).not.toBe(newUserId);

    await prisma.emailLog.deleteMany({ where: { toEmail: xTenantEmail } });
    await prisma.user.deleteMany({ where: { email: xTenantEmail } });
  });
});

// Group B Part 4 — GET /api/users default-hides customer + driver roles,
// supports role/status/search filters and sort. Verifies the staff list
// stays clean and that opt-in flags work.
describe('Users — Staff-only list + filters (Group B Part 4)', () => {
  it('GET /api/users default response excludes ONLY customer role (drivers stay visible)', async () => {
    const res = await request(app)
      .get('/api/users')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const roles = res.body.data.users.map((u: { role: string }) => u.role);
    expect(roles).not.toContain('customer');
    // Group B Part 7 Bug 3 — drivers ARE staff, they show by default now.
    // sanity: at least one staff role still shows
    expect(roles.some((r: string) => ['distributor_admin', 'finance', 'inventory'].includes(r))).toBe(true);
  });

  it('GET /api/users?includePortal=true restores customer-role rows', async () => {
    const res = await request(app)
      .get('/api/users?includePortal=true')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const roles = res.body.data.users.map((u: { role: string }) => u.role);
    // dev DB has customer-portal logins on dist-001 seeded as part of the
    // WI122 / portal smoke seed.
    expect(roles).toContain('customer');
  });

  it('GET /api/users?role=customer returns ONLY customer-role users', async () => {
    const res = await request(app)
      .get('/api/users?role=customer')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const roles: string[] = res.body.data.users.map((u: { role: string }) => u.role);
    expect(roles.length).toBeGreaterThan(0);
    expect(new Set(roles)).toEqual(new Set(['customer']));
  });

  it('GET /api/users?status=active returns ONLY active users', async () => {
    const res = await request(app)
      .get('/api/users?status=active')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const statuses: string[] = res.body.data.users.map((u: { status: string }) => u.status);
    expect(new Set(statuses)).toEqual(new Set(['active']));
  });

  it('GET /api/users?search=bhargava finds the dist-001 admin by email', async () => {
    const res = await request(app)
      .get('/api/users?search=bhargava')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const emails: string[] = res.body.data.users.map((u: { email: string }) => u.email);
    expect(emails.some((e) => e.includes('bhargava'))).toBe(true);
  });

  it('GET /api/users?sortBy=email&sortDir=asc returns alphabetical', async () => {
    const res = await request(app)
      .get('/api/users?sortBy=email&sortDir=asc')
      .set(auth(adminToken));
    expect(res.status).toBe(200);
    const emails: string[] = res.body.data.users.map((u: { email: string }) => u.email);
    const sorted = [...emails].sort();
    expect(emails).toEqual(sorted);
  });
});

describe('Users — Tenant Isolation', () => {
  it('cannot fetch a user from another distributor (404)', async () => {
    const dist2User = await prisma.user.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2User) throw new Error('Seed expected a dist-002 user');

    const res = await request(app)
      .get(`/api/users/${dist2User.id}`)
      .set(auth(adminToken));
    expect(res.status).toBe(404);
  });

  it('cannot update a user from another distributor', async () => {
    const dist2User = await prisma.user.findFirst({
      where: { distributorId: 'dist-002', deletedAt: null },
    });
    if (!dist2User) throw new Error('Seed expected a dist-002 user');

    const res = await request(app)
      .put(`/api/users/${dist2User.id}`)
      .set(auth(adminToken))
      .send({ firstName: 'Hijack' });
    expect([403, 404]).toContain(res.status);
  });
});
