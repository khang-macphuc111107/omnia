const fs = require('node:fs');
const path = require('node:path');

export function loadConfig(configPath) {
  const resolved = path.resolve(configPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.routes !== 'object') {
    throw new Error(`Invalid routes configuration in ${resolved}`);
  }
  return {
    default_channel: parsed.default_channel || 'general',
    routes: parsed.routes,
  };
}
