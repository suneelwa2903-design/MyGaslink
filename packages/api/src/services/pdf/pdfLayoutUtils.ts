/**
 * PDF Layout Utilities
 * Helper functions for crisp GST invoice layout using pdfkit.
 */

// ─── Money & Number Formatting ───────────────────────────────────────────────

/** Format INR with Rs. prefix (safe for Helvetica which lacks the rupee glyph). */
export function formatMoney(value: number | null | undefined): string {
  const n = Number(value);
  const safe = value == null || Number.isNaN(n) ? 0 : n;
  const s = safe.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `Rs. ${s}`;
}

/** Round to 2 decimal places. */
export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Format date as DD-MMM-YYYY (e.g. 24-Jan-2025). */
export function formatDate(d: Date | string | null | undefined): string {
  if (!d) return '\u2014';
  const dt = typeof d === 'string' ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return '\u2014';
  const day = String(dt.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day}-${months[dt.getMonth()]}-${dt.getFullYear()}`;
}

/** Format IRN for display — chunk into groups of 16 chars per line. */
export function formatIrnForDisplay(irn: string | null | undefined): string {
  if (!irn || irn.length === 0) return '\u2014';
  const chunks: string[] = [];
  for (let i = 0; i < irn.length; i += 16) {
    chunks.push(irn.substring(i, i + 16));
  }
  return chunks.join('\n');
}

// ─── Number-to-Words (Indian format) ────────────────────────────────────────

export function numberToWords(num: number): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  const teens = ['Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

  function convertTwoDigits(n: number): string {
    if (n === 0) return '';
    if (n < 10) return ones[n];
    if (n < 20) return teens[n - 10];
    return tens[Math.floor(n / 10)] + (n % 10 > 0 ? ' ' + ones[n % 10] : '');
  }

  function convertThreeDigits(n: number): string {
    if (n === 0) return '';
    const hundred = Math.floor(n / 100);
    const remainder = n % 100;
    let result = '';
    if (hundred > 0) {
      result = ones[hundred] + ' Hundred';
      if (remainder > 0) result += ' ';
    }
    if (remainder > 0) result += convertTwoDigits(remainder);
    return result.trim();
  }

  if (num === 0) return 'Zero Rupees Only';

  const rupees = Math.floor(num);
  const paise = Math.round((num - rupees) * 100);
  let result = '';

  if (rupees >= 10000000) {
    const crores = Math.floor(rupees / 10000000);
    result += convertThreeDigits(crores) + ' Crore' + (crores > 1 ? 's' : '') + ' ';
  }
  const afterCrores = rupees % 10000000;
  if (afterCrores >= 100000) {
    const lakhs = Math.floor(afterCrores / 100000);
    result += convertTwoDigits(lakhs) + ' Lakh' + (lakhs > 1 ? 's' : '') + ' ';
  }
  const afterLakhs = afterCrores % 100000;
  if (afterLakhs >= 1000) {
    const thousands = Math.floor(afterLakhs / 1000);
    result += convertTwoDigits(thousands) + ' Thousand' + (thousands > 1 ? 's' : '') + ' ';
  }
  const afterThousands = afterLakhs % 1000;
  if (afterThousands > 0) {
    result += convertThreeDigits(afterThousands);
  }

  result = result.trim();
  if (!result) result = 'Zero';
  result += ' Rupee' + (rupees !== 1 ? 's' : '');
  if (paise > 0) {
    result += ' and ' + convertTwoDigits(paise) + ' Paise';
  }
  result += ' Only';
  return result;
}

// ─── PDFKit Drawing Helpers ─────────────────────────────────────────────────

/** Draw a light border rectangle. */
export function drawBox(doc: PDFKit.PDFDocument, x: number, y: number, w: number, h: number, color = '#E5E7EB'): void {
  doc.strokeColor(color).lineWidth(0.5);
  doc.rect(x, y, w, h).stroke();
  doc.strokeColor('black');
}

/** Draw table header with colored background. Returns header height. */
export function drawTableHeader(
  doc: PDFKit.PDFDocument,
  x: number, y: number,
  colDefs: { label: string; width: number; align?: string }[],
  headerColor = '#0a3d62',
  tableWidth?: number,
): number {
  const headerHeight = 28;
  const totalWidth = tableWidth ?? colDefs.reduce((sum, col) => sum + col.width, 0);
  doc.rect(x, y, totalWidth, headerHeight).fill(headerColor);
  doc.fontSize(9).fillColor('#ffffff').font('Helvetica-Bold');
  let cx = x + 5;
  for (const col of colDefs) {
    doc.text(col.label, cx, y + 10, { width: col.width - 10, align: (col.align as any) || 'left' });
    cx += col.width;
  }
  doc.fillColor('black').font('Helvetica');
  return headerHeight;
}

/** Draw text block with wrapping. Returns height used. */
export function drawTextBlock(
  doc: PDFKit.PDFDocument,
  x: number, y: number, w: number,
  text: string | null | undefined,
  fontSize = 9,
  options: { bold?: boolean; color?: string } = {},
): number {
  if (!text) return 0;
  doc.fontSize(fontSize);
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica');
  doc.fillColor(options.color || 'black');
  try {
    const heightInfo = doc.heightOfString(text, { width: w }) as any;
    const height: number = typeof heightInfo === 'number' ? heightInfo : heightInfo?.height ?? fontSize * 1.5;
    doc.text(text, x, y, { width: w, lineGap: 0, paragraphGap: 0 });
    doc.font('Helvetica').fillColor('black');
    return height;
  } catch {
    const lines = text.split(',').map((s) => s.trim()).filter(Boolean);
    const lineHeight = fontSize * 1.2;
    let cy = y;
    for (const line of lines) {
      doc.text(line, x, cy, { width: w });
      cy += lineHeight;
    }
    doc.font('Helvetica').fillColor('black');
    return lines.length * lineHeight;
  }
}

/** Draw "Page X of Y" in footer style. */
export function drawPageNumber(doc: PDFKit.PDFDocument, x: number, y: number, page: number, total: number): void {
  doc.fontSize(7).fillColor('#6b7280').font('Helvetica');
  doc.text(`Page ${page} of ${total}`, x, y, { align: 'right', width: 80 });
  doc.fillColor('black');
}
