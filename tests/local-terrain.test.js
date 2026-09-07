const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLocalElevationGrid } = require('../src/data/local-terrain');

test('local terrain adapter prefers reviewed elevation samples when enough cover the point', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cflows-terrain-'));
  fs.mkdirSync(path.join(root, 'data', 'terrain'), { recursive: true });
  const samples = [];
  for (let row = -2; row <= 2; row += 1) for (let col = -2; col <= 2; col += 1) samples.push({ latitude: 13 + row * .0002, longitude: 80 + col * .0002, elevationM: 6 + row * .1 + col * .05 });
  fs.writeFileSync(path.join(root, 'data', 'terrain', 'local-elevation-samples.json'), JSON.stringify({ source: 'test 5 m DEM export', resolutionM: 5, samples }));
  const result = await loadLocalElevationGrid(root, { latitude: 13, longitude: 80, radiusM: 200 });
  assert.equal(result.local, true);
  assert.equal(result.resolutionM, 5);
  assert.ok(result.samples.length >= 9);
});
