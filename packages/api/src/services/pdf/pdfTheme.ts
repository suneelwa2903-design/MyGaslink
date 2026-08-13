/**
 * Per-distributor PDF accent colour (2026-08-13, Suneel).
 *
 * Distributors pick one accent colour in Settings → General; every PDF they
 * generate is themed with it. Stored as a key-value DistributorSetting
 * (`pdfAccentColor` → one of the keys below) so there is NO schema migration.
 *
 * The value is resolved to a hex at PDF-generation time via
 * getPdfAccentColor(distributorId). Blue is the historical default (the
 * '#0a3d62' every PDF template hardcoded before this feature), so tenants
 * that never touch the setting see no change.
 *
 * IMPORTANT: resolve the colour into a FUNCTION-LOCAL constant inside each
 * PDF generate function and thread it down to the drawing helpers. Do NOT
 * stash it in module-level mutable state — two distributors generating PDFs
 * concurrently would race on it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSetting } from '../settingsService.js';

export type PdfAccentKey = 'blue' | 'red' | 'green' | 'amber';

/** The 4 selectable accents. Each hex is dark enough for white text on top. */
export const PDF_ACCENT_HEX: Record<PdfAccentKey, string> = {
  blue: '#0a3d62', // historical default
  red: '#b91c1c', // MyGasLink red
  green: '#15803d', // natural green
  amber: '#b45309', // amber
};

export const PDF_ACCENT_KEYS: PdfAccentKey[] = ['blue', 'red', 'green', 'amber'];

export const DEFAULT_PDF_ACCENT_HEX = PDF_ACCENT_HEX.blue;

function isAccentKey(v: unknown): v is PdfAccentKey {
  return typeof v === 'string' && (PDF_ACCENT_KEYS as string[]).includes(v);
}

/**
 * Resolve a distributor's chosen PDF accent to a hex string. Falls back to the
 * historical blue when unset or invalid — never throws, so PDF generation is
 * never blocked by a settings read.
 */
export async function getPdfAccentColor(distributorId: string): Promise<string> {
  try {
    const row = await getSetting(distributorId, 'pdfAccentColor');
    const value = row?.settingValue;
    if (isAccentKey(value)) return PDF_ACCENT_HEX[value];
    // Tolerate a raw hex too (forward-compat if the picker ever stores hex).
    if (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)) return value;
    return DEFAULT_PDF_ACCENT_HEX;
  } catch {
    return DEFAULT_PDF_ACCENT_HEX;
  }
}

// ─── Per-request accent context (concurrency-safe) ──────────────────────────
//
// The colour is stashed in an AsyncLocalStorage so a PDF template's module-
// level THEME can expose PRIMARY as a getter (`get PRIMARY() { return
// currentPdfAccent(); }`) that reads the colour of the CURRENT PDF being
// generated — with zero risk of two distributors racing on shared state, and
// without threading the colour through every drawing helper. Each PDF's
// generate function wraps its body in withPdfAccent(accent, () => …); the
// context (and thus the colour) propagates across every await inside.
const accentStore = new AsyncLocalStorage<string>();

/** Run `fn` with `accent` as the active PDF accent for its entire async subtree. */
export function withPdfAccent<T>(accent: string, fn: () => T): T {
  return accentStore.run(accent, fn);
}

/** The accent of the PDF currently generating, or the default blue outside any. */
export function currentPdfAccent(): string {
  return accentStore.getStore() ?? DEFAULT_PDF_ACCENT_HEX;
}

/**
 * One-liner for a PDF generate function: resolve the distributor's accent and
 * bind it to the CURRENT async context via `enterWith`, so `currentPdfAccent()`
 * (and thus THEME.PRIMARY getters) return it for the rest of this generation —
 * across every await + drawing helper — with no body wrapping.
 *
 * Safe because each PDF is generated in its own request async context and each
 * `enterWith` overwrites any prior value, so sequential generations in one
 * request never cross-contaminate. Undefined distributorId → default blue
 * (e.g. billing-invoice PDFs that can be generated without a tenant).
 */
export async function applyPdfAccent(distributorId?: string | null): Promise<void> {
  const accent = distributorId ? await getPdfAccentColor(distributorId) : DEFAULT_PDF_ACCENT_HEX;
  accentStore.enterWith(accent);
}

/**
 * Bind an already-resolved accent to the current async context SYNCHRONOUSLY.
 * MUST be called directly inside the generate function (not via an awaited
 * helper) so `enterWith` runs in the generate's own context and persists to
 * its subsequent awaits + drawing helpers. Usage:
 *   setPdfAccent(await getPdfAccentColor(distributorId));
 */
export function setPdfAccent(accent: string): void {
  accentStore.enterWith(accent);
}
