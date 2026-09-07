'use strict';

// GCC's public layer contains multiple dimension fields. In a subset of
// Velachery/Thiruvanmiyur records drain_wid/drain_dep are decimal-shifted by
// ~10x while drain_size contains a plausible metric cross-section. Centralise
// interpretation here so every model uses the same audited dimensions.

function positiveNumber(value) {
  const parsed = Number.parseFloat(String(value ?? '').replace(/[^0-9.+-]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function parseDrainSize(value) {
  const match = String(value || '').match(/([0-9]+(?:\.[0-9]+)?)\s*[x×]\s*([0-9]+(?:\.[0-9]+)?)/i);
  if (!match) return null;
  const widthM = positiveNumber(match[1]);
  const depthM = positiveNumber(match[2]);
  return widthM && depthM ? { widthM, depthM } : null;
}

function ratio(a, b) {
  return a > 0 && b > 0 ? Math.max(a / b, b / a) : Infinity;
}

function normalizeGccDrainProperties(properties = {}) {
  const rawWidthM = positiveNumber(properties.drain_wid);
  const rawDepthM = positiveNumber(properties.drain_dep);
  const size = parseDrainSize(properties.drain_size);
  const closed = /\bclosed\b/i.test(String(properties.drain_detl || ''));
  const open = /\bopen\b/i.test(String(properties.drain_detl || ''));
  const warnings = [];

  if (size) {
    const widthMismatch = rawWidthM ? ratio(rawWidthM, size.widthM) > 1.5 : false;
    const depthMismatch = rawDepthM ? ratio(rawDepthM, size.depthM) > 1.5 : false;
    if (widthMismatch || depthMismatch) warnings.push('drain_wid/drain_dep disagree materially with drain_size; drain_size used');
    return {
      widthM: size.widthM,
      depthM: size.depthM,
      widthObserved: true,
      depthObserved: true,
      rawWidthM,
      rawDepthM,
      drainSize: properties.drain_size || null,
      dimensionSource: widthMismatch || depthMismatch ? 'GCC drain_size (raw dimension conflict corrected)' : 'GCC drain_size',
      dimensionConflict: widthMismatch || depthMismatch,
      closed,
      crossSectionShape: closed ? 'RECT_CLOSED' : 'RECT_OPEN',
      enclosureSource: closed || open ? 'GCC drain_detl' : 'unspecified; open section used conservatively',
      warnings,
    };
  }

  // Old caches do not contain drain_size. Large raw dimensions were shown by
  // the 2015 audit to be unsafe in the affected areas, so do not silently call
  // them observed hydraulic dimensions until the richer GIS record is fetched.
  const ambiguousLarge = (rawWidthM || 0) > 3 || (rawDepthM || 0) > 3;
  if (ambiguousLarge) warnings.push('large raw dimensions lack drain_size cross-check; hydraulic use withheld');
  return {
    widthM: rawWidthM,
    depthM: rawDepthM,
    widthObserved: Boolean(rawWidthM) && !ambiguousLarge,
    depthObserved: Boolean(rawDepthM) && !ambiguousLarge,
    rawWidthM,
    rawDepthM,
    drainSize: null,
    dimensionSource: ambiguousLarge ? 'GCC raw fields, ambiguous without drain_size' : 'GCC drain_wid/drain_dep',
    dimensionConflict: false,
    closed,
    crossSectionShape: closed ? 'RECT_CLOSED' : 'RECT_OPEN',
    enclosureSource: closed || open ? 'GCC drain_detl' : 'unspecified; open section used conservatively',
    warnings,
  };
}

module.exports = { parseDrainSize, normalizeGccDrainProperties };
