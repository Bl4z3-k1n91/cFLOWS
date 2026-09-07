'use strict';

const fs = require('fs/promises');
const path = require('path');

// Optional deployment/hindcast input. SWMM stage elevations are only accepted
// when the file explicitly declares that its vertical datum is compatible with
// the GCC invert elevations. This prevents an offshore MSL value from being
// silently treated as a local drain/river stage.
async function loadDownstreamBoundary(projectRoot, eventId = 'live') {
  const file = path.join(projectRoot, 'data', 'boundary', `${eventId}.json`);
  let payload;
  try { payload = JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return { available: false, state: 'missing', eventId, detail: `No reviewed downstream boundary file at data/boundary/${eventId}.json` };
    return { available: false, state: 'invalid', eventId, detail: error.message };
  }
  if (payload.datumCompatibleWithGccInverts !== true) return { available: false, state: 'blocked-datum', eventId, detail: 'Boundary file exists but does not certify vertical-datum compatibility with GCC invert elevations.' };
  const stageM = Number(payload.stageM);
  const series = Array.isArray(payload.series) ? payload.series.map((row) => ({ time: row.time, stageM: Number(row.stageM) })).filter((row) => row.time && Number.isFinite(row.stageM)) : [];
  if (series.length >= 2) return { available: true, state: 'reviewed-timeseries', eventId, source: payload.source || 'deployment-supplied reviewed boundary', datum: payload.datum || null, boundary: { type: 'timeseries', series, source: payload.source || 'reviewed stage series' } };
  if (Number.isFinite(stageM)) return { available: true, state: 'reviewed-fixed-stage', eventId, source: payload.source || 'deployment-supplied reviewed boundary', datum: payload.datum || null, boundary: { type: 'fixed-stage', stageM, source: payload.source || 'reviewed fixed stage' } };
  return { available: false, state: 'invalid', eventId, detail: 'Boundary file has neither a valid stageM nor a valid stage series.' };
}

module.exports = { loadDownstreamBoundary };
