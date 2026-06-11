// Import config first so dotenv/config runs ONCE and populates process.env
// from .env. We then immediately wipe the SMTP keys so any later
// `getTransporter()` call takes the skipped branch deterministically.
// Without this dance, every test that creates a user would synchronously
// open a Gmail SMTP socket — slow, flaky, and would actually email real
// addresses if any test fixture had a typo'd real domain.
import '../config/index.js';
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

import { prisma } from '../lib/prisma.js';
import { afterAll, beforeEach } from 'vitest';

// WI-128: INVENTORY_DISPATCH_DEBIT is a global env flag (isDispatchDebitEnabled
// reads process.env). Once it is set in packages/api/.env for the dev server,
// the vitest process inherits it. Reset it to undefined (treated as OFF) before
// every test so OFF-assuming tests stay deterministic. Tests that need it ON
// set it explicitly themselves (e.g. dva-dispatch-inventory.test.ts) and clean
// up after — this reset is the safety net for everything else.
beforeEach(() => {
  delete process.env.INVENTORY_DISPATCH_DEBIT;
  // Group 2 (2026-06-11): pre-dispatch stock gate. Default ON in
  // production; OFF in tests so the existing dispatch suites
  // (gst-preflight, dva-*, vehicle-return-bundle) which don't bother to
  // seed opening stock keep their semantics. The G2 stock-gate tests
  // (inventory-safety-gates.test.ts) opt back in via a beforeAll.
  process.env.INVENTORY_STOCK_GATE_BYPASS = 'true';
});

// Group B Part 2 — neutralise SMTP for the test process so tests are
// deterministic. With live SMTP creds in packages/api/.env (Suneel's
// dev setup) the welcome-email path otherwise tries a real Gmail
// connection per test, which is slow and asynchronous. Unsetting both
// SMTP_HOST and SMTP_USER routes sendWelcomeEmail() / sendOtpEmail()
// down the 'skipped' branch, which writes the audit row synchronously
// (or close enough) and never opens a network socket.
// Tests that need to assert real send behaviour can re-set the vars
// inside their own setup and call _resetTransporter().
delete process.env.SMTP_HOST;
delete process.env.SMTP_USER;
delete process.env.SMTP_PASS;

afterAll(async () => {
  await prisma.$disconnect();
});
