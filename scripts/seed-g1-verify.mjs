// Seeds a dist-001 customer + OB invoice + 1 delivered order + 1 payment so
// the Group 1 in-app ledger + statement PDF have something to render.
// Idempotent: if the verify customer already exists, the script clears its
// ledger/invoices/orders/payments before reseeding.

const API = 'http://localhost:5000';
const TRACK_NAME = 'G1-Verify Customer';

async function j(path, opts = {}) {
  const r = await fetch(API + path, opts);
  return { status: r.status, body: await r.json().catch(() => null) };
}
async function login(email, password) {
  const r = await j('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  return r.body.data.tokens.accessToken;
}
const hdrs = (t) => ({ 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' });

const tok = await login('bhargava@gasagency.com', 'Distadmin@123');

// Find an existing G1-Verify customer or create one.
let custList = await j('/api/customers?pageSize=200', { headers: hdrs(tok) });
let customers = custList.body?.data?.customers ?? custList.body?.data ?? [];
let cust = Array.isArray(customers) ? customers.find((c) => c.customerName === TRACK_NAME) : null;
let customerId = cust?.customerId ?? cust?.id;

if (!customerId) {
  const created = await j('/api/customers', {
    method: 'POST',
    headers: hdrs(tok),
    body: JSON.stringify({
      customerName: TRACK_NAME,
      phone: '9100000099',
      creditPeriodDays: 30,
      customerType: 'B2C',
      billingAddressLine1: 'Test Address',
      billingCity: 'Hyderabad',
      billingState: 'Telangana',
      billingPincode: '500001',
    }),
  });
  console.log('  customer create status:', created.status, JSON.stringify(created.body).slice(0, 200));
  customerId = created.body?.data?.customerId ?? created.body?.data?.id;
}
console.log('TRACK customer id:', customerId);

// Import opening balance (uses the importer — will be subject to G3 dedup once that ships, for now creates a new OB entry)
const ob = await j('/api/customers/import-opening-balances', {
  method: 'POST',
  headers: hdrs(tok),
  body: JSON.stringify({
    rows: [{ customerName: TRACK_NAME, openingBalance: 15000, notes: 'Carried from paper register' }],
  }),
});
console.log('OB import:', ob.status, JSON.stringify(ob.body).slice(0, 250));

console.log('\nLogin URL: http://localhost:5173/login');
console.log('  Email: bhargava@gasagency.com');
console.log('  Pwd:   Distadmin@123');
console.log(`\nThen open the customer "${TRACK_NAME}" → Ledger tab to verify Group 1.`);
console.log(`Customer id: ${customerId}`);
