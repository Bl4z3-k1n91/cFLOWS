'use strict';
const fs = require('fs/promises');
const path = require('path');

function distanceM(latitude, longitude, sample) {
  return Math.hypot((Number(sample.longitude) - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (Number(sample.latitude) - latitude) * 110540);
}

async function loadLocalElevationGrid(projectRoot, { latitude, longitude, radiusM = 480, minSamples = 9 } = {}) {
  const file = path.join(projectRoot, 'data', 'terrain', 'local-elevation-samples.json');
  let payload;
  try { payload = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const raw = Array.isArray(payload) ? payload : payload.samples || [];
  const samples = raw.map((sample) => ({ latitude: Number(sample.latitude), longitude: Number(sample.longitude), elevationM: Number(sample.elevationM) }))
    .filter((sample) => Number.isFinite(sample.latitude) && Number.isFinite(sample.longitude) && Number.isFinite(sample.elevationM) && distanceM(latitude, longitude, sample) <= radiusM * 1.25)
    .sort((a, b) => distanceM(latitude, longitude, a) - distanceM(latitude, longitude, b))
    .slice(0, 400);
  if (samples.length < minSamples) return null;
  return {
    source: payload.source || 'local reviewed elevation samples',
    resolutionM: Number(payload.resolutionM) || null,
    samples, radiusM, fresh: true, local: true,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { loadLocalElevationGrid };
