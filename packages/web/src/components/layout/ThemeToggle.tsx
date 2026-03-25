import { HiSun, HiMoon, HiComputerDesktop } from 'react-icons/hi2';
import { useThemeStore } from '@/stores/themeStore';
import { cn } from '@/lib/cn';

export function ThemeToggle() {
  const { theme, setTheme } = useThemeStore();

  const options = [
    { value: 'light' as const, icon: HiSun, label: 'Light' },
    { value: 'dark' as const, icon: HiMoon, label: 'Dark' },
    { value: 'system' as const, icon: HiComputerDesktop, label: 'System' },
  ];

  return (
    <div className="flex items-center gap-1 bg-surface-100 dark:bg-surface-700 rounded-lg p-1">
      {options.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          onClick={() => setTheme(value)}
          className={cn(
            'p-1.5 rounded-md transition-colors',
            theme === value
              ? 'bg-white dark:bg-surface-600 shadow-sm text-brand-600 dark:text-brand-400'
              : 'text-surface-500 hover:text-surface-700 dark:hover:text-surface-300',
          )}
          title={label}
        >
          <Icon className="h-4 w-4" />
        </button>
      ))}
    </div>
  );
}
