import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateBearing, isSpiroName, isStale, pushSample, distanceRange, relativeBearing, rssiToMetres, smoothedRssi, spiroLabel, spiroSuffix, wrapDegrees, SWEEP_WINDOW_MS } from '../src/spiroSensor.ts';

test('only advertised names beginning with TMD024 are treated as SPIRO', () => {
  assert.equal(isSpiroName('TMD024-A1F3'), true);
  assert.equal(isSpiroName('tmd024x'), true);
  assert.equal(isSpiroName('TMD025-A1F3'), false);
  assert.equal(isSpiroName('Boda TMD024'), false);
  assert.equal(isSpiroName(''), false);
  assert.equal(isSpiroName(null), false);
});

test('the suffix after TMD024 is the SPIRO label suffix', () => {
  assert.equal(spiroLabel('TMD024-A1F3'), 'SPIRO-A1F3');
  assert.equal(spiroLabel('TMD024_9Z'), 'SPIRO-9Z');
  assert.equal(spiroLabel('TMD024 Kla 2'), 'SPIRO-Kla 2');
  assert.equal(spiroLabel('TMD024'), 'SPIRO');
  assert.equal(spiroSuffix('TMD024:: 0042'), '0042');
});

test('RSSI maps to distance with the log-distance model and a sensible range', () => {
  assert.ok(Math.abs(rssiToMetres(-59) - 1) < 1e-9);
  assert.ok(Math.abs(rssiToMetres(-79) - Math.pow(10, 20 / 25)) < 1e-9);
  const [near, far] = distanceRange(-70);
  assert.ok(near < far);
  assert.ok(near > 0);
});

test('median smoothing damps a single RSSI spike', () => {
  const samples = [-70, -71, -40, -69, -72].map((rssi, i) => ({ rssi, heading: null, at: i }));
  assert.equal(smoothedRssi(samples), -70);
  assert.equal(smoothedRssi([]), null);
});

test('relative bearings wrap around the phone nose', () => {
  assert.equal(relativeBearing(10, 350), 20);
  assert.equal(relativeBearing(350, 10), 340);
  assert.equal(wrapDegrees(-90), 270);
});

test('tracks keep only the sweep window and report staleness', () => {
  let track = { id: 'a', name: 'TMD024-A1', label: 'SPIRO-A1', samples: [], lastSeen: 0 };
  track = pushSample(track, { rssi: -60, heading: 0, at: 0 });
  track = pushSample(track, { rssi: -61, heading: 10, at: SWEEP_WINDOW_MS + 5000 });
  assert.equal(track.samples.length, 1);
  assert.equal(isStale(track, track.lastSeen + 1000), false);
  assert.equal(isStale(track, track.lastSeen + 20000), true);
});

function sweep(sourceBearing, { start = 0, durationMs = 20000, stepMs = 200, now = 0, headingless = false } = {}) {
  const samples = [];
  for (let t = 0; t <= durationMs; t += stepMs) {
    const heading = wrapDegrees((t / durationMs) * 720); // two full turns
    const diff = Math.abs(((heading - sourceBearing + 540) % 360) - 180);
    samples.push({ rssi: -48 - 0.15 * diff, heading: headingless ? null : heading, at: start + t });
  }
  return { samples, now: start + durationMs };
}

test('a full phone sweep recovers the beacon bearing with strong confidence', () => {
  const { samples, now } = sweep(120);
  const estimate = estimateBearing(samples, now);
  assert.equal(estimate.confidence, 'good');
  assert.ok(Math.abs(estimate.bearing - 120) < 4, `bearing ${estimate.bearing}`);
  assert.equal(estimate.coverage, 1);
});

test('bearings across north are handled without a 360° seam error', () => {
  const { samples, now } = sweep(355);
  const estimate = estimateBearing(samples, now);
  assert.ok(Math.min(Math.abs(estimate.bearing - 355), 360 - Math.abs(estimate.bearing - 355)) < 4, `bearing ${estimate.bearing}`);
});

test('no compass heading means no bearing, only distance', () => {
  const { samples, now } = sweep(120, { headingless: true });
  const estimate = estimateBearing(samples, now);
  assert.equal(estimate.bearing, null);
  assert.equal(estimate.confidence, 'none');
});

test('a brief, one-sided sample set does not claim a direction', () => {
  const samples = [0, 5, 10].map((h, i) => ({ rssi: -60, heading: h, at: i * 500 }));
  assert.equal(estimateBearing(samples, 2000).bearing, null);
});
