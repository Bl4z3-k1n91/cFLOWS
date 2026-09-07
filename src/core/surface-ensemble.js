'use strict';

const { runRasterSpill, summarizeRasterPooling } = require('./raster-spill');

function cloneRaster(raster) {
  return {
    ...raster,
    cells: (raster.cells || []).map((row) => row.map((cell) => ({ ...cell, depthM: Number(cell.depthM) || 0 }))),
  };
}

function scaleRainfallSeries(series, factor) {
  return Array.isArray(series) ? series.map((item) => ({ ...item, mmHr: Math.max(0, Number(item.mmHr) || 0) * factor })) : null;
}

function quantile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
}

function runMember({ raster, latitude, longitude, rainfallMmHr, rainfallSeries, durationMinutes, imperviousPct, drainRemovalMmHr, drainOverflowM3, initialObservations, factors }) {
  const run = runRasterSpill({
    raster: cloneRaster(raster),
    rainfallMmHr: rainfallMmHr * factors.rain,
    rainfallSeries: scaleRainfallSeries(rainfallSeries, factors.rain),
    durationMinutes,
    imperviousPct,
    drainRemovalMmHr,
    drainEfficiency: factors.drain,
    drainOverflowM3: Math.max(0, Number(drainOverflowM3) || 0) * factors.overflow,
    initialObservations,
    imperviousMultiplier: factors.impervious,
    infiltrationMultiplier: factors.infiltration,
    manningMultiplier: factors.manning,
    frameEveryMinutes: Math.max(20, durationMinutes),
  });
  const pooling = summarizeRasterPooling(run, latitude, longitude);
  return {
    factors,
    selectedDepthM: pooling.selectedDepthM,
    p90DepthM: pooling.p90DepthM,
    p95DepthM: pooling.p95DepthM,
    floodedFraction: pooling.floodedFraction,
    significantFraction: pooling.significantFraction,
    deepFraction: pooling.deepFraction,
    depthBand: pooling.depthBand,
    continuityErrorPct: run.stats.continuityErrorPct,
  };
}

const JOINT_MEMBERS = [
  { rain: .90, impervious: .92, infiltration: 1.25, manning: .86, drain: 1.15, overflow: .85 },
  { rain: .92, impervious: 1.06, infiltration: .82, manning: 1.12, drain: .78, overflow: 1.10 },
  { rain: .96, impervious: .98, infiltration: 1.12, manning: 1.18, drain: .92, overflow: .95 },
  { rain: .98, impervious: 1.10, infiltration: .72, manning: .92, drain: .68, overflow: 1.18 },
  { rain: 1.00, impervious: 1.00, infiltration: 1.00, manning: 1.00, drain: 1.00, overflow: 1.00 },
  { rain: 1.02, impervious: .90, infiltration: 1.35, manning: 1.08, drain: 1.20, overflow: .82 },
  { rain: 1.04, impervious: 1.08, infiltration: .76, manning: .84, drain: .72, overflow: 1.20 },
  { rain: 1.06, impervious: .95, infiltration: 1.18, manning: .80, drain: 1.08, overflow: .90 },
  { rain: 1.08, impervious: 1.04, infiltration: .88, manning: 1.16, drain: .82, overflow: 1.12 },
  { rain: 1.10, impervious: 1.12, infiltration: .65, manning: .96, drain: .60, overflow: 1.25 },
  { rain: .94, impervious: 1.02, infiltration: .94, manning: .88, drain: 1.12, overflow: .92 },
  { rain: 1.07, impervious: .96, infiltration: 1.08, manning: 1.04, drain: .88, overflow: 1.08 },
];

function runSurfaceEnsemble(options = {}) {
  if (!options.raster?.cells?.length) return { available: false, state: 'no-raster' };
  const members = JOINT_MEMBERS.map((factors) => runMember({ ...options, factors }));
  const depths = members.map((member) => Number(member.selectedDepthM) || 0);
  const bandCounts = members.reduce((counts, member) => { counts[member.depthBand] = (counts[member.depthBand] || 0) + 1; return counts; }, {});
  const atLeast = (threshold) => members.filter((member) => member.selectedDepthM >= threshold).length;
  const memberCount = members.length;
  const p10DepthM = quantile(depths, .10), p50DepthM = quantile(depths, .50), p90DepthM = quantile(depths, .90);
  let consensusBand = 'minimal-ponding';
  if (atLeast(.40) >= Math.ceil(memberCount / 2)) consensusBand = 'deep-inundation-possible';
  else if (atLeast(.15) >= Math.ceil(memberCount / 2)) consensusBand = 'significant-inundation';
  else if (atLeast(.05) >= Math.ceil(memberCount / 2)) consensusBand = 'shallow-inundation';

  const baseFactors = { rain: 1, impervious: 1, infiltration: 1, manning: 1, drain: 1, overflow: 1 };
  const sensitivitySpecs = [
    ['rain', 'Rainfall uncertainty', .90, 1.10],
    ['impervious', 'Built-up / runoff uncertainty', .90, 1.10],
    ['infiltration', 'Infiltration uncertainty', .65, 1.35],
    ['manning', 'Surface roughness uncertainty', .80, 1.20],
    ...(Number(options.drainRemovalMmHr) > 0 ? [['drain', 'Drain effectiveness uncertainty', .60, 1.20]] : []),
  ];
  const sensitivity = sensitivitySpecs.map(([id, label, low, high]) => {
    const lowRun = runMember({ ...options, factors: { ...baseFactors, [id]: low } });
    const highRun = runMember({ ...options, factors: { ...baseFactors, [id]: high } });
    const deltaM = highRun.selectedDepthM - lowRun.selectedDepthM;
    return { id, label, lowFactor: low, highFactor: high, lowDepthM: lowRun.selectedDepthM, highDepthM: highRun.selectedDepthM, deltaM, absoluteEffectM: Math.abs(deltaM) };
  }).sort((a, b) => b.absoluteEffectM - a.absoluteEffectM);

  return {
    available: true,
    memberCount,
    method: 'deterministic bounded-parameter surface ensemble',
    interpretation: 'Member frequencies describe robustness across disclosed parameter ranges; they are not calibrated statistical probabilities.',
    consensusBand,
    selectedDepthM: { p10: p10DepthM, p50: p50DepthM, p90: p90DepthM },
    exceedance: {
      atLeast05cm: atLeast(.05),
      atLeast15cm: atLeast(.15),
      atLeast40cm: atLeast(.40),
    },
    neighbourhood: {
      membersWithMaterialPonding: members.filter((member) => member.floodedFraction >= .05).length,
      membersWithSignificantPooling: members.filter((member) => member.significantFraction >= .05).length,
      membersWithDeepCells: members.filter((member) => member.deepFraction >= .02).length,
    },
    bandCounts,
    sensitivity,
    members,
    maxContinuityErrorPct: Math.max(...members.map((member) => Number(member.continuityErrorPct) || 0)),
  };
}

module.exports = { runSurfaceEnsemble, JOINT_MEMBERS };
