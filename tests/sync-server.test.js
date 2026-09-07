const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

test('shared report service keeps citizen reports unverified and visible to other clients', async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cflows-sync-'));
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'sync-server.js')], {
    env: { ...process.env, CFLOWS_SYNC_PORT: String(port), CFLOWS_SYNC_HOST: '127.0.0.1', CFLOWS_SYNC_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { if (!child.killed) child.kill(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sync server did not start')), 5000);
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('cFLOWS sync listening')) { clearTimeout(timer); resolve(); } });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`sync server exited early with ${code}`)); });
  });
  const base = `http://127.0.0.1:${port}`;
  const created = await fetch(`${base}/reports`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ latitude: 12.9768, longitude: 80.2205, depthM: .28 }) }).then((response) => response.json());
  assert.equal(created.report.verificationState, 'unverified');
  assert.equal(created.report.confidence, .35);
  const listed = await fetch(`${base}/reports`).then((response) => response.json());
  assert.equal(listed.reports.length, 1);
  assert.equal(listed.reports[0].id, created.report.id);
});
