'use strict';

// Deterministic, mass-accounted exploratory 2D surface routing. It is not a
// replacement for a surveyed DEM: callers must disclose the elevation source.
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

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

function runRasterSpill({ raster, rainfallMmHr, imperviousPct, durationMinutes = 120, drainRemovalMmHr = 0, frameEveryMinutes = 10 }) {
  const minutesPerStep = 2, steps = Math.max(1, Math.round(durationMinutes / minutesPerStep));
  const addedMPerStep = Math.max(0, Number(rainfallMmHr) || 0) / 1000 * (minutesPerStep / 60) * clamp((Number(imperviousPct) || 70) / 100, .2, .98);
  const drainedMPerStep = Math.max(0, Number(drainRemovalMmHr) || 0) / 1000 * (minutesPerStep / 60);
  const frames = [], rows = raster.rows, cols = raster.cols, cellArea = raster.cellM ** 2;
  let rainVolumeM3 = 0, drainedVolumeM3 = 0, boundaryOutflowM3 = 0;
  const index = (row, col) => row >= 0 && row < rows && col >= 0 && col < cols ? raster.cells[row][col] : null;
  for (let step = 1; step <= steps; step += 1) {
    for (const row of raster.cells) for (const cell of row) { cell.depthM += addedMPerStep; rainVolumeM3 += addedMPerStep * cellArea; }
    const moves = [];
    for (const row of raster.cells) for (const cell of row) {
      const surface = cell.elevationM + cell.depthM;
      const neighbors = [[-1, 0], [1, 0], [0, -1], [0, 1]].map(([r, c]) => index(cell.row + r, cell.col + c)).filter(Boolean);
      const target = neighbors.sort((a, b) => (a.elevationM + a.depthM) - (b.elevationM + b.depthM))[0];
      if (!target) continue;
      const drop = surface - (target.elevationM + target.depthM);
      if (drop > .002 && cell.depthM > 0) moves.push({ cell, target, amount: Math.min(cell.depthM * .24, drop * .17) });
    }
    for (const move of moves) { move.cell.depthM -= move.amount; move.target.depthM += move.amount; }
    for (const row of raster.cells) for (const cell of row) {
      const edge = cell.row === 0 || cell.col === 0 || cell.row === rows - 1 || cell.col === cols - 1;
      const drain = Math.min(cell.depthM, drainedMPerStep * (edge ? .35 : 1));
      cell.depthM -= drain; drainedVolumeM3 += drain * cellArea;
      if (edge) { const out = cell.depthM * .015; cell.depthM -= out; boundaryOutflowM3 += out * cellArea; }
    }
    if (step % Math.max(1, Math.round(frameEveryMinutes / minutesPerStep)) === 0 || step === steps) frames.push({ minute: step * minutesPerStep, depthsM: raster.cells.flat().map((cell) => Math.round(cell.depthM * 1000) / 1000) });
  }
  const depths = raster.cells.flat().map((cell) => cell.depthM), storedM3 = depths.reduce((sum, depth) => sum + depth * cellArea, 0);
  return { raster: { ...raster, cells: raster.cells.map((row) => row.map(({ row: r, col, latitude: lat, longitude: lon, elevationM, depthM }) => ({ row: r, col, latitude: lat, longitude: lon, elevationM, depthM }))) }, frames, stats: { durationMinutes, rainfallVolumeM3: rainVolumeM3, drainedVolumeM3, boundaryOutflowM3, storedM3, continuityErrorPct: rainVolumeM3 ? Math.abs(rainVolumeM3 - drainedVolumeM3 - boundaryOutflowM3 - storedM3) / rainVolumeM3 * 100 : 0, maxDepthM: Math.max(...depths), floodedAreaM2: depths.filter((depth) => depth >= .05).length * cellArea }, status: 'exploratory-sparse-terrain-raster' };
}

function inspectRasterPoint(rasterRun, latitude, longitude) {
  const cells = rasterRun.raster.cells.flat();
  const cell = cells.reduce((closest, candidate) => Math.hypot(candidate.latitude - latitude, candidate.longitude - longitude) < Math.hypot(closest.latitude - latitude, closest.longitude - longitude) ? candidate : closest);
  return { ...cell, depthCm: Math.round(cell.depthM * 100), note: 'Point value is from the exploratory sparse-terrain raster, not a surveyed street elevation.' };
}

module.exports = { makeRaster, runRasterSpill, inspectRasterPoint };
