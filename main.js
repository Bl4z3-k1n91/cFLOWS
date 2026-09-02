const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');
const { fetchGccDrainsForEnvelope, fetchOpenMeteoRainfall, fetchOpenElevation, fetchOpenElevationGrid, fetchGdeltFloodSignals, fetchGoogleNewsFloodSignals, geocodeChennai, fetchKartaViewStreetPhoto, fetchOsmRunoffProxy } = require('./src/data/sources');
const { predictDrainageNetwork, isFloodNews } = require('./src/core/hydrograph');
const { runSwmmPrototype, runSwmmNetwork } = require('./src/core/swmm');
const { buildDrainGraph } = require('./src/core/drain-graph');
const { simulateSurfaceSpill } = require('./src/core/surface-spill');
const { loadCalibrationInputs, buildHistoricalReplay } = require('./src/core/calibration');
const { makeRaster, runRasterSpill, inspectRasterPoint } = require('./src/core/raster-spill');
const { saveScenarioRun, listScenarioRuns } = require('./src/core/run-store');
const { buildOperationalDecision } = require('./src/core/decision');
const { evidencePacket, askNarrator } = require('./src/core/narrator');
let latestPilotRun = null;
let calibrationSnapshot = null;

// Keep profile and Chromium session data beside the project. `sessionData`
// must be set before app readiness or Chromium falls back to a policy-locked
// profile cache on this host.
const localProfile = path.join(__dirname, '.electron-data');
const localSession = path.join(localProfile, 'session');
fsSync.mkdirSync(localSession, { recursive: true });
app.setPath('userData', localProfile);
app.setPath('sessionData', localSession);

const reportPath = () => path.join(app.getPath('userData'), 'field-reports.json');
async function readReports() {
  try { return JSON.parse(await fs.readFile(reportPath(), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? [] : Promise.reject(error); }
}
async function addReport(input) {
  const latitude = Number(input.latitude), longitude = Number(input.longitude), depthM = Number(input.depthM);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(depthM) || depthM < 0 || depthM > 3) throw new Error('Report must include a valid location and water depth.');
  const report = { id: `field-${Date.now()}-${Math.random().toString(16).slice(2)}`, latitude, longitude, depthM, confidence: .55, source: 'field report', timestamp: new Date().toISOString() };
  const reports = await readReports(); reports.push(report);
  await fs.mkdir(path.dirname(reportPath()), { recursive: true });
  await fs.writeFile(reportPath(), JSON.stringify(reports.slice(-500), null, 2));
  return report;
}
function nearestSegmentId(report, features) {
  let selected = null, distance = Infinity;
  for (const feature of features) {
    const points = feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates.flat() : feature.geometry?.coordinates || [];
    for (const [longitude, latitude] of points) {
      const d = (longitude - report.longitude) ** 2 + (latitude - report.latitude) ** 2;
      if (d < distance) { distance = d; selected = `gcc-${feature.properties?.objectid}`; }
    }
  }
  return selected;
}
function lineLengthM(geometry) {
  const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates : geometry?.type === 'LineString' ? [geometry.coordinates] : [];
  return lines.reduce((total, line) => total + line.slice(1).reduce((distance, point, index) => {
    const [lonA, latA] = line[index], [lonB, latB] = point;
    const meanLat = ((latA + latB) / 2) * Math.PI / 180;
    return distance + Math.hypot((lonB - lonA) * 111320 * Math.cos(meanLat), (latB - latA) * 110540);
  }, 0), 0);
}
function nearestDrainToPoint(segments, latitude, longitude) {
  let nearest = null, distanceM = Infinity;
  for (const segment of segments) for (const [lon, lat] of segment.points || []) {
    const metres = Math.hypot((lon - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (lat - latitude) * 110540);
    if (metres < distanceM) { nearest = segment; distanceM = metres; }
  }
  return nearest ? { ...nearest, snappedDistanceM: distanceM } : null;
}
function inferLocalDrainNetwork(segments, selected) {
  if (!selected?.points?.length) return [];
  const ends = [selected.points[0], selected.points[selected.points.length - 1]];
  const nearby = segments.filter((segment) => segment.id !== selected.id && segment.points?.length).map((segment) => {
    const candidates = [segment.points[0], segment.points[segment.points.length - 1]];
    const distanceM = Math.min(...ends.flatMap(([lonA, latA]) => candidates.map(([lonB, latB]) => Math.hypot((lonA - lonB) * 111320 * Math.cos(latA * Math.PI / 180), (latA - latB) * 110540))));
    return { segment, distanceM };
  }).filter((item) => item.distanceM < 45).sort((a, b) => a.distanceM - b.distanceM).slice(0, 6);
  return nearby.map(({ segment, distanceM }) => ({ id: segment.id, label: segment.label, distanceM: Math.round(distanceM), slope: segment.slope, widthM: segment.widthM, depthM: segment.depthM }));
}
function parseNaturalReport(text) {
  const words = String(text || '').toLowerCase();
  if (!/(?:i see|there is|water is|water level|ankle|knee|wheel|waterlog|inundat)/.test(words)) return null;
  const depthM = /wheel|waist/.test(words) ? .55 : /knee/.test(words) ? .28 : /ankle/.test(words) ? .08 : null;
  const location = words.match(/(?:near|at|on|around)\s+([a-z0-9 .,'-]{3,70})/i)?.[1]?.replace(/[.!?].*$/, '').trim();
  return depthM && location ? { depthM, location } : { needsLocation: !location, needsDepth: !depthM };
}
function extractPlace(text) {
  return String(text || '').match(/(?:near|around|in|at)\s+([a-z0-9 .,'-]{3,70})/i)?.[1]?.replace(/[?!.,].*$/, '').trim() || null;
}
function plainFallback(run) {
  const decision = run.decision;
  return `${decision.headline}. ${decision.explanation} Next step: ${decision.action}.`;
}
function sourceStatus(name, result, detail) {
  return result.status === 'fulfilled' ? { name, state: 'live', detail, fetchedAt: result.value.fetchedAt || new Date().toISOString() } : { name, state: 'unavailable', detail: result.reason?.message || detail };
}
async function fetchNewsSignals(query) {
  try { return await fetchGdeltFloodSignals(query, 12); }
  catch { return fetchGoogleNewsFloodSignals(query, 12); }
}
async function getCalibrationSnapshot() {
  if (calibrationSnapshot) return calibrationSnapshot;
  const inputs = await loadCalibrationInputs({
    rainfallPath: path.join(__dirname, 'data', 'imd', 'rainfall_districtwise_daily_imd.csv'),
    labelsPath: path.join(__dirname, 'data', 'calibration', 'flood-observations.csv'),
  });
  calibrationSnapshot = buildHistoricalReplay(inputs);
  return calibrationSnapshot;
}
async function buildPilotRun(liveInputs = {}) {
  // Bounded pilot envelope: Velachery → Pallikaranai. The GIS service is the
  // authoritative geometry source; missing live observations stay missing.
  const latitude = Number(liveInputs.area?.latitude || 12.9768), longitude = Number(liveInputs.area?.longitude || 80.2205);
  const drains = await fetchGccDrainsForEnvelope({ west: longitude - .025, south: latitude - .027, east: longitude + .025, north: latitude + .027 });
  const features = (drains.features || []).slice(0, 2000);
  const reports = await readReports();
  const reportsBySegment = reports.reduce((grouped, report) => {
    const id = nearestSegmentId(report, features); if (id) (grouped[id] ||= []).push(report); return grouped;
  }, {});
  let rainfall = { source: 'manual input', mmHr: Number(liveInputs.rainfallMmHr || 0), fresh: Boolean(liveInputs.rainfallSourceFresh), observedAt: null, forecast: [] };
  if (!Number.isFinite(Number(liveInputs.rainfallMmHr))) {
    try { rainfall = await fetchOpenMeteoRainfall({ latitude, longitude }); } catch (error) { rainfall = { source: 'rainfall feed unavailable', mmHr: 0, fresh: false, error: error.message }; }
  }
  const [elevationResult, newsResult, calibrationResult] = await Promise.allSettled([
    fetchOpenElevation({ latitude, longitude }),
    fetchNewsSignals(`${liveInputs.area?.label || 'Chennai'} flood OR waterlogging`),
    getCalibrationSnapshot(),
  ]);
  const elevation = elevationResult.status === 'fulfilled' ? elevationResult.value : null;
  const newsSignals = newsResult.status === 'fulfilled' ? newsResult.value.map((item) => isFloodNews(item)) : [];
  const calibration = calibrationResult.status === 'fulfilled' ? calibrationResult.value : { status: 'unavailable', labelCount: 0, isCalibrated: false, missing: ['calibration data could not be loaded'] };
  const dataSources = [
    { name: 'GCC storm-water drain GIS', state: 'live', detail: `${features.length} mapped drain features`, fetchedAt: new Date().toISOString() },
    { name: 'Current rain + 6-hour forecast', state: rainfall.fresh ? 'live' : 'unavailable', detail: rainfall.source, fetchedAt: rainfall.fetchedAt || null },
    sourceStatus('Terrain elevation', elevationResult, elevation ? `${elevation.elevationM} m at map focus` : 'Terrain sample unavailable'),
    sourceStatus('Flood and waterlogging news', newsResult, newsSignals.length ? `${newsSignals.length} recent signals; corroboration only` : 'No recent signals'),
    { name: 'Field reports', state: reports.length ? 'live' : 'waiting', detail: reports.length ? `${reports.length} locally recorded report(s)` : 'No verified field report yet' },
    { name: 'Water-level / velocity sensors', state: 'integration-needed', detail: 'Adapter ready; municipal endpoint required' },
    { name: 'Tide / outfall state', state: 'integration-needed', detail: 'Adapter ready; harbour/tide endpoint required' },
    { name: 'Historic inundation labels', state: 'integration-needed', detail: 'Import NRSC/municipal historical flood layer to calibrate' },
    { name: 'Historical calibration gate', state: calibration.isCalibrated ? 'validated' : 'blocked', detail: calibration.conclusion || 'Calibration evidence unavailable' },
  ];
  const segments = features.map((feature) => {
    const p = feature.properties || {};
    const rawWidth = Number.parseFloat(p.drain_wid), rawDepth = Number.parseFloat(p.drain_dep);
    const number = (value, fallback) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const lengthM = lineLengthM(feature.geometry), invertStartM = Number.parseFloat(p.invert_sp), invertEndM = Number.parseFloat(p.invert_ep);
    const points = feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates.flat() : feature.geometry?.coordinates || [];
    const derivedSlope = Number.isFinite(invertStartM) && Number.isFinite(invertEndM) && lengthM > 0 ? Math.max(.00005, Math.abs(invertStartM - invertEndM) / lengthM) : .001;
    return { id: `gcc-${p.objectid}`, label: p.location || 'the closest mapped drain', widthM: number(p.drain_wid, .6), depthM: number(p.drain_dep, .75), widthObserved: Number.isFinite(rawWidth) && rawWidth > 0, depthObserved: Number.isFinite(rawDepth) && rawDepth > 0, lengthM, invertStartM, invertEndM, points, slope: derivedSlope, conditionScore: String(p.status || '').toLowerCase().includes('good') ? .8 : .65, upstreamLevelRatio: liveInputs.levelRatios?.[p.objectid]?.upstream ?? 0, downstreamLevelRatio: liveInputs.levelRatios?.[p.objectid]?.downstream ?? 0, velocityMs: liveInputs.velocityMs?.[p.objectid] ?? .45, suspendedSolidsNtu: liveInputs.suspendedSolidsNtu?.[p.objectid] ?? 0, elevationPercentile: liveInputs.elevationPercentiles?.[p.objectid] ?? .5, historicalFloodFrequency: liveInputs.historicalFloodFrequency?.[p.objectid] ?? 0, hasLevelSensor: Boolean(liveInputs.levelRatios?.[p.objectid]), hasVelocitySensor: Boolean(liveInputs.velocityMs?.[p.objectid]) };
  });
  const graph = buildDrainGraph(segments);
  const predictions = predictDrainageNetwork({ segments, context: { rainfallMmHr: rainfall.mmHr, rainfallSourceFresh: rainfall.fresh, reportsBySegment, newsBySegment: liveInputs.newsBySegment || {} } });
  const validDrains = segments.filter((segment) => segment.widthObserved && segment.depthObserved && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM) && segment.lengthM > 0);
  const snappedDrain = liveInputs.selectedPoint ? nearestDrainToPoint(validDrains, latitude, longitude) : null;
  const representativeDrain = snappedDrain || validDrains.sort((a, b) => (a.widthM * a.depthM) - (b.widthM * b.depthM))[0] || {};
  const surfaceInputs = liveInputs.surfaceInputs || {};
  const swmm = await runSwmmPrototype({ projectRoot: __dirname, runDirectory: path.join(app.getPath('userData'), 'swmm-runs'), rainMmHr: rainfall.mmHr, representativeDrain, surfaceInputs });
  swmm.representativeDrain = representativeDrain.id ? { id: representativeDrain.id, label: representativeDrain.label, widthM: representativeDrain.widthM, depthM: representativeDrain.depthM, lengthM: representativeDrain.lengthM, slope: representativeDrain.slope, snappedDistanceM: representativeDrain.snappedDistanceM ?? null, topology: representativeDrain.topology } : null;
  dataSources.push({ name: 'Hydraulic solver', state: swmm.solved ? 'modelled' : 'blocked', detail: swmm.solved ? `${swmm.engine}: observed GIS geometry + inverts + rain; ${swmm.audit.assumptions.length} assumptions exposed` : `EPA SWMM blocked: ${swmm.error || 'unknown error'}`, fetchedAt: new Date().toISOString() });
  if (swmm.solved) for (const prediction of predictions) prediction.swmm = { engine: swmm.engine, mode: swmm.mode, maxFloodVolumeM3: swmm.maxFloodVolumeM3 };
  const decision = buildOperationalDecision({ rainfall, reports, predictions });
  return { source: 'Greater Chennai Corporation Storm Water Drain GIS', fetchedAt: new Date().toISOString(), drainCount: features.length, geojson: { type: 'FeatureCollection', features }, segments, graph, calibration, predictions, reports, rainfall, elevation, newsSignals, dataSources, decision, swmm, snappedDrain: swmm.representativeDrain, focus: { latitude, longitude, label: liveInputs.area?.label || 'Velachery / Pallikaranai' }, readiness: rainfall.fresh ? 'rain-feed-ready' : 'insufficient-live-inputs', missing: [!rainfall.fresh && 'fresh rainfall forcing', !reports.length && 'a verified field report or water-level sensor'].filter(Boolean) };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: '#e8ede7',
    title: 'cFLOWS — Chennai Flood Twin',
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, 'preload.js') }
  });
  window.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  ipcMain.handle('hydrograph:run-pilot', async (_event, liveInputs = {}) => {
    latestPilotRun = await buildPilotRun(liveInputs);
    return latestPilotRun;
  });
  ipcMain.handle('hydrograph:simulate-scenario', async (_event, input = {}) => {
    const rainfallMmHr = Math.max(0, Math.min(250, Number(input.rainfallMmHr) || 0));
    const latitude = Number(input.latitude), longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Select a location on the scenario map first.');
    const area = { latitude, longitude, label: input.label || 'selected scenario point' };
    let runoff = { source: 'OpenStreetMap runoff proxy unavailable', buildings: 0, roads: 0, imperviousPct: 70, fresh: false };
    try { runoff = await fetchOsmRunoffProxy({ latitude, longitude }); } catch { /* conservative fallback is disclosed */ }
    const run = await buildPilotRun({ area, selectedPoint: true, rainfallMmHr, rainfallSourceFresh: false, surfaceInputs: { imperviousPct: runoff.imperviousPct, catchmentAreaHa: .45 } });
    const selectedRisk = run.predictions.find((prediction) => prediction.id === run.snappedDrain?.id) || run.predictions[0];
    const risk = selectedRisk?.floodProbability || 0;
    const localNetwork = inferLocalDrainNetwork(run.segments || [], run.segments?.find((segment) => segment.id === run.snappedDrain?.id));
    const selectedSegment = run.segments.find((segment) => segment.id === run.snappedDrain?.id);
    const networkIds = new Set([selectedSegment?.id, ...localNetwork.map((segment) => segment.id)].filter(Boolean));
    const completeNetworkLinks = run.segments.filter((segment) => networkIds.has(segment.id) && segment.widthObserved && segment.depthObserved && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM));
    const networkSwmm = await runSwmmNetwork({ projectRoot: __dirname, runDirectory: path.join(app.getPath('userData'), 'swmm-runs'), rainMmHr, segments: completeNetworkLinks, surfaceInputs: { imperviousPct: runoff.imperviousPct, catchmentAreaHa: .45 } });
    const surface = simulateSurfaceSpill({ rainfallMmHr, imperviousPct: runoff.imperviousPct, catchmentAreaHa: .45, elevationM: run.elevation?.elevationM, drainageRisk: risk, swmm: networkSwmm.solved ? networkSwmm : run.swmm, topologyConfidence: selectedSegment?.topology?.confidence || 0, calibration: run.calibration });
    let raster = null;
    try {
      const elevationGrid = await fetchOpenElevationGrid({ latitude, longitude });
      const terrain = makeRaster({ latitude, longitude, elevationSamples: elevationGrid.samples });
      raster = { ...runRasterSpill({ raster: terrain, rainfallMmHr, imperviousPct: runoff.imperviousPct, drainRemovalMmHr: surface.drainRemovalMmHr }), elevationSource: elevationGrid.source };
    } catch (error) { raster = { status: 'blocked-elevation-grid-unavailable', error: error.message }; }
    let streetPhoto = { available: false, source: 'KartaView public street imagery' };
    try { streetPhoto = await fetchKartaViewStreetPhoto({ latitude, longitude }); } catch { /* projection remains available without imagery */ }
    const scenario = { rainfallMmHr, surface, raster, networkSwmm, modelScope: 'Chennai citywide on-demand micro-twin', basis: 'Tier 1: local multi-drain SWMM experiment. Tier 2: deterministic surface-spill raster using sparse public elevation samples.', selectedDrain: run.snappedDrain, localNetwork, runoff, streetPhoto, disclaimer: surface.disclaimer };
    const saved = await saveScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), { location: area, scenario: { rainfallMmHr, surface, raster: { status: raster.status, stats: raster.stats, elevationSource: raster.elevationSource }, networkSwmm: { solved: networkSwmm.solved, mode: networkSwmm.mode, linksModelled: networkSwmm.linksModelled, maxFloodVolumeM3: networkSwmm.maxFloodVolumeM3 } }, calibration: run.calibration });
    return { ...run, scenario: { ...scenario, runId: saved.id } };
  });
  ipcMain.handle('hydrograph:calibration-status', async () => getCalibrationSnapshot());
  ipcMain.handle('hydrograph:list-scenario-runs', async () => listScenarioRuns(path.join(app.getPath('userData'), 'scenario-runs')));
  ipcMain.handle('hydrograph:inspect-scenario-point', async (_event, { raster, latitude, longitude } = {}) => {
    if (!raster?.raster || !Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Run a terrain raster scenario, then select a map point.');
    return inspectRasterPoint(raster, latitude, longitude);
  });
  ipcMain.handle('hydrograph:add-field-report', async (_event, report) => addReport(report));
  ipcMain.handle('hydrograph:list-field-reports', async () => readReports());
  ipcMain.handle('hydrograph:ask', async (_event, question) => {
    const run = await buildPilotRun();
    const evidence = evidencePacket(run);
    const answer = await askNarrator({ projectRoot: __dirname, question, evidence });
    return { answer, decision: run.decision, evidence };
  });
  ipcMain.handle('hydrograph:converse', async (_event, message) => {
    const report = parseNaturalReport(message);
    if (report?.needsLocation) return { answer: 'I can record that. Tell me the nearest road, junction or landmark in Chennai—for example, “knee-high water near Taramani Link Road.”', action: 'need-location' };
    if (report?.needsDepth) return { answer: 'I can record that. Say whether the water is ankle-high, knee-high or wheel-high, and include the nearest road or landmark.', action: 'need-depth' };
    let savedReport = null;
    try {
      if (report?.location) {
        const point = await geocodeChennai(report.location);
        savedReport = await addReport({ latitude: point.latitude, longitude: point.longitude, depthM: report.depthM });
      }
    } catch (error) {
      return { answer: `I could not match that place in Chennai: ${error.message} Try the nearest road, junction or landmark.`, action: 'place-not-found' };
    }
    let run;
    try {
      // Questions should feel immediate. Reuse the most recent live snapshot
      // for 90 seconds; a report always triggers a fresh assessment.
      const requestedPlace = savedReport ? null : extractPlace(message);
      let area = null;
      if (requestedPlace) {
        try { area = await geocodeChennai(requestedPlace); }
        catch { /* The LLM can still answer a general question about the place. */ }
      }
      const isFresh = latestPilotRun && Date.now() - new Date(latestPilotRun.fetchedAt).getTime() < 90 * 1000;
      run = savedReport || area || !isFresh ? await buildPilotRun({ area }) : latestPilotRun;
      latestPilotRun = run;
    } catch (error) {
      return { answer: `I cannot refresh the evidence right now because ${error.message}. I will not guess at flood risk—try “Refresh live evidence” in a moment.`, action: 'evidence-unavailable' };
    }
    const question = savedReport ? `A resident reported ${Math.round(savedReport.depthM * 100)} cm of water near ${report.location}. Explain the updated decision plainly and name the next action.` : message;
    let answer;
    try { answer = await askNarrator({ projectRoot: __dirname, question, evidence: evidencePacket(run) }); }
    catch { answer = plainFallback(run); }
    return { answer, action: savedReport ? 'report-recorded' : 'answered', savedReport, decision: run.decision, run };
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
