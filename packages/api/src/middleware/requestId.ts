import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

/**
 * Assigns a unique request ID to every incoming request.
 * Used for log correlation and debugging.
 */
export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.requestId = (req.headers['x-request-id'] as string) || uuidv4();
  next();
}
