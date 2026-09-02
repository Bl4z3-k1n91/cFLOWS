'use strict';

const GCC_DRAIN_QUERY = 'https://gisgcc.chennaicorporation.gov.in/server/rest/services/GCCDepts/GCC_COLLABORATION_LAYER/MapServer/8/query';

async function fetchGccDrainsForEnvelope({ west, south, east, north }) {
  const query = new URLSearchParams({
    where: '1=1', outFields: 'objectid,location,drain_wid,drain_dep,drain_type,status,invert_sp,invert_ep,water_flow',
    geometry: `${west},${south},${east},${north}`, geometryType: 'esriGeometryEnvelope', inSR: '4326', spatialRel: 'esriSpatialRelIntersects', outSR: '4326', f: 'geojson', returnGeometry: 'true',
  });
  const response = await fetch(`${GCC_DRAIN_QUERY}?${query}`);
  if (!response.ok) throw new Error(`GCC drain GIS request failed: ${response.status}`);
  return response.json();
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

async function fetchOpenElevation({ latitude, longitude }) {
  const query = new URLSearchParams({ locations: `${latitude},${longitude}` });
  const response = await fetch(`https://api.open-elevation.com/api/v1/lookup?${query}`);
  if (!response.ok) throw new Error(`Elevation request failed: ${response.status}`);
  const elevation = Number((await response.json()).results?.[0]?.elevation);
  if (!Number.isFinite(elevation)) throw new Error('Elevation response had no usable value.');
  return { source: 'Open-Elevation terrain sample', elevationM: elevation, fetchedAt: new Date().toISOString(), fresh: true };
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

module.exports = { fetchGccDrainsForEnvelope, fetchGdeltFloodSignals, fetchGoogleNewsFloodSignals, fetchOpenMeteoRainfall, fetchOpenElevation, geocodeChennai, fetchKartaViewStreetPhoto, fetchOsmRunoffProxy, GCC_DRAIN_QUERY };
