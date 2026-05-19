/**
 * WI-071 — B2C EWB toGstin=URP + phantom-active guard + B2C PDF EWB rendering.
 *
 * Live failure (ORD-MPCDVUO1USY, INV-MPCDW7DR6F7, 2026-05-19):
 *   - Customer: Bangalore Foods, B2C, no GSTIN, pincode 560001
 *   - Depot:    Sharma Gas Distributors, GSTIN 29AAGCB1286Q000, pincode 560001
 *   - Dispatch EWB_GENERATE_STANDALONE → NIC error 611
 *   - Post-delivery EWB_GENERATE_B2C   → {"status_cd":"1","status_desc":"Sucess"}
 *     with NO `data` field / NO `ewayBillNo`. System still marked
 *     `ewb_status='active'` + `ewb_no=NULL` (phantom EWB).
 *
 * Defect A — toGstin == fromGstin for B2C
 *   buildEwbPayload (payloadBuilders.ts) used to send seller.Gstin as
 *   toGstin / shipToGSTIN for B2C. Under transactionType=1 ("Regular"
 *   = single recipient, Bill-To == Ship-To, distinct buyer from
 *   seller), NIC intermittently rejects with 611 when recipient
 *   GSTIN equals dispatcher GSTIN. Fix: use 'URP' for B2C — matches
 *   the IRN payload's existing BuyerDtls.Gstin convention.
 *
 * Defect B — phantom-active EWB on empty Sucess response
 *   gstService.processInvoiceGst B2C branch used to unconditionally
 *   mark `ewb_status='active'`. Fix: when status_cd=1 but no
 *   ewayBillNo, mark failed + raise pending action.
 *
 * B2C invoice PDF — verifies the invoice PDF correctly shows the
 *   EWB number for B2C invoices (when one exists in gst_documents)
 *   AND omits the IRN block (since B2C never generates an IRN).
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import PDFDocument from 'pdfkit';
import { buildIrnPayload, buildEwbPayload } from '../services/gst/payloadBuilders.js';
import { generateInvoicePdf } from '../services/pdf/invoicePdfService.js';
import { prisma } from '../lib/prisma.js';

/**
 * Mirror the live 2026-05-19 ORD-MPCDVUO1USY payload exactly.
 * Both seller and buyer are in Bangalore (29 = Karnataka, pincode
 * 560001), and the customer (Bangalore Foods) has no GSTIN — the
 * classic B2C / URP shape.
 */
function bangaloreFoodsB2cFixture() {
  return {
    docType: 'INV' as const,
    docNumber: 'INV-MPCDW7DR6F7',
    docDate: new Date('2026-05-19T00:00:00Z'),
    seller: {
      gstin: '29AAGCB1286Q000',
      legalName: 'Sharma Gas Distributors',
      tradeName: 'Sharma Gas Distributors',
      address: '56 MG Road, Bangalore',
      city: 'Bangalore',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000000',
      email: 'sharma@gasdist.com',
    },
    buyer: {
      gstin: null,  // ← B2C: no GSTIN
      legalName: 'Bangalore Foods',
      tradeName: 'Bangalore Foods',
      address: '10 Brigade Road',
      city: 'Bangalore',
      pincode: '560001',
      state: 'Karnataka',
      stateCode: '29',
      phone: '9800000001',
      email: 'foods@example.com',
    },
    items: [{
      slNo: 1,
      description: '19 KG LPG Cylinder',
      hsnCode: '27111900',
      quantity: 1,
      unit: 'NOS',
      unitPrice: 1694.92,
      discountPerUnit: 0,
      gstRate: 18,
    }],
    isInterState: false,
  };
}

describe('WI-071 investigation — B2C EWB toGstin should be URP, not seller GSTIN', () => {
  it('IRN payload (correct): BuyerDtls.Gstin is "URP" for B2C', () => {
    // Sanity check on existing correct behaviour. The IRN payload
    // already encodes URP for B2C buyers — proves URP is a legal
    // sentinel in our payload-builder vocabulary; EWB just doesn't
    // use it consistently.
    const irn = buildIrnPayload(bangaloreFoodsB2cFixture());
    expect(irn.TranDtls.SupTyp).toBe('B2C');
    expect(irn.BuyerDtls.Gstin).toBe('URP');
  });

  it('Defect A regression guard — B2C EWB toGstin must NEVER equal fromGstin', () => {
    // Pre-WI-071: toGstin/shipToGSTIN both contained seller.Gstin for
    // B2C. That equals fromGstin, contradicting transactionType=1
    // "Regular = distinct recipient" semantics, and NIC sandbox
    // returned 611 intermittently. This test pins the post-fix shape.
    const irn = buildIrnPayload(bangaloreFoodsB2cFixture());
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'KA01MN9999',
      transportMode: '1',
      distance: 1,
    });
    expect(ewb.toGstin).toBe('URP');
    expect(ewb.shipToGSTIN).toBe('URP');
    expect(ewb.fromGstin).toBe('29AAGCB1286Q000');
    expect(ewb.dispatchFromGSTIN).toBe('29AAGCB1286Q000');
    expect(ewb.toGstin).not.toBe(ewb.fromGstin);
  });

  it('B2B EWB is unchanged: toGstin = buyer GSTIN', () => {
    // Regression guard. The fix must touch B2C only; B2B routes a
    // real customer GSTIN through to NIC.
    const b2bFixture = {
      ...bangaloreFoodsB2cFixture(),
      buyer: {
        ...bangaloreFoodsB2cFixture().buyer,
        gstin: '36AAGCB1286Q004', // real buyer GSTIN (Hyderabad customer)
        legalName: 'Hyderabad Caterers',
        tradeName: 'Hyderabad Caterers',
      },
    };
    const irn = buildIrnPayload(b2bFixture);
    const ewb = buildEwbPayload(irn, {
      vehicleNumber: 'KA01MN9999',
      transportMode: '1',
      distance: 1,
    });
    expect(ewb.toGstin).toBe('36AAGCB1286Q004');
    expect(ewb.shipToGSTIN).toBe('36AAGCB1286Q004');
  });
});

// ─── WI-071 — B2C invoice PDF EWB rendering ──────────────────────────────────

/**
 * Spy on PDFDocument.prototype.text to capture every string drawn into
 * the PDF. pdfkit compresses content streams in the output buffer, so
 * a raw byte regex won't match — the spy is the reliable way. Pattern
 * borrowed from gst-trip-sheet-dn-pdf.test.ts.
 */
function spyDrawnStrings() {
  const drawn: string[] = [];
  const original = PDFDocument.prototype.text;
  const spy = vi.spyOn(PDFDocument.prototype as any, 'text').mockImplementation(
    function (this: any, str: any, ...rest: any[]) {
      if (typeof str === 'string') drawn.push(str);
      return original.call(this, str, ...rest);
    },
  );
  return { drawn, spy };
}

describe('WI-071 — B2C invoice PDF shows EWB number, omits IRN block', () => {
  const distributorId = 'dist-002';
  const cleanup: { orderId?: string; invoiceId?: string; gstDocId?: string } = {};

  afterAll(async () => {
    if (cleanup.gstDocId) {
      await prisma.gstDocument.deleteMany({ where: { id: cleanup.gstDocId } });
    }
    if (cleanup.invoiceId) {
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: cleanup.invoiceId } });
      await prisma.invoice.deleteMany({ where: { id: cleanup.invoiceId } });
    }
    if (cleanup.orderId) {
      await prisma.orderItem.deleteMany({ where: { orderId: cleanup.orderId } });
      await prisma.order.deleteMany({ where: { id: cleanup.orderId } });
    }
  });

  it('B2C invoice PDF contains "EWB No: <number>" and omits IRN/Ack labels', async () => {
    // Seed a B2C invoice with a realistic gst_documents row (ewbNo
    // set, irn null) and run it through the actual generateInvoicePdf
    // pipeline. The spy collects every string drawn into the PDF.
    const customer = await prisma.customer.findFirstOrThrow({
      where: { distributorId, customerType: 'B2C', deletedAt: null },
    });
    const cyl = await prisma.cylinderType.findFirstOrThrow({
      where: { distributorId, typeName: '19 KG' },
    });

    const order = await prisma.order.create({
      data: {
        distributorId,
        customerId: customer.id,
        orderNumber: `WI071-PDF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        orderDate: new Date('2099-12-31'),
        deliveryDate: new Date('2099-12-31'),
        status: 'delivered',
        orderType: 'delivery',
        totalAmount: 2000,
        items: { create: [{ cylinderTypeId: cyl.id, quantity: 1, unitPrice: 2000, totalPrice: 2000 }] },
      },
    });
    cleanup.orderId = order.id;

    const invoice = await prisma.invoice.create({
      data: {
        distributorId,
        customerId: customer.id,
        orderId: order.id,
        invoiceNumber: `WI071-INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        issueDate: new Date('2099-12-31'),
        dueDate: new Date('2099-12-31'),
        totalAmount: 2000,
        amountPaid: 0,
        outstandingAmount: 2000,
        status: 'issued',
        cgstValue: 152.54,
        sgstValue: 152.54,
        igstValue: 0,
        irnStatus: 'not_attempted',       // ← B2C: IRN never attempted
        ewbStatus: 'active',
        items: {
          create: [{ cylinderTypeId: cyl.id, description: '19 KG', hsnCode: '27111900', quantity: 1, unitPrice: 1694.92, totalPrice: 2000, gstRate: 18 }],
        },
      },
    });
    cleanup.invoiceId = invoice.id;

    const gstDoc = await prisma.gstDocument.create({
      data: {
        invoiceId: invoice.id,
        orderId: order.id,
        distributorId,
        docType: 'INV',
        gstDocNo: invoice.invoiceNumber,
        ewbNo: 'WI071EWB12345',
        ewbStatus: 'active',
        ewbDate: new Date('2099-12-31'),
        ewbValidTill: new Date('2099-12-31'),
        // irn / ackNo / ackDate / signedQr all null — this is B2C
        isLatest: true,
      },
    });
    cleanup.gstDocId = gstDoc.id;

    const { drawn, spy } = spyDrawnStrings();
    try {
      const pdf = await generateInvoicePdf(invoice.id, distributorId);
      expect(pdf.slice(0, 4).toString()).toBe('%PDF');

      // Header line + e-Documents card both reference the EWB number.
      const ewbStrings = drawn.filter((s) => s.includes('WI071EWB12345'));
      expect(ewbStrings.length).toBeGreaterThanOrEqual(1);

      const ewbHeaderLine = drawn.find((s) => s.startsWith('EWB No:'));
      expect(ewbHeaderLine).toBeDefined();
      expect(ewbHeaderLine).toContain('WI071EWB12345');

      // The e-Documents section title appears (proves drawComplianceSection ran)
      expect(drawn).toContain('e-Documents');
      expect(drawn).toContain('E-Waybill (EWB)');

      // IRN block must be entirely absent for B2C.
      // pdfkit emits the section card title 'e-Invoice (IRN)' AND the
      // 'IRN:' / 'Ack No:' / 'Ack Date:' labels when an IRN exists.
      // Asserting none of those strings appear catches accidental
      // future regressions where someone wires IRN rendering to also
      // fire for B2C invoices.
      expect(drawn).not.toContain('e-Invoice (IRN)');
      expect(drawn).not.toContain('IRN:');
      expect(drawn).not.toContain('Ack No:');
      expect(drawn).not.toContain('Ack Date:');
    } finally {
      spy.mockRestore();
    }
  });
});
