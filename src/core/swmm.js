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

module.exports = { buildPrototypeInp, modelInputAudit, parseSwmmReport, runSwmmPrototype };
