const test = require('node:test');
const assert = require('node:assert/strict');

test('project package declares an Electron entry point', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.main, 'main.js');
  assert.match(pkg.scripts.start, /electron/);
});
