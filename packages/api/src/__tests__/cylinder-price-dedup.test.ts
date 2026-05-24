import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createPrice, getEffectivePrice } from '../services/cylinderTypeService.js';

// WI-133: duplicate cylinder prices for the same (distributor, type, date)
// made getEffectivePrice non-deterministic. createPrice now find-or-updates,
// and getEffectivePrice has a createdAt tie-break for legacy duplicates.
describe('WI-133 — duplicate price prevention', () => {
  const DIST = 'dist-002';
  let cylinderTypeId: string;
  const EFF_DATE = '2099-06-01';

  beforeAll(async () => {
    const cyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: DIST } });
    cylinderTypeId = cyl.id;
  });

  afterAll(async () => {
    await prisma.cylinderPrice.deleteMany({
      where: { distributorId: DIST, cylinderTypeId, effectiveDate: new Date(EFF_DATE) },
    });
  });

  it('re-submitting the same effective date overwrites instead of duplicating', async () => {
    await createPrice(DIST, { cylinderTypeId, price: 1000, effectiveDate: EFF_DATE });
    await createPrice(DIST, { cylinderTypeId, price: 1200, effectiveDate: EFF_DATE });

    const rows = await prisma.cylinderPrice.findMany({
      where: { distributorId: DIST, cylinderTypeId, effectiveDate: new Date(EFF_DATE) },
    });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].price)).toBe(1200);

    const effective = await getEffectivePrice(DIST, cylinderTypeId, new Date(EFF_DATE));
    expect(effective).toBe(1200);
  });

  it('getEffectivePrice picks the latest-created row when legacy duplicates exist', async () => {
    // Simulate pre-WI-133 data: two rows, same date, inserted directly.
    await prisma.cylinderPrice.deleteMany({
      where: { distributorId: DIST, cylinderTypeId, effectiveDate: new Date(EFF_DATE) },
    });
    const older = await prisma.cylinderPrice.create({
      data: { distributorId: DIST, cylinderTypeId, price: 800, effectiveDate: new Date(EFF_DATE), createdAt: new Date('2026-01-01') },
    });
    const newer = await prisma.cylinderPrice.create({
      data: { distributorId: DIST, cylinderTypeId, price: 950, effectiveDate: new Date(EFF_DATE), createdAt: new Date('2026-02-01') },
    });

    const effective = await getEffectivePrice(DIST, cylinderTypeId, new Date(EFF_DATE));
    expect(effective).toBe(950);

    await prisma.cylinderPrice.deleteMany({ where: { id: { in: [older.id, newer.id] } } });
  });
});
