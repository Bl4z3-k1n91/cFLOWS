const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadSensorSnapshot } = require('../src/data/sensor-feed');

test('trusted sensor adapter validates freshness and maps segment telemetry', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cflows-sensor-'));
  fs.mkdirSync(path.join(root, 'data', 'sensors'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'data', 'sensors', 'live.json'), JSON.stringify({ observedAt: new Date(now - 60_000).toISOString(), source: 'test gateway', segments: [{ segmentId: 'gcc-7', upstreamLevelRatio: .9, downstreamLevelRatio: .2, velocityMs: .1 }] }));
  const snapshot = await loadSensorSnapshot(root, { now });
  assert.equal(snapshot.state, 'live');
  assert.equal(snapshot.bySegment['gcc-7'].upstreamLevelRatio, .9);
  assert.equal(snapshot.bySegment['gcc-7'].source, 'test gateway');
});

test('stale sensor snapshots remain readable but are not fresh evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cflows-sensor-'));
  fs.mkdirSync(path.join(root, 'data', 'sensors'), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'data', 'sensors', 'live.json'), JSON.stringify({ observedAt: new Date(now - 60 * 60 * 1000).toISOString(), segments: [{ segmentId: 'gcc-7', upstreamLevelRatio: .9, downstreamLevelRatio: .2 }] }));
  const snapshot = await loadSensorSnapshot(root, { now });
  assert.equal(snapshot.state, 'stale');
  assert.equal(snapshot.fresh, false);
});
