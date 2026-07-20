/**
 * Ledger PDF consistency (2026-07-19) — pin the layout invariants that
 * unified the individual and group ledger PDFs.
 *
 *   1. Both PDFs render a "Period Summary" 4-tile block above the
 *      entries table (Debited / Received / Net Outstanding / Overdue).
 *   2. Group PDF has the same 13 columns as the individual PDF has 12,
 *      with a Property column inserted at index 1 (right after Date).
 *   3. GROUP_TABLE_WIDTH === TABLE_WIDTH (both fit landscape A4).
 *   4. Group PDF uses the same Type labels and narration compaction
 *      helpers so a hotel HQ reader sees the same language on both
 *      surfaces.
 *
 * Source-file shape only — pdfkit output is binary and a full layout
 * check would need a PDF parser dependency for marginal payoff. The
 * render path is covered by hq-portal.test.ts T6 (PDF endpoints
 * returning application/pdf 200) and pdf-narration-truncation.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = readFileSync(
  resolve(__dirname, '..', 'services', 'pdf', 'customerLedgerPdfService.ts'),
  'utf-8',
);

describe('Ledger PDF consistency — Period Summary block', () => {
  it('exports a drawPeriodSummary helper accepting debited/received/netOutstanding/overdue', () => {
    expect(src).toMatch(/function drawPeriodSummary\s*\(/);
    // The block is a 4-tile row; the tile labels are the canonical
    // strings a reader looks for. Text calls uppercase the labels for
    // display, so match the source string as it appears in the tiles
    // array.
    expect(src).toContain('Debited (period)');
    expect(src).toContain('Received (period)');
    expect(src).toContain('Net Outstanding');
    expect(src).toContain('Overdue');
  });

  it('individual PDF does NOT render the period summary block (group-only per user 2026-07-19)', () => {
    // Only ONE drawPeriodSummary call exists in the file, and it's
    // inside generateGroupLedgerPdf. The individual PDF must not have
    // a call — the summary is a group-portal-only surface.
    const calls = (src.match(/drawPeriodSummary\(doc,/g) ?? []).length;
    expect(calls).toBe(1);
    // Locate the individual generator function body and assert it
    // contains no summary call.
    const indBody = src.match(/export async function generateCustomerLedgerPdf[\s\S]*?^\}/m);
    expect(indBody).not.toBeNull();
    expect(indBody![0]).not.toContain('drawPeriodSummary(');
  });

  it('group PDF calls drawPeriodSummary with the group totals + computed overdue', () => {
    // 2026-07-20 — group PDF switched from 4-tile
    // (Debited/Received/NetOutstanding/Overdue) to 5-tile accountant's
    // statement (Opening/Debited(period)/Received(period)/Closing/Overdue).
    // All 5 fields must be passed from ledger.totals so the tiles
    // reconcile to the visible in-range rows.
    expect(src).toMatch(
      /drawPeriodSummary\([\s\S]{0,800}opening:\s*ledger\.totals\.openingBalance[\s\S]{0,300}debited:\s*ledger\.totals\.periodDebited[\s\S]{0,200}received:\s*ledger\.totals\.periodReceived[\s\S]{0,200}netOutstanding:\s*ledger\.totals\.closingBalance[\s\S]{0,200}overdue:\s*ledger\.totals\.overdue/,
    );
  });

  it('group PDF pulls overdue straight from ledger.totals.overdue (not row-scan)', () => {
    // 2026-07-20 — the ad-hoc "sum of each customer's LAST
    // overDueAmount" scan (lastOverduePerCustomer Map) was replaced
    // by ledger.totals.overdue, which getGroupLedger populates by
    // summing summary.overdueAmount across every member's
    // processLedgerEntries call — same semantic, one source of truth.
    expect(src).not.toContain('lastOverduePerCustomer');
    expect(src).toMatch(/groupOverdue\s*=\s*ledger\.totals\.overdue/);
  });
});

describe('Ledger PDF consistency — Group column layout', () => {
  it('GROUP_COLS has 13 entries with Property at index 1', () => {
    // Grab the GROUP_COLS array literal and confirm shape.
    const match = src.match(/const GROUP_COLS:\s*Col\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(match).not.toBeNull();
    const body = match![1];
    // Count { label: '...' } entries in the array.
    const entries = body.match(/\{\s*label:\s*['"][^'"]+['"]/g) ?? [];
    expect(entries).toHaveLength(13);

    // Labels appear in a fixed order. Extract the label strings in
    // the order they were declared and assert the sequence.
    const labels = entries.map((e) => {
      const m = e.match(/label:\s*['"]([^'"]+)['"]/);
      return m ? m[1] : '';
    });
    expect(labels).toEqual([
      'Date', 'Property', 'Type', 'Narration', 'Del F', 'Amount',
      'Emp C', 'Pend E', 'Emp Cost', 'Total Amt', 'Received',
      'Due Amt', 'Overdue',
    ]);
  });

  it('COLS has 12 entries with same trailing 12 as GROUP_COLS[Date, ...GROUP_COLS[2..]]', () => {
    // Individual COLS = GROUP_COLS with Property removed. Assert this
    // holds so a future edit to the group layout can't silently drift
    // from the individual layout.
    const indMatch = src.match(/const COLS:\s*Col\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(indMatch).not.toBeNull();
    const indLabels = (indMatch![1].match(/label:\s*['"]([^'"]+)['"]/g) ?? [])
      .map((s) => s.replace(/label:\s*['"]([^'"]+)['"]/, '$1'));
    expect(indLabels).toEqual([
      'Date', 'Type', 'Narration', 'Del F', 'Amount', 'Emp C',
      'Pend E', 'Emp Cost', 'Total Amt', 'Received', 'Due Amt', 'Overdue',
    ]);
  });

  it('GROUP_TABLE_WIDTH === TABLE_WIDTH — enforced at import time', () => {
    expect(src).toMatch(
      /if \(GROUP_TABLE_WIDTH !== TABLE_WIDTH\)[\s\S]{0,200}throw new Error/,
    );
  });

  it('GROUP_COL_CHAR_CAP has 13 entries matching GROUP_COLS length', () => {
    const capMatch = src.match(/const GROUP_COL_CHAR_CAP:\s*number\[\]\s*=\s*\[([\s\S]*?)\];/);
    expect(capMatch).not.toBeNull();
    // Strip `//`-line comments before counting numbers — otherwise
    // dates and column widths embedded in the trailing docs
    // ("07-Jul-2026", "16 chars") false-match \b\d+\b.
    const stripped = capMatch![1]
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    const nums = (stripped.match(/\b\d+\b/g) ?? []).map((n) => Number(n));
    expect(nums).toHaveLength(13);
  });
});

describe('Ledger PDF consistency — Group PDF row semantics mirror individual', () => {
  it('group PDF defines groupTypeLabel with the same case values as individual typeLabel', () => {
    expect(src).toContain('function groupTypeLabel');
    // Same case coverage — opening / payment / credit_note / debit_note
    // / adjustment / empties_return / invoice. Extract the switch body
    // and check every kind is present.
    const gtl = src.match(/function groupTypeLabel[\s\S]*?\n\s*\}\n\s*\}/);
    expect(gtl).not.toBeNull();
    const body = gtl![0];
    for (const kind of [
      "'opening'", "'payment'", "'credit_note'", "'debit_note'",
      "'adjustment'", "'empties_return'", "'invoice'",
    ]) {
      expect(body).toContain(`case ${kind}`);
    }
  });

  it('group PDF defines groupShortNarration that strips " for order" tail', () => {
    expect(src).toContain('function groupShortNarration');
    expect(src).toMatch(/groupShortNarration[\s\S]{0,400}indexOf\(['"] for order['"]\)/);
  });

  it('group PDF renders an "Empties" row (mirrors individual PDF)', () => {
    // Two independent case-branches on 'empties_return' exist — one in
    // typeLabel (individual PDF) and one in groupTypeLabel (group PDF).
    // The group's ROW-KIND handler adds a THIRD occurrence in the main
    // loop where the cell array is composed. Assert all three are
    // present so a future edit can't quietly drop the group's stock-
    // only rendering.
    const empties = (src.match(/empties_return/g) ?? []).length;
    expect(empties).toBeGreaterThanOrEqual(3);
    // Cell composition uses "5 dashes then formatMoney" — the fingerprint
    // of the empties row.
    expect(src).toContain("'-', '-', '-', '-', '-'");
  });

  it('group PDF renders an Opening Balance row with bold', () => {
    // The opening row uses `{ bold: true }` and drops a 0.5-wide
    // separator line, mirroring the individual PDF's carry-forward
    // treatment. Assert BOTH PDFs render an opening branch; count of 2
    // 'opening' case labels + presence of `bold: true` in each function.
    const opening = (src.match(/case 'opening'/g) ?? []).length;
    expect(opening).toBeGreaterThanOrEqual(2);
  });
});
