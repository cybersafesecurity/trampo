import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function checkPassword(password, stored) {
  if (typeof stored !== 'string' || !/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) return false;
  const [salt, key] = stored.split(':');
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(key, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
export function openStore(path, demo = true) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'passenger', is_demo INTEGER DEFAULT 0, phone_verified INTEGER DEFAULT 0, created_at INTEGER NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, google_subject TEXT UNIQUE, avatar_url TEXT, city TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', preferred_service TEXT, accessibility_note TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS drivers(user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL DEFAULT 'pending', online INTEGER NOT NULL DEFAULT 0, vehicle_type TEXT NOT NULL, plate TEXT NOT NULL, model TEXT NOT NULL, color TEXT NOT NULL, district TEXT NOT NULL, permit_ref TEXT NOT NULL, insurance_ref TEXT NOT NULL, rating REAL NOT NULL DEFAULT 5, shift_check_at INTEGER, shift_check_json TEXT, reviewed_at INTEGER, review_note TEXT);
    CREATE TABLE IF NOT EXISTS locations(user_id TEXT PRIMARY KEY REFERENCES users(id), lat REAL NOT NULL, lng REAL NOT NULL, accuracy REAL NOT NULL, source TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS trips(id TEXT PRIMARY KEY, rider_id TEXT NOT NULL REFERENCES users(id), driver_id TEXT REFERENCES users(id), status TEXT NOT NULL, pickup TEXT NOT NULL, dropoff TEXT NOT NULL, service TEXT NOT NULL, fare INTEGER NOT NULL, distance_km REAL NOT NULL, minutes INTEGER NOT NULL, pin_hash TEXT NOT NULL, pin_attempts INTEGER DEFAULT 0, payment TEXT NOT NULL, note TEXT DEFAULT '', scheduled_at INTEGER, night_mode INTEGER DEFAULT 0, simulated INTEGER DEFAULT 0, created_at INTEGER NOT NULL, assigned_at INTEGER, rider_confirmed_at INTEGER, started_at INTEGER, ended_at INTEGER, start_distance REAL, final_fare INTEGER, rating INTEGER, cancel_reason TEXT, last_checkin_at INTEGER, checkin_escalated INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT, trip_id TEXT, actor_id TEXT, type TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS contacts(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, phone TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY, trip_id TEXT REFERENCES trips(id), user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, lat REAL, lng REAL, location_at INTEGER, status TEXT NOT NULL DEFAULT 'open', note TEXT DEFAULT '', created_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE TABLE IF NOT EXISTS shares(token_hash TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), expires_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY, trip_id TEXT NOT NULL REFERENCES trips(id), initiated_by TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL, started_at INTEGER NOT NULL, answered_at INTEGER, ended_at INTEGER);
    CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oauth_flows(state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, intent TEXT NOT NULL, user_id TEXT REFERENCES users(id), expires_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS trips_rider ON trips(rider_id, created_at); CREATE INDEX IF NOT EXISTS trips_driver ON trips(driver_id, status); CREATE INDEX IF NOT EXISTS events_trip ON events(trip_id, created_at);
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_rider ON trips(rider_id) WHERE status IN ('searching','assigned','in_progress');
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_driver ON trips(driver_id) WHERE status IN ('assigned','in_progress');
  `);
  // v1 stored a NOT NULL phone and no identity/profile columns. Rebuild only that
  // legacy table, preserving every id so trips, sessions and foreign keys survive.
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (!columns.some(c => c.name === 'email') || columns.find(c => c.name === 'phone')?.notnull) {
    const previousForeignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
    db.exec('PRAGMA foreign_keys=OFF');
    try {
      transaction(db, () => {
        db.exec(`CREATE TABLE users_profile_v2(id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL, account_type TEXT NOT NULL DEFAULT 'passenger', is_demo INTEGER DEFAULT 0, phone_verified INTEGER DEFAULT 0, created_at INTEGER NOT NULL, email TEXT, email_verified INTEGER NOT NULL DEFAULT 0, google_subject TEXT UNIQUE, avatar_url TEXT, city TEXT NOT NULL DEFAULT '', bio TEXT NOT NULL DEFAULT '', preferred_service TEXT, accessibility_note TEXT NOT NULL DEFAULT '', job_title TEXT NOT NULL DEFAULT '', department TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active', updated_at INTEGER);
          INSERT INTO users_profile_v2(id,name,phone,password_hash,role,is_demo,phone_verified,created_at) SELECT id,name,phone,password_hash,role,is_demo,phone_verified,created_at FROM users;
          DROP TABLE users; ALTER TABLE users_profile_v2 RENAME TO users;`);
      });
    } finally { db.exec(`PRAGMA foreign_keys=${previousForeignKeys}`); }
    const violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length) throw new Error('Profile migration preserved invalid foreign keys; restore the database backup.');
  }
  db.exec(`UPDATE users SET account_type=CASE WHEN role='admin' THEN 'admin' WHEN role='driver' THEN CASE WHEN EXISTS(SELECT 1 FROM drivers d WHERE d.user_id=users.id AND d.vehicle_type='boda') THEN 'motorbike_rider' ELSE 'car_driver' END ELSE 'passenger' END;
    UPDATE users SET city='Kampala' WHERE is_demo=1 AND city='';
    UPDATE users SET job_title='Operations manager', department='Safety & partner operations' WHERE id='demo-admin';
    UPDATE users SET preferred_service='boda' WHERE id='demo-passenger';`);
  const count = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (!count && demo) transaction(db, () => seed(db));
  return db;
}
export function user(db, id) { return db.prepare('SELECT * FROM users WHERE id = ?').get(id); }
export function driver(db, id) {
  return db.prepare('SELECT d.*, u.name, u.phone, u.is_demo, u.avatar_url FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.user_id=?').get(id);
}
export function accountType(role, vehicleType) {
  return role === 'driver' ? (vehicleType === 'boda' ? 'motorbike_rider' : 'car_driver') : role;
}
export function userProfile(db, u) {
  if (!u) return null;
  const d = u.role === 'driver' ? driver(db, u.id) : null;
  return {
    id: u.id, name: u.name, role: u.role, accountType: accountType(u.role, d?.vehicle_type),
    phone: u.phone || '', initials: u.name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase(),
    email: u.email || '', emailVerified: !!u.email_verified, phoneVerified: !!u.phone_verified,
    googleLinked: !!u.google_subject, hasPassword: /^[a-f0-9]{32}:[a-f0-9]{128}$/.test(u.password_hash),
    avatarUrl: u.avatar_url || '', city: u.city || '', bio: u.bio || '',
    preferredService: u.preferred_service || null, accessibilityNote: u.accessibility_note || '',
    jobTitle: u.job_title || '', department: u.department || '', status: u.status,
    isDemo: !!u.is_demo, createdAt: u.created_at, updatedAt: u.updated_at || u.created_at,
    driver: d || null,
  };
}
export function fix(db, id) {
  const p = db.prepare('SELECT *, updated_at AS updatedAt FROM locations WHERE user_id=?').get(id);
  return p ? { lat: p.lat, lng: p.lng, accuracy: p.accuracy, source: p.source, updatedAt: p.updated_at } : null;
}
export function saveFix(db, id, position, source, now = Date.now()) {
  db.prepare('INSERT INTO locations(user_id,lat,lng,accuracy,source,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET lat=excluded.lat,lng=excluded.lng,accuracy=excluded.accuracy,source=excluded.source,updated_at=excluded.updated_at').run(id, position.lat, position.lng, position.accuracy ?? 8, source, now);
}
export function event(db, tripId, actorId, type, detail = {}) {
  db.prepare('INSERT INTO events(trip_id,actor_id,type,detail,created_at) VALUES(?,?,?,?,?)').run(tripId, actorId, type, JSON.stringify(detail), Date.now());
}
export function activeTrip(db, uid) {
  return db.prepare("SELECT * FROM trips WHERE (rider_id=? OR driver_id=?) AND status IN ('searching','assigned','in_progress') ORDER BY created_at DESC LIMIT 1").get(uid, uid);
}
export function trip(db, id) { return db.prepare('SELECT * FROM trips WHERE id=?').get(id); }
export function setting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? JSON.parse(row.value) : fallback;
}
export function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function seed(db) {
  const now = Date.now();
  const add = (id, name, phone, role, vehicle, lat, lng) => {
    db.prepare('INSERT INTO users(id,name,phone,password_hash,role,account_type,is_demo,phone_verified,created_at) VALUES(?,?,?,?,?,?,1,1,?)').run(id, name, phone, hashPassword('TrampoDemo!23'), role, role === 'driver' ? (vehicle === 'boda' ? 'motorbike_rider' : 'car_driver') : role, now);
    saveFix(db, id, { lat, lng, accuracy: 8 }, 'simulated', now);
    if (vehicle) db.prepare('INSERT INTO drivers(user_id,status,online,vehicle_type,plate,model,color,district,permit_ref,insurance_ref,rating,shift_check_at,shift_check_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, 'approved', 1, vehicle, `UBD ${id.slice(-3)}X`, vehicle === 'boda' ? 'Bajaj Boxer' : vehicle === 'vip' ? 'Toyota Prado' : 'Toyota Corolla', vehicle === 'vip' ? 'Obsidian black' : 'Silver', 'Kampala', 'DEMO-PERMIT', 'DEMO-INSURANCE', 4.9, now, JSON.stringify({ roadworthy: true, helmet: true, lights: true, identity: true }));
  };
  add('demo-passenger', 'Nakato Amara', '+256772000101', 'passenger', null, 0.3354, 32.5769);
  add('demo-admin', 'Trampo Operations', '+256772000100', 'admin', null, 0.3476, 32.6155);
  add('demo-driver-101', 'Musa Kato', '+256772000102', 'driver', 'boda', 0.3404, 32.5731);
  add('demo-driver-102', 'David Okello', '+256772000103', 'driver', 'boda', 0.3318, 32.5678);
  add('demo-driver-103', 'Isaac Ssemakula', '+256772000104', 'driver', 'boda', 0.3467, 32.5845);
  add('demo-driver-104', 'Sarah Nambi', '+256772000105', 'driver', 'comfort', 0.3385, 32.5870);
  add('demo-driver-105', 'James Mugisha', '+256772000106', 'driver', 'comfort', 0.3287, 32.5808);
  add('demo-driver-106', 'Daniel Wasswa', '+256772000107', 'driver', 'vip', 0.3416, 32.5902);
  db.prepare('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)').run('demo-contact', 'demo-passenger', 'Amina (demo contact)', '+256772000199');
}
