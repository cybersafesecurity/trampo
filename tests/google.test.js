import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBackend } from '../server/index.js';
import { createGoogleAuth } from '../server/google.js';
import { openStore } from '../server/store.js';

async function setup(t, enabled = true) {
  let claims = {}, exchanged = null;
  const backend = createBackend({ dbPath: ':memory:', demo: true, autoTick: false, google: enabled ? {
    clientId: 'test-client.apps.googleusercontent.com', clientSecret: 'test-secret', publicOrigin: 'http://localhost:3000', production: false,
    exchangeCode: async (code, context) => { exchanged = { code, context }; return 'signed-by-google-stub'; },
    verifyIdToken: async () => claims,
  } : { clientId: '', clientSecret: '' } });
  await new Promise(resolve => backend.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${backend.server.address().port}`;
  t.after(() => backend.close());
  function client() {
    const jar = new Map();
    async function request(method, path, body, expected = 200) {
      const response = await fetch(`${base}${path}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json', 'X-Trampo-Client': 'web', ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const cookie of response.headers.getSetCookie()) { const [pair] = cookie.split(';'); const at = pair.indexOf('='); const name = pair.slice(0, at), value = pair.slice(at + 1); if (!value || /Max-Age=0/i.test(cookie)) jar.delete(name); else jar.set(name, value); }
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      assert.ok(Array.isArray(expected) ? expected.includes(response.status) : response.status === expected, `${method} ${path}: expected ${expected}, got ${response.status}: ${JSON.stringify(data)}`);
      return { data, response };
    }
    return { request, jar };
  }
  function claimsFor(state, overrides = {}) {
    const flow = backend.db.prepare('SELECT * FROM oauth_flows WHERE state_hash=?').get(createHash('sha256').update(state).digest('hex'));
    assert.ok(flow);
    claims = { sub: 'google-subject-1', email: 'Person@Example.com', email_verified: true, name: 'Google Person', picture: 'https://lh3.googleusercontent.com/photo', nonce: flow.nonce, aud: 'test-client.apps.googleusercontent.com', iss: 'https://accounts.google.com', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...overrides };
    return flow;
  }
  return { backend, base, client, claimsFor, exchanged: () => exchanged };
}

test('Google OAuth creates a passenger, consumes state, and never elevates privileges', async t => {
  const { backend, base, client, claimsFor, exchanged } = await setup(t), guest = client();
  assert.equal((await guest.request('GET', '/api/config')).data.googleSignIn, true);
  const start = await guest.request('POST', '/api/auth/google/start', { intent: 'signin' });
  const authUrl = new URL(start.data.url); assert.equal(authUrl.hostname, 'accounts.google.com'); assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  const state = authUrl.searchParams.get('state'); claimsFor(state);
  const callback = await guest.request('GET', `/api/auth/google/callback?state=${state}&code=valid-code`, undefined, 302);
  assert.equal(callback.response.headers.get('location'), '/?google=created#profile');
  assert.equal(exchanged().context.verifier.length, 43);
  const profile = (await guest.request('GET', '/api/profile')).data.profile;
  assert.equal(profile.role, 'passenger'); assert.equal(profile.accountType, 'passenger'); assert.equal(profile.email, 'person@example.com'); assert.equal(profile.googleLinked, true); assert.equal(profile.phone, '');
  await guest.request('POST', '/api/trips', { pickup: { lat: .3354, lng: 32.5769 }, dropoff: { lat: .3117, lng: 32.575 }, service: 'boda', payment: 'cash' }, 409);
  await guest.request('PATCH', '/api/profile', { name: profile.name, phone: '0772123451', city: 'Kampala', bio: '' });
  assert.equal((await guest.request('GET', '/api/profile')).data.profile.phone, '+256772123451');
  const replay = await fetch(`${base}/api/auth/google/callback?state=${state}&code=valid-code`, { redirect: 'manual', headers: { Cookie: `trampo_oauth=${state}` } });
  assert.equal(replay.headers.get('location'), '/?google=failed#profile');
  assert.equal(backend.db.prepare('SELECT COUNT(*) n FROM users WHERE google_subject=?').get('google-subject-1').n, 1);

  // A different Google subject with the same email must not merge into the first account.
  const second = client();
  const url2 = new URL((await second.request('POST', '/api/auth/google/start', { intent: 'signin' })).data.url);
  claimsFor(url2.searchParams.get('state'), { sub: 'different-subject' });
  await second.request('GET', `/api/auth/google/callback?state=${url2.searchParams.get('state')}&code=code-2`, undefined, 302);
  const secondProfile = (await second.request('GET', '/api/profile')).data.profile;
  assert.notEqual(secondProfile.id, profile.id); assert.equal(secondProfile.role, 'passenger');
});

test('Google nonce/state checks fail closed and explicit linking preserves an existing role', async t => {
  const { base, client, claimsFor } = await setup(t), admin = client();
  await admin.request('POST', '/api/demo/session', { role: 'admin' });
  const start = await admin.request('POST', '/api/auth/google/start', { intent: 'link' });
  const state = new URL(start.data.url).searchParams.get('state'); claimsFor(state, { sub: 'admin-google-subject', email: 'admin@example.com' });
  const linked = await admin.request('GET', `/api/auth/google/callback?state=${state}&code=link-code`, undefined, 302);
  assert.equal(linked.response.headers.get('location'), '/?google=linked#profile');
  const profile = (await admin.request('GET', '/api/profile')).data.profile;
  assert.equal(profile.role, 'admin'); assert.equal(profile.googleLinked, true);

  const bad = client();
  const badUrl = new URL((await bad.request('POST', '/api/auth/google/start', { intent: 'signin' })).data.url);
  const badState = badUrl.searchParams.get('state'); claimsFor(badState, { nonce: 'wrong-nonce', sub: 'bad-subject' });
  const failed = await bad.request('GET', `/api/auth/google/callback?state=${badState}&code=bad`, undefined, 302);
  assert.equal(failed.response.headers.get('location'), '/?google=failed#profile');
  await bad.request('GET', '/api/bootstrap', undefined, 401);

  const mismatch = client();
  const mismatchUrl = new URL((await mismatch.request('POST', '/api/auth/google/start', { intent: 'signin' })).data.url);
  const mismatchState = mismatchUrl.searchParams.get('state'); claimsFor(mismatchState);
  await mismatch.request('GET', `/api/auth/google/callback?state=${'x'.repeat(43)}&code=bad`, undefined, 302);
  await mismatch.request('GET', '/api/bootstrap', undefined, 401);

  // Explicitly linking an already-owned Google subject to another account is rejected.
  const other = client(); await other.request('POST', '/api/demo/session', { role: 'passenger' });
  const conflictUrl = new URL((await other.request('POST', '/api/auth/google/start', { intent: 'link' })).data.url);
  const conflictState = conflictUrl.searchParams.get('state'); claimsFor(conflictState, { sub: 'admin-google-subject' });
  const conflict = await other.request('GET', `/api/auth/google/callback?state=${conflictState}&code=conflict`, undefined, 302);
  assert.equal(conflict.response.headers.get('location'), '/?google=failed#profile');
  assert.equal((await other.request('GET', '/api/profile')).data.profile.googleLinked, false);
});

test('unconfigured Google sign-in is disabled and production requires HTTPS', async t => {
  const { client } = await setup(t, false);
  assert.equal((await client().request('GET', '/api/config')).data.googleSignIn, false);
  await client().request('POST', '/api/auth/google/start', { intent: 'signin' }, 503);
  const db = openStore(':memory:', false);
  try {
    const insecure = createGoogleAuth(db, { google: { clientId: 'id', clientSecret: 'secret', publicOrigin: 'http://example.com', production: true } });
    const secure = createGoogleAuth(db, { google: { clientId: 'id', clientSecret: 'secret', publicOrigin: 'https://example.com', production: true } });
    assert.equal(insecure.enabled, false); assert.equal(secure.enabled, true);
  } finally { db.close(); }
});
