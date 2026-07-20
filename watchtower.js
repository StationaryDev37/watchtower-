#!/usr/bin/env node
/**
 * Watchtower Framework — single-source crypto alert + revenue engine
 *
 * One process. One codebase. Free alerts + paid upgrades + affiliates.
 * Oracle Cloud Always Free → $0 infra. Revenue from day 1, not month 2–3.
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
