/**
 * 9-issues Group 2 — pricing fixes.
 *
 * Issue 4 — pricing_tiers.customer_portal_price 49 → 249 across all
 *           5 plans. Seed update + dev DB backfill. Existing
 *           BillingItem rows that snapshot the old ₹49 are intentionally
 *           NOT rewritten (historical audit immutability — only new
 *           cycles see ₹249).
 * Issue 8 — Business plan → tier_3 (not tier_2). seed.ts and
 *           seed-demo.ts updated; dev DB backfilled.
 */
import { describe, it, expect } from 'vitest';
import { prisma } from '../lib/prisma.js';

describe('Issue 4 — pricing_tiers.customer_portal_price = 249', () => {
  it('every plan now has customer_portal_price = 249 (not the legacy 49)', async () => {
    const tiers = await prisma.pricingTier.findMany({
      select: { plan: true, customerPortalPrice: true },
    });
    expect(tiers.length).toBeGreaterThanOrEqual(5);
    for (const t of tiers) {
      expect(Number(t.customerPortalPrice)).toBe(249);
    }
  });

  it('seed.ts source has the new ₹249 constant (and not a stale ₹49)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts'),
      'utf-8',
    );
    expect(src).toMatch(/customerPortalPrice:\s*249/);
    // The legacy ₹49 may live only in a comment that explains the bump;
    // the assertion below catches a slip back to an actual code literal.
    const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codeOnly).not.toMatch(/customerPortalPrice:\s*49\b/);
  });
});

describe('Issue 8 — Business plan maps to tier_3 in DB', () => {
  it('all distributors on the business plan have billing_tier = tier_3', async () => {
    const businessDistributors = await prisma.distributor.findMany({
      where: { subscriptionPlan: 'business', deletedAt: null },
      select: { id: true, businessName: true, billingTier: true },
    });
    // seed.ts seeds 2 business-plan distributors (dist-001 + dist-002).
    // A previous bound of ≥3 passed only on dev DBs with a leaked row and
    // failed in CI's fresh-seed state. The substantive assertion is the
    // loop below — guard against an empty query that would silently no-op.
    expect(businessDistributors.length).toBeGreaterThanOrEqual(1);
    for (const d of businessDistributors) {
      expect(d.billingTier).toBe('tier_3');
    }
  });

  it('seed.ts no longer writes the stale tier_2 for business-plan rows', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'prisma', 'seed.ts'),
      'utf-8',
    );
    const demo = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'prisma', 'seed-demo.ts'),
      'utf-8',
    );
    // Both files should reference tier_3 next to subscriptionPlan: 'business'.
    // Tolerate whitespace + comments between the two literals.
    expect(src).toMatch(/subscriptionPlan:\s*['"]business['"][\s\S]{0,400}billingTier:\s*['"]tier_3['"]/);
    expect(demo).toMatch(/subscriptionPlan:\s*['"]business['"][\s\S]{0,400}billingTier:\s*['"]tier_3['"]/);
  });

  it('deriveBillingTierFromPlan agrees with the seed (business → tier_3)', async () => {
    // The mapping function is the source of truth at runtime — pin it
    // so a future renamer can't drift seed and code apart.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'services', 'billingService.ts'),
      'utf-8',
    );
    expect(src).toMatch(/case\s*['"]business['"]:\s*return\s*['"]tier_3['"]/);
  });
});
