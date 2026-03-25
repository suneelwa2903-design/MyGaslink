import { cn } from '@/lib/cn';

interface LoaderProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Loader({ size = 'md', className }: LoaderProps) {
  const sizeClasses = { sm: 'h-4 w-4', md: 'h-8 w-8', lg: 'h-12 w-12' };
  return (
    <svg
      className={cn('animate-spin text-brand-500', sizeClasses[size], className)}
      viewBox="0 0 24 24"
      fill="none"
    >
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}

export function FullPageLoader() {
  return (
    <div className="flex items-center justify-center min-h-screen bg-surface-50 dark:bg-surface-950">
      <div className="text-center">
        <Loader size="lg" />
        <p className="mt-4 text-surface-500 dark:text-surface-400 text-sm">Loading...</p>
      </div>
    </div>
  );
}
