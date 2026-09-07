'use strict';

// Builds location-specific surface parameters from mapped urban geometry.
// These are still proxies: roads/buildings come from OSM and background soil
// infiltration is not a field survey. The important difference from the old
// model is that runoff, roughness and drain exchange are no longer uniform over
// the whole neighbourhood.

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function distancePointToSegmentM(point, a, b, latitude) {
  const scaleX = 111320 * Math.cos(latitude * Math.PI / 180), scaleY = 110540;
  const px = (point.lon - a.lon) * scaleX, py = (point.lat - a.lat) * scaleY;
  const bx = (b.lon - a.lon) * scaleX, by = (b.lat - a.lat) * scaleY;
  const denom = bx * bx + by * by;
  const t = denom > 0 ? clamp((px * bx + py * by) / denom, 0, 1) : 0;
  return Math.hypot(px - bx * t, py - by * t);
}

function distanceToGeometryM(cell, geometry = [], latitude = cell.latitude) {
  if (!geometry.length) return Infinity;
  const point = { lat: cell.latitude, lon: cell.longitude };
  let best = Infinity;
  for (let index = 1; index < geometry.length; index += 1) {
    const a = { lat: Number(geometry[index - 1].lat ?? geometry[index - 1][1]), lon: Number(geometry[index - 1].lon ?? geometry[index - 1][0]) };
    const b = { lat: Number(geometry[index].lat ?? geometry[index][1]), lon: Number(geometry[index].lon ?? geometry[index][0]) };
    if (![a.lat, a.lon, b.lat, b.lon].every(Number.isFinite)) continue;
    best = Math.min(best, distancePointToSegmentM(point, a, b, latitude));
  }
  return best;
}

function pointInPolygon(cell, geometry = []) {
  if (geometry.length < 3) return false;
  const x = cell.longitude, y = cell.latitude;
  let inside = false;
  for (let i = 0, j = geometry.length - 1; i < geometry.length; j = i++) {
    const xi = Number(geometry[i].lon ?? geometry[i][0]), yi = Number(geometry[i].lat ?? geometry[i][1]);
    const xj = Number(geometry[j].lon ?? geometry[j][0]), yj = Number(geometry[j].lat ?? geometry[j][1]);
    if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
    const crosses = ((yi > y) !== (yj > y)) && x < (xj - xi) * (y - yi) / Math.max(1e-12, yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

function roadWidthM(highway) {
  return ({ motorway: 18, trunk: 16, primary: 14, secondary: 12, tertiary: 10, residential: 7, service: 5, unclassified: 6 })[highway] || 6;
}

function buildSpatialSurfaceFields({ raster, runoffContext = {}, drainSegments = [], baseImperviousPct = 60 } = {}) {
  if (!raster?.cells?.length) return { raster, stats: { available: false } };
  const buildings = runoffContext.buildingFeatures || [];
  const roads = runoffContext.roadFeatures || [];
  const water = runoffContext.waterFeatures || [];
  const backgroundImpervious = clamp(Number(baseImperviousPct || 60) / 100 * .68, .18, .72);
  let buildingCells = 0, roadCells = 0, waterCells = 0, drainCells = 0;
  let drainWeightSum = 0;

  for (const row of raster.cells) for (const cell of row) {
    let landClass = 'background';
    let imperviousFraction = backgroundImpervious;
    let manningN = .055;
    let infiltrationMmHr = 12;

    const building = buildings.find((item) => pointInPolygon(cell, item.geometry || []));
    if (building) {
      landClass = 'building'; imperviousFraction = .98; manningN = .085; infiltrationMmHr = .2; buildingCells += 1;
    } else {
      const road = roads.find((item) => distanceToGeometryM(cell, item.geometry || []) <= roadWidthM(item.highway) / 2 + raster.cellM * .38);
      if (road) {
        landClass = 'road'; imperviousFraction = .95; manningN = .018; infiltrationMmHr = .5; roadCells += 1;
      } else {
        const waterFeature = water.find((item) => pointInPolygon(cell, item.geometry || []) || distanceToGeometryM(cell, item.geometry || []) <= raster.cellM * .55 || (item.center && Math.hypot((item.center.lat - cell.latitude) * 110540, (item.center.lon - cell.longitude) * 108500) <= raster.cellM));
        if (waterFeature) {
          landClass = 'water'; imperviousFraction = 1; manningN = .028; infiltrationMmHr = 0; waterCells += 1;
        }
      }
    }

    let drainWeight = 0;
    for (const segment of drainSegments || []) {
      const geometry = (segment.points || []).map(([lon, lat]) => ({ lat, lon }));
      const distanceM = distanceToGeometryM(cell, geometry);
      if (distanceM <= 70) drainWeight = Math.max(drainWeight, Math.exp(-((distanceM / 28) ** 2)));
    }
    if (drainWeight > .01) { drainCells += 1; drainWeightSum += drainWeight; }
    Object.assign(cell, { landClass, imperviousFraction, manningN, infiltrationMmHr, drainWeight });
  }

  return {
    raster,
    stats: {
      available: true,
      method: 'OSM geometry-conditioned surface fields',
      backgroundImperviousFraction: backgroundImpervious,
      buildingCells, roadCells, waterCells, drainCells, drainWeightSum,
      limitations: 'OSM geometry and engineering surface classes; not surveyed kerbs, soil or inlet inventory',
    },
  };
}

module.exports = { buildSpatialSurfaceFields, distanceToGeometryM, pointInPolygon, roadWidthM };
