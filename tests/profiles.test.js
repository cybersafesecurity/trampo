import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from '../server/index.js';
import { openStore, hashPassword } from '../server/store.js';

async function setup(t, options = {}) {
  const backend = createBackend({ dbPath: ':memory:', demo: true, autoTick: false, ...options });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.server.address().port}`;
  t.after(() => backend.close());
  function client() {
    let cookie = '';
    return async (method, path, body, expected = 200) => {
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'X-Trampo-Client': 'web', ...(cookie ? { Cookie: cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'manual' });
      const sessionCookie = response.headers.getSetCookie().find(c => c.startsWith('trampo_session='));
      if (sessionCookie) cookie = sessionCookie.split(';')[0];
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      assert.ok(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected, `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`);
      return { data, response, cookie: () => cookie };
    };
  }
  return { backend, base, client };
}
const personal = { name: 'Updated Person', phone: '0772123450', city: 'Jinja', bio: 'I enjoy quiet journeys.' };

test('legacy profile migration preserves accounts and allows Google accounts without a phone', () => {
  const dir = mkdtempSync(join(tmpdir(), 'trampo-migration-'));
  const path = join(dir, 'legacy.sqlite');
  try {
    const legacy = new DatabaseSync(path);
    legacy.exec("CREATE TABLE users(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL, is_demo INTEGER DEFAULT 0, phone_verified INTEGER DEFAULT 0, created_at INTEGER NOT NULL)");
    legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('legacy-user', 'Legacy User', '+256772123456', hashPassword('LegacyPassword123!'), 'passenger', 0, 1, Date.now());
    legacy.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run('legacy-admin', 'Legacy Admin', '+256772123457', hashPassword('LegacyPassword123!'), 'admin', 0, 1, Date.now());
    legacy.close();
    const db = openStore(path, false);
    const row = db.prepare('SELECT * FROM users WHERE id=?').get('legacy-user');
    assert.equal(row.name, 'Legacy User'); assert.equal(row.account_type, 'passenger'); assert.equal(row.status, 'active');
    assert.equal(db.prepare('SELECT account_type FROM users WHERE id=?').get('legacy-admin').account_type, 'admin');
    assert.equal(db.prepare('PRAGMA table_info(users)').get().name, 'id');
    assert.equal(db.prepare('PRAGMA table_info(users)').all().find(c => c.name === 'phone').notnull, 0);
    db.prepare('INSERT INTO users(id,name,phone,password_hash,role,account_type,email,email_verified,google_subject,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run('google-user', 'Google User', null, '!google-only:test', 'passenger', 'passenger', 'user@example.com', 1, 'subject-1', Date.now());
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 3);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    db.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('all four profile types edit safely and admin directory enforces permissions', async t => {
  const { client } = await setup(t), passenger = client(), car = client(), rider = client(), admin = client();
  await passenger('POST', '/api/demo/session', { role: 'passenger' });
  await car('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-104' });
  await rider('POST', '/api/demo/session', { role: 'driver', userId: 'demo-driver-101' });
  await admin('POST', '/api/demo/session', { role: 'admin' });
  assert.equal((await passenger('GET', '/api/profile')).data.profile.accountType, 'passenger');
  assert.equal((await car('GET', '/api/profile')).data.profile.accountType, 'car_driver');
  assert.equal((await rider('GET', '/api/profile')).data.profile.accountType, 'motorbike_rider');
  assert.equal((await admin('GET', '/api/profile')).data.profile.accountType, 'admin');

  const saved = await passenger('PATCH', '/api/profile', { ...personal, preferredService: 'vip', accessibilityNote: 'Extra pickup time please' });
  assert.equal(saved.data.profile.city, 'Jinja'); assert.equal(saved.data.profile.preferredService, 'vip');
  assert.equal((await passenger('GET', '/api/bootstrap')).data.profile.name, 'Updated Person');
  await passenger('PATCH', '/api/profile', { ...personal, phone: '123' }, 400);
  await passenger('PATCH', '/api/profile', { ...personal, phone: '0772000100' }, 409);
  await passenger('PATCH', '/api/profile', { ...personal, vehicle: { vehicleType: 'boda', plate: 'UBA123A', model: 'Boxer', color: 'Red', permitRef: 'DEMO-P', insuranceRef: 'DEMO-I' } }, 400);
  await passenger('GET', '/api/admin/profiles', undefined, 403);

  const adminSave = await admin('PATCH', '/api/profile', { ...personal, name: 'Operations Lead', phone: '0772000100', jobTitle: 'Safety lead', department: 'Night operations' });
  assert.equal(adminSave.data.profile.jobTitle, 'Safety lead');
  const directory = await admin('GET', '/api/admin/profiles?kind=motorbike_rider');
  assert.equal(directory.data.profiles.length, 3); assert.ok(directory.data.profiles.every(p => p.accountType === 'motorbike_rider'));
  assert.equal(directory.data.counts.car_driver, 3);

  const carProfile = (await car('GET', '/api/profile')).data.profile;
  const vehicle = { vehicleType: carProfile.driver.vehicle_type, plate: 'UBE999Z', model: carProfile.driver.model, color: carProfile.driver.color, permitRef: carProfile.driver.permit_ref, insuranceRef: carProfile.driver.insurance_ref };
  const changed = await car('PATCH', '/api/profile', { ...personal, name: carProfile.name, phone: carProfile.phone, vehicle });
  assert.equal(changed.data.reviewRequired, true); assert.equal(changed.data.profile.driver.status, 'pending'); assert.equal(changed.data.profile.driver.online, 0);
  await car('POST', '/api/driver/online', { online: true }, 403);

  const target = (await passenger('GET', '/api/profile')).data.profile;
  await admin('POST', `/api/admin/profiles/${target.id}/status`, { status: 'suspended', reason: 'Profile test suspension' });
  await passenger('GET', '/api/bootstrap', undefined, 401);
  await admin('POST', `/api/admin/profiles/${target.id}/status`, { status: 'active', reason: 'Profile test restored' });
  await admin('POST', `/api/admin/profiles/demo-admin/status`, { status: 'suspended', reason: 'Not permitted' }, 403);
});
