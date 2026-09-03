'use strict';

const regions = [
  { id: 'pallikaranai-kovalam', label: 'Pallikaranai–Kovalam drainage corridor', bounds: [80.12, 12.84, 80.31, 13.05], outfall: 'Kovalam / Buckingham Canal coastal corridor', outfallPoint: [80.27, 12.91] },
  { id: 'adyar', label: 'Adyar river basin', bounds: [80.08, 12.94, 80.29, 13.12], outfall: 'Adyar estuary', outfallPoint: [80.28, 13.00] },
  { id: 'cooum', label: 'Cooum river basin', bounds: [80.08, 13.05, 80.30, 13.20], outfall: 'Cooum estuary', outfallPoint: [80.29, 13.08] },
  { id: 'north-chennai', label: 'North Chennai coastal drainage corridor', bounds: [80.14, 13.15, 80.35, 13.33], outfall: 'Kosasthalaiyar / Ennore coastal corridor', outfallPoint: [80.31, 13.22] },
];

function distanceM(latitude, longitude, point) {
  return Math.hypot((longitude - point[0]) * 111320 * Math.cos(latitude * Math.PI / 180), (latitude - point[1]) * 110540);
}

function resolveChennaiContext({ latitude, longitude, marineBoundary = null } = {}) {
  const region = regions.find((item) => longitude >= item.bounds[0] && longitude <= item.bounds[2] && latitude >= item.bounds[1] && latitude <= item.bounds[3]) || null;
  if (!region) return { status: 'outside-mapped-regional-context', source: 'public regional drainage context', disclaimer: 'No regional Chennai corridor was assigned for this point.' };
  const outfallDistanceM = distanceM(latitude, longitude, region.outfallPoint);
  return {
    status: 'regional-context-only', source: 'public regional drainage context', catchment: region.label, outfall: region.outfall, outfallDistanceM: Math.round(outfallDistanceM),
    connection: 'regional routing context only; this does not prove that a selected drain connects to this outfall',
    marineBoundary: marineBoundary ? { source: marineBoundary.source, levelM: marineBoundary.levelM, restriction: marineBoundary.outfallRestriction, observed: marineBoundary.observed, restrictionNote: marineBoundary.restriction } : { status: 'unavailable' },
  };
}

module.exports = { resolveChennaiContext };
