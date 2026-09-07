const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs/promises');

// Load project-local runtime configuration without overriding environment
// variables supplied by the deployment/service manager.
try {
  const runtimeEnv = fsSync.readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of runtimeEnv.split(/\r?\n/)) {
    if (!/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)) continue;
    const index = line.indexOf('='); const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
    if (process.env[key] == null) process.env[key] = value;
  }
} catch { /* .env is optional */ }
const { fetchGccDrainsForEnvelope, fetchOpenMeteoRainfall, fetchCfmForecastRuns, fetchChennaiMarineBoundary, fetchOpenElevation, fetchOpenElevationGrid, fetchTerrariumElevationGrid, fetchGdeltFloodSignals, fetchGoogleNewsFloodSignals, geocodeChennai, fetchKartaViewStreetPhoto, fetchOsmRunoffProxy } = require('./src/data/sources');
const { predictDrainageNetwork, isFloodNews } = require('./src/core/hydrograph');
const { runSwmmPrototype, runSwmmNetwork } = require('./src/core/swmm');
const { buildDrainGraph } = require('./src/core/drain-graph');
const { simulateSurfaceSpill } = require('./src/core/surface-spill');
const { loadCalibrationInputs, buildHistoricalReplay } = require('./src/core/calibration');
const { makeRaster, runRasterSpill, inspectRasterPoint, summarizeRasterPooling } = require('./src/core/raster-spill');
const { buildSpatialSurfaceFields } = require('./src/core/spatial-surface');
const { runSurfaceEnsemble } = require('./src/core/surface-ensemble');
const { saveScenarioRun, listScenarioRuns, renameScenarioRun, duplicateScenarioRun, deleteScenarioRun, importScenarioRun } = require('./src/core/run-store');
const { getDataStackStatus, estimateOvertureImperviousness } = require('./src/data/data-stack');
const { buildRainfallProfile } = require('./src/core/rainfall-profile');
const { assessInfrastructureImpact } = require('./src/core/impact');
const { buildOperationalDecision } = require('./src/core/decision');
const { evidencePacket, askNarrator } = require('./src/core/narrator');
const { resolveChennaiContext } = require('./src/core/chennai-context');
const { getHistoricalEvidenceRegistry } = require('./src/data/historical-evidence');
const { loadSensorSnapshot } = require('./src/data/sensor-feed');
const { loadLocalElevationGrid } = require('./src/data/local-terrain');
const { normalizeGccDrainProperties } = require('./src/data/gcc-drains');
const { loadDownstreamBoundary } = require('./src/data/downstream-boundary');
let latestPilotRun = null;
let calibrationSnapshot = null;
let calibrationInputsCache = null;
let reportWriteQueue = Promise.resolve();
let sourceCacheWriteQueue = Promise.resolve();

// Keep profile and Chromium session data beside the project. `sessionData`
// must be set before app readiness or Chromium falls back to a policy-locked
// profile cache on this host.
const localProfile = path.join(__dirname, '.electron-data');
const localSession = path.join(localProfile, 'session');
fsSync.mkdirSync(localSession, { recursive: true });
app.setPath('userData', localProfile);
app.setPath('sessionData', localSession);

const reportPath = () => path.join(app.getPath('userData'), 'field-reports.json');
const drainCachePath = () => path.join(app.getPath('userData'), 'gcc-drain-cache.json');
const sourceCachePath = () => path.join(app.getPath('userData'), 'public-source-cache.json');
const CHENNAI_BOUNDS = { south: 12.72, north: 13.36, west: 79.95, east: 80.42 };
const SURFACE_DOMAIN_RADIUS_M = 480;

async function readSourceCache() {
  try { return JSON.parse(await fs.readFile(sourceCachePath(), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? {} : Promise.reject(error); }
}
async function writeSourceCache(cache) {
  const target = sourceCachePath(); const temp = `${target}.tmp`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(temp, JSON.stringify(cache, null, 2));
  await fs.rename(temp, target);
}
async function withSourceCache(key, fetcher, { maxAgeMs = Infinity, staleAllowed = true } = {}) {
  const cache = await readSourceCache();
  try {
    const value = await fetcher();
    const cachedAt = new Date().toISOString();
    const write = async () => { const latest = await readSourceCache(); latest[key] = { cachedAt, value }; await writeSourceCache(latest); };
    const queued = sourceCacheWriteQueue.then(write, write);
    sourceCacheWriteQueue = queued.then(() => undefined, () => undefined);
    await queued.catch(() => {});
    return { ...value, cacheState: 'live' };
  } catch (error) {
    const cached = cache[key];
    const ageMs = cached?.cachedAt ? Date.now() - new Date(cached.cachedAt).getTime() : Infinity;
    if (staleAllowed && cached?.value && ageMs <= maxAgeMs) return { ...cached.value, fresh: false, cacheState: 'cached', cacheAgeMs: ageMs, cacheError: error.message };
    throw error;
  }
}
async function readDrainCache() {
  try { return JSON.parse(await fs.readFile(drainCachePath(), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? null : Promise.reject(error); }
}
async function writeDrainCache(geojson) {
  try { await fs.writeFile(drainCachePath(), JSON.stringify({ cachedAt: new Date().toISOString(), geojson })); } catch { /* cache is an optional resilience layer */ }
}
async function readLocalReports() {
  try { return JSON.parse(await fs.readFile(reportPath(), 'utf8')); } catch (error) { return error.code === 'ENOENT' ? [] : Promise.reject(error); }
}
function syncBaseUrl() { return String(process.env.CFLOWS_SYNC_URL || '').replace(/\/$/, ''); }
function syncHeaders(extra = {}) { return { ...(process.env.CFLOWS_SYNC_TOKEN ? { Authorization: `Bearer ${process.env.CFLOWS_SYNC_TOKEN}` } : {}), ...extra }; }
async function readReports() {
  const baseUrl = syncBaseUrl();
  if (!baseUrl) return readLocalReports();
  const response = await fetch(`${baseUrl}/reports`, { headers: syncHeaders({ Accept: 'application/json' }), signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error(`Shared report service returned ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.reports) ? payload.reports : [];
}
async function addReport(input) {
  const latitude = Number(input.latitude), longitude = Number(input.longitude), depthM = Number(input.depthM);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(depthM) || depthM < 0 || depthM > 3) throw new Error('Report must include a valid location and water depth.');
  if (latitude < CHENNAI_BOUNDS.south || latitude > CHENNAI_BOUNDS.north || longitude < CHENNAI_BOUNDS.west || longitude > CHENNAI_BOUNDS.east) throw new Error('Field reports are accepted only inside the Chennai pilot boundary.');
  const baseUrl = syncBaseUrl();
  if (baseUrl) {
    const response = await fetch(`${baseUrl}/reports`, { method: 'POST', headers: syncHeaders({ 'content-type': 'application/json', Accept: 'application/json' }), body: JSON.stringify({ latitude, longitude, depthM }), signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Shared report service rejected the report: ${payload.error || response.status}`);
    return payload.report;
  }
  const operation = async () => {
    const reports = await readLocalReports(); const now = Date.now();
    const duplicate = reports.find((candidate) => {
      const age = now - new Date(candidate.timestamp).getTime();
      const metres = Math.hypot((candidate.longitude - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (candidate.latitude - latitude) * 110540);
      return age >= 0 && age < 5 * 60 * 1000 && metres < 25 && Math.abs(Number(candidate.depthM) - depthM) < .08;
    });
    if (duplicate) return { ...duplicate, duplicateSuppressed: true };
    const report = {
      id: `field-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      latitude, longitude, depthM,
      confidence: .35,
      source: 'unverified citizen field report',
      verificationState: 'unverified',
      timestamp: new Date().toISOString(),
    };
    reports.push(report);
    const target = reportPath(), temp = `${target}.tmp`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(temp, JSON.stringify(reports.slice(-500), null, 2));
    await fs.rename(temp, target);
    return report;
  };
  const next = reportWriteQueue.then(operation, operation);
  reportWriteQueue = next.then(() => undefined, () => undefined);
  return next;
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
  if (!selected) return [];
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const selectedIds = new Set(selected.topology?.geometryDownstreamIds || []);
  for (const segment of segments) if ((segment.topology?.geometryDownstreamIds || []).includes(selected.id)) selectedIds.add(segment.id);
  const firstHop = [...selectedIds];
  for (const id of firstHop) for (const next of byId.get(id)?.topology?.geometryDownstreamIds || []) selectedIds.add(next);
  return [...selectedIds].map((id) => byId.get(id)).filter(Boolean).slice(0, 8).map((segment) => ({
    id: segment.id, label: segment.label, slope: segment.slope, widthM: segment.widthM, depthM: segment.depthM,
    topologyBasis: segment.topology?.propagationBasis || 'coincident-public-endpoints',
  }));
}
function deriveTerrainContext(samples, latitude, longitude) {
  const usable = (samples || []).filter((sample) => Number.isFinite(sample.elevationM));
  if (usable.length < 9) return null;
  const centre = usable.reduce((closest, sample) => Math.hypot(sample.latitude - latitude, sample.longitude - longitude) < Math.hypot(closest.latitude - latitude, closest.longitude - longitude) ? sample : closest);
  const elevations = usable.map((sample) => sample.elevationM);
  const mean = elevations.reduce((sum, elevation) => sum + elevation, 0) / elevations.length;
  return { elevationM: centre.elevationM, depressionM: Math.max(0, mean - centre.elevationM), reliefM: Math.max(...elevations) - Math.min(...elevations), sampleCount: usable.length };
}

function historicalFrequencyAtSegment(segment, labels = []) {
  const points = segment?.points || [];
  if (!points.length) return { value: 0, observed: false, sampleCount: 0 };
  const midpoint = points[Math.floor(points.length / 2)];
  const nearby = labels.filter((row) => {
    const latitude = Number(row.latitude), longitude = Number(row.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return false;
    const metres = Math.hypot((longitude - midpoint[0]) * 111320 * Math.cos(latitude * Math.PI / 180), (latitude - midpoint[1]) * 110540);
    return metres <= 300;
  });
  if (!nearby.length) return { value: 0, observed: false, sampleCount: 0 };
  const flooded = nearby.filter((row) => /true|yes|1/i.test(String(row.observed_flooded ?? row.flooded ?? ''))).length;
  return { value: flooded / nearby.length, observed: true, sampleCount: nearby.length };
}

function mapNewsToSegments(newsSignals, segments) {
  const output = {};
  for (const segment of segments) {
    const tokens = String(segment.label || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 5).slice(0, 4);
    const matched = (newsSignals || []).filter((signal) => {
      if (!signal.floodRelated || !signal.locationMatched) return false;
      const text = String(signal.title || '').toLowerCase();
      return tokens.length && tokens.some((token) => text.includes(token));
    });
    if (matched.length) output[segment.id] = matched;
  }
  return output;
}

function catchmentPriorForSegment(segment) {
  const lengthM = Number(segment?.lengthM);
  if (!Number.isFinite(lengthM) || lengthM <= 0) return { midpointHa: .45, rangeHa: [.20, .90], source: 'bounded catchment prior; no delineated catchment available' };
  const midpointHa = Math.max(.12, Math.min(1.5, lengthM * 55 / 10000));
  return { midpointHa, rangeHa: [Math.max(.08, midpointHa * .45), Math.min(3, midpointHa * 1.9)], source: 'bounded reach-length catchment prior; not a surveyed catchment boundary' };
}
function catchmentPriorForNetwork(segments = []) {
  const priors = segments.map(catchmentPriorForSegment);
  if (!priors.length) return { midpointHa: 0, rangeHa: [0, 0], bySegment: {}, source: 'no hydraulically local links available for catchment assignment' };
  const bySegment = Object.fromEntries(segments.map((segment, index) => [segment.id, priors[index].midpointHa]));
  return {
    midpointHa: priors.reduce((sum, prior) => sum + prior.midpointHa, 0),
    rangeHa: [priors.reduce((sum, prior) => sum + prior.rangeHa[0], 0), priors.reduce((sum, prior) => sum + prior.rangeHa[1], 0)],
    bySegment,
    source: 'sum of per-reach bounded catchment priors; still not a surveyed/delineated catchment',
  };
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
  return result.status === 'fulfilled'
    ? { name, state: result.value.cacheState === 'cached' ? 'cached' : 'live', detail: result.value.cacheState === 'cached' ? `${detail} · cached fallback` : detail, fetchedAt: result.value.fetchedAt || result.value.cachedAt || new Date().toISOString() }
    : { name, state: 'unavailable', detail: result.reason?.message || detail };
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
    sentinelLabelsPath: path.join(__dirname, 'data', 'calibration', 'sentinel-flood-labels.geojson'),
  });
  calibrationInputsCache = inputs;
  calibrationSnapshot = buildHistoricalReplay(inputs);
  return calibrationSnapshot;
}
async function buildPilotRun(liveInputs = {}) {
  // Bounded pilot envelope: Velachery → Pallikaranai. The GIS service is the
  // authoritative geometry source; missing live observations stay missing.
  const latitude = Number(liveInputs.area?.latitude || 12.9768), longitude = Number(liveInputs.area?.longitude || 80.2205);
  let drains, drainFeed;
  try {
    drains = await fetchGccDrainsForEnvelope({ west: longitude - .025, south: latitude - .027, east: longitude + .025, north: latitude + .027 });
    await writeDrainCache(drains); drainFeed = { state: 'live', detail: 'Public GCC GIS query completed' };
  } catch (error) {
    const cached = await readDrainCache();
    if (cached?.geojson?.features?.length) { drains = cached.geojson; drainFeed = { state: 'cached', detail: `GCC GIS unavailable; using locally cached geometry from ${new Date(cached.cachedAt).toLocaleString()}` }; }
    else { drains = { type: 'FeatureCollection', features: [] }; drainFeed = { state: 'unavailable', detail: `GCC GIS unavailable; no local cache: ${error.message}` }; }
  }
  const features = (drains.features || []).slice(0, 2000);
  const reports = await readReports();
  const sensorSnapshot = await loadSensorSnapshot(__dirname);
  const reportsBySegment = reports.reduce((grouped, report) => {
    const id = nearestSegmentId(report, features); if (id) (grouped[id] ||= []).push(report); return grouped;
  }, {});
  let rainfall = { source: 'manual input', mmHr: Number(liveInputs.rainfallMmHr || 0), fresh: Boolean(liveInputs.rainfallSourceFresh), observedAt: null, forecast: [] };
  if (!Number.isFinite(Number(liveInputs.rainfallMmHr))) {
    try {
      rainfall = await withSourceCache(`rain:${latitude.toFixed(3)}:${longitude.toFixed(3)}`, () => fetchOpenMeteoRainfall({ latitude, longitude }), { maxAgeMs: 6 * 60 * 60 * 1000 });
      if (rainfall.cacheState === 'cached') rainfall = { ...rainfall, fresh: false, source: `${rainfall.source} · cached fallback` };
    } catch (error) { rainfall = { source: 'rainfall feed unavailable', mmHr: 0, fresh: false, error: error.message }; }
  }
  const [elevationResult, newsResult, calibrationResult, cfmResult, marineResult, downstreamBoundaryResult] = await Promise.allSettled([
    withSourceCache(`elevation:${latitude.toFixed(4)}:${longitude.toFixed(4)}`, () => fetchOpenElevation({ latitude, longitude }), { maxAgeMs: 180 * 24 * 60 * 60 * 1000 }),
    withSourceCache(`news:${String(liveInputs.area?.label || 'Chennai').toLowerCase()}`, () => fetchNewsSignals(`${liveInputs.area?.label || 'Chennai'} flood OR waterlogging`).then((items) => ({ items, fetchedAt: new Date().toISOString() })), { maxAgeMs: 6 * 60 * 60 * 1000 }),
    getCalibrationSnapshot(),
    withSourceCache('cfm-runs', fetchCfmForecastRuns, { maxAgeMs: 12 * 60 * 60 * 1000 }),
    withSourceCache('marine-boundary', fetchChennaiMarineBoundary, { maxAgeMs: 6 * 60 * 60 * 1000 }),
    loadDownstreamBoundary(__dirname, 'live'),
  ]);
  const elevation = elevationResult.status === 'fulfilled' ? elevationResult.value : null;
  const newsSignals = newsResult.status === 'fulfilled' ? (newsResult.value.items || []).map((item) => isFloodNews(item)) : [];
  const calibration = calibrationResult.status === 'fulfilled' ? calibrationResult.value : { status: 'unavailable', labelCount: 0, isCalibrated: false, missing: ['calibration data could not be loaded'] };
  const historicalEvidence = getHistoricalEvidenceRegistry();
  const cfm = cfmResult.status === 'fulfilled' ? cfmResult.value : null;
  const marineBoundary = marineResult.status === 'fulfilled' ? marineResult.value : null;
  const downstreamBoundary = downstreamBoundaryResult.status === 'fulfilled'
    ? downstreamBoundaryResult.value
    : { available: false, state: 'invalid', eventId: 'live', detail: downstreamBoundaryResult.reason?.message || 'Downstream boundary loader failed' };
  const cityContext = resolveChennaiContext({ latitude, longitude, marineBoundary });
  const dataStack = await getDataStackStatus(__dirname);
  const dataSources = [
    { name: 'GCC storm-water drain GIS', state: drainFeed.state, detail: `${features.length} mapped drain features · ${drainFeed.detail}`, fetchedAt: drainFeed.state === 'live' ? new Date().toISOString() : null },
    { name: 'Current rain + 6-hour forecast', state: rainfall.fresh ? 'live' : rainfall.cacheState === 'cached' ? 'cached' : 'unavailable', detail: rainfall.source, fetchedAt: rainfall.fetchedAt || null },
    { name: 'Tamil Nadu CFM-DSS forecast run', state: cfm ? (cfm.cacheState === 'cached' ? 'cached' : 'live') : 'unavailable', detail: cfm ? `${cfm.latestRun.datetime} ${cfm.latestRun.run} · values remain access-controlled by the public portal` : (cfmResult.reason?.message || 'CFM run catalogue unavailable'), fetchedAt: cfm?.fetchedAt || null },
    sourceStatus('Terrain elevation', elevationResult, elevation ? `${elevation.elevationM} m at map focus` : 'Terrain sample unavailable'),
    sourceStatus('Flood and waterlogging news', newsResult, newsSignals.length ? `${newsSignals.length} recent signals; corroboration only` : 'No recent signals'),
    { name: 'Field reports', state: reports.some((report) => report.verificationState === 'verified') ? 'verified-evidence' : reports.length ? 'unverified-only' : 'waiting', detail: reports.length ? `${reports.length} ${syncBaseUrl() ? 'shared' : 'local'} report(s); ${reports.filter((report) => report.verificationState === 'verified').length} verified` : `No field report yet · ${syncBaseUrl() ? 'shared sync service' : 'local desktop store'}` },
    { name: 'Water-level / velocity sensors', state: sensorSnapshot.state, detail: sensorSnapshot.detail },
    { name: 'Offshore sea-level context', state: marineBoundary ? (marineBoundary.cacheState === 'cached' ? 'cached-model' : 'modelled') : 'unavailable', detail: marineBoundary ? `${marineBoundary.outfallRestriction} offshore boundary · ${marineBoundary.restriction}` : (marineResult.reason?.message || 'Marine boundary unavailable') },
    { name: 'Hydraulic downstream stage boundary', state: downstreamBoundary.available ? downstreamBoundary.state : downstreamBoundary.state || 'integration-needed', detail: downstreamBoundary.available ? `${downstreamBoundary.source}${downstreamBoundary.datum ? ` · datum ${downstreamBoundary.datum}` : ''}` : downstreamBoundary.detail },
    { name: 'Historic inundation labels', state: (calibrationInputsCache?.labelRows || []).length ? 'ready' : 'integration-needed', detail: (calibrationInputsCache?.labelRows || []).length ? `${calibrationInputsCache.labelRows.length} imported observation row(s); calibration gate still applies` : 'Import NRSC/municipal historical flood labels to calibrate' },
    { name: 'NRSC/ISRO Chennai flood archive', state: 'evidence-ready', detail: `${historicalEvidence.events.length} official event/prior layers registered; ${historicalEvidence.usableLabelCount} georeferenced calibration labels`, fetchedAt: null },
    { name: 'Historical calibration gate', state: calibration.isCalibrated ? 'validated' : 'blocked', detail: calibration.conclusion || 'Calibration evidence unavailable' },
    ...dataStack.sources.map((source) => ({ name: source.name, state: source.state, detail: `${source.resolution} · ${source.access}` })),
  ];
  const segments = features.map((feature) => {
    const p = feature.properties || {};
    const dimensions = normalizeGccDrainProperties(p);
    const number = (value, fallback) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    };
    const lengthM = lineLengthM(feature.geometry), invertStartM = Number.parseFloat(p.invert_sp), invertEndM = Number.parseFloat(p.invert_ep);
    const points = feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates.flat() : feature.geometry?.coordinates || [];
    const derivedSlope = Number.isFinite(invertStartM) && Number.isFinite(invertEndM) && lengthM > 0 ? Math.max(.00005, Math.abs(invertStartM - invertEndM) / lengthM) : .001;
    const history = historicalFrequencyAtSegment({ points }, calibrationInputsCache?.labelRows || []);
    const sensor = sensorSnapshot.bySegment?.[`gcc-${p.objectid}`] || {};
    const upstreamLevelRatio = liveInputs.levelRatios?.[p.objectid]?.upstream ?? sensor.upstreamLevelRatio ?? 0;
    const downstreamLevelRatio = liveInputs.levelRatios?.[p.objectid]?.downstream ?? sensor.downstreamLevelRatio ?? 0;
    const velocityMs = liveInputs.velocityMs?.[p.objectid] ?? sensor.velocityMs ?? .45;
    const suspendedSolidsNtu = liveInputs.suspendedSolidsNtu?.[p.objectid] ?? sensor.suspendedSolidsNtu ?? 0;
    const liveSensorCredit = sensorSnapshot.fresh && Boolean(sensorSnapshot.bySegment?.[`gcc-${p.objectid}`]);
    return { id: `gcc-${p.objectid}`, label: p.location || 'the closest mapped drain', widthM: dimensions.widthM || .6, depthM: dimensions.depthM || .75, widthObserved: dimensions.widthObserved, depthObserved: dimensions.depthObserved, rawWidthM: dimensions.rawWidthM, rawDepthM: dimensions.rawDepthM, drainSize: dimensions.drainSize, dimensionSource: dimensions.dimensionSource, dimensionConflict: dimensions.dimensionConflict, dimensionWarnings: dimensions.warnings, closed: dimensions.closed, crossSectionShape: dimensions.crossSectionShape, enclosureSource: dimensions.enclosureSource, lengthM, invertStartM, invertEndM, points, slope: derivedSlope, conditionScore: String(p.status || '').toLowerCase().includes('good') ? .8 : .65, upstreamLevelRatio, downstreamLevelRatio, velocityMs, suspendedSolidsNtu, elevationPercentile: liveInputs.elevationPercentiles?.[p.objectid] ?? .5, historicalFloodFrequency: liveInputs.historicalFloodFrequency?.[p.objectid] ?? history.value, historyObserved: liveInputs.historicalFloodFrequency?.[p.objectid] != null || history.observed, historicalSampleCount: history.sampleCount, hasLevelSensor: Boolean(liveInputs.levelRatios?.[p.objectid]) || (liveSensorCredit && sensor.upstreamLevelRatio != null && sensor.downstreamLevelRatio != null), hasVelocitySensor: Boolean(liveInputs.velocityMs?.[p.objectid]) || (liveSensorCredit && sensor.velocityMs != null), sensorSource: liveSensorCredit ? sensor.source : null };
  });
  const dimensionConflicts = segments.filter((segment) => segment.dimensionConflict).length;
  const dimensionAmbiguous = segments.filter((segment) => !segment.widthObserved || !segment.depthObserved).length;
  dataSources.push({ name: 'Drain dimension audit', state: dimensionAmbiguous ? 'partial' : 'ready', detail: `${dimensionConflicts} GCC raw-field conflict(s) corrected from drain_size; ${dimensionAmbiguous} feature(s) withheld from hydraulics because dimensions are incomplete/ambiguous` });
  const graph = buildDrainGraph(segments);
  const mappedNews = mapNewsToSegments(newsSignals, segments);
  const predictions = predictDrainageNetwork({ segments, context: { rainfallMmHr: rainfall.mmHr, rainfallSourceFresh: rainfall.fresh, reportsBySegment, newsBySegment: liveInputs.newsBySegment || mappedNews } });
  const validDrains = segments.filter((segment) => segment.widthObserved && segment.depthObserved && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM) && segment.lengthM > 0);
  const snappedDrain = liveInputs.selectedPoint ? nearestDrainToPoint(validDrains, latitude, longitude) : null;
  const representativeDrain = snappedDrain || validDrains.sort((a, b) => (a.widthM * a.depthM) - (b.widthM * b.depthM))[0] || {};
  const catchmentPrior = catchmentPriorForSegment(representativeDrain);
  const surfaceInputs = {
    ...(liveInputs.surfaceInputs || {}),
    catchmentAreaHa: Number.isFinite(Number(liveInputs.surfaceInputs?.catchmentAreaHa)) ? Number(liveInputs.surfaceInputs.catchmentAreaHa) : catchmentPrior.midpointHa,
    outfallBoundary: downstreamBoundary.available ? downstreamBoundary.boundary : null,
  };
  const swmm = await runSwmmPrototype({ projectRoot: __dirname, runDirectory: path.join(app.getPath('userData'), 'swmm-runs'), rainMmHr: rainfall.mmHr, representativeDrain, surfaceInputs });
  if (swmm.audit && !Number.isFinite(Number(liveInputs.surfaceInputs?.catchmentAreaHa))) swmm.audit.assumptions.push(catchmentPrior.source);
  swmm.representativeDrain = representativeDrain.id ? { id: representativeDrain.id, label: representativeDrain.label, widthM: representativeDrain.widthM, depthM: representativeDrain.depthM, lengthM: representativeDrain.lengthM, slope: representativeDrain.slope, snappedDistanceM: representativeDrain.snappedDistanceM ?? null, topology: representativeDrain.topology } : null;
  dataSources.push({ name: 'Hydraulic solver', state: swmm.solved ? 'modelled' : 'blocked', detail: swmm.solved ? `${swmm.engine}: observed GIS geometry + inverts + rain; ${swmm.audit.assumptions.length} assumptions exposed` : `EPA SWMM blocked: ${swmm.error || 'unknown error'}`, fetchedAt: new Date().toISOString() });
  if (swmm.solved) for (const prediction of predictions) prediction.swmm = { engine: swmm.engine, mode: swmm.mode, maxFloodVolumeM3: swmm.maxFloodVolumeM3 };
  const focus = { latitude, longitude, label: liveInputs.area?.label || 'Velachery / Pallikaranai' };
  const decision = buildOperationalDecision({ rainfall, reports, predictions, focus });
  return { source: 'Greater Chennai Corporation Storm Water Drain GIS', fetchedAt: new Date().toISOString(), drainFeed, dataStack, sensorSnapshot: { state: sensorSnapshot.state, fresh: sensorSnapshot.fresh, observedAt: sensorSnapshot.observedAt, detail: sensorSnapshot.detail }, drainCount: features.length, geojson: { type: 'FeatureCollection', features }, segments, graph, calibration, historicalEvidence, cfm, marineBoundary, downstreamBoundary, cityContext, predictions, reports, rainfall, elevation, newsSignals, dataSources, decision, swmm, catchmentPrior, snappedDrain: swmm.representativeDrain, focus, readiness: rainfall.fresh && drainFeed.state !== 'unavailable' ? 'rain-feed-ready' : 'insufficient-live-inputs', missing: [drainFeed.state === 'unavailable' && 'fresh GCC drain geometry', !rainfall.fresh && 'fresh rainfall forcing', !reports.some((report) => report.verificationState === 'verified') && !sensorSnapshot.fresh && 'a verified nearby field report or live water-level sensor'].filter(Boolean) };
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1540,
    height: 980,
    minWidth: 1120,
    minHeight: 760,
    backgroundColor: '#e8ede7',
    title: 'cFLOWS — Chennai Flood Twin',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, allowRunningInsecureContent: false, preload: path.join(__dirname, 'preload.js') }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith('file://')) event.preventDefault(); });
  if (process.env.CFLOWS_SMOKE_TEST === '1') window.webContents.once('did-finish-load', async () => {
    try {
      const bridgeReady = await window.webContents.executeJavaScript("Boolean(window.neer && typeof window.neer.runPilot === 'function' && typeof window.neer.simulateScenario === 'function')");
      console.log(bridgeReady ? 'CFLOWS_SMOKE_OK preload bridge ready' : 'CFLOWS_SMOKE_FAIL preload bridge unavailable');
      app.exit(bridgeReady ? 0 : 2);
    } catch (error) {
      console.error(`CFLOWS_SMOKE_FAIL ${error.message}`); app.exit(3);
    }
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
    const durationMinutes = Math.max(60, Math.min(12 * 60, Math.round(Number(input.durationMinutes) || 120)));
    const rainfallProfile = buildRainfallProfile({ peakMmHr: rainfallMmHr, durationMinutes, profile: input.rainProfile || 'steady' });
    const latitude = Number(input.latitude), longitude = Number(input.longitude);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new Error('Select a location on the scenario map first.');
    const area = { latitude, longitude, label: input.label || 'selected scenario point' };
    let runoff = await estimateOvertureImperviousness({ projectRoot: __dirname, latitude, longitude });
    let osmContext = null;
    try { osmContext = await withSourceCache(`osm-context:${latitude.toFixed(4)}:${longitude.toFixed(4)}`, () => fetchOsmRunoffProxy({ latitude, longitude, radiusM: SURFACE_DOMAIN_RADIUS_M }), { maxAgeMs: 7 * 24 * 60 * 60 * 1000 }); } catch { /* context is optional */ }
    const overtureHasImpervious = runoff?.imperviousPct !== null && runoff?.imperviousPct !== undefined && runoff?.imperviousPct !== '' && Number.isFinite(Number(runoff.imperviousPct));
    if (!runoff || !overtureHasImpervious) {
      runoff = { source: 'bounded imperviousness prior; mapped land-cover source unavailable', buildings: 0, roads: 0, imperviousPct: null, imperviousRangePct: [40, 85], fresh: false };
      const osmHasImpervious = osmContext?.imperviousPct !== null && osmContext?.imperviousPct !== undefined && osmContext?.imperviousPct !== '' && Number.isFinite(Number(osmContext.imperviousPct));
      if (osmHasImpervious) runoff = { ...osmContext, fallbackReason: 'Overture building subset had no usable local imperviousness estimate' };
    }
    if (osmContext && runoff !== osmContext) runoff = { ...runoff, buildingFeatures: osmContext.buildingFeatures || [], roadFeatures: osmContext.roadFeatures || [], facilityFeatures: osmContext.facilityFeatures || [], waterFeatures: osmContext.waterFeatures || [], osmContextSource: osmContext.source };
    const hasImpervious = runoff?.imperviousPct !== null && runoff?.imperviousPct !== undefined && runoff?.imperviousPct !== '' && Number.isFinite(Number(runoff.imperviousPct));
    const assumedImperviousPct = hasImpervious ? Number(runoff.imperviousPct) : (Number(runoff.imperviousRangePct?.[0] || 40) + Number(runoff.imperviousRangePct?.[1] || 85)) / 2;
    const run = await buildPilotRun({ area, selectedPoint: true, rainfallMmHr, rainfallSourceFresh: false, surfaceInputs: { imperviousPct: assumedImperviousPct } });
    const selectedRisk = run.predictions.find((prediction) => prediction.id === run.snappedDrain?.id) || run.predictions[0];
    const risk = selectedRisk?.floodProbability || 0;
    const selectedSegment = run.segments.find((segment) => segment.id === run.snappedDrain?.id);
    const selectedInsideSurfaceDomain = Number(run.snappedDrain?.snappedDistanceM) <= SURFACE_DOMAIN_RADIUS_M;
    const localNetwork = selectedInsideSurfaceDomain ? inferLocalDrainNetwork(run.segments || [], selectedSegment) : [];
    const networkIds = new Set(selectedInsideSurfaceDomain ? [selectedSegment?.id, ...localNetwork.map((segment) => segment.id)].filter(Boolean) : []);
    const completeNetworkLinks = run.segments.filter((segment) => networkIds.has(segment.id) && segment.widthObserved && segment.depthObserved && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM));
    const catchmentPrior = completeNetworkLinks.length ? catchmentPriorForNetwork(completeNetworkLinks) : catchmentPriorForSegment(selectedSegment);
    const downstreamBoundary = run.downstreamBoundary || await loadDownstreamBoundary(__dirname, 'live');
    const networkSwmm = await runSwmmNetwork({ projectRoot: __dirname, runDirectory: path.join(app.getPath('userData'), 'swmm-runs'), rainMmHr: rainfallMmHr, segments: completeNetworkLinks, surfaceInputs: { rainfallSeries: rainfallProfile.series, durationMinutes: rainfallProfile.durationMinutes, imperviousPct: assumedImperviousPct, catchmentAreaHa: catchmentPrior.midpointHa, catchmentAreaBySegment: catchmentPrior.bySegment, outfallBoundary: downstreamBoundary.available ? downstreamBoundary.boundary : null } });
    if (!selectedInsideSurfaceDomain) {
      networkSwmm.mode = 'blocked-drain-outside-surface-domain';
      networkSwmm.error = `Nearest hydraulically complete drain is ${Math.round(Number(run.snappedDrain?.snappedDistanceM) || 0)} m away, outside the ${SURFACE_DOMAIN_RADIUS_M} m terrain domain.`;
    }
    if (networkSwmm.audit) {
      if (!hasImpervious) networkSwmm.audit.assumptions.push(`imperviousness midpoint ${assumedImperviousPct.toFixed(1)}% is used only inside SWMM; surface screening propagates ${runoff.imperviousRangePct?.[0] || 40}–${runoff.imperviousRangePct?.[1] || 85}%`);
      networkSwmm.audit.assumptions.push(catchmentPrior.source);
      if (!downstreamBoundary.available) networkSwmm.audit.assumptions.push(`downstream boundary unavailable: ${downstreamBoundary.detail}`);
    }
    let elevationGrid = null;
    try {
      elevationGrid = await loadLocalElevationGrid(__dirname, { latitude, longitude });
      if (!elevationGrid) {
        try {
          elevationGrid = await withSourceCache(`terrarium-grid:${latitude.toFixed(4)}:${longitude.toFixed(4)}`, () => fetchTerrariumElevationGrid({ latitude, longitude, radiusM: SURFACE_DOMAIN_RADIUS_M, spacingM: 30 }), { maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
        } catch {
          elevationGrid = await withSourceCache(`elevation-grid:${latitude.toFixed(4)}:${longitude.toFixed(4)}`, () => fetchOpenElevationGrid({ latitude, longitude, count: 9 }), { maxAgeMs: 180 * 24 * 60 * 60 * 1000 });
        }
      }
    } catch { /* surface output is withheld below when local terrain is unavailable */ }
    const terrainContext = deriveTerrainContext(elevationGrid?.samples, latitude, longitude);
    const boundaryMultiplier = run.marineBoundary?.capacityMultiplier || 1;
    const drainContext = selectedSegment ? { observed: Boolean(selectedInsideSurfaceDomain && selectedSegment.widthObserved && selectedSegment.depthObserved && Number.isFinite(selectedSegment.invertStartM) && Number.isFinite(selectedSegment.invertEndM)), distanceM: run.snappedDrain?.snappedDistanceM, capacityIndex: selectedSegment.widthM * selectedSegment.depthM * Math.sqrt(Math.max(.00001, selectedSegment.slope || 0)) * boundaryMultiplier, boundaryMultiplier, locality: selectedInsideSurfaceDomain ? 'inside-surface-domain' : 'outside-surface-domain' } : {};
    const surfaceCatchmentRangeHa = selectedInsideSurfaceDomain ? catchmentPrior.rangeHa : [.20, .90];
    const surface = simulateSurfaceSpill({ rainfallMmHr, imperviousPct: runoff.imperviousPct, imperviousRangePct: runoff.imperviousRangePct || (Number.isFinite(Number(runoff.imperviousPct)) ? [runoff.imperviousPct, runoff.imperviousPct] : [40, 85]), catchmentAreaRangeHa: surfaceCatchmentRangeHa, elevationM: terrainContext?.elevationM || run.elevation?.elevationM, drainageRisk: risk, swmm: networkSwmm.solved ? networkSwmm : run.swmm, topologyConfidence: selectedInsideSurfaceDomain ? (selectedSegment?.topology?.confidence || 0) : 0, calibration: run.calibration, terrain: terrainContext || {}, drain: drainContext });
    let raster = null;
    let ensemble = { available: false, state: 'no-raster' };
    let spatialSurface = { stats: { available: false } };
    if (surface.available && elevationGrid) {
      const terrain = makeRaster({ latitude, longitude, elevationSamples: elevationGrid.samples });
      spatialSurface = buildSpatialSurfaceFields({ raster: terrain, runoffContext: runoff, drainSegments: completeNetworkLinks, baseImperviousPct: assumedImperviousPct });
      const trustedInitialObservations = (run.reports || []).filter((report) => {
        if (report.verificationState !== 'verified') return false;
        const ageMs = Date.now() - new Date(report.timestamp).getTime();
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > 2 * 60 * 60 * 1000) return false;
        const metres = Math.hypot((Number(report.longitude) - longitude) * 111320 * Math.cos(latitude * Math.PI / 180), (Number(report.latitude) - latitude) * 110540);
        return metres <= 700;
      }).map((report) => ({ latitude: Number(report.latitude), longitude: Number(report.longitude), depthM: Number(report.depthM), confidence: Number(report.confidence || .8), source: report.source }));
      const baselineRaster = structuredClone(spatialSurface.raster);
      raster = {
        ...runRasterSpill({
          raster: baselineRaster,
          rainfallMmHr,
          rainfallSeries: rainfallProfile.series,
          durationMinutes: rainfallProfile.durationMinutes,
          imperviousPct: assumedImperviousPct,
          drainRemovalMmHr: surface.drainRemovalMmHr,
          drainOverflowM3: networkSwmm.solved ? Number(networkSwmm.totalFloodVolumeM3 || 0) : 0,
          initialObservations: trustedInitialObservations,
        }),
        elevationSource: elevationGrid.source,
        spatialSurface: spatialSurface.stats,
        interpretation: surface.surfaceOnly
          ? 'spatial rain-on-grid pooling screen with local roads/buildings/roughness/infiltration proxies; no local drain capacity credited; sparse public elevations do not support kerb-scale depth accuracy'
          : 'spatial rain-on-grid surface screen with mapped-drain sink distribution and loose SWMM overflow feedback; sparse public elevations do not support kerb-scale depth accuracy',
      };
      ensemble = runSurfaceEnsemble({
        raster: spatialSurface.raster,
        latitude,
        longitude,
        rainfallMmHr,
        rainfallSeries: rainfallProfile.series,
        durationMinutes: rainfallProfile.durationMinutes,
        imperviousPct: assumedImperviousPct,
        drainRemovalMmHr: surface.drainRemovalMmHr,
        drainOverflowM3: networkSwmm.solved ? Number(networkSwmm.totalFloodVolumeM3 || 0) : 0,
        initialObservations: trustedInitialObservations,
      });
    } else raster = { status: 'withheld-missing-location-inputs', error: surface.missing?.join(', ') || 'Elevation grid unavailable' };
    const spatialPooling = raster?.raster ? summarizeRasterPooling(raster, latitude, longitude) : { available: false, state: 'no-raster' };
    if (surface.available && spatialPooling.available) {
      surface.scalarScreen = { centralDepthM: surface.centralDepthM, depthBand: surface.depthBand, depthRangeM: surface.depthRangeM };
      surface.centralDepthM = spatialPooling.selectedDepthM;
      surface.depthBand = spatialPooling.depthBand;
      surface.spatialPooling = spatialPooling;
      surface.severityBasis = 'spatial-raster-distribution';
      if (ensemble.available) {
        surface.singleRunScreen = { centralDepthM: surface.centralDepthM, depthBand: surface.depthBand };
        surface.centralDepthM = ensemble.selectedDepthM.p50;
        surface.depthRangeM = { low: ensemble.selectedDepthM.p10, high: ensemble.selectedDepthM.p90 };
        surface.depthBand = ensemble.consensusBand;
        surface.ensemble = ensemble;
        surface.severityBasis = 'bounded-parameter-ensemble-over-spatial-raster';
      }
    }
    const infrastructureImpact = assessInfrastructureImpact({ rasterRun: raster, roadFeatures: runoff.roadFeatures || [], facilityFeatures: runoff.facilityFeatures || [], waterFeatures: runoff.waterFeatures || [] });
    let streetPhoto = { available: false, source: 'KartaView public street imagery' };
    try { streetPhoto = await fetchKartaViewStreetPhoto({ latitude, longitude }); } catch { /* projection remains available without imagery */ }
    const scenario = { rainfallMmHr, rainfallProfile, durationMinutes: rainfallProfile.durationMinutes, surface, raster, ensemble, spatialSurface: spatialSurface.stats, networkSwmm, catchmentPrior, downstreamBoundary, infrastructureImpact, hydraulicLocality: { radiusM: SURFACE_DOMAIN_RADIUS_M, selectedInsideSurfaceDomain, selectedDistanceM: run.snappedDrain?.snappedDistanceM ?? null }, modelScope: 'Chennai hybrid urban-flood digital-twin prototype', basis: '1D layer: EPA SWMM on hydraulically complete mapped drains. 2D layer: spatial multi-direction Manning rain-on-grid screen with OSM-conditioned runoff/roughness/infiltration, mapped-drain sink distribution, optional SWMM overflow feedback and verified-observation initial-state assimilation. Uncertainty layer: bounded deterministic ensemble. This is not a surveyed kerb-scale 1D/2D production hydraulic model.', selectedDrain: run.snappedDrain, localNetwork, runoff, streetPhoto, cityContext: run.cityContext, marineBoundary: run.marineBoundary, disclaimer: `${surface.disclaimer} ${ensemble.interpretation || ''} ${run.cityContext?.connection || ''}`.trim() };
    const saved = await saveScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), { name: input.name || `${area.label} · ${rainfallProfile.label}`, location: area, scenario: { rainfallMmHr, rainfallProfile, durationMinutes: rainfallProfile.durationMinutes, surface, ensemble: ensemble.available ? { memberCount: ensemble.memberCount, consensusBand: ensemble.consensusBand, selectedDepthM: ensemble.selectedDepthM, exceedance: ensemble.exceedance, neighbourhood: ensemble.neighbourhood, sensitivity: ensemble.sensitivity, interpretation: ensemble.interpretation } : ensemble, spatialSurface: spatialSurface.stats, raster: { status: raster.status, stats: raster.stats, elevationSource: raster.elevationSource }, infrastructureImpact, networkSwmm: { solved: networkSwmm.solved, mode: networkSwmm.mode, linksModelled: networkSwmm.linksModelled, floodedNodeCount: networkSwmm.floodedNodeCount, totalFloodVolumeM3: networkSwmm.totalFloodVolumeM3, maxFloodVolumeM3: networkSwmm.maxFloodVolumeM3, maxPondedDepthM: networkSwmm.maxPondedDepthM, downstreamBoundary: networkSwmm.downstreamBoundary }, downstreamBoundary }, calibration: run.calibration });
    return { ...run, scenario: { ...scenario, runId: saved.id } };
  });
  ipcMain.handle('hydrograph:calibration-status', async () => getCalibrationSnapshot());
  ipcMain.handle('hydrograph:list-scenario-runs', async () => listScenarioRuns(path.join(app.getPath('userData'), 'scenario-runs')));
  ipcMain.handle('hydrograph:rename-scenario-run', async (_event, { id, name } = {}) => renameScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), id, name));
  ipcMain.handle('hydrograph:duplicate-scenario-run', async (_event, { id, name } = {}) => duplicateScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), id, name));
  ipcMain.handle('hydrograph:delete-scenario-run', async (_event, { id } = {}) => deleteScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), id));
  ipcMain.handle('hydrograph:import-scenario-run', async (_event, payload) => importScenarioRun(path.join(app.getPath('userData'), 'scenario-runs'), payload));
  ipcMain.handle('hydrograph:geocode', async (_event, { place } = {}) => withSourceCache(`geocode:${String(place || '').toLowerCase()}`, () => geocodeChennai(place), { maxAgeMs: 365 * 24 * 60 * 60 * 1000 }));
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
        const point = await withSourceCache(`geocode:${report.location.toLowerCase()}`, () => geocodeChennai(report.location), { maxAgeMs: 365 * 24 * 60 * 60 * 1000 });
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
        try { area = await withSourceCache(`geocode:${requestedPlace.toLowerCase()}`, () => geocodeChennai(requestedPlace), { maxAgeMs: 365 * 24 * 60 * 60 * 1000 }); }
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
