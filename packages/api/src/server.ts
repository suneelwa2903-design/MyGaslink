import { config, validateEnv } from './config/index.js';
import { logger } from './utils/logger.js';
import { createApp } from './app.js';

// ─── Validate Environment ────────────────────────────────────────────────────

validateEnv();

// ─── Start Server ────────────────────────────────────────────────────────────

const app = createApp();
const port = config.port;

app.listen(port, () => {
  logger.info(`GasLink API server running on port ${port}`, {
    env: config.nodeEnv,
    cors: config.cors.origins,
  });
});

export default app;
