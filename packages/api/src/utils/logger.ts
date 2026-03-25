import winston from 'winston';
import { config } from '../config/index.js';

const { combine, timestamp, errors, json, printf, colorize } = winston.format;

const devFormat = printf(({ level, message, timestamp, requestId, ...meta }) => {
  const reqId = requestId ? `[${requestId}] ` : '';
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} ${level}: ${reqId}${message}${metaStr}`;
});

export const logger = winston.createLogger({
  level: config.isDev ? 'debug' : 'info',
  defaultMeta: { service: 'gaslink-api' },
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss.SSS' }),
    errors({ stack: true }),
  ),
  transports: [
    new winston.transports.Console({
      format: config.isDev
        ? combine(colorize(), devFormat)
        : combine(json()),
    }),
  ],
});

/**
 * Create a child logger with request context
 */
export function createRequestLogger(requestId: string, userId?: string) {
  return logger.child({ requestId, userId });
}

/**
 * Log a business event for audit trail
 */
export function logBusinessEvent(event: {
  action: string;
  entityType: string;
  entityId?: string;
  userId?: string;
  distributorId?: string;
  details?: Record<string, unknown>;
  requestId?: string;
}) {
  logger.info(`[BUSINESS] ${event.action}`, {
    ...event,
    timestamp: new Date().toISOString(),
  });
}
