'use strict';

// Deterministic, mass-accounted exploratory 2D surface routing. It is not a
// replacement for a surveyed DEM: callers must disclose the elevation source.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const { sampleRainfallSeries } = require('./rainfall-profile');

function idwElevation(latitude, longitude, samples) {
  const weighted = (samples || []).filter((sample) => Number.isFinite(sample.elevationM)).map((sample) => {
    const distance = Math.hypot((sample.latitude - latitude) * 110540, (sample.longitude - longitude) * 108500);
    return { sample, weight: 1 / Math.max(12, distance) ** 2 };
  });
  if (!weighted.length) return 0;
  return weighted.reduce((sum, item) => sum + item.sample.elevationM * item.weight, 0) / weighted.reduce((sum, item) => sum + item.weight, 0);
}

function makeRaster({ latitude, longitude, elevationSamples = [], radiusM = 480, rows = 28, cols = 28 }) {
  const cellM = radiusM * 2 / cols;
  const cells = Array.from({ length: rows }, (_, row) => Array.from({ length: cols }, (_, col) => {
    const northM = radiusM - (row + .5) * cellM, eastM = -radiusM + (col + .5) * cellM;
    const lat = latitude + northM / 110540, lon = longitude + eastM / (111320 * Math.cos(latitude * Math.PI / 180));
    return { row, col, latitude: lat, longitude: lon, elevationM: idwElevation(lat, lon, elevationSamples), depthM: 0 };
  }));
  return { latitude, longitude, radiusM, rows, cols, cellM, cells, terrainSource: elevationSamples.length ? 'sparse public elevation samples' : 'no terrain samples' };
}

function runRasterSpill({
  raster,
  rainfallMmHr,
  rainfallSeries = null,
  imperviousPct,
  durationMinutes = 120,
  drainRemovalMmHr = 0,
  drainEfficiency = 1,
  drainOverflowM3 = 0,
  initialObservations = [],
  frameEveryMinutes = 10,
  manningN = .04,
  manningMultiplier = 1,
  imperviousMultiplier = 1,
  infiltrationMultiplier = 1,
} = {}) {
  // This remains a screening solver, but it now uses spatially varying runoff,
  // infiltration, roughness and drain exchange when those fields are supplied.
  // Flow is split among all lower neighbours instead of being forced into one
  // steepest cell. Momentum, kerbs and surveyed breaklines are still unresolved.
  const minutesPerStep = 1, stepSeconds = minutesPerStep * 60, steps = Math.max(1, Math.round(durationMinutes / minutesPerStep));
  const fallbackImpervious = clamp((Number(imperviousPct) || 70) / 100, .2, .98);
  const frames = [], rows = raster.rows, cols = raster.cols, cellArea = raster.cellM ** 2;
  const flatCells = raster.cells.flat();
  const drainWeightSum = flatCells.reduce((sum, cell) => sum + Math.max(0, Number(cell.drainWeight) || 0), 0);
  const totalCells = flatCells.length;
  let grossRainVolumeM3 = 0, runoffVolumeM3 = 0, infiltrationVolumeM3 = 0, drainedVolumeM3 = 0, boundaryOutflowM3 = 0, overflowInputM3 = 0;
  const index = (row, col) => row >= 0 && row < rows && col >= 0 && col < cols ? raster.cells[row][col] : null;

  // Assimilation hook: a verified field observation can provide an antecedent
  // surface-water state. Callers are responsible for passing only trusted data.
  for (const observation of initialObservations || []) {
    const latitude = Number(observation.latitude), longitude = Number(observation.longitude), depthM = Number(observation.depthM);
    if (![latitude, longitude, depthM].every(Number.isFinite) || depthM <= 0) continue;
    const confidence = clamp(Number(observation.confidence ?? 1), 0, 1);
    for (const cell of flatCells) {
      const distanceM = Math.hypot((cell.latitude - latitude) * 110540, (cell.longitude - longitude) * 111320 * Math.cos(latitude * Math.PI / 180));
      if (distanceM > 140) continue;
      const influence = Math.exp(-((distanceM / 55) ** 2)) * confidence;
      cell.depthM = Math.max(cell.depthM, depthM * influence);
    }
  }
  const initialStorageM3 = flatCells.reduce((sum, cell) => sum + Math.max(0, Number(cell.depthM) || 0) * cellArea, 0);

  for (let step = 1; step <= steps; step += 1) {
    const rainRateMmHr = Array.isArray(rainfallSeries) && rainfallSeries.length
      ? sampleRainfallSeries(rainfallSeries, step - .5)
      : Math.max(0, Number(rainfallMmHr) || 0);
    const grossRainM = rainRateMmHr / 1000 * (minutesPerStep / 60);
    for (const cell of flatCells) {
      const imperviousFraction = clamp((Number.isFinite(Number(cell.imperviousFraction)) ? Number(cell.imperviousFraction) : fallbackImpervious) * imperviousMultiplier, .05, .995);
      const perviousFraction = 1 - imperviousFraction;
      const spatialInfiltration = Number(cell.infiltrationMmHr);
      // Backwards-compatible fallback: without a spatial infiltration field,
      // the pervious share is treated as infiltrating completely as before.
      const infiltrationM = Number.isFinite(spatialInfiltration)
        ? Math.min(grossRainM * perviousFraction, Math.max(0, spatialInfiltration * infiltrationMultiplier) / 1000 * (minutesPerStep / 60) * perviousFraction)
        : grossRainM * perviousFraction;
      const runoffM = Math.max(0, grossRainM - infiltrationM);
      cell.depthM += runoffM;
      grossRainVolumeM3 += grossRainM * cellArea;
      runoffVolumeM3 += runoffM * cellArea;
      infiltrationVolumeM3 += infiltrationM * cellArea;
    }

    // Loose 1D<->2D feedback: if SWMM reports overflow, return that water near
    // mapped drains. This is not a fully synchronous hydraulic coupling; it is
    // deliberately labelled as a distributed overflow source in the audit.
    const overflowStepM3 = Math.max(0, Number(drainOverflowM3) || 0) / steps;
    if (overflowStepM3 > 0) {
      if (drainWeightSum > 0) {
        for (const cell of flatCells) {
          const weight = Math.max(0, Number(cell.drainWeight) || 0);
          if (!weight) continue;
          const volume = overflowStepM3 * weight / drainWeightSum;
          cell.depthM += volume / cellArea; overflowInputM3 += volume;
        }
      } else {
        const centre = raster.cells[Math.floor(rows / 2)]?.[Math.floor(cols / 2)];
        if (centre) { centre.depthM += overflowStepM3 / cellArea; overflowInputM3 += overflowStepM3; }
      }
    }

    const moves = [];
    for (const row of raster.cells) for (const cell of row) {
      const surface = cell.elevationM + cell.depthM;
      if (cell.depthM <= 0) continue;
      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [-1, 1], [1, -1], [1, 1]]
        .map(([r, c]) => ({ target: index(cell.row + r, cell.col + c), diagonal: r !== 0 && c !== 0 }))
        .filter((item) => item.target)
        .map((item) => ({ ...item, drop: surface - (item.target.elevationM + item.target.depthM) }))
        .filter((item) => item.drop > .001);
      if (!neighbors.length) continue;
      const hydraulicDepth = Math.max(.001, cell.depthM);
      const localN = Math.max(.012, (Number.isFinite(Number(cell.manningN)) ? Number(cell.manningN) : Number(manningN) || .04) * manningMultiplier);
      const conveyances = neighbors.map((item) => {
        const travelM = raster.cellM * (item.diagonal ? Math.SQRT2 : 1);
        const slope = Math.max(1e-6, item.drop / travelM);
        const dischargeM3s = (1 / localN) * raster.cellM * hydraulicDepth ** (5 / 3) * Math.sqrt(slope);
        return { ...item, dischargeM3s };
      });
      const totalDischarge = conveyances.reduce((sum, item) => sum + item.dischargeM3s, 0);
      if (totalDischarge <= 0) continue;
      const availableVolumeM3 = cell.depthM * cellArea * .38;
      const movedVolumeM3 = Math.min(availableVolumeM3, totalDischarge * stepSeconds);
      for (const item of conveyances) moves.push({ cell, target: item.target, amount: movedVolumeM3 * item.dischargeM3s / totalDischarge / cellArea });
    }
    for (const move of moves) { move.cell.depthM -= move.amount; move.target.depthM += move.amount; }
    for (const row of raster.cells) for (const cell of row) {
      const edge = cell.row === 0 || cell.col === 0 || cell.row === rows - 1 || cell.col === cols - 1;
      const averageDrainMmHr = Math.max(0, Number(drainRemovalMmHr) || 0) * Math.max(0, Number(drainEfficiency) || 0);
      const spatialDrainMmHr = drainWeightSum > 0
        ? averageDrainMmHr * totalCells * Math.max(0, Number(cell.drainWeight) || 0) / drainWeightSum
        : averageDrainMmHr;
      const drainMPerStep = spatialDrainMmHr / 1000 * (minutesPerStep / 60);
      const drain = Math.min(cell.depthM, drainMPerStep * (edge ? .35 : 1));
      cell.depthM -= drain; drainedVolumeM3 += drain * cellArea;
      if (edge && cell.depthM > .002) {
        const boundarySlope = Math.max(1e-6, cell.depthM / raster.cellM);
        const localN = Math.max(.012, (Number.isFinite(Number(cell.manningN)) ? Number(cell.manningN) : Number(manningN) || .04) * manningMultiplier);
        const velocityMs = (1 / localN) * cell.depthM ** (2 / 3) * Math.sqrt(boundarySlope);
        const fluxDepthM = velocityMs * cell.depthM * raster.cellM * stepSeconds / cellArea;
        const out = Math.min(cell.depthM * .18, fluxDepthM);
        cell.depthM -= out; boundaryOutflowM3 += out * cellArea;
      }
    }
    if (step % Math.max(1, Math.round(frameEveryMinutes / minutesPerStep)) === 0 || step === steps) frames.push({ minute: step * minutesPerStep, depthsM: raster.cells.flat().map((cell) => Math.round(cell.depthM * 1000) / 1000) });
  }
  const depths = flatCells.map((cell) => cell.depthM), storedM3 = depths.reduce((sum, depth) => sum + depth * cellArea, 0);
  const inputVolumeM3 = initialStorageM3 + grossRainVolumeM3 + overflowInputM3;
  const continuityErrorPct = inputVolumeM3 ? Math.abs(inputVolumeM3 - infiltrationVolumeM3 - drainedVolumeM3 - boundaryOutflowM3 - storedM3) / inputVolumeM3 * 100 : 0;
  return {
    raster: {
      ...raster,
      cells: raster.cells.map((row) => row.map(({ row: r, col, latitude: lat, longitude: lon, elevationM, depthM, landClass, imperviousFraction, manningN: cellManningN, infiltrationMmHr, drainWeight }) => ({ row: r, col, latitude: lat, longitude: lon, elevationM, depthM, landClass, imperviousFraction, manningN: cellManningN, infiltrationMmHr, drainWeight }))),
    },
    frames,
    stats: {
      durationMinutes,
      rainfallVolumeM3: grossRainVolumeM3,
      runoffVolumeM3,
      infiltrationVolumeM3,
      initialStorageM3,
      overflowInputM3,
      drainedVolumeM3,
      boundaryOutflowM3,
      storedM3,
      continuityErrorPct,
      maxDepthM: Math.max(...depths),
      floodedAreaM2: depths.filter((depth) => depth >= .05).length * cellArea,
      rainfallSeriesUsed: Boolean(Array.isArray(rainfallSeries) && rainfallSeries.length),
      peakRainfallMmHr: Array.isArray(rainfallSeries) && rainfallSeries.length ? Math.max(...rainfallSeries.map((row) => Number(row.mmHr) || 0)) : Math.max(0, Number(rainfallMmHr) || 0),
      spatialSurfaceUsed: flatCells.some((cell) => Number.isFinite(Number(cell.imperviousFraction)) || Number.isFinite(Number(cell.manningN))),
      spatialDrainExchangeUsed: drainWeightSum > 0 && Number(drainRemovalMmHr) > 0,
      assimilatedObservationCount: (initialObservations || []).filter((item) => Number.isFinite(Number(item.depthM)) && Number(item.depthM) > 0).length,
    },
    routing: {
      method: 'multi-direction Manning diffusive-wave screening approximation',
      manningN: Math.max(.02, Number(manningN) || .04),
      stepSeconds,
      neighbors: 8,
      drainCoupling: drainWeightSum > 0 ? 'spatial drain sink; optional SWMM overflow feedback' : 'uniform/no-drain fallback',
      limitations: 'no momentum, surveyed kerbs/walls, explicit manhole exchange or high-resolution breaklines',
    },
    status: 'spatial-diffusive-wave-screening',
  };
}

function inspectRasterPoint(rasterRun, latitude, longitude) {
  const cells = rasterRun.raster.cells.flat();
  const cell = cells.reduce((closest, candidate) => Math.hypot(candidate.latitude - latitude, candidate.longitude - longitude) < Math.hypot(closest.latitude - latitude, closest.longitude - longitude) ? candidate : closest);
  const approximateDepthM = Math.round(cell.depthM * 10) / 10;
  const band = cell.depthM < .05 ? 'no material ponding in this screening cell' : cell.depthM < .15 ? 'shallow ponding possible' : cell.depthM < .4 ? 'moderate inundation possible' : 'deep inundation possible';
  return { ...cell, approximateDepthM, band, note: 'Point value is rounded to decimetres because the sparse-terrain screening raster does not resolve kerbs, road crowns or surveyed street elevation.' };
}

function summarizeRasterPooling(rasterRun, latitude, longitude) {
  const cells = rasterRun?.raster?.cells?.flat?.() || [];
  if (!cells.length) return { available: false, state: 'no-raster' };
  const depths = cells.map((cell) => Math.max(0, Number(cell.depthM) || 0)).sort((a, b) => a - b);
  const quantile = (fraction) => depths[Math.min(depths.length - 1, Math.max(0, Math.round((depths.length - 1) * fraction)))];
  const selected = Number.isFinite(Number(latitude)) && Number.isFinite(Number(longitude))
    ? cells.reduce((closest, candidate) => Math.hypot(candidate.latitude - latitude, candidate.longitude - longitude) < Math.hypot(closest.latitude - latitude, closest.longitude - longitude) ? candidate : closest)
    : cells[Math.floor(cells.length / 2)];
  const countAt = (threshold) => depths.filter((depth) => depth >= threshold).length;
  const floodedFraction = countAt(.05) / depths.length;
  const significantFraction = countAt(.15) / depths.length;
  const deepFraction = countAt(.40) / depths.length;
  const p90DepthM = quantile(.90), p95DepthM = quantile(.95), selectedDepthM = Math.max(0, Number(selected?.depthM) || 0);
  let depthBand = 'minimal-ponding';
  if (selectedDepthM >= .40 || (p95DepthM >= .40 && deepFraction >= .02)) depthBand = 'deep-inundation-possible';
  else if (selectedDepthM >= .15 || p90DepthM >= .15 || significantFraction >= .12) depthBand = 'significant-inundation';
  else if (selectedDepthM >= .05 || p90DepthM >= .05 || floodedFraction >= .15) depthBand = 'shallow-inundation';
  const pattern = deepFraction >= .12 ? 'widespread-deep' : deepFraction > 0 ? 'isolated-deep' : significantFraction >= .20 ? 'widespread-moderate' : floodedFraction >= .20 ? 'widespread-shallow' : floodedFraction > 0 ? 'isolated-shallow' : 'little-pooling';
  return {
    available: true,
    depthBand,
    pattern,
    selectedDepthM,
    p90DepthM,
    p95DepthM,
    maxDepthM: Math.max(...depths),
    floodedFraction,
    significantFraction,
    deepFraction,
    floodedAreaM2: Number(rasterRun.stats?.floodedAreaM2) || 0,
    interpretation: 'Severity is derived from the spatial pooling distribution, not the old capped scalar road-storage depth.',
  };
}

module.exports = { makeRaster, runRasterSpill, inspectRasterPoint, summarizeRasterPooling };
