'use strict';

// Turns model output into an operational recommendation. It deliberately does
// not call an area safe: missing evidence produces a request for evidence.
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function buildOperationalDecision({ rainfall, reports = [], predictions = [], now = Date.now() }) {
  const freshRain = Boolean(rainfall?.fresh);
  const activeRain = Number(rainfall?.mmHr || 0) >= 4;
  const recentReports = reports.filter((report) => now - new Date(report.timestamp).getTime() <= 45 * 60 * 1000);
  const corroborated = recentReports.length >= 1;
  const top = predictions[0];
  const confidence = clamp((top?.confidence || 0) + (corroborated ? .12 : 0));

  if (!freshRain) return {
    state: 'evidence-needed', headline: 'Rain feed unavailable',
    explanation: 'Do not issue a flood warning. Refresh the rainfall feed first.',
    action: 'Restore rainfall feed', confidence: 0,
  };
  if (!activeRain && !corroborated) return {
    state: 'monitor', headline: 'No active flooding evidence',
    explanation: 'The rainfall feed is quiet and no recent field report confirms water on the road.',
    action: 'Keep monitoring', confidence: .42,
  };
  if (activeRain && !corroborated) return {
    state: 'verify', headline: 'Rain is active — verify on the ground',
    explanation: 'Rain alone cannot identify a blocked drain. Request a water-level or crew report before dispatch.',
    action: 'Request field verification', confidence: clamp(confidence, 0, .49),
  };
  if (top?.severity === 'critical' && confidence >= .5) return {
    state: 'act', headline: `Inspect ${top.label || 'the closest drain'} now`,
    explanation: `Recent field water evidence agrees with active rainfall and a high blockage score (${Math.round(top.blockageProbability * 100)}%).`,
    action: 'Inspect inlet; pre-position pump', confidence,
  };
  return {
    state: 'verify', headline: 'Water report received — verify blockage',
    explanation: 'Evidence is not yet strong enough for a pump dispatch, but a crew inspection is warranted.',
    action: 'Inspect inlet and monitor', confidence,
  };
}

module.exports = { buildOperationalDecision };
