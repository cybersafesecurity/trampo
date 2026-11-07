import test from 'node:test';
import assert from 'node:assert/strict';
import { distanceMeters, gpsMatch, inUganda, isNight, quote, normalizePhone } from '../server/domain.js';
const pickup = { lat: 0.3354, lng: 32.5769 }, now = 1000000;
const fix = (offset = 0, extra = {}) => ({ ...pickup, lat: pickup.lat + offset, accuracy: 8, updatedAt: now, source: 'browser', ...extra });
test('Haversine distance is symmetric and zero at the same point', () => {
  assert.equal(distanceMeters(pickup, pickup), 0);
  assert.ok(Math.abs(distanceMeters(pickup, fix(.0001)) - 11.12) < .1);
  assert.equal(distanceMeters(pickup, fix(.0001)), distanceMeters(fix(.0001), pickup));
});
test('GPS start requires both fresh accurate fixes inside daytime threshold', () => {
  assert.equal(gpsMatch(fix(), fix(.0002), now).matched, true);
  assert.equal(gpsMatch(fix(), fix(.0004), now).matched, false);
  assert.equal(gpsMatch(null, fix(), now).matched, false);
  assert.equal(gpsMatch(fix(), fix(0, { updatedAt: now - 15001 }), now).matched, false);
  assert.equal(gpsMatch(fix(), fix(0, { updatedAt: now + 6000 }), now).matched, false);
  assert.equal(gpsMatch(fix(), fix(0, { accuracy: 51 }), now).matched, false);
  assert.equal(gpsMatch(fix(), fix(0, { accuracy: -1 }), now).matched, false);
});
test('Night threshold is tighter and never relaxes freshness', () => {
  assert.equal(gpsMatch(fix(), fix(.00025), now, true).matched, false);
  assert.equal(gpsMatch(fix(), fix(.0002), now, true).matched, true);
  assert.equal(gpsMatch(fix(), fix(.0002), now, true).threshold, 25);
  assert.equal(gpsMatch(fix(), fix(0, { updatedAt: 0 }), now, true).matched, false);
});
test('Night Shield uses Uganda time, not the server timezone', () => {
  assert.equal(isNight(new Date('2026-01-01T16:00:00Z')), true); // 19:00 EAT
  assert.equal(isNight(new Date('2026-01-01T15:59:00Z')), false); // 18:59 EAT
  assert.equal(isNight(new Date('2026-01-01T02:59:00Z')), true); // 05:59 EAT
  assert.equal(isNight(new Date('2026-01-01T03:00:00Z')), false); // 06:00 EAT
});
test('Quotes reject locations outside Uganda and identical points', () => {
  assert.equal(inUganda({ lat: 0, lng: 0 }), false);
  assert.throws(() => quote(pickup, { lat: 51.5, lng: -.1 }));
  assert.throws(() => quote(pickup, pickup));
  const q = quote(pickup, { lat: .0445, lng: 32.4435 }, 'vip');
  assert.ok(q.fare >= 25000 && q.fare % 500 === 0);
  assert.equal(q.currency, 'UGX'); assert.equal(q.estimate, true);
});
test('Uganda phone numbers normalize consistently', () => {
  assert.equal(normalizePhone('0772 123 456'), '+256772123456');
  assert.equal(normalizePhone('+256 (0)772-123-456'.replace('(0)', '')), '+256772123456');
  assert.throws(() => normalizePhone('+14155551212'));
});
