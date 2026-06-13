import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { HiOutlineMagnifyingGlass, HiOutlineXMark } from 'react-icons/hi2';
import type { Customer } from '@gaslink/shared';
import { apiGet } from '@/lib/api';
import { Loader } from './Loader';
import { cn } from '@/lib/cn';

interface CustomerSearchInputProps {
  /** Selected customerId (controlled). Empty string = no selection. */
  value: string;
  /** Fires with the new customerId and the full Customer when the operator picks one. Empty string when cleared. */
  onChange: (customerId: string, customer?: Customer) => void;
  label?: string;
  required?: boolean;
  error?: string;
  /**
   * When opening an Edit modal (or any non-empty initial selection), pass the
   * already-selected customer's display name so the locked field renders
   * immediately without an extra fetch.
   */
  initialCustomerName?: string;
  placeholder?: string;
  disabled?: boolean;
}

const MIN_CHARS = 3;
const DEBOUNCE_MS = 300;
const RESULT_LIMIT = 10;

export function CustomerSearchInput({
  value,
  onChange,
  label,
  required,
  error,
  initialCustomerName,
  placeholder = 'Type name or phone to search...',
  disabled,
}: CustomerSearchInputProps) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [pickedName, setPickedName] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Derived during render — no setState-in-effect needed.
  // If the parent clears `value`, displayName becomes '' automatically; if
  // the user picks one in this session, pickedName wins over the initial
  // prop; if neither is set, fall back to the parent-supplied initial name.
  const displayName = value ? (pickedName || initialCustomerName || '') : '';

  // Debounce — schedule the next debounced value inside the timer (deferred),
  // so we never call setState synchronously inside an effect.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(query.length >= MIN_CHARS ? query : '');
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const { data, isFetching } = useQuery({
    queryKey: ['customer-search', debouncedQuery],
    queryFn: () =>
      apiGet<{ customers: Customer[] }>('/customers', {
        search: debouncedQuery,
        pageSize: RESULT_LIMIT,
      }),
    enabled: debouncedQuery.length >= MIN_CHARS,
    staleTime: 30_000,
  });

  const results = data?.customers ?? [];

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const handleClear = () => {
    onChange('');
    setPickedName('');
    setQuery('');
    setDebouncedQuery('');
  };

  // Locked-selected state
  if (value && displayName) {
    return (
      <div>
        {label && (
          <label className="label">
            {label}
            {required && <span className="text-red-500"> *</span>}
          </label>
        )}
        <div className="input flex items-center gap-2 py-2">
          <span className="flex-1 truncate text-surface-900 dark:text-white">{displayName}</span>
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled}
            className="p-1 rounded hover:bg-surface-200 dark:hover:bg-surface-600 text-surface-500 disabled:cursor-not-allowed disabled:opacity-50"
            title="Clear selection"
            aria-label="Clear customer selection"
          >
            <HiOutlineXMark className="h-4 w-4" />
          </button>
        </div>
        {error && <p className="error-text">{error}</p>}
      </div>
    );
  }

  const showShortHint = open && query.length > 0 && query.length < MIN_CHARS;
  const showNoResults = open && debouncedQuery.length >= MIN_CHARS && !isFetching && results.length === 0;
  const showResults = open && results.length > 0;

  return (
    <div ref={containerRef} className="relative">
      {label && (
        <label className="label">
          {label}
          {required && <span className="text-red-500"> *</span>}
        </label>
      )}
      <div className="relative">
        <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-surface-400 pointer-events-none" />
        <input
          type="text"
          placeholder={placeholder}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          disabled={disabled}
          className={cn('input pl-9 py-2', error && 'border-red-500 focus:ring-red-500')}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {isFetching && (
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            <Loader size="sm" />
          </div>
        )}
      </div>

      {showShortHint && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg">
          <div className="px-3 py-2 text-sm text-surface-500 dark:text-surface-400">
            Type at least {MIN_CHARS} characters to search
          </div>
        </div>
      )}

      {showNoResults && (
        <div className="absolute z-20 mt-1 w-full rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg">
          <div className="px-3 py-2 text-sm text-surface-500 dark:text-surface-400">
            No customer found for &ldquo;{debouncedQuery}&rdquo;
          </div>
        </div>
      )}

      {showResults && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-800 shadow-lg">
          {results.map((c) => (
            <button
              key={c.customerId}
              type="button"
              onClick={() => {
                onChange(c.customerId, c);
                setPickedName(c.customerName);
                setOpen(false);
                setQuery('');
                setDebouncedQuery('');
              }}
              className="w-full text-left px-3 py-2 hover:bg-surface-50 dark:hover:bg-surface-700 border-b last:border-b-0 border-surface-100 dark:border-surface-700/50"
            >
              <div className="font-medium text-surface-900 dark:text-white truncate">{c.customerName}</div>
              <div className="text-xs text-surface-500 dark:text-surface-400 truncate">
                {c.phone}
                {c.businessName ? ` • ${c.businessName}` : ''}
              </div>
            </button>
          ))}
        </div>
      )}

      {error && !showResults && !showShortHint && !showNoResults && (
        <p className="error-text">{error}</p>
      )}
    </div>
  );
}
