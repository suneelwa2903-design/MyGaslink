/**
 * Phase 4a — subscription pricing structure refresh.
 *
 * Locks in the 5-tier seed data + the new schema columns. The migration
 * itself runs before this test suite via `prisma migrate deploy`; the
 * dev DB has already been re-seeded with the new structure.
 *
 * What we guard:
 *   1. All 5 plans seeded (Starter / Growth / Business / Enterprise / Ultra).
 *   2. Each plan's monthly price + cylinder range matches the locked spec.
 *   3. Per-role addon pricing columns exist and carry the new defaults.
 *   4. The Ultra tier has volumeMax = null (unlimited bucket).
 *
 * Phase 4b will exercise the seatRequestService → these columns wiring.
 * Phase 4a's responsibility is just the schema + seed.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { SubscriptionPlan } from '@gaslink/shared';

const EXPECTED = {
  starter:    { monthlyPrice: 4999,  volumeMin: 0,     volumeMax: 5000,  driverSeats: 2,    gstApiCallsIncluded: 1500 },
  growth:     { monthlyPrice: 6999,  volumeMin: 5001,  volumeMax: 15000, driverSeats: 5,    gstApiCallsIncluded: 4000 },
  business:   { monthlyPrice: 12999, volumeMin: 15001, volumeMax: 30000, driverSeats: 8,    gstApiCallsIncluded: 8000 },
  enterprise: { monthlyPrice: 18999, volumeMin: 30001, volumeMax: 50000, driverSeats: 12,   gstApiCallsIncluded: 15000 },
  ultra:      { monthlyPrice: 24999, volumeMin: 50001, volumeMax: null,  driverSeats: 9999, gstApiCallsIncluded: 999999 },
};

describe('Phase 4a — pricing tiers seeded with new structure', () => {
  it('the SubscriptionPlan enum carries all 5 plan codes', () => {
    expect(SubscriptionPlan.STARTER).toBe('starter');
    expect(SubscriptionPlan.GROWTH).toBe('growth');
    expect(SubscriptionPlan.BUSINESS).toBe('business');
    expect(SubscriptionPlan.ENTERPRISE).toBe('enterprise');
    expect(SubscriptionPlan.ULTRA).toBe('ultra');
  });

  it.each(Object.entries(EXPECTED))(
    'seeds %s with the locked monthly price + cylinder range + GST API allowance',
    async (planKey, expected) => {
      const tier = await prisma.pricingTier.findUnique({
        where: { plan: planKey as 'starter' | 'growth' | 'business' | 'enterprise' | 'ultra' },
      });
      expect(tier).not.toBeNull();
      expect(Number(tier!.monthlyPrice)).toBe(expected.monthlyPrice);
      expect(tier!.volumeMin).toBe(expected.volumeMin);
      expect(tier!.volumeMax).toBe(expected.volumeMax);
      expect(tier!.driverSeats).toBe(expected.driverSeats);
      expect(tier!.gstApiCallsIncluded).toBe(expected.gstApiCallsIncluded);
    },
  );

  it('Ultra has the unlimited-bucket signature (volumeMax null)', async () => {
    const ultra = await prisma.pricingTier.findUnique({ where: { plan: 'ultra' } });
    expect(ultra!.volumeMax).toBeNull();
  });

  it('every plan carries the new per-role addon pricing columns (Phase 4b will read these)', async () => {
    const tiers = await prisma.pricingTier.findMany();
    expect(tiers.length).toBe(5);
    for (const tier of tiers) {
      expect(Number(tier.extraSeatPriceAdmin)).toBe(999);
      expect(Number(tier.extraSeatPriceDriver)).toBe(299);
      expect(Number(tier.extraSeatPriceFinance)).toBe(499);
      expect(Number(tier.extraSeatPriceInventory)).toBe(499);
      expect(Number(tier.extraSeatPriceCustomer)).toBe(249);
      expect(tier.freeCustomerLogins).toBe(5);
    }
  });

  it('exactly 5 pricing tiers — no orphan rows from old structure', async () => {
    const count = await prisma.pricingTier.count();
    expect(count).toBe(5);
  });
});
