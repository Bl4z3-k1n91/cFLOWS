'use strict';

const { fetchOpenElevationGrid } = require('../src/data/sources');
const { makeRaster, runRasterSpill, summarizeRasterPooling } = require('../src/core/raster-spill');

const points = [
  ['Old Pallavaram', 12.9581, 80.1766],
  ['Velachery', 12.9824, 80.2090],
  ['Guindy', 13.0102, 80.2129],
  ['T Nagar', 13.0418, 80.2341],
  ['Adyar', 13.0067, 80.2575],
];

(async () => {
  for (const [name, latitude, longitude] of points) {
    try {
      const grid = await fetchOpenElevationGrid({ latitude, longitude });
      const run = runRasterSpill({
        raster: makeRaster({ latitude, longitude, elevationSamples: grid.samples }),
        rainfallMmHr: 80,
        imperviousPct: 70,
        durationMinutes: 120,
        drainRemovalMmHr: 0,
      });
      const summary = summarizeRasterPooling(run, latitude, longitude);
      console.log(JSON.stringify({
        name,
        depthBand: summary.depthBand,
        pattern: summary.pattern,
        selectedCm: Math.round(summary.selectedDepthM * 100),
        p90Cm: Math.round(summary.p90DepthM * 100),
        floodedPct: Math.round(summary.floodedFraction * 100),
        significantPct: Math.round(summary.significantFraction * 100),
        deepPct: Math.round(summary.deepFraction * 100),
      }));
    } catch (error) {
      console.log(JSON.stringify({ name, error: error.message }));
    }
  }
})();
