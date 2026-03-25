import type { Request, Response, NextFunction } from 'express';
import type { ZodSchema } from 'zod';
import { sendValidationError } from '../utils/apiResponse.js';

// Extend Request to hold validated data
declare global {
  namespace Express {
    interface Request {
      validated?: Record<string, unknown>;
    }
  }
}

/**
 * Validate request body/query/params against a Zod schema.
 * For body: replaces req.body with parsed values (body is writable).
 * For query/params: stores parsed values in req.validated (query/params are read-only in Express 5).
 */
export function validate(schema: ZodSchema, source: 'body' | 'query' | 'params' = 'body') {
  return (req: Request, res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      return sendValidationError(res, result.error.flatten().fieldErrors);
    }
    if (source === 'body') {
      req.body = result.data;
    } else {
      // query and params are read-only in Express 5, store parsed data separately
      if (!req.validated) req.validated = {};
      req.validated[source] = result.data;
    }
    next();
  };
}

/**
 * Validate query parameters (with coercion for pagination etc.)
 */
export function validateQuery(schema: ZodSchema) {
  return validate(schema, 'query');
}

/**
 * Validate URL parameters
 */
export function validateParams(schema: ZodSchema) {
  return validate(schema, 'params');
}
