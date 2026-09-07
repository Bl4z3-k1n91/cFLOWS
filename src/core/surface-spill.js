'use strict';

// A transparent, bounded surface balance. This is intentionally separate from
// SWMM: SWMM describes the selected conduit/reach; this describes water that
// remains on the local road surface after a conservative drain-headroom proxy.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const DEFAULT_SURFACE_PRIOR = Object.freeze({
  removalReferenceMmHr: 42,
  capacityReference: .030,
  riskPenalty: .55,
  minimumRemovalMmHr: 2,
  maximumRemovalMmHr: 62,
  localityRadiusM: 480,
});

function depthBand(highM) {
  if (highM < .10) return 'minimal-ponding';
  if (highM < .30) return 'shallow-inundation';
  if (highM < .60) return 'significant-inundation';
  return 'deep-inundation-possible';
}

function simulateSurfaceSpill({ rainfallMmHr, imperviousPct, imperviousRangePct = [40, 85], catchmentAreaHa, catchmentAreaRangeHa = [.20, .90], elevationM, drainageRisk, swmm, topologyConfidence = 0, calibration, terrain = {}, drain = {}, parameters = DEFAULT_SURFACE_PRIOR } = {}) {
  const rain = Math.max(0, Number(rainfallMmHr) || 0);
  const prior = { ...DEFAULT_SURFACE_PRIOR, ...(parameters || {}) };
  const terrainReady = Number.isFinite(terrain.depressionM) && Number.isFinite(terrain.reliefM);
  const drainInsideDomain = Number.isFinite(drain.distanceM) && drain.distanceM <= prior.localityRadiusM;
  const drainReady = drainInsideDomain && Number.isFinite(drain.capacityIndex) && drain.observed === true;
  if (!terrainReady) return {
    available: false, tier: 'surface-spill-balance', rainMmHr: rain, calibrated: false, state: 'withheld-missing-location-inputs',
    missing: ['local terrain depression from elevation grid'],
    disclaimer: 'cFLOWS withheld the street-water range because it cannot differentiate this location from another without local terrain evidence.',
  };
  const imperviousKnown = imperviousPct !== null && imperviousPct !== undefined && imperviousPct !== '' && Number.isFinite(Number(imperviousPct));
  const imperviousLow = clamp((imperviousKnown ? Number(imperviousPct) : Number(imperviousRangePct?.[0] ?? 40)) / 100, .2, .98);
  const imperviousHigh = clamp((imperviousKnown ? Number(imperviousPct) : Number(imperviousRangePct?.[1] ?? 85)) / 100, imperviousLow, .98);
  const impervious = (imperviousLow + imperviousHigh) / 2;
  const areaKnown = catchmentAreaHa !== null && catchmentAreaHa !== undefined && catchmentAreaHa !== '' && Number.isFinite(Number(catchmentAreaHa));
  const areaLow = clamp(areaKnown ? Number(catchmentAreaHa) : Number(catchmentAreaRangeHa?.[0] ?? .20), .05, 25);
  const areaHigh = clamp(areaKnown ? Number(catchmentAreaHa) : Number(catchmentAreaRangeHa?.[1] ?? .90), areaLow, 25);
  const areaHa = (areaLow + areaHigh) / 2;
  const risk = clamp(Number(drainageRisk) || 0, 0, 1);
  const knownFlooding = drainReady && Number(swmm?.maxFloodVolumeM3 || 0) > 0 ? .28 : 0;
  const capacityFactor = drainReady ? clamp(drain.capacityIndex / prior.capacityReference, .08, 1.35) : 0;
  const proximityFactor = drainReady ? clamp(1 - drain.distanceM / prior.localityRadiusM, 0, 1) : 0;
  const terrainRetention = clamp(1 + terrain.depressionM / .45 + (terrain.reliefM < .4 ? .15 : 0), .75, 2.2);
  // If no hydraulically complete local drain is available, do not invent pipe
  // capacity. We still allow a conservative surface-only screen using terrain,
  // rainfall and runoff, with zero drainage credit. This intentionally behaves
  // like an upper-bound pooling screen rather than a drain-aware depth forecast.
  const drainRemovalMmHr = drainReady
    ? clamp(prior.removalReferenceMmHr * capacityFactor * proximityFactor * (1 - risk * prior.riskPenalty) * (.65 + topologyConfidence * .35), prior.minimumRemovalMmHr, prior.maximumRemovalMmHr)
    : 0;
  const modelDepth = (imp, area) => {
    const runoffMmHr = Math.max(0, rain * imp - drainRemovalMmHr);
    const excessVolumeM3 = runoffMmHr / 1000 * area * 10000;
    const roadStorageAreaM2 = clamp(area * 10000 * (.028 + (elevationM != null && elevationM < 8 ? .018 : 0) + terrain.depressionM * .018), 150, 2200);
    return { runoffMmHr, excessVolumeM3, roadStorageAreaM2, depthM: clamp((excessVolumeM3 / roadStorageAreaM2) * terrainRetention + knownFlooding, 0, 1.5) };
  };
  const central = modelDepth(impervious, areaHa);
  const calibrated = Boolean(calibration?.isCalibrated) && drainReady;
  const depthScale = calibrated && Number.isFinite(Number(calibration?.surfaceParameters?.depthScale)) ? Number(calibration.surfaceParameters.depthScale) : 1;
  const envelope = [
    modelDepth(imperviousLow, areaLow).depthM,
    modelDepth(imperviousLow, areaHigh).depthM,
    modelDepth(imperviousHigh, areaLow).depthM,
    modelDepth(imperviousHigh, areaHigh).depthM,
  ].map((value) => clamp(value * depthScale, 0, 2.2));
  const centralDepthM = clamp(central.depthM * depthScale, 0, 1.5);
  const uncalibratedPenalty = calibrated ? .08 : calibration?.labelCount ? .22 : .38;
  const uncertaintyM = clamp(.10 + centralDepthM * .55 + (1 - topologyConfidence) * .14 + uncalibratedPenalty + (drainReady ? 0 : .22), calibrated && drainReady ? .15 : .30, 1.15);
  const depthRangeM = { low: Math.max(0, Math.min(...envelope) - uncertaintyM), high: Math.min(2.2, Math.max(...envelope) + uncertaintyM) };
  return {
    available: true,
    tier: drainReady ? 'surface-spill-screening' : 'surface-only-pooling-screening',
    rainMmHr: rain, runoffMmHr: central.runoffMmHr, drainRemovalMmHr, terrain, drain,
    surfaceOnly: !drainReady,
    drainDataAvailable: drainReady,
    drainAssumption: drainReady ? 'local mapped drain capacity proxy used' : 'no local drain capacity assumed; zero drainage credit used for conservative pooling screen',
    missing: drainReady ? [] : [drainInsideDomain ? 'nearby mapped drain with observed dimensions/inverts' : `hydraulically complete drain inside ${prior.localityRadiusM} m surface domain`],
    imperviousPct: imperviousKnown ? Number(imperviousPct) : null,
    imperviousRangePct: [Math.round(imperviousLow * 100), Math.round(imperviousHigh * 100)],
    catchmentAreaHa: areaKnown ? Number(catchmentAreaHa) : null,
    catchmentAreaRangeHa: [areaLow, areaHigh],
    roadStorageAreaM2: central.roadStorageAreaM2, excessVolumeM3: central.excessVolumeM3,
    centralDepthM, depthRangeM, depthBand: depthBand(depthRangeM.high),
    uncertaintyM, calibrated,
    displayPrecision: calibrated ? 'decimetre-range' : 'qualitative-band',
    parameterSource: calibrated ? 'held-out depth-scale calibration plus explicit engineering priors' : 'unfitted engineering prior; bounded input ranges are propagated',
    parameters: prior,
    state: !drainReady ? 'surface-only-no-drain-credit' : calibrated ? 'calibrated-range' : 'exploratory-range-not-calibrated',
    disclaimer: !drainReady
      ? 'Surface-only conservative screening: no local drain capacity was assumed, so pooling may be overstated. Use this to identify where water could collect, not as an exact street-depth prediction.'
      : calibrated
        ? 'Range uses a depth-scale parameter fitted on separate training observations and checked against held-out local observations; live conditions can still differ.'
        : 'Screening band only: no independent local depth calibration supports centimetre-level accuracy. Treat the range as an uncertainty envelope, not a street-depth measurement.',
  };
}

module.exports = { simulateSurfaceSpill, DEFAULT_SURFACE_PRIOR, depthBand };
