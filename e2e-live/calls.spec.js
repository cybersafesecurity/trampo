import { test, expect } from '@playwright/test';

const ORIGIN = 'https://euknlccrsfvuaymuecpd.supabase.co';
const TRIP_ID = '11111111-1111-4111-8111-111111111111';
const CALL_ID = '22222222-2222-4222-8222-222222222222';
const passenger = { id: '00000000-0000-4000-8000-000000000011', name: 'Call Passenger', role: 'passenger', accountType: 'passenger', phone: '+256772000301', initials: 'CP', avatarUrl: '' };
const driver = { id: '00000000-0000-4000-8000-000000000012', name: 'Call Driver', role: 'driver', accountType: 'motorbike_rider', phone: '+256772000302', initials: 'CD', avatarUrl: '', plate: 'UBD 302X', model: 'Bajaj Boxer', color: 'Silver', vehicleType: 'boda', rating: 4.9, isDemo: false };
const authUser = person => ({ id: person.id, aud: 'authenticated', role: 'authenticated', email: `${person.role}@calls.example.test`, email_confirmed_at: '2026-11-09T00:00:00Z', created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: person.name }, identities: [] });
const session = person => ({ access_token: `token-${person.role}`, refresh_token: `refresh-${person.role}`, expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user: authUser(person) });
const trip = () => ({ id: TRIP_ID, status: 'assigned', service: 'boda', pickup: { lat: .3354, lng: 32.5769, name: 'Acacia Mall', area: 'Kampala' }, dropoff: { lat: .3117, lng: 32.575, name: 'Garden City', area: 'Kampala' }, stops: [], fare: 5000, distanceKm: 3, minutes: 10, payment: 'cash', note: '', createdAt: Date.now(), assignedAt: Date.now(), night: false, simulated: false, rider: passenger, driver, match: { matched: true, distance: 5, threshold: 50, reasons: [] }, riderConfirmedAt: null, events: [] });
const bootstrap = person => ({ user: person, profile: { ...person, email: `${person.role}@calls.example.test`, emailVerified: true, phoneVerified: true, googleLinked: false, hasPassword: true, city: 'Kampala', bio: '', preferredService: null, accessibilityNote: '', jobTitle: '', department: '', status: 'active', isDemo: false, createdAt: Date.now(), updatedAt: Date.now(), driver: person.role === 'driver' ? { user_id: person.id, status: 'approved', online: 1, vehicle_type: 'boda', plate: driver.plate, model: driver.model, color: driver.color, district: 'Kampala', rating: 4.9, shift_check_at: Date.now(), is_demo: 0 } : null }, googleSignIn: false, driver: person.role === 'driver' ? { name: person.name, status: 'approved', online: 1, vehicle_type: 'boda', plate: driver.plate, model: driver.model, color: driver.color, district: 'Kampala', rating: 4.9, shift_check_at: Date.now(), is_demo: 0 } : null, demo: false, night: false, nightPreview: false, office: 'Ntinda', location: { lat: .3354, lng: 32.5769, accuracy: 8, source: 'browser', updatedAt: Date.now() }, activeTrip: trip(), trips: [], upcoming: [], nearby: [], offers: [], contacts: [], operations: null, serverTime: Date.now() });

let peers = new Set(), stats, mode = 'normal';
const freshStats = () => ({ offers: 0, answers: 0, ice: 0, acks: 0, droppedOffers: 0, droppedAnswers: 0 });
test.beforeEach(() => { peers.clear(); mode = 'normal'; stats = freshStats(); });

function decodePhoenix(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  // Supabase Realtime v2 sends user broadcasts as binary kind 3 frames.
  if (buf[0] === 3) {
    let offset = 1;
    const joinLen = buf[offset++], refLen = buf[offset++], topicLen = buf[offset++], eventLen = buf[offset++], metaLen = buf[offset++], encoding = buf[offset++];
    const read = len => { const value = buf.toString('utf8', offset, offset + len); offset += len; return value; };
    const joinRef = read(joinLen), ref = read(refLen), topic = read(topicLen), userEvent = read(eventLen); read(metaLen);
    const payloadBytes = buf.subarray(offset);
    const payload = encoding === 1 ? JSON.parse(payloadBytes.toString('utf8')) : payloadBytes;
    return { join_ref: joinRef || null, ref: ref || null, topic, event: 'broadcast', payload: { type: 'broadcast', event: userEvent, payload } };
  }
  const parsed = JSON.parse(buf.toString('utf8'));
  if (Array.isArray(parsed)) return { join_ref: parsed[0], ref: parsed[1], topic: parsed[2], event: parsed[3], payload: parsed[4] };
  return parsed;
}

function phoenixMock(ws) {
  const client = { ws, userId: null, topic: null }; peers.add(client);
  ws.onClose(() => peers.delete(client));
  ws.onMessage(raw => {
    let msg; try { msg = decodePhoenix(raw); } catch { return; }
    const encode = value => JSON.stringify([value.join_ref ?? null, value.ref ?? null, value.topic, value.event, value.payload]);
    const reply = (response = {}, status = 'ok') => ws.send(encode({ topic: msg.topic, event: 'phx_reply', ref: msg.ref, join_ref: msg.join_ref ?? null, payload: { status, response } }));
    if (msg.event === 'phx_join') {
      client.userId = msg.payload?.access_token === 'token-driver' ? driver.id : passenger.id;
      client.topic = msg.topic;
      expect(msg.payload?.config?.private).toBe(true);
      expect(msg.payload?.config?.broadcast?.ack).toBe(true);
      reply({}); return;
    }
    if (msg.event === 'heartbeat' || msg.event === 'phx_leave') { reply({}); return; }
    if (msg.event === 'broadcast') {
      const signal = msg.payload?.payload;
      stats.acks++; reply({});
      if (!signal || signal.tripId !== TRIP_ID) return;
      if (signal.type === 'call-offer') stats.offers++;
      if (signal.type === 'call-answer') stats.answers++;
      if (signal.type === 'call-ice') stats.ice++;
      const forward = () => {
        for (const peer of peers) if (peer !== client && peer.topic === client.topic) {
          peer.ws.send(encode({ topic: client.topic, event: 'broadcast', ref: null, join_ref: null, payload: { type: 'broadcast', event: msg.payload.event, payload: signal } }));
        }
      };
      if (mode === 'loss' && signal.type === 'call-offer' && stats.droppedOffers === 0) { stats.droppedOffers++; return; }
      if (mode === 'loss' && signal.type === 'call-answer' && stats.droppedAnswers === 0) { stats.droppedAnswers++; return; }
      if (mode === 'reorder' && signal.type === 'call-offer') { setTimeout(forward, 250); return; }
      forward();
    }
  });
}

async function openParticipant(browser, person, hash) {
  const context = await browser.newContext({ permissions: ['microphone', 'geolocation'] });
  await context.addInitScript(({ session, key }) => { if (location.protocol.startsWith('http')) localStorage.setItem(key, JSON.stringify(session)); }, { session: session(person), key: 'sb-euknlccrsfvuaymuecpd-auth-token' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.routeWebSocket('**/realtime/**', phoenixMock);
  let answered = false, ended = false;
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (url.pathname === '/auth/v1/settings') return json({ external: { email: true, google: false } });
    if (url.pathname === '/auth/v1/user') return json(authUser(person));
    if (url.pathname.endsWith('/trampo-api/config')) return json({ ok: true, demo: false, googleSignIn: false });
    if (url.pathname.endsWith('/trampo-api/bootstrap')) return json(bootstrap(person));
    if (url.pathname.endsWith(`/trampo-api/trips/${TRIP_ID}/call`) && request.method() === 'POST') return json({ callId: CALL_ID, initiator: passenger.id, mode: 'webrtc-p2p', iceServers: [], expiresInSeconds: 60 });
    if (url.pathname.endsWith(`/trampo-api/trips/${TRIP_ID}/call/config`)) return json({ iceServers: [] });
    if (url.pathname.endsWith(`/trampo-api/trips/${TRIP_ID}/call/answer`)) { answered = true; return json({ ok: true, callId: CALL_ID }); }
    if (url.pathname.endsWith(`/trampo-api/trips/${TRIP_ID}/call/end`)) { ended = true; return json({ ok: true }); }
    return json({ error: `Unexpected call-test request: ${url.pathname}` }, 500);
  });
  await page.goto(`/#${hash}`);
  return { context, page, errors, state: () => ({ answered, ended }) };
}

async function expectConnected(page) {
  await expect(page.locator('.call-overlay')).toContainText('Connected', { timeout: 30000 });
  await expect(page.locator('.call-overlay')).not.toContainText('Connecting audio');
  const audio = page.locator('audio[data-trampo-call-audio]');
  await expect(audio).toHaveCount(1);
  expect(await audio.evaluate(element => !!element.srcObject && element.srcObject.getAudioTracks().some(track => track.readyState === 'live'))).toBe(true);
}

test('live Supabase client connects real two-browser audio only after media flows, and end releases both sides', async ({ browser }) => {
  const rider = await openParticipant(browser, passenger, 'ride');
  const captain = await openParticipant(browser, driver, 'drive');
  try {
    await expect(rider.page.getByRole('button', { name: 'Call driver for free' })).toBeVisible();
    await expect(captain.page.getByRole('button', { name: 'Call passenger for free' })).toBeVisible();
    await rider.page.getByRole('button', { name: 'Call driver for free' }).click();
    await expect(captain.page.locator('.call-overlay')).toContainText('Incoming audio call');
    await captain.page.getByRole('button', { name: 'Answer', exact: true }).click();
    // The mocked database answer is immediate; Connected must still wait for RTP.
    expect(captain.state().answered).toBe(true);
    await expectConnected(rider.page); await expectConnected(captain.page);
    expect(stats.acks).toBeGreaterThan(0); expect(stats.ice).toBeGreaterThan(0);
    await rider.page.getByRole('button', { name: 'Mute microphone' }).click();
    await expect(rider.page.getByRole('button', { name: 'Unmute microphone' })).toBeVisible();
    await rider.page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(rider.page.locator('.call-overlay')).toHaveCount(0);
    await expect(captain.page.locator('.call-overlay')).toHaveCount(0);
    await expect(captain.page.locator('audio[data-trampo-call-audio]')).toHaveCount(0);
    expect(rider.errors).toEqual([]); expect(captain.errors).toEqual([]);
  } finally { await rider.context.close(); await captain.context.close(); }
});

test('ack-checked signaling recovers a dropped offer/answer and buffers ICE that arrives before the offer', async ({ browser }) => {
  mode = 'loss';
  const rider = await openParticipant(browser, passenger, 'ride');
  const captain = await openParticipant(browser, driver, 'drive');
  try {
    await rider.page.getByRole('button', { name: 'Call driver for free' }).click();
    await expect(captain.page.locator('.call-overlay')).toContainText('Incoming audio call', { timeout: 15000 });
    await captain.page.getByRole('button', { name: 'Answer', exact: true }).click();
    await expectConnected(rider.page); await expectConnected(captain.page);
    expect(stats.droppedOffers).toBe(1); expect(stats.droppedAnswers).toBe(1);
    expect(stats.offers).toBeGreaterThan(1); expect(stats.answers).toBeGreaterThan(1);
    await captain.page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(rider.page.locator('.call-overlay')).toHaveCount(0);
    expect(rider.errors).toEqual([]); expect(captain.errors).toEqual([]);
  } finally { await rider.context.close(); await captain.context.close(); }
});

test('out-of-order ICE before the incoming offer is retained and the call still connects', async ({ browser }) => {
  mode = 'reorder';
  const rider = await openParticipant(browser, passenger, 'ride');
  const captain = await openParticipant(browser, driver, 'drive');
  try {
    await rider.page.getByRole('button', { name: 'Call driver for free' }).click();
    await expect(captain.page.locator('.call-overlay')).toContainText('Incoming audio call', { timeout: 15000 });
    await captain.page.getByRole('button', { name: 'Answer', exact: true }).click();
    await expectConnected(rider.page); await expectConnected(captain.page);
    expect(stats.ice).toBeGreaterThan(0);
    await rider.page.getByRole('button', { name: 'End call', exact: true }).click();
    await expect(captain.page.locator('.call-overlay')).toHaveCount(0);
    expect(rider.errors).toEqual([]); expect(captain.errors).toEqual([]);
  } finally { await rider.context.close(); await captain.context.close(); }
});
