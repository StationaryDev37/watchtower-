const fs = require('fs');
const path = require('path');

/**
 * Drop a file in src/signals/ or src/channels/ — registry picks it up.
 * Skip: index.js, base.js, anything starting with _ or .
 */
function loadPlugins(dir, { exportNames = [], config, log, extraArgs = [] }) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return [];

  const files = fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => !['index.js', 'base.js'].includes(f))
    .filter((f) => !f.startsWith('_') && !f.startsWith('.'))
    .sort();

  const plugins = [];
  for (const file of files) {
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const mod = require(path.join(abs, file));
    const Plugin = resolveExport(mod, exportNames);
    if (!Plugin) {
      log.warn('Plugin file has no constructable export — skipped', { file });
      continue;
    }
    try {
      const instance = new Plugin(config, log, ...extraArgs);
      if (!instance.name) instance.name = path.basename(file, '.js');
      plugins.push(instance);
      log.info('Loaded plugin', { file, name: instance.name });
    } catch (err) {
      log.error('Plugin failed to construct', { file, error: err.message });
    }
  }
  return plugins;
}

function resolveExport(mod, exportNames) {
  for (const name of exportNames) {
    if (mod[name]) return mod[name];
  }
  if (typeof mod === 'function') return mod;
  if (typeof mod.default === 'function') return mod.default;
  // First class-like export (function with prototype)
  for (const val of Object.values(mod)) {
    if (typeof val === 'function' && val.prototype && val.prototype.constructor === val) {
      return val;
    }
  }
  return null;
}

module.exports = { loadPlugins };
