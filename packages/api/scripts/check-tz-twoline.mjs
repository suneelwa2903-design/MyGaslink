#!/usr/bin/env node
/**
 * Anti-pattern #21 guard, PART 2 — the TWO-LINE form.
 *
 * check-tz-patterns.sh catches the single-expression shape:
 *     new Date().toISOString().split('T')[0]
 * Its own header documented a known blind spot: the same bug written across
 * two statements evades a line-oriented grep.
 *
 *     const today = new Date();                       // line N
 *     const todayIso = today.toISOString().split('T')[0];  // line N+k  ← BUG
 *
 * That gap bit for real: `customerService.ts > importOpeningBalances` shipped
 * exactly this shape and computed yesterday's date for every operator running
 * an opening-balance import between 00:00 and 05:30 IST.
 *
 * This script closes it. For each source file it finds `const|let X = new Date()`
 * (with no argument — a *data-derived* date like `new Date(row.createdAt)` is
 * legitimate and must NOT be flagged), then looks ahead a short window for
 * `X.toISOString().split('T')[0]` or `X.toISOString().slice(0, 10)`.
 *
 * Bash can't do this: `grep -P` (needed for backreferences) is unavailable in
 * the Git Bash build used on the dev machines.
 *
 * Exit 0 = clean, exit 1 = hits found.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');

const SCOPED_DIRS = [
  'packages/api/src',
  'packages/web/src',
  'packages/mobile/app',
  'packages/mobile/src',
];

// How many lines after the `new Date()` assignment to keep looking.
const LOOKAHEAD = 6;

// `new Date()` with NO arguments only. `new Date(someStored)` is data-derived
// and legitimate per anti-pattern #21.
const ASSIGN_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new Date\(\s*\)\s*;/;
const isComment = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

function sourceFiles(dir, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

const hits = [];

for (const scoped of SCOPED_DIRS) {
  for (const file of sourceFiles(join(ROOT, scoped))) {
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (isComment(lines[i])) continue;
      const assign = ASSIGN_RE.exec(lines[i]);
      if (!assign) continue;
      const varName = assign[1].replace(/[$]/g, '\\$');
      const useRe = new RegExp(
        `\\b${varName}\\.toISOString\\(\\)\\.(?:split\\('T'\\)|slice\\(\\s*0\\s*,\\s*10\\s*\\))`,
      );
      for (let j = i + 1; j <= Math.min(i + LOOKAHEAD, lines.length - 1); j++) {
        if (isComment(lines[j])) continue;
        // Re-assignment of the same name ends the window.
        if (new RegExp(`\\b${varName}\\s*=\\s*new Date\\(`).test(lines[j])) break;
        if (useRe.test(lines[j])) {
          hits.push({
            file: relative(ROOT, file).replace(/\\/g, '/'),
            declLine: i + 1,
            useLine: j + 1,
            snippet: lines[j].trim(),
          });
          break;
        }
      }
    }
  }
}

if (hits.length > 0) {
  console.error('ERROR (anti-pattern #21, two-line form): UTC date drift');
  console.error('  A `new Date()` assigned on one line, then .toISOString().split(\'T\')[0]');
  console.error('  on a later line. Returns the UTC calendar date — one day behind IST');
  console.error('  between 00:00 and 05:30 local.');
  console.error('  fix: use localTodayISO() / localDateISO(d) from @gaslink/shared');
  console.error('  hits:');
  for (const h of hits) {
    console.error(`    ${h.file}:${h.useLine}  (declared line ${h.declLine})`);
    console.error(`      ${h.snippet}`);
  }
  process.exit(1);
}

console.log('TZ two-line check: clean.');
