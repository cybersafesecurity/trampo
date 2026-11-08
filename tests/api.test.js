import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBackend } from '../server/index.js';
import { saveFix, hashPassword } from '../server/store.js';
const pickup = { lat: .3354, lng: 32.5769, name: 'Acacia Mall' }, dropoff = { lat: .3117, lng: 32.5750, name: 'Garden City' };
async function setup(t, demo = true) {
  const backend = createBackend({ dbPath: ':memory:', demo, autoTick: false });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.server.address().port}`;
  t.after(() => backend.close());
  function client() {
    let cookie = '';
    return async (method, path, body, expected = 200) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Trampo-Client': 'web', ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const setCookie = response.headers.getSetCookie().find(c => c.startsWith('trampo_session=')); if (setCookie) cookie = setCookie.split(';')[0];
      const data = await response.json();
      
      assert.ok(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected, `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`);
      return data;
    };
  }
  return { backend, base, client };
}
async function passenger(client) {
  await client('POST', '/api/auth/register', { name: 'Test Passenger', phone: `0772${String(process.pid % 1000000).padStart(6, '0')}`, password: 'TestPassword123!' }, 201);
  await client('POST', '/api/location', { ...pickup, accuracy: 8, source: 'simulated' });
}
async function requestRide(client) { return (await client('POST', '/api/trips', { pickup, dropoff, service: 'boda', payment: 'cash' }, 201)).trip; }
test('authentication, CSRF protection, Uganda bounds and fare quotes', async t => {
  const { client: makeClient, base } = await setup(t); const client = makeClient();
  await client('GET', '/api/bootstrap', undefined, 401);
  const res = await fetch(`${base}/api/demo/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"role":"admin"}' }); assert.equal(res.status, 403);
  await client('POST', '/api/demo/session', { role: 'passenger' });
  const state = await client('GET', '/api/bootstrap'); assert.equal(state.nearby.length, 6); assert.equal(state.user.role, 'passenger');
  await client('POST', '/api/location', { lat: 51.5, lng: -.1, accuracy: 8, source: 'browser' }, 400);
  const quotes = await client('POST', '/api/quotes', { pickup, dropoff }); assert.ok(quotes.vip.fare > quotes.comfort.fare && quotes.comfort.fare > quotes.boda.fare);
});
test('complete trip enforces PIN, passenger confirmation, calling window and rating with GPS boarding gates disabled', async t => {
  const { backend, client } = await setup(t), rider = client(), driver = client(), admin = client(), stranger = client();
  await passenger(rider);
  let trip = await requestRide(rider);
  await driver('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-101' });
  await admin('POST', '/api/demo/session', { role: 'admin' });
  await stranger('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-102' });
  await driver('POST', `/api/trips/${trip.id}/call`, {}, 403);
  await stranger('POST', `/api/trips/${trip.id}/start`, { pin: '0000' }, 403);
  trip = (await driver('POST', `/api/trips/${trip.id}/accept`, {})).trip;
  const pin = (await rider('GET', `/api/trips/${trip.id}`)).trip.pin;
  assert.match(pin, /^\d{4}$/); assert.equal(trip.pin, undefined);
  // GPS distance/accuracy/freshness no longer block boarding in testing mode.
  await driver('POST', '/api/location', { ...pickup, lat: pickup.lat + .1, accuracy: 500, source: 'simulated' });
  saveFix(backend.db, 'demo-passenger', { ...pickup, accuracy: 500 }, 'simulated', Date.now() - 60000);
  await driver('POST', `/api/trips/${trip.id}/start`, { pin }, 409); // Still requires passenger confirmation.
  const confirmed = await rider('POST', `/api/trips/${trip.id}/confirm`, { identityChecked: true, safePickup: true });
  assert.equal(confirmed.match.matched, true); assert.equal(confirmed.match.testingBypass, true);
  await driver('POST', `/api/trips/${trip.id}/start`, { pin: pin === '0000' ? '0001' : '0000' }, 400);
  const started = await driver('POST', `/api/trips/${trip.id}/start`, { pin }); assert.equal(started.trip.status, 'in_progress'); assert.equal(started.match.threshold, null); assert.equal(started.match.testingBypass, true); assert.deepEqual(started.match.reasons, []); assert.ok(Number.isFinite(started.match.distance));
  await driver('POST', `/api/trips/${trip.id}/start`, { pin }, 409);
  await driver('POST', `/api/trips/${trip.id}/cancel`, { reason: 'Too late' }, 409);
  const call = await rider('POST', `/api/trips/${trip.id}/call`, {}); assert.equal(call.mode, 'webrtc-p2p');
  await stranger('POST', `/api/trips/${trip.id}/call`, {}, 403);
  const share = await rider('POST', `/api/trips/${trip.id}/share`, {});
  const shared = await stranger('GET', `/api/shared/${share.path.split('/').pop()}`); assert.equal(shared.phone, undefined); assert.equal(shared.pin, undefined);
  await rider('DELETE', `/api/trips/${trip.id}/share`, {}); await stranger('GET', `/api/shared/${share.path.split('/').pop()}`, undefined, 404);
  const alert = await rider('POST', `/api/trips/${trip.id}/sos`, {}, 201); assert.equal(alert.dispatched, false);
  await rider('POST', `/api/alerts/${alert.id}/resolve`, { note: 'Not allowed' }, 403);
  await admin('POST', `/api/alerts/${alert.id}/resolve`, { note: 'Demo alert reviewed' });
  await driver('POST', `/api/trips/${trip.id}/call/end`, {});
  trip = (await driver('POST', `/api/trips/${trip.id}/complete`, {})).trip; assert.equal(trip.status, 'completed');
  await driver('POST', `/api/trips/${trip.id}/call`, {}, 403);
  await rider('POST', `/api/trips/${trip.id}/rate`, { rating: 5 });
  await rider('POST', `/api/trips/${trip.id}/rate`, { rating: 4 }, 409);
  const ops = await admin('GET', '/api/bootstrap'); assert.equal(ops.operations.stats.completed, 1); assert.equal(ops.operations.stats.openAlerts, 0);
});
test('driver registration requires review and shift checks before going online', async t => {
  const { client } = await setup(t), driver = client(), admin = client();
  const input = { name: 'New Driver', phone: '0772888999', password: 'TestPassword123!', district: 'Kampala', vehicleType: 'comfort', plate: 'UBE123A', model: 'Toyota Corolla', color: 'Silver', permitRef: 'DEMO-PERMIT-TEST', insuranceRef: 'DEMO-INSURANCE-TEST', consent: true };
  const registered = await driver('POST', '/api/driver/register', input, 201); assert.equal(registered.status, 'pending');
  await driver('POST', '/api/driver/online', { online: true }, 403);
  await admin('POST', '/api/demo/session', { role: 'admin' });
  await admin('POST', `/api/drivers/${registered.user.id}/review`, { status: 'approved', note: 'Demo review only', documentsChecked: true });
  await driver('POST', '/api/driver/online', { online: true }, 403);
  await driver('POST', '/api/driver/checks', { roadworthy: true, helmet: true, lights: true, identity: true });
  await driver('POST', '/api/driver/online', { online: true });
  assert.equal((await driver('GET', '/api/bootstrap')).driver.status, 'approved');
});
test('concurrent acceptance only assigns one driver', async t => {
  const { client } = await setup(t), rider = client(), a = client(), b = client();
  await passenger(rider); const trip = await requestRide(rider);
  await a('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-101' });
  await b('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-102' });
  await Promise.all([a('POST', `/api/trips/${trip.id}/accept`, {}, [200, 409]), b('POST', `/api/trips/${trip.id}/accept`, {}, [200, 409])]);
  // One request is serialised first; the other sees an already assigned trip.
  assert.equal((await rider('GET', `/api/trips/${trip.id}`)).trip.status, 'assigned');
  const states = await Promise.all([a('GET', '/api/bootstrap'), b('GET', '/api/bootstrap')]); assert.equal(states.filter(s => s.activeTrip?.id === trip.id).length, 1);
});
test('night check-in escalation creates an operations alert', async t => {
  const { backend, client } = await setup(t), rider = client(), driver = client(), admin = client();
  await passenger(rider); const trip = await requestRide(rider);
  await driver('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-101' }); await driver('POST', `/api/trips/${trip.id}/accept`, {});
  await rider('POST', '/api/settings/night-preview', { enabled: true });
  backend.db.prepare('UPDATE trips SET night_mode=1,assigned_at=?,last_checkin_at=NULL WHERE id=?').run(Date.now() - 421000, trip.id);
  backend.tick();
  await admin('POST', '/api/demo/session', { role: 'admin' });
  const ops = await admin('GET', '/api/bootstrap'); assert.equal(ops.operations.stats.openAlerts, 1); assert.equal(ops.operations.alerts[0].kind, 'missed_checkin');
  await rider('POST', `/api/trips/${trip.id}/check-in`, {});
  assert.equal((await rider('GET', `/api/trips/${trip.id}`)).trip.night, true);
});
test('production rejects demo sessions, simulated GPS and unverified booking', async t => {
  const { backend, client } = await setup(t, false), c = client();
  await c('POST', '/api/demo/session', { role: 'admin' }, 404);
  await c('POST', '/api/auth/register', { name: 'Real Passenger', phone: '0772111222', password: 'TestPassword123!' }, 201);
  await c('POST', '/api/auth/login', { phone: '0772111222', password: 'TestPassword123!' }, 403);
  backend.db.prepare('UPDATE users SET phone_verified=1 WHERE phone=?').run('+256772111222');
  await c('POST', '/api/auth/login', { phone: '0772111222', password: 'TestPassword123!' });
  await c('POST', '/api/location', { ...pickup, accuracy: 8, source: 'simulated' }, 403);
  await c('POST', '/api/settings/night-preview', { enabled: true }, 403);
});
test('scheduling stores a future request and allows cancellation', async t => {
  const { client: makeClient } = await setup(t); const client = makeClient(); await client('POST', '/api/demo/session', { role: 'passenger' });
  await client('POST', '/api/trips', { pickup, dropoff, service: 'vip', payment: 'cash', scheduledAt: Date.now() + 60000 }, 400);
  const trip = (await client('POST', '/api/trips', { pickup, dropoff, service: 'vip', payment: 'cash', scheduledAt: Date.now() + 3600000 }, 201)).trip;
  assert.equal(trip.status, 'scheduled'); assert.equal((await client('GET', '/api/bootstrap')).upcoming.length, 1);
  await client('POST', `/api/trips/${trip.id}/cancel`, { reason: 'Plans changed' });
  assert.equal((await client('GET', '/api/bootstrap')).upcoming.length, 0);
});
