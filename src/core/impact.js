'use strict';

function nearestRasterCell(rasterRun, latitude, longitude) {
  const cells = rasterRun?.raster?.cells?.flat?.() || [];
  if (!cells.length || !Number.isFinite(Number(latitude)) || !Number.isFinite(Number(longitude))) return null;
  return cells.reduce((closest, cell) => {
    if (!closest) return cell;
    const current = Math.hypot(cell.latitude - latitude, cell.longitude - longitude);
    const best = Math.hypot(closest.latitude - latitude, closest.longitude - longitude);
    return current < best ? cell : closest;
  }, null);
}

function depthBand(depthM) {
  const depth = Math.max(0, Number(depthM) || 0);
  if (depth < .05) return { level: 0, label: 'no meaningful ponding in this screening' };
  if (depth < .15) return { level: 1, label: 'some ponding possible' };
  if (depth < .4) return { level: 2, label: 'waterlogging could affect movement' };
  return { level: 3, label: 'deep water could make access unsafe' };
}

function geometryDepth(rasterRun, geometry = []) {
  let maximum = 0;
  for (const point of geometry) {
    const cell = nearestRasterCell(rasterRun, Number(point.lat), Number(point.lon));
    if (cell) maximum = Math.max(maximum, Number(cell.depthM) || 0);
  }
  return maximum;
}

function assessInfrastructureImpact({ rasterRun, roadFeatures = [], facilityFeatures = [], waterFeatures = [] } = {}) {
  if (!rasterRun?.raster?.cells) return { available: false, state: 'withheld-no-surface-raster', roads: [], facilities: [], water: [] };
  const roads = roadFeatures.map((road) => {
    const maxDepthM = geometryDepth(rasterRun, road.geometry || []);
    const band = depthBand(maxDepthM);
    return { id: road.id, name: road.name || 'Unnamed road', highway: road.highway || null, maxDepthM, level: band.level, band: band.label };
  }).filter((road) => road.level > 0).sort((a, b) => b.level - a.level || b.maxDepthM - a.maxDepthM).slice(0, 8);
  const facilities = facilityFeatures.map((facility) => {
    const cell = nearestRasterCell(rasterRun, facility.latitude, facility.longitude);
    const maxDepthM = Number(cell?.depthM) || 0;
    const band = depthBand(maxDepthM);
    return { ...facility, maxDepthM, level: band.level, band: band.label };
  }).filter((facility) => facility.level > 0).sort((a, b) => b.level - a.level || b.maxDepthM - a.maxDepthM).slice(0, 8);
  const water = waterFeatures.slice(0, 12).map((item) => ({ id: item.id, name: item.name || 'Unnamed water feature', kind: item.kind || 'water', note: 'Mapped context only; overflow is not calculated without reviewed stage/storage data.' }));
  const hotspotCells = rasterRun.raster.cells.flat().filter((cell) => Number(cell.depthM) >= .05).sort((a, b) => Number(b.depthM) - Number(a.depthM)).slice(0, 5).map((cell) => ({ latitude: cell.latitude, longitude: cell.longitude, band: depthBand(cell.depthM).label, approximateDepthM: Math.round(Number(cell.depthM) * 10) / 10 }));
  return {
    available: true,
    state: 'screening-only',
    roads,
    facilities,
    water,
    hotspotCells,
    affectedRoadCount: roads.length,
    atRiskFacilityCount: facilities.length,
    disclaimer: 'Impact ranking is derived from the same sparse-terrain screening raster. It is not a road-closure notice or observed facility flooding.',
  };
}

module.exports = { assessInfrastructureImpact, depthBand, nearestRasterCell };
