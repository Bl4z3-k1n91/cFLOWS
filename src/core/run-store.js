'use strict';
const fs = require('fs/promises');
const path = require('path');

function cleanRun(run) {
  const stamp = new Date().toISOString();
  return { id: `scenario-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`, createdAt: stamp, ...run };
}
async function saveScenarioRun(directory, run) {
  await fs.mkdir(directory, { recursive: true }); const record = cleanRun(run);
  await fs.writeFile(path.join(directory, `${record.id}.json`), JSON.stringify(record, null, 2)); return record;
}
async function listScenarioRuns(directory) {
  try {
    const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.json')).sort().reverse().slice(0, 30);
    return Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))));
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
module.exports = { saveScenarioRun, listScenarioRuns };
