const test = require('node:test');
const assert = require('node:assert/strict');
const { predictDrainageNetwork, isFloodNews } = require('../src/core/hydrograph');
const { buildOperationalDecision } = require('../src/core/decision');

const common = { rainfallMmHr: 96, rainfallSourceFresh: true, reportsBySegment: {}, newsBySegment: {} };

test('HydroGraph flags hydraulic blockage signatures above unconstrained segments', () => {
  const result = predictDrainageNetwork({ segments: [
    { id: 'clear', widthM: 1.2, depthM: 1.2, slope: .008, conditionScore: .95, upstreamLevelRatio: .2, downstreamLevelRatio: .18, velocityMs: .9, elevationPercentile: .7, historicalFloodFrequency: .05, hasLevelSensor: true, hasVelocitySensor: true },
    { id: 'blocked', widthM: .6, depthM: .7, slope: .001, conditionScore: .35, upstreamLevelRatio: .92, downstreamLevelRatio: .18, velocityMs: .05, suspendedSolidsNtu: 260, elevationPercentile: .1, historicalFloodFrequency: .8, hasLevelSensor: true, hasVelocitySensor: true },
  ], context: common });
  assert.equal(result[0].id, 'blocked');
  assert.equal(result[0].severity, 'critical');
  assert.ok(result[0].reasons.includes('water is higher upstream than downstream'));
});

test('news is corroborating-only and requires location plus flood language', () => {
  const signal = isFloodNews({ title: 'Heavy rain causes waterlogging in Velachery', summary: '' });
  assert.equal(signal.floodRelated, true); assert.equal(signal.locationMatched, true);
  const irrelevant = isFloodNews({ title: 'Coimbatore cultural festival', summary: '' });
  assert.equal(irrelevant.floodRelated, false); assert.equal(irrelevant.locationMatched, false);
});

test('decision framework refuses dispatch from rain alone', () => {
  const decision = buildOperationalDecision({ rainfall: { fresh: true, mmHr: 32 }, reports: [], predictions: [{ severity: 'critical', confidence: .47 }] });
  assert.equal(decision.state, 'verify');
  assert.match(decision.action, /field verification/);
});
