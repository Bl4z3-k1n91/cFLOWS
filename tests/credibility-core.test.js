const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDrainGraph } = require('../src/core/drain-graph');
const { simulateSurfaceSpill } = require('../src/core/surface-spill');
const { buildHistoricalReplay } = require('../src/core/calibration');

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
  const result = simulateSurfaceSpill({ rainfallMmHr: 150, imperviousPct: 75, catchmentAreaHa: .45, drainageRisk: .7, topologyConfidence: .2, calibration: { labelCount: 0, isCalibrated: false } });
  assert.equal(result.calibrated, false);
  assert.equal(result.state, 'exploratory-range-not-calibrated');
  assert.ok(result.depthRangeM.high > result.depthRangeM.low);
});

test('daily IMD rainfall without flood labels cannot claim calibration', () => {
  const result = buildHistoricalReplay({ rainfallRows: [{ DISTRICT: 'Chennai', DATE: '2026-09-01', 'DAILY ACTUAL': '12.5' }], labelRows: [] });
  assert.equal(result.isCalibrated, false);
  assert.match(result.conclusion, /not flood-depth calibration/i);
});
