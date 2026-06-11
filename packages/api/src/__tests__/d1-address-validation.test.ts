/**
 * Group D1 (2026-06-11) — address-field validation guards.
 *
 *  - 6-digit pincode regex on createCustomer + createDistributor schemas
 *    (both billing+shipping for customer; registered+godown+office for
 *    distributor).
 *  - INDIAN_STATE_NAMES is exported, sorted, and contains 37+ entries (the
 *    state-dropdown source).
 *
 * Schema-level tests only — no DB, no HTTP. The behavior tested here is
 * pure-Zod, so it lives next to other schema guards.
 */
import { describe, it, expect } from 'vitest';
import {
  createCustomerSchema,
  createDistributorSchema,
  INDIAN_STATE_NAMES,
  INDIAN_STATES,
} from '@gaslink/shared';

describe('D1 — pincode regex on customer schema', () => {
  const base = { customerName: 'X', phone: '9876543210' };

  it('accepts a valid 6-digit billing pincode', () => {
    const r = createCustomerSchema.safeParse({ ...base, billingPincode: '500034' });
    expect(r.success).toBe(true);
  });

  it('rejects a 4-digit billing pincode with the expected message', () => {
    const r = createCustomerSchema.safeParse({ ...base, billingPincode: '5000' });
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.find((i) => i.path.join('.') === 'billingPincode')?.message;
      expect(msg).toBe('Pincode must be exactly 6 digits');
    }
  });

  it('rejects a non-digit billing pincode', () => {
    const r = createCustomerSchema.safeParse({ ...base, billingPincode: 'abc123' });
    expect(r.success).toBe(false);
  });

  it('accepts an empty billing pincode (optional)', () => {
    const r = createCustomerSchema.safeParse({ ...base, billingPincode: '' });
    expect(r.success).toBe(true);
  });

  it('accepts a missing billing pincode (optional)', () => {
    const r = createCustomerSchema.safeParse({ ...base });
    expect(r.success).toBe(true);
  });

  it('applies the same regex to shippingPincode', () => {
    const bad = createCustomerSchema.safeParse({ ...base, shippingPincode: '5' });
    const good = createCustomerSchema.safeParse({ ...base, shippingPincode: '110001' });
    expect(bad.success).toBe(false);
    expect(good.success).toBe(true);
  });

  it('still accepts a missing state (state field is free-text in schema; dropdown enforced UI-side)', () => {
    // Server schema does NOT restrict the state string — the Combobox in
    // the form is the enforcement point. This test pins that behavior so
    // a GSTIN-lookup return like "Telangana" or a CSV import with
    // "telengana" both round-trip without server rejection.
    const r = createCustomerSchema.safeParse({ ...base, billingState: 'Telangana' });
    expect(r.success).toBe(true);
  });
});

describe('D1 — pincode regex on distributor schema', () => {
  const base = { businessName: 'X', legalName: 'X Pvt Ltd' };

  it('rejects a 5-digit registered pincode', () => {
    const r = createDistributorSchema.safeParse({ ...base, pincode: '50003' });
    expect(r.success).toBe(false);
  });

  it('accepts a valid registered pincode', () => {
    const r = createDistributorSchema.safeParse({ ...base, pincode: '500034' });
    expect(r.success).toBe(true);
  });

  it('rejects a non-digit godown pincode', () => {
    const r = createDistributorSchema.safeParse({ ...base, godownPincode: '50003a' });
    expect(r.success).toBe(false);
  });

  it('rejects a 7-digit office pincode', () => {
    const r = createDistributorSchema.safeParse({ ...base, officePincode: '5000341' });
    expect(r.success).toBe(false);
  });

  it('accepts empty godown + office pincodes (optional, may be unset at create-time)', () => {
    const r = createDistributorSchema.safeParse({
      ...base,
      godownPincode: '',
      officePincode: '',
    });
    expect(r.success).toBe(true);
  });
});

describe('D1 — INDIAN_STATE_NAMES export shape', () => {
  it('is sorted alphabetically', () => {
    const copy = [...INDIAN_STATE_NAMES];
    const sorted = [...copy].sort((a, b) => a.localeCompare(b));
    expect(copy).toEqual(sorted);
  });

  it('has no duplicates', () => {
    expect(INDIAN_STATE_NAMES.length).toBe(new Set(INDIAN_STATE_NAMES).size);
  });

  it('covers every state/UT name in INDIAN_STATES (state-code map)', () => {
    const fromMap = new Set(Object.values(INDIAN_STATES));
    for (const name of fromMap) {
      expect(INDIAN_STATE_NAMES).toContain(name);
    }
  });

  it('includes the four states the brief calls out (Telangana, Karnataka, Maharashtra, Tamil Nadu)', () => {
    for (const s of ['Telangana', 'Karnataka', 'Maharashtra', 'Tamil Nadu']) {
      expect(INDIAN_STATE_NAMES).toContain(s);
    }
  });
});
