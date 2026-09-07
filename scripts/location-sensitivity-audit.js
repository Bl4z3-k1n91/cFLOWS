'use strict';

const { fetchTerrariumElevationGrid, fetchOpenElevationGrid, fetchOsmRunoffProxy } = require('../src/data/sources');
const { makeRaster, runRasterSpill, summarizeRasterPooling } = require('../src/core/raster-spill');
const { buildSpatialSurfaceFields } = require('../src/core/spatial-surface');
const { runSurfaceEnsemble } = require('../src/core/surface-ensemble');

const points = [
  { name: 'Old Pallavaram', latitude: 12.9581, longitude: 80.1766 },
  { name: 'Velachery', latitude: 12.9824, longitude: 80.2090 },
  { name: 'Pallikaranai', latitude: 12.9418, longitude: 80.2156 },
  { name: 'Taramani', latitude: 12.9866, longitude: 80.2432 },
  { name: 'Nanganallur', latitude: 12.9802, longitude: 80.1882 },
];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const rows = [];
  for (const point of points) {
    let elevation;
    try { elevation = await fetchTerrariumElevationGrid({ latitude: point.latitude, longitude: point.longitude, radiusM: 480, spacingM: 30 }); }
    catch { elevation = await fetchOpenElevationGrid({ latitude: point.latitude, longitude: point.longitude, radiusM: 480, count: 9 }); }
    let osm = null;
    try { osm = await fetchOsmRunoffProxy({ latitude: point.latitude, longitude: point.longitude, radiusM: 480 }); }
    catch (error) { osm = { imperviousPct: null, roadFeatures: [], buildingFeatures: [], waterFeatures: [], error: error.message }; }
    const hasImpervious = osm?.imperviousPct !== null && osm?.imperviousPct !== undefined && osm?.imperviousPct !== '' && Number.isFinite(Number(osm.imperviousPct));
    const imperviousPct = hasImpervious ? Number(osm.imperviousPct) : 60;
    const terrain = makeRaster({ latitude: point.latitude, longitude: point.longitude, elevationSamples: elevation.samples });
    const fields = buildSpatialSurfaceFields({ raster: terrain, runoffContext: osm, drainSegments: [], baseImperviousPct: imperviousPct });
    const central = runRasterSpill({ raster: structuredClone(fields.raster), rainfallMmHr: 80, durationMinutes: 120, imperviousPct, drainRemovalMmHr: 0 });
    const spatial = summarizeRasterPooling(central, point.latitude, point.longitude);
    const ensemble = runSurfaceEnsemble({ raster: fields.raster, latitude: point.latitude, longitude: point.longitude, rainfallMmHr: 80, durationMinutes: 120, imperviousPct, drainRemovalMmHr: 0 });
    rows.push({
      ...point,
      elevationMinM: Math.min(...elevation.samples.map((item) => item.elevationM)),
      elevationMaxM: Math.max(...elevation.samples.map((item) => item.elevationM)),
      terrainSource: elevation.source,
      terrainSamples: elevation.samples.length,
      imperviousPct: hasImpervious ? Math.round(Number(osm.imperviousPct) * 10) / 10 : null,
      osmError: osm.error || null,
      spatialBand: spatial.depthBand,
      centralSelectedCm: Math.round(spatial.selectedDepthM * 100),
      floodedAreaPct: Math.round(spatial.floodedFraction * 100),
      ensembleBand: ensemble.consensusBand,
      ensembleP10Cm: Math.round(ensemble.selectedDepthM.p10 * 100),
      ensembleP50Cm: Math.round(ensemble.selectedDepthM.p50 * 100),
      ensembleP90Cm: Math.round(ensemble.selectedDepthM.p90 * 100),
      ensembleAtLeast15cm: ensemble.exceedance.atLeast15cm,
      ensembleAtLeast40cm: ensemble.exceedance.atLeast40cm,
      members: ensemble.memberCount,
    });
    await wait(900);
  }
  console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => { console.error(error); process.exit(1); });
