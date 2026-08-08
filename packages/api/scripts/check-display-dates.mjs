#!/usr/bin/env node
/**
 * DATE-FORMAT-AUDIT (2026-08-08) guard — locks the dd/MM/yyyy standard.
 *
 * Bans the two ambiguous ad-hoc DISPLAY date forms that the sweep removed:
 *   1. `.toLocaleDateString('en-IN')`  (no options — the locale-numeric
 *      "7/8/2026" form). Use formatDisplayDate() from @gaslink/shared.
 *   2. `new Date(...).toLocaleString('en-IN')`  (bare date+time). Use
 *      formatDisplayDateTime() from @gaslink/shared.
 *
 * Legit calls are untouched: options-carrying toLocaleDateString (chart
 * axes, weekday/month headers) and `.toLocaleString('en-IN', {min…})` on
 * NUMBERS (currency). Comment lines are ignored.
 *
 * Node (not grep -P): the Git-Bash build on dev machines lacks PCRE.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const TREES = [
  join(ROOT, 'packages', 'web', 'src'),
  join(ROOT, 'packages', 'mobile', 'app'),
  join(ROOT, 'packages', 'mobile', 'src'),
];
const BARE_DATE = /\.toLocaleDateString\(\s*['"]en-IN['"]\s*\)/;
const BARE_DATETIME = /new Date\([^)]*\)\.toLocaleString\(\s*['"]en-IN['"]\s*\)/;

function walk(dir, out) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) { if (e !== 'node_modules') walk(p, out); }
    else if (/\.(tsx?|jsx?)$/.test(e)) out.push(p);
  }
}

const files = [];
for (const t of TREES) walk(t, files);

const hits = [];
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return;
    if (BARE_DATE.test(line)) hits.push(`${f}:${i + 1}  bare .toLocaleDateString('en-IN') → use formatDisplayDate()`);
    if (BARE_DATETIME.test(line)) hits.push(`${f}:${i + 1}  bare new Date(..).toLocaleString('en-IN') → use formatDisplayDateTime()`);
  });
}

if (hits.length > 0) {
  console.error('ERROR (DATE-FORMAT-AUDIT): ad-hoc display date formatting — standard is dd/MM/yyyy via @gaslink/shared.');
  for (const h of hits) console.error('  ' + h.replace(ROOT + '\\', '').replace(ROOT + '/', ''));
  process.exit(1);
}
console.log('Display-date format check: clean.');
