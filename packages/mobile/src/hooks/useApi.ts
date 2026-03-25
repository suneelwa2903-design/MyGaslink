import { useQuery, useMutation, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, getErrorMessage } from '../lib/api';
import { Alert } from 'react-native';

// ─── Query hooks ─────────────────────────────────────────────────────────────

export function useApiQuery<T>(
  key: string[],
  url: string,
  params?: Record<string, unknown>,
  options?: Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>,
) {
  return useQuery<T>({
    queryKey: key,
    queryFn: () => apiGet<T>(url, params),
    ...options,
  });
}

// ─── Mutation hooks ──────────────────────────────────────────────────────────

export function useApiMutation<TData, TVariables = unknown>(
  method: 'post' | 'put' | 'patch' | 'delete',
  url: string | ((vars: TVariables) => string),
  options?: {
    invalidateKeys?: string[][];
    successMessage?: string;
    onSuccess?: (data: TData) => void;
  },
) {
  const queryClient = useQueryClient();

  const mutationFn = async (variables: TVariables): Promise<TData> => {
    const resolvedUrl = typeof url === 'function' ? url(variables) : url;
    switch (method) {
      case 'post': return apiPost<TData>(resolvedUrl, variables);
      case 'put': return apiPut<TData>(resolvedUrl, variables);
      case 'patch': return apiPatch<TData>(resolvedUrl, variables);
      case 'delete': return apiDelete<TData>(resolvedUrl);
    }
  };

  return useMutation<TData, Error, TVariables>({
    mutationFn,
    onSuccess: (data) => {
      if (options?.invalidateKeys) {
        options.invalidateKeys.forEach((key) => queryClient.invalidateQueries({ queryKey: key }));
      }
      if (options?.successMessage) {
        Alert.alert('Success', options.successMessage);
      }
      options?.onSuccess?.(data);
    },
    onError: (error) => {
      Alert.alert('Error', getErrorMessage(error));
    },
  });
}
