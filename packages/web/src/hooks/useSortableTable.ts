/**
 * useSortableTable — three-state header toggle used with <SortableTh>.
 * Click sequence on the SAME column: asc → desc → clear (returns to
 * the default). Clicking a different column jumps straight to its
 * default direction (typically 'desc' for dates/amounts, callers set
 * this via defaultDir).
 *
 * State is intentionally local — pages that want URL-persisted sort
 * can lift the {sortBy, sortDir} pair and mirror it into search params
 * themselves. Keeping the hook lightweight avoids coupling to any
 * particular route store.
 */
import { useCallback, useState } from 'react';
import type { SortDir } from '../components/ui/SortableTh';

export function useSortableTable(defaultColumn: string | null, defaultDir: SortDir = 'desc') {
  const [sortBy, setSortBy] = useState<string | null>(defaultColumn);
  const [sortDir, setSortDir] = useState<SortDir>(defaultDir);

  const toggle = useCallback((column: string) => {
    if (column !== sortBy) {
      setSortBy(column);
      setSortDir(defaultDir);
      return;
    }
    if (sortDir === defaultDir) {
      setSortDir(defaultDir === 'desc' ? 'asc' : 'desc');
      return;
    }
    // Third click on the same column → clear back to default.
    setSortBy(defaultColumn);
    setSortDir(defaultDir);
  }, [sortBy, sortDir, defaultColumn, defaultDir]);

  return { sortBy, sortDir, toggle } as const;
}
