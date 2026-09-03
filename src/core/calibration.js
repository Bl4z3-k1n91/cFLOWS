'use strict';

const fs = require('fs/promises');

function parseCsvRows(raw) {
  const records = [], row = []; let field = '', quoted = false;
  const source = String(raw || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') { if (quoted && source[index + 1] === '"') { field += '"'; index += 1; } else quoted = !quoted; continue; }
    if (character === ',' && !quoted) { row.push(field); field = ''; continue; }
    if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field); field = ''; if (row.some((cell) => cell.length)) records.push(row.splice(0)); else row.length = 0; continue;
    }
    field += character;
  }
  if (field.length || row.length) { row.push(field); records.push(row); }
  if (records.length < 2) return [];
  const headers = records[0].map((item) => item.replace(/\s+/g, ' ').trim());
  return records.slice(1).map((cells) => Object.fromEntries(headers.map((header, index) => [header, (cells[index] || '').trim()])));
}

async function loadCalibrationInputs({ rainfallPath, labelsPath, sentinelLabelsPath }) {
  const rainfallRows = parseCsvRows(await fs.readFile(rainfallPath, 'utf8'));
  let labelRows = [];
  try { labelRows = parseCsvRows(await fs.readFile(labelsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (sentinelLabelsPath) try {
    const sentinel = JSON.parse(await fs.readFile(sentinelLabelsPath, 'utf8'));
    const features = sentinel.features || [];
    labelRows.push(...features.map((feature) => ({ district: feature.properties?.district || 'Chennai', flooded: feature.properties?.flooded ?? true, timestamp: feature.properties?.timestamp || feature.properties?.event_time || null, source: 'Sentinel-1 imported flood extent', confidence: feature.properties?.confidence ?? .7 })).filter((row) => row.timestamp));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { rainfallRows, labelRows };
}

function evaluateHindcasts(rows = []) {
  const usable = rows.filter((row) => /^(true|false|yes|no|0|1)$/i.test(String(row.observed_flooded ?? row.flooded ?? '')) && /^(true|false|yes|no|0|1)$/i.test(String(row.predicted_flooded ?? '')));
  if (usable.length < 20) return { status: 'blocked-insufficient-held-out-events', eventCount: usable.length, metrics: null, conclusion: 'At least 20 held-out, time-matched observed flood events are required before publishing performance metrics.' };
  const truth = (row) => /true|yes|1/i.test(String(row.observed_flooded ?? row.flooded));
  const predicted = (row) => /true|yes|1/i.test(String(row.predicted_flooded));
  let tp = 0, fp = 0, tn = 0, fn = 0;
  for (const row of usable) { if (truth(row) && predicted(row)) tp += 1; else if (!truth(row) && predicted(row)) fp += 1; else if (truth(row)) fn += 1; else tn += 1; }
  const numericDepth = (value) => value !== '' && value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  const depthPairs = usable.map((row) => [numericDepth(row.predicted_depth_m), numericDepth(row.depth_m ?? row.observed_depth_m)]).filter(([prediction, observed]) => prediction != null && observed != null);
  const maeM = depthPairs.length ? depthPairs.reduce((sum, [prediction, observed]) => sum + Math.abs(prediction - observed), 0) / depthPairs.length : null;
  return { status: 'evaluated-held-out-events', eventCount: usable.length, metrics: { precision: tp + fp ? tp / (tp + fp) : null, recall: tp + fn ? tp / (tp + fn) : null, falseAlarmRate: fp + tn ? fp / (fp + tn) : null, depthMaeM: maeM, depthSampleCount: depthPairs.length, confusion: { tp, fp, tn, fn } }, conclusion: 'Metrics are held-out event results. They do not transfer automatically to unobserved streets.' };
}

function buildHistoricalReplay({ rainfallRows = [], labelRows = [], district = 'Chennai' }) {
  const rainfall = rainfallRows.filter((row) => String(row.District || row.DISTRICT || row.district || '').toLowerCase() === district.toLowerCase());
  const labels = labelRows.filter((row) => String(row.district || row.DISTRICT || district).toLowerCase() === district.toLowerCase());
  const validLabels = labels.filter((row) => Number.isFinite(Number(row.depth_m ?? row.depthM)) || /true|yes|1/i.test(String(row.flooded ?? '')));
  const dates = rainfall.map((row) => row.Date || row.DATE || row.date).filter(Boolean).sort();
  const rainfallValues = rainfall.map((row) => Number(row['Daily Actual'] ?? row['DAILY ACTUAL'] ?? row.daily_actual ?? row.rainfall_mm)).filter(Number.isFinite);
  const missing = [];
  if (!rainfall.length) missing.push('district rainfall records');
  if (!validLabels.length) missing.push('time-matched flood-depth or inundation labels');
  const dailyOnly = rainfall.some((row) => row['Daily Actual'] != null || row['DAILY ACTUAL'] != null);
  const hindcast = evaluateHindcasts(labels);
  if (dailyOnly) missing.push('sub-daily storm hyetographs');
  return {
    district, rainfallRecords: rainfall.length, labelCount: validLabels.length, dateRange: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    rainfallSummary: rainfallValues.length ? { maxDailyMm: Math.max(...rainfallValues), meanDailyMm: rainfallValues.reduce((sum, value) => sum + value, 0) / rainfallValues.length } : null,
    isCalibrated: hindcast.status === 'evaluated-held-out-events' && !dailyOnly,
    status: hindcast.status === 'evaluated-held-out-events' && !dailyOnly ? 'evaluated-held-out-events' : 'blocked-insufficient-ground-truth',
    hindcast,
    missing: [...new Set(missing)],
    conclusion: validLabels.length
      ? 'Labels are present, but calibration remains gated until rainfall time resolution matches flood observations.'
      : 'IMD rainfall alone can support event screening, not flood-depth calibration or accuracy claims.',
  };
}

module.exports = { parseCsvRows, loadCalibrationInputs, buildHistoricalReplay, evaluateHindcasts };
