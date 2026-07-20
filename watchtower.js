#!/usr/bin/env node
/**
 * Watchtower Framework — signals + delivery + subscription billing
 *
 * One process on Oracle Always Free (1 OCPU / 1 GB).
 * Drop-in signal/channel plugins. Stripe primary, crypto payment fallback.
 * Market-data / entertainment framing — not financial advice.
 */

require('dotenv').config();

const { loadConfig } = require('./src/config');
const { createLogger } = require('./src/logger');
const { WatchtowerFramework } = require('./src/framework');

async function main() {
  const config = loadConfig();
  const log = createLogger(config.logLevel);
  const app = new WatchtowerFramework(config, log);

  await app.start();

  const shutdown = async (signal) => {
    log.info(`Received ${signal}, shutting down`);
    await app.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal Watchtower error:', err);
  process.exit(1);
});
