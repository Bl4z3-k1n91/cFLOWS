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

function modelInputAudit(input = {}) {
  const measured = [
    ['rainfall forcing', Number(input.rainMmHr) >= 0], ['drain width', Number(input.widthM) > 0 && input.widthObserved !== false],
    ['drain depth', Number(input.depthM) > 0 && input.depthObserved !== false], ['drain length from GIS geometry', Number(input.lengthM) > 0],
    ['both drain invert elevations', Number.isFinite(input.invertStartM) && Number.isFinite(input.invertEndM)],
  ];
  const assumptions = ['drain connectivity/direction', 'subcatchment boundary and area', 'impervious fraction and infiltration', 'Manning roughness', 'outfall/tide boundary', 'ponding/storage', 'pump operating rules'];
  return { observed: measured.filter(([, present]) => present).map(([name]) => name), missingObserved: measured.filter(([, present]) => !present).map(([name]) => name), assumptions, ready: measured.every(([, present]) => present) };
}

function buildPrototypeInp({ rainMmHr = 0, widthM = .6, depthM = .75, lengthM = 120, invertStartM, invertEndM, imperviousPct = 82, catchmentAreaHa = .45, runDate = new Date() } = {}) {
  const width = Math.max(.3, Number(widthM) || .6).toFixed(2);
  const depth = Math.max(.3, Number(depthM) || .75).toFixed(2);
  const length = Math.max(20, Number(lengthM) || 120).toFixed(1);
  const rain = Math.max(0, Number(rainMmHr) || 0).toFixed(2);
  const impervious = Math.max(5, Math.min(98, Number(imperviousPct) || 82)).toFixed(1);
  const catchmentArea = Math.max(.05, Math.min(3, Number(catchmentAreaHa) || .45)).toFixed(2);
  const date = runDate.toISOString().slice(0, 10);
  const highInvert = Math.max(Number(invertStartM), Number(invertEndM));
  const lowInvert = Math.min(Number(invertStartM), Number(invertEndM));
  const inletInvert = Number.isFinite(highInvert) ? highInvert : 5;
  const outletInvert = Number.isFinite(lowInvert) ? lowInvert : 4.7;
  const outfallInvert = Math.min(outletInvert - .15, inletInvert - .3);
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
END_DATE             ${date}
END_TIME             02:00:00
REPORT_STEP          00:05:00
WET_STEP             00:01:00
DRY_STEP             01:00:00
ROUTING_STEP         0:00:30
ALLOW_PONDING        YES
INERTIAL_DAMPING     PARTIAL
NORMAL_FLOW_LIMITED  BOTH

[RAINGAGES]
;;Name           Format    Interval SCF      Source
RG1              INTENSITY 0:05     1.0      TIMESERIES RAIN

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
J1     ${inletInvert.toFixed(3)}      1.20     0        0.30     180
J2     ${outletInvert.toFixed(3)}      1.20     0        0.30     180

[OUTFALLS]
;;Name Elevation Type StageData Gated RouteTo
O1     ${outfallInvert.toFixed(3)}      FREE              NO

[CONDUITS]
;;Name FromNode ToNode Length Roughness InOffset OutOffset InitFlow MaxFlow
C1     J1       J2     ${length}    0.018     0        0         0       0
C2     J2       O1     ${length}    0.018     0        0         0       0

[XSECTIONS]
;;Link Shape     Geom1  Geom2 Geom3 Geom4 Barrels Culvert
C1     RECT_OPEN ${width} ${depth} 0     0     1
C2     RECT_OPEN ${width} ${depth} 0     0     1

[TIMESERIES]
;;Name Date       Time     Value
RAIN   ${date} 00:00   ${rain}
RAIN   ${date} 00:30   ${rain}
RAIN   ${date} 01:00   0
RAIN   ${date} 02:00   0

[REPORT]
INPUT      NO
CONTROLS   NO
SUBCATCHMENTS ALL
NODES ALL
LINKS ALL

[END]
`;
}

function parseSwmmReport(report) {
  const flooding = /Node Flooding Summary[\s\S]*?(?=\n\s*\*{3}|\n\s*Analysis)/i.exec(report)?.[0] || '';
  const rows = flooding.split(/\r?\n/).filter((line) => /^\s*J\d+\s+/.test(line));
  const flooded = rows.map((line) => {
    const values = line.trim().split(/\s+/);
    return { node: values[0], hoursFlooded: Number(values[1]) || 0, maxFlowCms: Number(values[2]) || 0, volumeM3: Number(values[3]) || 0 };
  });
  const flowRows = report.split(/\r?\n/).filter((line) => /^\s*C\d+\s+/.test(line));
  return { flooded, maxFloodVolumeM3: Math.max(0, ...flooded.map((row) => row.volumeM3)), solved: /Analysis begun/i.test(report) && /Analysis ended/i.test(report) };
}

function buildNetworkInp({ segments = [], rainMmHr = 0, imperviousPct = 70, catchmentAreaHa = .45, runDate = new Date() } = {}) {
  const usable = segments.filter((segment) => Number(segment.widthM) > 0 && Number(segment.depthM) > 0 && Number(segment.lengthM) > 0 && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM)).slice(0, 24);
  if (!usable.length) throw new Error('No drain links have complete dimensions and invert elevations.');
  const date = runDate.toISOString().slice(0, 10), rain = Math.max(0, Number(rainMmHr) || 0).toFixed(2);
  const impervious = Math.max(5, Math.min(98, Number(imperviousPct) || 70)).toFixed(1);
  const nodes = new Map(), lines = [];
  for (let index = 0; index < usable.length; index += 1) {
    const segment = usable[index]; const from = `J${String(index * 2 + 1).padStart(3, '0')}`, to = `J${String(index * 2 + 2).padStart(3, '0')}`;
    const high = Math.max(segment.invertStartM, segment.invertEndM), low = Math.min(segment.invertStartM, segment.invertEndM);
    nodes.set(from, high); nodes.set(to, low);
    lines.push({ id: `C${String(index + 1).padStart(3, '0')}`, from, to, segment });
  }
  const junctions = [...nodes].map(([id, elevation]) => `${id.padEnd(7)} ${elevation.toFixed(3)}  1.20 0 0.30 180`).join('\n');
  const conduits = lines.map(({ id, from, to, segment }) => `${id.padEnd(7)} ${from.padEnd(7)} ${to.padEnd(7)} ${Math.max(20, segment.lengthM).toFixed(1)} 0.018 0 0 0 0`).join('\n');
  const xsections = lines.map(({ id, segment }) => `${id.padEnd(7)} RECT_OPEN ${Math.max(.3, segment.widthM).toFixed(2)} ${Math.max(.3, segment.depthM).toFixed(2)} 0 0 1`).join('\n');
  const outlets = lines.map(({ segment }, index) => `O${String(index + 1).padStart(3, '0')} ${(Math.min(segment.invertStartM, segment.invertEndM) - .15).toFixed(3)} FREE NO`).join('\n');
  const outletLinks = lines.map(({ to, segment }, index) => `X${String(index + 1).padStart(3, '0')} ${to.padEnd(7)} O${String(index + 1).padStart(3, '0')} 10.0 0.018 0 0 0 0`).join('\n');
  const outletXsections = lines.map((_, index) => `X${String(index + 1).padStart(3, '0')} RECT_OPEN 1.00 1.20 0 0 1`).join('\n');
  const subcatchments = lines.map(({ from }, index) => `S${String(index + 1).padStart(3, '0')} RG1 ${from} ${(Math.max(.03, catchmentAreaHa / lines.length)).toFixed(3)} ${impervious} 40 0.35 0`).join('\n');
  const subareas = lines.map((_, index) => `S${String(index + 1).padStart(3, '0')} 0.015 0.22 1.5 4.0 25 OUTLET 100`).join('\n');
  const infiltration = lines.map((_, index) => `S${String(index + 1).padStart(3, '0')} 48 4 4 7 0`).join('\n');
  return `[TITLE]\n;; cFLOWS experimental local SWMM network. Candidate connectivity is not surveyed.\n[OPTIONS]\nFLOW_UNITS CMS\nINFILTRATION HORTON\nFLOW_ROUTING DYNWAVE\nSTART_DATE ${date}\nSTART_TIME 00:00:00\nEND_DATE ${date}\nEND_TIME 02:00:00\nREPORT_STEP 00:05:00\nWET_STEP 00:01:00\nROUTING_STEP 0:00:30\nALLOW_PONDING YES\n[RAINGAGES]\nRG1 INTENSITY 0:05 1.0 TIMESERIES RAIN\n[SUBCATCHMENTS]\n${subcatchments}\n[SUBAREAS]\n${subareas}\n[INFILTRATION]\n${infiltration}\n[JUNCTIONS]\n${junctions}\n[OUTFALLS]\n${outlets}\n[CONDUITS]\n${conduits}\n${outletLinks}\n[XSECTIONS]\n${xsections}\n${outletXsections}\n[TIMESERIES]\nRAIN ${date} 00:00 ${rain}\nRAIN ${date} 00:30 ${rain}\nRAIN ${date} 01:00 0\nRAIN ${date} 02:00 0\n[REPORT]\nNODES ALL\nLINKS ALL\n[END]\n`;
}

async function runSwmmNetwork({ projectRoot, runDirectory, rainMmHr, segments, surfaceInputs = {} }) {
  const solver = path.join(projectRoot, 'vendor', 'epa-swmm', 'bin', 'runswmm.exe');
  const stamp = `${Date.now()}-network`; const inputPath = path.join(runDirectory, `${stamp}.inp`), reportPath = path.join(runDirectory, `${stamp}.rpt`), outputPath = path.join(runDirectory, `${stamp}.out`);
  const audit = { observed: ['rainfall forcing', 'GIS drain geometry', 'drain widths/depths/inverts for included links'], missingObserved: [], assumptions: ['candidate connectivity is inferred, not surveyed', 'subcatchment areas', 'impervious fraction and infiltration', 'roughness', 'outfall/tide boundary'], ready: Boolean(segments?.length) };
  if (!audit.ready) return { engine: 'EPA SWMM 5.2.4', mode: 'blocked-no-complete-links', solved: false, audit, error: 'No local mapped drain links have all dimensions and inverts.' };
  await fs.mkdir(runDirectory, { recursive: true }); await fs.writeFile(inputPath, buildNetworkInp({ segments, rainMmHr, ...surfaceInputs }));
  try { await execFileAsync(solver, [inputPath, reportPath, outputPath], { windowsHide: true, timeout: 35_000 }); const report = await fs.readFile(reportPath, 'utf8'); return { engine: 'EPA SWMM 5.2.4', mode: 'experimental-local-network-inferred-connectivity', inputPath, reportPath, audit, linksModelled: Math.min(24, segments.length), operationalUse: 'not-for-dispatch', ...parseSwmmReport(report) }; }
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

module.exports = { buildPrototypeInp, buildNetworkInp, modelInputAudit, parseSwmmReport, runSwmmPrototype, runSwmmNetwork };
