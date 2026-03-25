import type { Response } from 'express';
import type { ApiResponse, PaginationMeta } from '@gaslink/shared';

/**
 * Standardized API response helper.
 * Every response follows: { success, data, error?, code?, meta? }
 */
export function sendSuccess<T>(res: Response, data: T, status = 200, meta?: PaginationMeta) {
  const response: ApiResponse<T> = { success: true, data };
  if (meta) response.meta = meta;
  return res.status(status).json(response);
}

export function sendCreated<T>(res: Response, data: T) {
  return sendSuccess(res, data, 201);
}

export function sendError(
  res: Response,
  message: string,
  status = 500,
  code?: string,
) {
  const response: ApiResponse<null> = {
    success: false,
    data: null,
    error: message,
    code,
  };
  return res.status(status).json(response);
}

export function sendValidationError(res: Response, errors: unknown) {
  return res.status(400).json({
    success: false,
    data: null,
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    details: errors,
  });
}

export function sendNotFound(res: Response, entity = 'Resource') {
  return sendError(res, `${entity} not found`, 404, 'NOT_FOUND');
}

export function sendUnauthorized(res: Response, message = 'Authentication required') {
  return sendError(res, message, 401, 'AUTHENTICATION_ERROR');
}

export function sendForbidden(res: Response, message = 'Insufficient permissions') {
  return sendError(res, message, 403, 'AUTHORIZATION_ERROR');
}
