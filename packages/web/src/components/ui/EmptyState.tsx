import { cn } from '@/lib/cn';
import { HiOutlineInboxStack } from 'react-icons/hi2';

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({
  title = 'No data found',
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div className={cn('flex flex-col items-center justify-center py-12 px-4 text-center', className)}>
      <div className="text-surface-300 dark:text-surface-600 mb-4">
        {icon || <HiOutlineInboxStack className="h-16 w-16" />}
      </div>
      <h3 className="text-lg font-semibold text-surface-700 dark:text-surface-300">{title}</h3>
      {description && (
        <p className="mt-1 text-sm text-surface-500 dark:text-surface-400 max-w-sm">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
