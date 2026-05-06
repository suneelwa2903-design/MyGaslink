import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from './ui/Button';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Top-level React error boundary.
 *
 * Catches any uncaught render error in the tree and shows a recoverable
 * fallback UI — never lets the user see a blank white screen.
 *
 * In production with VITE_SENTRY_DSN configured, errors are reported to
 * Sentry. Sentry is loaded dynamically so the dev bundle stays small and
 * unconfigured environments incur no runtime cost.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Always log to console — visible in dev and in production logs.
    // eslint-disable-next-line no-console
    console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);

    // Report to Sentry when (a) DSN is configured at build time, (b) we're
    // in a production build, and (c) the @sentry/browser package was loaded
    // via a separate <script> tag or globalThis.Sentry. The web bundle does
    // not depend on @sentry/browser today; once it does, swap this for a
    // direct dynamic import('@sentry/browser').
    if (import.meta.env.PROD && import.meta.env.VITE_SENTRY_DSN) {
      const sentry = (globalThis as { Sentry?: { captureException: (e: Error, ctx?: unknown) => void } }).Sentry;
      if (sentry?.captureException) {
        try {
          sentry.captureException(error, {
            contexts: { react: { componentStack: info.componentStack } },
          });
        } catch {
          // Reporting failed — already logged to console above.
        }
      }
    }
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-slate-900 px-4">
        <div className="max-w-md w-full bg-white dark:bg-slate-800 rounded-2xl shadow-lg p-8 text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-red-100 dark:bg-red-900/40 flex items-center justify-center">
            <svg
              className="h-6 w-6 text-red-600 dark:text-red-400"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 9v3m0 4h.01M5.07 19h13.86c1.54 0 2.5-1.67 1.73-3L13.73 4a2 2 0 0 0-3.46 0L3.34 16c-.77 1.33.19 3 1.73 3z" />
            </svg>
          </div>

          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100 mb-2">
            Something went wrong
          </h1>
          <p className="text-sm text-slate-600 dark:text-slate-400 mb-6">
            An unexpected error occurred while rendering this page. You can try
            again, or reload the app if the problem persists.
          </p>

          {import.meta.env.DEV && this.state.error && (
            <pre className="text-left text-xs bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 p-3 rounded-lg mb-6 overflow-auto max-h-40">
              {this.state.error.message}
            </pre>
          )}

          <div className="flex gap-3 justify-center">
            <Button variant="primary" onClick={this.handleRetry}>
              Try again
            </Button>
            <Button variant="secondary" onClick={this.handleReload}>
              Refresh page
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
