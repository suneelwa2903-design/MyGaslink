import { writeFileSync } from 'node:fs';

/**
 * Quick Health Check / Smoke Test
 *
 * Lightweight script that verifies the API is up, the database is reachable,
 * and response times are within acceptable thresholds.
 *
 * Can be called by external uptime services (e.g. UptimeRobot) or used
 * as a pre-deploy gate.
 *
 * Environment variables
 *   BASE_URL   API root (default http://localhost:5000/api)
 *
 * Usage:
 *   npx tsx packages/api/scripts/health-check.ts
 *
 * Exit codes:
 *   0 – all checks passed
 *   1 – one or more checks failed
 */

const BASE_URL = (process.env.BASE_URL || 'http://localhost:5000/api').replace(/\/$/, '');

interface CheckResult {
  check: string;
  status: 'pass' | 'fail';
  durationMs: number;
  detail?: string;
}

const checks: CheckResult[] = [];

async function runCheck(name: string, fn: () => Promise<string | void>): Promise<void> {
  const start = Date.now();
  try {
    const detail = await fn();
    checks.push({ check: name, status: 'pass', durationMs: Date.now() - start, detail: detail || undefined });
  } catch (err: any) {
    checks.push({ check: name, status: 'fail', durationMs: Date.now() - start, detail: err?.message || String(err) });
  }
}

function assert(condition: boolean, msg: string): void {
  if (!condition) throw new Error(msg);
}

async function main(): Promise<void> {
  // 1. API reachability
  await runCheck('API reachable', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert(res.ok, `HTTP ${res.status}`);
    return `HTTP ${res.status}`;
  });

  // 2. DB connectivity (via health endpoint)
  await runCheck('Database connected', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    const dbStatus = body?.data?.database?.status;
    assert(dbStatus === 'connected', `DB status: ${dbStatus}`);
    const latency = body?.data?.database?.latencyMs;
    return `Latency ${latency}ms`;
  });

  // 3. DB latency threshold
  await runCheck('DB latency < 200ms', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    const latency = body?.data?.database?.latencyMs ?? 9999;
    assert(latency < 200, `${latency}ms`);
    return `${latency}ms`;
  });

  // 4. Response time — health endpoint under 1s
  await runCheck('Health response < 1s', async () => {
    const start = Date.now();
    await fetch(`${BASE_URL}/health`);
    const elapsed = Date.now() - start;
    assert(elapsed < 1000, `${elapsed}ms`);
    return `${elapsed}ms`;
  });

  // 5. Response time — cold auth endpoint (should at least respond, even with 4xx)
  await runCheck('Auth endpoint reachable', async () => {
    const res = await fetch(`${BASE_URL}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'healthcheck@test.invalid', password: 'x' }),
    });
    // We expect 400 (validation) or 401 (bad creds), NOT 500/503
    assert(res.status < 500, `Server error: HTTP ${res.status}`);
    return `HTTP ${res.status}`;
  });

  // Print results
  console.log('\n' + '-'.repeat(50));
  console.log('  HEALTH CHECK');
  console.log('-'.repeat(50));
  console.log(`  Target: ${BASE_URL}`);
  console.log(`  Time:   ${new Date().toISOString()}`);
  console.log('-'.repeat(50));

  let anyFailed = false;
  for (const c of checks) {
    const icon = c.status === 'pass' ? 'OK' : 'FAIL';
    const pad = icon === 'OK' ? '  ' : '';
    console.log(`  [${icon}]${pad} ${c.check} (${c.durationMs}ms)${c.detail ? ` — ${c.detail}` : ''}`);
    if (c.status === 'fail') anyFailed = true;
  }
  console.log('-'.repeat(50));

  // Write JSON for programmatic consumption
  const summary = {
    timestamp: new Date().toISOString(),
    baseUrl: BASE_URL,
    healthy: !anyFailed,
    checks,
  };
  writeFileSync('health-check-result.json', JSON.stringify(summary, null, 2));
  console.log('JSON written to health-check-result.json\n');

  if (anyFailed) process.exit(1);
}

main().catch(err => {
  console.error('Health check crashed:', err);
  process.exit(2);
});
