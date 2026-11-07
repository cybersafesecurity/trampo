import express from 'express';
import { createServer } from 'node:http';
import { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { openStore, hashPassword, checkPassword, user, userProfile, driver, fix, saveFix, event, activeTrip, trip, setting, setSetting, transaction, accountType } from './store.js';
import { createGoogleAuth } from './google.js';
import { inUganda, distanceMeters, isNight, quote, gpsMatch, interpolate, normalizePhone, publicUser, SERVICES, OFFICE } from './domain.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const hash = value => createHash('sha256').update(value).digest('hex');
const id = () => randomUUID();
const json = value => JSON.parse(value);
const positionSchema = z.object({ lat: z.number().finite(), lng: z.number().finite(), name: z.string().trim().max(140).optional() });
const fixSchema = positionSchema.extend({ accuracy: z.number().finite().min(0).max(100000), source: z.enum(['browser', 'simulated']).default('browser') });
class ApiError extends Error { constructor(status, message, code = 'REQUEST_FAILED', details) { super(message); this.status = status; this.code = code; this.details = details; } }
const assert = (condition, status, message, code, details) => { if (!condition) throw new ApiError(status, message, code, details); };
const phoneSchema = z.string().max(40).transform((value, ctx) => {
  try { return normalizePhone(value); }
  catch { ctx.addIssue({ code: 'custom', message: 'Enter a Uganda mobile number, e.g. 0772 000 101.' }); return z.NEVER; }
});

export function createBackend(options = {}) {
  const demo = options.demo ?? (process.env.DEMO_MODE !== 'false' && process.env.NODE_ENV !== 'production');
  const db = openStore(options.dbPath ?? process.env.DATABASE_PATH ?? resolve(root, 'data/trampo.sqlite'), demo);
  const google = createGoogleAuth(db, options);
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 24 * 1024 });
  const clients = new Map();
  const limits = new Map();
  let closed = false;
  app.disable('x-powered-by');
  app.use(express.json({ limit: '32kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    // The preview is embedded by Arena. Configure a deployment-specific CSP frame-ancestors allowlist at your reverse proxy.
    if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('X-Trampo-Client') !== 'web') return next(new ApiError(403, 'Missing client protection header.'));
      const origin = req.get('Origin');
      if (origin) {
        try { assert(new URL(origin).host === req.get('Host') || origin === process.env.PUBLIC_ORIGIN, 403, 'Origin not allowed.'); }
        catch (e) { if (e instanceof ApiError) return next(e); return next(new ApiError(403, 'Invalid origin.')); }
      }
    }
    next();
  });
  const route = fn => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
  function session(req) {
    const cookie = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('trampo_session='));
    if (!cookie) return null;
    const token = cookie.slice('trampo_session='.length);
    if (!/^[a-f0-9]{64}$/.test(token)) return null;
    const s = db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires_at>?').get(hash(token), Date.now());
    return s ? user(db, s.user_id) : null;
  }
  function setSession(res, uid) {
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token), uid, Date.now() + 7 * 86400000);
    // Lax allows the top-level OAuth callback to establish a session; mutations
    // still require the custom client header and an allowed origin below.
    res.cookie('trampo_session', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 7 * 86400000, path: '/' });
  }
  const auth = route((req, res, next) => { req.user = session(req); assert(req.user, 401, 'Please sign in to continue.'); assert(req.user.status === 'active', 403, 'This account is suspended. Contact Trampo operations.'); next(); });
  const admin = (req, res, next) => auth(req, res, () => { assert(req.user.role === 'admin', 403, 'Operations access required.'); next(); });
  const requireDriver = (req, res, next) => auth(req, res, () => { assert(req.user.role === 'driver', 403, 'Driver access required.'); next(); });
  function rateBucket(key, max, window = 60000) {
    const now = Date.now(), old = limits.get(key);
    const bucket = old && now - old.start < window ? old : { start: now, count: 0 };
    bucket.count++; limits.set(key, bucket);
    assert(bucket.count <= max, 429, 'Too many requests. Please wait a minute.');
  }
  app.use('/api', (req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) rateBucket(`api:${req.ip}`, 160);
    next();
  });
  function sendTo(uid, data) {
    for (const ws of clients.get(uid) || []) if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  function refresh() { for (const uid of clients.keys()) sendTo(uid, { type: 'refresh' }); }
  function night() { return isNight(new Date(), demo && setting(db, 'nightPreview', false)); }
  function participant(t, uid) { return t && (t.rider_id === uid || t.driver_id === uid); }
  function callActive(t) { return t && ['assigned', 'in_progress'].includes(t.status); }
  function endCalls(t, reason = 'trip_ended') {
    db.prepare("UPDATE calls SET status='ended',ended_at=? WHERE trip_id=? AND status IN ('ringing','connected')").run(Date.now(), t.id);
    for (const uid of [t.rider_id, t.driver_id]) if (uid) sendTo(uid, { type: 'call-ended', tripId: t.id, reason });
  }
  function serializeTrip(t, uid) {
    if (!t) return null;
    const d = t.driver_id ? driver(db, t.driver_id) : null;
    const r = user(db, t.rider_id);
    const canSee = participant(t, uid) || user(db, uid)?.role === 'admin';
    const match = t.driver_id ? gpsMatch(fix(db, t.rider_id), fix(db, t.driver_id), Date.now(), !!t.night_mode) : null;
    const lastCheck = t.last_checkin_at || t.started_at || t.assigned_at;
    return {
      id: t.id, status: t.status, service: t.service, pickup: json(t.pickup), dropoff: json(t.dropoff),
      fare: t.fare, finalFare: t.final_fare, distanceKm: t.distance_km, minutes: t.minutes, payment: t.payment, note: t.note,
      createdAt: t.created_at, scheduledAt: t.scheduled_at, assignedAt: t.assigned_at, startedAt: t.started_at, endedAt: t.ended_at,
      night: !!t.night_mode, simulated: !!t.simulated, rating: t.rating, cancelReason: t.cancel_reason,
      rider: publicUser(r), driver: d ? { ...publicUser(user(db, d.user_id)), plate: d.plate, model: d.model, color: d.color, vehicleType: d.vehicle_type, rating: d.rating, isDemo: !!d.is_demo } : null,
      ...(canSee ? { riderLocation: fix(db, t.rider_id), driverLocation: t.driver_id ? fix(db, t.driver_id) : null, match,
        riderConfirmedAt: t.rider_confirmed_at, startDistance: t.start_distance,
        checkInDueAt: t.night_mode && ['assigned', 'in_progress'].includes(t.status) ? lastCheck + 300000 : null,
        events: db.prepare('SELECT type,detail,created_at AS createdAt FROM events WHERE trip_id=? ORDER BY created_at DESC LIMIT 30').all(t.id).map(e => ({ ...e, detail: json(e.detail) })) } : {}),
      ...(demo && t.rider_id === uid && t.status === 'assigned' ? { pin: setting(db, `pin:${t.id}`) } : {}),
      ...(demo && t.simulated && uid === t.driver_id && t.status === 'assigned' ? { demoPin: setting(db, `pin:${t.id}`) } : {}),
    };
  }
  // The preview PIN is recoverable solely for the explicitly labelled demo. Real trip PINs are one-way hashed.
  function storePin(t, pin) {
    db.prepare('UPDATE trips SET pin_hash=? WHERE id=?').run(scryptSync(pin, t.id, 32).toString('hex'), t.id);
    if (demo) setSetting(db, `pin:${t.id}`, pin);
  }
  function availableDrivers(service, pickup) {
    return db.prepare("SELECT d.user_id FROM drivers d JOIN users u ON u.id=d.user_id WHERE d.status='approved' AND d.online=1 AND d.vehicle_type=?").all(service)
      .map(row => ({ ...driver(db, row.user_id), location: fix(db, row.user_id) }))
      .filter(d => d.location && Date.now() - d.location.updatedAt < 30000 && distanceMeters(d.location, pickup) <= 8000)
      .sort((a, b) => distanceMeters(a.location, pickup) - distanceMeters(b.location, pickup));
  }
  function assign(t, d) {
    transaction(db, () => {
      const current = trip(db, t.id);
      assert(current.status === 'searching', 409, 'This request is no longer available.');
      assert(!activeTrip(db, d.user_id), 409, 'Driver already has an active trip.');
      const fresh = driver(db, d.user_id);
      assert(fresh.online && fresh.status === 'approved', 409, 'Driver is no longer available.');
      db.prepare('UPDATE trips SET driver_id=?,status=?,assigned_at=?,night_mode=?,simulated=? WHERE id=?').run(d.user_id, 'assigned', Date.now(), +night(), +(!!user(db, t.rider_id).is_demo && !!d.is_demo), t.id);
      event(db, t.id, d.user_id, 'driver_matched', { name: d.name });
    });
    refresh();
  }
  app.get('/api/health', (req, res) => res.json({ ok: true, demo, calling: 'webrtc-p2p' }));
  app.get('/api/config', (req, res) => res.json({ demo, office: OFFICE, services: SERVICES, calling: 'webrtc-p2p', googleSignIn: google.enabled, serverTime: Date.now() }));
  app.post('/api/demo/session', route((req, res) => {
    assert(demo, 404, 'Not found.'); rateBucket(`demo:${req.ip}`, 30);
    const input = z.object({ role: z.enum(['passenger', 'driver', 'admin']), userId: z.string().max(80).optional() }).parse(req.body);
    const uid = input.userId || (input.role === 'passenger' ? 'demo-passenger' : input.role === 'admin' ? 'demo-admin' : 'demo-driver-101');
    const u = user(db, uid);
    assert(u?.is_demo && u.role === input.role, 404, 'Demo account not found.');
    setSession(res, uid); res.json({ user: publicUser(u) });
  }));
  app.post('/api/auth/login', route((req, res) => {
    rateBucket(`login:${req.ip}`, 10);
    const input = z.object({ phone: phoneSchema, password: z.string().min(1).max(128) }).parse(req.body);
    const u = db.prepare('SELECT * FROM users WHERE phone=?').get(input.phone);
    assert(u && checkPassword(input.password, u.password_hash), 401, 'Phone number or password is incorrect.');
    assert(u.status === 'active', 403, 'This account is suspended. Contact Trampo operations.');
    assert(demo || u.phone_verified, 403, 'Phone verification is required. Configure the production identity provider.');
    setSession(res, u.id); res.json({ user: publicUser(u) });
  }));
  app.post('/api/auth/register', route((req, res) => {
    rateBucket(`register:${req.ip}`, 5);
    const input = z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema, password: z.string().min(10).max(128) }).parse(req.body);
    assert(!db.prepare('SELECT id FROM users WHERE phone=?').get(input.phone), 409, 'An account already uses this phone number.');
    const uid = id();
    db.prepare('INSERT INTO users(id,name,phone,password_hash,role,account_type,is_demo,phone_verified,created_at) VALUES(?,?,?,?,?,?,0,0,?)').run(uid, input.name, input.phone, hashPassword(input.password), 'passenger', 'passenger', Date.now());
    if (demo) { db.prepare('UPDATE users SET phone_verified=1 WHERE id=?').run(uid); setSession(res, uid); }
    res.status(201).json({ user: publicUser(user(db, uid)), verificationRequired: !demo });
  }));
  app.post('/api/auth/logout', auth, route((req, res) => {
    const token = req.headers.cookie.split(';').map(s => s.trim()).find(s => s.startsWith('trampo_session='))?.split('=')[1];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));
    res.clearCookie('trampo_session', { path: '/' }); res.json({ ok: true });
  }));
  app.post('/api/auth/google/start', route((req, res) => {
    rateBucket(`google-start:${req.ip}`, 12);
    assert(google.enabled, 503, 'Google sign-in is not configured on this server.', 'GOOGLE_NOT_CONFIGURED');
    const { intent } = z.object({ intent: z.enum(['signin', 'link']).default('signin') }).parse(req.body || {});
    const current = intent === 'link' ? session(req) : null;
    assert(intent !== 'link' || (current && current.status === 'active'), 401, 'Sign in before connecting Google.');
    const flow = google.start({ intent, userId: current?.id });
    res.cookie('trampo_oauth', flow.state, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: flow.maxAge, path: '/api/auth/google' });
    res.json({ url: flow.url });
  }));
  app.get('/api/auth/google/callback', route(async (req, res) => {
    const cookieState = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('trampo_oauth='))?.slice('trampo_oauth='.length);
    res.clearCookie('trampo_oauth', { path: '/api/auth/google' });
    try {
      assert(!req.query.error, 400, 'Google sign-in was cancelled.');
      const result = await google.finish({ state: req.query.state, cookieState, code: req.query.code });
      const identity = result.identity;
      let uid, outcome = 'connected';
      transaction(db, () => {
        const linked = db.prepare('SELECT * FROM users WHERE google_subject=?').get(identity.subject);
        if (result.intent === 'link') {
          const target = user(db, result.userId);
          assert(target && target.status === 'active', 403, 'This account is unavailable.');
          assert(!linked || linked.id === target.id, 409, 'That Google account is already connected to another Trampo account.');
          db.prepare('UPDATE users SET google_subject=?,email=?,email_verified=1,avatar_url=CASE WHEN avatar_url IS NULL OR avatar_url=\'\' THEN ? ELSE avatar_url END,updated_at=? WHERE id=?')
            .run(identity.subject, identity.email, identity.avatarUrl || null, Date.now(), target.id);
          uid = target.id; outcome = 'linked';
        } else if (linked) {
          assert(linked.status === 'active', 403, 'This account is suspended. Contact Trampo operations.');
          uid = linked.id;
          db.prepare('UPDATE users SET email=?,email_verified=1,updated_at=? WHERE id=?').run(identity.email, Date.now(), uid);
        } else {
          // Never merge by email or elevate a role from an OAuth claim. New Google
          // identities are passengers; an existing user must explicitly link.
          uid = id();
          db.prepare('INSERT INTO users(id,name,phone,password_hash,role,account_type,email,email_verified,google_subject,avatar_url,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
            .run(uid, identity.name, null, `!google-only:${randomBytes(24).toString('hex')}`, 'passenger', 'passenger', identity.email, 1, identity.subject, identity.avatarUrl || null, Date.now(), Date.now());
          outcome = 'created';
        }
        event(db, null, uid, outcome === 'created' ? 'google_account_created' : 'google_account_connected');
      });
      setSession(res, uid);
      res.redirect(`/?google=${outcome}#profile`);
    } catch {
      res.redirect('/?google=failed#profile');
    }
  }));
  app.get('/api/bootstrap', auth, route((req, res) => {
    const u = req.user, current = activeTrip(db, u.id), ownFix = fix(db, u.id);
    const trips = db.prepare('SELECT * FROM trips WHERE rider_id=? OR driver_id=? ORDER BY created_at DESC LIMIT 40').all(u.id, u.id).map(t => serializeTrip(t, u.id));
    const nearby = db.prepare("SELECT user_id,vehicle_type FROM drivers WHERE status='approved' AND online=1").all().map(row => {
      const d = driver(db, row.user_id), loc = fix(db, row.user_id);
      if (!loc || Date.now() - loc.updatedAt > 30000) return null;
      return { id: d.user_id, vehicleType: d.vehicle_type, location: loc, isDemo: !!d.is_demo };
    }).filter(Boolean);
    const offers = u.role === 'driver' && driver(db, u.id)?.status === 'approved' ? db.prepare("SELECT * FROM trips WHERE status='searching' AND service=? AND scheduled_at IS NULL ORDER BY created_at DESC LIMIT 10").all(driver(db, u.id).vehicle_type).filter(t => ownFix && distanceMeters(ownFix, json(t.pickup)) < 8000).map(t => serializeTrip(t, u.id)) : [];
    const contacts = db.prepare('SELECT id,name,phone FROM contacts WHERE user_id=?').all(u.id);
    const operations = u.role === 'admin' ? {
      alerts: db.prepare('SELECT a.*,u.name AS userName FROM alerts a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC LIMIT 100').all(),
      drivers: db.prepare('SELECT d.*,u.name,u.phone,u.is_demo FROM drivers d JOIN users u ON u.id=d.user_id ORDER BY u.created_at DESC').all(),
      trips: db.prepare('SELECT * FROM trips ORDER BY created_at DESC LIMIT 100').all().map(t => serializeTrip(t, u.id)),
      stats: { drivers: db.prepare('SELECT COUNT(*) n FROM drivers').get().n, approved: db.prepare("SELECT COUNT(*) n FROM drivers WHERE status='approved'").get().n, pending: db.prepare("SELECT COUNT(*) n FROM drivers WHERE status='pending'").get().n, active: db.prepare("SELECT COUNT(*) n FROM trips WHERE status IN ('assigned','in_progress')").get().n, completed: db.prepare("SELECT COUNT(*) n FROM trips WHERE status='completed'").get().n, openAlerts: db.prepare("SELECT COUNT(*) n FROM alerts WHERE status='open'").get().n },
    } : null;
    res.json({ user: publicUser(u), profile: userProfile(db, u), googleSignIn: google.enabled, driver: u.role === 'driver' ? driver(db, u.id) : null, demo, night: night(), nightPreview: !!setting(db, 'nightPreview', false), office: OFFICE,
      location: ownFix, activeTrip: serializeTrip(current, u.id), trips, upcoming: trips.filter(t => t.status === 'scheduled'), nearby, offers, contacts, operations, serverTime: Date.now() });
  }));
  const vehicleSchema = z.object({ vehicleType: z.enum(['boda', 'comfort', 'vip']), plate: z.string().trim().min(4).max(16), model: z.string().trim().min(2).max(60), color: z.string().trim().min(2).max(30), permitRef: z.string().trim().min(4).max(80), insuranceRef: z.string().trim().min(4).max(80) }).strict();
  const profileSchema = z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema, city: z.string().trim().min(2).max(80), bio: z.string().trim().max(240).default(''), preferredService: z.enum(['boda', 'comfort', 'vip']).nullable().optional(), accessibilityNote: z.string().trim().max(240).optional(), jobTitle: z.string().trim().max(80).optional(), department: z.string().trim().max(80).optional(), removePhoto: z.boolean().optional(), vehicle: vehicleSchema.optional() }).strict();
  app.get('/api/profile', auth, route((req, res) => res.json({ profile: userProfile(db, req.user) })));
  app.patch('/api/profile', auth, route((req, res) => {
    rateBucket(`profile:${req.user.id}`, 20);
    const input = profileSchema.parse(req.body), u = req.user, d = u.role === 'driver' ? driver(db, u.id) : null;
    assert(!input.vehicle || d, 400, 'Vehicle details belong to a driver or rider profile.');
    assert(!input.jobTitle && !input.department || u.role === 'admin', 400, 'Staff details belong to an admin profile.');
    assert(!input.preferredService && !input.accessibilityNote || u.role === 'passenger', 400, 'Ride preferences belong to a passenger profile.');
    const duplicate = db.prepare('SELECT id FROM users WHERE phone=? AND id!=?').get(input.phone, u.id);
    assert(!duplicate, 409, 'Another account already uses this phone number.');
    const changedVehicle = input.vehicle && d && ['vehicleType', 'plate', 'model', 'color', 'permitRef', 'insuranceRef'].some(key => {
      const old = { vehicleType: d.vehicle_type, plate: d.plate, model: d.model, color: d.color, permitRef: d.permit_ref, insuranceRef: d.insurance_ref }[key];
      const next = key === 'plate' ? input.vehicle[key].toUpperCase() : input.vehicle[key];
      return old !== next;
    });
    assert(!changedVehicle || !activeTrip(db, u.id), 409, 'Finish your active trip before changing registered vehicle details.');
    const phoneChanged = input.phone !== u.phone;
    transaction(db, () => {
      db.prepare(`UPDATE users SET name=?,phone=?,phone_verified=?,city=?,bio=?,preferred_service=?,accessibility_note=?,job_title=?,department=?,avatar_url=CASE WHEN ? THEN NULL ELSE avatar_url END,account_type=?,updated_at=? WHERE id=?`)
        .run(input.name, input.phone, phoneChanged ? +demo : u.phone_verified, input.city, input.bio,
          u.role === 'passenger' ? input.preferredService || null : null, u.role === 'passenger' ? input.accessibilityNote || '' : '',
          u.role === 'admin' ? input.jobTitle || '' : '', u.role === 'admin' ? input.department || '' : '',
          +(!!input.removePhoto), input.vehicle ? accountType('driver', input.vehicle.vehicleType) : u.account_type, Date.now(), u.id);
      if (d && input.vehicle) {
        const v = input.vehicle;
        db.prepare('UPDATE drivers SET vehicle_type=?,plate=?,model=?,color=?,district=?,permit_ref=?,insurance_ref=? WHERE user_id=?')
          .run(v.vehicleType, v.plate.toUpperCase(), v.model, v.color, input.city, v.permitRef, v.insuranceRef, u.id);
        if (changedVehicle) db.prepare("UPDATE drivers SET status='pending',online=0,shift_check_at=NULL,reviewed_at=NULL,review_note='Vehicle or permit details changed; operations re-review required.' WHERE user_id=?").run(u.id);
      }
      event(db, null, u.id, 'profile_updated', { vehicleChanged: !!changedVehicle, phoneChanged });
    });
    if (changedVehicle) refresh();
    res.json({ profile: userProfile(db, user(db, u.id)), reviewRequired: !!changedVehicle });
  }));
  app.get('/api/admin/profiles', admin, route((req, res) => {
    const query = z.object({ kind: z.enum(['all', 'admin', 'car_driver', 'motorbike_rider', 'passenger']).default('all'), q: z.string().trim().max(80).default('') }).parse(req.query);
    const rows = db.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT 500').all();
    const profiles = rows.map(u => userProfile(db, u)).filter(p => (query.kind === 'all' || p.accountType === query.kind) && (!query.q || `${p.name} ${p.email} ${p.phone} ${p.city} ${p.driver?.plate || ''}`.toLowerCase().includes(query.q.toLowerCase())));
    const counts = Object.fromEntries(['admin', 'car_driver', 'motorbike_rider', 'passenger'].map(kind => [kind, rows.filter(u => u.account_type === kind).length]));
    res.json({ profiles, counts, total: rows.length });
  }));
  app.post('/api/admin/profiles/:id/status', admin, route((req, res) => {
    const input = z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(3).max(240) }).strict().parse(req.body);
    const target = user(db, req.params.id);
    assert(target, 404, 'Profile not found.'); assert(target.role !== 'admin', 403, 'Admin access is managed on the server, not through profile suspension.');
    assert(target.id !== req.user.id, 400, 'You cannot suspend your own account.');
    assert(input.status !== 'suspended' || !activeTrip(db, target.id), 409, 'Finish this user’s active trip before suspension.');
    db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(input.status, Date.now(), target.id);
    if (input.status === 'suspended') {
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
      db.prepare('UPDATE drivers SET online=0 WHERE user_id=?').run(target.id);
      for (const ws of wss.clients) if (ws.userId === target.id) ws.close(1008, 'Account suspended');
    }
    event(db, null, req.user.id, 'account_status_changed', { targetId: target.id, status: input.status, reason: input.reason }); refresh();
    res.json({ profile: userProfile(db, user(db, target.id)) });
  }));
  app.post('/api/location', auth, route((req, res) => {
    const input = fixSchema.parse(req.body);
    assert(inUganda(input), 400, 'Trampo currently accepts locations inside Uganda only.');
    assert(input.source !== 'simulated' || demo, 403, 'Simulated GPS is disabled outside the demo.');
    const t = activeTrip(db, req.user.id);
    saveFix(db, req.user.id, input, input.source);
    if (t) refresh();
    res.json({ location: fix(db, req.user.id) });
  }));
  app.post('/api/quotes', auth, route((req, res) => {
    const input = z.object({ pickup: positionSchema, dropoff: positionSchema }).parse(req.body);
    res.json(Object.fromEntries(Object.keys(SERVICES).map(s => [s, quote(input.pickup, input.dropoff, s)])));
  }));
  app.post('/api/trips', auth, route((req, res) => {
    rateBucket(`book:${req.user.id}`, 10);
    assert(req.user.role === 'passenger', 403, 'Use a passenger account to book a ride.');
    assert(req.user.phone, 409, 'Add your Uganda mobile number in My profile before booking.');
    assert(demo || req.user.phone_verified, 403, 'Verify your phone before booking.');
    const input = z.object({ pickup: positionSchema, dropoff: positionSchema, service: z.enum(['boda', 'comfort', 'vip']), payment: z.enum(['cash', 'mobile_money']), note: z.string().trim().max(240).default(''), scheduledAt: z.number().int().optional() }).parse(req.body);
    assert(inUganda(input.pickup) && inUganda(input.dropoff), 400, 'Pickup and destination must be in Uganda.');
    assert(!activeTrip(db, req.user.id), 409, 'Finish or cancel your current request first.');
    if (input.scheduledAt) {
      assert(input.scheduledAt >= Date.now() + 15 * 60000 && input.scheduledAt <= Date.now() + 30 * 86400000, 400, 'Schedule between 15 minutes and 30 days ahead.');
      assert(db.prepare("SELECT COUNT(*) n FROM trips WHERE rider_id=? AND status='scheduled'").get(req.user.id).n < 3, 409, 'You can have up to three upcoming rides.');
    }
    const estimate = quote(input.pickup, input.dropoff, input.service), tid = id(), pin = String(randomBytes(4).readUInt32BE() % 10000).padStart(4, '0');
    db.prepare('INSERT INTO trips(id,rider_id,status,pickup,dropoff,service,fare,distance_km,minutes,pin_hash,payment,note,scheduled_at,night_mode,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(tid, req.user.id, input.scheduledAt ? 'scheduled' : 'searching', JSON.stringify(input.pickup), JSON.stringify(input.dropoff), input.service, estimate.fare, estimate.distanceKm, estimate.minutes, '', input.payment, input.note, input.scheduledAt || null, +night(), Date.now());
    storePin(trip(db, tid), pin); event(db, tid, req.user.id, input.scheduledAt ? 'ride_scheduled' : 'ride_requested', { service: input.service });
    refresh(); res.status(201).json({ trip: serializeTrip(trip(db, tid), req.user.id) });
  }));
  const tripAuth = route((req, res, next) => {
    req.user = session(req); assert(req.user, 401, 'Please sign in.'); assert(req.user.status === 'active', 403, 'This account is suspended.');
    req.trip = trip(db, req.params.id); assert(req.trip, 404, 'Trip not found.');
    assert(participant(req.trip, req.user.id) || req.user.role === 'admin', 403, 'You are not a participant in this trip.'); next();
  });
  app.get('/api/trips/:id', tripAuth, route((req, res) => res.json({ trip: serializeTrip(req.trip, req.user.id) })));
  app.post('/api/trips/:id/accept', requireDriver, route((req, res) => {
    const t = trip(db, req.params.id), d = driver(db, req.user.id);
    assert(t, 404, 'Trip not found.'); assert(d?.status === 'approved' && d.online, 403, 'Get approved and go online first.');
    assert(d.vehicle_type === t.service, 409, 'This request needs a different vehicle class.');
    assert(!activeTrip(db, req.user.id), 409, 'You already have an active trip.');
    assert(fix(db, d.user_id) && Date.now() - fix(db, d.user_id).updatedAt < 30000 && distanceMeters(fix(db, d.user_id), json(t.pickup)) <= 8000, 400, 'This pickup is outside your 8 km dispatch radius, or your GPS needs refreshing.');
    assign(t, d); res.json({ trip: serializeTrip(trip(db, t.id), req.user.id) });
  }));
  app.post('/api/trips/:id/cancel', tripAuth, route((req, res) => {
    const input = z.object({ reason: z.string().trim().max(240).default('Cancelled by user') }).parse(req.body);
    assert(['searching', 'assigned', 'scheduled'].includes(req.trip.status), 409, 'An started trip cannot be cancelled. Contact safety support if you need help.');
    if (req.user.role === 'admin') assert(req.user.id !== req.trip.rider_id, 403, 'Invalid operation.');
    transaction(db, () => {
      db.prepare("UPDATE trips SET status='cancelled',ended_at=?,cancel_reason=? WHERE id=?").run(Date.now(), input.reason, req.trip.id);
      event(db, req.trip.id, req.user.id, 'ride_cancelled', { reason: input.reason });
    });
    endCalls(req.trip); refresh(); res.json({ trip: serializeTrip(trip(db, req.trip.id), req.user.id) });
  }));
  app.post('/api/trips/:id/confirm', tripAuth, route((req, res) => {
    assert(req.user.id === req.trip.rider_id && req.trip.status === 'assigned', 409, 'Only the matched passenger can confirm boarding.');
    const input = z.object({ identityChecked: z.literal(true), safePickup: z.boolean().optional() }).parse(req.body);
    if (req.trip.night_mode) assert(input.safePickup === true, 400, 'Confirm that you are meeting at a well-lit pickup point.');
    const match = gpsMatch(fix(db, req.trip.rider_id), fix(db, req.trip.driver_id), Date.now(), !!req.trip.night_mode);
    assert(match.matched, 409, 'Your GPS locations do not match yet. Move closer and refresh both locations.', 'GPS_NOT_MATCHED', match);
    db.prepare('UPDATE trips SET rider_confirmed_at=? WHERE id=?').run(Date.now(), req.trip.id);
    event(db, req.trip.id, req.user.id, 'passenger_confirmed', { distance: match.distance }); refresh(); res.json({ ok: true, match });
  }));
  app.post('/api/trips/:id/start', tripAuth, route((req, res) => {
    assert(req.user.id === req.trip.driver_id && req.trip.status === 'assigned', 409, 'Only the assigned driver can start this trip.');
    const input = z.object({ pin: z.string().regex(/^\d{4}$/) }).parse(req.body);
    assert(req.trip.pin_attempts < 5, 429, 'PIN attempt limit reached. Cancel and request a new ride.');
    const expected = Buffer.from(req.trip.pin_hash, 'hex'), actual = scryptSync(input.pin, req.trip.id, 32);
    const pinOK = timingSafeEqual(actual, expected);
    if (!pinOK) { db.prepare('UPDATE trips SET pin_attempts=pin_attempts+1 WHERE id=?').run(req.trip.id); event(db, req.trip.id, req.user.id, 'pin_rejected'); }
    assert(pinOK, 400, 'That boarding PIN is not correct. Ask the passenger for their Trampo PIN.', 'PIN_INVALID');
    const match = gpsMatch(fix(db, req.trip.rider_id), fix(db, req.trip.driver_id), Date.now(), !!req.trip.night_mode);
    assert(match.matched, 409, 'Trip cannot start: both phones need fresh, accurate GPS within the pickup threshold.', 'GPS_NOT_MATCHED', match);
    assert(req.trip.rider_confirmed_at && Date.now() - req.trip.rider_confirmed_at <= 120000, 409, 'Ask the passenger to confirm the vehicle and boarding in their app.', 'PASSENGER_NOT_CONFIRMED');
    const d = driver(db, req.user.id);
    assert(d.shift_check_at && Date.now() - d.shift_check_at < 12 * 3600000, 403, 'Complete your shift safety checklist first.');
    transaction(db, () => {
      const current = trip(db, req.trip.id);
      assert(current.status === 'assigned', 409, 'Trip already started.');
      db.prepare("UPDATE trips SET status='in_progress',started_at=?,start_distance=?,last_checkin_at=? WHERE id=?").run(Date.now(), match.distance, Date.now(), req.trip.id);
      event(db, req.trip.id, req.user.id, 'trip_started', { distance: match.distance, threshold: match.threshold, pinVerified: true, passengerConfirmed: true });
    });
    refresh(); res.json({ trip: serializeTrip(trip(db, req.trip.id), req.user.id), match });
  }));
  app.post('/api/trips/:id/complete', tripAuth, route((req, res) => {
    assert(req.user.id === req.trip.driver_id && req.trip.status === 'in_progress', 409, 'Only the driver can complete a started trip.');
    db.prepare("UPDATE trips SET status='completed',ended_at=?,final_fare=fare WHERE id=?").run(Date.now(), req.trip.id);
    db.prepare("UPDATE shares SET revoked_at=? WHERE trip_id=? AND revoked_at IS NULL").run(Date.now(), req.trip.id);
    event(db, req.trip.id, req.user.id, 'trip_completed', { fare: req.trip.fare, billing: 'preview_estimate' }); endCalls(req.trip); refresh();
    res.json({ trip: serializeTrip(trip(db, req.trip.id), req.user.id) });
  }));
  app.post('/api/trips/:id/rate', tripAuth, route((req, res) => {
    assert(req.user.id === req.trip.rider_id && req.trip.status === 'completed', 409, 'Rate your completed trip.');
    const { rating } = z.object({ rating: z.number().int().min(1).max(5) }).parse(req.body);
    assert(!req.trip.rating, 409, 'You have already rated this trip.');
    db.prepare('UPDATE trips SET rating=? WHERE id=?').run(rating, req.trip.id);
    db.prepare('UPDATE drivers SET rating=(SELECT AVG(rating) FROM trips WHERE driver_id=? AND rating IS NOT NULL) WHERE user_id=?').run(req.trip.driver_id, req.trip.driver_id);
    event(db, req.trip.id, req.user.id, 'trip_rated', { rating }); refresh(); res.json({ ok: true });
  }));
  app.post('/api/driver/register', route((req, res) => {
    rateBucket(`driver-register:${req.ip}`, 5);
    const input = z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema, password: z.string().min(10).max(128), district: z.string().trim().min(2).max(80), vehicleType: z.enum(['boda', 'comfort', 'vip']), plate: z.string().trim().min(4).max(16), model: z.string().trim().min(2).max(60), color: z.string().trim().min(2).max(30), permitRef: z.string().trim().min(4).max(80), insuranceRef: z.string().trim().min(4).max(80), consent: z.literal(true) }).parse(req.body);
    assert(!db.prepare('SELECT id FROM users WHERE phone=?').get(input.phone), 409, 'This phone number is already registered. Sign in instead.');
    const uid = id();
    transaction(db, () => {
      db.prepare('INSERT INTO users(id,name,phone,password_hash,role,account_type,is_demo,phone_verified,created_at) VALUES(?,?,?,?,?,?,0,0,?)').run(uid, input.name, input.phone, hashPassword(input.password), 'driver', accountType('driver', input.vehicleType), Date.now());
      db.prepare('INSERT INTO drivers(user_id,vehicle_type,plate,model,color,district,permit_ref,insurance_ref) VALUES(?,?,?,?,?,?,?,?)').run(uid, input.vehicleType, input.plate.toUpperCase(), input.model, input.color, input.district, input.permitRef, input.insuranceRef);
    });
    if (demo) { db.prepare('UPDATE users SET phone_verified=1 WHERE id=?').run(uid); setSession(res, uid); }
    refresh(); res.status(201).json({ user: publicUser(user(db, uid)), status: 'pending', verificationRequired: !demo });
  }));
  app.post('/api/driver/online', requireDriver, route((req, res) => {
    const { online } = z.object({ online: z.boolean() }).parse(req.body), d = driver(db, req.user.id);
    assert(d?.status === 'approved', 403, 'Your driver application is not approved yet.');
    if (online) assert(d.shift_check_at && Date.now() - d.shift_check_at < 12 * 3600000, 403, 'Complete the shift safety checklist before going online.');
    if (!online) assert(!activeTrip(db, req.user.id), 409, 'Finish your active trip before going offline.');
    db.prepare('UPDATE drivers SET online=? WHERE user_id=?').run(+online, req.user.id); refresh(); res.json({ online });
  }));
  app.post('/api/driver/checks', requireDriver, route((req, res) => {
    const input = z.object({ roadworthy: z.literal(true), helmet: z.literal(true), lights: z.literal(true), identity: z.literal(true) }).parse(req.body);
    db.prepare('UPDATE drivers SET shift_check_at=?,shift_check_json=? WHERE user_id=?').run(Date.now(), JSON.stringify(input), req.user.id);
    res.json({ checkedAt: Date.now() });
  }));
  app.post('/api/drivers/:id/review', admin, route((req, res) => {
    const input = z.object({ status: z.enum(['approved', 'rejected']), note: z.string().trim().min(3).max(240), documentsChecked: z.literal(true) }).parse(req.body);
    const d = driver(db, req.params.id); assert(d, 404, 'Driver not found.');
    assert(d.status === 'pending', 409, 'This application has already been reviewed.');
    db.prepare('UPDATE drivers SET status=?,reviewed_at=?,review_note=?,online=0 WHERE user_id=?').run(input.status, Date.now(), input.note, d.user_id);
    event(db, null, req.user.id, 'driver_reviewed', { driverId: d.user_id, status: input.status }); refresh(); res.json({ ok: true });
  }));
  app.post('/api/contacts', auth, route((req, res) => {
    const input = z.object({ name: z.string().trim().min(2).max(80), phone: phoneSchema }).parse(req.body);
    assert(db.prepare('SELECT COUNT(*) n FROM contacts WHERE user_id=?').get(req.user.id).n < 5, 400, 'Save up to five trusted contacts.');
    const cid = id(); db.prepare('INSERT INTO contacts(id,user_id,name,phone) VALUES(?,?,?,?)').run(cid, req.user.id, input.name, input.phone);
    res.status(201).json({ id: cid, ...input });
  }));
  app.delete('/api/contacts/:id', auth, route((req, res) => {
    const result = db.prepare('DELETE FROM contacts WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    assert(result.changes, 404, 'Contact not found.'); res.json({ ok: true });
  }));
  app.post('/api/trips/:id/share', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id), 403, 'Only trip participants can share a journey.');
    assert(callActive(req.trip), 409, 'Match with a driver before sharing your trip.');
    const token = randomBytes(24).toString('base64url'), expires = Date.now() + 12 * 3600000;
    db.prepare('INSERT INTO shares(token_hash,trip_id,expires_at) VALUES(?,?,?)').run(hash(token), req.trip.id, expires);
    event(db, req.trip.id, req.user.id, 'share_link_created'); res.json({ path: `/share/${token}`, expiresAt: expires });
  }));
  app.delete('/api/trips/:id/share', tripAuth, route((req, res) => {
    db.prepare('UPDATE shares SET revoked_at=? WHERE trip_id=? AND revoked_at IS NULL').run(Date.now(), req.trip.id);
    event(db, req.trip.id, req.user.id, 'share_link_revoked'); res.json({ ok: true });
  }));
  app.get('/api/shared/:token', route((req, res) => {
    rateBucket(`share:${req.ip}`, 60);
    assert(/^[A-Za-z0-9_-]{32}$/.test(req.params.token), 404, 'This shared trip is unavailable.');
    const share = db.prepare('SELECT * FROM shares WHERE token_hash=? AND expires_at>? AND revoked_at IS NULL').get(hash(req.params.token), Date.now());
    assert(share, 404, 'This trip link has expired or been revoked.');
    const t = trip(db, share.trip_id); assert(callActive(t), 404, 'This journey has ended.');
    const d = driver(db, t.driver_id), loc = fix(db, t.driver_id);
    res.json({ pickup: json(t.pickup), dropoff: json(t.dropoff), status: t.status, driverName: user(db, t.driver_id).name.split(' ')[0], vehicle: `${d.color} ${d.model}`, plate: d.plate, location: loc, expiresAt: share.expires_at });
  }));
  app.post('/api/trips/:id/sos', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id), 403, 'Only participants can raise a trip alert.');
    assert(callActive(req.trip), 409, 'SOS trip alerts are available during a matched journey. Contact local emergency services directly.');
    const loc = fix(db, req.user.id), aid = id();
    db.prepare('INSERT INTO alerts(id,trip_id,user_id,kind,lat,lng,location_at,created_at) VALUES(?,?,?,?,?,?,?,?)').run(aid, req.trip.id, req.user.id, 'sos', loc?.lat ?? null, loc?.lng ?? null, loc?.updated_at ?? null, Date.now());
    event(db, req.trip.id, req.user.id, 'sos_raised', { alertId: aid, demo }); refresh();
    res.status(201).json({ id: aid, recorded: true, dispatched: false, message: demo ? 'Demo alert recorded in Operations. No emergency service has been contacted.' : 'Alert recorded for operations. This software does not dispatch emergency services.' });
  }));
  app.post('/api/alerts/:id/resolve', admin, route((req, res) => {
    const { note } = z.object({ note: z.string().trim().min(3).max(500) }).parse(req.body);
    const result = db.prepare("UPDATE alerts SET status='resolved',note=?,resolved_at=? WHERE id=? AND status='open'").run(note, Date.now(), req.params.id);
    assert(result.changes, 404, 'Open alert not found.'); event(db, null, req.user.id, 'alert_resolved', { alertId: req.params.id }); refresh(); res.json({ ok: true });
  }));
  app.post('/api/trips/:id/check-in', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id) && callActive(req.trip), 409, 'No active journey to check in.');
    db.prepare('UPDATE trips SET last_checkin_at=?,checkin_escalated=0 WHERE id=?').run(Date.now(), req.trip.id);
    event(db, req.trip.id, req.user.id, 'safety_checkin', { ok: true }); refresh(); res.json({ ok: true });
  }));
  app.post('/api/settings/night-preview', auth, route((req, res) => {
    assert(demo, 403, 'Night preview is only available in demo mode.');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    setSetting(db, 'nightPreview', enabled); refresh(); res.json({ enabled });
  }));
  app.post('/api/demo/trips/:id/advance', tripAuth, route((req, res) => {
    assert(demo && req.trip.simulated, 403, 'Demo movement is only allowed for a simulated trip.');
    assert(participant(req.trip, req.user.id), 403, 'Not your simulated trip.');
    const { phase } = z.object({ phase: z.enum(['pickup', 'destination']) }).parse(req.body);
    assert(phase === 'pickup' ? req.trip.status === 'assigned' : req.trip.status === 'in_progress', 409, 'This simulated movement is not available at this stage.');
    const riderFix = fix(db, req.trip.rider_id), target = phase === 'pickup' ? riderFix : json(req.trip.dropoff);
    assert(target && inUganda(target), 400, 'Passenger location is required first.');
    const point = phase === 'pickup' ? { lat: target.lat + 0.00006, lng: target.lng + 0.00006 } : target;
    saveFix(db, req.trip.driver_id, { ...point, accuracy: 8 }, 'simulated');
    if (phase === 'destination' && riderFix?.source === 'simulated') saveFix(db, req.trip.rider_id, { ...point, accuracy: 8 }, 'simulated');
    event(db, req.trip.id, req.user.id, 'demo_location_advanced', { phase }); refresh(); res.json({ ok: true, source: 'simulated' });
  }));
  app.post('/api/demo/trips/:id/confirm', tripAuth, route((req, res) => {
    assert(demo && req.trip.simulated && req.trip.status === 'assigned', 403, 'Only an explicitly simulated trip can use this demo shortcut.');
    assert(participant(req.trip, req.user.id), 403, 'Not your demo trip.');
    const match = gpsMatch(fix(db, req.trip.rider_id), fix(db, req.trip.driver_id), Date.now(), !!req.trip.night_mode);
    assert(match.matched, 409, 'Both demo GPS locations must match before confirming.', 'GPS_NOT_MATCHED', match);
    db.prepare('UPDATE trips SET rider_confirmed_at=? WHERE id=?').run(Date.now(), req.trip.id);
    event(db, req.trip.id, req.trip.rider_id, 'demo_passenger_confirmed', { distance: match.distance }); refresh(); res.json({ ok: true });
  }));
  app.post('/api/trips/:id/call', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id) && callActive(req.trip), 403, 'Free calling is available only to the matched passenger and driver, until the trip ends.');
    let call = db.prepare("SELECT * FROM calls WHERE trip_id=? AND status IN ('ringing','connected')").get(req.trip.id);
    if (call && call.initiated_by !== req.user.id && call.status === 'ringing') assert(false, 409, 'The other participant is already calling. Answer the incoming call instead.');
    if (!call) {
      const cid = id(); db.prepare("INSERT INTO calls(id,trip_id,initiated_by,status,started_at) VALUES(?,?,?,'ringing',?)").run(cid, req.trip.id, req.user.id, Date.now());
      call = db.prepare('SELECT * FROM calls WHERE id=?').get(cid); event(db, req.trip.id, req.user.id, 'call_started');
    }
    res.json({ callId: call.id, initiator: call.initiated_by, mode: 'webrtc-p2p', iceServers: iceConfig(), expiresInSeconds: 60 });
  }));
  app.get('/api/trips/:id/call/config', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id) && callActive(req.trip), 403, 'Calling is only available during a matched trip.');
    res.json({ iceServers: iceConfig() });
  }));
  app.post('/api/trips/:id/call/answer', tripAuth, route((req, res) => {
    assert(participant(req.trip, req.user.id) && callActive(req.trip), 403, 'Calling is only available to the matched passenger and driver, until the trip ends.');
    const call = db.prepare("SELECT * FROM calls WHERE trip_id=? AND status IN ('ringing','connected')").get(req.trip.id);
    assert(call && call.initiated_by !== req.user.id, 409, 'There is no incoming call to answer.');
    db.prepare("UPDATE calls SET status='connected',answered_at=coalesce(answered_at,?) WHERE id=?").run(Date.now(), call.id);
    event(db, req.trip.id, req.user.id, 'call_answered'); refresh();
    res.json({ ok: true, callId: call.id });
  }));
  function iceConfig() {
    const servers = [];
    if (process.env.STUN_URL !== '') servers.push({ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' });
    if (process.env.TURN_URLS) servers.push({ urls: process.env.TURN_URLS.split(','), username: process.env.TURN_USERNAME, credential: process.env.TURN_CREDENTIAL });
    return servers;
  }
  app.post('/api/trips/:id/call/end', tripAuth, route((req, res) => { endCalls(req.trip, 'hangup'); res.json({ ok: true }); }));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint not found.' }));
  app.use('/api', (err, req, res, next) => {
    if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '), code: 'VALIDATION_ERROR' });
    if (err instanceof ApiError) return res.status(err.status).json({ error: err.message, code: err.code, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body.' });
    console.error('[api]', err.message); res.status(500).json({ error: 'Something went wrong. Please try again.' });
  });
  server.on('upgrade', (req, socket, head) => {
    if (req.url?.split('?')[0] !== '/ws') return;
    const u = session(req);
    const origin = req.headers.origin;
    let originOK = !origin;
    try { originOK ||= new URL(origin).host === req.headers.host || origin === process.env.PUBLIC_ORIGIN; } catch {}
    if (!u || u.status !== 'active' || !originOK) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, ws => {
      ws.userId = u.id; ws.alive = true; ws.messageCount = 0; ws.rateStart = Date.now();
      if (!clients.has(u.id)) clients.set(u.id, new Set());
      clients.get(u.id).add(ws);
      ws.on('pong', () => { ws.alive = true; });
      ws.on('error', () => {});
      ws.on('close', () => { clients.get(u.id)?.delete(ws); if (!clients.get(u.id)?.size) clients.delete(u.id); });
      ws.on('message', raw => {
        if (Date.now() - ws.rateStart > 10000) { ws.rateStart = Date.now(); ws.messageCount = 0; }
        if (++ws.messageCount > 150) { ws.close(1008, 'Rate limit'); return; }
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
          if (!['call-offer', 'call-answer', 'call-ice', 'call-end'].includes(msg.type)) return;
          const t = trip(db, msg.tripId);
          if (!participant(t, u.id) || !callActive(t) || typeof msg.callId !== 'string') return;
          const call = db.prepare('SELECT * FROM calls WHERE id=? AND trip_id=?').get(msg.callId, t.id);
          if (!call || call.status === 'ended') return;
          const other = u.id === t.rider_id ? t.driver_id : t.rider_id;
          if (msg.offer && (msg.offer.type !== 'offer' || typeof msg.offer.sdp !== 'string')) return;
          if (msg.answer && (msg.answer.type !== 'answer' || typeof msg.answer.sdp !== 'string')) return;
          if (msg.type === 'call-offer' && call.initiated_by === u.id) sendTo(other, { type: 'call-offer', tripId: t.id, callId: call.id, offer: msg.offer, caller: publicUser(u) });
          if (msg.type === 'call-answer' && call.initiated_by !== u.id && call.status !== 'ended') {
            db.prepare("UPDATE calls SET status='connected',answered_at=coalesce(answered_at,?) WHERE id=?").run(Date.now(), call.id);
            sendTo(other, { type: 'call-answer', callId: call.id, answer: msg.answer });
          }
          if (msg.type === 'call-ice') sendTo(other, { type: 'call-ice', callId: call.id, candidate: msg.candidate });
          if (msg.type === 'call-end') endCalls(t, 'hangup');
        } catch { /* Untrusted signaling payloads are ignored. */ }
      });
      ws.send(JSON.stringify({ type: 'connected' }));
    });
  });
  function tick() {
    if (closed) return;
    const now = Date.now();
    if (demo) {
      for (const row of db.prepare("SELECT id FROM users WHERE is_demo=1 AND role != 'admin'").all()) {
        const f = fix(db, row.id);
        if (f?.source === 'simulated') saveFix(db, row.id, f, 'simulated', now);
      }
      for (const t of db.prepare("SELECT * FROM trips WHERE status='assigned' AND simulated=1").all()) {
        const df = fix(db, t.driver_id), rf = fix(db, t.rider_id);
        if (df?.source === 'simulated' && rf && distanceMeters(df, rf) > 12) saveFix(db, t.driver_id, { ...interpolate(df, rf, 0.16), accuracy: 8 }, 'simulated', now);
      }
      for (const t of db.prepare("SELECT * FROM trips WHERE status='searching' AND simulated=0").all()) {
        // Only auto-dispatch requests made by seed demo passengers. New accounts use real driver acceptance.
        if (!user(db, t.rider_id).is_demo || now - t.created_at < 1600) continue;
        const d = availableDrivers(t.service, json(t.pickup)).find(d => d.is_demo && !activeTrip(db, d.user_id));
        if (d) { try { assign(t, d); } catch {} }
      }
    }
    for (const t of db.prepare("SELECT * FROM trips WHERE status='scheduled' AND scheduled_at<=?").all(now)) {
      db.prepare("UPDATE trips SET status='searching',created_at=? WHERE id=?").run(now, t.id); event(db, t.id, t.rider_id, 'scheduled_dispatch_started'); refresh();
    }
    for (const t of db.prepare("SELECT * FROM trips WHERE status IN ('assigned','in_progress')").all()) {
      if (!!t.night_mode !== night()) {
        db.prepare('UPDATE trips SET night_mode=?,last_checkin_at=?,checkin_escalated=0 WHERE id=?').run(+night(), now, t.id);
        event(db, t.id, null, night() ? 'night_shield_activated' : 'night_shield_ended'); refresh();
      }
    }
    for (const t of db.prepare("SELECT * FROM trips WHERE status IN ('assigned','in_progress') AND night_mode=1 AND checkin_escalated=0").all()) {
      const due = (t.last_checkin_at || t.started_at || t.assigned_at) + 300000;
      if (now > due + 120000) {
        const aid = id();
        db.prepare("INSERT INTO alerts(id,trip_id,user_id,kind,lat,lng,location_at,created_at) VALUES(?,?,?,'missed_checkin',?,?,?,?)").run(aid, t.id, t.rider_id, fix(db, t.rider_id)?.lat ?? null, fix(db, t.rider_id)?.lng ?? null, fix(db, t.rider_id)?.updated_at ?? null, now);
        db.prepare('UPDATE trips SET checkin_escalated=1 WHERE id=?').run(t.id); event(db, t.id, null, 'checkin_escalated', { alertId: aid }); refresh();
      }
    }
    for (const call of db.prepare("SELECT c.* FROM calls c JOIN trips t ON t.id=c.trip_id WHERE c.status='ringing' AND c.started_at<?").all(now - 45000)) endCalls(trip(db, call.trip_id), 'no_answer');
    for (const [key, value] of limits) if (now - value.start > 120000) limits.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires_at<?').run(now);
    db.prepare('DELETE FROM oauth_flows WHERE expires_at<?').run(now);
    for (const ws of wss.clients) { if (!ws.alive) { ws.terminate(); continue; } ws.alive = false; ws.ping(); }
  }
  const timer = options.autoTick === false ? null : setInterval(tick, 2000); timer?.unref();
  const pinCleanup = setInterval(() => { db.prepare("DELETE FROM settings WHERE key LIKE 'pin:%' AND key NOT IN (SELECT 'pin:' || id FROM trips WHERE status IN ('assigned','searching'))").run(); }, 3600000); pinCleanup.unref();
  async function close() {
    closed = true; clearInterval(timer); clearInterval(pinCleanup);
    for (const ws of wss.clients) ws.close();
    await new Promise(resolve => server.close(resolve)); db.close();
  }
  return { app, server, db, demo, refresh, tick, close, serializeTrip };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const backend = createBackend();
  const { app, server, demo } = backend;
  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(resolve(root, 'dist')));
    app.get('/{*path}', (req, res) => res.sendFile(resolve(root, 'dist/index.html')));
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ root, server: { middlewareMode: true, hmr: { server }, allowedHosts: true }, appType: 'spa' });
    app.use(vite.middlewares);
  }
  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`Trampo ${demo ? 'DEMO' : 'production'} ready on http://0.0.0.0:${port}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await backend.close(); process.exit(0); });
}
