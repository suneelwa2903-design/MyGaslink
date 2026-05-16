/**
 * Format the small CN/DN count pill that renders next to an invoice
 * number on the Billing list (WI-056). Pure function so it's covered
 * by a unit test without needing JSX-render infrastructure in the web
 * package.
 *
 *   count = 1 → just the prefix ("CN", "DN") — cleaner when most
 *               invoices only ever have one note.
 *   count ≥ 2 → "CN ×2" / "DN ×3". The multiplication sign is
 *               immediately scannable in a busy table; "CN 2" reads
 *               like an invoice number.
 *   count < 1 → empty string. Caller should not render a badge.
 */
export function formatNoteCountLabel(count: number, prefix: 'CN' | 'DN'): string {
  if (!Number.isFinite(count) || count < 1) return '';
  if (count === 1) return prefix;
  return `${prefix} ×${count}`;
}
