/**
 * M14 v1.0 — account deletion API client.
 * Wraps the 3 endpoints in IOS-ACCOUNT-DELETION-SPEC §4.
 */
import { api, apiGet, apiPost, getErrorMessage } from '../lib/api';

export interface DeletionRequestStatus {
  requested: boolean;
  requestId?: string;
  status?: 'pending' | 'cancelled' | 'completed';
  requestedAt?: string;
  scheduledCompletionAt?: string;
  daysRemaining?: number | null;
  cancelledAt?: string | null;
}

export interface DeletionRequestResult {
  requestId: string;
  requestedAt: string;
  scheduledCompletionAt: string;
  cancellationDeadline: string;
}

export async function getDeletionRequestStatus(): Promise<DeletionRequestStatus> {
  return apiGet<DeletionRequestStatus>('/users/me/deletion-request');
}

export async function submitDeletionRequest(reason?: string): Promise<DeletionRequestResult> {
  return apiPost<DeletionRequestResult>('/users/me/deletion-request', {
    confirmText: 'DELETE MY ACCOUNT',
    reason,
  });
}

export async function cancelDeletionRequest(): Promise<void> {
  // Cancel returns 204 No Content — bypass apiPost which expects a JSON envelope.
  await api.post('/users/me/deletion-request/cancel');
}

export { getErrorMessage };
