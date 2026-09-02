const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('neer', {
  runPilot: (liveInputs) => ipcRenderer.invoke('hydrograph:run-pilot', liveInputs),
  simulateScenario: (input) => ipcRenderer.invoke('hydrograph:simulate-scenario', input),
  addFieldReport: (report) => ipcRenderer.invoke('hydrograph:add-field-report', report),
  listFieldReports: () => ipcRenderer.invoke('hydrograph:list-field-reports'),
  ask: (question) => ipcRenderer.invoke('hydrograph:ask', question),
  converse: (message) => ipcRenderer.invoke('hydrograph:converse', message),
  listScenarioRuns: () => ipcRenderer.invoke('hydrograph:list-scenario-runs'),
  inspectScenarioPoint: (input) => ipcRenderer.invoke('hydrograph:inspect-scenario-point', input),
});
