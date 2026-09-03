const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDrainGraph } = require('../src/core/drain-graph');
const { simulateSurfaceSpill } = require('../src/core/surface-spill');
const { buildHistoricalReplay, evaluateHindcasts } = require('../src/core/calibration');
const { resolveChennaiContext } = require('../src/core/chennai-context');
const { getHistoricalEvidenceRegistry } = require('../src/data/historical-evidence');
const { makeRaster, runRasterSpill, inspectRasterPoint } = require('../src/core/raster-spill');
const { buildNetworkInp } = require('../src/core/swmm');
const { getDataStackStatus } = require('../src/data/data-stack');

test('public geometry creates labelled inferred links but no fake confirmed connectivity', () => {
  const segments = [
    { id: 'a', points: [[80, 13], [80.0001, 13]], lengthM: 11, invertStartM: 5, invertEndM: 4.8, widthObserved: true, depthObserved: true },
    { id: 'b', points: [[80.0001, 13], [80.0002, 13]], lengthM: 11, invertStartM: 4.7, invertEndM: 4.5, widthObserved: true, depthObserved: true },
  ];
  const graph = buildDrainGraph(segments);
  assert.ok(graph.summary.inferredLinks >= 1);
  assert.equal(graph.summary.confirmedLinks, 0);
  assert.deepEqual(segments[0].downstreamIds, []);
});

test('surface spill reports a broad exploratory range without calibration labels', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 150, imperviousPct: 75, catchmentAreaHa: .45, drainageRisk: .7, topologyConfidence: .2, calibration: { labelCount: 0, isCalibrated: false }, terrain: { depressionM: .18, reliefM: 2.1 }, drain: { observed: true, distanceM: 35, capacityIndex: .018 } });
  assert.equal(result.calibrated, false);
  assert.equal(result.state, 'exploratory-range-not-calibrated');
  assert.ok(result.depthRangeM.high > result.depthRangeM.low);
});

test('surface spill withholds a generic range when location-specific inputs are absent', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 150, imperviousPct: 75 });
  assert.equal(result.available, false);
  assert.match(result.disclaimer, /cannot differentiate/i);
});

test('daily IMD rainfall without flood labels cannot claim calibration', () => {
  const result = buildHistoricalReplay({ rainfallRows: [{ DISTRICT: 'Chennai', DATE: '2026-09-01', 'DAILY ACTUAL': '12.5' }], labelRows: [] });
  assert.equal(result.isCalibrated, false);
  assert.match(result.conclusion, /not flood-depth calibration/i);
});

test('hindcast evaluator withholds metrics until it has enough held-out events', () => {
  const result = evaluateHindcasts([{ observed_flooded: 'true', predicted_flooded: 'true' }]);
  assert.equal(result.status, 'blocked-insufficient-held-out-events');
  assert.equal(result.metrics, null);
});

test('hindcast evaluator reports reproducible event metrics once the held-out gate is met', () => {
  const rows = Array.from({ length: 20 }, (_, index) => ({ observed_flooded: index < 10 ? 'true' : 'false', predicted_flooded: index < 8 || index === 10 ? 'true' : 'false', depth_m: index < 10 ? '.4' : '', predicted_depth_m: index < 10 ? '.3' : '' }));
  const result = evaluateHindcasts(rows);
  assert.equal(result.status, 'evaluated-held-out-events');
  assert.equal(result.metrics.confusion.tp, 8);
  assert.equal(result.metrics.confusion.fn, 2);
  assert.equal(result.metrics.confusion.fp, 1);
  assert.ok(Math.abs(result.metrics.depthMaeM - .1) < 1e-9);
});

test('regional Chennai context exposes an outfall hypothesis without claiming pipe connectivity', () => {
  const result = resolveChennaiContext({ latitude: 12.9768, longitude: 80.2205, marineBoundary: { source: 'marine model', levelM: .2, outfallRestriction: 'elevated', observed: false } });
  assert.match(result.catchment, /Pallikaranai/);
  assert.match(result.connection, /does not prove/i);
  assert.equal(result.marineBoundary.observed, false);
});

test('official NRSC history is evidence until a georeferenced label is reviewed', () => {
  const archive = getHistoricalEvidenceRegistry();
  assert.equal(archive.usableLabelCount, 0);
  assert.ok(archive.events.some((event) => event.layerId === 'ch_exp_0306dec15'));
  assert.match(archive.conclusion, /not used to calibrate/i);
});

test('deterministic sparse-terrain raster conserves rainfall within numerical tolerance', () => {
  const terrain = makeRaster({ latitude: 13, longitude: 80, rows: 8, cols: 8, radiusM: 160, elevationSamples: [{ latitude: 13, longitude: 80, elevationM: 8 }] });
  const run = runRasterSpill({ raster: terrain, rainfallMmHr: 80, imperviousPct: 70, durationMinutes: 30, drainRemovalMmHr: 18 });
  assert.ok(run.frames.length >= 1);
  assert.ok(run.stats.continuityErrorPct < .001);
  assert.match(inspectRasterPoint(run, 13, 80).note, /exploratory/);
});

test('local SWMM network generator includes every observed local drain link', () => {
  const inp = buildNetworkInp({ rainMmHr: 50, segments: [
    { widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { widthM: 1, depthM: 1.1, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  assert.match(inp, /C001/); assert.match(inp, /C002/); assert.match(inp, /experimental local SWMM network/);
});

test('public data stack reports missing optional high-resolution imports honestly', async () => {
  const status = await getDataStackStatus(require('os').tmpdir());
  assert.equal(status.sources.find((source) => source.name === 'Overture buildings + roads').state, 'import-needed');
});
