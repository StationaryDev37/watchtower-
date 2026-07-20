function createLogger(level = 'info') {
  const ranks = { error: 0, warn: 1, info: 2, debug: 3 };
  const min = ranks[level] ?? 2;

  function write(rank, tag, message, meta) {
    if ((ranks[rank] ?? 2) > min) return;
    const line = {
      ts: new Date().toISOString(),
      level: rank,
      msg: message,
      ...(meta && Object.keys(meta).length ? { meta } : {}),
    };
    const out = JSON.stringify(line);
    if (rank === 'error') console.error(out);
    else if (rank === 'warn') console.warn(out);
    else console.log(out);
  }

  return {
    error: (msg, meta) => write('error', 'error', msg, meta),
    warn: (msg, meta) => write('warn', 'warn', msg, meta),
    info: (msg, meta) => write('info', 'info', msg, meta),
    debug: (msg, meta) => write('debug', 'debug', msg, meta),
  };
}

module.exports = { createLogger };
