import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ApiResponse } from '@gaslink/shared';
import { useAuthStore } from '@/stores/authStore';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Token refresh: single-flight ───────────────────────────────────────────
//
// One shared `refreshPromise` so that however many requests need a fresh
// token at once — whether they noticed proactively (token about to expire)
// or reactively (got a 401) — they all await the SAME refresh call. The
// access token is rotated server-side on every refresh, so firing N refresh
// requests in parallel would be both wasteful and racy.

/** Decode a JWT's `exp` (epoch seconds). Returns null if unparseable. */
function getTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1] ?? ''));
    return typeof payload?.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

// Refresh when the access token is within this window of expiring (ms).
const REFRESH_SKEW_MS = 30_000;

let refreshPromise: Promise<string> | null = null;

/**
 * Exchange the stored refresh token for a fresh access/refresh pair.
 * Returns the new access token. De-duplicated: concurrent callers share
 * one in-flight request. On failure the session is cleared (logout) and
 * the error is rethrown so callers stop.
 */
function refreshAccessToken(): Promise<string> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const { refreshToken, setTokens, logout } = useAuthStore.getState();
    if (!refreshToken) {
      logout();
      throw new Error('No refresh token available');
    }
    try {
      // Bare axios (not `api`) so this call skips the interceptors below.
      const res = await axios.post<ApiResponse<{ tokens: { accessToken: string; refreshToken: string } }>>(
        `${BASE_URL}/auth/refresh`,
        { refreshToken },
      );
      const tokens = res.data.data?.tokens;
      if (!tokens?.accessToken || !tokens?.refreshToken) {
        throw new Error('Malformed refresh response');
      }
      setTokens(tokens.accessToken, tokens.refreshToken);
      return tokens.accessToken;
    } catch (err) {
      // Refresh itself failed (401/403/expired refresh token, network, or
      // bad payload) → the session is genuinely dead. This is the ONLY
      // path that logs the user out.
      useAuthStore.getState().logout();
      throw err;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ─── Request Interceptor: proactive refresh + attach tokens & tenant ─────────

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const state = useAuthStore.getState();
  let accessToken = state.accessToken;
  const { selectedDistributorId } = state;

  // Proactive refresh: if the access token is missing/expired/about to
  // expire, refresh BEFORE sending so the request never 401s. Skip for
  // /auth/* endpoints (login/refresh must not depend on a valid token).
  const isAuthEndpoint = config.url?.includes('/auth/');
  if (accessToken && !isAuthEndpoint) {
    const exp = getTokenExpiry(accessToken);
    const expiringSoon = exp === null || exp * 1000 - Date.now() < REFRESH_SKEW_MS;
    if (expiringSoon) {
      try {
        accessToken = await refreshAccessToken();
      } catch {
        // Refresh failed — refreshAccessToken already logged out. Let the
        // request proceed; it will 401 and surface naturally.
      }
    }
  }

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }
  if (selectedDistributorId) {
    config.headers['X-Distributor-Id'] = selectedDistributorId;
  }

  return config;
});

// ─── Response Interceptor: reactive 401 fallback ────────────────────────────

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse<null>>) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Don't retry auth endpoints
    if (originalRequest?.url?.includes('/auth/')) {
      return Promise.reject(error);
    }

    // Reactive fallback: a 401 that proactive refresh missed (e.g. the
    // token expired mid-flight, or clock skew). Refresh once, then retry
    // the original request transparently.
    //
    // IMPORTANT: only 401 triggers this. Every other status (400 validation,
    // 403, 404, 409, 5xx) is rejected as-is so the calling mutation/useQuery
    // handles it inline — never log the user out on a plain 4xx.
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      try {
        const newAccess = await refreshAccessToken();
        originalRequest.headers.Authorization = `Bearer ${newAccess}`;
        return api(originalRequest);
      } catch (refreshError) {
        // refreshAccessToken already cleared the session.
        return Promise.reject(refreshError);
      }
    }

    // Handle billing suspension
    if (error.response?.status === 403 && error.response.data?.code === 'BILLING_SUSPENDED') {
      window.location.href = '/app/billing/suspended';
      return Promise.reject(error);
    }

    return Promise.reject(error);
  },
);

// ─── Typed API helpers ───────────────────────────────────────────────────────

export async function apiGet<T>(url: string, params?: Record<string, unknown>, options?: { distributorIdOverride?: string }): Promise<T> {
  const headers: Record<string, string> = {};
  if (options?.distributorIdOverride) {
    headers['X-Distributor-Id'] = options.distributorIdOverride;
  }
  const res = await api.get<ApiResponse<T>>(url, { params, headers });
  return res.data.data;
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.post<ApiResponse<T>>(url, data);
  return res.data.data;
}

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.put<ApiResponse<T>>(url, data);
  return res.data.data;
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const res = await api.patch<ApiResponse<T>>(url, data);
  return res.data.data;
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res = await api.delete<ApiResponse<T>>(url);
  return res.data.data;
}

/**
 * Extract user-friendly error message from API error
 */
export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as ApiResponse<null> | undefined;
    return data?.error || error.message || 'Something went wrong';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}
