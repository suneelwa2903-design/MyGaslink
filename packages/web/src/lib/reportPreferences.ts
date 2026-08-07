/**
 * Report preferences — Phase 1 templates polish (2026-08-05).
 *
 * Everything lives in browser localStorage keyed by the current user
 * ID + report slug. Zero server dependency. Safe to blow away on
 * cache clear — user just resets to defaults, no data loss.
 *
 * Design principle: every helper is defensive — malformed JSON in
 * localStorage returns the empty default rather than throwing. Users
 * who wipe just one key don't get a broken page.
 */

const NAMESPACE = 'gaslink.report-prefs.v1';

// ─── Helpers ──────────────────────────────────────────────────────────

function key(userId: string, slug: string, feature: string): string {
  return `${NAMESPACE}:${userId}:${slug}:${feature}`;
}

function readJson<T>(k: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(k);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(k: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(k, JSON.stringify(value));
  } catch {
    /* quota exceeded or storage disabled — silent fail is fine here */
  }
}

function removeKey(k: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(k);
  } catch {
    /* ignore */
  }
}

// ─── A. Filter presets (per user × per report) ────────────────────────
//
// Each preset stores the filter values the user picked + the dateFrom/
// dateTo they had at save time. Loading a preset restores all of them.

export interface FilterPreset {
  id: string;         // random uuid-ish; used to identify for delete
  name: string;       // user-typed name
  createdAt: string;  // ISO timestamp
  filters: Record<string, string>; // e.g. { customerId: '...', driverId: '...' }
  dateFrom?: string;
  dateTo?: string;
}

export function listFilterPresets(userId: string, slug: string): FilterPreset[] {
  return readJson<FilterPreset[]>(key(userId, slug, 'filter-presets'), []);
}

export function saveFilterPreset(userId: string, slug: string, preset: Omit<FilterPreset, 'id' | 'createdAt'>): FilterPreset {
  const list = listFilterPresets(userId, slug);
  const full: FilterPreset = {
    id: `p_${Math.random().toString(36).slice(2, 10)}`,
    createdAt: new Date().toISOString(),
    ...preset,
  };
  // Overwrite an existing preset with the same name (users prefer this
  // to being told "already exists" — mirrors Notion / Figma behavior).
  const filtered = list.filter((p) => p.name !== preset.name);
  filtered.push(full);
  writeJson(key(userId, slug, 'filter-presets'), filtered);
  return full;
}

export function deleteFilterPreset(userId: string, slug: string, presetId: string): void {
  const list = listFilterPresets(userId, slug);
  writeJson(key(userId, slug, 'filter-presets'), list.filter((p) => p.id !== presetId));
}

// ─── B. Column visibility (per user × per report) ─────────────────────
//
// Stores the set of column keys the user HIDES. Everything else is
// visible by default — this way new columns added by the API get
// shown automatically instead of silently disappearing.

export function getHiddenColumns(userId: string, slug: string): Set<string> {
  const arr = readJson<string[]>(key(userId, slug, 'hidden-cols'), []);
  return new Set(arr);
}

export function setHiddenColumns(userId: string, slug: string, hidden: Set<string>): void {
  writeJson(key(userId, slug, 'hidden-cols'), [...hidden]);
}

// ─── C. Sticky date range (per user, ALL reports) ─────────────────────
//
// Single key per user (not per report). Persists last-picked
// dateFrom / dateTo so switching between reports carries the range.
// User can clear via a "Reset dates" button.

export interface StickyDates {
  dateFrom: string;
  dateTo: string;
}

export function getStickyDates(userId: string): StickyDates | null {
  return readJson<StickyDates | null>(`${NAMESPACE}:${userId}:__sticky-dates`, null);
}

export function setStickyDates(userId: string, dates: StickyDates): void {
  writeJson(`${NAMESPACE}:${userId}:__sticky-dates`, dates);
}

export function clearStickyDates(userId: string): void {
  removeKey(`${NAMESPACE}:${userId}:__sticky-dates`);
}

// ─── D. Recent reports (per user, ALL reports) ────────────────────────
//
// FIFO list of report slugs, most-recently-selected first. Cap at 5.
// Deduplicated — reopening a report bumps it to the top rather than
// adding a duplicate entry.

const RECENT_CAP = 5;

export function getRecentReports(userId: string): string[] {
  return readJson<string[]>(`${NAMESPACE}:${userId}:__recent`, []);
}

export function pushRecentReport(userId: string, slug: string): string[] {
  const current = getRecentReports(userId);
  const deduped = [slug, ...current.filter((s) => s !== slug)].slice(0, RECENT_CAP);
  writeJson(`${NAMESPACE}:${userId}:__recent`, deduped);
  return deduped;
}
