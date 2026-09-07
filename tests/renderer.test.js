const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('project package declares an Electron entry point', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'main.js');
  assert.match(pkg.scripts.start, /electron/);
  assert.match(pkg.scripts.smoke, /CFLOWS_SMOKE_TEST/);
});

test('initial UI contains no canned flood depths, pump dispatches or replay claims', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /S-17|P-04|0\.62 m|92 mm\/h|Replay ready|08:48/);
  assert.match(html, /separates what is observed from what is estimated/i);
  assert.match(html, /never treats placeholder values as real observations/i);
});

test('all first-class navigation items have implemented view targets', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.html'), 'utf8');
  for (const view of ['nowcast', 'network', 'scenarios', 'analytics']) assert.match(html, new RegExp(`data-view="${view}"`));
});

test('renderer does not synthesize live risk, rain or pump effectiveness from the timeline', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer.js'), 'utf8');
  assert.doesNotMatch(source, /Pump P-04 cuts|0\.62 m predicted|Math\.max\(35, Math\.round\(92/);
  assert.match(source, /Synthetic live replay is disabled/);
});
