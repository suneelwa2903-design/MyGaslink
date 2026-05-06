import { useTranslation } from 'react-i18next';
import { setLanguage, SUPPORTED_LANGUAGES, type SupportedLanguage } from '@/lib/i18n';
import { cn } from '@/lib/cn';

/**
 * Compact EN/TE toggle. Place in nav bars or settings.
 */
export function LanguageSwitcher({ className }: { className?: string }) {
  const { i18n: i18next } = useTranslation();
  const active = (i18next.resolvedLanguage || 'en') as SupportedLanguage;

  return (
    <div
      className={cn(
        'inline-flex items-center rounded-lg border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 p-0.5 text-xs font-medium',
        className,
      )}
      role="group"
      aria-label="Language"
    >
      {SUPPORTED_LANGUAGES.map((lng) => {
        const isActive = active === lng;
        return (
          <button
            key={lng}
            type="button"
            onClick={() => setLanguage(lng)}
            className={cn(
              'px-2 py-1 rounded-md transition-colors',
              isActive
                ? 'bg-brand-500 text-white'
                : 'text-surface-600 dark:text-surface-300 hover:text-surface-900 dark:hover:text-surface-100',
            )}
            aria-pressed={isActive}
          >
            {lng === 'en' ? 'EN' : 'తె'}
          </button>
        );
      })}
    </div>
  );
}
