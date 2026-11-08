import test from 'node:test';
import assert from 'node:assert/strict';
import { BOARDING_MAX_DISTANCE, distanceMeters, gpsMatch, inUganda, isNight, quote, routeQuote, normalizePhone } from '../server/domain.js';
const pickup = { lat: 0.3354, lng: 32.5769 }, now = 1000000;
const fix = (offset = 0, extra = {}) => ({ ...pickup, lat: pickup.lat + offset, accuracy: 8, updatedAt: now, source: 'browser', ...extra });
test('Haversine distance is symmetric and zero at the same point', () => {
  assert.equal(distanceMeters(pickup, pickup), 0);
  assert.ok(Math.abs(distanceMeters(pickup, fix(.0001)) - 11.12) < .1);
  assert.equal(distanceMeters(pickup, fix(.0001)), distanceMeters(fix(.0001), pickup));
});
test('boarding requires fresh accurate GPS within a fixed 50 m', () => {
  assert.equal(BOARDING_MAX_DISTANCE, 50);
  const ok = gpsMatch(fix(), fix(.0002), now);
  assert.equal(ok.matched, true); assert.equal(ok.threshold, 50); assert.equal(ok.maxAccuracy, 50); assert.equal(ok.maxAgeSeconds, 15); assert.deepEqual(ok.reasons, []);
  for (const [m, reason] of [[gpsMatch(fix(), fix(.1), now), 'too_far'], [gpsMatch(null, fix(), now), 'passenger_missing'], [gpsMatch(fix(), null, now), 'driver_missing'], [gpsMatch(fix(), fix(0, { updatedAt: now - 15001 }), now), 'driver_stale'], [gpsMatch(fix(), fix(0, { updatedAt: now + 6000 }), now), 'driver_stale'], [gpsMatch(fix(), fix(0, { accuracy: 51 }), now), 'driver_inaccurate'], [gpsMatch(fix(), fix(0, { accuracy: -1 }), now), 'driver_inaccurate'], [gpsMatch(fix(), fix(0, { lat: 51.5, lng: -.1 }), now), 'driver_missing']]) {
    assert.equal(m.matched, false); assert.ok(m.reasons.includes(reason), `${reason} in ${m.reasons}`);
  }
  assert.equal(gpsMatch(fix(), fix(.1), now, true).threshold, 50);
  assert.equal(gpsMatch(null, null, now).distance, null);
});
test('route quotes include stops and reject tiny or foreign legs', () => {
  const drop = { lat: .3476, lng: 32.5825 }, stop = { lat: .33, lng: 32.5822 };
  const direct = routeQuote(pickup, [], drop, 'boda'), via = routeQuote(pickup, [stop], drop, 'boda');
  assert.ok(via.fare >= direct.fare); assert.ok(via.minutes >= direct.minutes + 3); assert.equal(via.estimate, true);
  assert.throws(() => routeQuote(pickup, [{ lat: 51.5, lng: -.1 }], drop, 'boda'));
  assert.throws(() => routeQuote(pickup, [pickup], drop, 'boda'));
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
import { dispatchCandidates } from '../server/domain.js';
test('dispatch ranks available drivers by proximity with no 100-mile cutoff', () => {
  const base = { status: 'approved', online: true, account_status: 'active', busy: false, vehicle_type: 'boda', shift_check_at: now, rating: 4.8, location: fix() };
  const near = { ...base, user_id: 'near', location: fix(.001) };
  const far = { ...base, user_id: 'far', location: fix(1.45) }; // ~161 km / 100 miles
  assert.deepEqual(dispatchCandidates([far, near], { ...pickup, service: 'boda' }, now).map(d => d.user_id), ['near', 'far']);
  const sole = dispatchCandidates([far], { ...pickup, service: 'boda' }, now);
  assert.equal(sole.length, 1); assert.equal(sole[0].user_id, 'far'); assert.ok(sole[0].dispatchDistance > 160000);
  assert.deepEqual(dispatchCandidates([{ ...far, online: false }, { ...far, busy: true }, { ...far, status: 'pending' }, { ...far, account_status: 'suspended' }, { ...far, vehicle_type: 'comfort' }, { ...far, shift_check_at: now - 43200001 }, { ...far, location: fix(0, { updatedAt: now - 30001 }) }, { ...far, location: fix(0, { accuracy: 51 }) }, { ...far, location: fix(0, { lat: 51.5, lng: -.1 }) }], { ...pickup, service: 'boda' }, now), []);
  const tiedA = { ...near, user_id: 'a', rating: 4.9 }, tiedB = { ...near, user_id: 'b', rating: 4.7 };
  assert.deepEqual(dispatchCandidates([tiedB, tiedA], { ...pickup, service: 'boda' }, now).map(d => d.user_id), ['a', 'b']);
});
