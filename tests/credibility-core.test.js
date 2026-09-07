const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDrainGraph } = require('../src/core/drain-graph');
const { simulateSurfaceSpill } = require('../src/core/surface-spill');
const { buildHistoricalReplay, evaluateHindcasts, fitDepthCalibration } = require('../src/core/calibration');
const { resolveChennaiContext } = require('../src/core/chennai-context');
const { getHistoricalEvidenceRegistry } = require('../src/data/historical-evidence');
const { makeRaster, runRasterSpill, inspectRasterPoint } = require('../src/core/raster-spill');
const { buildNetworkInp, parseSwmmReport } = require('../src/core/swmm');
const { getDataStackStatus } = require('../src/data/data-stack');
const { estimateOvertureImperviousness } = require('../src/data/data-stack');
const { buildOperationalDecision, scopeReports } = require('../src/core/decision');
const { normalizeGccDrainProperties } = require('../src/data/gcc-drains');
const { loadDownstreamBoundary } = require('../src/data/downstream-boundary');
const fsPromises = require('fs/promises');
const os = require('os');
const path = require('path');

test('coincident public geometry can propagate experimentally without becoming surveyed connectivity', () => {
  const segments = [
    { id: 'a', points: [[80, 13], [80.0001, 13]], lengthM: 11, invertStartM: 5, invertEndM: 4.8, widthObserved: true, depthObserved: true },
    { id: 'b', points: [[80.0001, 13], [80.0002, 13]], lengthM: 11, invertStartM: 4.7, invertEndM: 4.5, widthObserved: true, depthObserved: true },
  ];
  const graph = buildDrainGraph(segments);
  assert.ok(graph.summary.inferredLinks >= 1);
  assert.ok(graph.summary.geometryLinks >= 1);
  assert.equal(graph.summary.confirmedLinks, 0);
  assert.deepEqual(segments[0].downstreamIds, ['b']);
  assert.deepEqual(segments[0].topology.confirmedDownstreamIds, []);
  assert.equal(segments[0].topology.propagationBasis, 'coincident-public-endpoints');
});

test('surface spill reports a broad exploratory range without calibration labels', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 150, imperviousPct: 75, catchmentAreaHa: .45, drainageRisk: .7, topologyConfidence: .2, calibration: { labelCount: 0, isCalibrated: false }, terrain: { depressionM: .18, reliefM: 2.1 }, drain: { observed: true, distanceM: 35, capacityIndex: .018 } });
  assert.equal(result.calibrated, false);
  assert.equal(result.state, 'exploratory-range-not-calibrated');
  assert.ok(result.depthRangeM.high > result.depthRangeM.low);
});

test('missing imperviousness stays unknown instead of becoming numeric zero', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 80, imperviousPct: null, imperviousRangePct: [40, 85], terrain: { depressionM: .1, reliefM: 2 }, drain: { observed: false } });
  assert.equal(result.imperviousPct, null);
  assert.deepEqual(result.imperviousRangePct, [40, 85]);
  assert.ok(result.runoffMmHr > 30);
});

test('surface spill withholds a generic range when location-specific inputs are absent', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 150, imperviousPct: 75 });
  assert.equal(result.available, false);
  assert.match(result.disclaimer, /cannot differentiate/i);
});

test('surface spill refuses drainage credit from outside its terrain domain but still permits conservative pooling screen', () => {
  const result = simulateSurfaceSpill({ rainfallMmHr: 80, imperviousPct: 70, terrain: { depressionM: .2, reliefM: 1 }, drain: { observed: true, distanceM: 634, capacityIndex: .03 } });
  assert.equal(result.available, true);
  assert.equal(result.surfaceOnly, true);
  assert.equal(result.drainRemovalMmHr, 0);
  assert.equal(result.state, 'surface-only-no-drain-credit');
  assert.match(result.missing.join(' '), /480 m surface domain/i);
});

test('GCC drain_size corrects decimal-shifted raw dimensions and preserves enclosure type', () => {
  const result = normalizeGccDrainProperties({ drain_wid: '7.29', drain_dep: '7.29', drain_size: '0.729 x 0.729', drain_detl: 'Closed' });
  assert.equal(result.widthM, .729);
  assert.equal(result.depthM, .729);
  assert.equal(result.dimensionConflict, true);
  assert.equal(result.crossSectionShape, 'RECT_CLOSED');
});

test('large legacy raw drain dimensions are withheld when drain_size is unavailable', () => {
  const result = normalizeGccDrainProperties({ drain_wid: '7.29', drain_dep: '7.29' });
  assert.equal(result.widthObserved, false);
  assert.equal(result.depthObserved, false);
  assert.match(result.dimensionSource, /ambiguous/i);
});

test('downstream hydraulic boundary refuses an unverified datum and accepts a reviewed compatible stage', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cflows-boundary-'));
  const directory = path.join(root, 'data', 'boundary');
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.writeFile(path.join(directory, 'live.json'), JSON.stringify({ source: 'test gauge', datum: 'unknown', stageM: 2.1 }));
  const blocked = await loadDownstreamBoundary(root, 'live');
  assert.equal(blocked.available, false);
  assert.equal(blocked.state, 'blocked-datum');
  await fsPromises.writeFile(path.join(directory, 'live.json'), JSON.stringify({ source: 'test gauge', datum: 'GCC-compatible test datum', datumCompatibleWithGccInverts: true, stageM: 2.1 }));
  const accepted = await loadDownstreamBoundary(root, 'live');
  assert.equal(accepted.available, true);
  assert.equal(accepted.state, 'reviewed-fixed-stage');
  assert.equal(accepted.boundary.stageM, 2.1);
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
  const inspection = inspectRasterPoint(run, 13, 80);
  assert.match(inspection.note, /rounded to decimetres/i);
  assert.ok(Number.isFinite(inspection.approximateDepthM));
});

test('local SWMM network generator includes every observed local drain link', () => {
  const inp = buildNetworkInp({ rainMmHr: 50, segments: [
    { id: 'a', points: [[80, 13], [80.0001, 13]], widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { id: 'b', points: [[80.0001, 13], [80.0002, 13]], widthM: 1, depthM: 1.1, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  assert.match(inp, /C001/); assert.match(inp, /C002/); assert.match(inp, /experimental local SWMM network/);
  const c1 = inp.match(/^C001\s+(J\d+)\s+(J\d+)/m);
  const c2 = inp.match(/^C002\s+(J\d+)\s+(J\d+)/m);
  assert.ok(c1 && c2);
  assert.equal(c1[2], c2[1], 'coincident endpoints must share the same SWMM junction');
});

test('SWMM network uses closed sections, per-reach catchments and datum-checked stage boundary inputs', () => {
  const inp = buildNetworkInp({ rainMmHr: 50, catchmentAreaBySegment: { a: .8, b: 1.2 }, outfallBoundary: { type: 'fixed-stage', stageM: 5.7 }, segments: [
    { id: 'a', closed: true, points: [[80, 13], [80.0001, 13]], widthM: .7, depthM: .5, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { id: 'b', closed: true, points: [[80.0001, 13], [80.0002, 13]], widthM: 1, depthM: .8, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  assert.match(inp, /^C001\s+RECT_CLOSED\s+0\.500\s+0\.700/m);
  assert.match(inp, /^S001\s+RG1\s+J\d+\s+0\.800/m);
  assert.match(inp, /^S002\s+RG1\s+J\d+\s+1\.200/m);
  assert.match(inp, /^O\d+\s+[-0-9.]+\s+FIXED\s+5\.700\s+NO/m);
});

test('production SWMM parser reads flooded-node volume and ponded depth from SWMM 5.2 tables', () => {
  const report = `
Node Flooding Summary
*********************
Flooding refers to all water that overflows a node, whether it ponds or not.
--------------------------------------------------------------------------
Node                 Flooded       CMS   days hr:min    10^6 ltr    Meters
--------------------------------------------------------------------------
J005                   12.78     0.166      0  12:12       1.357     2.804

Outfall Loading Summary
***********************
Analysis begun on: test
Analysis ended on: test
`;
  const parsed = parseSwmmReport(report);
  assert.equal(parsed.solved, true);
  assert.equal(parsed.floodedNodeCount, 1);
  assert.equal(parsed.flooded[0].volumeM3, 1357);
  assert.equal(parsed.totalFloodVolumeM3, 1357);
  assert.equal(parsed.maxPondedDepthM, 2.804);
});

test('unverified or distant citizen reports cannot authorize an operational action', () => {
  const now = Date.now();
  const focus = { latitude: 12.9768, longitude: 80.2205 };
  const distant = { latitude: 13.2, longitude: 80.3, depthM: .5, confidence: .95, verificationState: 'verified', source: 'crew report', timestamp: new Date(now).toISOString() };
  const localUnverified = { latitude: 12.977, longitude: 80.2206, depthM: .5, confidence: .35, verificationState: 'unverified', source: 'unverified citizen field report', timestamp: new Date(now).toISOString() };
  assert.equal(scopeReports([distant], focus, now).length, 0);
  const decision = buildOperationalDecision({ rainfall: { fresh: true, mmHr: 60 }, reports: [distant, localUnverified], focus, now, predictions: [{ severity: 'critical', confidence: .8, blockageProbability: .9, label: 'test drain' }] });
  assert.equal(decision.state, 'verify');
  assert.match(decision.action, /verification/i);
});

test('verified local evidence may unlock action only when model confidence is also high', () => {
  const now = Date.now();
  const focus = { latitude: 12.9768, longitude: 80.2205 };
  const verified = { latitude: 12.977, longitude: 80.2206, depthM: .5, confidence: .9, verificationState: 'verified', source: 'municipal crew report', timestamp: new Date(now).toISOString() };
  const decision = buildOperationalDecision({ rainfall: { fresh: true, mmHr: 60 }, reports: [verified], focus, now, predictions: [{ severity: 'critical', confidence: .7, blockageProbability: .9, label: 'test drain' }] });
  assert.equal(decision.state, 'act');
  assert.match(decision.action, /crew confirmation/i);
});

test('depth calibration requires explicit training and independent holdout rows', () => {
  const blocked = fitDepthCalibration(Array.from({ length: 30 }, (_, index) => ({ depth_m: .4, raw_model_depth_m: .3, split: index < 10 ? 'train' : '' })));
  assert.match(blocked.status, /^blocked/);
  const rows = [
    ...Array.from({ length: 10 }, (_, index) => ({ depth_m: .4 + index * .01, raw_model_depth_m: .2 + index * .01, split: 'train' })),
    ...Array.from({ length: 20 }, (_, index) => ({ depth_m: .5 + index * .005, raw_model_depth_m: .3 + index * .004, split: 'holdout' })),
  ];
  const fitted = fitDepthCalibration(rows);
  assert.equal(fitted.status, 'calibrated-with-independent-holdout');
  assert.ok(fitted.parameter.depthScale > 0);
  assert.ok(fitted.metrics.depthMaeM >= 0);
});

test('public data stack reports missing optional high-resolution imports honestly', async () => {
  const status = await getDataStackStatus(require('os').tmpdir());
  assert.equal(status.sources.find((source) => source.name === 'Overture buildings').state, 'import-needed');
});

test('missing local Overture coverage does not masquerade as a 35 percent place-specific impervious estimate', async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'cflows-overture-'));
  const directory = path.join(root, 'data', 'assets');
  await fsPromises.mkdir(directory, { recursive: true });
  await fsPromises.writeFile(path.join(directory, 'overture-buildings.geojson'), JSON.stringify({ type: 'FeatureCollection', features: [] }));
  const result = await estimateOvertureImperviousness({ projectRoot: root, latitude: 13, longitude: 80 });
  assert.equal(result.imperviousPct, null);
  assert.match(result.coverage, /no local coverage/i);
});
