/**
 * Phase 7 — mobile customer form: state picker + GSTIN warning surface.
 *
 *  D1 (state picker): mobile previously let users type any string into
 *  billingState / shippingState. Server-side WI-077 didn't validate
 *  state names either — "Telangaaana" or "TS" would pass through and
 *  silently corrupt GSTR-1 place-of-supply derivation. Web shipped a
 *  dropdown in commit 61392d8; mobile gets parity here.
 *
 *  E1 (multi-branch GSTIN warning): the server has emitted
 *  `warnings: string[]` on create/update responses since aa36370. The
 *  mobile (admin)/customer-create.tsx wrapper now surfaces it as a
 *  must-acknowledge alert so the user explicitly sees the multi-branch
 *  situation before being routed back to the list.
 *
 * Server tests pin the contract the mobile UI consumes:
 *  - POST /api/customers with a duplicate GSTIN returns 201 + warnings
 *  - source-file guards on the mobile form pin the StatePickerField
 *    contract + the warnings-handling in customer-create.tsx.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApp } from '../app.js';
import { loginAsDistAdmin } from './helpers.js';
import { prisma } from '../lib/prisma.js';
import type { Express } from 'express';

let app: Express;
let adminToken: string;
const DUP_GSTIN = '29AABCT1234A1Z5';
const cleanupIds: string[] = [];

beforeAll(async () => {
  app = createApp();
  adminToken = (await loginAsDistAdmin()).token;
});

afterAll(async () => {
  if (cleanupIds.length > 0) {
    await prisma.customer.deleteMany({ where: { id: { in: cleanupIds } } });
  }
});

describe('Phase 7 — E1 multi-branch GSTIN warning on POST /api/customers', () => {
  it('first customer with a fresh GSTIN gets 201 + no warnings', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerName: 'Phase7 Branch A',
        gstin: DUP_GSTIN,
        phone: '9100000999',
        billingState: 'Karnataka',
      });
    expect(res.status).toBe(201);
    cleanupIds.push(res.body.data.customerId);
    // No warnings on a first-time GSTIN.
    expect(res.body.data.warnings ?? []).toEqual([]);
  });

  it('second customer with the SAME GSTIN gets 201 + a multi-branch warning', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        customerName: 'Phase7 Branch B',
        gstin: DUP_GSTIN,
        phone: '9100000998',
        billingState: 'Karnataka',
      });
    expect(res.status).toBe(201);
    cleanupIds.push(res.body.data.customerId);
    const warnings: string[] = res.body.data.warnings ?? [];
    expect(warnings.length).toBeGreaterThan(0);
    // The exact wording matters less than the user-visible signal that
    // this is a duplicate-GSTIN multi-branch situation — pin the most
    // recognisable substring so a copy-edit doesn't quietly break the
    // mobile alert text.
    expect(warnings.join(' ')).toMatch(/GSTIN/);
  });
});

describe('Phase 7 — mobile CustomerForm source guards', () => {
  const formSource = readFileSync(
    resolve(__dirname, '../../../mobile/src/screens/CustomerForm.tsx'),
    'utf-8',
  );

  it('imports INDIAN_STATE_NAMES from shared', () => {
    expect(formSource).toMatch(/import\s*\{\s*INDIAN_STATE_NAMES\s*\}\s*from\s*['"]@gaslink\/shared['"]/);
  });

  it('declares a StatePickerField component', () => {
    expect(formSource).toContain('function StatePickerField');
  });

  it('uses StatePickerField for billingState AND shippingState', () => {
    // Pin BOTH replacements — a half-applied edit that only fixes one
    // would silently leave the legacy TextInput on the other field.
    const matches = formSource.match(/<StatePickerField/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Phase 7 — mobile customer-create warnings surface', () => {
  const screen = readFileSync(
    resolve(__dirname, '../../../mobile/app/(admin)/customer-create.tsx'),
    'utf-8',
  );

  it('reads warnings off the create response', () => {
    expect(screen).toContain('data?.warnings');
  });

  it('surfaces warnings via an Alert before routing back', () => {
    expect(screen).toContain('Alert.alert');
    expect(screen).toMatch(/Customer created.*review/);
  });
});
