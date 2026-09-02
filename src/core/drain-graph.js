'use strict';

// The GCC layer publishes drain polylines, not a surveyed network topology.
// This module keeps that distinction explicit: every link is either an observed
// same-node junction or an inferred candidate, never a silently "known" pipe.

const METRES_PER_LAT = 110540;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function distanceM(a, b) {
  const latitude = ((a[1] + b[1]) / 2) * Math.PI / 180;
  return Math.hypot((a[0] - b[0]) * 111320 * Math.cos(latitude), (a[1] - b[1]) * METRES_PER_LAT);
}

function endpoints(segment) {
  const points = segment.points || [];
  if (points.length < 2) return null;
  const start = points[0], end = points[points.length - 1];
  const hasInverts = Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM);
  if (!hasInverts) return { inlet: start, outlet: end, direction: 'unknown', invertConfidence: 0 };
  const startsHigher = segment.invertStartM >= segment.invertEndM;
  return {
    inlet: startsHigher ? start : end,
    outlet: startsHigher ? end : start,
    direction: startsHigher ? 'start-to-end' : 'end-to-start',
    invertConfidence: 1,
  };
}

function buildDrainGraph(segments, { junctionToleranceM = 4, candidateToleranceM = 18 } = {}) {
  const usable = segments.filter((segment) => endpoints(segment));
  const nodes = [];
  const findOrCreateNode = (coordinate) => {
    const existing = nodes.find((node) => distanceM(node.coordinate, coordinate) <= junctionToleranceM);
    if (existing) return existing.id;
    const node = { id: `node-${nodes.length + 1}`, coordinate, observedGeometry: true, degree: 0 };
    nodes.push(node); return node.id;
  };
  const links = usable.map((segment) => {
    const shape = endpoints(segment);
    const inletNodeId = findOrCreateNode(shape.inlet), outletNodeId = findOrCreateNode(shape.outlet);
    return {
      id: segment.id, inletNodeId, outletNodeId, direction: shape.direction,
      invertConfidence: shape.invertConfidence, lengthM: segment.lengthM,
      observedGeometry: true, observedDimensions: Boolean(segment.widthObserved && segment.depthObserved),
      surveyedConnectivity: false,
    };
  });
  const candidates = [];
  for (const from of usable) {
    const fromEnds = endpoints(from);
    for (const to of usable) {
      if (from.id === to.id) continue;
      const toEnds = endpoints(to);
      const gapM = distanceM(fromEnds.outlet, toEnds.inlet);
      if (gapM > candidateToleranceM) continue;
      const inverted = Number.isFinite(from.invertEndM) && Number.isFinite(to.invertStartM)
        ? Math.abs(from.invertEndM - to.invertStartM) : null;
      const endpointScore = 1 - gapM / candidateToleranceM;
      const elevationScore = inverted == null ? .35 : clamp(1 - inverted / 1.5, 0, 1);
      const confidence = clamp(.15 + endpointScore * .55 + elevationScore * .3, 0, .95);
      candidates.push({ fromId: from.id, toId: to.id, gapM: Math.round(gapM * 10) / 10, invertDifferenceM: inverted, confidence, kind: gapM <= junctionToleranceM ? 'coincident-endpoints' : 'proximity-inference', confirmed: false });
    }
  }
  const bestCandidates = candidates.sort((a, b) => b.confidence - a.confidence).filter((candidate, index, list) => !list.slice(0, index).some((other) => other.fromId === candidate.fromId && other.toId === candidate.toId));
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  for (const segment of segments) {
    const outgoing = bestCandidates.filter((candidate) => candidate.fromId === segment.id);
    segment.topology = {
      status: outgoing.length ? 'inferred-candidates' : 'isolated-in-public-geometry',
      confidence: outgoing.length ? Math.max(...outgoing.map((candidate) => candidate.confidence)) : 0,
      inferredDownstreamIds: outgoing.filter((candidate) => candidate.confidence >= .7).map((candidate) => candidate.toId),
      confirmedDownstreamIds: [],
    };
    // Only surveyed/confirmed connectivity may influence hydraulic propagation.
    segment.downstreamIds = segment.topology.confirmedDownstreamIds;
  }
  for (const link of links) { const segment = byId.get(link.id); nodes.find((node) => node.id === link.inletNodeId).degree += 1; nodes.find((node) => node.id === link.outletNodeId).degree += 1; if (segment) link.topologyConfidence = segment.topology.confidence; }
  return {
    nodes, links, candidates: bestCandidates,
    summary: {
      segments: usable.length, nodes: nodes.length, inferredLinks: bestCandidates.length,
      highConfidenceCandidates: bestCandidates.filter((candidate) => candidate.confidence >= .7).length,
      confirmedLinks: 0,
      status: 'public-geometry-inference-only',
    },
  };
}

module.exports = { buildDrainGraph, distanceM, endpoints };
