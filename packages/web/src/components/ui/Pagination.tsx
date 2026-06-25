import { Button } from './Button';
import { HiOutlineChevronLeft, HiOutlineChevronRight } from 'react-icons/hi2';

/**
 * Standard pagination footer: "Showing X–Y of Z · page N of M" + Prev / Next.
 *
 * Designed for the PaginationMeta shape returned by listInvoices /
 * listPayments. Renders nothing when total is 0 — the caller still shows
 * its own empty-state above the table.
 */
export function Pagination({
  page,
  pageSize,
  total,
  totalPages,
  onChange,
  itemLabel = 'items',
}: {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  onChange: (page: number) => void;
  itemLabel?: string;
}) {
  if (total <= 0) return null;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between pt-3">
      <p className="text-xs text-surface-500 dark:text-surface-400">
        Showing <strong>{first}</strong>–<strong>{last}</strong> of <strong>{total}</strong> {itemLabel}
        {totalPages > 1 && ` · page ${page} of ${totalPages}`}
      </p>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={prevDisabled}
          onClick={() => !prevDisabled && onChange(page - 1)}
        >
          <HiOutlineChevronLeft className="h-3 w-3" />
          Prev
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={nextDisabled}
          onClick={() => !nextDisabled && onChange(page + 1)}
        >
          Next
          <HiOutlineChevronRight className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
