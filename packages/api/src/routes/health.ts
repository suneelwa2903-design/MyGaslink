import { Router } from 'express';
import { prisma } from '../lib/prisma.js';
import { sendSuccess, sendError } from '../utils/apiResponse.js';

const router = Router();

// GET /api/health
router.get('/', async (_req, res) => {
  try {
    // Check DB connectivity
    const dbStart = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    const dbLatency = Date.now() - dbStart;

    return sendSuccess(res, {
      status: 'healthy',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: {
        status: 'connected',
        latencyMs: dbLatency,
      },
    });
  } catch (err) {
    return sendError(res, 'Service unhealthy', 503);
  }
});

export default router;
