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
});

afterAll(async () => {
  await prisma.$disconnect();
});
