/**
 * SortableTh — a table header cell that toggles a sort column when
 * clicked. Renders a chevron indicator on the currently-active column
 * (↑ for asc, ↓ for desc). Passing a column that isn't the active one
 * still renders the neutral ↕ hint so users can see it's clickable.
 *
 * Usage:
 *   const { sortBy, sortDir, toggle } = useSortableTable('createdAt', 'desc');
 *   <th>...</th>
 *   <SortableTh column="issueDate" active={sortBy} dir={sortDir} onToggle={toggle}>
 *     Issue Date
 *   </SortableTh>
 *
 * The `column` prop must be one of the whitelisted values on the backend
 * (see e.g. invoiceService.listInvoices ALLOWED_SORT). Passing an
 * unrecognised column is caller-safe — the backend silently falls back
 * to createdAt-desc.
 */
import type { ReactNode } from 'react';

export type SortDir = 'asc' | 'desc';

interface Props {
  /** Column key sent to the API (must match the backend whitelist). */
  column: string;
  /** Currently active column (or null when the table is unsorted). */
  active: string | null;
  /** Direction of the active column — ignored when `active` differs. */
  dir: SortDir;
  onToggle: (column: string) => void;
  className?: string;
  /** Header alignment. Default is 'left' to match the `.table`'s
   * text-left convention — headers stay lined up with their data
   * cells vertically. Pass 'right' for numeric columns that also
   * right-align the value in the <td>. */
  align?: 'left' | 'right' | 'center';
  children: ReactNode;
}

export function SortableTh({
  column, active, dir, onToggle, className, align = 'left', children,
}: Props) {
  const isActive = active === column;
  const arrow = !isActive ? '↕' : dir === 'asc' ? '↑' : '↓';
  const alignCls =
    align === 'right' ? 'text-right' :
    align === 'left' ? 'text-left' :
    'text-center';
  // Match the label + chevron layout to the alignment so the chevron
  // sits next to the text (centered pair, not floated far right).
  const wrapperJustify =
    align === 'right' ? 'justify-end' :
    align === 'left' ? 'justify-start' :
    'justify-center';
  return (
    <th
      className={
        `cursor-pointer select-none hover:text-brand-600 dark:hover:text-brand-400 ${alignCls} ${className ?? ''}`
      }
      onClick={() => onToggle(column)}
      aria-sort={isActive ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className={`inline-flex items-center gap-1 ${wrapperJustify}`}>
        {children}
        <span
          className={
            isActive
              ? 'text-brand-500 dark:text-brand-400 text-xs'
              : 'text-surface-300 dark:text-surface-600 text-xs'
          }
          aria-hidden
        >
          {arrow}
        </span>
      </span>
    </th>
  );
}
