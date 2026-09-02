const $ = (selector) => document.querySelector(selector);
const layers = { drains: '.drain-layer', flow: '.flow-layer', depth: '.depth-layer', assets: '.asset-layer' };
let running = false, speed = 1, pumpActive = false;
let pilotMap;
let drainOverlay;
let swmmOverlay;
let reportOverlay;
let latestRun;
let reportLocation;
let swmmCard;
let scenarioMap;
let scenarioMarker;
let scenarioPoint = { latitude: 12.9768, longitude: 80.2205, label: 'Velachery / Pallikaranai' };
let scenarioRasterOverlay;
let latestScenario;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
function setBootDetail(message) { const detail = document.querySelector('#bootDetail'); if (detail) detail.textContent = message; }
function finishBoot() { document.body.classList.remove('booting'); document.querySelector('#bootScreen')?.remove(); }

function inlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');
}

function renderAssistantMarkdown(message) {
  const lines = String(message || '').replace(/\r/g, '').split('\n');
  let html = '', index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\s*\|.+\|\s*$/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1] || '')) {
      const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((cell) => inlineMarkdown(cell.trim()));
      const header = cells(line); index += 2; const rows = [];
      while (index < lines.length && /^\s*\|.+\|\s*$/.test(lines[index])) { rows.push(cells(lines[index])); index += 1; }
      html += `<div class="chat-table-wrap"><table class="chat-table"><thead><tr>${header.map((cell) => `<th>${cell}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${header.map((_, cellIndex) => `<td>${row[cellIndex] || ''}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      continue;
    }
    if (/^#{1,3}\s+/.test(line)) { html += `<h3>${inlineMarkdown(line.replace(/^#{1,3}\s+/, ''))}</h3>`; index += 1; continue; }
    if (/^\s*[-*]\s+/.test(line)) { html += `<li>${inlineMarkdown(line.replace(/^\s*[-*]\s+/, ''))}</li>`; index += 1; continue; }
    if (!line.trim()) { index += 1; continue; }
    html += `<p>${inlineMarkdown(line)}</p>`; index += 1;
  }
  return html || '<p>No response returned.</p>';
}

function addConversationMessage(role, message, pending = false, question = '') {
  const log = document.querySelector('#conversationLog');
  if (!log) return null;
  const bubble = document.createElement('div');
  bubble.className = `conversation-message ${role}${pending ? ' pending' : ''}`;
  bubble.innerHTML = role === 'assistant' ? renderAssistantMarkdown(message) : escapeHtml(message);
  log.replaceChildren();
  if (question) {
    const asked = document.createElement('span'); asked.className = 'conversation-query'; asked.textContent = question;
    log.append(asked);
  }
  log.append(bubble);
  return bubble;
}

function mountConversation() {
  if (document.querySelector('#conversationPanel')) return;
  const panel = document.createElement('section');
  panel.id = 'conversationPanel';
  panel.innerHTML = '<div class="conversation-title"><span></span><b>Ask cFLOWS</b><small>Live evidence, plain answers</small></div><div id="conversationLog" class="conversation-log" aria-live="polite"><div class="conversation-message assistant">Ask a question or describe what you see on the road.</div></div><form id="conversationForm" class="conversation-form"><input id="conversationInput" aria-label="Message cFLOWS" placeholder="Is it safe near Velachery?" autocomplete="off"><button type="submit">Ask</button></form><p class="conversation-hint">Try: “Knee-high water near Taramani Link Road.”</p>';
  $('.workspace').after(panel);
  panel.querySelector('form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = panel.querySelector('input'); const message = input.value.trim(); if (!message) return;
    input.value = ''; input.disabled = true;
    const pending = addConversationMessage('assistant', 'Checking live rain, drains and field reports…', true, message);
    try {
      const response = await window.neer.converse(message);
      if (response.run) {
        updateDecision(response.run);
        if (drainOverlay) drainOverlay.remove();
        drainOverlay = window.L.geoJSON(response.run.geojson, { style: { color: '#16718a', weight: 1.6, opacity: .48 }, interactive: false }).addTo(pilotMap);
        if (response.run.focus) pilotMap.setView([response.run.focus.latitude, response.run.focus.longitude], 13);
      }
      pending.textContent = response.answer; pending.classList.remove('pending');
    } catch (error) {
      pending.textContent = `I could not process that message. Nothing was recorded. ${error.message}`;
      pending.classList.remove('pending');
    } finally { input.disabled = false; input.focus(); }
  });
}

function updateDecision(run) {
  latestRun = run;
  const decision = run.decision || {};
  const card = document.querySelector('.plain-map-card');
  if (card) {
    card.querySelector('.answer-label').textContent = `Flood decision · ${decision.state || 'loading'}`;
    card.querySelector('b').textContent = decision.headline || 'Evidence is loading';
    card.querySelector('p').textContent = decision.explanation || 'Checking the available rainfall and field evidence.';
    card.querySelector('em').textContent = `Next step: ${decision.action || 'wait'} · Confidence ${Math.round((decision.confidence || 0) * 100)}%`;
  }
  const rain = run.rainfall || {};
  $('#rainAmount').textContent = Number(rain.mmHr || 0).toFixed(1);
  $('#riskNumber').textContent = String((run.predictions || []).filter((prediction) => prediction.severity === 'critical').length);
  $('#confidenceValue').textContent = Number(decision.confidence || 0).toFixed(2);
  const guide = document.querySelector('#citizenGuide');
  if (guide) {
    const monitor = decision.state === 'monitor';
    guide.querySelector('[data-guide-state]').textContent = monitor ? 'RIGHT NOW · LOW FLOOD RISK' : `RIGHT NOW · ${String(decision.state || 'CHECKING').toUpperCase()}`;
    guide.querySelector('[data-guide-title]').textContent = monitor ? 'Safe to travel, based on current evidence.' : (decision.headline || 'Check the latest local evidence.');
    guide.querySelector('[data-guide-detail]').textContent = monitor ? 'No active flooding evidence is available for this area. Conditions can change quickly after heavy rain.' : (decision.explanation || 'We are checking rain, drains and reports.');
    guide.querySelector('[data-guide-action]').textContent = monitor ? 'If you see standing water, report it on the map so nearby people get a better answer.' : `Next step: ${decision.action || 'keep checking live evidence'}.`;
    guide.querySelector('[data-guide-rain]').textContent = `${Number(rain.mmHr || 0).toFixed(1)} mm/h now`;
    guide.querySelector('[data-guide-place]').textContent = run.focus?.label || 'Current map area';
  }
  $('.page-head .subhead').textContent = `${rain.source || 'Rainfall feed'}: ${Number(rain.mmHr || 0).toFixed(1)} mm/h. ${decision.explanation || ''}`;
  $('#simulateButton').textContent = 'Refresh live evidence';
  if (run.focus?.label) $('.map-card h2').textContent = `Drains near ${run.focus.label}`;
  const ledgerGrid = document.querySelector('#ledgerDialog .ledger-grid');
  if (ledgerGrid && run.dataSources) ledgerGrid.innerHTML = run.dataSources.map((source) => `<div><span>${escapeHtml(source.name)} · ${escapeHtml(source.state)}</span><b>${escapeHtml(source.detail)}</b><small>${source.fetchedAt ? new Date(source.fetchedAt).toLocaleString() : 'No live endpoint connected'}</small></div>`).join('');
  renderSwmmResult(run);
  if (pilotMap) {
    if (reportOverlay) reportOverlay.remove();
    reportOverlay = window.L.layerGroup((run.reports || []).map((report) => window.L.circleMarker([report.latitude, report.longitude], { radius: 7, color: '#9b3c2f', weight: 2, fillColor: '#ef806a', fillOpacity: .88 }).bindPopup(`<b>Water report</b><br>${Math.round(report.depthM * 100)} cm observed<br><small>${new Date(report.timestamp).toLocaleString()}</small>`))).addTo(pilotMap);
  }
}

function mountCitizenGuide() {
  const aside = document.querySelector('.side-stack');
  if (!aside) return;
  aside.innerHTML = '<article class="card citizen-guide" id="citizenGuide"><span class="guide-state" data-guide-state>RIGHT NOW · CHECKING</span><h2 data-guide-title>Checking whether it is safe to travel.</h2><p data-guide-detail>We are comparing live rainfall, mapped drains and nearby reports.</p><div class="guide-facts"><div><span>Area</span><b data-guide-place>Velachery / Pallikaranai</b></div><div><span>Rain now</span><b data-guide-rain>Checking…</b></div></div><p class="guide-action" data-guide-action>Wait for the latest evidence.</p><button class="guide-report" type="button">Report water you can see</button></article><article class="card citizen-watch"><p class="kicker">WHAT THE APP CHECKS</p><ol><li><b>Rain now and next 6 hours</b><span>Public forecast, refreshed on demand.</span></li><li><b>Mapped Chennai drains</b><span>Real GCC geometry, not drawn lines.</span></li><li><b>Reports from people nearby</b><span>Your observation can trigger a fresh check.</span></li></ol></article>';
  aside.querySelector('.guide-report').onclick = () => toast('Click the exact point on the map where you can see water.');
}

function mountScenarioView() {
  if (document.querySelector('#scenarioView')) return;
  const view = document.createElement('section');
  view.id = 'scenarioView';
  view.innerHTML = '<div class="scenario-head"><div><p class="kicker">WHAT-IF FLOOD SCENARIO</p><h1>What happens if the rain gets worse?</h1><p>Choose rain intensity, tap a street, then inspect a two-tier projection: drain hydraulics first, surface spill second. This never changes the live-nowcast answer.</p></div><button class="ghost scenario-back">← Back to live nowcast</button></div><div class="scenario-layout"><aside class="scenario-controls"><label for="rainScenario">Rainfall intensity</label><div class="scenario-rain"><output id="scenarioRainValue">80</output><span>mm/h</span></div><input id="rainScenario" type="range" min="0" max="250" value="80" step="5"><div class="scenario-presets"><button data-rain="25">Light<br><small>25</small></button><button data-rain="80" class="active">Heavy<br><small>80</small></button><button data-rain="150">Extreme<br><small>150</small></button></div><div class="scenario-place"><span>Selected place</span><b id="scenarioPlace">Velachery / Pallikaranai</b><small>Click anywhere on the map to move the projection.</small></div><button id="runScenario" class="scenario-run">Run flood scenario</button><div class="scenario-validation" id="scenarioValidation">Calibration check: loading only when you run the scenario.</div><p class="scenario-disclaimer">A scenario is not a warning. It never treats inferred drain links as confirmed pipes.</p></aside><div class="scenario-map-wrap"><div id="scenarioMap"></div><div class="scenario-map-note">Click a place to inspect it</div></div><article class="street-projection"><span class="street-label">STREET-LEVEL FLOOD PROJECTION</span><div class="street-scene" id="streetScene"><div class="street-buildings"><i></i><i></i><i></i></div><div class="street-road"><span class="road-mark"></span><div class="street-water" id="streetWater"></div><span class="water-ripple r1"></span><span class="water-ripple r2"></span></div><div class="street-person"><span></span><i></i></div><div class="street-empty" id="streetEmpty">Run a scenario to see the projected waterline.</div></div><h2 id="streetDepthTitle">Choose rain and a place</h2><p id="streetDepthDetail">The waterline is an indicative surface projection, not a live camera feed.</p><div class="street-source" id="streetSource">No public street image requested yet.</div></article></div>';
  document.querySelector('main').append(view);
  const slider = view.querySelector('#rainScenario');
  const setRain = (value) => { slider.value = value; view.querySelector('#scenarioRainValue').textContent = value; view.querySelectorAll('[data-rain]').forEach((button) => button.classList.toggle('active', Number(button.dataset.rain) === Number(value))); };
  slider.oninput = () => setRain(slider.value);
  view.querySelectorAll('[data-rain]').forEach((button) => button.onclick = () => setRain(button.dataset.rain));
  view.querySelector('.scenario-back').onclick = () => setScenarioMode(false);
  view.querySelector('#runScenario').onclick = () => runScenario(Number(slider.value));
  const controls = view.querySelector('.scenario-controls');
  const playback = document.createElement('div'); playback.className = 'scenario-playback'; playback.innerHTML = '<b>Flood timeline</b><div><button type="button" id="scenarioPlay">Play</button><input id="scenarioTime" type="range" min="0" max="0" value="0" disabled></div><small id="scenarioTimeLabel">Run a scenario to inspect the first 2 hours.</small><button type="button" id="scenarioExport" disabled>Export evidence JSON</button><button type="button" id="scenarioSaved">Show saved runs</button>';
  controls.append(playback);
  playback.querySelector('#scenarioPlay').onclick = () => playScenarioTimeline();
  playback.querySelector('#scenarioTime').oninput = (event) => paintScenarioFrame(Number(event.target.value));
  playback.querySelector('#scenarioExport').onclick = () => exportScenarioEvidence();
  playback.querySelector('#scenarioSaved').onclick = async () => { const runs = await window.neer.listScenarioRuns(); document.querySelector('#streetSource').textContent = runs.length ? `${runs.length} saved scenario run(s). Latest: ${runs[0].location?.label || 'selected location'}, ${runs[0].scenario?.rainfallMmHr} mm/h, ${new Date(runs[0].createdAt).toLocaleString()}.` : 'No saved scenario runs yet.'; };
  scenarioMap = window.L.map('scenarioMap', { zoomControl: true, attributionControl: true }).setView([scenarioPoint.latitude, scenarioPoint.longitude], 13);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(scenarioMap);
  scenarioMarker = window.L.marker([scenarioPoint.latitude, scenarioPoint.longitude], { draggable: true }).addTo(scenarioMap);
  const selectPoint = async (latlng) => { scenarioPoint = { latitude: latlng.lat, longitude: latlng.lng, label: `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}` }; scenarioMarker.setLatLng(latlng); view.querySelector('#scenarioPlace').textContent = scenarioPoint.label; if (latestScenario?.raster?.raster) { try { const inspected = await window.neer.inspectScenarioPoint({ raster: latestScenario.raster, latitude: latlng.lat, longitude: latlng.lng }); document.querySelector('#streetSource').textContent = `Point inspection: ${inspected.depthCm} cm in the selected raster cell; terrain ${inspected.elevationM.toFixed(1)} m. ${inspected.note}`; } catch { /* selected location remains usable */ } } };
  scenarioMap.on('click', (event) => selectPoint(event.latlng));
  scenarioMarker.on('dragend', () => selectPoint(scenarioMarker.getLatLng()));
}

function rasterColour(depth) { if (depth >= .8) return '#b83b4f'; if (depth >= .4) return '#e17755'; if (depth >= .15) return '#eab64e'; if (depth >= .05) return '#43a8b8'; return '#4fc2d022'; }
function paintScenarioFrame(frameIndex) {
  const raster = latestScenario?.raster; const map = scenarioMap; if (!raster?.raster || !map || !window.L) return;
  const frame = raster.frames?.[frameIndex] || raster.frames?.at(-1); if (!frame) return;
  if (scenarioRasterOverlay) scenarioRasterOverlay.remove();
  const cells = raster.raster.cells.flat(), cellM = raster.raster.cellM, latitude = raster.raster.latitude;
  scenarioRasterOverlay = window.L.layerGroup(cells.map((cell, index) => {
    const latSpan = cellM / 110540 / 2, lonSpan = cellM / (111320 * Math.cos(latitude * Math.PI / 180)) / 2, depth = frame.depthsM[index] || 0;
    return window.L.rectangle([[cell.latitude - latSpan, cell.longitude - lonSpan], [cell.latitude + latSpan, cell.longitude + lonSpan]], { stroke: false, fillColor: rasterColour(depth), fillOpacity: depth >= .05 ? .47 : .05, interactive: false });
  })).addTo(map);
  const label = document.querySelector('#scenarioTimeLabel'); if (label) label.textContent = `${frame.minute} minutes · max ${Math.round((raster.stats?.maxDepthM || 0) * 100)} cm · continuity error ${(raster.stats?.continuityErrorPct || 0).toFixed(2)}%`;
}
function playScenarioTimeline() {
  const raster = latestScenario?.raster; const control = document.querySelector('#scenarioTime'); if (!raster?.frames?.length || !control) return;
  let index = Number(control.value || 0); const play = document.querySelector('#scenarioPlay'); play.disabled = true;
  const tick = () => { index = (index + 1) % raster.frames.length; control.value = index; paintScenarioFrame(index); if (index === 0) { play.disabled = false; return; } setTimeout(tick, 460); };
  tick();
}
function exportScenarioEvidence() {
  if (!latestScenario) return;
  const payload = { exportedAt: new Date().toISOString(), location: scenarioPoint, runId: latestScenario.runId, rainfallMmHr: latestScenario.rainfallMmHr, surface: latestScenario.surface, networkSwmm: latestScenario.networkSwmm, raster: { status: latestScenario.raster?.status, stats: latestScenario.raster?.stats, elevationSource: latestScenario.raster?.elevationSource }, disclaimer: latestScenario.disclaimer };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); link.download = `${payload.runId || 'cflows-scenario'}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function setScenarioMode(enabled) {
  document.body.classList.toggle('scenario-mode', enabled);
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', enabled ? button.dataset.view === 'scenarios' : button.dataset.view === 'nowcast'));
  if (enabled) { mountScenarioView(); setTimeout(() => scenarioMap?.invalidateSize(), 40); }
}

async function runScenario(rainfallMmHr) {
  const button = document.querySelector('#runScenario');
  const title = document.querySelector('#streetDepthTitle');
  const detail = document.querySelector('#streetDepthDetail');
  const source = document.querySelector('#streetSource');
  button.disabled = true; button.textContent = 'Running SWMM…'; title.textContent = 'Calculating the scenario…';
  try {
    const result = await window.neer.simulateScenario({ ...scenarioPoint, rainfallMmHr });
    const scenario = result.scenario; const surface = scenario.surface; const depthCm = Math.round(surface.centralDepthM * 100);
    latestScenario = scenario;
    const rangeLow = Math.round(surface.depthRangeM.low * 100), rangeHigh = Math.round(surface.depthRangeM.high * 100);
    const water = document.querySelector('#streetWater');
    water.style.height = `${Math.min(77, 8 + surface.centralDepthM * 78)}%`;
    document.querySelector('#streetScene').classList.toggle('has-water', depthCm > 0);
    document.querySelector('#streetEmpty').textContent = depthCm ? '' : 'This rainfall scenario does not project standing road water at this point.';
    title.textContent = depthCm ? `${surface.calibrated ? 'Projected' : 'Illustrative'} road-water range: ${rangeLow}–${rangeHigh} cm` : 'No standing road water projected';
    const drain = scenario.selectedDrain;
    detail.textContent = `${rainfallMmHr} mm/h at ${scenarioPoint.label}. Tier 1 ran SWMM on ${drain?.label || 'the nearest mapped drain'}${drain?.snappedDistanceM != null ? ` (${Math.round(drain.snappedDistanceM)} m away)` : ''}. Tier 2 estimates surface spill after drain headroom. ${scenario.disclaimer}`;
    const photo = scenario.streetPhoto;
    const safePhotoUrl = photo?.available && /^https?:\/\//i.test(photo.url || '') ? photo.url : null;
    const scene = document.querySelector('#streetScene');
    scene.classList.toggle('has-photo', Boolean(safePhotoUrl));
    scene.style.backgroundImage = safePhotoUrl ? `linear-gradient(rgba(8,36,40,.08), rgba(8,36,40,.08)), url("${safePhotoUrl.replace(/"/g, '%22')}")` : '';
    const graph = result.graph?.summary || {}; const topology = drain?.topology;
    const networkText = `${scenario.modelScope}; ${graph.inferredLinks || 0} inferred links across this map window, ${graph.confirmedLinks || 0} confirmed public links. This drain's topology confidence: ${Math.round((topology?.confidence || 0) * 100)}%. Built-form runoff proxy: ${Math.round(scenario.runoff?.imperviousPct || 0)}% impervious.`;
    source.textContent = photo?.available ? `Public KartaView street photo available nearby (${photo.distanceM ? `${Math.round(photo.distanceM)} m` : 'distance unknown'}). ${networkText}` : `No public street photo is available nearby. ${networkText}`;
    const calibration = result.calibration || {};
    document.querySelector('#scenarioValidation').textContent = calibration.isCalibrated
      ? `Calibration check: ${calibration.labelCount} matched labels available. This range is eligible for held-out evaluation.`
      : `Calibration gate: blocked — ${calibration.labelCount || 0} matched flood labels. ${calibration.conclusion || 'Depth accuracy is not claimed.'}`;
    const time = document.querySelector('#scenarioTime'); const exportButton = document.querySelector('#scenarioExport');
    if (scenario.raster?.frames?.length) { time.disabled = false; time.max = scenario.raster.frames.length - 1; time.value = scenario.raster.frames.length - 1; paintScenarioFrame(Number(time.value)); }
    if (exportButton) exportButton.disabled = false;
  } catch (error) { title.textContent = 'Scenario could not run'; detail.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Run flood scenario'; }
}

function renderSwmmResult(run) {
  const swmm = run.swmm;
  if (swmmCard) {
    const drain = swmm?.representativeDrain;
    const flooded = Number(swmm?.maxFloodVolumeM3 || 0) > 0;
    swmmCard.classList.toggle('has-flooding', flooded);
    swmmCard.querySelector('[data-swmm-state]').textContent = swmm?.solved ? 'EPA SWMM · ran now' : 'EPA SWMM · blocked';
    swmmCard.querySelector('[data-swmm-title]').textContent = swmm?.solved
      ? (flooded ? `${swmm.maxFloodVolumeM3.toFixed(1)} m³ ponded in this prototype` : 'No node flooding in the 2-hour run')
      : 'The hydraulic run is waiting for missing inputs';
    swmmCard.querySelector('[data-swmm-detail]').textContent = drain
      ? `${drain.label} · ${drain.lengthM.toFixed(0)} m · ${drain.widthM.toFixed(2)} m wide`
      : (swmm?.error || 'No GCC drain with complete surveyed attributes was returned.');
    swmmCard.querySelector('[data-swmm-note]').textContent = swmm?.solved
      ? `${swmm.audit?.observed?.length || 0} observed inputs · ${swmm.audit?.assumptions?.length || 0} assumptions exposed`
      : 'Open the evidence ledger to see what is missing.';
  }
  if (!pilotMap || !window.L || !swmm?.solved || !swmm.representativeDrain?.id) return;
  if (swmmOverlay) swmmOverlay.remove();
  const featureId = String(swmm.representativeDrain.id).replace(/^gcc-/, '');
  const feature = (run.geojson?.features || []).find((item) => String(item.properties?.objectid) === featureId);
  if (!feature) return;
  const flooded = Number(swmm.maxFloodVolumeM3 || 0) > 0;
  swmmOverlay = window.L.geoJSON(feature, {
    interactive: false,
    style: { color: flooded ? '#df5f4a' : '#08b8c6', weight: 6, opacity: .98, dashArray: '13 16', className: flooded ? 'swmm-flow-line flooded' : 'swmm-flow-line' },
  }).addTo(pilotMap);
}

function setupReportDialog() {
  const dialog = document.createElement('dialog');
  dialog.id = 'reportDialog';
  dialog.innerHTML = '<form method="dialog" class="report-sheet"><button class="report-close" value="cancel" aria-label="Close">×</button><p class="kicker">FIELD EVIDENCE</p><h2>How deep is the water here?</h2><p>Choose the visible depth at the point you selected. This is recorded as an unverified field report and can trigger an inspection—not an automatic pump dispatch.</p><div class="depth-choices"><button type="button" data-depth="0.08">Ankle<br><small>~8 cm</small></button><button type="button" data-depth="0.28">Knee<br><small>~28 cm</small></button><button type="button" data-depth="0.55">Wheel-high<br><small>~55 cm</small></button></div><span class="report-location"></span></form>';
  document.body.append(dialog);
  dialog.querySelectorAll('[data-depth]').forEach((button) => button.onclick = async () => {
    if (!reportLocation) return;
    button.disabled = true;
    try {
      await window.neer.addFieldReport({ latitude: reportLocation.lat, longitude: reportLocation.lng, depthM: Number(button.dataset.depth) });
      dialog.close(); toast('Field evidence recorded. Refreshing the decision.'); await runActualNowcast();
    } catch (error) { toast(`Could not save field report: ${error.message}`); button.disabled = false; }
  });
  return dialog;
}

function openReportDialog(latlng) {
  reportLocation = latlng;
  const dialog = document.querySelector('#reportDialog') || setupReportDialog();
  dialog.querySelector('.report-location').textContent = `Selected point: ${latlng.lat.toFixed(5)}, ${latlng.lng.toFixed(5)}`;
  dialog.showModal();
}

function initialiseBasemap() {
  setBootDetail('Loading the map, then checking public drain geometry and live evidence.');
  mountCitizenGuide();
  const mapNode = document.createElement('div');
  mapNode.id = 'liveMap';
  $('.map-frame').prepend(mapNode);
  const leaflet = document.createElement('script');
  leaflet.src = '../node_modules/leaflet/dist/leaflet.js';
  leaflet.onload = () => {
    const map = window.L.map('liveMap', { zoomControl: false, attributionControl: true, scrollWheelZoom: false }).setView([12.9768, 80.2205], 13);
    pilotMap = map;
    window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    window.L.control.zoom({ position: 'bottomright' }).addTo(map);
    const reportControl = window.L.control({ position: 'bottomright' });
    reportControl.onAdd = () => {
      const node = window.L.DomUtil.create('button', 'report-map-button');
      node.type = 'button'; node.textContent = 'Report water seen';
      window.L.DomEvent.disableClickPropagation(node);
      node.onclick = () => toast('Click the point on the map where you can see water.');
      return node;
    };
    reportControl.addTo(map);
    pilotMap.on('click', (event) => openReportDialog(event.latlng));
    mountConversation();
    document.querySelector('[data-view="scenarios"]')?.addEventListener('click', () => setScenarioMode(true));
    document.querySelector('[data-view="nowcast"]')?.addEventListener('click', () => setScenarioMode(false));
    loadActualDrainNetwork();
  };
  document.head.append(leaflet);
}

async function loadActualDrainNetwork() {
  if (!window.neer || !pilotMap) return;
  try {
    setBootDetail('Checking GCC drain geometry, rainfall and field reports…');
    const run = await window.neer.runPilot({});
    if (drainOverlay) drainOverlay.remove();
    drainOverlay = window.L.geoJSON(run.geojson, {
      style: { color: '#16718a', weight: 1.6, opacity: .48 }, interactive: false,
    }).addTo(pilotMap);
    document.body.classList.add('real-map');
    const plainLanguageControl = window.L.control({ position: 'topleft' });
    plainLanguageControl.onAdd = () => {
      const node = window.L.DomUtil.create('div');
      node.innerHTML = '<div class="plain-map-card"><span class="answer-label">Flood decision · loading</span><b>Checking the latest evidence…</b><p>Loading rainfall, real drain geometry and field reports.</p><em>No action yet.</em></div>';
      return node;
    };
    plainLanguageControl.addTo(pilotMap);
    const swmmControl = window.L.control({ position: 'topright' });
    swmmControl.onAdd = () => {
      const node = window.L.DomUtil.create('div', 'swmm-map-card');
      node.innerHTML = '<span data-swmm-state>EPA SWMM · waiting</span><b data-swmm-title>Preparing hydraulic run…</b><p data-swmm-detail>Finding a GCC drain with geometry and invert levels.</p><em data-swmm-note>Only observed data can unlock the run.</em>';
      window.L.DomEvent.disableClickPropagation(node); swmmCard = node; return node;
    };
    swmmControl.addTo(pilotMap);
    $('.page-head .kicker').textContent = 'CHENNAI · VELACHERY / PALLIKARANAI';
    $('.page-head h1').textContent = 'Will this area flood soon?';
    $('.page-head .subhead').textContent = 'The map shows where water can drain. We only issue a flood answer when live rain and water-level evidence agree.';
    $('.map-card h2').textContent = 'Drains near Velachery';
    $('.map-card .card-head p').innerHTML = '<span class="map-live"></span> Real Greater Chennai Corporation drain geometry · pan and zoom to explore';
    updateDecision(run);
    finishBoot();
    toast(run.drainFeed?.state === 'unavailable' ? 'GCC geometry is unavailable. The app is in evidence-needed mode.' : `${run.drainCount} GCC drain features ready. ${run.reports.length} local field report(s) in the ledger.`);
  } catch (error) {
    document.body.classList.add('real-map');
    $('.page-head h1').textContent = 'Live evidence is unavailable';
    $('.page-head .subhead').textContent = 'cFLOWS did not receive enough public data to produce a flood answer.';
    finishBoot();
    $('#simulateButton').textContent = 'GCC GIS unavailable';
    toast(`Could not load GCC drains: ${error.message}`);
  }
}

async function runActualNowcast() {
  if (!window.neer) return toast('Desktop data bridge is unavailable.');
  $('#simulateButton').textContent = 'Loading real drain inputs…';
  try {
    const run = await window.neer.runPilot({});
    if (drainOverlay) drainOverlay.remove();
    drainOverlay = window.L.geoJSON(run.geojson, { style: { color: '#16718a', weight: 1.6, opacity: .48 }, interactive: false }).addTo(pilotMap);
    document.body.classList.add('real-map');
    updateDecision(run);
    toast(`${run.decision.headline} — ${run.decision.action}.`);
  } catch (error) {
    $('#simulateButton').textContent = 'Run nowcast';
    toast(`Nowcast stopped: ${error.message}`);
  }
}
function toast(message) { const n = $('#toast'); n.textContent = message; n.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => n.classList.remove('show'), 2700); }
function updateTime(value) { const offset = Number(value) - 58, minutes = 510 + offset, time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; $('#timelineNow').textContent = time; $('#rainTime').textContent = `${time} IST`; $('#rainAmount').textContent = Math.max(35, Math.round(92 - Math.abs(offset) * .68)); if (!pumpActive) $('#riskNumber').textContent = Math.max(1, Math.min(5, Math.round((Number(value) - 22) / 21))); $('#confidenceValue').textContent = (.88 - Math.abs(offset) / 500).toFixed(2); }
function setRunning(value) { running = value; $('#simulateButton').textContent = value ? 'Running nowcast…' : 'Run nowcast'; $('#playButton').textContent = value ? 'Ⅱ' : '▶'; }
function simulatePump() { pumpActive = !pumpActive; $('.critical-pool').style.opacity = pumpActive ? '.26' : '.65'; $('#riskNumber').textContent = pumpActive ? '1' : '3'; $('#incidentDepth').textContent = pumpActive ? '0.27 m predicted · avoided' : '0.62 m predicted · 18 min'; $('#urgentPill').textContent = pumpActive ? '1 urgent' : '2 urgent'; $('#compareButton').textContent = pumpActive ? 'Reset baseline →' : 'Simulate Pump P-04 →'; toast(pumpActive ? 'Pump P-04 cuts S-17 depth by 0.35 m.' : 'Baseline risk restored.'); }
$('#simulateButton').onclick = runActualNowcast;
$('#playButton').onclick = () => setRunning(!running);
$('#timeSlider').oninput = (e) => updateTime(e.target.value);
$('#speedButton').onclick = () => { speed = speed === 1 ? 2 : speed === 2 ? 4 : 1; $('#speedButton').textContent = `${speed}×`; };
document.querySelectorAll('.map-toggle').forEach((b) => b.onclick = () => { b.classList.toggle('active'); if (b.dataset.layer === 'drains' && drainOverlay) { b.classList.contains('active') ? drainOverlay.addTo(pilotMap) : drainOverlay.remove(); return; } document.querySelector(layers[b.dataset.layer]).style.display = b.classList.contains('active') ? '' : 'none'; });
const ledger = $('#ledgerDialog'); ['#sourcesButton', '#openLedger', '#explainButton'].forEach((s) => $(s).onclick = () => ledger.showModal()); $('[data-close]').onclick = () => ledger.close();
$('#incidentButton').onclick = () => toast('S-17: surface spill expected at 08:48 IST.');
if ($('#dispatchButton')) $('#dispatchButton').onclick = () => toast('Operational plan opened: Pump P-04 is the first dispatch.');
if ($('#compareButton')) $('#compareButton').onclick = simulatePump;
document.querySelectorAll('.inline-action').forEach((b) => b.onclick = () => { const pump = b.dataset.action === 'pump'; b.textContent = pump ? 'Queued ✓' : 'Sent ✓'; if (pump && !pumpActive) simulatePump(); toast(pump ? 'Pump P-04 queued from Velachery depot.' : 'Bus control alert sent.'); });
setInterval(() => { if (!running) return; const input = $('#timeSlider'); let value = Number(input.value) + speed; if (value > 120) value = 0; input.value = value; updateTime(value); }, 650);
updateTime(58);
initialiseBasemap();
