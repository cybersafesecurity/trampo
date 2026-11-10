// Spiro Sensor — pure signal-processing helpers (experimental).
// No browser APIs here, so everything is unit-testable under node:test.

export const SPIRO_PREFIX = 'TMD024';
/** Assumed RSSI (dBm) at 1 m. Real beacons differ by ±6 dB or more; treat distances as indicative. */
export const RSSI_AT_1M = -59;
/** Assumed path-loss exponent (2 = free space; 2.5–3 is more typical indoors and in cities). */
export const PATH_LOSS_EXPONENT = 2.5;
/** RSSI uncertainty used to express the distance as a range. */
export const RSSI_UNCERTAINTY_DB = 6;
/** Devices not heard for this long are shown as stale. */
export const STALE_AFTER_MS = 15000;
/** Rolling window of heading samples used for the bearing sweep. */
export const SWEEP_WINDOW_MS = 25000;
export const BEARING_BINS = 36; // 10° bins

export type Confidence = 'none' | 'low' | 'medium' | 'good';
export type HeadingSample = { rssi: number; heading: number | null; at: number };
export type SpiroTrack = { id: string; name: string; label: string; samples: HeadingSample[]; lastSeen: number };
export type BearingEstimate = { bearing: number | null; coverage: number; contrastDb: number; confidence: Confidence; samples: number };

/** True when an advertised name starts with TMD024 (case-insensitive). */
export function isSpiroName(name: string | null | undefined): boolean {
  return !!name && name.trim().toUpperCase().startsWith(SPIRO_PREFIX);
}

/** The part of the name after TMD024, with leading separators removed. "TMD024-A1F3" → "A1F3". */
export function spiroSuffix(name: string): string {
  return name.trim().slice(SPIRO_PREFIX.length).replace(/^[\s\-_:.#]+/, '').trim();
}

/** Display label, e.g. "SPIRO-A1F3", or plain "SPIRO" when the name has no suffix. */
export function spiroLabel(name: string): string {
  const suffix = spiroSuffix(name);
  return suffix ? `SPIRO-${suffix}` : 'SPIRO';
}

export function wrapDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

/** Bearing of the device relative to the phone's nose (0° = straight ahead, clockwise positive). */
export function relativeBearing(bearing: number, heading: number): number {
  return wrapDegrees(bearing - heading);
}

/** Log-distance path-loss estimate in metres from a single RSSI reading. */
export function rssiToMetres(rssi: number, rssiAt1m = RSSI_AT_1M, exponent = PATH_LOSS_EXPONENT): number {
  return Math.pow(10, (rssiAt1m - rssi) / (10 * exponent));
}

/** Distance range in metres for the RSSI uncertainty band. */
export function distanceRange(rssi: number): [number, number] {
  return [rssiToMetres(rssi + RSSI_UNCERTAINTY_DB), rssiToMetres(rssi - RSSI_UNCERTAINTY_DB)];
}

/** Median of the most recent `count` RSSI readings — damps single-advertisement spikes. */
export function smoothedRssi(samples: HeadingSample[], count = 5): number | null {
  const values = samples.slice(-count).map(s => s.rssi).sort((a, b) => a - b);
  if (!values.length) return null;
  const mid = Math.floor(values.length / 2);
  return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/** Append a reading, dropping anything outside the sweep window and capping memory use. */
export function pushSample(track: SpiroTrack, sample: HeadingSample): SpiroTrack {
  const samples = [...track.samples, sample].filter(s => sample.at - s.at <= SWEEP_WINDOW_MS).slice(-400);
  return { ...track, samples, lastSeen: sample.at };
}

/**
 * Estimate the direction of a beacon from RSSI sampled while the phone turns.
 * Samples are binned by compass heading; the strongest (power-averaged) bin is the bearing,
 * refined by a parabolic fit across its neighbours. This is a best-effort RSSI peak, not
 * angle-of-arrival, so it degrades with body shadowing, reflections and sparse sweeps.
 */
export function estimateBearing(samples: HeadingSample[], now: number, windowMs = SWEEP_WINDOW_MS): BearingEstimate {
  const recent = samples.filter(s => s.heading != null && now - s.at <= windowMs && s.at <= now + 1000);
  const power = new Array<number>(BEARING_BINS).fill(0);
  const count = new Array<number>(BEARING_BINS).fill(0);
  for (const s of recent) {
    const bin = Math.floor(wrapDegrees(s.heading as number) / (360 / BEARING_BINS)) % BEARING_BINS;
    power[bin] += Math.pow(10, s.rssi / 10);
    count[bin] += 1;
  }
  const mean: (number | null)[] = count.map((n, i) => (n ? 10 * Math.log10(power[i] / n) : null));
  const filled = mean.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
  const coverage = filled.length / BEARING_BINS;
  if (recent.length < 8 || filled.length < 4) return { bearing: null, coverage, contrastDb: 0, confidence: 'none', samples: recent.length };

  let peak = filled[0];
  for (const i of filled) if ((mean[i] as number) > (mean[peak] as number)) peak = i;
  const c = mean[peak] as number;
  const left = mean[(peak - 1 + BEARING_BINS) % BEARING_BINS];
  const right = mean[(peak + 1) % BEARING_BINS];
  let offset = 0;
  if (left != null && right != null) {
    const denominator = left - 2 * c + right;
    if (denominator < 0) offset = Math.max(-0.5, Math.min(0.5, 0.5 * (left - right) / denominator));
  }
  const bearing = wrapDegrees((peak + 0.5 + offset) * (360 / BEARING_BINS));
  const sorted = filled.map(i => mean[i] as number).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const contrastDb = c - median;

  let confidence: Confidence = 'low';
  if (coverage >= 0.75 && contrastDb >= 6 && recent.length >= 30) confidence = 'good';
  else if (coverage >= 0.5 && contrastDb >= 3) confidence = 'medium';
  return { bearing, coverage, contrastDb, confidence, samples: recent.length };
}

export function isStale(track: Pick<SpiroTrack, 'lastSeen'>, now: number): boolean {
  return now - track.lastSeen > STALE_AFTER_MS;
}
