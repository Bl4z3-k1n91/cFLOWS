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
let scenarioDrainOverlay;
let scenarioRoadOverlay;
let scenarioWaterOverlay;
let scenarioFacilityOverlay;
let latestScenario;
let scenarioInspectMode = false;
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const hasNumericValue = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
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
    card.querySelector('.answer-label').textContent = `CURRENT ANSWER · ${String(decision.state || 'checking').toUpperCase()}`;
    card.querySelector('b').textContent = decision.headline || 'Evidence is loading';
    card.querySelector('p').textContent = decision.explanation || 'Checking the available rainfall and field evidence.';
    card.querySelector('em').textContent = `Next step: ${decision.action || 'wait'} · Confidence ${Math.round((decision.confidence || 0) * 100)}%`;
  }
  const rain = run.rainfall || {};
  $('#rainAmount').textContent = Number(rain.mmHr || 0).toFixed(1);
  $('#riskNumber').textContent = String((run.predictions || []).filter((prediction) => prediction.severity === 'critical').length);
  const decisionConfidence = Number(decision.confidence || 0);
  $('#confidenceValue').textContent = decisionConfidence >= .75 ? 'HIGH' : decisionConfidence >= .5 ? 'MEDIUM' : 'LOW';
  const guide = document.querySelector('#citizenGuide');
  if (guide) {
    const monitor = decision.state === 'monitor';
    guide.querySelector('[data-guide-state]').textContent = monitor ? 'RIGHT NOW · NO ACTIVE FLOOD EVIDENCE' : `RIGHT NOW · ${String(decision.state || 'CHECKING').toUpperCase()}`;
    guide.querySelector('[data-guide-title]').textContent = monitor ? 'Current feeds show no active flooding evidence.' : (decision.headline || 'Check the latest local evidence.');
    guide.querySelector('[data-guide-detail]').textContent = monitor ? 'This is not a travel clearance. Conditions can change quickly and unmapped street flooding may still exist.' : (decision.explanation || 'We are checking rain, drains and reports.');
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
  aside.innerHTML = '<article class="card citizen-guide" id="citizenGuide"><span class="guide-state" data-guide-state>RIGHT NOW · CHECKING</span><h2 data-guide-title>Checking current flood evidence.</h2><p data-guide-detail>We are comparing live rainfall, mapped drains and nearby reports.</p><div class="guide-facts"><div><span>Area</span><b data-guide-place>Velachery / Pallikaranai</b></div><div><span>Rain now</span><b data-guide-rain>Checking…</b></div></div><p class="guide-action" data-guide-action>Wait for the latest evidence.</p><button class="guide-report" type="button">Report water you can see</button></article><article class="card citizen-watch"><p class="kicker">WHAT THE APP CHECKS</p><ol><li><b>Rain now and next 6 hours</b><span>Public forecast, refreshed on demand.</span></li><li><b>Mapped Chennai drains</b><span>Real GCC geometry, not drawn lines.</span></li><li><b>Reports from people nearby</b><span>Your observation can trigger a fresh check.</span></li></ol></article>';
  aside.querySelector('.guide-report').onclick = () => toast('Click the exact point on the map where you can see water.');
}

function mountScenarioView() {
  if (document.querySelector('#scenarioView')) return;
  const view = document.createElement('section');
  view.id = 'scenarioView';
  view.innerHTML = '<div class="scenario-head"><div><p class="kicker">WHAT IF THE RAIN GETS WORSE?</p><h1>Test a place before the storm happens</h1><p>Pick a rainfall level and a point on the map. cFLOWS will answer three things in plain language: what could happen, how sure it is, and what information is missing.</p></div><button class="ghost scenario-back">← Back to current conditions</button></div><div class="scenario-layout"><aside class="scenario-controls"><label for="rainScenario">How hard is it raining?</label><div class="scenario-rain"><output id="scenarioRainValue">80</output><span>mm/h</span></div><input id="rainScenario" type="range" min="0" max="250" value="80" step="5"><div class="scenario-presets"><button data-rain="25">Moderate<br><small>25 mm/h</small></button><button data-rain="80" class="active">Very heavy<br><small>80 mm/h</small></button><button data-rain="150">Extreme<br><small>150 mm/h</small></button></div><div class="scenario-place"><span>Place being tested</span><b id="scenarioPlace">Velachery / Pallikaranai</b><small>Click anywhere on the map to move the test point.</small></div><button id="runScenario" class="scenario-run">Check this place</button><div class="scenario-validation" id="scenarioValidation">How sure? Run the test to see what is known and missing.</div><p class="scenario-disclaimer">This is a what-if test, not a live flood warning. Never use a modelled depth as permission to enter standing water.</p></aside><div class="scenario-map-wrap"><div id="scenarioMap"></div><div class="scenario-map-note">Click a place to test it</div><div class="scenario-legend"><b>Map colours</b><span><i class="legend-blue"></i>Some ponding</span><span><i class="legend-yellow"></i>Waterlogging</span><span><i class="legend-orange"></i>Deep water possible</span><span><i class="legend-red"></i>Very deep in this model</span><small>These colours are model estimates, not observations.</small></div></div><article class="street-projection"><span class="street-label">ANSWER FOR THIS PLACE</span><div id="scenarioConfidence" class="scenario-confidence waiting"><span>HOW SURE?</span><b>Run the test</b><small>Confidence describes the quality of the inputs, not the probability of flooding.</small></div><h2 id="streetDepthTitle">Choose rain and a place</h2><p id="streetDepthDetail">We will tell you what could happen without pretending the exact water depth is known.</p><div class="scenario-knowledge" id="scenarioKnowledge"><div class="known"><b>WE KNOW</b><p>Nothing yet — run the test.</p></div><div class="estimated"><b>WE ESTIMATE</b><p>Nothing yet.</p></div><div class="unknown"><b>WE DON’T KNOW YET</b><p>Nothing yet.</p></div></div><div class="street-scene" id="streetScene"><div class="street-buildings"><i></i><i></i><i></i></div><div class="street-road"><span class="road-mark"></span><div class="street-water" id="streetWater"></div><span class="water-ripple r1"></span><span class="water-ripple r2"></span></div><div class="street-person"><span></span><i></i></div><div class="street-empty" id="streetEmpty">Run the test to see where water may collect.</div></div><details class="scenario-technical"><summary>Technical details</summary><div class="street-source" id="streetSource">No model run yet.</div></details></article></div>';
  document.querySelector('main').append(view);
  const placeBlock = view.querySelector('.scenario-place');
  const searchForm = document.createElement('form');
  searchForm.className = 'scenario-search';
  searchForm.innerHTML = '<label for="scenarioSearch">Find a road or place</label><div><input id="scenarioSearch" placeholder="e.g. Taramani Link Road or 12.97,80.21" autocomplete="off"><button type="submit">Find</button></div><small>Search stays inside Chennai. You can also enter latitude, longitude.</small>';
  placeBlock.before(searchForm);
  const stormControls = document.createElement('div');
  stormControls.className = 'scenario-storm-controls';
  stormControls.innerHTML = '<label for="scenarioDuration">How long does the storm last?</label><div class="scenario-duration"><input id="scenarioDuration" type="range" min="60" max="720" value="120" step="30"><b id="scenarioDurationValue">2 hours</b></div><span class="storm-label">How does the rain arrive?</span><div class="storm-presets"><button type="button" data-storm="steady" class="active">Steady</button><button type="button" data-storm="cloudburst">Cloudburst</button><button type="button" data-storm="building">Builds up</button><button type="button" data-storm="two-wave">Two waves</button></div><small>The number above is the peak intensity. Different storm shapes can produce different flooding even with similar totals.</small>';
  placeBlock.before(stormControls);
  const duration = stormControls.querySelector('#scenarioDuration');
  const updateDuration = () => { const minutes = Number(duration.value); stormControls.querySelector('#scenarioDurationValue').textContent = minutes % 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes / 60} hour${minutes === 60 ? '' : 's'}`; };
  duration.oninput = updateDuration;
  stormControls.querySelectorAll('[data-storm]').forEach((button) => button.onclick = () => { stormControls.querySelectorAll('[data-storm]').forEach((item) => item.classList.toggle('active', item === button)); });
  const mapWrap = view.querySelector('.scenario-map-wrap');
  const layerControls = document.createElement('div');
  layerControls.className = 'scenario-layer-controls';
  layerControls.innerHTML = '<b>Show on map</b><button type="button" data-scenario-layer="flood" class="active">Flood</button><button type="button" data-scenario-layer="drains" class="active">Drains</button><button type="button" data-scenario-layer="roads">Roads</button><button type="button" data-scenario-layer="water">Water</button><button type="button" data-scenario-layer="facilities">Important places</button>';
  mapWrap.append(layerControls);
  const projection = view.querySelector('.street-projection');
  const impactPanel = document.createElement('div');
  impactPanel.id = 'scenarioImpact'; impactPanel.className = 'scenario-impact waiting';
  impactPanel.innerHTML = '<b>WHAT COULD BE AFFECTED?</b><p>Run the test to check nearby roads and important places against the modelled flood map.</p>';
  projection.querySelector('.scenario-technical').before(impactPanel);
  const pointPanel = document.createElement('div');
  pointPanel.id = 'scenarioPointInspector'; pointPanel.className = 'scenario-point-inspector';
  pointPanel.innerHTML = '<b>MAP CLICK MODE</b><p>Map clicks move the test point by default.</p><button type="button" data-inspect-toggle>Inspect flooded cells</button><small>Turn this on only when you want to inspect coloured cells instead of choosing a new place.</small>';
  impactPanel.after(pointPanel);
  const confidenceShell = view.querySelector('#scenarioConfidence');
  confidenceShell.innerHTML = '<div class="scenario-answer-grid"><div><span>MODEL RESULT</span><b data-scenario-result>Run the test</b></div><div><span>CONFIDENCE</span><b data-scenario-confidence>—</b></div></div><small data-scenario-meaning>We will separate what the model shows from how much you should trust it.</small>';
  const quickFacts = document.createElement('div');
  quickFacts.id = 'scenarioQuickFacts'; quickFacts.className = 'scenario-quick-facts';
  quickFacts.innerHTML = '<div><span>Storm</span><b>Not run</b></div><div><span>Surface</span><b>Not run</b></div><div><span>Drain check</span><b>Not run</b></div>';
  confidenceShell.after(quickFacts);
  const driverPanel = document.createElement('div');
  driverPanel.id = 'scenarioDrivers'; driverPanel.className = 'scenario-drivers';
  driverPanel.innerHTML = '<b>WHY THE MODEL SAYS THIS</b><p>Run the test to see which inputs pushed the result up, pushed it down, or only reduced confidence.</p>';
  quickFacts.after(driverPanel);
  const slider = view.querySelector('#rainScenario');
  const setRain = (value) => { slider.value = value; view.querySelector('#scenarioRainValue').textContent = value; view.querySelectorAll('[data-rain]').forEach((button) => button.classList.toggle('active', Number(button.dataset.rain) === Number(value))); };
  slider.oninput = () => setRain(slider.value);
  view.querySelectorAll('[data-rain]').forEach((button) => button.onclick = () => setRain(button.dataset.rain));
  view.querySelector('.scenario-back').onclick = () => setScenarioMode(false);
  view.querySelector('#runScenario').onclick = () => runScenario(Number(slider.value));
  const controls = view.querySelector('.scenario-controls');
  const playback = document.createElement('div'); playback.className = 'scenario-playback'; playback.innerHTML = '<b>How water changes over 2 hours</b><div><button type="button" id="scenarioPlay">Play</button><input id="scenarioTime" type="range" min="0" max="0" value="0" disabled></div><small id="scenarioTimeLabel">Run the test to see how the modelled water changes.</small><button type="button" id="scenarioExport" disabled>Download technical evidence</button><button type="button" id="scenarioSaved">Previous tests</button>';
  controls.append(playback);
  const exportFormats = document.createElement('div'); exportFormats.className = 'scenario-export-formats'; exportFormats.innerHTML = '<button type="button" data-export-csv disabled>CSV summary</button><button type="button" data-export-geojson disabled>Flood GeoJSON</button><button type="button" data-export-print disabled>Print report</button>';
  playback.append(exportFormats);
  playback.querySelector('#scenarioPlay').onclick = () => playScenarioTimeline();
  playback.querySelector('#scenarioTime').oninput = (event) => paintScenarioFrame(Number(event.target.value));
  playback.querySelector('#scenarioExport').onclick = () => exportScenarioEvidence();
  exportFormats.querySelector('[data-export-csv]').onclick = () => exportScenarioCsv();
  exportFormats.querySelector('[data-export-geojson]').onclick = () => exportScenarioGeoJson();
  exportFormats.querySelector('[data-export-print]').onclick = () => window.print();
  playback.querySelector('#scenarioSaved').onclick = () => openScenarioLibrary();
  scenarioMap = window.L.map('scenarioMap', { zoomControl: true, attributionControl: true }).setView([scenarioPoint.latitude, scenarioPoint.longitude], 13);
  window.L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(scenarioMap);
  scenarioMarker = window.L.marker([scenarioPoint.latitude, scenarioPoint.longitude], { draggable: true }).addTo(scenarioMap);
  const setInspectMode = (enabled) => {
    scenarioInspectMode = Boolean(enabled && latestScenario?.raster?.raster);
    const inspectButton = pointPanel.querySelector('[data-inspect-toggle]');
    if (inspectButton) {
      inspectButton.classList.toggle('active', scenarioInspectMode);
      inspectButton.textContent = scenarioInspectMode ? 'Stop inspecting' : 'Inspect flooded cells';
    }
    const explanation = pointPanel.querySelector('p');
    if (explanation) explanation.textContent = scenarioInspectMode
      ? 'Inspect mode is on. Click a coloured cell to inspect that model cell.'
      : 'Map clicks move the test point by default.';
    const note = view.querySelector('.scenario-map-note');
    if (note) note.textContent = scenarioInspectMode ? 'Inspect mode · click a coloured cell' : 'Click anywhere to choose a new test point';
  };
  pointPanel.querySelector('[data-inspect-toggle]').onclick = () => setInspectMode(!scenarioInspectMode);
  const selectPoint = async (latlng) => {
    setInspectMode(false);
    scenarioPoint = { latitude: latlng.lat, longitude: latlng.lng, label: `${latlng.lat.toFixed(4)}, ${latlng.lng.toFixed(4)}` };
    scenarioMarker.setLatLng(latlng);
    view.querySelector('#scenarioPlace').textContent = scenarioPoint.label;
    if (latestScenario) {
      document.querySelector('#streetDepthTitle').textContent = 'Point changed — run the test again';
      document.querySelector('#streetDepthDetail').textContent = 'The answer on this panel belongs to the previous map point. Run again so cFLOWS does not mix results from two places.';
      document.querySelector('#scenarioConfidence').className = 'scenario-confidence waiting';
      document.querySelector('[data-scenario-result]').textContent = 'Run again';
      document.querySelector('[data-scenario-confidence]').textContent = '—';
      document.querySelector('[data-scenario-meaning]').textContent = 'The previous answer belonged to the old map point.';
      const facts = document.querySelector('#scenarioQuickFacts');
      if (facts) facts.innerHTML = '<div><span>Storm</span><b>Ready</b></div><div><span>Surface</span><b>Waiting</b></div><div><span>Drain check</span><b>Waiting</b></div>';
      const drivers = document.querySelector('#scenarioDrivers');
      if (drivers) drivers.innerHTML = '<b>WHY THE MODEL SAYS THIS</b><p>Run the test again to explain the new place.</p>';
      if (scenarioRasterOverlay) scenarioRasterOverlay.remove();
      clearScenarioContextOverlays();
      latestScenario = null;
    }
  };
  searchForm.onsubmit = async (event) => {
    event.preventDefault();
    const query = searchForm.querySelector('input').value.trim(); if (!query) return;
    const coordinate = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    try {
      const found = coordinate ? { latitude: Number(coordinate[1]), longitude: Number(coordinate[2]), label: query } : await window.neer.geocode(query);
      if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) throw new Error('No usable coordinate returned.');
      await selectPoint({ lat: found.latitude, lng: found.longitude });
      scenarioPoint.label = found.label || query;
      view.querySelector('#scenarioPlace').textContent = scenarioPoint.label;
      scenarioMap.setView([found.latitude, found.longitude], 15);
    } catch (error) { toast(`Place search failed: ${error.message}`); }
  };
  scenarioMap.on('click', async (event) => {
    if (scenarioInspectMode && latestScenario?.raster?.raster) {
      try {
        const inspected = await window.neer.inspectScenarioPoint({ raster: latestScenario.raster, latitude: event.latlng.lat, longitude: event.latlng.lng });
        const panel = document.querySelector('#scenarioPointInspector');
        panel.innerHTML = `<b>THIS SPOT ON THE MAP</b><strong>${escapeHtml(inspected.band)}</strong><p>Approximate screening depth: ~${Number(inspected.approximateDepthM || 0).toFixed(1)} m. Ground sample: ${Number(inspected.elevationM || 0).toFixed(1)} m. This is rounded model output, not measured water.</p><button type="button" data-inspect-toggle class="active">Stop inspecting</button><small>Inspect mode is still on. Stop inspecting to choose another test point.</small>`;
        panel.querySelector('[data-inspect-toggle]').onclick = () => setInspectMode(false);
        return;
      } catch { /* fall through to move the test point */ }
    }
    selectPoint(event.latlng);
  });
  scenarioMarker.on('dragend', () => selectPoint(scenarioMarker.getLatLng()));
  layerControls.querySelectorAll('[data-scenario-layer]').forEach((button) => button.onclick = () => { button.classList.toggle('active'); setScenarioLayerVisibility(button.dataset.scenarioLayer, button.classList.contains('active')); });
}

function scenarioLayerEnabled(name) { return document.querySelector(`[data-scenario-layer="${name}"]`)?.classList.contains('active') !== false; }
function setScenarioLayerVisibility(name, visible) {
  const overlays = { flood: scenarioRasterOverlay, drains: scenarioDrainOverlay, roads: scenarioRoadOverlay, water: scenarioWaterOverlay, facilities: scenarioFacilityOverlay };
  const overlay = overlays[name]; if (!overlay || !scenarioMap) return;
  if (visible) overlay.addTo(scenarioMap); else overlay.remove();
}
function clearScenarioContextOverlays() {
  for (const overlay of [scenarioDrainOverlay, scenarioRoadOverlay, scenarioWaterOverlay, scenarioFacilityOverlay]) if (overlay) overlay.remove();
  scenarioDrainOverlay = scenarioRoadOverlay = scenarioWaterOverlay = scenarioFacilityOverlay = null;
}
function drawScenarioContext(result) {
  if (!scenarioMap || !window.L) return;
  clearScenarioContextOverlays();
  const runoff = result.scenario?.runoff || {};
  scenarioDrainOverlay = window.L.geoJSON(result.geojson || { type: 'FeatureCollection', features: [] }, { interactive: false, style: { color: '#117b8c', weight: 2, opacity: .55 } });
  const roads = (runoff.roadFeatures || []).map((road) => window.L.polyline((road.geometry || []).map((point) => [point.lat, point.lon]), { color: '#5f6d73', weight: 2, opacity: .62 }).bindPopup(`<b>${escapeHtml(road.name)}</b><br><small>OpenStreetMap road</small>`));
  scenarioRoadOverlay = window.L.layerGroup(roads);
  const water = (runoff.waterFeatures || []).map((item) => {
    const coordinates = (item.geometry || []).map((point) => [point.lat, point.lon]);
    if (coordinates.length >= 2) return window.L.polyline(coordinates, { color: '#287fb8', weight: 4, opacity: .65 }).bindPopup(`<b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(item.kind)} · mapped context only; overflow needs real stage/storage data</small>`);
    if (item.center) return window.L.circleMarker([item.center.lat, item.center.lon], { radius: 5, color: '#287fb8', fillOpacity: .7 }).bindPopup(`<b>${escapeHtml(item.name)}</b>`);
    return null;
  }).filter(Boolean);
  scenarioWaterOverlay = window.L.layerGroup(water);
  const facilities = (runoff.facilityFeatures || []).map((item) => window.L.circleMarker([item.latitude, item.longitude], { radius: 5, color: '#7a3e8e', weight: 2, fillColor: '#f4d6ff', fillOpacity: .85 }).bindPopup(`<b>${escapeHtml(item.name)}</b><br><small>${escapeHtml(String(item.kind || 'important place').replace(/_/g, ' '))}</small>`));
  scenarioFacilityOverlay = window.L.layerGroup(facilities);
  for (const name of ['drains', 'roads', 'water', 'facilities']) setScenarioLayerVisibility(name, scenarioLayerEnabled(name));
}
function renderScenarioImpact(impact) {
  const panel = document.querySelector('#scenarioImpact'); if (!panel) return;
  if (!impact?.available) { panel.className = 'scenario-impact waiting'; panel.innerHTML = '<b>WHAT COULD BE AFFECTED?</b><p>Road and facility impact could not be ranked because the local surface raster was unavailable.</p>'; return; }
  const roadItems = (impact.roads || []).slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.band)}</span></li>`).join('');
  const facilityItems = (impact.facilities || []).slice(0, 4).map((item) => `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.band)}</span></li>`).join('');
  const waterItems = (impact.water || []).slice(0, 3).map((item) => escapeHtml(item.name)).join(', ');
  panel.className = 'scenario-impact';
  panel.innerHTML = `<b>WHAT COULD BE AFFECTED?</b><div class="impact-stats"><span><strong>${impact.affectedRoadCount || 0}</strong> nearby road${impact.affectedRoadCount === 1 ? '' : 's'} flagged</span><span><strong>${impact.atRiskFacilityCount || 0}</strong> important place${impact.atRiskFacilityCount === 1 ? '' : 's'} flagged</span></div>${roadItems ? `<h4>Roads to watch</h4><ul>${roadItems}</ul>` : '<p>No named nearby road crosses a materially flooded model cell.</p>'}${facilityItems ? `<h4>Important places nearby</h4><ul>${facilityItems}</ul>` : ''}${waterItems ? `<p class="impact-water"><b>Mapped water nearby:</b> ${waterItems}. cFLOWS does not claim overflow without reviewed stage/storage data.</p>` : ''}<small>${escapeHtml(impact.disclaimer || '')}</small>`;
}
function downloadScenarioFile(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type })); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); URL.revokeObjectURL(url);
}
function exportScenarioCsv() {
  if (!latestScenario) return;
  const rows = [
    ['field', 'value'], ['location', scenarioPoint.label], ['peak_rain_mm_hr', latestScenario.rainfallMmHr], ['storm_profile', latestScenario.rainfallProfile?.label || 'steady'], ['duration_minutes', latestScenario.durationMinutes || 120], ['total_rain_mm', latestScenario.rainfallProfile?.totalMm ?? ''], ['surface_band', latestScenario.surface?.depthBand || ''], ['confidence_note', latestScenario.surface?.state || ''], ['swmm_flood_volume_m3', latestScenario.networkSwmm?.totalFloodVolumeM3 || 0], ['affected_roads', latestScenario.infrastructureImpact?.affectedRoadCount || 0], ['at_risk_facilities', latestScenario.infrastructureImpact?.atRiskFacilityCount || 0],
  ];
  downloadScenarioFile(`${latestScenario.runId || 'cflows-scenario'}.csv`, rows.map((row) => row.map((value) => `"${String(value ?? '').replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
}
function exportScenarioGeoJson() {
  if (!latestScenario?.raster?.raster) return toast('No flood raster is available to export.');
  const features = latestScenario.raster.raster.cells.flat().filter((cell) => Number(cell.depthM) >= .05).map((cell) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [cell.longitude, cell.latitude] }, properties: { screeningDepthM: Math.round(Number(cell.depthM) * 10) / 10, evidence: 'modelled-sparse-terrain-screening' } }));
  downloadScenarioFile(`${latestScenario.runId || 'cflows-scenario'}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }, null, 2), 'application/geo+json');
}
async function openScenarioLibrary() {
  let dialog = document.querySelector('#scenarioLibraryDialog');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'scenarioLibraryDialog'; dialog.innerHTML = '<div class="scenario-library"><button class="modal-close" data-library-close>×</button><p class="kicker">PREVIOUS WHAT-IF TESTS</p><h2>Scenario library</h2><div class="scenario-library-actions"><label>Import cFLOWS JSON<input type="file" accept="application/json,.json" data-library-import></label></div><div data-library-list></div></div>'; document.body.append(dialog); dialog.querySelector('[data-library-close]').onclick = () => dialog.close(); dialog.querySelector('[data-library-import]').onchange = async (event) => { const file = event.target.files?.[0]; if (!file) return; try { const payload = JSON.parse(await file.text()); await window.neer.importScenarioRun(payload); await refreshScenarioLibrary(dialog); } catch (error) { toast(`Import failed: ${error.message}`); } }; }
  await refreshScenarioLibrary(dialog); dialog.showModal();
}
async function refreshScenarioLibrary(dialog) {
  const runs = await window.neer.listScenarioRuns(); const list = dialog.querySelector('[data-library-list]');
  list.innerHTML = runs.length ? runs.map((run) => `<article data-run-id="${escapeHtml(run.id)}"><div><b>${escapeHtml(run.name || run.location?.label || 'Scenario')}</b><span>${escapeHtml(run.location?.label || '')} · ${run.scenario?.rainfallMmHr ?? '?'} mm/h · ${escapeHtml(run.scenario?.rainfallProfile?.label || 'steady')}</span><small>${new Date(run.createdAt).toLocaleString()}</small></div><div><button data-run-action="rename">Rename</button><button data-run-action="duplicate">Duplicate</button><button data-run-action="delete">Delete</button></div></article>`).join('') : '<p>No saved tests yet.</p>';
  list.querySelectorAll('[data-run-action]').forEach((button) => button.onclick = async () => { const article = button.closest('[data-run-id]'); const id = article.dataset.runId; try { if (button.dataset.runAction === 'rename') { const name = prompt('New scenario name:'); if (name) await window.neer.renameScenarioRun({ id, name }); } else if (button.dataset.runAction === 'duplicate') await window.neer.duplicateScenarioRun({ id }); else if (button.dataset.runAction === 'delete' && confirm('Delete this saved scenario?')) await window.neer.deleteScenarioRun({ id }); await refreshScenarioLibrary(dialog); } catch (error) { toast(error.message); } });
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
  }));
  if (scenarioLayerEnabled('flood')) scenarioRasterOverlay.addTo(map);
  const label = document.querySelector('#scenarioTimeLabel'); if (label) label.textContent = `${frame.minute} minutes into the test · deepest modelled cell ~${(Math.round((raster.stats?.maxDepthM || 0) * 10) / 10).toFixed(1)} m · this is modelled, not measured water depth`;
}
function playScenarioTimeline() {
  const raster = latestScenario?.raster; const control = document.querySelector('#scenarioTime'); if (!raster?.frames?.length || !control) return;
  let index = Number(control.value || 0); const play = document.querySelector('#scenarioPlay'); play.disabled = true;
  const tick = () => { index = (index + 1) % raster.frames.length; control.value = index; paintScenarioFrame(index); if (index === 0) { play.disabled = false; return; } setTimeout(tick, 460); };
  tick();
}
function exportScenarioEvidence() {
  if (!latestScenario) return;
  const payload = { format: 'cflows-scenario-bundle-v1', exportedAt: new Date().toISOString(), name: `${scenarioPoint.label} · ${latestScenario.rainfallProfile?.label || 'what-if test'}`, location: scenarioPoint, scenario: latestScenario };
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); link.download = `${latestScenario.runId || 'cflows-scenario'}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function setScenarioMode(enabled) {
  document.body.classList.toggle('scenario-mode', enabled);
  document.body.classList.remove('insight-mode');
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', enabled ? button.dataset.view === 'scenarios' : button.dataset.view === 'nowcast'));
  if (enabled) { mountScenarioView(); setTimeout(() => scenarioMap?.invalidateSize(), 40); }
}

async function mountInsightView(viewName) {
  let view = document.querySelector('#insightView');
  if (!view) { view = document.createElement('section'); view.id = 'insightView'; document.querySelector('main').append(view); }
  const run = latestRun;
  if (!run) { view.innerHTML = '<div class="insight-empty"><h1>Live evidence is still loading</h1><p>Return after the first nowcast refresh.</p></div>'; return; }
  if (viewName === 'network') {
    const graph = run.graph?.summary || {};
    const observed = (run.segments || []).filter((segment) => segment.widthObserved && segment.depthObserved && Number.isFinite(segment.invertStartM) && Number.isFinite(segment.invertEndM));
    const candidates = (run.graph?.candidates || []).slice(0, 12);
    view.innerHTML = `<div class="insight-head"><p class="kicker">HOW MUCH OF THE DRAIN MAP DO WE REALLY KNOW?</p><h1>The map is real. The underground connections are not fully known.</h1><p>cFLOWS knows the public GCC drain locations and many drain sizes. It can join endpoints that visibly meet on the map for a what-if calculation, but it does not pretend those joins were surveyed underground.</p></div><div class="insight-stats"><article><span>Drains on this map</span><b>${run.segments?.length || 0}</b></article><article><span>Drains usable in hydraulics</span><b>${observed.length}</b></article><article><span>Map endpoints that meet</span><b>${graph.geometryLinks || 0}</b></article><article><span>Survey-confirmed connections</span><b>${graph.confirmedLinks || 0}</b></article></div><article class="insight-table"><h2>Connections the app thinks may exist</h2><p class="insight-explainer">These are clues for modelling and field survey, not proof of an underground connection.</p><table><thead><tr><th>Drain A</th><th>Drain B</th><th>Why they may connect</th><th>Gap</th><th>Map confidence</th></tr></thead><tbody>${candidates.map((item) => `<tr><td>${escapeHtml(item.fromId)}</td><td>${escapeHtml(item.toId)}</td><td>${escapeHtml(item.kind)}</td><td>${Number(item.gapM || 0).toFixed(1)} m</td><td>${Math.round((item.confidence || 0) * 100)}%</td></tr>`).join('') || '<tr><td colspan="5">No likely connections in the current map window.</td></tr>'}</tbody></table></article>`;
    return;
  }
  const calibration = run.calibration || {}, hindcast = calibration.hindcast || {}, metrics = hindcast.metrics || {};
  const sources = run.dataSources || [];
  const available = sources.filter((source) => ['live', 'modelled', 'validated', 'evidence-ready', 'ready', 'cached'].includes(source.state)).length;
  const scenarioRuns = await window.neer.listScenarioRuns().catch(() => []);
  const rainKnown = Boolean(run.rainfall?.fresh);
  const drainKnown = (run.segments || []).some((segment) => segment.widthObserved && segment.depthObserved);
  const waterObserved = Boolean(run.sensorSnapshot?.fresh || (run.reports || []).some((report) => report.verificationState === 'verified'));
  const depthValidated = Boolean(calibration.isCalibrated);
  const boundaryKnown = Boolean(run.downstreamBoundary?.available);
  const confidenceRows = [
    ['Current rain', rainKnown, rainKnown ? 'Fresh rainfall source is available.' : 'Current rain is stale, manual, or unavailable.'],
    ['Drain size and location', drainKnown, drainKnown ? 'Usable GCC drain geometry and dimensions are available.' : 'Local drain dimensions are incomplete.'],
    ['Water already on the ground', waterObserved, waterObserved ? 'A trusted sensor or verified local report is available.' : 'No trusted local water-level observation is available.'],
    ['Exact flood depth', depthValidated, depthValidated ? 'Depth behaviour has independent local holdout validation.' : 'Exact depth is not independently calibrated here.'],
    ['Downstream river/canal level', boundaryKnown, boundaryKnown ? 'A reviewed datum-compatible stage is connected.' : 'The downstream stage is unknown, so backwater is uncertain.'],
  ];
  const strongCount = confidenceRows.filter(([, known]) => known).length;
  const overall = depthValidated && boundaryKnown && strongCount >= 4 ? 'HIGH' : strongCount >= 3 ? 'MEDIUM' : 'LOW';
  view.innerHTML = `<div class="insight-head"><p class="kicker">HOW SURE IS CFLOWS?</p><h1>Right now: ${overall} confidence in local flood detail.</h1><p>This is confidence in the evidence and model inputs — not a “${overall.toLowerCase()}% chance of flooding.” The app is strongest when describing the rainfall you gave it and mapped drains; it is weakest at exact street depth when local observations, surveyed pipe connections or downstream river levels are missing.</p></div><div class="certainty-board">${confidenceRows.map(([label, known, explanation]) => `<article class="${known ? 'certainty-known' : 'certainty-missing'}"><span>${known ? 'KNOWN WELL' : 'LIMITED'}</span><b>${escapeHtml(label)}</b><p>${escapeHtml(explanation)}</p></article>`).join('')}</div><div class="insight-stats"><article><span>Evidence sources available</span><b>${available}/${sources.length}</b></article><article><span>Local flood labels</span><b>${calibration.labelCount || 0}</b></article><article><span>Independent test events</span><b>${hindcast.eventCount || 0}</b></article><article><span>Saved what-if tests</span><b>${scenarioRuns.length}</b></article></div><div class="analytics-grid"><article><h2>Can we trust exact depth yet?</h2><b class="analytics-state">${depthValidated ? 'YES — LOCALLY CHECKED' : 'NO — NOT YET'}</b><p>${escapeHtml(calibration.conclusion || 'No independent depth-calibration result is available.')}</p><details><summary>Technical validation numbers</summary><ul><li>Precision: ${metrics.precision == null ? 'not available' : metrics.precision.toFixed(2)}</li><li>Recall: ${metrics.recall == null ? 'not available' : metrics.recall.toFixed(2)}</li><li>False-alarm rate: ${metrics.falseAlarmRate == null ? 'not available' : metrics.falseAlarmRate.toFixed(2)}</li><li>Depth MAE: ${metrics.depthMaeM == null ? 'not available' : `${metrics.depthMaeM.toFixed(2)} m`}</li></ul></details></article><article><h2>What would make it more certain?</h2><ul>${(calibration.missing || ['More surveyed local observations and downstream boundary data.']).map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></article></div>`;
}

function setProductView(viewName) {
  if (viewName === 'scenarios') { setScenarioMode(true); return; }
  document.body.classList.remove('scenario-mode');
  const insight = viewName === 'network' || viewName === 'analytics';
  document.body.classList.toggle('insight-mode', insight);
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === viewName));
  if (insight) mountInsightView(viewName);
}

function plainScenarioHeadline(surface) {
  if (surface?.available === false) return 'We do not have enough local data for this place.';
  const ensemble = surface?.ensemble;
  if (ensemble?.available) {
    const majority = Math.ceil((ensemble.memberCount || 1) / 2);
    if (Number(ensemble.exceedance?.atLeast40cm || 0) >= majority) return 'Deep pooling persists across most model variations.';
    if (Number(ensemble.exceedance?.atLeast15cm || 0) >= majority) return 'Road-level pooling persists across most model variations.';
    if (Number(ensemble.exceedance?.atLeast05cm || 0) >= majority) return 'Shallow pooling appears in most model variations.';
    if (Number(ensemble.neighbourhood?.membersWithDeepCells || 0) >= majority) return 'This point stays mostly clear, but nearby low spots flood in most model variations.';
    if (Number(ensemble.neighbourhood?.membersWithMaterialPonding || 0) >= majority) return 'This point stays mostly clear, but nearby pooling appears in most model variations.';
    return 'Most model variations keep this point mostly clear.';
  }
  const spatial = surface?.spatialPooling;
  if (spatial?.available) {
    const atPoint = Number(spatial.selectedDepthM || 0);
    if (atPoint < .05) {
      if (spatial.depthBand === 'deep-inundation-possible' || spatial.depthBand === 'significant-inundation') return 'This exact point stays mostly clear, but nearby low spots collect water.';
      if (spatial.depthBand === 'shallow-inundation') return 'Little water at this point; shallow pooling appears nearby.';
      return 'Little pooling is shown at this point or nearby.';
    }
    if (atPoint < .15) return 'Shallow pooling is shown at this point.';
    if (atPoint < .40) return 'Road-level pooling is shown at this point.';
    return 'Deep pooling is shown at this point.';
  }
  const labels = {
    'minimal-ponding': 'Little surface pooling is shown in this test.',
    'shallow-inundation': 'Shallow pooling is shown in low spots.',
    'significant-inundation': 'Road-level pooling is shown in low spots.',
    'deep-inundation-possible': 'Deep pooling is shown in some low-lying cells.',
  };
  return labels[surface?.depthBand] || 'The model shows surface pooling in this test.';
}

function plainSurfaceFact(surface) {
  const ensemble = surface?.ensemble;
  if (ensemble?.available) {
    const majority = Math.ceil((ensemble.memberCount || 1) / 2);
    if (Number(ensemble.exceedance?.atLeast40cm || 0) >= majority) return 'Robust deep pooling';
    if (Number(ensemble.exceedance?.atLeast15cm || 0) >= majority) return 'Robust road-level pooling';
    if (Number(ensemble.exceedance?.atLeast05cm || 0) >= majority) return 'Robust shallow pooling';
    return 'Mostly clear across ensemble';
  }
  const atPoint = Number(surface?.spatialPooling?.selectedDepthM);
  if (Number.isFinite(atPoint)) {
    if (atPoint < .05) return 'Mostly clear at point';
    if (atPoint < .15) return 'Shallow at point';
    if (atPoint < .40) return 'Road-level at point';
    return 'Deep at point';
  }
  return ({
    'minimal-ponding': 'Little pooling',
    'shallow-inundation': 'Shallow pooling',
    'significant-inundation': 'Road-level pooling',
    'deep-inundation-possible': 'Deep pooling pattern',
  })[surface?.depthBand] || 'Pooling pattern';
}

function scenarioDrivers(result, scenario, surface) {
  const drivers = [];
  const profile = scenario.rainfallProfile || {};
  const peak = Number(scenario.rainfallMmHr || profile.peakMmHr || 0);
  const total = Number(profile.totalMm || 0);
  const rawImpervious = surface?.imperviousPct ?? scenario.runoff?.imperviousPct;
  const impervious = hasNumericValue(rawImpervious) ? Number(rawImpervious) : NaN;
  const imperviousRange = surface?.imperviousRangePct || scenario.runoff?.imperviousRangePct;
  const depression = Number(surface?.terrain?.depressionM);
  const relief = Number(surface?.terrain?.reliefM);
  const drainRemoval = Number(surface?.drainRemovalMmHr || 0);
  const swmm = scenario.networkSwmm || {};
  const swmmFloodM3 = Number(swmm.totalFloodVolumeM3 || swmm.maxFloodVolumeM3 || 0);
  const boundaryKnown = Boolean(scenario.downstreamBoundary?.available);
  const calibrated = Boolean(result.calibration?.isCalibrated || surface?.calibrated);
  const spatial = surface?.spatialPooling;
  const ensemble = surface?.ensemble || scenario.ensemble;

  if (ensemble?.available) {
    const members = Number(ensemble.memberCount || 0);
    const over15 = Number(ensemble.exceedance?.atLeast15cm || 0);
    const over40 = Number(ensemble.exceedance?.atLeast40cm || 0);
    drivers.push({
      kind: over40 >= Math.ceil(members / 2) ? 'raise' : over15 >= Math.ceil(members / 2) ? 'raise' : 'neutral',
      strength: over40 >= Math.ceil(members / 2) ? 3 : over15 >= Math.ceil(members / 2) ? 2 : 1,
      title: 'Ensemble agreement',
      value: `${over15}/${members} members ≥15 cm · ${over40}/${members} ≥40 cm`,
      why: 'The same location was rerun across bounded rainfall, runoff, infiltration, roughness and drainage assumptions. Agreement across members makes the result more robust to any one assumption.',
    });
    for (const item of (ensemble.sensitivity || []).slice(0, 3)) {
      const effectCm = Math.round(Number(item.absoluteEffectM || 0) * 100);
      if (!effectCm) continue;
      drivers.push({
        kind: 'sensitivity',
        strength: effectCm >= 20 ? 3 : effectCm >= 8 ? 2 : 1,
        title: item.label,
        value: `~${effectCm} cm swing across tested range`,
        why: `Changing only this factor from ${Number(item.lowFactor).toFixed(2)}× to ${Number(item.highFactor).toFixed(2)}× changes the selected-cell result from ~${Math.round(Number(item.lowDepthM || 0) * 100)} cm to ~${Math.round(Number(item.highDepthM || 0) * 100)} cm.`,
      });
    }
  }

  if (spatial?.available) {
    const floodedPct = Math.round((spatial.floodedFraction || 0) * 100);
    const significantPct = Math.round((spatial.significantFraction || 0) * 100);
    const deepPct = Math.round((spatial.deepFraction || 0) * 100);
    const kind = spatial.depthBand === 'minimal-ponding' ? 'lower' : 'raise';
    const strength = spatial.depthBand === 'deep-inundation-possible' ? 3 : spatial.depthBand === 'significant-inundation' ? 2 : 1;
    drivers.push({
      kind, strength,
      title: 'Spatial pooling pattern',
      value: `${floodedPct}% of nearby cells ≥5 cm · ${significantPct}% ≥15 cm · ${deepPct}% ≥40 cm`,
      why: spatial.depthBand === 'minimal-ponding'
        ? 'Most model cells drain or route water away without retaining material ponding under this storm.'
        : `The severity comes from the spatial raster (${String(spatial.pattern || 'pooling pattern').replace(/-/g, ' ')}), not from a capped one-number depth formula.`,
    });
  }

  if (peak > 0) {
    const strength = peak >= 150 || total >= 250 ? 3 : peak >= 80 || total >= 120 ? 2 : 1;
    drivers.push({
      kind: 'raise', strength,
      title: peak >= 80 ? 'Heavy rainfall load' : 'Rainfall input',
      value: `${Math.round(peak)} mm/h peak${total ? ` · ${Math.round(total)} mm total` : ''}`,
      why: 'More rain creates more surface runoff before drainage and routing can remove it.',
    });
  }
  if (Number.isFinite(impervious)) {
    const strength = impervious >= 75 ? 3 : impervious >= 55 ? 2 : 1;
    drivers.push({
      kind: 'raise', strength,
      title: 'Built-up ground', value: `~${Math.round(impervious)}% impervious proxy`,
      why: 'Paved and built surfaces absorb less rainfall, so a larger share becomes runoff.',
    });
  } else if (imperviousRange?.length === 2) {
    drivers.push({
      kind: 'uncertain', strength: 2,
      title: 'Built-up ground is uncertain', value: `${Math.round(imperviousRange[0])}–${Math.round(imperviousRange[1])}% assumed range`,
      why: 'This range changes how much rainfall becomes runoff and widens the result envelope.',
    });
  }
  if (Number.isFinite(depression)) {
    const strength = depression >= .25 ? 3 : depression >= .08 ? 2 : 1;
    drivers.push({
      kind: depression > .03 ? 'raise' : 'neutral', strength,
      title: 'Local terrain shape',
      value: `${Math.round(depression * 100)} cm local depression${Number.isFinite(relief) ? ` · ${relief.toFixed(1)} m neighbourhood relief` : ''}`,
      why: depression > .03 ? 'The selected area sits below its local terrain average, so the surface model retains more water there.' : 'The selected point is not strongly depressed relative to the local terrain sample.',
    });
  }
  if (surface?.surfaceOnly) {
    drivers.push({
      kind: 'raise', strength: 3,
      title: 'Drain capacity unknown', value: '0 mm/h drain credit',
      why: 'No trustworthy local drain capacity is available, so cFLOWS deliberately assumes the drain removes nothing. This makes the pooling result conservative.',
    });
  } else if (Number.isFinite(drainRemoval)) {
    drivers.push({
      kind: 'lower', strength: drainRemoval >= 30 ? 3 : drainRemoval >= 12 ? 2 : 1,
      title: 'Drainage removes water', value: `~${Math.round(drainRemoval)} mm/h modelled removal`,
      why: 'The local drain-capacity proxy subtracts runoff from the surface calculation.',
    });
  }
  if (swmmFloodM3 > 0) {
    drivers.push({
      kind: 'raise', strength: 3,
      title: 'Drain model overflowed', value: `~${Math.round(swmmFloodM3)} m³ SWMM overflow`,
      why: 'The hydraulic drain model itself produced flooding, which is additional evidence that local capacity may be exceeded.',
    });
  } else if (swmm.solved) {
    drivers.push({
      kind: 'lower', strength: 1,
      title: 'No SWMM overflow in this run', value: '0 m³ modelled overflow',
      why: 'The drain-capacity run did not overflow, although that does not rule out surface ponding.',
    });
  }
  if (!boundaryKnown) drivers.push({
    kind: 'uncertain', strength: 2,
    title: 'Downstream water level unknown', value: 'Backwater not measured',
    why: 'River/canal stage can change how easily drains discharge. This mainly lowers confidence rather than directly forcing the displayed severity.',
  });
  if (!calibrated) drivers.push({
    kind: 'uncertain', strength: 3,
    title: 'Exact depth is not locally calibrated', value: 'No independent local depth fit',
    why: 'The model can rank pooling patterns more reliably than it can claim an exact street-water depth here.',
  });

  const priority = { raise: 0, lower: 1, sensitivity: 2, uncertain: 3, neutral: 4 };
  return drivers.sort((a, b) => b.strength - a.strength || priority[a.kind] - priority[b.kind]);
}

function renderScenarioDrivers(result, scenario, surface) {
  const panel = document.querySelector('#scenarioDrivers');
  if (!panel) return;
  const drivers = scenarioDrivers(result, scenario, surface).slice(0, 6);
  if (!drivers.length) {
    panel.innerHTML = '<b>WHY THIS RESULT?</b><p>No explainable model drivers were available for this run.</p>';
    return;
  }
  const labels = { raise: 'SUPPORTS MORE POOLING', lower: 'SUPPORTS LESS POOLING', sensitivity: 'RESULT IS SENSITIVE TO', uncertain: 'LOWERS CONFIDENCE', neutral: 'WEAK / MIXED SIGNAL' };
  panel.innerHTML = `<b>WHY THE MODEL SAYS THIS</b><p class="driver-intro">These are the strongest inputs affecting this run. They are not invented AI explanations; they come from the values used by the model.</p><div class="scenario-driver-list">${drivers.map((driver) => `<article class="driver-${driver.kind}"><span>${labels[driver.kind] || 'DRIVER'}</span><div><strong>${escapeHtml(driver.title)}</strong><em>${escapeHtml(driver.value)}</em><p>${escapeHtml(driver.why)}</p></div></article>`).join('')}</div>`;
}

function scenarioCertainty(result, scenario, surface) {
  const drain = scenario.selectedDrain;
  const runoff = scenario.runoff || {};
  const calibration = result.calibration || {};
  const boundary = scenario.downstreamBoundary || {};
  const graph = result.graph?.summary || {};
  const local = scenario.hydraulicLocality?.selectedInsideSurfaceDomain === true;
  const terrainSource = String(scenario.raster?.elevationSource || '');
  const hasTerrain = Boolean(scenario.raster?.raster || terrainSource);
  const hasMappedImpervious = hasNumericValue(runoff.imperviousPct);
  const hasSurveyedTopology = Number(graph.confirmedLinks || 0) > 0;
  const known = [
    `You selected a peak rain rate of ${scenario.rainfallMmHr} mm/h, a ${scenario.rainfallProfile?.label || 'steady'} storm, and ${Math.round((scenario.durationMinutes || 120) / 60 * 10) / 10} hours of duration.`,
    ...(drain && local ? [`A mapped GCC drain with usable dimensions is ${Math.round(drain.snappedDistanceM || 0)} m from the test point.`] : []),
    ...(hasTerrain ? ['Terrain data is available for this neighbourhood.'] : []),
  ];
  const estimated = [
    'Where rainwater may collect on the surface.',
    hasMappedImpervious ? 'How much nearby ground is paved or built-up.' : 'How much nearby ground is paved or built-up, using a broad range.',
    'How much land may be draining into the mapped drain.',
  ];
  const unknown = [
    ...(!calibration.isCalibrated ? ['The exact street water depth — there is not enough independent local depth calibration.'] : []),
    ...(!hasSurveyedTopology ? ['The exact underground drain connections — the public map is not a surveyed pipe network.'] : []),
    ...(!boundary.available ? ['The real downstream river/canal water level affecting this drain.'] : []),
    ...(!local ? ['A hydraulically complete drain inside the local surface-model area.'] : []),
  ];
  let score = 0;
  if (drain && local) score += 2;
  if (hasTerrain) score += 1;
  if (hasMappedImpervious) score += 1;
  if (boundary.available) score += 1;
  if (hasSurveyedTopology) score += 2;
  if (calibration.isCalibrated) score += 3;
  const level = surface?.available === false ? 'LOW' : score >= 8 ? 'HIGH' : score >= 5 ? 'MEDIUM' : 'LOW';
  const reason = level === 'HIGH'
    ? 'Most important local inputs are measured or independently checked.'
    : level === 'MEDIUM'
      ? 'Some local inputs are strong, but important hydraulic details are still estimated.'
      : 'Important local inputs are still assumptions, so the app can flag possibility better than exact depth.';
  return { level, reason, known, estimated, unknown };
}

function renderScenarioKnowledge(certainty) {
  const knowledge = document.querySelector('#scenarioKnowledge');
  if (!knowledge) return;
  const renderItems = (items) => items.length ? items.map((item) => `<span>${escapeHtml(item)}</span>`).join('') : '<span>Nothing important is missing here.</span>';
  knowledge.querySelector('.known p').innerHTML = renderItems(certainty.known);
  knowledge.querySelector('.estimated p').innerHTML = renderItems(certainty.estimated);
  knowledge.querySelector('.unknown p').innerHTML = renderItems(certainty.unknown);
  const confidence = document.querySelector('#scenarioConfidence');
  if (confidence) {
    confidence.className = `scenario-confidence ${certainty.level.toLowerCase()}`;
    const level = confidence.querySelector('[data-scenario-confidence]');
    const meaning = confidence.querySelector('[data-scenario-meaning]');
    if (level) level.textContent = certainty.level;
    if (meaning) meaning.textContent = certainty.reason;
  }
}

async function runScenario(rainfallMmHr) {
  const button = document.querySelector('#runScenario');
  const title = document.querySelector('#streetDepthTitle');
  const detail = document.querySelector('#streetDepthDetail');
  const source = document.querySelector('#streetSource');
  const durationMinutes = Number(document.querySelector('#scenarioDuration')?.value || 120);
  const rainProfile = document.querySelector('[data-storm].active')?.dataset.storm || 'steady';
  button.disabled = true; button.textContent = 'Checking this place…'; title.textContent = 'Checking what could happen…';
  try {
    const result = await window.neer.simulateScenario({ ...scenarioPoint, rainfallMmHr, durationMinutes, rainProfile });
    const scenario = result.scenario; const surface = scenario.surface; const hasLocationResult = surface.available !== false; const depthCm = hasLocationResult ? Math.round(surface.centralDepthM * 100) : null;
    latestScenario = scenario;
    const rangeLowM = hasLocationResult ? Math.round(surface.depthRangeM.low * 10) / 10 : null, rangeHighM = hasLocationResult ? Math.round(surface.depthRangeM.high * 10) / 10 : null;
    const certainty = scenarioCertainty(result, scenario, surface);
    renderScenarioKnowledge(certainty);
    drawScenarioContext(result);
    renderScenarioImpact(scenario.infrastructureImpact);
    renderScenarioDrivers(result, scenario, surface);
    const publicHeadline = plainScenarioHeadline(surface);
    const resultLabel = document.querySelector('[data-scenario-result]');
    if (resultLabel) resultLabel.textContent = hasLocationResult ? plainSurfaceFact(surface) : 'Not enough data';
    const meaning = document.querySelector('[data-scenario-meaning]');
    if (meaning) meaning.textContent = surface.surfaceOnly
      ? 'Low confidence because local drain capacity is unknown. This screen assumes no drain removal, so it is deliberately conservative.'
      : `${certainty.reason} Confidence describes input quality, not the chance of flooding.`;
    const quickFacts = document.querySelector('#scenarioQuickFacts');
    if (quickFacts) {
      const hours = Math.round((scenario.durationMinutes || 120) / 60 * 10) / 10;
      const drainFact = surface.surfaceOnly ? 'Unavailable here' : scenario.networkSwmm?.solved ? 'Capacity check ran' : 'Limited data';
      const spatial = surface.spatialPooling;
      const ensemble = surface.ensemble;
      const atPoint = ensemble?.available
        ? `${Math.round(Number(ensemble.selectedDepthM?.p50 || 0) * 100)} cm median`
        : spatial?.available ? (spatial.selectedDepthM < .05 ? '<5 cm' : `~${Math.round(spatial.selectedDepthM * 100)} cm`) : escapeHtml(plainSurfaceFact(surface));
      const nearby = ensemble?.available
        ? `${ensemble.neighbourhood?.membersWithMaterialPonding || 0}/${ensemble.memberCount || 0} runs pool nearby`
        : spatial?.available ? `${Math.round(spatial.floodedFraction * 100)}% cells >5 cm` : 'No spatial summary';
      quickFacts.innerHTML = `<div><span>Storm</span><b>${Math.round(rainfallMmHr)} mm/h · ${hours} h</b></div><div><span>At this point</span><b>${escapeHtml(atPoint)}</b></div><div><span>Ensemble</span><b>${escapeHtml(nearby)}</b></div><div><span>Drain check</span><b>${escapeHtml(drainFact)}</b></div>`;
    }
    const water = document.querySelector('#streetWater');
    water.style.height = hasLocationResult ? `${Math.min(77, 8 + surface.centralDepthM * 78)}%` : '0';
    document.querySelector('#streetScene').classList.toggle('has-water', depthCm > 0);
    document.querySelector('#streetEmpty').textContent = hasLocationResult ? (depthCm ? '' : 'This test does not show meaningful standing water at this point.') : 'Not enough local information to estimate surface water here.';
    title.textContent = publicHeadline;
    const drain = scenario.selectedDrain;
    const spatial = surface.spatialPooling;
    const ensemble = surface.ensemble;
    const spatialSentence = spatial?.available
      ? ` At the selected cell the model retains about ${Math.round(spatial.selectedDepthM * 100)} cm; across the neighbourhood, ${Math.round(spatial.floodedFraction * 100)}% of cells exceed 5 cm, ${Math.round(spatial.significantFraction * 100)}% exceed 15 cm, and ${Math.round(spatial.deepFraction * 100)}% exceed 40 cm.`
      : '';
    const ensembleSentence = ensemble?.available
      ? ` Across ${ensemble.memberCount} bounded model variations, ${ensemble.exceedance.atLeast05cm} retain at least 5 cm at this exact point, ${ensemble.exceedance.atLeast15cm} retain at least 15 cm, and ${ensemble.exceedance.atLeast40cm} retain at least 40 cm. Nearby, ${ensemble.neighbourhood?.membersWithMaterialPonding || 0}/${ensemble.memberCount} members show material pooling and ${ensemble.neighbourhood?.membersWithDeepCells || 0}/${ensemble.memberCount} contain deep cells. The selected-point ensemble range is roughly ${Math.round(ensemble.selectedDepthM.p10 * 100)}–${Math.round(ensemble.selectedDepthM.p90 * 100)} cm, with a ${Math.round(ensemble.selectedDepthM.p50 * 100)} cm median. These member counts are robustness frequencies, not calibrated probabilities.`
      : '';
    detail.textContent = !hasLocationResult
      ? `At ${scenarioPoint.label}, cFLOWS cannot make a useful local flood estimate yet because ${(surface.missing || []).join(', ')}.`
      : surface.surfaceOnly
        ? `The coloured map shows where rainfall, terrain and mapped land cover make water collect.${ensembleSentence || spatialSentence} Local drain capacity is unknown here, so the ensemble includes conservative no-drain behavior rather than inventing pipe capacity. Actual flooding may be lower if drainage works well, or higher if drains are blocked or downstream water backs up.`
      : surface.calibrated
        ? `For this ${scenario.rainfallProfile?.label || 'storm'} test (peak ${rainfallMmHr} mm/h over ${Math.round((scenario.durationMinutes || 120) / 60 * 10) / 10} hours), the local model indicates flooding within a calibrated ${rangeLowM.toFixed(1)}–${rangeHighM.toFixed(1)} m range.`
        : `The map shows the central modelled pooling pattern for this storm.${ensembleSentence || spatialSentence} Exact street depth is not trusted yet because local flood-depth calibration and some hydraulic inputs are still missing.`;
    const photo = scenario.streetPhoto;
    const safePhotoUrl = photo?.available && /^https?:\/\//i.test(photo.url || '') ? photo.url : null;
    const scene = document.querySelector('#streetScene');
    scene.classList.toggle('has-photo', Boolean(safePhotoUrl));
    scene.style.backgroundImage = safePhotoUrl ? `linear-gradient(rgba(8,36,40,.08), rgba(8,36,40,.08)), url("${safePhotoUrl.replace(/"/g, '%22')}")` : '';
    const graph = result.graph?.summary || {}; const topology = drain?.topology;
    const context = scenario.cityContext || {};
    const marine = scenario.marineBoundary;
    const boundaryText = context.catchment ? `${context.catchment}; regional outfall context: ${context.outfall} (${Math.round((context.outfallDistanceM || 0) / 100) / 10} km away). ${marine ? `Offshore sea-level boundary is ${marine.outfallRestriction}; it reduces assumed drain headroom to ${Math.round((marine.capacityMultiplier || 1) * 100)}%.` : 'No marine boundary was available.'}` : 'No regional Chennai drainage corridor was assigned for this point.';
    const imperviousText = hasNumericValue(scenario.runoff?.imperviousPct) ? `${Math.round(scenario.runoff.imperviousPct)}% proxy estimate` : `${scenario.runoff?.imperviousRangePct?.[0] || 40}–${scenario.runoff?.imperviousRangePct?.[1] || 85}% bounded prior`;
    const networkText = `${scenario.modelScope}; ${graph.geometryLinks || 0} coincident-endpoint geometry links, ${graph.inferredLinks || 0} total candidate links, ${graph.confirmedLinks || 0} surveyed/confirmed links. This drain's topology confidence: ${Math.round((topology?.confidence || 0) * 100)}%. Imperviousness: ${imperviousText}. ${boundaryText} ${context.connection || ''}`;
    const drainTechnicalText = surface.surfaceOnly
      ? `No local drain was used in the surface calculation. Nearest mapped GCC drain: ${drain?.label || 'none'}${drain?.snappedDistanceM != null ? `, ${Math.round(drain.snappedDistanceM)} m away` : ''}. Drain removal credit: 0 mm/h.`
      : `Drain used: ${drain?.label || 'none'}${drain?.snappedDistanceM != null ? `, ${Math.round(drain.snappedDistanceM)} m away` : ''}.`;
    const spatialTechnicalText = spatial?.available
      ? `Spatial severity basis: selected cell ${(spatial.selectedDepthM * 100).toFixed(0)} cm; p90 ${(spatial.p90DepthM * 100).toFixed(0)} cm; p95 ${(spatial.p95DepthM * 100).toFixed(0)} cm; ${(spatial.floodedFraction * 100).toFixed(1)}% of cells >=5 cm; ${(spatial.deepFraction * 100).toFixed(1)}% >=40 cm. Old scalar road-storage screen is retained only as an uncertainty check and no longer sets the public severity.`
      : '';
    const ensembleTechnicalText = ensemble?.available
      ? `Ensemble: ${ensemble.memberCount} bounded parameter members; selected depth p10/p50/p90 ${(ensemble.selectedDepthM.p10 * 100).toFixed(0)}/${(ensemble.selectedDepthM.p50 * 100).toFixed(0)}/${(ensemble.selectedDepthM.p90 * 100).toFixed(0)} cm; max member continuity error ${Number(ensemble.maxContinuityErrorPct || 0).toExponential(2)}%. ${ensemble.interpretation}`
      : '';
    const surfaceFieldText = scenario.spatialSurface?.available
      ? `Spatial surface fields: ${scenario.spatialSurface.roadCells || 0} road cells, ${scenario.spatialSurface.buildingCells || 0} building cells, ${scenario.spatialSurface.waterCells || 0} water cells, ${scenario.spatialSurface.drainCells || 0} drain-influenced cells.`
      : 'Spatial land-surface fields unavailable; scalar fallback used.';
    source.textContent = `Storm: ${scenario.rainfallProfile?.label || rainProfile}; peak ${rainfallMmHr} mm/h; duration ${scenario.durationMinutes || durationMinutes} minutes; integrated model rainfall ${scenario.rainfallProfile?.totalMm ?? '?'} mm. Test point: ${scenarioPoint.label}. ${drainTechnicalText} ${hasLocationResult ? `${spatialTechnicalText} ${ensembleTechnicalText} ${surfaceFieldText} ${surface.parameterSource}.` : `Missing: ${(surface.missing || []).join(', ')}.`} ${photo?.available ? `Nearby public KartaView image: ${photo.distanceM ? `${Math.round(photo.distanceM)} m away` : 'distance unknown'}.` : 'No nearby public street image.'} ${networkText}`;
    const calibration = result.calibration || {};
    document.querySelector('#scenarioValidation').textContent = ensemble?.available
      ? `${ensemble.memberCount}-member uncertainty ensemble · member frequency is robustness, not probability${surface.surfaceOnly ? ' · local drain capacity unavailable' : ''}.`
      : surface.surfaceOnly
      ? 'Drain capacity unavailable here · surface-only pooling screen using rainfall and terrain.'
      : calibration.isCalibrated
        ? `How sure? Better than usual: water-depth behaviour was checked against ${calibration.depthCalibration?.holdoutCount || 0} independent local observations.`
        : `Depth is not locally calibrated yet · use the map as a screening result, not a measurement.`;
    const time = document.querySelector('#scenarioTime'); const exportButton = document.querySelector('#scenarioExport');
    if (scenario.raster?.frames?.length) { time.disabled = false; time.max = scenario.raster.frames.length - 1; time.value = scenario.raster.frames.length - 1; paintScenarioFrame(Number(time.value)); }
    const playbackTitle = document.querySelector('.scenario-playback > b'); if (playbackTitle) playbackTitle.textContent = `How water changes over ${Math.round((scenario.durationMinutes || durationMinutes) / 60 * 10) / 10} hours`;
    if (exportButton) exportButton.disabled = false;
    document.querySelectorAll('[data-export-csv],[data-export-geojson],[data-export-print]').forEach((item) => { item.disabled = false; });
  } catch (error) { title.textContent = 'Scenario could not run'; detail.textContent = error.message; }
  finally { button.disabled = false; button.textContent = 'Check this place'; }
}

function renderSwmmResult(run) {
  const swmm = run.swmm;
  if (swmmCard) {
    const drain = swmm?.representativeDrain;
    const flooded = Number(swmm?.maxFloodVolumeM3 || 0) > 0;
    swmmCard.classList.toggle('has-flooding', flooded);
    swmmCard.querySelector('[data-swmm-state]').textContent = swmm?.solved ? 'DRAIN CAPACITY CHECK · COMPLETE' : 'DRAIN CAPACITY CHECK · WAITING';
    swmmCard.querySelector('[data-swmm-title]').textContent = swmm?.solved
      ? (flooded ? 'The drain model shows overflow in this test' : 'The drain model does not show overflow in this 2-hour check')
      : 'Not enough drain information to run the check';
    swmmCard.querySelector('[data-swmm-detail]').textContent = drain
      ? `${drain.label} · mapped drain ${drain.snappedDistanceM != null ? `${Math.round(drain.snappedDistanceM)} m away` : 'selected for the local check'}`
      : (swmm?.error || 'No GCC drain with complete surveyed attributes was returned.');
    swmmCard.querySelector('[data-swmm-note]').textContent = swmm?.solved
      ? `${swmm.audit?.observed?.length || 0} measured/mapped inputs · ${swmm.audit?.assumptions?.length || 0} assumptions. Technical solver: EPA SWMM.`
      : 'Open “Why this answer?” to see what is missing.';
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
      const saved = await window.neer.addFieldReport({ latitude: reportLocation.lat, longitude: reportLocation.lng, depthM: Number(button.dataset.depth) });
      dialog.close(); toast(saved.duplicateSuppressed ? 'Duplicate nearby report suppressed. Refreshing the decision.' : 'Unverified field evidence recorded. Refreshing the decision.'); await runActualNowcast();
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
    document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => setProductView(button.dataset.view)));
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
      node.innerHTML = '<div class="plain-map-card"><span class="answer-label">CURRENT ANSWER · CHECKING</span><b>Checking the latest evidence…</b><p>Loading rainfall, mapped drains and nearby water evidence.</p><em>No conclusion yet.</em></div>';
      return node;
    };
    plainLanguageControl.addTo(pilotMap);
    const swmmControl = window.L.control({ position: 'topright' });
    swmmControl.onAdd = () => {
      const node = window.L.DomUtil.create('div', 'swmm-map-card');
      node.innerHTML = '<span data-swmm-state>DRAIN CAPACITY CHECK · WAITING</span><b data-swmm-title>Checking whether a nearby drain can be modelled…</b><p data-swmm-detail>Looking for a mapped GCC drain with usable size and level information.</p><em data-swmm-note>The app will say when it has to assume something.</em>';
      window.L.DomEvent.disableClickPropagation(node); swmmCard = node; return node;
    };
    swmmControl.addTo(pilotMap);
    $('.page-head .kicker').textContent = 'CHENNAI · VELACHERY / PALLIKARANAI';
    $('.page-head h1').textContent = 'Will this area flood soon?';
    $('.page-head .subhead').textContent = 'The map shows known drains. The answer card tells you what is observed, what is estimated, and whether the evidence is strong enough to trust.';
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
function updateTime(value) { const minutes = 450 + Number(value), time = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`; if ($('#timelineNow')) $('#timelineNow').textContent = time; }
function setRunning() { running = false; toast('Synthetic live replay is disabled. Use Scenarios for modelled timelines.'); }
function simulatePump() { toast('Pump effects are not shown unless an intervention is represented in the hydraulic model.'); }
$('#simulateButton').onclick = runActualNowcast;
if ($('#playButton')) $('#playButton').onclick = setRunning;
if ($('#timeSlider')) $('#timeSlider').disabled = true;
if ($('#speedButton')) $('#speedButton').disabled = true;
document.querySelectorAll('.map-toggle').forEach((b) => b.onclick = () => { b.classList.toggle('active'); if (b.dataset.layer === 'drains' && drainOverlay) { b.classList.contains('active') ? drainOverlay.addTo(pilotMap) : drainOverlay.remove(); return; } document.querySelector(layers[b.dataset.layer]).style.display = b.classList.contains('active') ? '' : 'none'; });
const ledger = $('#ledgerDialog'); ['#sourcesButton', '#openLedger', '#explainButton'].forEach((s) => { if ($(s)) $(s).onclick = () => ledger.showModal(); }); if ($('[data-close]')) $('[data-close]').onclick = () => ledger.close();
if ($('#incidentButton')) $('#incidentButton').onclick = () => toast('Legacy replay marker is disabled in live mode.');
if ($('#dispatchButton')) $('#dispatchButton').onclick = () => toast('Automatic dispatch is disabled; verified field evidence is required.');
if ($('#compareButton')) $('#compareButton').onclick = simulatePump;
document.querySelectorAll('.inline-action').forEach((b) => b.onclick = () => toast('Legacy canned actions are disabled. Use verified operational workflows only.'));
updateTime(58);
initialiseBasemap();
