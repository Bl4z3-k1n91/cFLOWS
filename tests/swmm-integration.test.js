const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildNetworkInp, buildPrototypeInp } = require('../src/core/swmm');
const { buildRainfallProfile } = require('../src/core/rainfall-profile');

const solver = path.join(__dirname, '..', 'vendor', 'epa-swmm', 'bin', 'runswmm.exe');

function executeInp(t, name, input) {
  if (!fs.existsSync(solver)) { t.skip('EPA SWMM executable is not built on this machine'); return null; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflows-swmm-'));
  const inp = path.join(dir, `${name}.inp`), rpt = path.join(dir, `${name}.rpt`), out = path.join(dir, `${name}.out`);
  fs.writeFileSync(inp, input);
  const result = spawnSync(solver, [inp, rpt, out], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = fs.readFileSync(rpt, 'utf8');
  assert.doesNotMatch(report, /\bERROR\s+\d+/i);
  assert.doesNotMatch(report, /\bWARNING\s+\d+/i);
  assert.match(report, /Analysis ended/i);
  return report;
}

test('generated representative reach solves cleanly in EPA SWMM', (t) => {
  const input = buildPrototypeInp({ rainMmHr: 80, widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 });
  assert.match(input, /START_DATE\s+\d{2}\/\d{2}\/\d{4}/);
  assert.doesNotMatch(input, /\[END\]/);
  executeInp(t, 'prototype', input);
});

test('connected two-reach network solves cleanly in EPA SWMM', (t) => {
  const input = buildNetworkInp({ rainMmHr: 80, segments: [
    { id: 'a', points: [[80, 13], [80.0001, 13]], widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { id: 'b', points: [[80.0001, 13], [80.0002, 13]], widthM: 1, depthM: 1.1, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  const c1 = input.match(/^C001\s+(J\d+)\s+(J\d+)/m), c2 = input.match(/^C002\s+(J\d+)\s+(J\d+)/m);
  assert.ok(c1 && c2);
  assert.equal(c1[2], c2[1]);
  executeInp(t, 'network', input);
});

test('closed connected network with fixed downstream stage solves cleanly in EPA SWMM', (t) => {
  const input = buildNetworkInp({ rainMmHr: 80, catchmentAreaBySegment: { a: .8, b: 1.0 }, outfallBoundary: { type: 'fixed-stage', stageM: 5.45 }, segments: [
    { id: 'a', closed: true, points: [[80, 13], [80.0001, 13]], widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { id: 'b', closed: true, points: [[80.0001, 13], [80.0002, 13]], widthM: 1, depthM: 1.1, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  assert.match(input, /RECT_CLOSED/);
  assert.match(input, /FIXED\s+5\.450/);
  executeInp(t, 'closed-boundary-network', input);
});

test('time-shaped multi-hour storm solves cleanly in EPA SWMM', (t) => {
  const profile = buildRainfallProfile({ peakMmHr: 150, durationMinutes: 240, profile: 'two-wave' });
  const input = buildNetworkInp({ rainMmHr: 150, rainfallSeries: profile.series, durationMinutes: profile.durationMinutes, segments: [
    { id: 'a', closed: true, points: [[80, 13], [80.0001, 13]], widthM: .8, depthM: .9, lengthM: 80, invertStartM: 6, invertEndM: 5.8 },
    { id: 'b', closed: true, points: [[80.0001, 13], [80.0002, 13]], widthM: 1, depthM: 1.1, lengthM: 100, invertStartM: 5.8, invertEndM: 5.6 },
  ] });
  assert.match(input, /END_TIME 04:00:00/);
  assert.match(input, /RAIN \d{2}\/\d{2}\/\d{4} 02:00:00/);
  executeInp(t, 'variable-rain-network', input);
});
