'use strict';

// HydroGraph is intentionally explainable. It estimates risk on each drain link,
// then propagates surcharge pressure downstream through the drainage graph.
// All inputs carry provenance and freshness outside this module; news is only
// corroborating evidence and cannot dominate a hydraulic prediction.

const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const sigmoid = (value) => 1 / (1 + Math.exp(-value));
const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function evidenceFromReports(reports = [], now = Date.now()) {
  const relevant = reports
    .filter((report) => Number.isFinite(report.depthM) && Number.isFinite(report.confidence))
    .map((report) => ({
      depth: clamp(report.depthM / 0.8),
      reliability: clamp(report.confidence) * Math.exp(-Math.max(0, now - new Date(report.timestamp).getTime()) / (45 * 60 * 1000)),
    }));
  return clamp(mean(relevant.map((report) => report.depth * report.reliability)));
}

function evidenceFromNews(items = [], now = Date.now()) {
  // A news hit receives a deliberately small maximum weight. It must be both
  // location-matched and flood-related; it never substitutes for a sensor.
  const relevant = items.filter((item) => item.locationMatched && item.floodRelated);
  return clamp(mean(relevant.map((item) => clamp(item.sourceReliability || 0.5) * Math.exp(-Math.max(0, now - new Date(item.publishedAt).getTime()) / (4 * 60 * 60 * 1000)))) * 0.08, 0, 0.08);
}

function localPrediction(segment, context, now) {
  const width = Math.max(.3, Number(segment.widthM || .6));
  const depth = Math.max(.3, Number(segment.depthM || .75));
  const slope = Math.max(.0001, Number(segment.slope || .001));
  const condition = clamp(Number(segment.conditionScore ?? .75));
  const rainfall = clamp(Number(context.rainfallMmHr || 0) / 120);
  const upstream = clamp(Number(segment.upstreamLevelRatio || 0));
  const downstream = clamp(Number(segment.downstreamLevelRatio || 0));
  const lowVelocity = 1 - clamp(Number(segment.velocityMs || .45) / 1.2);
  const suspendedSolids = clamp(Number(segment.suspendedSolidsNtu || 0) / 350);
  const lowElevation = 1 - clamp(Number(segment.elevationPercentile ?? .5));
  const history = clamp(Number(segment.historicalFloodFrequency ?? 0));
  const reports = evidenceFromReports(context.reportsBySegment?.[segment.id], now);
  const news = evidenceFromNews(context.newsBySegment?.[segment.id], now);
  const headDifference = clamp(upstream - downstream, -1, 1);
  const hydraulicCapacityIndex = clamp((width * depth * Math.sqrt(slope) * condition) / .045);
  const overload = clamp(rainfall - hydraulicCapacityIndex + upstream * .45);

  // Blockage requires the characteristic upstream/downstream split. Sediment
  // and low velocity increase likelihood, while reports corroborate it.
  const blockageProbability = sigmoid(
    -3.0 + 2.8 * headDifference + 1.25 * lowVelocity + 1.15 * suspendedSolids +
    1.1 * overload + .8 * history + 1.8 * reports + news
  );
  const floodProbability = clamp(
    .33 * blockageProbability + .28 * overload + .14 * lowElevation + .15 * history + .08 * reports + news
  );
  const confidence = clamp(.25 + .22 * Boolean(context.rainfallSourceFresh) + .22 * Boolean(segment.hasLevelSensor) + .18 * Boolean(segment.hasVelocitySensor) + .13 * (reports > 0 ? 1 : 0));
  const reasons = [];
  if (headDifference > .28) reasons.push('water is higher upstream than downstream');
  if (lowVelocity > .58) reasons.push('flow velocity is unusually low');
  if (suspendedSolids > .45) reasons.push('suspended-solids load is elevated');
  if (overload > .25) reasons.push('rainfall exceeds estimated drain headroom');
  if (history > .45) reasons.push('this segment has repeated historical inundation');
  if (reports > .1) reasons.push('recent field reports corroborate surface water');
  return { id: segment.id, label: segment.label || segment.id, blockageProbability, floodProbability, confidence, overload, reasons, localEvidence: { reports, news, headDifference, hydraulicCapacityIndex } };
}

function predictDrainageNetwork({ segments, context = {}, now = Date.now() }) {
  const local = new Map(segments.map((segment) => [segment.id, localPrediction(segment, context, now)]));
  const upstreamOf = new Map(segments.map((segment) => [segment.id, []]));
  for (const segment of segments) for (const downstreamId of segment.downstreamIds || []) if (upstreamOf.has(downstreamId)) upstreamOf.get(downstreamId).push(segment.id);
  const results = new Map();
  for (const segment of segments) {
    const base = local.get(segment.id);
    const upstreamPressure = mean((upstreamOf.get(segment.id) || []).map((id) => local.get(id).floodProbability));
    const propagatedRisk = clamp(base.floodProbability + .18 * upstreamPressure);
    const severity = propagatedRisk >= .7 ? 'critical' : propagatedRisk >= .4 ? 'watch' : 'normal';
    results.set(segment.id, { ...base, floodProbability: propagatedRisk, severity, action: severity === 'critical' ? 'inspect blockage and pre-position pump' : severity === 'watch' ? 'inspect inlet and monitor' : 'monitor' });
  }
  return [...results.values()].sort((a, b) => b.floodProbability - a.floodProbability);
}

function isFloodNews(item, pilotTokens = ['velachery', 'pallikaranai', 'taramani', 'chennai']) {
  const text = `${item.title || ''} ${item.summary || ''}`.toLowerCase();
  return { ...item, floodRelated: /flood|waterlog|inundat|heavy rain|drainage/.test(text), locationMatched: pilotTokens.some((token) => text.includes(token)) };
}

module.exports = { predictDrainageNetwork, isFloodNews, evidenceFromReports, evidenceFromNews };
