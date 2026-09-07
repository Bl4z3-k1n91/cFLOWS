const test = require('node:test');
const assert = require('node:assert/strict');
const { makeRaster, runRasterSpill } = require('../src/core/raster-spill');
const { buildSpatialSurfaceFields } = require('../src/core/spatial-surface');
const { runSurfaceEnsemble } = require('../src/core/surface-ensemble');
const { terrariumElevationFromRgb, mercatorGlobalPixel } = require('../src/data/sources');

function syntheticTerrain() {
  return makeRaster({
    latitude: 13,
    longitude: 80,
    radiusM: 140,
    rows: 10,
    cols: 10,
    elevationSamples: [
      { latitude: 13.0012, longitude: 79.9988, elevationM: 9 },
      { latitude: 13.0012, longitude: 80.0012, elevationM: 8 },
      { latitude: 12.9988, longitude: 79.9988, elevationM: 7 },
      { latitude: 12.9988, longitude: 80.0012, elevationM: 6 },
      { latitude: 13, longitude: 80, elevationM: 5.5 },
      { latitude: 13.0006, longitude: 80, elevationM: 7 },
      { latitude: 12.9994, longitude: 80, elevationM: 6 },
      { latitude: 13, longitude: 79.9994, elevationM: 6.5 },
      { latitude: 13, longitude: 80.0006, elevationM: 5.8 },
    ],
  });
}

test('surface fields vary runoff roughness and drain exchange across mapped urban geometry', () => {
  const raster = syntheticTerrain();
  const centre = raster.cells[5][5];
  const context = {
    buildingFeatures: [{ geometry: [
      { lat: centre.latitude - .00018, lon: centre.longitude - .00018 },
      { lat: centre.latitude - .00018, lon: centre.longitude + .00018 },
      { lat: centre.latitude + .00018, lon: centre.longitude + .00018 },
      { lat: centre.latitude + .00018, lon: centre.longitude - .00018 },
    ] }],
    roadFeatures: [{ highway: 'primary', geometry: [
      { lat: 12.9989, lon: 79.9995 }, { lat: 13.0011, lon: 79.9995 },
    ] }],
    waterFeatures: [],
  };
  const drainSegments = [{ points: [[80.0005, 12.999], [80.0005, 13.001]] }];
  const spatial = buildSpatialSurfaceFields({ raster, runoffContext: context, drainSegments, baseImperviousPct: 62 });
  assert.equal(spatial.stats.available, true);
  assert.ok(spatial.stats.buildingCells > 0);
  assert.ok(spatial.stats.roadCells > 0);
  assert.ok(spatial.stats.drainCells > 0);
  const classes = new Set(spatial.raster.cells.flat().map((cell) => cell.landClass));
  assert.ok(classes.has('background'));
  assert.ok(classes.has('building'));
  assert.ok(classes.has('road'));
});

test('spatial surface run conserves water while using infiltration and concentrated drain exchange', () => {
  const spatial = buildSpatialSurfaceFields({
    raster: syntheticTerrain(),
    runoffContext: { roadFeatures: [{ highway: 'secondary', geometry: [{ lat: 12.999, lon: 80 }, { lat: 13.001, lon: 80 }] }] },
    drainSegments: [{ points: [[80.0003, 12.999], [80.0003, 13.001]] }],
    baseImperviousPct: 60,
  });
  const run = runRasterSpill({ raster: spatial.raster, rainfallMmHr: 70, durationMinutes: 45, imperviousPct: 60, drainRemovalMmHr: 15 });
  assert.equal(run.stats.spatialSurfaceUsed, true);
  assert.equal(run.stats.spatialDrainExchangeUsed, true);
  assert.ok(run.stats.infiltrationVolumeM3 > 0);
  assert.ok(run.stats.drainedVolumeM3 > 0);
  assert.ok(run.stats.continuityErrorPct < .01);
});

test('surface ensemble exposes robustness frequencies and parameter sensitivity rather than one deterministic label', () => {
  const spatial = buildSpatialSurfaceFields({ raster: syntheticTerrain(), runoffContext: {}, drainSegments: [], baseImperviousPct: 58 });
  const ensemble = runSurfaceEnsemble({ raster: spatial.raster, latitude: 13, longitude: 80, rainfallMmHr: 80, durationMinutes: 60, imperviousPct: 58, drainRemovalMmHr: 0 });
  assert.equal(ensemble.available, true);
  assert.equal(ensemble.memberCount, 12);
  assert.ok(ensemble.selectedDepthM.p10 <= ensemble.selectedDepthM.p50);
  assert.ok(ensemble.selectedDepthM.p50 <= ensemble.selectedDepthM.p90);
  assert.ok(ensemble.sensitivity.length >= 4);
  assert.ok(ensemble.maxContinuityErrorPct < .01);
});

test('verified observation hook seeds antecedent water and remains inside the mass balance', () => {
  const raster = syntheticTerrain();
  const run = runRasterSpill({
    raster,
    rainfallMmHr: 0,
    durationMinutes: 5,
    imperviousPct: 60,
    initialObservations: [{ latitude: 13, longitude: 80, depthM: .25, confidence: 1 }],
  });
  assert.equal(run.stats.assimilatedObservationCount, 1);
  assert.ok(run.stats.initialStorageM3 > 0);
  assert.ok(run.stats.continuityErrorPct < .01);
});

test('Terrarium DEM decoder and Web Mercator pixel mapping are deterministic', () => {
  assert.equal(terrariumElevationFromRgb(128, 0, 0), 0);
  assert.equal(terrariumElevationFromRgb(128, 100, 128), 100.5);
  const pixel = mercatorGlobalPixel(0, 0, 0);
  assert.ok(Math.abs(pixel.x - 128) < 1e-9);
  assert.ok(Math.abs(pixel.y - 128) < 1e-9);
});
