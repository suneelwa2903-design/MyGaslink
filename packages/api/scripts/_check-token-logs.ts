import { prisma } from '../src/lib/prisma.js';

const now = new Date();
const past2h = new Date(now.getTime() - 2 * 3600_000);

// Recent gst_api_logs for dist-002 — look for 1005 errors and auth calls
const logs = await prisma.gstApiLog.findMany({
  where: { distributorId: 'dist-002', createdAt: { gte: past2h } },
  orderBy: { createdAt: 'desc' },
  take: 20,
  select: {
    id: true, apiType: true, httpStatus: true, errorCode: true, errorMessage: true,
    latencyMs: true, createdAt: true, invoiceId: true,
  },
});
console.log(`\nRecent gst_api_logs for dist-002 (last 2h): ${logs.length} rows`);
for (const l of logs) {
  console.log(`  ${l.createdAt.toISOString()} | ${l.apiType?.padEnd(25)} | HTTP=${l.httpStatus} errCode=${l.errorCode || '-'} | ${(l.errorMessage || '').slice(0, 80)}`);
}

// Check gst_credentials fields more carefully — look at tokenCache column name
const raw = await prisma.$queryRaw<any[]>`
  SELECT scope, is_valid, email, client_id,
         token_expires_at,
         CASE WHEN token_cache IS NOT NULL THEN LEFT(token_cache::text, 40) ELSE 'NULL' END AS token_snip,
         updated_at
  FROM gst_credentials
  WHERE distributor_id = 'dist-002'
  ORDER BY scope
`;
console.log('\nRaw gst_credentials for dist-002:');
for (const r of raw) {
  console.log(`  scope=${r.scope} isValid=${r.is_valid} tokenExpiry=${r.token_expires_at ? new Date(r.token_expires_at).toISOString() : 'NULL'} token=${r.token_snip} updated=${new Date(r.updated_at).toISOString()}`);
}

await prisma.$disconnect();
