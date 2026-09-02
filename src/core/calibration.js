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

async function loadCalibrationInputs({ rainfallPath, labelsPath }) {
  const rainfallRows = parseCsvRows(await fs.readFile(rainfallPath, 'utf8'));
  let labelRows = [];
  try { labelRows = parseCsvRows(await fs.readFile(labelsPath, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { rainfallRows, labelRows };
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
  if (dailyOnly) missing.push('sub-daily storm hyetographs');
  return {
    district, rainfallRecords: rainfall.length, labelCount: validLabels.length, dateRange: dates.length ? { start: dates[0], end: dates.at(-1) } : null,
    rainfallSummary: rainfallValues.length ? { maxDailyMm: Math.max(...rainfallValues), meanDailyMm: rainfallValues.reduce((sum, value) => sum + value, 0) / rainfallValues.length } : null,
    isCalibrated: validLabels.length >= 20 && !dailyOnly,
    status: validLabels.length >= 20 && !dailyOnly ? 'ready-for-held-out-calibration' : 'blocked-insufficient-ground-truth',
    missing: [...new Set(missing)],
    conclusion: validLabels.length
      ? 'Labels are present, but calibration remains gated until rainfall time resolution matches flood observations.'
      : 'IMD rainfall alone can support event screening, not flood-depth calibration or accuracy claims.',
  };
}

module.exports = { parseCsvRows, loadCalibrationInputs, buildHistoricalReplay };
