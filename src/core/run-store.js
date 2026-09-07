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

function safeRunId(id) {
  const value = String(id || '');
  if (!/^scenario-[A-Za-z0-9-]+$/.test(value)) throw new Error('Invalid scenario id.');
  return value;
}

async function readScenarioRun(directory, id) {
  const safeId = safeRunId(id);
  return JSON.parse(await fs.readFile(path.join(directory, `${safeId}.json`), 'utf8'));
}

async function writeScenarioRun(directory, record) {
  const safeId = safeRunId(record.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, `${safeId}.json`), JSON.stringify(record, null, 2));
  return record;
}

async function renameScenarioRun(directory, id, name) {
  const record = await readScenarioRun(directory, id);
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) throw new Error('Scenario name cannot be empty.');
  record.name = cleanName;
  record.updatedAt = new Date().toISOString();
  return writeScenarioRun(directory, record);
}

async function duplicateScenarioRun(directory, id, name = null) {
  const record = await readScenarioRun(directory, id);
  const { id: sourceId, createdAt: _createdAt, updatedAt: _updatedAt, ...copy } = record;
  return saveScenarioRun(directory, { ...copy, name: String(name || `${record.name || record.location?.label || 'Scenario'} copy`).slice(0, 80), duplicatedFrom: sourceId });
}

async function deleteScenarioRun(directory, id) {
  const safeId = safeRunId(id);
  await fs.unlink(path.join(directory, `${safeId}.json`));
  return { deleted: true, id: safeId };
}

async function importScenarioRun(directory, payload) {
  const input = payload && typeof payload === 'object' ? payload : null;
  if (!input?.location || !input?.scenario) throw new Error('This file is not a cFLOWS scenario bundle.');
  return saveScenarioRun(directory, {
    name: String(input.name || input.location?.label || 'Imported scenario').slice(0, 80),
    location: input.location,
    scenario: input.scenario,
    calibration: input.calibration || null,
    importedFrom: input.id || null,
  });
}

module.exports = { saveScenarioRun, listScenarioRuns, readScenarioRun, renameScenarioRun, duplicateScenarioRun, deleteScenarioRun, importScenarioRun };
