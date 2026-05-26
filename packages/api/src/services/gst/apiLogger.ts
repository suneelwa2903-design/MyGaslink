/**
 * Caller-side logging wrapper for WhiteBooks API calls.
 *
 * Implements Anti-pattern #11 ("External API call failures must be logged
 * with full request payload"). Every wrapped call writes a `gst_api_logs`
 * row capturing the exact outgoing request_payload, the raw response (or
 * the parsed error), latency, and forensic context (apiType / invoiceId /
 * orderId / distributorId / httpStatus).
 *
 * Why this lives OUTSIDE whitebooksClient.ts:
 *   The Vitest suite mocks `apiCall` directly to short-circuit network
 *   I/O. If the log write were inside `apiCall`, the mock would bypass it,
 *   and `gst_api_logs` audit coverage would be untestable. Keeping the log
 *   write in a thin caller-side wrapper (which is NOT mocked) means the
 *   audit row still gets written when the test path returns/throws via
 *   the mock — regardless of whether the real HTTP call ran.
 *
 * Why the write is best-effort:
 *   A failure to write the audit row MUST never block the outgoing API
 *   result for the caller. We log to Winston and swallow.
 */

import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../utils/logger.js';
import { apiCall, GstError, type ApiCallContext } from './whitebooksClient.js';

interface LoggedCallArgs<T> {
  distributorId: string | null;
  context: Required<Pick<ApiCallContext, 'apiType'>> &
    Pick<ApiCallContext, 'invoiceId' | 'orderId'>;
  scope: 'einvoice' | 'ewaybill';
  /** Endpoint path WITHOUT the query string — keeps the audit row searchable. */
  endpoint: string;
  /** Full outgoing payload (body). Captured even on failure. */
  payload: unknown;
  /** The actual call (so we don't double-thread args through). */
  call: () => Promise<T>;
}

/**
 * Run a WhiteBooks API call and persist exactly one `gst_api_logs` row
 * regardless of success/failure outcome.
 */
export async function loggedApiCall<T>(args: LoggedCallArgs<T>): Promise<T> {
  const started = Date.now();
  try {
    const resp = await args.call();
    void writeApiLog({
      ...args,
      status: 'success',
      response: resp,
      latencyMs: Date.now() - started,
    });
    return resp;
  } catch (err: unknown) {
    // GstError carries the raw NIC response body in `err.response`. Persist
    // it verbatim so the audit row has the un-massaged upstream payload —
    // not just our parsed message string.
    void writeApiLog({
      ...args,
      status: 'failed',
      response: err instanceof GstError ? (err.response ?? null) : null,
      latencyMs: Date.now() - started,
      errorCode: err instanceof GstError ? err.code : undefined,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Convenience overload: build the standard `loggedApiCall` invocation
 * directly around `apiCall`, so callers don't have to spell out the closure.
 *
 *   await callWithLog(distributorId, 'POST', path, body, 'einvoice',
 *     { apiType: 'IRN_GENERATE', invoiceId, orderId });
 */
export async function callWithLog<T = unknown>(
  distributorId: string | null,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  scope: 'einvoice' | 'ewaybill',
  context: Required<Pick<ApiCallContext, 'apiType'>> &
    Pick<ApiCallContext, 'invoiceId' | 'orderId'>,
): Promise<T> {
  return loggedApiCall<T>({
    distributorId,
    context,
    scope,
    endpoint: path.split('?')[0],
    payload: body,
    call: () => apiCall<T>(distributorId, method, path, body, scope, context),
  });
}

async function writeApiLog(args: LoggedCallArgs<unknown> & {
  status: 'success' | 'failed';
  response: unknown;
  latencyMs: number;
  errorCode?: string;
  errorMessage?: string;
}) {
  // distributorId is required in the gst_api_logs schema; skip GasLink-level
  // calls (null) — those still appear in Winston via the apiCall logger.info.
  if (!args.distributorId) return;
  try {
    await prisma.gstApiLog.create({
      data: {
        distributorId: args.distributorId,
        invoiceId: args.context.invoiceId ?? null,
        orderId: args.context.orderId ?? null,
        apiType: args.context.apiType,
        scope: args.scope,
        endpoint: args.endpoint,
        status: args.status,
        errorCode: args.errorCode ?? null,
        errorMessage: args.errorMessage ?? null,
        requestPayload: (args.payload ?? {}) as Prisma.InputJsonValue,
        responsePayload:
          args.response == null
            ? Prisma.DbNull
            : (args.response as Prisma.InputJsonValue),
        latencyMs: args.latencyMs,
      },
    });
  } catch (logErr) {
    logger.warn('gst_api_logs write failed (non-blocking)', {
      err: (logErr as Error).message,
    });
  }
}
