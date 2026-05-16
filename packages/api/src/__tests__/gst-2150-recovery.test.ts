/**
 * WI-057 gap G2 — 2150 (duplicate IRN) recovery via GETIRNBYDOCDETAILS.
 *
 * When NIC says "IRN already exists for this docNo/docType/docDate",
 * we now look up the actual IRN value from the portal and persist it
 * onto the invoice + a gst_documents row. Without this, irnStatus
 * stays 'success' but invoice.irn is NULL, and every downstream
 * feature (PDF, EWB recovery, CN/DN linkage) silently breaks.
 *
 * vi.mock the apiCall so we can simulate:
 *   - IRN GENERATE → throws GstError('...', '2150')
 *   - GETIRNBYDOCDETAILS → returns the existing IRN
 *   - GETIRNBYDOCDETAILS → also throws (degraded path)
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const { apiCallMock } = vi.hoisted(() => ({ apiCallMock: vi.fn() }));

vi.mock('../services/gst/whitebooksClient.js', async (orig) => {
  const original: any = await orig();
  return {
    ...original,
    apiCall: apiCallMock,
    getAuthToken: vi.fn(async () => 'fake-token'),
    getCredentials: vi.fn(async () => ({
      clientId: 'TEST-CLIENT',
      clientSecret: 'TEST-SECRET',
      username: 'TEST',
      password: 'TEST',
      gstin: '29AAGCB1286Q000',
      email: 'test@mygaslink.com',
      baseUrl: 'https://apisandbox.whitebooks.in',
    })),
  };
});

import { prisma } from '../lib/prisma.js';
import { processInvoiceGst, getIrnByDocDetails } from '../services/gst/gstService.js';
import { GstError } from '../services/gst/whitebooksClient.js';

let invoiceId: string;

beforeAll(async () => {
  // Find a Sharma B2B invoice with a value > 0 — same fixture as the
  // other GST tests. We mutate it within each test and restore at the end.
  const inv = await prisma.invoice.findFirstOrThrow({
    where: {
      distributorId: 'dist-002',
      deletedAt: null,
      status: { not: 'cancelled' },
      totalAmount: { gt: 1000 },
      customer: { gstin: { not: null } },
    },
    orderBy: { createdAt: 'asc' },
  });
  invoiceId = inv.id;
});

beforeEach(async () => {
  apiCallMock.mockReset();
  // Reset the invoice's IRN state so each test starts from "not attempted".
  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { irn: null, ackNo: null, ackDate: null, irnStatus: 'not_attempted' },
  });
  // Clear any gst_documents row from prior runs.
  await prisma.gstDocument.deleteMany({ where: { invoiceId, irn: { startsWith: 'WI057' } } });
});

describe('WI-057 G2 — getIrnByDocDetails formats param1 correctly', () => {
  it('builds the docType:docNo:DD/MM/YYYY query string and returns parsed fields', async () => {
    const expectedIrn = 'WI057' + 'a'.repeat(59);
    apiCallMock.mockResolvedValueOnce({
      data: {
        Irn: expectedIrn,
        AckNo: '112612345678901',
        AckDt: '2026-05-16T07:30:00.000Z',
        SignedQRCode: 'fakeqr',
      },
    });

    const docDate = new Date(Date.UTC(2026, 4, 16));  // 16 May 2026
    const out = await getIrnByDocDetails('dist-002', 'INV', 'INV-TEST-DEDUP', docDate);

    expect(out?.irn).toBe(expectedIrn);
    expect(out?.ackNo).toBe('112612345678901');
    expect(out?.signedQr).toBe('fakeqr');

    // Verify the URL contained param1=INV:INV-TEST-DEDUP:16/05/2026 (URL-encoded).
    expect(apiCallMock).toHaveBeenCalled();
    const callArgs = apiCallMock.mock.calls[0];
    const path = callArgs[2] as string;
    expect(path).toContain('GETIRNBYDOCDETAILS');
    // url-encoded colon is %3A; slashes %2F
    expect(decodeURIComponent(path.split('param1=')[1].split('&')[0]))
      .toBe('INV:INV-TEST-DEDUP:16/05/2026');
  });

  it('returns null when NIC response has no Irn field', async () => {
    apiCallMock.mockResolvedValueOnce({ data: { AckNo: 'partial' } });
    const out = await getIrnByDocDetails('dist-002', 'INV', 'X', new Date());
    expect(out).toBeNull();
  });

  it('returns null when the apiCall throws (swallowed + logged)', async () => {
    apiCallMock.mockRejectedValueOnce(new Error('upstream timeout'));
    const out = await getIrnByDocDetails('dist-002', 'INV', 'X', new Date());
    expect(out).toBeNull();
  });
});

describe('WI-057 G2 — processInvoiceGst 2150 path recovers the IRN', () => {
  it('on 2150 it calls GETIRNBYDOCDETAILS and persists the recovered IRN', async () => {
    const recoveredIrn = 'WI057' + 'b'.repeat(59);

    apiCallMock
      // First call: IRN GENERATE → 2150 duplicate
      .mockImplementationOnce(() => { throw new GstError('Duplicate IRN', '2150'); })
      // Second call: GETIRNBYDOCDETAILS → success with the existing IRN
      .mockResolvedValueOnce({
        data: {
          Irn: recoveredIrn,
          AckNo: '112699999999999',
          AckDt: '2026-05-16T07:30:00.000Z',
        },
      })
      // Any subsequent EWB call (the dup-IRN branch tries EWB) → throw a
      // harmless error so we don't have to mock that path too. It's
      // handled in the same try/catch; we only care about the IRN state.
      .mockImplementation(() => { throw new GstError('EWB skipped in test', '999'); });

    await processInvoiceGst(invoiceId, 'dist-002');

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(updated.irn).toBe(recoveredIrn);
    expect(updated.ackNo).toBe('112699999999999');
    expect(updated.irnStatus).toBe('success');

    const gstDoc = await prisma.gstDocument.findFirst({
      where: { invoiceId, isLatest: true },
    });
    expect(gstDoc?.irn).toBe(recoveredIrn);
    expect(gstDoc?.irnStatus).toBe('success');
  });

  it('on 2150 when GETIRNBYDOCDETAILS also fails: irnStatus=success, irn stays null, pending action created', async () => {
    apiCallMock
      .mockImplementationOnce(() => { throw new GstError('Duplicate IRN', '2150'); })
      .mockResolvedValueOnce({ data: {} }) // GETIRNBYDOCDETAILS returns no Irn
      .mockImplementation(() => { throw new GstError('EWB skipped', '999'); });

    await processInvoiceGst(invoiceId, 'dist-002');

    const updated = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
    expect(updated.irnStatus).toBe('success');
    expect(updated.irn).toBeNull();

    const pa = await prisma.pendingAction.findFirst({
      where: {
        distributorId: 'dist-002',
        entityId: invoiceId,
        actionType: 'IRN_GENERATION',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(pa).toBeTruthy();
    expect(pa?.description ?? '').toMatch(/2150/);

    // Cleanup pending action so test reruns stay clean.
    if (pa) await prisma.pendingAction.delete({ where: { id: pa.id } });
  });
});
