'use strict';

// EPA SWMM is executed as a separate, vendored binary. The public GCC layer
// contains geometry but not the surveyed connectivity/inverts required for a
// city-wide production model, so this builds a deliberately bounded,
// inspectable prototype reach. It is not presented as a surveyed network.

const path = require('path');
const fs = require('fs/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const clean = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, '_');
const swmmDate = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Invalid SWMM run date.');
  return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')}/${date.getFullYear()}`;
};

function dateAtMinutes(runDate, minutes) {
  const base = runDate instanceof Date ? new Date(runDate) : new Date(runDate);
  if (Number.isNaN(base.getTime())) throw new Error('Invalid SWMM run date.');
  base.setHours(0, 0, 0, 0);
  base.setMinutes(base.getMinutes() + Math.max(0, Number(minutes) || 0));
  return base;
}

function swmmTime(value) {
  return `${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}:00`;
}

function normaliseRainfallSeries(rainfallSeries, rainMmHr, durationMinutes) {
  const duration = Math.max(30, Math.min(12 * 60, Math.round(Number(durationMinutes) || 120)));
  const supplied = Array.isArray(rainfallSeries) ? rainfallSeries
    .map((row) => ({ minute: Number(row.minute), mmHr: Math.max(0, Number(row.mmHr) || 0) }))
    .filter((row) => Number.isFinite(row.minute) && row.minute >= 0 && row.minute <= duration)
    .sort((a, b) => a.minute - b.minute) : [];
  if (supplied.length >= 2) {
    if (supplied[0].minute > 0) supplied.unshift({ minute: 0, mmHr: supplied[0].mmHr });
    if (supplied.at(-1).minute < duration) supplied.push({ minute: duration, mmHr: supplied.at(-1).mmHr });
    return { durationMinutes: duration, series: supplied };
  }
  const rain = Math.max(0, Number(rainMmHr) || 0);
  return { durationMinutes: duration, series: [{ minute: 0, mmHr: rain }, { minute: Math.min(30, duration), mmHr: rain }, { minute: Math.min(60, duration), mmHr: 0 }, { minute: duration, mmHr: 0 }] };
}

function rainfallRows(runDate, forcing) {
  return forcing.series.map((row) => {
    const stamp = dateAtMinutes(runDate, row.minute);
    return `RAIN ${swmmDate(stamp)} ${swmmTime(stamp)} ${Number(row.mmHr).toFixed(2)}`;
  });
}

function rainfallInterval(forcing) {
  const differences = forcing.series.slice(1).map((row, index) => row.minute - forcing.series[index].minute).filter((value) => value > 0);
  const minutes = Math.max(1, Math.min(...(differences.length ? differences : [30])));
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`;
}

const shapeForSegment = (segment = {}) => segment.closed === true || segment.crossSectionShape === 'RECT_CLOSED' ? 'RECT_CLOSED' : 'RECT_OPEN';

function boundaryRows(boundary) {
  if (boundary?.type !== 'timeseries' || !Array.isArray(boundary.series)) return [];
  return boundary.series.map((row) => {
    const date = new Date(row.time);
    const stageM = Number(row.stageM);
    if (Number.isNaN(date.getTime()) || !Number.isFinite(stageM)) return null;
    return `BOUNDARY ${swmmDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')} ${stageM.toFixed(3)}`;
  }).filter(Boolean);
}

function outfallDefinition(id, invertM, boundary) {
  if (boundary?.type === 'fixed-stage' && Number.isFinite(Number(boundary.stageM))) return `${id} ${invertM.toFixed(3)} FIXED ${Number(boundary.stageM).toFixed(3)} NO`;
  if (boundary?.type === 'timeseries' && boundaryRows(boundary).length >= 2) return `${id} ${invertM.toFixed(3)} TIMESERIES BOUNDARY NO`;
  return `${id} ${invertM.toFixed(3)} FREE NO`;
}

function modelInputAudit(input = {}) {
  const measured = [
    ['rainfall forcing', Number(input.rainMmHr) >= 0 || (Array.isArray(input.rainfallSeries) && input.rainfallSeries.length >= 2)], ['drain width', Number(input.widthM) > 0 && input.widthObserved !== false],
    ['drain depth', Number(input.depthM) > 0 && input.depthObserved !== false], ['drain length from GIS geometry', Number(input.lengthM) > 0],
    ['both drain invert elevations', Number.isFinite(input.invertStartM) && Number.isFinite(input.invertEndM)],
  ];
  const assumptions = ['drain connectivity/direction', 'subcatchment boundary and area', 'impervious fraction and infiltration', 'Manning roughness', ...(!input.outfallBoundary ? ['outfall/tide boundary'] : []), 'ponding/storage', 'pump operating rules'];
  return { observed: measured.filter(([, present]) => present).map(([name]) => name), missingObserved: measured.filter(([, present]) => !present).map(([name]) => name), assumptions, ready: measured.every(([, present]) => present) };
}

function buildPrototypeInp({ rainMmHr = 0, rainfallSeries = null, durationMinutes = 120, widthM = .6, depthM = .75, lengthM = 120, invertStartM, invertEndM, imperviousPct = 82, catchmentAreaHa = .45, runDate = new Date(), closed = false, crossSectionShape, outfallBoundary = null } = {}) {
  const width = Math.max(.3, Number(widthM) || .6).toFixed(2);
  const depth = Math.max(.3, Number(depthM) || .75).toFixed(2);
  const length = Math.max(20, Number(lengthM) || 120).toFixed(1);
  const impervious = Math.max(5, Math.min(98, Number(imperviousPct) || 82)).toFixed(1);
  const catchmentArea = Math.max(.05, Math.min(3, Number(catchmentAreaHa) || .45)).toFixed(2);
  const date = swmmDate(runDate);
  const forcing = normaliseRainfallSeries(rainfallSeries, rainMmHr, durationMinutes);
  const end = dateAtMinutes(runDate, forcing.durationMinutes);
  const junctionMaxDepth = Math.max(1.2, Number(depth) + .3).toFixed(2);
  const highInvert = Math.max(Number(invertStartM), Number(invertEndM));
  const lowInvert = Math.min(Number(invertStartM), Number(invertEndM));
  const inletInvert = Number.isFinite(highInvert) ? highInvert : 5;
  const outletInvert = Number.isFinite(lowInvert) ? lowInvert : 4.7;
  const outfallInvert = Math.min(outletInvert - .15, inletInvert - .3);
  const mainShape = closed === true || crossSectionShape === 'RECT_CLOSED' ? 'RECT_CLOSED' : 'RECT_OPEN';
  const boundarySeries = boundaryRows(outfallBoundary);
  return `[TITLE]
;; cFLOWS provisional SWMM reach. Generated from public geometry + rain.
;; It must be calibrated with surveyed connectivity, inverts and catchments.

[OPTIONS]
FLOW_UNITS           CMS
INFILTRATION         HORTON
FLOW_ROUTING         DYNWAVE
START_DATE           ${date}
START_TIME           00:00:00
REPORT_START_DATE    ${date}
REPORT_START_TIME    00:00:00
END_DATE             ${swmmDate(end)}
END_TIME             ${swmmTime(end)}
REPORT_STEP          00:05:00
WET_STEP             00:01:00
DRY_STEP             01:00:00
ROUTING_STEP         0:00:30
ALLOW_PONDING        YES
INERTIAL_DAMPING     PARTIAL
NORMAL_FLOW_LIMITED  BOTH

[RAINGAGES]
;;Name           Format    Interval SCF      Source
RG1              INTENSITY ${rainfallInterval(forcing)}     1.0      TIMESERIES RAIN

[SUBCATCHMENTS]
;;Name  RainGage Outlet Area   %Imperv Width  %Slope  CurbLen SnowPack
S1      RG1      J1     ${catchmentArea}   ${impervious}      65     0.35    0

[SUBAREAS]
;;Subcatchment N-Imperv N-Perv S-Imperv S-Perv %Zero RouteTo PctRouted
S1             0.015    0.22   1.5      4.0    25    OUTLET 100

[INFILTRATION]
;;Subcatchment MaxRate MinRate Decay DryTime MaxInfil
S1             48      4       4     7       0

[JUNCTIONS]
;;Name Elevation MaxDepth InitDepth SurDepth Aponded
J1     ${inletInvert.toFixed(3)}      ${junctionMaxDepth}     0        0.30     180
J2     ${outletInvert.toFixed(3)}      ${junctionMaxDepth}     0        0.30     180

[OUTFALLS]
;;Name Elevation Type StageData Gated RouteTo
${outfallDefinition('O1', outfallInvert, outfallBoundary)}

[CONDUITS]
;;Name FromNode ToNode Length Roughness InOffset OutOffset InitFlow MaxFlow
C1     J1       J2     ${length}    0.018     0        0         0       0
C2     J2       O1     5.0          0.018     0        0         0       0

[XSECTIONS]
;;Link Shape     Geom1  Geom2 Geom3 Geom4 Barrels Culvert
C1     ${mainShape} ${depth} ${width} 0     0     1
C2     RECT_OPEN ${Math.max(1.0, Number(depth)).toFixed(2)} ${Math.max(1.2, Number(width) * 1.5).toFixed(2)} 0 0 1

[TIMESERIES]
;;Name Date       Time     Value
${rainfallRows(runDate, forcing).join('\n')}
${boundarySeries.join('\n')}

[REPORT]
INPUT      NO
CONTROLS   NO
SUBCATCHMENTS ALL
NODES ALL
LINKS ALL
`;
}

function parseSwmmReport(report) {
  const start = report.indexOf('Node Flooding Summary');
  const next = start >= 0 ? report.indexOf('Outfall Loading Summary', start) : -1;
  const flooding = start >= 0 ? report.slice(start, next >= 0 ? next : undefined) : '';
  const rows = /No nodes were flooded/i.test(flooding) ? [] : flooding.split(/\r?\n/).filter((line) => /^\s*J\d+\s+/.test(line));
  const flooded = rows.map((line) => {
    const values = line.trim().split(/\s+/);
    const volumeMillionL = Number(values[values.length - 2]);
    return {
      node: values[0],
      hoursFlooded: Number(values[1]) || 0,
      maxFlowCms: Number(values[2]) || 0,
      volumeM3: Number.isFinite(volumeMillionL) ? volumeMillionL * 1000 : 0,
      maxPondedDepthM: Number(values[values.length - 1]) || 0,
    };
  }).filter((row) => row.hoursFlooded > 0 || row.volumeM3 > 0);
  const flowRows = report.split(/\r?\n/).filter((line) => /^\s*C\d+\s+/.test(line));
  return {
    flooded,
    floodedNodeCount: flooded.length,
    totalFloodVolumeM3: flooded.reduce((sum, row) => sum + row.volumeM3, 0),
    maxFloodVolumeM3: Math.max(0, ...flooded.map((row) => row.volumeM3)),
    maxPondedDepthM: Math.max(0, ...flooded.map((row) => row.maxPondedDepthM)),
    solved: /Analysis begun/i.test(report) && /Analysis ended/i.test(report),
  };
}

function buildNetworkInp({ segments = [], rainMmHr = 0, rainfallSeries = null, durationMinutes = 120, imperviousPct = 70, catchmentAreaHa = .45, catchmentAreaBySegment = null, runDate = new Date(), junctionToleranceM = 4, outfallBoundary = null } = {}) {
  const usable = segments.filter((segment) => Number(segment.widthM) > 0 && Number(segment.depthM) > 0 && Number(segment.lengthM) > 0 && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM)).slice(0, 24);
  if (!usable.length) throw new Error('No drain links have complete dimensions and invert elevations.');
  const date = swmmDate(runDate);
  const forcing = normaliseRainfallSeries(rainfallSeries, rainMmHr, durationMinutes);
  const end = dateAtMinutes(runDate, forcing.durationMinutes);
  const impervious = Math.max(5, Math.min(98, Number(imperviousPct) || 70)).toFixed(1);
  const distanceM = (a, b) => {
    if (!a || !b) return Infinity;
    const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
    return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(latitude), (a[1] - b[1]) * 110540);
  };
  const nodes = [];
  const getNode = (coordinate, elevation, fallbackKey) => {
    let node = coordinate ? nodes.find((candidate) => candidate.coordinate && distanceM(candidate.coordinate, coordinate) <= junctionToleranceM) : null;
    if (!node) {
      node = { id: `J${String(nodes.length + 1).padStart(3, '0')}`, coordinate: coordinate || null, elevations: [], fallbackKey };
      nodes.push(node);
    }
    node.elevations.push(elevation);
    return node.id;
  };
  const lines = usable.map((segment, index) => {
    const points = Array.isArray(segment.points) && segment.points.length >= 2 ? segment.points : null;
    const startHigher = segment.invertStartM >= segment.invertEndM;
    const inletPoint = points ? (startHigher ? points[0] : points.at(-1)) : null;
    const outletPoint = points ? (startHigher ? points.at(-1) : points[0]) : null;
    const inletInvert = Math.max(segment.invertStartM, segment.invertEndM);
    const outletInvert = Math.min(segment.invertStartM, segment.invertEndM);
    return {
      id: `C${String(index + 1).padStart(3, '0')}`,
      from: getNode(inletPoint, inletInvert, `${segment.id || index}-in`),
      to: getNode(outletPoint, outletInvert, `${segment.id || index}-out`),
      segment,
    };
  });
  const nodeElevation = new Map(nodes.map((node) => [node.id, node.elevations.reduce((sum, value) => sum + value, 0) / node.elevations.length]));
  const outgoingCount = new Map(nodes.map((node) => [node.id, 0]));
  for (const line of lines) outgoingCount.set(line.from, (outgoingCount.get(line.from) || 0) + 1);
  const terminalNodes = nodes.filter((node) => (outgoingCount.get(node.id) || 0) === 0);
  const incidentDepths = new Map(nodes.map((node) => [node.id, []]));
  for (const line of lines) {
    incidentDepths.get(line.from)?.push(Number(line.segment.depthM));
    incidentDepths.get(line.to)?.push(Number(line.segment.depthM));
  }
  const junctions = nodes.map((node) => {
    const maxDepth = Math.max(1.2, ...incidentDepths.get(node.id).filter(Number.isFinite)) + .30;
    return `${node.id.padEnd(7)} ${nodeElevation.get(node.id).toFixed(3)}  ${maxDepth.toFixed(2)} 0 0.30 180`;
  }).join('\n');
  const conduits = lines.map(({ id, from, to, segment }) => `${id.padEnd(7)} ${from.padEnd(7)} ${to.padEnd(7)} ${Math.max(20, segment.lengthM).toFixed(1)} 0.018 0 0 0 0`).join('\n');
  const xsections = lines.map(({ id, segment }) => `${id.padEnd(7)} ${shapeForSegment(segment)} ${Math.max(.3, segment.depthM).toFixed(3)} ${Math.max(.3, segment.widthM).toFixed(3)} 0 0 1`).join('\n');
  const outlets = terminalNodes.map((node, index) => outfallDefinition(`O${String(index + 1).padStart(3, '0')}`, nodeElevation.get(node.id) - .15, outfallBoundary)).join('\n');
  const outletLinks = terminalNodes.map((node, index) => `X${String(index + 1).padStart(3, '0')} ${node.id.padEnd(7)} O${String(index + 1).padStart(3, '0')} 5.0 0.018 0 0 0 0`).join('\n');
  const outletXsections = terminalNodes.map((_, index) => `X${String(index + 1).padStart(3, '0')} RECT_OPEN 1.20 1.00 0 0 1`).join('\n');
  const areaPerLink = Math.max(.03, Number(catchmentAreaHa || .45) / lines.length);
  const subcatchments = lines.map(({ from, segment }, index) => {
    const supplied = Number(catchmentAreaBySegment?.[segment.id]);
    const areaHa = Number.isFinite(supplied) && supplied > 0 ? Math.max(.03, Math.min(25, supplied)) : areaPerLink;
    return `S${String(index + 1).padStart(3, '0')} RG1 ${from} ${areaHa.toFixed(3)} ${impervious} 40 0.35 0`;
  }).join('\n');
  const subareas = lines.map((_, index) => `S${String(index + 1).padStart(3, '0')} 0.015 0.22 1.5 4.0 25 OUTLET 100`).join('\n');
  const infiltration = lines.map((_, index) => `S${String(index + 1).padStart(3, '0')} 48 4 4 7 0`).join('\n');
  const boundarySeries = boundaryRows(outfallBoundary);
  return `[TITLE]\n;; cFLOWS experimental local SWMM network. Coincident public-GIS endpoints are snapped into shared hydraulic nodes.\n;; Topology is geometry-derived and must not be described as surveyed connectivity.\n[OPTIONS]\nFLOW_UNITS CMS\nINFILTRATION HORTON\nFLOW_ROUTING DYNWAVE\nSTART_DATE ${date}\nSTART_TIME 00:00:00\nEND_DATE ${swmmDate(end)}\nEND_TIME ${swmmTime(end)}\nREPORT_STEP 00:05:00\nWET_STEP 00:01:00\nROUTING_STEP 0:00:30\nALLOW_PONDING YES\n[RAINGAGES]\nRG1 INTENSITY ${rainfallInterval(forcing)} 1.0 TIMESERIES RAIN\n[SUBCATCHMENTS]\n${subcatchments}\n[SUBAREAS]\n${subareas}\n[INFILTRATION]\n${infiltration}\n[JUNCTIONS]\n${junctions}\n[OUTFALLS]\n${outlets}\n[CONDUITS]\n${conduits}\n${outletLinks}\n[XSECTIONS]\n${xsections}\n${outletXsections}\n[TIMESERIES]\n${rainfallRows(runDate, forcing).join('\n')}\n${boundarySeries.join('\n')}\n[REPORT]\nNODES ALL\nLINKS ALL\n`;
}

async function runSwmmNetwork({ projectRoot, runDirectory, rainMmHr, segments, surfaceInputs = {} }) {
  const solver = path.join(projectRoot, 'vendor', 'epa-swmm', 'bin', 'runswmm.exe');
  const stamp = `${Date.now()}-network`; const inputPath = path.join(runDirectory, `${stamp}.inp`), reportPath = path.join(runDirectory, `${stamp}.rpt`), outputPath = path.join(runDirectory, `${stamp}.out`);
  const hasBoundary = surfaceInputs.outfallBoundary?.type === 'fixed-stage' || surfaceInputs.outfallBoundary?.type === 'timeseries';
  const audit = { observed: ['rainfall forcing', 'GIS drain geometry', 'drain widths/depths/inverts for included links', ...(hasBoundary ? ['datum-checked downstream stage boundary'] : [])], missingObserved: [], assumptions: ['connectivity uses coincident public-GIS endpoints and is not surveyed', 'subcatchment areas', 'impervious fraction and infiltration', 'roughness', ...(!hasBoundary ? ['outfall/river stage boundary'] : [])], ready: Boolean(segments?.length) };
  if (!audit.ready) return { engine: 'EPA SWMM 5.2.4', mode: 'blocked-no-complete-links', solved: false, audit, error: 'No local mapped drain links have all dimensions and inverts.' };
  await fs.mkdir(runDirectory, { recursive: true }); await fs.writeFile(inputPath, buildNetworkInp({ segments, rainMmHr, ...surfaceInputs }));
  try { await execFileAsync(solver, [inputPath, reportPath, outputPath], { windowsHide: true, timeout: 35_000 }); const report = await fs.readFile(reportPath, 'utf8'); return { engine: 'EPA SWMM 5.2.4', mode: 'experimental-local-network-geometry-snapped', inputPath, reportPath, audit, linksModelled: Math.min(24, segments.length), downstreamBoundary: hasBoundary ? surfaceInputs.outfallBoundary : { type: 'free', reason: 'no datum-compatible downstream stage supplied' }, operationalUse: 'not-for-dispatch', ...parseSwmmReport(report) }; }
  catch (error) { return { engine: 'EPA SWMM 5.2.4', mode: 'unavailable', solved: false, audit, error: error.message }; }
}

async function runSwmmPrototype({ projectRoot, runDirectory, rainMmHr, representativeDrain = {}, surfaceInputs = {} }) {
  const solver = path.join(projectRoot, 'vendor', 'epa-swmm', 'bin', 'runswmm.exe');
  const stamp = `${Date.now()}-${clean(representativeDrain.id || 'pilot')}`;
  const inputPath = path.join(runDirectory, `${stamp}.inp`);
  const reportPath = path.join(runDirectory, `${stamp}.rpt`);
  const outputPath = path.join(runDirectory, `${stamp}.out`);
  await fs.mkdir(runDirectory, { recursive: true });
  const input = { rainMmHr, ...surfaceInputs, ...representativeDrain };
  const audit = modelInputAudit(input);
  if (!audit.ready) return { engine: 'EPA SWMM 5.2.4', mode: 'blocked-missing-observed-input', solved: false, audit, error: `Cannot create a physical SWMM run without: ${audit.missingObserved.join(', ')}` };
  await fs.writeFile(inputPath, buildPrototypeInp(input));
  try {
    await execFileAsync(solver, [inputPath, reportPath, outputPath], { windowsHide: true, timeout: 20_000 });
    const report = await fs.readFile(reportPath, 'utf8');
    return { engine: 'EPA SWMM 5.2.4', mode: 'provisional-representative-reach', inputPath, reportPath, audit, ...parseSwmmReport(report) };
  } catch (error) {
    return { engine: 'EPA SWMM 5.2.4', mode: 'unavailable', solved: false, error: error.message };
  }
}

module.exports = { buildPrototypeInp, buildNetworkInp, modelInputAudit, parseSwmmReport, runSwmmPrototype, runSwmmNetwork, swmmDate };
