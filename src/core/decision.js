'use strict';

// Turns model output into an operational recommendation. It deliberately does
// not call an area safe: missing evidence produces a request for evidence.
const clamp = (value, min = 0, max = 1) => Math.max(min, Math.min(max, value));

function distanceM(a, b) {
  if (!a || !b || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude) || !Number.isFinite(b.latitude) || !Number.isFinite(b.longitude)) return Infinity;
  const latitude = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  return Math.hypot((a.longitude - b.longitude) * 111320 * Math.cos(latitude), (a.latitude - b.latitude) * 110540);
}

function scopeReports(reports = [], focus, now = Date.now(), radiusM = 750) {
  return reports.filter((report) => {
    const timestamp = new Date(report.timestamp).getTime();
    if (!Number.isFinite(timestamp) || now - timestamp > 45 * 60 * 1000 || timestamp - now > 5 * 60 * 1000) return false;
    if (!focus || !Number.isFinite(focus.latitude) || !Number.isFinite(focus.longitude)) return false;
    return distanceM(report, focus) <= radiusM;
  });
}

function isTrustedWaterEvidence(report) {
  return report?.verificationState === 'verified'
    || /crew|sensor|municipal|official/i.test(String(report?.source || ''))
    || Number(report?.confidence || 0) >= .8;
}

function buildOperationalDecision({ rainfall, reports = [], predictions = [], focus = null, now = Date.now(), verificationRadiusM = 750 }) {
  const freshRain = Boolean(rainfall?.fresh);
  const activeRain = Number(rainfall?.mmHr || 0) >= 4;
  const recentReports = scopeReports(reports, focus, now, verificationRadiusM);
  const trustedReports = recentReports.filter(isTrustedWaterEvidence);
  const corroborated = recentReports.length >= 1;
  const trustedCorroboration = trustedReports.length >= 1;
  const top = predictions[0];
  const trustedSensorEvidence = Boolean(top?.localEvidence?.hasLevelSensor) && Number(top?.localEvidence?.headDifference || 0) > .28;
  const confidence = clamp((top?.confidence || 0) + (trustedCorroboration ? .15 : corroborated ? .04 : trustedSensorEvidence ? .08 : 0));

  if (!freshRain) return {
    state: 'evidence-needed', headline: 'Rain feed unavailable',
    explanation: corroborated
      ? 'A nearby water report exists, but the current rainfall feed is unavailable. Treat the report as a verification task, not a forecast.'
      : 'Do not issue a flood warning or travel clearance. Refresh the rainfall feed first.',
    action: corroborated ? 'Verify the nearby report and restore rainfall feed' : 'Restore rainfall feed', confidence: 0,
  };
  if (!activeRain && !corroborated) return {
    state: 'monitor', headline: 'No active flooding evidence',
    explanation: 'The current rainfall feed is quiet and there is no recent nearby water report. This is not a travel-safety clearance.',
    action: 'Keep monitoring', confidence: .42,
  };
  if (activeRain && !corroborated && !trustedSensorEvidence) return {
    state: 'verify', headline: 'Rain is active — verify on the ground',
    explanation: 'Rain alone cannot identify a blocked drain. Request a water-level or crew report before dispatch.',
    action: 'Request field verification', confidence: clamp(confidence, 0, .49),
  };
  if (corroborated && !trustedCorroboration) return {
    state: 'verify', headline: 'Nearby water report received — verify it',
    explanation: 'A recent citizen report is spatially relevant, but it is still unverified. It can trigger inspection, not an automatic dispatch.',
    action: 'Request crew or sensor verification', confidence: Math.min(confidence, .59),
  };
  if (top?.severity === 'critical' && confidence >= .6 && (trustedCorroboration || trustedSensorEvidence)) return {
    state: 'act', headline: `Inspect ${top.label || 'the closest drain'} now`,
    explanation: `${trustedSensorEvidence ? 'Fresh water-level telemetry' : 'Verified nearby water evidence'} agrees with active rainfall and a high blockage score (${Math.round((top.blockageProbability || 0) * 100)}%).`,
    action: 'Inspect inlet; stage response equipment after crew confirmation', confidence,
  };
  return {
    state: 'verify', headline: 'Water report received — verify blockage',
    explanation: 'Evidence is not yet strong enough for a pump dispatch, but a crew inspection is warranted.',
    action: 'Inspect inlet and monitor', confidence,
  };
}

module.exports = { buildOperationalDecision, scopeReports, distanceM, isTrustedWaterEvidence };
