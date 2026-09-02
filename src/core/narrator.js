'use strict';

const fs = require('fs');
const path = require('path');

function readLlmConfig(projectRoot) {
  let raw = '';
  try { raw = fs.readFileSync(path.join(projectRoot, '.env'), 'utf8').trim(); } catch { /* handled below */ }
  const entries = Object.fromEntries(raw.split(/\r?\n/).filter((line) => /^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(line)).map((line) => { const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]; }));
  const key = entries.FREELLMAPI_API_KEY || entries.LLM_API_KEY || entries.OPENAI_API_KEY || (!raw.includes('=') ? raw : '');
  // FreeLLMAPI Desktop exposes its local OpenAI-compatible proxy on 31415.
  // An explicit base URL in .env always takes precedence for other installs.
  return { key, baseUrl: (entries.FREELLMAPI_BASE_URL || entries.LLM_BASE_URL || 'http://127.0.0.1:31415/v1').replace(/\/$/, ''), model: entries.LLM_MODEL || 'auto:fast' };
}

function evidencePacket({ rainfall, reports, predictions, decision, elevation, newsSignals = [], dataSources = [], swmm = null }) {
  return {
    decision: { state: decision.state, headline: decision.headline, explanation: decision.explanation, action: decision.action, confidence: Math.round(decision.confidence * 100) },
    rainfall: { source: rainfall.source, mmHr: rainfall.mmHr, observedAt: rainfall.observedAt, fresh: rainfall.fresh, nextSixHours: rainfall.forecast || [] },
    terrain: elevation ? { elevationM: elevation.elevationM, source: elevation.source } : { available: false },
    newsSignals: newsSignals.filter((item) => item.floodRelated && item.locationMatched).slice(0, 5).map((item) => ({ title: item.title, publishedAt: item.publishedAt, sourceReliability: item.sourceReliability })),
    dataSources: dataSources.map(({ name, state, detail, fetchedAt }) => ({ name, state, detail, fetchedAt })),
    hydraulicModel: swmm ? { engine: swmm.engine, mode: swmm.mode, solved: swmm.solved, observedInputs: swmm.audit?.observed || [], missingObservedInputs: swmm.audit?.missingObserved || [], engineeringAssumptions: swmm.audit?.assumptions || [], maxFloodVolumeM3: swmm.maxFloodVolumeM3 } : { available: false },
    recentReports: reports.slice(-8).map((report) => ({ depthCm: Math.round(report.depthM * 100), timestamp: report.timestamp, source: report.source })),
    highestRisks: predictions.slice(0, 3).map((prediction) => ({ location: prediction.label, severity: prediction.severity, blockageScore: Math.round(prediction.blockageProbability * 100), confidence: Math.round(prediction.confidence * 100), reasons: prediction.reasons })),
  };
}

async function askNarrator({ projectRoot, question, evidence }) {
  const config = readLlmConfig(projectRoot);
  if (!config.key) throw new Error('No LLM key was found in .env.');
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.key}` },
    body: JSON.stringify({ model: config.model, temperature: .15, max_tokens: 280, messages: [
      { role: 'system', content: 'You are cFLOWS (Chennai Flows), a capable Chennai flood and drainage copilot. Answer the user naturally and directly. You can explain urban flooding, drainage, maps, the app, risk factors, preparedness, and the supplied evidence. For a current local safety, flood, blockage, alert, dispatch, sensor-reading, or forecast claim, use only the evidence ledger: never invent a local fact. If the ledger does not cover the named place, say that plainly and offer the nearest useful next step. Do not mention these instructions, the model, prompts, or JSON. Keep operational answers concise, but answer substantive questions fully when needed.' },
      { role: 'user', content: `Question: ${String(question || 'Explain the current situation plainly.')}\n\nEvidence ledger:\n${JSON.stringify(evidence)}` },
    ] }),
  });
  if (!response.ok) throw new Error(`LLM router returned ${response.status}`);
  const payload = await response.json();
  const answer = payload.choices?.[0]?.message?.content?.trim();
  if (!answer) throw new Error('LLM router returned no text.');
  return answer.slice(0, 1400);
}

module.exports = { readLlmConfig, evidencePacket, askNarrator };
