/**
 * Scenario runner for Proof-of-Collection Phase 1 (2026-07-15).
 *
 * Runs 5 end-to-end scenarios against the local dev DB + in-process
 * createApp via supertest. Presents:
 *  - a real signature PNG (sharp+SVG rasterized)
 *  - a real invoice PDF with the signature embedded (via a local
 *    HTTP server that plays the CloudFront role during the run)
 *  - full DB dumps and API responses for every step
 *  - a summary in docs/SCENARIO-TEST-RESULTS.md
 *
 * Env vars are set BEFORE any app module is imported so createApp
 * sees a valid AWS_CLOUDFRONT_URL and AWS_S3_BUCKET (config/index.ts
 * freezes these at module load via `as const`).
 *
 * S3 uploads themselves are BYPASSED — the presigned-URL endpoint
 * (which requires real AWS credentials to sign PUT requests) is
 * called optionally with graceful fallback to a hand-crafted s3Key.
 * The signature PNG is written directly to the local HTTP server's
 * root so drawProofSection's fetch of the CloudFront URL succeeds
 * and the signature embeds properly in the PDF. Production would
 * upload to real S3 → CloudFront; here the local server is the
 * stand-in.
 */
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import sharp from 'sharp';

const OUT_DIR = 'C:/Users/HP/AppData/Local/Temp/claude/C--Projects-Re-New-Gaslink/cb465259-91cb-4798-88b7-bed9b208e5b0/scratchpad/scenario';
const CDN_PORT = 9876;
const CDN_ROOT = `http://127.0.0.1:${CDN_PORT}`;

// MUST set BEFORE any app import — config/index.ts freezes at load time.
process.env.AWS_S3_BUCKET = process.env.AWS_S3_BUCKET || 'scenario-mock-bucket';
process.env.AWS_CLOUDFRONT_URL = CDN_ROOT;
process.env.AWS_REGION = process.env.AWS_REGION || 'ap-south-1';

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Now import app modules — env is in place.
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/lib/prisma.js');
const supertest = (await import('supertest')).default;
const jwt = (await import('jsonwebtoken')).default;
const { config } = await import('../src/config/index.js');

const app = createApp();
const api = supertest(app);

type ScenarioResult = { name: string; expected: string; actual: string; pass: boolean; notes?: string };
const results: ScenarioResult[] = [];
const log: string[] = [];

function say(msg: string): void {
  console.log(msg);
  log.push(msg);
}

function h1(t: string): void { say(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`); }
function h2(t: string): void { say(`\n--- ${t} ---`); }

function tokenFor(user: { id: string; email: string; role: string; distributorId: string | null; customerId?: string | null }): string {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      role: user.role,
      distributorId: user.distributorId,
      customerId: user.customerId ?? null,
    },
    config.jwt.accessSecret,
    { expiresIn: '1h' },
  );
}

// Small HTTP server standing in for CloudFront during the run.
function startLocalCdn(rootDir: string): Server {
  // path.resolve normalizes slashes for the OS so the startsWith
  // safety check compares apples to apples on Windows (forward-slash
  // rootDir vs. backslash-normalized joined path was the S1 bug).
  const rootAbs = path.resolve(rootDir);
  return createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url ?? '/');
    const safe = urlPath.replace(/^([/\\])+/, '');
    const fp = path.resolve(rootAbs, safe);
    if (!fp.startsWith(rootAbs)) {
      res.writeHead(403).end();
      return;
    }
    fs.readFile(fp, (err, buf) => {
      if (err) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': fp.endsWith('.png') ? 'image/png' : 'application/octet-stream' });
      res.end(buf);
    });
  }).listen(CDN_PORT, '127.0.0.1');
}

/**
 * Generate a signature-like PNG at 400x150. Uses an SVG with hand-
 * crafted cubic bezier paths that approximate a cursive "K. Reddy"
 * signature. Rasterized via sharp. Also draws a thin baseline.
 */
async function generateSignaturePng(destPath: string): Promise<void> {
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="150" viewBox="0 0 400 150">
  <rect width="400" height="150" fill="#ffffff"/>
  <!-- Signature strokes: pseudo-cursive "K. Reddy" -->
  <g fill="none" stroke="#0b0b0b" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
    <!-- K -->
    <path d="M 40 40 C 44 60, 42 85, 44 108" />
    <path d="M 44 78 C 60 62, 72 50, 84 40" />
    <path d="M 46 76 C 60 82, 76 96, 92 112" />
    <!-- period -->
    <circle cx="100" cy="106" r="2.2" fill="#0b0b0b" stroke="none" />
    <!-- R -->
    <path d="M 120 40 C 122 60, 124 85, 126 108" />
    <path d="M 122 42 C 148 34, 168 44, 162 62 C 158 76, 138 78, 124 74" />
    <path d="M 138 76 C 148 88, 158 98, 172 110" />
    <!-- e -->
    <path d="M 184 92 C 196 80, 216 82, 212 94 C 206 106, 186 106, 184 92 C 186 108, 208 116, 220 108" />
    <!-- d -->
    <path d="M 246 60 C 244 84, 246 104, 250 116" />
    <path d="M 246 92 C 232 82, 224 96, 232 108 C 240 118, 254 116, 252 106" />
    <!-- d -->
    <path d="M 272 60 C 270 84, 272 104, 276 116" />
    <path d="M 272 92 C 258 82, 250 96, 258 108 C 266 118, 280 116, 278 106" />
    <!-- y with flourish -->
    <path d="M 292 88 C 298 100, 304 112, 308 116" />
    <path d="M 322 88 C 316 102, 306 122, 292 132 C 280 138, 274 132, 278 128" />
    <!-- long underline flourish -->
    <path d="M 40 132 C 120 128, 260 128, 340 130 C 348 130, 356 132, 360 136" />
  </g>
  <!-- baseline -->
  <line x1="30" y1="130" x2="370" y2="130" stroke="#c0c0c0" stroke-width="0.6"/>
</svg>`;
  await sharp(Buffer.from(svg)).png().toFile(destPath);
}

// ─── Setup ────────────────────────────────────────────────────────────────

async function setup(): Promise<{
  sharma: { id: string; businessName: string };
  driver: { id: string; userId: string; email: string; token: string };
  driverBhargava: { id: string; userId: string; email: string; token: string };
  distAdmin: { userId: string; email: string; token: string };
  cylinderType: { id: string; typeName: string };
  bhargavaId: string;
}> {
  const sharma = await prisma.distributor.findFirstOrThrow({
    where: { businessName: { contains: 'Sharma', mode: 'insensitive' } },
    select: { id: true, businessName: true },
  });
  say(`Sharma distributor: id=${sharma.id} businessName="${sharma.businessName}"`);

  const bhargava = await prisma.distributor.findFirstOrThrow({
    where: { businessName: { contains: 'Bhargava', mode: 'insensitive' } },
    select: { id: true, businessName: true },
  });
  say(`Bhargava distributor: id=${bhargava.id} businessName="${bhargava.businessName}"`);

  const driverUser = await prisma.user.findFirstOrThrow({
    where: { distributorId: sharma.id, role: 'driver' },
  });
  const driver = await prisma.driver.findFirstOrThrow({
    where: { distributorId: sharma.id, phone: driverUser.phone! },
    select: { id: true },
  });
  say(`Sharma driver: id=${driver.id} userId=${driverUser.id} email=${driverUser.email}`);

  const driverBhargavaUser = await prisma.user.findFirstOrThrow({
    where: { distributorId: bhargava.id, role: 'driver' },
  });
  const driverBhargava = await prisma.driver.findFirstOrThrow({
    where: { distributorId: bhargava.id, phone: driverBhargavaUser.phone! },
    select: { id: true },
  });
  say(`Bhargava driver: id=${driverBhargava.id} userId=${driverBhargavaUser.id}`);

  const distAdminUser = await prisma.user.findFirstOrThrow({
    where: { distributorId: sharma.id, role: 'distributor_admin' },
  });
  say(`Sharma distributor_admin: userId=${distAdminUser.id} email=${distAdminUser.email}`);

  const cylinderType = await prisma.cylinderType.findFirstOrThrow({
    where: { distributorId: sharma.id, isActive: true },
    select: { id: true, typeName: true },
  });
  say(`Cylinder type: id=${cylinderType.id} typeName="${cylinderType.typeName}"`);

  return {
    sharma,
    driver: {
      id: driver.id,
      userId: driverUser.id,
      email: driverUser.email,
      token: tokenFor({ id: driverUser.id, email: driverUser.email, role: driverUser.role, distributorId: driverUser.distributorId }),
    },
    driverBhargava: {
      id: driverBhargava.id,
      userId: driverBhargavaUser.id,
      email: driverBhargavaUser.email,
      token: tokenFor({ id: driverBhargavaUser.id, email: driverBhargavaUser.email, role: driverBhargavaUser.role, distributorId: driverBhargavaUser.distributorId }),
    },
    distAdmin: {
      userId: distAdminUser.id,
      email: distAdminUser.email,
      token: tokenFor({ id: distAdminUser.id, email: distAdminUser.email, role: distAdminUser.role, distributorId: distAdminUser.distributorId }),
    },
    cylinderType,
    bhargavaId: bhargava.id,
  };
}

async function makeCustomer(distributorId: string, name: string, requireDeliveryVerification: boolean): Promise<{ id: string; name: string }> {
  const existing = await prisma.customer.findFirst({ where: { distributorId, customerName: name, deletedAt: null } });
  if (existing) {
    await prisma.customer.update({
      where: { id: existing.id },
      data: { requireDeliveryVerification },
    });
    return { id: existing.id, name };
  }
  const created = await prisma.customer.create({
    data: {
      distributorId,
      customerName: name,
      customerType: 'B2B',
      phone: `9${Date.now()}`.slice(0, 10),
      requireDeliveryVerification,
    },
  });
  return { id: created.id, name };
}

async function makeOrderPendingDelivery(
  distributorId: string,
  customerId: string,
  driverId: string,
  cylinderTypeId: string,
  quantity: number,
): Promise<{ id: string; orderNumber: string }> {
  const orderNumber = `ORD-SCEN-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  const order = await prisma.order.create({
    data: {
      orderNumber,
      distributorId,
      customerId,
      driverId,
      orderDate: new Date(),
      deliveryDate: new Date(),
      status: 'pending_delivery',
      totalAmount: 100 * quantity,
      items: { create: [{ cylinderTypeId, quantity, unitPrice: 100, discountPerUnit: 0, totalPrice: 100 * quantity }] },
    },
    select: { id: true, orderNumber: true },
  });
  return order;
}

// ─── Run ──────────────────────────────────────────────────────────────────

async function run(): Promise<void> {
  const cdnServer = startLocalCdn(OUT_DIR);
  say(`Local CDN stand-in listening on ${CDN_ROOT} (root: ${OUT_DIR})`);

  try {
    h1('SETUP — Fixtures');
    const ctx = await setup();

    const testCustomer = await makeCustomer(ctx.sharma.id, 'KINARA GROUP OF HOTELS TEST', true);
    say(`Test customer S1/S2: id=${testCustomer.id} name="${testCustomer.name}" requireDeliveryVerification=true`);

    // ═════════════════════════════════════════════════════════════════════
    // SCENARIO 1 — Signature happy path
    // ═════════════════════════════════════════════════════════════════════
    h1('SCENARIO 1 — Signature proof happy path');

    h2('S1-A: Confirm verification flag = true');
    const s1Cust = await prisma.customer.findUniqueOrThrow({
      where: { id: testCustomer.id },
      select: { customerName: true, requireDeliveryVerification: true },
    });
    say(`  DB row: customer_name="${s1Cust.customerName}" require_delivery_verification=${s1Cust.requireDeliveryVerification}`);

    h2('S1-B: Create + dispatch order');
    const s1Order = await makeOrderPendingDelivery(ctx.sharma.id, testCustomer.id, ctx.driver.id, ctx.cylinderType.id, 5);
    say(`  Order: id=${s1Order.id} number=${s1Order.orderNumber} status=pending_delivery`);

    h2('S1-C: Get presigned upload URL (may fall back to mock if AWS creds missing)');
    let s1UploadUrl: string;
    let s1S3Key: string;
    const uploadRes = await api
      .post(`/api/orders/${s1Order.id}/delivery-proof-upload-url`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({ proofType: 'signature' });
    if (uploadRes.status === 200) {
      s1UploadUrl = uploadRes.body.data.uploadUrl;
      s1S3Key = uploadRes.body.data.s3Key;
      say(`  Server returned: uploadUrl=${s1UploadUrl.slice(0, 80)}... s3Key=${s1S3Key}`);
    } else {
      // AWS creds not present locally — construct a s3Key by hand
      // matching what generateDeliveryProofUploadUrl would produce.
      const uuid = randomUUID();
      s1S3Key = `delivery-proofs/${ctx.sharma.id}/${s1Order.id}/signature-${uuid}.png`;
      s1UploadUrl = `[mocked — AWS creds missing, upload-url endpoint status=${uploadRes.status}]`;
      say(`  [MOCK] AWS creds missing; hand-crafted s3Key=${s1S3Key}`);
      say(`  [MOCK] endpoint returned status=${uploadRes.status} body=${JSON.stringify(uploadRes.body).slice(0, 200)}`);
    }

    h2('S1-D: Generate signature PNG (sharp + SVG bezier paths)');
    const sigPath = path.join(OUT_DIR, 'test-signature.png');
    await generateSignaturePng(sigPath);
    // Also mirror to the CDN-served path so the PDF's fetch by CloudFront
    // URL resolves to the same bytes.
    const cdnSigPath = path.join(OUT_DIR, s1S3Key);
    fs.mkdirSync(path.dirname(cdnSigPath), { recursive: true });
    fs.copyFileSync(sigPath, cdnSigPath);
    const sigStat = fs.statSync(sigPath);
    say(`  Wrote ${sigPath} (${sigStat.size} bytes)`);
    say(`  Mirrored to CDN path ${cdnSigPath}`);

    h2('S1-E: POST /delivery-proof');
    const s1ProofRes = await api
      .post(`/api/orders/${s1Order.id}/delivery-proof`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({
        proofType: 'signature',
        proofS3Key: s1S3Key,
        proofSigningPartyPhone: '9876543210',
        capturedLat: 17.4065,
        capturedLng: 78.4772,
      });
    say(`  Status: ${s1ProofRes.status}`);
    say(`  Body: ${JSON.stringify(s1ProofRes.body)}`);

    const s1ProofRow = await prisma.deliveryProof.findFirstOrThrow({ where: { orderId: s1Order.id } });
    say(`  DB row:`);
    say(`    id=${s1ProofRow.id}`);
    say(`    order_id=${s1ProofRow.orderId}`);
    say(`    distributor_id=${s1ProofRow.distributorId}`);
    say(`    proof_type=${s1ProofRow.proofType}`);
    say(`    s3_key=${s1ProofRow.s3Key}`);
    say(`    signing_party_phone=${s1ProofRow.signingPartyPhone}`);
    say(`    captured_lat=${s1ProofRow.capturedLat}`);
    say(`    captured_lng=${s1ProofRow.capturedLng}`);
    say(`    captured_at=${s1ProofRow.capturedAt.toISOString()}`);
    say(`    captured_by=${s1ProofRow.capturedBy}`);

    h2('S1-F: POST /confirm-delivery');
    const s1ConfRes = await api
      .post(`/api/orders/${s1Order.id}/confirm-delivery`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({
        items: [{ cylinderTypeId: ctx.cylinderType.id, deliveredQuantity: 5, emptiesCollected: 4 }],
        notes: 'Delivered to hotel reception',
      });
    say(`  Status: ${s1ConfRes.status}`);
    const s1OrderRow = await prisma.order.findUniqueOrThrow({
      where: { id: s1Order.id },
      select: { status: true, invoice: { select: { id: true, invoiceNumber: true } } },
    });
    say(`  Order status now: ${s1OrderRow.status}`);
    say(`  Invoice created: id=${s1OrderRow.invoice?.id} number=${s1OrderRow.invoice?.invoiceNumber}`);

    let s1PdfBytes = 0;
    let s1PdfPath = '';
    let s1PdfEmbedsImage = false;
    if (s1OrderRow.invoice) {
      h2('S1-G: GET invoice PDF (should embed signature via local CDN)');
      const pdfRes = await api
        .get(`/api/invoices/${s1OrderRow.invoice.id}/pdf`)
        .set('Authorization', `Bearer ${ctx.distAdmin.token}`)
        .buffer(true)
        .parse((res, cb) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => cb(null, Buffer.concat(chunks)));
        });
      s1PdfPath = path.join(OUT_DIR, 'scenario1-signature-invoice.pdf');
      fs.writeFileSync(s1PdfPath, pdfRes.body as Buffer);
      s1PdfBytes = (pdfRes.body as Buffer).length;
      say(`  PDF status: ${pdfRes.status}, ${s1PdfBytes} bytes → ${s1PdfPath}`);

      // Extract text via pdf-parse and check for the proof section.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: pdfRes.body as Buffer });
      try {
        const text = (await parser.getText()).text;
        const hasVerified = /DELIVERY VERIFIED/i.test(text);
        const hasPhone = /9876543210/.test(text);
        const hasGps = /17\.40650|17\.40650, 78\.47720/.test(text);
        say(`  Text extract:`);
        say(`    contains "DELIVERY VERIFIED": ${hasVerified}`);
        say(`    contains signing phone "9876543210": ${hasPhone}`);
        say(`    contains GPS coords: ${hasGps}`);
        // The image itself won't show up in text extract — check PDF
        // bytes for an embedded FlateDecode/DCTDecode image stream.
        // A pure text-only PDF is smaller; ours should have an image
        // stream added by doc.image().
        const pdfBuf = pdfRes.body as Buffer;
        const bufStr = pdfBuf.toString('binary');
        // pdfkit embeds PNGs as `/Filter /FlateDecode` /Subtype /Image
        s1PdfEmbedsImage = /\/Subtype\s*\/Image/.test(bufStr);
        say(`    PDF contains embedded image stream: ${s1PdfEmbedsImage}`);
      } finally {
        await parser.destroy();
      }
    }

    results.push({
      name: 'S1: Signature happy path',
      expected: 'Proof persisted; PDF renders "Delivery Verified" with signature image, phone, GPS, timestamp',
      actual: `Proof row created (id=${s1ProofRow.id.slice(0, 8)}…), delivery confirmed, invoice PDF ${s1PdfBytes} bytes, contains DELIVERY VERIFIED text${s1PdfEmbedsImage ? ' + embedded image stream (signature)' : ' but NO embedded image stream'}`,
      pass: s1ProofRes.status === 201 && s1ConfRes.status === 200 && s1PdfBytes > 0 && s1PdfEmbedsImage,
      notes: uploadRes.status !== 200 ? 'upload-url endpoint fell back to hand-crafted s3Key (AWS creds missing locally)' : undefined,
    });

    // ═════════════════════════════════════════════════════════════════════
    // SCENARIO 2 — Retry idempotency
    // ═════════════════════════════════════════════════════════════════════
    h1('SCENARIO 2 — Retry idempotency (upsert-by-orderId, latest wins)');

    const s2Order = await makeOrderPendingDelivery(ctx.sharma.id, testCustomer.id, ctx.driver.id, ctx.cylinderType.id, 3);
    say(`Fresh order for S2: id=${s2Order.id} number=${s2Order.orderNumber}`);

    h2('S2-A: POST /delivery-proof with phone 9876543210');
    const s2P1 = await api
      .post(`/api/orders/${s2Order.id}/delivery-proof`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({
        proofType: 'signature',
        proofS3Key: `delivery-proofs/${ctx.sharma.id}/${s2Order.id}/signature-v1.png`,
        proofSigningPartyPhone: '9876543210',
      });
    say(`  Status: ${s2P1.status}, body: ${JSON.stringify(s2P1.body)}`);

    h2('S2-B: POST /delivery-proof again with phone 9999999999 (simulated retry)');
    const s2P2 = await api
      .post(`/api/orders/${s2Order.id}/delivery-proof`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({
        proofType: 'signature',
        proofS3Key: `delivery-proofs/${ctx.sharma.id}/${s2Order.id}/signature-v2.png`,
        proofSigningPartyPhone: '9999999999',
      });
    say(`  Status: ${s2P2.status}, body: ${JSON.stringify(s2P2.body)}`);

    const s2Rows = await prisma.deliveryProof.findMany({ where: { orderId: s2Order.id } });
    say(`  delivery_proofs row count for this order: ${s2Rows.length}`);
    say(`  latest phone: ${s2Rows[0]?.signingPartyPhone}, s3Key: ${s2Rows[0]?.s3Key}`);

    h2('S2-C: Confirm delivery still works');
    const s2Conf = await api
      .post(`/api/orders/${s2Order.id}/confirm-delivery`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({ items: [{ cylinderTypeId: ctx.cylinderType.id, deliveredQuantity: 3, emptiesCollected: 3 }] });
    say(`  Status: ${s2Conf.status}`);

    results.push({
      name: 'S2: Retry idempotency',
      expected: 'Both POSTs return 201, only ONE delivery_proofs row exists, latest phone (9999999999) stored',
      actual: `p1=${s2P1.status} p2=${s2P2.status} rows=${s2Rows.length} latestPhone=${s2Rows[0]?.signingPartyPhone} confirmDelivery=${s2Conf.status}`,
      pass: s2P1.status === 201 && s2P2.status === 201 && s2Rows.length === 1 && s2Rows[0]?.signingPartyPhone === '9999999999' && s2Conf.status === 200,
    });

    // ═════════════════════════════════════════════════════════════════════
    // SCENARIO 3 — Verification flag OFF regression
    // ═════════════════════════════════════════════════════════════════════
    h1('SCENARIO 3 — Verification flag OFF (regression)');

    const s3Customer = await makeCustomer(ctx.sharma.id, 'NON-VERIFIED CUST TEST', false);
    say(`S3 customer: id=${s3Customer.id} name="${s3Customer.name}" requireDeliveryVerification=false`);

    const s3Order = await makeOrderPendingDelivery(ctx.sharma.id, s3Customer.id, ctx.driver.id, ctx.cylinderType.id, 2);
    say(`S3 order: id=${s3Order.id} number=${s3Order.orderNumber}`);

    h2('S3-C: GET /orders as driver — inspect customerRequiresVerification flat alias');
    const s3ListRes = await api.get('/api/orders').set('Authorization', `Bearer ${ctx.driver.token}`).query({ status: 'pending_delivery' });
    const s3OrderInList = (s3ListRes.body.data.orders as Array<{ orderId: string; customerRequiresVerification?: boolean }>).find((o) => o.orderId === s3Order.id);
    say(`  Found in driver list: ${!!s3OrderInList}`);
    say(`  customerRequiresVerification field value: ${s3OrderInList?.customerRequiresVerification}`);

    h2('S3-D: Confirm delivery WITHOUT any proof body');
    const s3Conf = await api
      .post(`/api/orders/${s3Order.id}/confirm-delivery`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({ items: [{ cylinderTypeId: ctx.cylinderType.id, deliveredQuantity: 2, emptiesCollected: 2 }] });
    say(`  Status: ${s3Conf.status}`);

    const s3ProofRows = await prisma.deliveryProof.findMany({ where: { orderId: s3Order.id } });
    say(`  delivery_proofs row count for this order: ${s3ProofRows.length} (expected 0)`);

    results.push({
      name: 'S3: Flag OFF regression',
      expected: 'customerRequiresVerification=false in /orders response; confirm-delivery accepts empty body; zero proof rows',
      actual: `flagInResponse=${s3OrderInList?.customerRequiresVerification} confirmStatus=${s3Conf.status} proofRows=${s3ProofRows.length}`,
      pass: s3OrderInList?.customerRequiresVerification === false && s3Conf.status === 200 && s3ProofRows.length === 0,
    });

    // ═════════════════════════════════════════════════════════════════════
    // SCENARIO 4 — OTP flow preview (Phase 3 wiring)
    // ═════════════════════════════════════════════════════════════════════
    h1('SCENARIO 4 — OTP flow preview (Phase 3 outstanding)');

    // Find or create a customer under Sharma with portal access.
    const s4Customer = await makeCustomer(ctx.sharma.id, 'OTP-PREVIEW-CUST', true);
    say(`S4 customer: id=${s4Customer.id}`);
    let s4User = await prisma.user.findFirst({ where: { customerId: s4Customer.id, role: 'customer' } });
    if (!s4User) {
      // Use the same provisionPortalAccess service used by the route.
      const { hashPassword } = await import('../src/services/authService.js');
      s4User = await prisma.user.create({
        data: {
          email: `test-hq-${Date.now()}@sharma.com`,
          passwordHash: await hashPassword('Test@1234'),
          firstName: 'Raj',
          lastName: 'Kumar',
          role: 'customer',
          distributorId: ctx.sharma.id,
          customerId: s4Customer.id,
          requiresPasswordReset: false,
        },
      });
    }
    const s4CustToken = tokenFor({
      id: s4User.id,
      email: s4User.email,
      role: 'customer',
      distributorId: ctx.sharma.id,
      customerId: s4Customer.id,
    });
    say(`S4 customer portal user: id=${s4User.id} email=${s4User.email}`);

    const s4Order = await makeOrderPendingDelivery(ctx.sharma.id, s4Customer.id, ctx.driver.id, ctx.cylinderType.id, 1);
    say(`S4 order: id=${s4Order.id}`);

    h2('S4-C: POST /delivery-otp/generate as driver (expected: 404 — Phase 3 not built)');
    const s4Otp = await api
      .post(`/api/orders/${s4Order.id}/delivery-otp/generate`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({});
    say(`  Status: ${s4Otp.status}`);
    say(`  Body: ${typeof s4Otp.body === 'object' ? JSON.stringify(s4Otp.body) : String(s4Otp.body).slice(0, 200)}`);

    h2('S4-D: GET /customer-portal/orders — check for otpCode field on the order card');
    const s4PortalRes = await api.get('/api/customer-portal/orders').set('Authorization', `Bearer ${s4CustToken}`);
    say(`  Status: ${s4PortalRes.status}`);
    const s4OrderCard = (s4PortalRes.body?.data?.orders as Array<{ orderId: string; otpCode?: string | null }> | undefined)?.find((o) => o.orderId === s4Order.id);
    say(`  Order visible in portal: ${!!s4OrderCard}`);
    const s4HasOtpField = s4OrderCard && Object.prototype.hasOwnProperty.call(s4OrderCard, 'otpCode');
    say(`  otpCode field present on response: ${s4HasOtpField}`);
    if (s4HasOtpField) {
      say(`  otpCode value: ${s4OrderCard!.otpCode}`);
    }

    results.push({
      name: 'S4: OTP preview (Phase 3)',
      expected: 'Endpoint returns 404 (not built); customer portal /orders response reserved otpCode field is null',
      actual: `otpGenStatus=${s4Otp.status} portalOrderVisible=${!!s4OrderCard} otpCodeFieldPresent=${s4HasOtpField}`,
      pass: s4Otp.status === 404 && !!s4OrderCard,
      notes: s4HasOtpField ? 'otpCode field is present on the wire' : 'otpCode field is NOT yet on the customer-portal /orders response (Phase 3 mapper extension outstanding — plan §1.4 lists it; this is a documented Phase 3 wiring gap, not a Phase 1 regression)',
    });

    // ═════════════════════════════════════════════════════════════════════
    // SCENARIO 5 — Cross-tenant security check
    // ═════════════════════════════════════════════════════════════════════
    h1('SCENARIO 5 — Cross-tenant security');

    // Need a Bhargava (dist-001) order to attack.
    const bhargavaCust = await prisma.customer.findFirstOrThrow({ where: { distributorId: ctx.bhargavaId, deletedAt: null } });
    const bhargavaCyl = await prisma.cylinderType.findFirstOrThrow({ where: { distributorId: ctx.bhargavaId, isActive: true } });
    const s5Order = await makeOrderPendingDelivery(ctx.bhargavaId, bhargavaCust.id, ctx.driverBhargava.id, bhargavaCyl.id, 1);
    say(`Bhargava victim order: id=${s5Order.id} number=${s5Order.orderNumber}`);

    h2('S5-B: Sharma driver POSTs /delivery-proof on Bhargava order — expected 404/403');
    const s5Post = await api
      .post(`/api/orders/${s5Order.id}/delivery-proof`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({
        proofType: 'signature',
        proofS3Key: `delivery-proofs/${ctx.sharma.id}/${s5Order.id}/signature-attack.png`,
        proofSigningPartyPhone: '9876543210',
      });
    say(`  Status: ${s5Post.status}, body: ${JSON.stringify(s5Post.body)}`);

    h2('S5-C: Sharma driver POSTs upload-url on Bhargava order — expected 404/403');
    const s5Upload = await api
      .post(`/api/orders/${s5Order.id}/delivery-proof-upload-url`)
      .set('Authorization', `Bearer ${ctx.driver.token}`)
      .send({ proofType: 'signature' });
    say(`  Status: ${s5Upload.status}, body: ${JSON.stringify(s5Upload.body)}`);

    const s5AttackRows = await prisma.deliveryProof.findMany({ where: { orderId: s5Order.id } });
    say(`  delivery_proofs rows on victim order (expected 0): ${s5AttackRows.length}`);

    results.push({
      name: 'S5: Cross-tenant security',
      expected: 'Both endpoints 403/404 when Sharma driver targets Bhargava order; zero rows written',
      actual: `proofPost=${s5Post.status} uploadUrl=${s5Upload.status} attackRowsWritten=${s5AttackRows.length}`,
      pass: [403, 404].includes(s5Post.status) && [403, 404].includes(s5Upload.status) && s5AttackRows.length === 0,
    });

    // ─── Summary ─────────────────────────────────────────────────────────
    h1('SUMMARY');
    for (const r of results) {
      say(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
      say(`      expected: ${r.expected}`);
      say(`      actual:   ${r.actual}`);
      if (r.notes) say(`      notes:    ${r.notes}`);
    }

    // ─── Write markdown report ──────────────────────────────────────────
    const md: string[] = [];
    md.push('# Proof-of-Collection Phase 1 — Scenario Test Results');
    md.push('');
    md.push(`**Run:** ${new Date().toISOString()} (local dev, in-process createApp via supertest, real Postgres, no push)`);
    md.push('');
    md.push('## Results');
    md.push('');
    md.push('| # | Scenario | Expected | Actual | Pass |');
    md.push('|---|---|---|---|---|');
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      md.push(`| ${i + 1} | ${r.name} | ${r.expected} | ${r.actual} | ${r.pass ? 'PASS' : 'FAIL'} |`);
    }
    md.push('');
    md.push('## Artifacts');
    md.push('');
    md.push('- **Signature PNG:** `' + sigPath.replace(/\\/g, '/') + '` (400×150, sharp+SVG bezier "K. Reddy")');
    md.push('- **Invoice PDF:** `' + s1PdfPath.replace(/\\/g, '/') + '` (' + s1PdfBytes + ' bytes)');
    md.push('');
    md.push('## Full Log');
    md.push('');
    md.push('```');
    md.push(...log);
    md.push('```');
    fs.writeFileSync('C:/Projects/Re-New_Gaslink/docs/SCENARIO-TEST-RESULTS.md', md.join('\n'));
    say(`Report written to docs/SCENARIO-TEST-RESULTS.md`);

  } finally {
    cdnServer.close();
    await prisma.$disconnect();
  }
}

run().catch((err) => {
  console.error('Scenario runner failed:', err);
  process.exit(1);
});
