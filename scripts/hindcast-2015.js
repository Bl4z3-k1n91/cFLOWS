'use strict';

// Reproducible 2015 Chennai stress/hindcast audit.
//
// Important: the workspace does not contain the raw IMD 2015 hourly file or
// extracted NRSC inundation polygons. The two hourly shapes below are manually
// digitised, to the nearest ~1 mm/h, from Figures 3 and 4 of the IITM/IISc/IITB
// "Chennai Floods 2015: A Rapid Assessment" and are normalized to the published
// 24-h totals. Results are therefore sensitivity/hindcast-screening results, not
// validation metrics.

const fs = require('fs/promises');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { buildDrainGraph } = require('../src/core/drain-graph');
const { buildNetworkInp, parseSwmmReport } = require('../src/core/swmm');
const { estimateOvertureImperviousness } = require('../src/data/data-stack');
const { makeRaster, runRasterSpill } = require('../src/core/raster-spill');
const { simulateSurfaceSpill } = require('../src/core/surface-spill');

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'analysis', '2015-hindcast');
const CACHE = path.join(ROOT, '.electron-data', 'gcc-drain-cache.json');
const SOURCE_CACHE = path.join(ROOT, '.electron-data', 'public-source-cache.json');
const SOLVER = path.join(ROOT, 'vendor', 'epa-swmm', 'bin', 'runswmm.exe');
const FOCUS = { latitude: 12.9824, longitude: 80.2090, label: 'Velachery / Taramani pilot' };
// Freeze the substantial regression network to the eight Velachery reaches
// audited when the 2015 failure modes were discovered. The live GCC cache can
// gain/lose features; a regression target must not silently become a different
// neighbourhood just because another connected component becomes larger.
const REFERENCE_VELACHERY_IDS = ['gcc-5975', 'gcc-6026', 'gcc-5977', 'gcc-6014', 'gcc-6018', 'gcc-6019', 'gcc-6047', 'gcc-6015'];

function lineLengthM(geometry) {
  const lines = geometry?.type === 'MultiLineString' ? geometry.coordinates : geometry?.type === 'LineString' ? [geometry.coordinates] : [];
  return lines.reduce((total, line) => total + line.slice(1).reduce((distance, point, index) => {
    const [lonA, latA] = line[index], [lonB, latB] = point;
    const meanLat = ((latA + latB) / 2) * Math.PI / 180;
    return distance + Math.hypot((lonB - lonA) * 111320 * Math.cos(meanLat), (latB - latA) * 110540);
  }, 0), 0);
}

function segmentDistanceM(segment, focus = FOCUS) {
  return Math.min(...(segment.points || []).map(([lon, lat]) => Math.hypot(
    (lon - focus.longitude) * 111320 * Math.cos(focus.latitude * Math.PI / 180),
    (lat - focus.latitude) * 110540,
  )));
}

function catchmentPrior(segment) {
  const lengthM = Number(segment?.lengthM);
  const midpointHa = Number.isFinite(lengthM) && lengthM > 0 ? Math.max(.12, Math.min(1.5, lengthM * 55 / 10000)) : .45;
  return { midpointHa, rangeHa: [Math.max(.08, midpointHa * .45), Math.min(3, midpointHa * 1.9)] };
}

function normalizeReportingWindow(series, targetMm, startIndex = 9, hours = 24) {
  const observed = series.slice(startIndex, startIndex + hours).reduce((sum, value) => sum + value, 0);
  const scale = observed > 0 ? targetMm / observed : 1;
  return series.map((value) => Math.round(value * scale * 10) / 10);
}

// Approximate hourly shape from Rapid Assessment Figure 4. The reporting-day
// window beginning around 09:00 on Dec 1 sums to ~294 mm before normalization.
const nungambakkamShape = [
  0, 1, 0, 1, 0, 0, 7, 10, 2, 13, 31, 8, 9, 16, 9, 9, 17, 4, 34, 24, 12, 20, 17, 10,
  21, 16, 10, 7, 2, 2, 1, 0, 1, 0, 1, 0, 0, 0, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0,
];

// Approximate hourly shape from Rapid Assessment Figure 3; normalized to the
// published 475 mm 24-h Chembarambakkam total because the printed graph cannot
// be digitised exactly at this resolution.
const chembarambakkamShape = [
  0, 1, 0, 2, 0, 0, 18, 16, 14, 29, 15, 49, 58, 21, 24, 20, 28, 19, 39, 27, 17, 13, 10, 11,
  8, 3, 2, 4, 4, 3, 2, 1, 1, 0, 0, 4, 0, 0, 5, 2, 5, 1, 0, 0, 0, 0, 0, 0,
];

const rainCases = [
  {
    id: 'nungambakkam-observed-shape',
    label: 'Nungambakkam 2015 observed-shape proxy',
    series: normalizeReportingWindow(nungambakkamShape, 294),
    published24hMm: 294,
    role: 'city rainfall forcing',
  },
  {
    id: 'taramani-observed-total-proxy',
    label: 'Taramani 2015 300-mm total using Nungambakkam temporal shape',
    series: normalizeReportingWindow(nungambakkamShape, 300),
    published24hMm: 300,
    role: 'pilot-area rainfall proxy',
  },
  {
    id: 'chembarambakkam-upper-catchment-stress',
    label: 'Chembarambakkam 2015 upper-catchment stress',
    series: normalizeReportingWindow(chembarambakkamShape, 475),
    published24hMm: 475,
    role: 'upper-catchment stress only; not local Taramani rainfall',
  },
  {
    id: 'nungambakkam-uniform-24h',
    label: 'Nungambakkam 294 mm spread uniformly over 24 h',
    series: Array.from({ length: 48 }, (_, hour) => hour >= 9 && hour < 33 ? 294 / 24 : 0),
    published24hMm: 294,
    role: 'temporal-distribution sensitivity',
  },
];

function toSegments(features) {
  return features.map((feature) => {
    const p = feature.properties || {};
    const widthM = Number.parseFloat(p.drain_wid), depthM = Number.parseFloat(p.drain_dep);
    const invertStartM = Number.parseFloat(p.invert_sp), invertEndM = Number.parseFloat(p.invert_ep);
    const points = feature.geometry?.type === 'MultiLineString' ? feature.geometry.coordinates.flat() : feature.geometry?.coordinates || [];
    return {
      id: `gcc-${p.objectid}`,
      label: p.location || 'mapped GCC drain',
      widthM,
      depthM,
      widthObserved: Number.isFinite(widthM) && widthM > 0,
      depthObserved: Number.isFinite(depthM) && depthM > 0,
      lengthM: lineLengthM(feature.geometry),
      invertStartM,
      invertEndM,
      points,
    };
  }).filter((segment) => segment.widthObserved && segment.depthObserved && segment.lengthM > 0 && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM));
}

function components(segments) {
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  const reverse = new Map(segments.map((segment) => [segment.id, []]));
  for (const segment of segments) for (const downstream of segment.downstreamIds || []) reverse.get(downstream)?.push(segment.id);
  const unseen = new Set(segments.map((segment) => segment.id));
  const output = [];
  while (unseen.size) {
    const root = unseen.values().next().value;
    const ids = new Set([root]), queue = [root]; unseen.delete(root);
    while (queue.length) {
      const id = queue.shift();
      const neighbors = [...(byId.get(id)?.downstreamIds || []), ...(reverse.get(id) || [])];
      for (const neighbor of neighbors) if (unseen.has(neighbor)) { unseen.delete(neighbor); ids.add(neighbor); queue.push(neighbor); }
    }
    const links = [...ids].map((id) => byId.get(id));
    output.push({ links, minDistanceM: Math.min(...links.map((link) => segmentDistanceM(link))) });
  }
  return output;
}

function swmmDate(date) {
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
}

function withRainSeries(baseInput, series) {
  const start = new Date(2015, 11, 1, 0, 0, 0);
  const end = new Date(start.getTime() + series.length * 60 * 60 * 1000);
  let input = baseInput
    .replace(/START_DATE\s+\S+/, `START_DATE ${swmmDate(start)}`)
    .replace(/END_DATE\s+\S+/, `END_DATE ${swmmDate(end)}`)
    .replace(/END_TIME\s+\S+/, `END_TIME ${String(end.getHours()).padStart(2, '0')}:00:00`)
    .replace(/RG1 INTENSITY\s+0:30\s+1\.0 TIMESERIES RAIN/, 'RG1 INTENSITY 1:00 1.0 TIMESERIES RAIN');
  const rows = series.map((value, index) => {
    const stamp = new Date(start.getTime() + index * 60 * 60 * 1000);
    return `RAIN ${swmmDate(stamp)} ${String(stamp.getHours()).padStart(2, '0')}:00 ${Number(value).toFixed(2)}`;
  }).join('\n');
  input = input.replace(/\[TIMESERIES\][\s\S]*?(?=\[REPORT\])/, `[TIMESERIES]\n${rows}\n`);
  return input;
}

async function fetchDrainMetadata(ids) {
  const where = encodeURIComponent(`objectid in (${ids.map((id) => String(id).replace(/^gcc-/, '')).join(',')})`);
  const fields = 'objectid,drain_wid,drain_dep,drain_size,drain_detl';
  const url = `https://gisgcc.chennaicorporation.gov.in/server/rest/services/GCCDepts/GCC_COLLABORATION_LAYER/MapServer/8/query?where=${where}&outFields=${fields}&returnGeometry=false&f=json`;
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`GCC metadata query failed: ${response.status}`);
  const payload = await response.json();
  return Object.fromEntries((payload.features || []).map((feature) => [`gcc-${feature.attributes.objectid}`, feature.attributes]));
}

function dimensionsFromDrainSize(metadata, fallback) {
  const match = String(metadata?.drain_size || '').match(/([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return { ...fallback, source: 'raw drain_wid/drain_dep; drain_size unavailable' };
  const widthM = Number(match[1]), depthM = Number(match[2]);
  if (!(widthM > 0) || !(depthM > 0)) return { ...fallback, source: 'raw drain_wid/drain_dep; drain_size invalid' };
  return { widthM, depthM, source: 'parsed drain_size field', closed: /closed/i.test(String(metadata?.drain_detl || '')) };
}

function correctedNetwork(segments, metadataById) {
  return segments.map((segment) => {
    const correction = dimensionsFromDrainSize(metadataById[segment.id], { widthM: segment.widthM, depthM: segment.depthM });
    return { ...segment, widthM: correction.widthM, depthM: correction.depthM, dimensionSource: correction.source, closed: correction.closed === true };
  });
}

function parseContinuity(report) {
  const values = [...report.matchAll(/Continuity Error \(%\)\s+\.\.\.\.\.\s+(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]));
  return { runoffPct: values[0] ?? null, routingPct: values[1] ?? null };
}

function reportSection(report, title, nextTitle) {
  const start = report.indexOf(title);
  if (start < 0) return '';
  const end = nextTitle ? report.indexOf(nextTitle, start + title.length) : -1;
  return report.slice(start, end >= 0 ? end : undefined);
}

function parseFloodingRows(report) {
  const block = reportSection(report, 'Node Flooding Summary', 'Outfall Loading Summary');
  if (/No nodes were flooded/i.test(block)) return [];
  const rows = [];
  for (const line of block.split(/\r?\n/)) {
    if (!/^\s*J\d+\s+/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    // SWMM 5.2 columns: Node, Hours Flooded, Max Rate CMS, Time of Max
    // (days + hh:mm), Total Flood Volume (10^6 L), Max Ponded Depth m.
    const hoursFlooded = Number(tokens[1]);
    const maxRateCms = Number(tokens[2]);
    const volumeMillionL = Number(tokens[tokens.length - 2]);
    const maxPondedDepthM = Number(tokens[tokens.length - 1]);
    rows.push({ node: tokens[0], hoursFlooded, maxRateCms, volumeM3: Number.isFinite(volumeMillionL) ? volumeMillionL * 1000 : null, maxPondedDepthM });
  }
  return rows;
}

function parseLinkUtilization(report) {
  const block = reportSection(report, 'Link Flow Summary', 'Flow Classification Summary');
  const rows = [];
  for (const line of block.split(/\r?\n/)) {
    if (!/^\s*C\d+\s+CONDUIT\s+/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    rows.push({ link: tokens[0], maxFlowCms: Number(tokens[2]), maxVelocityMs: Number(tokens[tokens.length - 3]), maxFullFlowRatio: Number(tokens[tokens.length - 2]), maxFullDepthRatio: Number(tokens[tokens.length - 1]) });
  }
  return rows;
}

function parseNodeDepths(report) {
  const block = reportSection(report, 'Node Depth Summary', 'Node Inflow Summary');
  const values = [];
  for (const line of block.split(/\r?\n/)) {
    if (!/^\s*J\d+\s+JUNCTION\s+/.test(line)) continue;
    const tokens = line.trim().split(/\s+/);
    values.push(Number(tokens[3]));
  }
  return values.filter(Number.isFinite);
}

function parseReportedPrecipitation(report) {
  return Number(/Total Precipitation\s+\.\.\.\.\.\.\s+[-0-9.]+\s+([-0-9.]+)/.exec(report)?.[1] || NaN);
}

async function runSwmmCase({ networkId, segments, catchmentAreaHa, catchmentAreaBySegment = null, imperviousPct, rainCase, dimensionMode = 'raw-fields' }) {
  const caseDir = path.join(OUTPUT, 'swmm');
  await fs.mkdir(caseDir, { recursive: true });
  const stem = `${networkId}__${dimensionMode}__${rainCase.id}__a${catchmentAreaHa.toFixed(2).replace('.', 'p')}`;
  const inpPath = path.join(caseDir, `${stem}.inp`), rptPath = path.join(caseDir, `${stem}.rpt`), outPath = path.join(caseDir, `${stem}.out`);
  const base = buildNetworkInp({ segments, rainMmHr: 0, imperviousPct, catchmentAreaHa, catchmentAreaBySegment, runDate: new Date(2015, 11, 1) });
  let input = withRainSeries(base, rainCase.series);
  await fs.writeFile(inpPath, input);
  await execFileAsync(SOLVER, [inpPath, rptPath, outPath], { windowsHide: true, timeout: 35_000 });
  const report = await fs.readFile(rptPath, 'utf8');
  const parsed = parseSwmmReport(report);
  const flooding = parseFloodingRows(report);
  const utilization = parseLinkUtilization(report);
  const nodeDepths = parseNodeDepths(report);
  return {
    networkId,
    dimensionMode,
    rainCase: rainCase.id,
    catchmentAreaHa,
    links: segments.length,
    totalRain48hMm: Math.round(rainCase.series.reduce((sum, value) => sum + value, 0) * 10) / 10,
    reporting24hMm: Math.round(rainCase.series.slice(9, 33).reduce((sum, value) => sum + value, 0) * 10) / 10,
    peakMmHr: Math.max(...rainCase.series),
    floodedNodes: flooding.length,
    totalFloodVolumeM3: flooding.reduce((sum, row) => sum + (row.volumeM3 || 0), 0),
    maxPondedDepthM: flooding.length ? Math.max(...flooding.map((row) => row.maxPondedDepthM || 0)) : 0,
    maxHoursFlooded: flooding.length ? Math.max(...flooding.map((row) => row.hoursFlooded || 0)) : 0,
    maxLinkFullFlowRatio: utilization.length ? Math.max(...utilization.map((row) => row.maxFullFlowRatio || 0)) : 0,
    maxLinkFullDepthRatio: utilization.length ? Math.max(...utilization.map((row) => row.maxFullDepthRatio || 0)) : 0,
    maxNodeDepthM: nodeDepths.length ? Math.max(...nodeDepths) : 0,
    swmmReportedPrecipitationMm: parseReportedPrecipitation(report),
    warningCount: (report.match(/^\s*WARNING\s+/gm) || []).length,
    continuity: parseContinuity(report),
    solved: parsed.solved,
    productionParser: {
      floodedNodes: parsed.floodedNodeCount,
      totalFloodVolumeM3: parsed.totalFloodVolumeM3,
      maxPondedDepthM: parsed.maxPondedDepthM,
      agreesWithAuditParser: parsed.floodedNodeCount === flooding.length && Math.abs(parsed.totalFloodVolumeM3 - flooding.reduce((sum, row) => sum + (row.volumeM3 || 0), 0)) < 1,
    },
    flooding,
    reportPath: path.relative(ROOT, rptPath),
  };
}

function terrainContext(samples) {
  const usable = (samples || []).filter((sample) => Number.isFinite(sample.elevationM));
  const centre = usable.reduce((closest, sample) => Math.hypot(sample.latitude - FOCUS.latitude, sample.longitude - FOCUS.longitude) < Math.hypot(closest.latitude - FOCUS.latitude, closest.longitude - FOCUS.longitude) ? sample : closest);
  const elevations = usable.map((sample) => sample.elevationM);
  const mean = elevations.reduce((sum, elevation) => sum + elevation, 0) / elevations.length;
  return { elevationM: centre.elevationM, depressionM: Math.max(0, mean - centre.elevationM), reliefM: Math.max(...elevations) - Math.min(...elevations), sampleCount: usable.length };
}

async function runRasterCase({ rainCase, imperviousPct, drainRemovalMmHr, samples }) {
  let raster = makeRaster({ latitude: FOCUS.latitude, longitude: FOCUS.longitude, elevationSamples: samples });
  let totals = { rainfallVolumeM3: 0, drainedVolumeM3: 0, boundaryOutflowM3: 0 };
  let maxDepthM = 0, floodedAreaM2 = 0, continuityErrorPct = 0;
  for (const rainMmHr of rainCase.series) {
    const hour = runRasterSpill({ raster, rainfallMmHr: rainMmHr, imperviousPct, durationMinutes: 60, drainRemovalMmHr, frameEveryMinutes: 60 });
    raster = hour.raster;
    totals.rainfallVolumeM3 += hour.stats.rainfallVolumeM3;
    totals.drainedVolumeM3 += hour.stats.drainedVolumeM3;
    totals.boundaryOutflowM3 += hour.stats.boundaryOutflowM3;
    maxDepthM = Math.max(maxDepthM, hour.stats.maxDepthM);
    floodedAreaM2 = Math.max(floodedAreaM2, hour.stats.floodedAreaM2);
    continuityErrorPct = Math.max(continuityErrorPct, hour.stats.continuityErrorPct);
  }
  const cellArea = raster.cellM ** 2;
  const storedM3 = raster.cells.flat().reduce((sum, cell) => sum + cell.depthM * cellArea, 0);
  const aggregateContinuityErrorPct = totals.rainfallVolumeM3 ? Math.abs(totals.rainfallVolumeM3 - totals.drainedVolumeM3 - totals.boundaryOutflowM3 - storedM3) / totals.rainfallVolumeM3 * 100 : 0;
  return { rainCase: rainCase.id, drainRemovalMmHr, maxDepthM, maxFloodedAreaM2: floodedAreaM2, finalStoredM3: storedM3, aggregateContinuityErrorPct, note: `per-hour continuity is not comparable after the first hour because each call begins with retained water; aggregate continuity closes the 48-h mass balance`, ...totals };
}

async function main() {
  await fs.mkdir(OUTPUT, { recursive: true });
  const drainCache = JSON.parse(await fs.readFile(CACHE, 'utf8'));
  const segments = toSegments(drainCache.geojson?.features || []);
  const graph = buildDrainGraph(segments);
  const comps = components(segments).sort((a, b) => a.minDistanceM - b.minDistanceM);
  const nearest = [...segments].sort((a, b) => segmentDistanceM(a) - segmentDistanceM(b))[0];
  const nearestConnected = comps.find((component) => component.links.length >= 2);
  const referenceLinks = REFERENCE_VELACHERY_IDS.map((id) => segments.find((segment) => segment.id === id)).filter(Boolean);
  const referenceComplete = referenceLinks.length === REFERENCE_VELACHERY_IDS.length;
  const fallbackSubstantial = comps.filter((component) => component.minDistanceM <= 2500).sort((a, b) => b.links.length - a.links.length || a.minDistanceM - b.minDistanceM)[0];
  const substantial = referenceComplete
    ? { links: referenceLinks, minDistanceM: Math.min(...referenceLinks.map((link) => segmentDistanceM(link))), selectionSource: 'pinned-2015-audit-reference' }
    : { ...fallbackSubstantial, selectionSource: `fallback-largest-nearby-component; missing reference ids: ${REFERENCE_VELACHERY_IDS.filter((id) => !referenceLinks.some((link) => link.id === id)).join(', ')}` };
  const networks = [
    { id: 'nearest-selected', links: [nearest], distanceM: segmentDistanceM(nearest), selectionSource: 'nearest-current-cache' },
    { id: 'nearest-connected', links: nearestConnected.links, distanceM: nearestConnected.minDistanceM, selectionSource: 'nearest-current-connected-component' },
    { id: 'velachery-substantial', links: substantial.links, distanceM: substantial.minDistanceM, selectionSource: substantial.selectionSource },
  ];
  const metadataById = await fetchDrainMetadata([...new Set(networks.flatMap((network) => network.links.map((link) => link.id)))]);
  const correctedByNetwork = Object.fromEntries(networks.map((network) => [network.id, correctedNetwork(network.links, metadataById)]));
  const impervious = await estimateOvertureImperviousness({ projectRoot: ROOT, latitude: FOCUS.latitude, longitude: FOCUS.longitude });
  const imperviousPct = impervious?.imperviousPct ?? 67.3;
  const swmmRuns = [];
  for (const network of networks) {
    const appArea = catchmentPrior(network.links[0]).midpointHa;
    const summedArea = network.links.reduce((sum, link) => sum + catchmentPrior(link).midpointHa, 0);
    const correctedCatchments = Object.fromEntries(correctedByNetwork[network.id].map((link) => [link.id, catchmentPrior(link).midpointHa]));
    for (const area of [...new Set([appArea, summedArea].map((value) => Math.round(value * 1000) / 1000))]) {
      for (const rainCase of rainCases) {
        swmmRuns.push(await runSwmmCase({ networkId: network.id, segments: network.links, catchmentAreaHa: area, imperviousPct, rainCase, dimensionMode: 'raw-fields' }));
        swmmRuns.push(await runSwmmCase({ networkId: network.id, segments: correctedByNetwork[network.id], catchmentAreaHa: area, catchmentAreaBySegment: Math.abs(area - summedArea) < .001 ? correctedCatchments : null, imperviousPct, rainCase, dimensionMode: Math.abs(area - summedArea) < .001 ? 'production-fixed' : 'drain-size-closed' }));
      }
    }
  }

  const sourceCache = JSON.parse(await fs.readFile(SOURCE_CACHE, 'utf8'));
  const elevationEntry = sourceCache['elevation-grid:12.9824:80.2090'];
  const samples = elevationEntry?.value?.samples || [];
  const selected = nearest;
  const terrain = terrainContext(samples);
  const selectedPrior = catchmentPrior(selected);
  const topologyConfidence = selected.topology?.confidence || 0;
  const distanceM = segmentDistanceM(selected);
  const drain = { observed: true, distanceM, capacityIndex: selected.widthM * selected.depthM * Math.sqrt(Math.max(.00001, Math.abs(selected.invertStartM - selected.invertEndM) / selected.lengthM)) };
  const peakScreen = simulateSurfaceSpill({ rainfallMmHr: 34, imperviousPct, catchmentAreaRangeHa: selectedPrior.rangeHa, elevationM: terrain.elevationM, drainageRisk: .65, topologyConfidence, calibration: { isCalibrated: false, labelCount: 0 }, terrain, drain });
  const drainRemovalMmHr = peakScreen.available ? peakScreen.drainRemovalMmHr : 10;
  const rasterRuns = samples.length >= 9 ? [] : null;
  if (rasterRuns) for (const rainCase of rainCases) rasterRuns.push(await runRasterCase({ rainCase, imperviousPct, drainRemovalMmHr, samples }));

  const topology = {
    completeHydraulicFeatures: segments.length,
    graphSummary: graph.summary,
    nearestSelected: { id: nearest.id, label: nearest.label, distanceM: Math.round(segmentDistanceM(nearest)), componentSize: comps.find((component) => component.links.some((link) => link.id === nearest.id))?.links.length || 1 },
    networks: networks.map((network) => ({
      id: network.id, links: network.links.length, distanceM: Math.round(network.distanceM), labels: [...new Set(network.links.map((link) => link.label))],
      selectionSource: network.selectionSource,
      dimensions: network.links.map((link, index) => ({ id: link.id, rawWidth: link.widthM, rawDepth: link.depthM, correctedWidth: correctedByNetwork[network.id][index].widthM, correctedDepth: correctedByNetwork[network.id][index].depthM, source: correctedByNetwork[network.id][index].dimensionSource, closed: correctedByNetwork[network.id][index].closed })),
    })),
  };

  const reservoir = {
    peakReleaseCusec: 29000,
    peakReleaseCms: 29000 * 0.028316846592,
    durationHours: 21,
    approximateReleasedVolumeM3: 29000 * 0.028316846592 * 21 * 3600,
    modelRepresentation: 'not represented by the local storm-drain SWMM or surface raster',
  };

  const result = {
    generatedAt: new Date().toISOString(),
    scope: '2015 historical stress/hindcast screening; not a calibrated validation because raw hourly station files and NRSC inundation polygons are absent locally',
    focus: FOCUS,
    forcingNotes: {
      localWorkspaceIMD: 'contains only 2026-08-19 through 2026-09-01; not used for 2015',
      publishedTotalsMm: { Nungambakkam: 294, Taramani: 300, Chembarambakkam: 475 },
      temporalShape: 'hourly shapes manually digitised approximately from Rapid Assessment Figures 3/4 and normalized to published 24-h totals',
    },
    impervious,
    topology,
    rainCases: rainCases.map((item) => ({ id: item.id, label: item.label, role: item.role, peakMmHr: Math.max(...item.series), reporting24hMm: item.series.slice(9, 33).reduce((sum, value) => sum + value, 0), total48hMm: item.series.reduce((sum, value) => sum + value, 0) })),
    swmmRuns,
    rasterRuns,
    rasterInputs: { elevationSource: elevationEntry?.value?.source || null, sampleCount: samples.length, drainRemovalMmHr, terrain },
    reservoir,
    validationAvailability: { nrscRegistryEntries: 2, extractedInundationPolygons: 0, observedDepthLabels: 0, spatialIoUAvailable: false, depthMAEAvailable: false },
  };
  await fs.writeFile(path.join(OUTPUT, 'results.json'), JSON.stringify(result, null, 2));

  const rows = swmmRuns.map((run) => ({
    network: run.networkId,
    dimensions: run.dimensionMode,
    rain: run.rainCase,
    areaHa: run.catchmentAreaHa,
    links: run.links,
    rain24mm: run.reporting24hMm,
    peakMmHr: run.peakMmHr,
    floodedNodes: run.floodedNodes,
    floodM3: Math.round(run.totalFloodVolumeM3),
    maxPondedM: run.maxPondedDepthM,
    maxFloodHours: run.maxHoursFlooded,
    maxFullFlowRatio: run.maxLinkFullFlowRatio,
    maxFullDepthRatio: run.maxLinkFullDepthRatio,
    maxNodeDepthM: run.maxNodeDepthM,
    swmmPrecipMm: run.swmmReportedPrecipitationMm,
    warnings: run.warningCount,
    runoffContinuityPct: run.continuity.runoffPct,
    routingContinuityPct: run.continuity.routingPct,
  }));
  const headers = Object.keys(rows[0]);
  await fs.writeFile(path.join(OUTPUT, 'swmm-summary.csv'), `${headers.join(',')}\n${rows.map((row) => headers.map((header) => row[header]).join(',')).join('\n')}\n`);
  console.log(JSON.stringify({ topology, rainCases: result.rainCases, swmmRuns: rows, rasterRuns, reservoir }, null, 2));
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
