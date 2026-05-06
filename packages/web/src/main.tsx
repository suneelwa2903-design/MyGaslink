import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from 'react-hot-toast';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './lib/i18n'; // initialize i18next before first render
import './index.css';

// Initialize theme before first render to prevent flash
const storedTheme = (() => {
  try {
    const raw = localStorage.getItem('gaslink-theme');
    if (raw) {
      const parsed = JSON.parse(raw);
      return parsed?.state?.theme as string | undefined;
    }
  } catch {
    // ignore
  }
  return undefined;
})();

const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
const shouldBeDark =
  storedTheme === 'dark' || (storedTheme !== 'light' && prefersDark);
document.documentElement.classList.toggle('dark', shouldBeDark);

// TanStack Query client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30 * 1000,
    },
    mutations: {
      retry: 0,
    },
  },
});

const rootElement = document.getElementById('root')!;
const root = createRoot(rootElement);

root.render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
          <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              borderRadius: '12px',
              padding: '12px 16px',
              fontSize: '14px',
            },
            success: {
              iconTheme: {
                primary: '#10b981',
                secondary: '#ffffff',
              },
            },
            error: {
              iconTheme: {
                primary: '#ef4444',
                secondary: '#ffffff',
              },
            },
            }}
          />
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
