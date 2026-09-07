const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { buildRainfallProfile } = require('../src/core/rainfall-profile');
const { makeRaster, runRasterSpill, summarizeRasterPooling } = require('../src/core/raster-spill');
const { assessInfrastructureImpact } = require('../src/core/impact');
const { saveScenarioRun, listScenarioRuns, renameScenarioRun, duplicateScenarioRun, deleteScenarioRun, importScenarioRun } = require('../src/core/run-store');

test('storm profiles preserve peak/duration but produce different reproducible totals', () => {
  const steady = buildRainfallProfile({ peakMmHr: 100, durationMinutes: 180, profile: 'steady' });
  const burst = buildRainfallProfile({ peakMmHr: 100, durationMinutes: 180, profile: 'cloudburst' });
  const double = buildRainfallProfile({ peakMmHr: 100, durationMinutes: 180, profile: 'two-wave' });
  assert.equal(steady.peakMmHr, 100);
  assert.equal(steady.durationMinutes, 180);
  assert.equal(steady.totalMm, 300);
  assert.ok(burst.totalMm < steady.totalMm);
  assert.notEqual(burst.totalMm, double.totalMm);
  assert.deepEqual(buildRainfallProfile({ peakMmHr: 100, durationMinutes: 180, profile: 'cloudburst' }), burst);
});

test('surface raster accepts time-varying rainfall and keeps mass continuity', () => {
  const profile = buildRainfallProfile({ peakMmHr: 120, durationMinutes: 120, profile: 'two-wave' });
  const raster = makeRaster({ latitude: 13, longitude: 80, rows: 8, cols: 8, radiusM: 160, elevationSamples: [{ latitude: 13, longitude: 80, elevationM: 8 }] });
  const run = runRasterSpill({ raster, rainfallSeries: profile.series, durationMinutes: profile.durationMinutes, imperviousPct: 70, drainRemovalMmHr: 10 });
  assert.equal(run.stats.rainfallSeriesUsed, true);
  assert.equal(run.stats.peakRainfallMmHr, 120);
  assert.ok(run.frames.length > 3);
  assert.ok(run.stats.continuityErrorPct < .001);
});

test('spatial pooling severity differentiates flat slope and bowl terrain under the same storm', () => {
  const run = (elevationSamples) => {
    const raster = makeRaster({ latitude: 13, longitude: 80, rows: 12, cols: 12, radiusM: 180, elevationSamples });
    return summarizeRasterPooling(runRasterSpill({ raster, rainfallMmHr: 80, imperviousPct: 70, durationMinutes: 120, drainRemovalMmHr: 0 }), 13, 80);
  };
  const flat = run([{ latitude: 13, longitude: 80, elevationM: 8 }]);
  const slope = run([
    { latitude: 13.004, longitude: 80, elevationM: 12 },
    { latitude: 13, longitude: 80, elevationM: 8 },
    { latitude: 12.996, longitude: 80, elevationM: 4 },
  ]);
  const bowl = run([
    { latitude: 13, longitude: 80, elevationM: 4 },
    { latitude: 13.004, longitude: 80, elevationM: 10 },
    { latitude: 12.996, longitude: 80, elevationM: 10 },
    { latitude: 13, longitude: 80.004, elevationM: 10 },
    { latitude: 13, longitude: 79.996, elevationM: 10 },
  ]);
  assert.equal(flat.depthBand, 'minimal-ponding');
  assert.equal(bowl.depthBand, 'deep-inundation-possible');
  assert.ok(slope.floodedFraction > flat.floodedFraction);
  assert.ok(slope.maxDepthM > flat.maxDepthM);
  assert.ok(bowl.deepFraction > flat.deepFraction);
  assert.ok(bowl.maxDepthM > slope.maxDepthM);
});

test('road and facility impact is ranked from the screening raster without claiming observation', () => {
  const raster = makeRaster({ latitude: 13, longitude: 80, rows: 6, cols: 6, radiusM: 120, elevationSamples: [{ latitude: 13, longitude: 80, elevationM: 8 }] });
  raster.cells[2][2].depthM = .5;
  raster.cells[2][3].depthM = .2;
  const impact = assessInfrastructureImpact({
    rasterRun: { raster },
    roadFeatures: [{ id: 'r1', name: 'Test Road', geometry: [{ lat: raster.cells[2][2].latitude, lon: raster.cells[2][2].longitude }, { lat: raster.cells[2][3].latitude, lon: raster.cells[2][3].longitude }] }],
    facilityFeatures: [{ id: 'h1', name: 'Test Hospital', kind: 'hospital', latitude: raster.cells[2][2].latitude, longitude: raster.cells[2][2].longitude }],
    waterFeatures: [{ id: 'w1', name: 'Test Lake', kind: 'water', geometry: [] }],
  });
  assert.equal(impact.available, true);
  assert.equal(impact.roads[0].name, 'Test Road');
  assert.equal(impact.facilities[0].name, 'Test Hospital');
  assert.match(impact.disclaimer, /not a road-closure notice/i);
});

test('scenario library supports rename duplicate import and delete', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cflows-runs-'));
  const first = await saveScenarioRun(directory, { name: 'Original', location: { label: 'Velachery', latitude: 13, longitude: 80 }, scenario: { rainfallMmHr: 80 } });
  const renamed = await renameScenarioRun(directory, first.id, 'Renamed');
  assert.equal(renamed.name, 'Renamed');
  const duplicate = await duplicateScenarioRun(directory, first.id);
  assert.notEqual(duplicate.id, first.id);
  assert.equal(duplicate.duplicatedFrom, first.id);
  const imported = await importScenarioRun(directory, { name: 'Imported', location: { label: 'Taramani', latitude: 13, longitude: 80 }, scenario: { rainfallMmHr: 120 } });
  assert.equal(imported.name, 'Imported');
  assert.equal((await listScenarioRuns(directory)).length, 3);
  await deleteScenarioRun(directory, duplicate.id);
  assert.equal((await listScenarioRuns(directory)).length, 2);
});
