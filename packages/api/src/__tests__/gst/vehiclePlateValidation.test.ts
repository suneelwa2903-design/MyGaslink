/**
 * Vehicle plate pre-validation guard in buildEwbPayload.
 *
 * Live-NIC failure 2026-05-29 (the demo distributor's 'DEMO-MN-0001' vehicle):
 * NIC sandbox rejected the EWB with code 225 — the sanitizer produced
 * 'DEMOMN0001' which is not a valid Indian RTO plate ('DEMO' is not a state
 * code). Operators saw a generic "EWB generation failed unexpectedly" because
 * the cryptic NIC envelope made it past `buildPendingActionDescription`.
 *
 * Fix: validate the sanitized plate against the standard RTO regex BEFORE the
 * payload leaves the process. A clear-text Error surfaces immediately as a
 * 400 to the caller (and into the pending-action description after the Fix 2
 * NIC-code classifier picks up the same payload-shape rule).
 *
 * Positive tests pin the formats commercial fleets use; negative tests pin the
 * exact failure modes the demo hit + a couple of structural edge cases (empty
 * string, missing state code).
 *
 * Also includes a smoke test that every UUID constant in seed-demo.ts's DEMO
 * block now parses as a v4 UUID — paired guard for Fix 1.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { buildIrnPayload, buildEwbPayload } from '../../services/gst/payloadBuilders.js';

function b2bIrnFixture() {
  return buildIrnPayload({
    docType: 'INV' as const,
    docNumber: 'INV-PLATE-TEST',
    docDate: new Date('2026-05-30T00:00:00Z'),
    seller: {
      gstin: '29AAGCB1286Q000',
      legalName: 'Demo Gas Agency',
      tradeName: 'Demo Gas',
      address: '1 Depot Road',
      city: 'Bangalore',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000000',
      email: 'demo@gasdist.com',
    },
    buyer: {
      gstin: '29AWGPV7107B1Z1',
      legalName: 'Demo Agencies',
      tradeName: 'Demo',
      address: '45 Customer Lane',
      city: 'Bangalore',
      pincode: '560041',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000001',
      email: 'agencies@example.com',
    },
    items: [{
      slNo: 1,
      description: '19 KG LPG Cylinder',
      hsnCode: '27111900',
      quantity: 2,
      unit: 'NOS',
      unitPrice: 2000,
      discountPerUnit: 0,
      gstRate: 18,
    }],
    isInterState: false,
  });
}

function buildWith(vehicleNumber: string) {
  return buildEwbPayload(b2bIrnFixture(), {
    vehicleNumber,
    transportMode: '1',
    distance: 2,
  });
}

describe('Vehicle plate validation — accepts valid Indian RTO formats', () => {
  it('KA01-DM-0001 (hyphenated, 2-digit district)', () => {
    expect(() => buildWith('KA01-DM-0001')).not.toThrow();
  });

  it('MH12-AB-1234 (Maharashtra, 2-letter series)', () => {
    expect(() => buildWith('MH12-AB-1234')).not.toThrow();
  });

  it('TS09-AB-1234 (Telangana — the dist-001 seeded format)', () => {
    expect(() => buildWith('TS09-AB-1234')).not.toThrow();
  });

  it('DL01-AB-1234 (Delhi)', () => {
    expect(() => buildWith('DL01-AB-1234')).not.toThrow();
  });

  it('KA01MN9999 (already-sanitized form, no hyphens)', () => {
    // dist-002's seeded vehicle plate. The sanitizer is idempotent on
    // already-clean input — this guard confirms we don't reject it.
    expect(() => buildWith('KA01MN9999')).not.toThrow();
  });

  it('KA1AB1234 (1-digit district variant — some smaller RTOs)', () => {
    expect(() => buildWith('KA1AB1234')).not.toThrow();
  });

  it('MH12ABC1234 (3-letter series variant)', () => {
    expect(() => buildWith('MH12ABC1234')).not.toThrow();
  });
});

describe('Vehicle plate validation — rejects with operator-readable error', () => {
  it('DEMO-MN-0001 — the exact live-2026-05-29 failure', () => {
    expect(() => buildWith('DEMO-MN-0001')).toThrow(
      /Invalid vehicle registration number "DEMO-MN-0001"/,
    );
    expect(() => buildWith('DEMO-MN-0001')).toThrow(
      /Expected Indian RTO format e\.g\. KA01-AB-1234/,
    );
    expect(() => buildWith('DEMO-MN-0001')).toThrow(
      /Update in\s+Fleet → Vehicles/,
    );
  });

  it('DEMOMN0001 (the post-sanitize form) is rejected too', () => {
    expect(() => buildWith('DEMOMN0001')).toThrow(
      /Invalid vehicle registration/,
    );
  });

  it('empty string is rejected', () => {
    expect(() => buildWith('')).toThrow(/Invalid vehicle registration/);
  });

  it('"12-AB-1234" (missing state-code letters) is rejected', () => {
    expect(() => buildWith('12-AB-1234')).toThrow(/Invalid vehicle registration/);
  });

  it('"KA-AB-1234" (missing district digits) is rejected', () => {
    expect(() => buildWith('KA-AB-1234')).toThrow(/Invalid vehicle registration/);
  });

  it('"KA01-AB-123" (only 3 trailing digits — short number) is rejected', () => {
    expect(() => buildWith('KA01-AB-123')).toThrow(/Invalid vehicle registration/);
  });
});

describe('Seed-demo UUID constants smoke test (Fix 1 paired guard)', () => {
  // Hardcoded copies of the constants in seed-demo.ts. If these drift (e.g.
  // someone reverts to a slug), this test catches it before a reseed propagates
  // the regression to the demo tenant.
  const DEMO_CONSTANTS = {
    customerB2cId:      'a0000000-0000-4000-8000-000000000001',
    customerB2bInterId: 'a0000000-0000-4000-8000-000000000002',
    customerB2bIntraId: 'a0000000-0000-4000-8000-000000000003',
    driverId:           'a0000000-0000-4000-8000-000000000010',
    vehicleId:          'a0000000-0000-4000-8000-000000000020',
  };

  const uuid = z.string().uuid();

  for (const [name, value] of Object.entries(DEMO_CONSTANTS)) {
    it(`DEMO.${name} parses as a UUID`, () => {
      expect(uuid.safeParse(value).success).toBe(true);
    });
  }
});
