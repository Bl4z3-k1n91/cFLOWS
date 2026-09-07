'use strict';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

const PRESETS = Object.freeze({
  steady: {
    label: 'Steady heavy rain',
    anchors: [[0, 1], [1, 1]],
  },
  cloudburst: {
    label: 'Short cloudburst',
    anchors: [[0, .12], [.08, .38], [.2, 1], [.38, .72], [.62, .36], [1, .08]],
  },
  building: {
    label: 'Rain builds gradually',
    anchors: [[0, .12], [.2, .28], [.45, .55], [.7, .82], [1, 1]],
  },
  'two-wave': {
    label: 'Two heavy waves',
    anchors: [[0, .12], [.18, .88], [.38, .34], [.58, .24], [.76, 1], [1, .16]],
  },
});

function interpolateAnchors(anchors, fraction) {
  const f = clamp(Number(fraction) || 0, 0, 1);
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const [x0, y0] = anchors[index], [x1, y1] = anchors[index + 1];
    if (f >= x0 && f <= x1) {
      const span = Math.max(1e-9, x1 - x0);
      const mix = (f - x0) / span;
      return y0 * (1 - mix) + y1 * mix;
    }
  }
  return anchors.at(-1)?.[1] || 0;
}

function sampleRainfallSeries(series, minute) {
  const rows = (series || []).filter((row) => Number.isFinite(Number(row.minute)) && Number.isFinite(Number(row.mmHr))).sort((a, b) => Number(a.minute) - Number(b.minute));
  if (!rows.length) return 0;
  const target = Number(minute) || 0;
  if (target <= Number(rows[0].minute)) return Math.max(0, Number(rows[0].mmHr));
  if (target >= Number(rows.at(-1).minute)) return Math.max(0, Number(rows.at(-1).mmHr));
  for (let index = 0; index < rows.length - 1; index += 1) {
    const left = rows[index], right = rows[index + 1];
    if (target < Number(left.minute) || target > Number(right.minute)) continue;
    const span = Math.max(1e-9, Number(right.minute) - Number(left.minute));
    const mix = (target - Number(left.minute)) / span;
    return Math.max(0, Number(left.mmHr) * (1 - mix) + Number(right.mmHr) * mix);
  }
  return 0;
}

function totalRainfallMm(series, durationMinutes) {
  const duration = Math.max(1, Number(durationMinutes) || 1);
  let total = 0;
  for (let minute = 0; minute < duration; minute += 1) total += sampleRainfallSeries(series, minute + .5) / 60;
  return total;
}

function buildRainfallProfile({ peakMmHr = 80, durationMinutes = 120, profile = 'steady', intervalMinutes = 10 } = {}) {
  const duration = clamp(Math.round(Number(durationMinutes) || 120), 30, 12 * 60);
  const peak = clamp(Number(peakMmHr) || 0, 0, 300);
  const preset = PRESETS[profile] || PRESETS.steady;
  const interval = clamp(Math.round(Number(intervalMinutes) || 10), 5, 30);
  const series = [];
  for (let minute = 0; minute <= duration; minute += interval) {
    const fraction = duration ? minute / duration : 0;
    series.push({ minute, mmHr: Math.round(peak * interpolateAnchors(preset.anchors, fraction) * 100) / 100 });
  }
  if (series.at(-1)?.minute !== duration) series.push({ minute: duration, mmHr: Math.round(peak * interpolateAnchors(preset.anchors, 1) * 100) / 100 });
  const peakAnchor = preset.anchors.reduce((best, anchor) => anchor[1] > best[1] ? anchor : best, preset.anchors[0]);
  const targetPeakMinute = peakAnchor[0] * duration;
  const closestPeakRow = series.reduce((best, row) => Math.abs(row.minute - targetPeakMinute) < Math.abs(best.minute - targetPeakMinute) ? row : best, series[0]);
  if (closestPeakRow) closestPeakRow.mmHr = peak;
  return {
    id: Object.prototype.hasOwnProperty.call(PRESETS, profile) ? profile : 'steady',
    label: preset.label,
    peakMmHr: peak,
    durationMinutes: duration,
    intervalMinutes: interval,
    totalMm: Math.round(totalRainfallMm(series, duration) * 10) / 10,
    series,
  };
}

module.exports = { PRESETS, buildRainfallProfile, sampleRainfallSeries, totalRainfallMm };
