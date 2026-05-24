/**
 * WI-109 — block zero-qty delivery (server-side validation).
 *
 * deliveryConfirmationSchema must reject an all-zero delivery (nothing handed
 * over → the order should be cancelled by an admin, not "delivered") while
 * still allowing legitimate partial deliveries where some items are 0 as long
 * as at least one item is > 0. This guards the server even if the mobile
 * pre-submit check is bypassed.
 *
 * Schema-level test against the built @gaslink/shared artifact — the route
 * (POST /orders/:id/confirm-delivery) runs this exact schema through
 * validate() (orders.ts:393), and the happy path is exercised by the existing
 * workflow / gst-invoicing integration tests.
 */
import { describe, it, expect } from 'vitest';
import { deliveryConfirmationSchema } from '@gaslink/shared';

const CYL_A = '11111111-1111-1111-1111-111111111111';
const CYL_B = '22222222-2222-2222-2222-222222222222';

describe('WI-109 — deliveryConfirmationSchema zero-qty guard', () => {
  it('✅ single item delivered qty 1 is accepted', () => {
    const r = deliveryConfirmationSchema.safeParse({
      items: [{ cylinderTypeId: CYL_A, deliveredQuantity: 1, emptiesCollected: 0 }],
    });
    expect(r.success).toBe(true);
  });

  it('✅ partial delivery (one item 0, one > 0) is accepted', () => {
    const r = deliveryConfirmationSchema.safeParse({
      items: [
        { cylinderTypeId: CYL_A, deliveredQuantity: 0, emptiesCollected: 1 },
        { cylinderTypeId: CYL_B, deliveredQuantity: 2, emptiesCollected: 0 },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('❌ all-zero delivery is rejected with a readable message', () => {
    const r = deliveryConfirmationSchema.safeParse({
      items: [
        { cylinderTypeId: CYL_A, deliveredQuantity: 0, emptiesCollected: 2 },
        { cylinderTypeId: CYL_B, deliveredQuantity: 0, emptiesCollected: 0 },
      ],
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => /at least one item/i.test(i.message))).toBe(true);
    }
  });

  it('❌ single item delivered qty 0 is rejected', () => {
    const r = deliveryConfirmationSchema.safeParse({
      items: [{ cylinderTypeId: CYL_A, deliveredQuantity: 0, emptiesCollected: 0 }],
    });
    expect(r.success).toBe(false);
  });
});
