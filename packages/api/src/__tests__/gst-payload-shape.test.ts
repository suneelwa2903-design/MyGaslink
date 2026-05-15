/**
 * IRN / EWB payload shape validation.
 *
 * These tests run buildIrnPayload directly against synthetic
 * InvoiceData fixtures and assert the SHAPE of the returned payload
 * — field names, lengths, formats, required keys. They never touch
 * the database, never call WhiteBooks, and never spin up an Express
 * app.
 *
 * Why this file exists (see CLAUDE.md anti-patterns):
 *   Mocked unit + integration tests cover service logic but never
 *   see the raw payload NIC actually validates. A bug like
 *   "TransDocDt: '' " slips past every mock-based test and only
 *   surfaces on the first live dispatch — at which point the
 *   distributor is stuck on the depot floor.
 *
 * The rule for every external-API integration (WhiteBooks, NIC,
 * any future GSP / payment-gateway / etc.) is: add payload-shape
 * tests alongside the logic tests. They run in CI and catch format
 * bugs in seconds.
 */

import { describe, it, expect } from 'vitest';
import { buildIrnPayload, buildEwbPayload } from '../services/gst/payloadBuilders.js';

/**
 * Minimal B2B invoice fixture with transport details — exercises the
 * inline-EWB path (EwbDtls block populated). Returns plain JS data;
 * no Prisma, no DB.
 */
function b2bFixture(overrides: Partial<Parameters<typeof buildIrnPayload>[0]> = {}) {
  return {
    docType: 'INV' as const,
    docNumber: 'INV-MP6QW1RV8HJ', // 15 chars, valid for both InvNo and TransDocNo
    docDate: new Date('2026-05-15T00:00:00Z'),
    seller: {
      gstin: '29AAGCB1286Q000',
      legalName: 'Sharma Gas Distributors',
      tradeName: 'Sharma Gas',
      address: '123 Depot Road',
      city: 'Bangalore',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000000',
      email: 'sharma@gasdist.com',
    },
    buyer: {
      gstin: '29AWGPV7107B1Z1',
      legalName: 'Maruthi Agencies',
      tradeName: 'Maruthi',
      address: '45 Customer Lane',
      city: 'Bangalore',
      pincode: '560041',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000001',
      email: 'maruthi@example.com',
    },
    items: [{
      slNo: 1,
      description: '19 KG LPG Cylinder',
      hsnCode: '27111900',
      quantity: 5,
      unit: 'NOS',
      unitPrice: 2000,
      discountPerUnit: 0,
      gstRate: 18,
    }],
    isInterState: false,
    transport: {
      vehicleNumber: 'KA01MN9999',
      transportMode: '1' as const,
      distance: 0,
      transDocNo: 'ORD-MP6QW1RV8HJ', // 15 chars
      transDocDt: '15/05/2026',
    },
    ...overrides,
  };
}

describe('IRN payload shape validation', () => {
  it('Test 1 — transDocNo length is between 1 and 15 chars', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(payload.EwbDtls).toBeTruthy();
    expect(typeof payload.EwbDtls.Transdocno).toBe('string');
    expect(payload.EwbDtls.Transdocno.length).toBeGreaterThanOrEqual(1);
    expect(payload.EwbDtls.Transdocno.length).toBeLessThanOrEqual(15);
  });

  it('Test 1b — transDocNo is truncated when caller passes >15 chars', () => {
    const payload = buildIrnPayload(b2bFixture({
      transport: {
        vehicleNumber: 'KA01MN9999',
        transportMode: '1',
        distance: 0,
        transDocNo: 'ORD-LORRY-RECEIPT-WAY-TOO-LONG-FOR-NIC',
        transDocDt: '15/05/2026',
      },
    }));
    expect(payload.EwbDtls.Transdocno.length).toBeLessThanOrEqual(15);
  });

  it('Test 1c — transDocNo falls back to docNumber when not supplied', () => {
    const payload = buildIrnPayload(b2bFixture({
      transport: {
        vehicleNumber: 'KA01MN9999',
        transportMode: '1',
        distance: 0,
        transDocDt: '15/05/2026',
        // transDocNo intentionally omitted
      },
    }));
    expect(payload.EwbDtls.Transdocno.length).toBeGreaterThanOrEqual(1);
    expect(payload.EwbDtls.Transdocno.length).toBeLessThanOrEqual(15);
  });

  it('Test 2 — transDocDt is exactly DD/MM/YYYY (10 chars)', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(typeof payload.EwbDtls.TransdocDt).toBe('string');
    expect(payload.EwbDtls.TransdocDt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(payload.EwbDtls.TransdocDt.length).toBe(10);
  });

  it('Test 2b — transDocDt defaults to docDate when caller omits it', () => {
    const payload = buildIrnPayload(b2bFixture({
      transport: {
        vehicleNumber: 'KA01MN9999',
        transportMode: '1',
        distance: 0,
        transDocNo: 'ORD-MP6QW1RV8HJ',
        // transDocDt omitted
      },
    }));
    expect(payload.EwbDtls.TransdocDt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(payload.EwbDtls.TransdocDt.length).toBe(10);
  });

  it('Test 3 — transMode is "1" (road transport) by default', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(payload.EwbDtls.TransMode).toBe('1');
  });

  it('Test 4 — VehNo is non-empty when vehicle is assigned', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(typeof payload.EwbDtls.Vehno).toBe('string');
    expect(payload.EwbDtls.Vehno.length).toBeGreaterThan(0);
    expect(payload.EwbDtls.Vehno.length).toBeLessThanOrEqual(15);
    // VehNo is sanitised to alphanumeric uppercase by buildIrnPayload
    expect(payload.EwbDtls.Vehno).toMatch(/^[A-Z0-9]+$/);
  });

  it('Test 4b — EwbDtls block is omitted entirely when no transport is provided', () => {
    const payload = buildIrnPayload(b2bFixture({ transport: undefined }));
    expect(payload.EwbDtls).toBeUndefined();
  });

  it('Test 5 — required IRN top-level fields are all present', () => {
    const payload = buildIrnPayload(b2bFixture());
    // NIC schema (per WhiteBooks Postman collection) requires every
    // one of these. Missing any is an instant 5xxx rejection.
    expect(payload.TranDtls).toBeTruthy();
    expect(payload.DocDtls).toBeTruthy();
    expect(payload.SellerDtls).toBeTruthy();
    expect(payload.BuyerDtls).toBeTruthy();
    expect(payload.ItemList).toBeTruthy();
    expect(payload.ValDtls).toBeTruthy();
    // EwbDtls is conditional (present only when transport supplied),
    // but for the b2bFixture above it must be set.
    expect(payload.EwbDtls).toBeTruthy();
  });

  it('Test 5b — DocDtls contains No / Dt / Typ in correct shapes', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(typeof payload.DocDtls.No).toBe('string');
    expect(payload.DocDtls.No.length).toBeGreaterThan(0);
    expect(payload.DocDtls.No.length).toBeLessThanOrEqual(16); // NIC InvNo max
    expect(typeof payload.DocDtls.Dt).toBe('string');
    expect(payload.DocDtls.Dt).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
    expect(['INV', 'CRN', 'DBN']).toContain(payload.DocDtls.Typ);
  });

  it('Test 5c — TranDtls.SupTyp correctly reflects B2B vs B2C', () => {
    const b2b = buildIrnPayload(b2bFixture());
    expect(['B2B', 'SEZWP', 'SEZWOP', 'EXPWP', 'EXPWOP']).toContain(b2b.TranDtls.SupTyp);

    const b2c = buildIrnPayload(b2bFixture({
      buyer: { ...b2bFixture().buyer, gstin: null },
    }));
    expect(b2c.TranDtls.SupTyp).toBe('B2C');
  });

  it('Test 5d — ItemList is a non-empty array with HsnCd as string', () => {
    const payload = buildIrnPayload(b2bFixture());
    expect(Array.isArray(payload.ItemList)).toBe(true);
    expect(payload.ItemList.length).toBeGreaterThanOrEqual(1);
    // HSN must be string per NIC schema (numeric works in dev but fails
    // on stricter validators — caught us once already).
    expect(typeof payload.ItemList[0].HsnCd).toBe('string');
  });
});

describe('Standalone EWB payload shape validation', () => {
  it('transDocNo is non-empty and within 15 chars', () => {
    const irn = buildIrnPayload(b2bFixture());
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'KA01MN9999',
      transportMode: '1',
      distance: 1,
    });
    expect(typeof ewb.transDocNo).toBe('string');
    expect(ewb.transDocNo.length).toBeGreaterThanOrEqual(1);
    expect(ewb.transDocNo.length).toBeLessThanOrEqual(15);
  });

  it('transDocDate matches DD/MM/YYYY', () => {
    const irn = buildIrnPayload(b2bFixture());
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'KA01MN9999',
      transportMode: '1',
      distance: 1,
    });
    expect(ewb.transDocDate).toMatch(/^\d{2}\/\d{2}\/\d{4}$/);
  });

  it('transMode defaults to "1" (road) and transDistance is >=1 string', () => {
    const irn = buildIrnPayload(b2bFixture());
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'KA01MN9999',
      // transportMode omitted
      distance: 0, // EWB-side clamps to 1 (0 triggers NIC error 721)
    });
    expect(ewb.transMode).toBe('1');
    expect(typeof ewb.transDistance).toBe('string');
    expect(parseInt(ewb.transDistance, 10)).toBeGreaterThanOrEqual(1);
  });

  it('vehicleNo is sanitised to uppercase alphanumeric, max 15 chars', () => {
    const irn = buildIrnPayload(b2bFixture());
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'ka 01-mn / 9999',
      transportMode: '1',
      distance: 1,
    });
    expect(ewb.vehicleNo).toMatch(/^[A-Z0-9]+$/);
    expect(ewb.vehicleNo.length).toBeLessThanOrEqual(15);
  });
});
