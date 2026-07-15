/**
 * Feature A Step 10 — HQ portal scenario testing.
 *
 * Uses the seeded hq-sharma@mygaslink.com / HqTest@123 login and
 * walks 9 scenarios end-to-end against a running dev API on
 * http://localhost:5000. Prints a machine-readable summary the CP4
 * report renders into docs/SCENARIO-TEST-RESULTS-GROUPING.md.
 */
const API = 'http://localhost:5000';

interface Result {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
}
const results: Result[] = [];

async function pass(id: string, name: string, detail: string) {
  results.push({ id, name, status: 'PASS', detail });
  console.log(`✓ ${id} ${name}  —  ${detail}`);
}
async function fail(id: string, name: string, detail: string) {
  results.push({ id, name, status: 'FAIL', detail });
  console.log(`✗ ${id} ${name}  —  ${detail}`);
}

async function main() {
  // Login as HQ user
  const loginRes = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'hq-sharma@mygaslink.com', password: 'HqTest@123' }),
  });
  if (loginRes.status !== 200) {
    console.error(`Login failed: ${loginRes.status}`);
    process.exit(1);
  }
  const loginJson: any = await loginRes.json();
  const token: string = loginJson.data.tokens.accessToken;
  const authHeader = { Authorization: `Bearer ${token}` };

  // ─── S1: dashboard loads with real KPIs ─────────────────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/dashboard`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && j.data?.properties?.length >= 2 && typeof j.data.totalOutstanding === 'number') {
      await pass('S1', 'Dashboard KPIs',
        `${j.data.properties.length} properties, ₹${j.data.totalOutstanding} outstanding, aging bucket0_30=${j.data.aging.bucket0_30}`);
    } else {
      await fail('S1', 'Dashboard KPIs', `status=${r.status}, shape=${JSON.stringify(j).slice(0, 200)}`);
    }
  }

  // ─── S2: orders list with property filter ───────────────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/orders?pageSize=5`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && Array.isArray(j.data.orders)) {
      const props = new Set(j.data.orders.map((o: any) => o.customerName));
      await pass('S2', 'Orders list', `${j.data.orders.length} rows, ${props.size} distinct properties`);
    } else {
      await fail('S2', 'Orders list', `status=${r.status}`);
    }
  }

  // ─── S3: invoices list + PDF download ───────────────────────────
  {
    const listR = await fetch(`${API}/api/customer-group-portal/invoices?pageSize=1`, { headers: authHeader });
    const listJ: any = await listR.json();
    if (listR.status !== 200 || !listJ.data.invoices?.length) {
      await fail('S3', 'Invoice PDF download', `list status=${listR.status}, empty=${!listJ.data.invoices?.length}`);
    } else {
      const inv = listJ.data.invoices[0];
      const pdfR = await fetch(`${API}/api/customer-group-portal/invoices/${inv.invoiceId}/pdf`, { headers: authHeader });
      const ct = pdfR.headers.get('content-type') || '';
      const buf = new Uint8Array(await pdfR.arrayBuffer());
      const magic = String.fromCharCode(...buf.slice(0, 4));
      if (pdfR.status === 200 && ct.includes('application/pdf') && magic === '%PDF') {
        await pass('S3', 'Invoice PDF download',
          `${inv.invoiceNumber} → ${buf.length} bytes, %PDF magic OK`);
      } else {
        await fail('S3', 'Invoice PDF download',
          `status=${pdfR.status}, ct=${ct}, magic=${magic}, size=${buf.length}`);
      }
    }
  }

  // ─── S4: consolidated ledger + group-statement PDF ──────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/ledger`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && j.data.rows && j.data.totals) {
      const pdfR = await fetch(`${API}/api/customer-group-portal/ledger/pdf`, { headers: authHeader });
      const ct = pdfR.headers.get('content-type') || '';
      const buf = new Uint8Array(await pdfR.arrayBuffer());
      const magic = String.fromCharCode(...buf.slice(0, 4));
      if (pdfR.status === 200 && ct.includes('application/pdf') && magic === '%PDF') {
        await pass('S4', 'Consolidated ledger + PDF',
          `${j.data.rows.length} merged rows, debited=₹${j.data.totals.totalDebited}; PDF ${buf.length} bytes`);
      } else {
        await fail('S4', 'Consolidated ledger + PDF', `pdf status=${pdfR.status}, ct=${ct}, magic=${magic}`);
      }
    } else {
      await fail('S4', 'Consolidated ledger', `list status=${r.status}`);
    }
  }

  // ─── S5: aging report has per-property rows ─────────────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/aging`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && Array.isArray(j.data.columns) && Array.isArray(j.data.rows)) {
      await pass('S5', 'Aging report', `${j.data.columns.length} columns, ${j.data.rows.length} property rows`);
    } else {
      await fail('S5', 'Aging report', `status=${r.status}`);
    }
  }

  // ─── S6: profile has group + distributor + members ──────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/profile`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && j.data.group?.name && j.data.distributor?.businessName && j.data.members?.length >= 2) {
      await pass('S6', 'Profile',
        `${j.data.group.name} · ${j.data.distributor.businessName} · ${j.data.members.length} members`);
    } else {
      await fail('S6', 'Profile', `status=${r.status}`);
    }
  }

  // ─── S7: property filter narrows to a single customer ───────────
  {
    const profR = await fetch(`${API}/api/customer-group-portal/profile`, { headers: authHeader });
    const profJ: any = await profR.json();
    const firstMemberId = profJ.data.members[0].customerId;
    const r = await fetch(`${API}/api/customer-group-portal/orders?customerId=${firstMemberId}&pageSize=25`, { headers: authHeader });
    const j: any = await r.json();
    if (r.status === 200 && j.data.orders.every((o: any) => o.customerId === firstMemberId)) {
      await pass('S7', 'Property filter narrows',
        `${j.data.orders.length} orders, all customerId=${firstMemberId.slice(0, 8)}...`);
    } else {
      await fail('S7', 'Property filter narrows', `status=${r.status}, or mixed customerIds returned`);
    }
  }

  // ─── S8: method guard blocks non-GET ────────────────────────────
  {
    const r = await fetch(`${API}/api/customer-group-portal/dashboard`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (r.status === 405) {
      await pass('S8', 'Method guard blocks POST', 'POST /dashboard → 405');
    } else {
      await fail('S8', 'Method guard blocks POST', `expected 405, got ${r.status}`);
    }
  }

  // ─── S9: dev server still serves web + /hq/* routes ─────────────
  {
    // Post-Step 10 the dev-server is only api here; the web dev-server
    // was verified in CP3. Instead this scenario re-confirms API health
    // + a fresh HQ dashboard round-trip after every commit landed.
    const health = await fetch(`${API}/api/health`);
    const healthJ: any = await health.json();
    const dashR = await fetch(`${API}/api/customer-group-portal/dashboard`, { headers: authHeader });
    if (health.status === 200 && dashR.status === 200) {
      await pass('S9', 'API up + HQ dashboard reachable after all commits',
        `/health ok, /dashboard 200 (env=${healthJ.data?.env ?? 'n/a'})`);
    } else {
      await fail('S9', 'API up after all commits', `health=${health.status}, dashboard=${dashR.status}`);
    }
  }

  // ─── Summary ────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passCount}/${results.length} scenarios passed, ${failCount} failed`);
  console.log('\n---BEGIN JSON---');
  console.log(JSON.stringify(results, null, 2));
  console.log('---END JSON---');
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
