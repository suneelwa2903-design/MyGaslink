import { forwardRef, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/cn';

export interface ComboboxOption {
  value: string;
  label: string;
}

interface ComboboxProps {
  label?: string;
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  /** When set, restricts selection to options in the list (typed value that doesn't match is rejected on blur). */
  strict?: boolean;
  /** Optional helper text shown below the input when no error is active. */
  helperText?: string;
}

// Searchable combobox. Type to filter, arrow keys to navigate, Enter to
// select. Built on a controlled text input + filtered listbox dropdown.
// Designed to drop in next to packages/web/src/components/ui/Input.tsx so
// forms can swap a free-text state field for a curated list (37 Indian
// states) without dragging in a UI library.
export const Combobox = forwardRef<HTMLInputElement, ComboboxProps>(
  ({ label, options, value, onChange, placeholder, error, disabled, required, id, className, strict, helperText }, ref) => {
    const generatedId = useId();
    const inputId = id || generatedId;
    const listboxId = `${inputId}-listbox`;

    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState(value);
    const [highlight, setHighlight] = useState(0);

    // Keep the input synced with external value changes (e.g. RHF setValue
    // after a GSTIN lookup populates state). Only resync when the input
    // isn't currently focused so we don't fight the user's typing.
    const inputRef = useRef<HTMLInputElement | null>(null);
    useEffect(() => {
      if (document.activeElement !== inputRef.current) {
        setQuery(value);
      }
    }, [value]);

    const filtered = useMemo(() => {
      if (!query) return options;
      const q = query.toLowerCase();
      return options.filter((opt) => opt.label.toLowerCase().includes(q));
    }, [options, query]);

    // Close on outside click.
    const containerRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => {
      if (!open) return;
      const handler = (e: MouseEvent) => {
        if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
          setOpen(false);
          // On outside click, if strict and the typed query is not a valid
          // option, revert to last committed value. Otherwise pass-through.
          if (strict) {
            const match = options.find((opt) => opt.label.toLowerCase() === query.toLowerCase());
            if (!match) setQuery(value);
          }
        }
      };
      document.addEventListener('mousedown', handler);
      return () => document.removeEventListener('mousedown', handler);
    }, [open, options, query, strict, value]);

    const commit = (opt: ComboboxOption) => {
      onChange(opt.value);
      setQuery(opt.label);
      setOpen(false);
    };

    const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (!open) setOpen(true);
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (open && filtered[highlight]) commit(filtered[highlight]);
      } else if (e.key === 'Escape') {
        setOpen(false);
        setQuery(value);
      }
    };

    return (
      <div ref={containerRef} className={cn('relative', className)}>
        {label && (
          <label htmlFor={inputId} className="label">
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <input
          ref={(el) => {
            inputRef.current = el;
            if (typeof ref === 'function') ref(el);
            else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = el;
          }}
          id={inputId}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          autoComplete="off"
          disabled={disabled}
          value={query}
          placeholder={placeholder}
          className={cn('input', error && 'input-error')}
          onFocus={() => !disabled && setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setHighlight(0);
            // For non-strict modes, also propagate the raw query so
            // consumers see partial typing. Strict commits only on select.
            if (!strict) onChange(e.target.value);
          }}
          onKeyDown={handleKey}
        />
        {open && filtered.length > 0 && (
          <ul
            id={listboxId}
            role="listbox"
            className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-surface-200 bg-white shadow-lg dark:border-surface-700 dark:bg-surface-800"
          >
            {filtered.map((opt, idx) => (
              <li
                key={opt.value}
                role="option"
                aria-selected={idx === highlight}
                className={cn(
                  'cursor-pointer px-3 py-2 text-sm',
                  idx === highlight
                    ? 'bg-brand-50 text-brand-900 dark:bg-brand-900/30 dark:text-brand-100'
                    : 'text-surface-700 dark:text-surface-200 hover:bg-surface-50 dark:hover:bg-surface-700',
                )}
                onMouseEnter={() => setHighlight(idx)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(opt);
                }}
              >
                {opt.label}
              </li>
            ))}
          </ul>
        )}
        {open && filtered.length === 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-surface-200 bg-white px-3 py-2 text-xs text-surface-500 shadow-lg dark:border-surface-700 dark:bg-surface-800">
            No matches
          </div>
        )}
        {error
          ? <p className="error-text">{error}</p>
          : helperText ? <p className="mt-1 text-xs text-surface-500">{helperText}</p> : null}
      </div>
    );
  },
);
Combobox.displayName = 'Combobox';
