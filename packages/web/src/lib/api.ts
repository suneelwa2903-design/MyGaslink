import axios, { type AxiosError, type InternalAxiosRequestConfig } from 'axios';
import type { ApiResponse } from '@gaslink/shared';
import { useAuthStore } from '@/stores/authStore';

const BASE_URL = import.meta.env.VITE_API_URL || '/api';

export const api = axios.create({
  baseURL: BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Request Interceptor: Attach tokens & distributor context ────────────────

api.interceptors.request.use((config: InternalAxiosRequestConfig) => {
  const { accessToken, selectedDistributorId } = useAuthStore.getState();

  if (accessToken) {
    config.headers.Authorization = `Bearer ${accessToken}`;
  }

  if (selectedDistributorId) {
    config.headers['X-Distributor-Id'] = selectedDistributorId;
  }

  return config;
});

// ─── Response Interceptor: Token refresh on 401 ─────────────────────────────

let isRefreshing = false;
let refreshQueue: Array<{
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}> = [];

function processQueue(error: unknown, token?: string) {
  refreshQueue.forEach(({ resolve, reject }) => {
    if (error) reject(error);
    else if (token) resolve(token);
  });
  refreshQueue = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError<ApiResponse<null>>) => {
    const originalRequest = error.config as InternalAxiosRequestConfig & { _retry?: boolean };

    // Don't retry auth endpoints
    if (originalRequest?.url?.includes('/auth/')) {
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;

      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve, reject) => {
          refreshQueue.push({
            resolve: (token: string) => {
              originalRequest.headers.Authorization = `Bearer ${token}`;
              resolve(api(originalRequest));
            },
            reject,
          });
        });
      }

      isRefreshing = true;

      try {
        const { refreshToken, setTokens, logout } = useAuthStore.getState();
        if (!refreshToken) {
          logout();
          return Promise.reject(error);
        }

        const res = await axios.post(`${BASE_URL}/auth/refresh`, { refreshToken });
        const { accessToken: newAccess, refreshToken: newRefresh } = res.data.data.tokens;

        setTokens(newAccess, newRefresh);
        originalRequest.headers.Authorization = `Bearer ${newAccess}`;
        processQueue(null, newAccess);

        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);
        useAuthStore.getState().logout();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
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
