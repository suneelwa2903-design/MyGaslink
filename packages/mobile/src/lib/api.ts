import axios, { type InternalAxiosRequestConfig, type AxiosError } from 'axios';
import * as SecureStore from 'expo-secure-store';
import type { ApiResponse } from '@gaslink/shared';

const BASE_URL = process.env.EXPO_PUBLIC_API_URL || 'http://localhost:5000/api';

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Token management via SecureStore
async function getToken(key: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(key);
  } catch {
    return null;
  }
}

async function setToken(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function removeToken(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

export const tokenStorage = {
  getAccessToken: () => getToken('accessToken'),
  getRefreshToken: () => getToken('refreshToken'),
  setTokens: async (access: string, refresh: string) => {
    await setToken('accessToken', access);
    await setToken('refreshToken', refresh);
  },
  clearTokens: async () => {
    await removeToken('accessToken');
    await removeToken('refreshToken');
  },
};

// Request interceptor
api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  const token = await getToken('accessToken');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  const distributorId = await getToken('selectedDistributorId');
  if (distributorId) {
    config.headers['X-Distributor-Id'] = distributorId;
  }
  return config;
});

// Response interceptor with token refresh
let isRefreshing = false;
let refreshQueue: Array<{ resolve: (t: string) => void; reject: (e: unknown) => void }> = [];

function processQueue(err: unknown, token?: string) {
  refreshQueue.forEach(({ resolve, reject }) => err ? reject(err) : resolve(token!));
  refreshQueue = [];
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<ApiResponse<null>>) => {
    const original = error.config as InternalAxiosRequestConfig & { _retry?: boolean };
    if (original?.url?.includes('/auth/')) return Promise.reject(error);

    // M14 v1.0 (IOS-ACCOUNT-DELETION-SPEC §5.2): the server returns 403
    // with error='account_pending_deletion' for any non-allowlisted request
    // by a user with a pending deletion. Bounce to the pending-deletion
    // screen so the user can cancel or sign out. Skip when the call IS
    // the deletion-status / cancel endpoint (the screen needs them).
    if (
      error.response?.status === 403
      && (error.response.data as { error?: string } | undefined)?.error === 'account_pending_deletion'
      && !original?.url?.includes('/users/me/deletion-request')
    ) {
      try {
        // Lazy import to dodge any module-init cycle with expo-router.
        const { router } = await import('expo-router');
        router.replace('/(shared)/pending-deletion');
      } catch {
        // Best-effort; the 403 still rejects below.
      }
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !original._retry) {
      original._retry = true;

      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (t) => { original.headers.Authorization = `Bearer ${t}`; resolve(api(original)); },
            reject,
          });
        });
      }

      isRefreshing = true;
      try {
        const refreshToken = await getToken('refreshToken');
        if (!refreshToken) throw new Error('No refresh token');

        const res = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken });
        const { accessToken, refreshToken: newRefresh } = res.data.data.tokens;
        await tokenStorage.setTokens(accessToken, newRefresh);
        original.headers.Authorization = `Bearer ${accessToken}`;
        processQueue(null, accessToken);
        return api(original);
      } catch (e) {
        processQueue(e);
        await tokenStorage.clearTokens();
        return Promise.reject(e);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(error);
  },
);

// Typed helpers
export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res = await api.get<ApiResponse<T>>(url, { params });
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

export function getErrorMessage(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as
      | (ApiResponse<null> & { code?: string; details?: Record<string, string[] | undefined> })
      | undefined;
    // Validation failures from the server's sendValidationError() expose
    // a `details` map of field → array-of-messages (Zod's
    // flatten().fieldErrors shape). The top-level error is a generic
    // "Validation failed" string; alone, that tells the user nothing.
    // Expand the field-level messages into a readable one-liner so the
    // user actually sees which field rejected the payload.
    if (data?.code === 'VALIDATION_ERROR' && data?.details) {
      const parts: string[] = [];
      for (const [field, messages] of Object.entries(data.details)) {
        if (Array.isArray(messages) && messages.length > 0) {
          parts.push(`${field}: ${messages.join(', ')}`);
        }
      }
      if (parts.length > 0) {
        return `${data.error ?? 'Validation failed'} — ${parts.join('; ')}`;
      }
    }
    return data?.error || error.message || 'Something went wrong';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong';
}

// WI-122: some endpoints encode a structured payload in the error message
// (e.g. the order-placement overdue gate returns a JSON string describing the
// escalation level). Returns the parsed object, or null for plain-text errors.
export function parseStructuredError(error: unknown): Record<string, unknown> | null {
  const msg = getErrorMessage(error);
  try {
    const parsed = JSON.parse(msg);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
