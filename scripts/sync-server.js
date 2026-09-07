'use strict';
const http = require('http');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const projectRoot = path.resolve(__dirname, '..');
try {
  const runtimeEnv = fsSync.readFileSync(path.join(projectRoot, '.env'), 'utf8');
  for (const line of runtimeEnv.split(/\r?\n/)) {
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const index = line.indexOf('='); const key = line.slice(0, index).trim(); const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] == null) process.env[key] = value;
  }
} catch { /* .env is optional */ }

const host = process.env.CFLOWS_SYNC_HOST || '127.0.0.1';
const port = Number(process.env.CFLOWS_SYNC_PORT || 8787);
const token = process.env.CFLOWS_SYNC_TOKEN || '';
const dataDir = path.resolve(process.env.CFLOWS_SYNC_DATA_DIR || path.join(projectRoot, '.sync-data'));
const reportsPath = path.join(dataDir, 'reports.json');
const CHENNAI_BOUNDS = { south: 12.72, north: 13.36, west: 79.95, east: 80.42 };
let writeQueue = Promise.resolve();

if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !token) {
  console.error('CFLOWS_SYNC_TOKEN is required when the sync service listens beyond loopback.');
  process.exit(2);
}

async function readReports() {
  try { return JSON.parse(await fs.readFile(reportsPath, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

function distanceM(a, b) {
  const latitude = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  return Math.hypot((a.longitude - b.longitude) * 111320 * Math.cos(latitude), (a.latitude - b.latitude) * 110540);
}

async function addReport(input) {
  const latitude = Number(input.latitude), longitude = Number(input.longitude), depthM = Number(input.depthM);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(depthM) || depthM < 0 || depthM > 3) throw new Error('invalid report coordinates or depth');
  if (latitude < CHENNAI_BOUNDS.south || latitude > CHENNAI_BOUNDS.north || longitude < CHENNAI_BOUNDS.west || longitude > CHENNAI_BOUNDS.east) throw new Error('report outside Chennai pilot bounds');
  const operation = async () => {
    const reports = await readReports(); const now = Date.now();
    const duplicate = reports.find((candidate) => now - new Date(candidate.timestamp).getTime() < 5 * 60 * 1000 && distanceM(candidate, { latitude, longitude }) < 25 && Math.abs(Number(candidate.depthM) - depthM) < .08);
    if (duplicate) return { ...duplicate, duplicateSuppressed: true };
    const report = { id: `field-${Date.now()}-${Math.random().toString(16).slice(2)}`, latitude, longitude, depthM, confidence: .35, source: 'unverified citizen field report', verificationState: 'unverified', timestamp: new Date().toISOString() };
    reports.push(report); await fs.mkdir(dataDir, { recursive: true });
    const temp = `${reportsPath}.tmp`; await fs.writeFile(temp, JSON.stringify(reports.slice(-500), null, 2)); await fs.rename(temp, reportsPath);
    return report;
  };
  const next = writeQueue.then(operation, operation); writeQueue = next.then(() => undefined, () => undefined); return next;
}

function authorized(request) { return !token || request.headers.authorization === `Bearer ${token}`; }
function json(response, status, payload) { const body = JSON.stringify(payload); response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' }); response.end(body); }

const server = http.createServer(async (request, response) => {
  try {
    if (request.url === '/health' && request.method === 'GET') return json(response, 200, { ok: true, service: 'cflows-sync' });
    if (!authorized(request)) return json(response, 401, { error: 'unauthorized' });
    if (request.url === '/reports' && request.method === 'GET') return json(response, 200, { reports: await readReports() });
    if (request.url === '/reports' && request.method === 'POST') {
      let raw = ''; for await (const chunk of request) { raw += chunk; if (raw.length > 32_000) throw new Error('request too large'); }
      return json(response, 201, { report: await addReport(JSON.parse(raw || '{}')) });
    }
    return json(response, 404, { error: 'not found' });
  } catch (error) { return json(response, 400, { error: error.message }); }
});

server.listen(port, host, () => console.log(`cFLOWS sync listening on http://${host}:${port}`));
