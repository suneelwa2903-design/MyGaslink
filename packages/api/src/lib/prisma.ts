import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger.js';

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: [
      { level: 'error', emit: 'event' },
      { level: 'warn', emit: 'event' },
      ...(process.env.NODE_ENV === 'development'
        ? [{ level: 'query' as const, emit: 'event' as const }]
        : []),
    ],
  });

prisma.$on('error' as never, (e: unknown) => {
  logger.error('Prisma error', { error: e });
});

prisma.$on('warn' as never, (e: unknown) => {
  logger.warn('Prisma warning', { warning: e });
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
