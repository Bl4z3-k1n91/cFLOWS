'use strict';
const fs = require('fs/promises');
const path = require('path');

const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));

async function loadSensorSnapshot(projectRoot, { now = Date.now(), maxAgeMs = 10 * 60 * 1000 } = {}) {
  const configured = process.env.CFLOWS_SENSOR_FEED;
  const file = configured ? path.resolve(configured) : path.join(projectRoot, 'data', 'sensors', 'live.json');
  let payload;
  try { payload = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { state: 'integration-needed', fresh: false, file, bySegment: {}, detail: 'No trusted sensor snapshot is configured.' };
    return { state: 'invalid', fresh: false, file, bySegment: {}, detail: `Sensor snapshot could not be read: ${error.message}` };
  }
  const observedAt = payload.observedAt || payload.timestamp;
  const observedMs = new Date(observedAt).getTime();
  const ageMs = Number.isFinite(observedMs) ? now - observedMs : Infinity;
  const fresh = ageMs >= -2 * 60 * 1000 && ageMs <= maxAgeMs;
  const rows = Array.isArray(payload.segments) ? payload.segments : [];
  const bySegment = {};
  for (const row of rows) {
    const id = String(row.segmentId || (row.objectid != null ? `gcc-${row.objectid}` : '')).trim();
    if (!id) continue;
    const upstream = Number(row.upstreamLevelRatio), downstream = Number(row.downstreamLevelRatio), velocity = Number(row.velocityMs), solids = Number(row.suspendedSolidsNtu);
    bySegment[id] = {
      upstreamLevelRatio: Number.isFinite(upstream) ? clamp(upstream) : null,
      downstreamLevelRatio: Number.isFinite(downstream) ? clamp(downstream) : null,
      velocityMs: Number.isFinite(velocity) && velocity >= 0 ? velocity : null,
      suspendedSolidsNtu: Number.isFinite(solids) && solids >= 0 ? solids : null,
      observedAt,
      source: payload.source || 'trusted local sensor adapter',
    };
  }
  return { state: fresh ? 'live' : 'stale', fresh, file, observedAt, ageMs, bySegment, detail: `${Object.keys(bySegment).length} mapped sensor segment(s)${fresh ? '' : '; snapshot is stale and confidence credit is disabled'}` };
}

module.exports = { loadSensorSnapshot };
