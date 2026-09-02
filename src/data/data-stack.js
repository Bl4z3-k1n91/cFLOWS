'use strict';

const fs = require('fs/promises');
const path = require('path');

const assets = {
  overtureBuildings: ['data', 'assets', 'overture-buildings.geojson'],
  cartoDem: ['data', 'assets', 'cartodem-30m.tif'],
  copDem: ['data', 'assets', 'cop-dem-glo-30.tif'],
  imerg: ['data', 'imerg', 'imerg-halfhourly.csv'],
  sentinelLabels: ['data', 'calibration', 'sentinel-flood-labels.geojson'],
};
const assetPath = (projectRoot, key) => path.join(projectRoot, ...assets[key]);
const exists = async (file) => { try { await fs.access(file); return true; } catch { return false; } };

function polygonAreaM2(coordinates) {
  const ring = coordinates?.[0] || []; if (ring.length < 4) return 0;
  const latitude = ring.reduce((sum, point) => sum + point[1], 0) / ring.length * Math.PI / 180;
  let twiceArea = 0;
  for (let index = 0; index < ring.length - 1; index += 1) {
    const [x1, y1] = ring[index], [x2, y2] = ring[index + 1];
    twiceArea += (x1 * 111320 * Math.cos(latitude)) * (y2 * 110540) - (x2 * 111320 * Math.cos(latitude)) * (y1 * 110540);
  }
  return Math.abs(twiceArea) / 2;
}
function featureCentre(feature) {
  const ring = feature.geometry?.type === 'Polygon' ? feature.geometry.coordinates[0] : feature.geometry?.type === 'MultiPolygon' ? feature.geometry.coordinates[0]?.[0] : [];
  if (!ring?.length) return null;
  return { latitude: ring.reduce((sum, point) => sum + point[1], 0) / ring.length, longitude: ring.reduce((sum, point) => sum + point[0], 0) / ring.length };
}
async function estimateOvertureImperviousness({ projectRoot, latitude, longitude, radiusM = 220 }) {
  const file = assetPath(projectRoot, 'overtureBuildings');
  if (!await exists(file)) return null;
  const payload = JSON.parse(await fs.readFile(file, 'utf8'));
  const features = payload.features || []; let footprintM2 = 0, buildings = 0;
  for (const feature of features) {
    const centre = featureCentre(feature); if (!centre) continue;
    const distance = Math.hypot((centre.latitude - latitude) * 110540, (centre.longitude - longitude) * 108500);
    if (distance > radiusM) continue;
    footprintM2 += polygonAreaM2(feature.geometry.coordinates); buildings += 1;
  }
  if (!buildings) return { source: 'Overture building footprints (local subset)', buildings: 0, imperviousPct: 35, fresh: false, coverage: 'no buildings found in imported subset' };
  const area = Math.PI * radiusM ** 2;
  return { source: 'Overture building footprints (local subset)', buildings, footprintM2, imperviousPct: Math.max(35, Math.min(94, 28 + footprintM2 / area * 100)), fresh: true, coverage: 'building-footprint estimate' };
}
async function getDataStackStatus(projectRoot) {
  const available = await Promise.all(Object.keys(assets).map(async (key) => [key, await exists(assetPath(projectRoot, key))]));
  const files = Object.fromEntries(available);
  return {
    files,
    sources: [
      { name: 'GCC storm-water drains', resolution: 'feature-level attributes', access: 'live public GIS', state: 'live' },
      { name: 'Overture buildings + roads', resolution: 'building/road vectors', access: 'anonymous local subset', state: files.overtureBuildings ? 'ready' : 'import-needed' },
      { name: 'CartoDEM / Copernicus GLO-30', resolution: 'about 30 m', access: 'local raster import', state: files.cartoDem || files.copDem ? 'ready' : 'import-needed' },
      { name: 'NASA GPM IMERG', resolution: 'about 10 km / 30 min', access: 'local replay import', state: files.imerg ? 'ready' : 'import-needed' },
      { name: 'Sentinel-1 flood labels', resolution: 'about 10 m event extent', access: 'local label import', state: files.sentinelLabels ? 'ready' : 'import-needed' },
    ],
  };
}

module.exports = { getDataStackStatus, estimateOvertureImperviousness, assetPath };
