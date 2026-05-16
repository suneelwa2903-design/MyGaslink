/**
 * API data extraction tests
 *
 * Pure unit tests for the anti-pattern #9 fix shape:
 *   const { data: xResponse } = useApiQuery<{ x: T[] }>(...);
 *   const x: T[] = xResponse?.x ?? [];
 *
 * This is the pattern that prevents `.map`/`.filter` crashes when an
 * envelope-wrapped API response is consumed by a screen.
 *
 * We extract the selector logic into a pure function and test it in
 * isolation rather than rendering the actual screens — testing
 * React Native components requires a working test renderer + mocks for
 * expo-router / safe-area-context / @tanstack/react-query, which is a
 * much bigger surface area than the bug we want to pin.
 *
 * Selector under test (mirrors the inline code in every screen):
 *   const extract = <K extends string, T>(
 *     response: { [key in K]: T[] } | undefined,
 *     key: K,
 *   ): T[] => response?.[key] ?? [];
 */

function extract<K extends string, T>(
  response: { [key in K]: T[] } | undefined,
  key: K,
): T[] {
  return response?.[key] ?? [];
}

interface MockOrder {
  orderId: string;
  orderNumber: string;
}

interface MockInvoice {
  invoiceId: string;
  total: number;
}

interface MockCylinderType {
  id: string;
  typeName: string;
}

describe('API response shape extraction', () => {
  test('1. { orders: [mockOrder] } → orders array extracted correctly', () => {
    const mockOrder: MockOrder = { orderId: 'o-1', orderNumber: 'ORD-001' };
    const response = { orders: [mockOrder] };
    const orders = extract(response, 'orders');
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe('o-1');
    // The result is iterable — calling .map on it must not throw, which
    // is the exact crash the anti-pattern fix prevents.
    expect(orders.map((o) => o.orderNumber)).toEqual(['ORD-001']);
  });

  test('2. undefined response → ?? [] fallback gives empty array', () => {
    // This is the case during the initial load before TanStack Query has
    // resolved — `data` is undefined, the selector must yield [] so
    // downstream `.map` / `.length` works without a guard.
    const orders = extract(undefined as { orders: MockOrder[] } | undefined, 'orders');
    expect(orders).toEqual([]);
    expect(orders).toHaveLength(0);
    expect(() => orders.map((o) => o.orderNumber)).not.toThrow();
  });

  test('3. { invoices: [mockInvoice] } → invoices extracted correctly', () => {
    const mockInvoice: MockInvoice = { invoiceId: 'inv-1', total: 1200 };
    const response = { invoices: [mockInvoice] };
    const invoices = extract(response, 'invoices');
    expect(invoices).toHaveLength(1);
    expect(invoices[0].invoiceId).toBe('inv-1');
    expect(invoices.reduce((sum, i) => sum + i.total, 0)).toBe(1200);
  });

  test('4. { cylinderTypes: [mock] } → extracted correctly', () => {
    const mockCt: MockCylinderType = { id: 'ct-1', typeName: '19 KG' };
    const response = { cylinderTypes: [mockCt] };
    const cylinderTypes = extract(response, 'cylinderTypes');
    expect(cylinderTypes).toHaveLength(1);
    expect(cylinderTypes[0].typeName).toBe('19 KG');
  });

  test('5. empty array in response → extracted as empty array (not undefined)', () => {
    // Edge case worth pinning: a successful API response with zero rows
    // returns `{ orders: [] }`. The selector must yield `[]`, not `undefined`.
    const response = { orders: [] as MockOrder[] };
    const orders = extract(response, 'orders');
    expect(orders).toEqual([]);
    expect(Array.isArray(orders)).toBe(true);
  });
});
