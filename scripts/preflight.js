'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checks = [
  ['Node.js 20+', Number(process.versions.node.split('.')[0]) >= 20, process.versions.node],
  ['EPA SWMM source', fs.existsSync(path.join(root, 'vendor', 'epa-swmm', 'src', 'solver')), 'git submodule'],
  ['EPA SWMM executable', fs.existsSync(path.join(root, 'vendor', 'epa-swmm', 'bin', 'runswmm.exe')), 'npm run build:swmm'],
  ['Leaflet dependency', fs.existsSync(path.join(root, 'node_modules', 'leaflet')), 'npm install'],
  ['Local IMD evidence', fs.existsSync(path.join(root, 'data', 'imd', 'rainfall_districtwise_daily_imd.csv')), 'historical event screening'],
];

console.log('cFLOWS preflight');
for (const [name, ok, detail] of checks) console.log(`${ok ? 'OK ' : 'WARN'}  ${name} — ${detail}`);
const env = path.join(root, '.env');
console.log(`${fs.existsSync(env) ? 'OK ' : 'INFO'}  LLM configuration — ${fs.existsSync(env) ? '.env present' : 'optional; deterministic fallback remains available'}`);
console.log(`INFO  Sensor adapter — ${process.env.CFLOWS_SENSOR_FEED ? process.env.CFLOWS_SENSOR_FEED : 'data/sensors/live.json when supplied; otherwise integration-needed'}`);
console.log(`INFO  Report store — ${process.env.CFLOWS_SYNC_URL || 'local atomic desktop store (set CFLOWS_SYNC_URL for shared multi-client mode)'}`);
console.log(`INFO  Hydraulic downstream boundary — ${fs.existsSync(path.join(root, 'data', 'boundary', 'live.json')) ? 'data/boundary/live.json present; datum gate will be enforced' : 'not supplied; SWMM uses a disclosed FREE boundary and will not treat offshore model sea level as drain stage'}`);
console.log('INFO  Live public feeds are optional for startup; cached evidence is labelled stale and never promoted to live.');
