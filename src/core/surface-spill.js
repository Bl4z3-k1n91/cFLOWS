'use strict';

// A transparent, bounded surface balance. This is intentionally separate from
// SWMM: SWMM describes the selected conduit/reach; this describes water that
// remains on the local road surface after a conservative drain-headroom proxy.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function simulateSurfaceSpill({ rainfallMmHr, imperviousPct, catchmentAreaHa, elevationM, drainageRisk, swmm, topologyConfidence = 0, calibration, terrain = {}, drain = {} } = {}) {
  const rain = Math.max(0, Number(rainfallMmHr) || 0);
  const terrainReady = Number.isFinite(terrain.depressionM) && Number.isFinite(terrain.reliefM);
  const drainReady = Number.isFinite(drain.distanceM) && Number.isFinite(drain.capacityIndex) && drain.observed === true;
  if (!terrainReady || !drainReady) return {
    available: false, tier: 'surface-spill-balance', rainMmHr: rain, calibrated: false, state: 'withheld-missing-location-inputs',
    missing: [...(!terrainReady ? ['local terrain depression from elevation grid'] : []), ...(!drainReady ? ['nearby mapped drain with observed dimensions/inverts'] : [])],
    disclaimer: 'cFLOWS withheld the street-water range because it cannot differentiate this location from another with the available evidence.',
  };
  const impervious = clamp((Number(imperviousPct) || 70) / 100, .2, .98);
  const areaHa = clamp(Number(catchmentAreaHa) || .45, .05, 3);
  const risk = clamp(Number(drainageRisk) || 0, 0, 1);
  const knownFlooding = Number(swmm?.maxFloodVolumeM3 || 0) > 0 ? .28 : 0;
  const capacityFactor = clamp(drain.capacityIndex / .030, .08, 1.35);
  const proximityFactor = clamp(1 - drain.distanceM / 480, .15, 1);
  const terrainRetention = clamp(1 + terrain.depressionM / .45 + (terrain.reliefM < .4 ? .15 : 0), .75, 2.2);
  const drainRemovalMmHr = clamp(42 * capacityFactor * proximityFactor * (1 - risk * .55) * (.65 + topologyConfidence * .35), 2, 62);
  const runoffMmHr = Math.max(0, rain * impervious - drainRemovalMmHr);
  const excessVolumeM3 = runoffMmHr / 1000 * areaHa * 10000;
  const roadStorageAreaM2 = clamp(areaHa * 10000 * (.028 + (elevationM != null && elevationM < 8 ? .018 : 0) + terrain.depressionM * .018), 150, 2200);
  const centralDepthM = clamp((excessVolumeM3 / roadStorageAreaM2) * terrainRetention + knownFlooding, 0, 1.5);
  const uncalibratedPenalty = calibration?.labelCount ? .12 : .32;
  const uncertaintyM = clamp(.10 + centralDepthM * .60 + (1 - topologyConfidence) * .12 + uncalibratedPenalty, .18, .9);
  const calibrated = Boolean(calibration?.isCalibrated);
  return {
    available: true, tier: 'surface-spill-balance', rainMmHr: rain, runoffMmHr, drainRemovalMmHr, terrain, drain,
    catchmentAreaHa: areaHa, roadStorageAreaM2, excessVolumeM3,
    centralDepthM, depthRangeM: { low: Math.max(0, centralDepthM - uncertaintyM), high: Math.min(2.2, centralDepthM + uncertaintyM) },
    uncertaintyM, calibrated,
    state: calibrated ? 'calibrated-range' : 'exploratory-range-not-calibrated',
    disclaimer: calibrated
      ? 'Range is calibrated against held-out local observations; live conditions can still differ.'
      : 'Illustrative range only: no time-matched local flood-depth labels have calibrated this location yet.',
  };
}

module.exports = { simulateSurfaceSpill };
