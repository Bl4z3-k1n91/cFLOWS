'use strict';

const GCC_DRAIN_QUERY = 'https://gisgcc.chennaicorporation.gov.in/server/rest/services/GCCDepts/GCC_COLLABORATION_LAYER/MapServer/8/query';
const CFM_BASE_URL = 'https://chennaifloodmonitor.tn.gov.in';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchGccDrainsForEnvelope({ west, south, east, north }) {
  const query = new URLSearchParams({
    where: '1=1', outFields: 'objectid,location,drain_wid,drain_dep,drain_type,status,invert_sp,invert_ep,water_flow',
    geometry: `${west},${south},${east},${north}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', f: 'geojson', returnGeometry: 'true',
  });
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const signal = AbortSignal.timeout(18_000);
    try {
      const response = await fetch(`${GCC_DRAIN_QUERY}?${query}`, { signal, headers: { Accept: 'application/geo+json,application/json;q=0.9,*/*;q=0.8' } });
      if (!response.ok) throw new Error(`GCC drain GIS request failed: ${response.status}`);
      return response.json();
    } catch (error) { lastError = error; if (attempt < 2) await wait(350 * (attempt + 1)); }
  }
  throw new Error(`GCC drain GIS unreachable after 3 attempts: ${lastError?.cause?.code || lastError?.message || 'unknown network error'}`);
}

async function fetchGdeltFloodSignals(query = 'Chennai flood OR waterlogging', maxrecords = 20) {
  const params = new URLSearchParams({ query, mode: 'artlist', format: 'json', maxrecords: String(maxrecords), sort: 'HybridRel' });
  const response = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`);
  if (!response.ok) throw new Error(`GDELT request failed: ${response.status}`);
  const payload = await response.json();
  return (payload.articles || []).map((article) => ({ title: article.title, url: article.url, publishedAt: article.seendate, sourceReliability: .45 }));
}

async function fetchGoogleNewsFloodSignals(query = 'Chennai flood OR waterlogging', maxrecords = 12) {
  const params = new URLSearchParams({ q: query, hl: 'en-IN', gl: 'IN', ceid: 'IN:en' });
  const response = await fetch(`https://news.google.com/rss/search?${params}`);
  if (!response.ok) throw new Error(`News RSS request failed: ${response.status}`);
  const xml = await response.text();
  const entries = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, maxrecords);
  const pick = (item, tag) => item.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`))?.[1]?.trim() || '';
  return entries.map((entry) => ({ title: pick(entry[1], 'title').replace(/\s+-\s+[^-]+$/, ''), url: pick(entry[1], 'link'), publishedAt: pick(entry[1], 'pubDate'), sourceReliability: .4, source: 'Google News RSS' }));
}

async function fetchOpenMeteoRainfall({ latitude = 12.9768, longitude = 80.2205 } = {}) {
  const params = new URLSearchParams({ latitude: String(latitude), longitude: String(longitude), current: 'precipitation,rain,weather_code', hourly: 'precipitation,precipitation_probability,weather_code', forecast_hours: '6', timezone: 'Asia/Kolkata' });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!response.ok) throw new Error(`Rainfall feed request failed: ${response.status}`);
  const payload = await response.json();
  const observedAt = payload.current?.time ? new Date(payload.current.time).toISOString() : null;
  const ageMs = observedAt ? Date.now() - new Date(observedAt).getTime() : Infinity;
  const forecast = (payload.hourly?.time || []).slice(0, 6).map((time, index) => ({ time, mm: Number(payload.hourly?.precipitation?.[index] || 0), probability: Number(payload.hourly?.precipitation_probability?.[index] || 0), weatherCode: payload.hourly?.weather_code?.[index] }));
  return { source: 'Open-Meteo current precipitation', mmHr: Number(payload.current?.precipitation || payload.current?.rain || 0), weatherCode: payload.current?.weather_code, forecast, observedAt, fetchedAt: new Date().toISOString(), fresh: ageMs >= -15 * 60 * 1000 && ageMs <= 45 * 60 * 1000 };
}

async function fetchCfmForecastRuns() {
  const response = await fetch(`${CFM_BASE_URL}/Master/GetRun_Deteministic?source=ECMWF&controlormax=Control`, {
    headers: { Referer: `${CFM_BASE_URL}/HomePage/Dashboard`, 'X-Requested-With': 'XMLHttpRequest', Accept: 'application/json, text/javascript, */*; q=0.01' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`CFM public forecast-run request failed: ${response.status}`);
  const raw = await response.json();
  const runs = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!Array.isArray(runs) || !runs.length) throw new Error('CFM returned no forecast runs.');
  return { source: 'Tamil Nadu CFM-DSS public ECMWF run catalogue', latestRun: runs[0], runs: runs.slice(0, 12), fetchedAt: new Date().toISOString(), fresh: true, access: 'public catalogue; station-value endpoint is separately access-controlled' };
}

async function fetchChennaiMarineBoundary() {
  // Offshore grid cell, not a harbour gauge. This is useful only as a modelled
  // downstream boundary signal and is deliberately never presented as observed tide.
  const params = new URLSearchParams({ latitude: '13.05', longitude: '80.32', current: 'sea_level_height_msl', hourly: 'sea_level_height_msl', forecast_hours: '6', timezone: 'Asia/Kolkata' });
  const response = await fetch(`https://marine-api.open-meteo.com/v1/marine?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`Marine boundary request failed: ${response.status}`);
  const payload = await response.json();
  const levelM = Number(payload.current?.sea_level_height_msl);
  const hourly = (payload.hourly?.time || []).slice(0, 6).map((time, index) => ({ time, levelM: Number(payload.hourly?.sea_level_height_msl?.[index]) })).filter((item) => Number.isFinite(item.levelM));
  if (!Number.isFinite(levelM) && !hourly.length) throw new Error('Marine boundary response had no sea-level values.');
  const values = [levelM, ...hourly.map((item) => item.levelM)].filter(Number.isFinite);
  const low = Math.min(...values), high = Math.max(...values);
  const position = Number.isFinite(levelM) && high > low ? (levelM - low) / (high - low) : .5;
  return { source: 'Open-Meteo marine model sea-level boundary', observed: false, levelM: Number.isFinite(levelM) ? levelM : hourly[0]?.levelM, nextSixHours: hourly, restriction: 'offshore model grid; not a Chennai harbour gauge or navigation tide', outfallRestriction: position >= .7 ? 'elevated' : position <= .3 ? 'favourable' : 'neutral', capacityMultiplier: position >= .7 ? .78 : position <= .3 ? 1 : .9, fetchedAt: new Date().toISOString(), fresh: true };
}

async function fetchOpenElevation({ latitude, longitude }) {
  const query = new URLSearchParams({ locations: `${latitude},${longitude}` });
  const response = await fetch(`https://api.open-elevation.com/api/v1/lookup?${query}`);
  if (!response.ok) throw new Error(`Elevation request failed: ${response.status}`);
  const elevation = Number((await response.json()).results?.[0]?.elevation);
  if (!Number.isFinite(elevation)) throw new Error('Elevation response had no usable value.');
  return { source: 'Open-Elevation terrain sample', elevationM: elevation, fetchedAt: new Date().toISOString(), fresh: true };
}

async function fetchOpenElevationGrid({ latitude, longitude, radiusM = 480, count = 5 }) {
  const points = [];
  for (let row = 0; row < count; row += 1) for (let col = 0; col < count; col += 1) {
    const north = radiusM - row * (radiusM * 2 / (count - 1)), east = -radiusM + col * (radiusM * 2 / (count - 1));
    points.push({ latitude: latitude + north / 110540, longitude: longitude + east / (111320 * Math.cos(latitude * Math.PI / 180)) });
  }
  const locations = points.map((point) => `${point.latitude},${point.longitude}`).join('|');
  const response = await fetch(`https://api.open-elevation.com/api/v1/lookup?${new URLSearchParams({ locations })}`);
  if (!response.ok) throw new Error(`Elevation grid request failed: ${response.status}`);
  const results = (await response.json()).results || [];
  const samples = results.map((result, index) => ({ ...points[index], elevationM: Number(result.elevation) })).filter((point) => Number.isFinite(point.elevationM));
  if (samples.length < 9) throw new Error('Elevation service returned too few terrain samples for the raster.');
  return { source: 'Open-Elevation sparse 5×5 terrain samples', samples, radiusM, fresh: true, fetchedAt: new Date().toISOString() };
}

async function geocodeChennai(place) {
  const query = new URLSearchParams({ q: `${place}, Chennai, Tamil Nadu, India`, format: 'jsonv2', limit: '1' });
  const response = await fetch(`https://nominatim.openstreetmap.org/search?${query}`, { headers: { 'User-Agent': 'cFLOWS-SIH-prototype/0.1' } });
  if (!response.ok) throw new Error(`Place lookup failed: ${response.status}`);
  const match = (await response.json())[0];
  if (!match) throw new Error('I could not find that Chennai location.');
  return { latitude: Number(match.lat), longitude: Number(match.lon), label: match.display_name };
}

async function fetchKartaViewStreetPhoto({ latitude, longitude, radiusM = 250 }) {
  const params = new URLSearchParams({ lat: String(latitude), lng: String(longitude), radius: String(radiusM) });
  const response = await fetch(`https://api.openstreetcam.org/2.0/photo/?${params}`);
  if (!response.ok) throw new Error(`KartaView request failed: ${response.status}`);
  const payload = await response.json();
  const candidates = payload?.result?.data || payload?.result?.photos || payload?.photos || [];
  const photo = Array.isArray(candidates) ? candidates[0] : null;
  const url = photo?.fileurl || photo?.fileUrl || photo?.url || photo?.thumb_name || photo?.thumbnailUrl || null;
  return { available: Boolean(url), url, source: 'KartaView public street imagery', distanceM: Number(photo?.distance || photo?.distanceM) || null };
}

async function fetchOsmRunoffProxy({ latitude, longitude, radiusM = 220 }) {
  const query = `[out:json][timeout:18];(way(around:${Math.round(radiusM)},${latitude},${longitude})[building];way(around:${Math.round(radiusM)},${latitude},${longitude})[highway];);out tags geom;`;
  const response = await fetch('https://overpass.kumi.systems/api/interpreter', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(query)}` });
  if (!response.ok) throw new Error(`OpenStreetMap runoff query failed: ${response.status}`);
  const payload = await response.json();
  const elements = payload.elements || [];
  const buildings = elements.filter((item) => item.tags?.building).length;
  const roads = elements.filter((item) => item.tags?.highway).length;
  // A transparent proxy, not a claimed land-cover survey. More built form
  // means more impervious runoff in the local scenario catchment.
  return { source: 'OpenStreetMap buildings + roads', buildings, roads, imperviousPct: Math.max(35, Math.min(92, 35 + buildings * 1.2 + roads * .7)), fresh: true };
}

module.exports = { fetchGccDrainsForEnvelope, fetchGdeltFloodSignals, fetchGoogleNewsFloodSignals, fetchOpenMeteoRainfall, fetchCfmForecastRuns, fetchChennaiMarineBoundary, fetchOpenElevation, fetchOpenElevationGrid, geocodeChennai, fetchKartaViewStreetPhoto, fetchOsmRunoffProxy, GCC_DRAIN_QUERY };
