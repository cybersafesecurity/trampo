import test from 'node:test';
import assert from 'node:assert/strict';
import { createMeteredRelay, hasRelay, meteredConfig, staleRelay, usableRelay, METERED_PROPAGATION_MS, METERED_TTL_SECONDS } from '../server/metered.js';

const servers = [{ urls: ['turn:global.relay.metered.ca:80?transport=tcp', 'turns:global.relay.metered.ca:443?transport=tcp'], username: 'temporary-user', credential: 'temporary-password' }];

test('Metered secret is server-only, credentials are fetched in two steps and never logged in errors', async () => {
  const config = meteredConfig({ METERED_APP: 'trampo.metered.live', METERED_SECRET_KEY: 'super-secret' });
  assert.deepEqual(config, { app: 'trampo.metered.live', secret: 'super-secret' });
  assert.throws(() => meteredConfig({ METERED_APP: 'trampo.metered.live' }), /METERED_SECRET_KEY/);
  assert.throws(() => meteredConfig({ METERED_APP: 'evil.example.com', METERED_SECRET_KEY: 'x' }), /METERED_APP/);
  const requests = [];
  const cache = await createMeteredRelay(config, async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET', body: init.body });
    if (requests.length === 1) return { ok: true, json: async () => ({ apiKey: 'credential-scoped-key', username: 'temporary-user', password: 'temporary-password' }) };
    return { ok: true, json: async () => servers };
  }, () => 1000);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].method, 'POST');
  assert.match(requests[0].url, /secretKey=super-secret/);
  assert.deepEqual(JSON.parse(requests[0].body), { expiryInSeconds: METERED_TTL_SECONDS, label: 'trampo-private-calls' });
  assert.match(requests[1].url, /apiKey=credential-scoped-key/);
  assert.deepEqual(cache.servers, servers);
  assert.equal(cache.expiresAt, 1000 + METERED_TTL_SECONDS * 1000);
  assert.equal(JSON.stringify(cache).includes('super-secret'), false);
  await assert.rejects(createMeteredRelay(config, async () => ({ ok: false, status: 401 })), /Could not issue/);
});

test('relay cache waits for propagation, expires before use and detects stale credentials', () => {
  const cache = { servers, createdAt: 1000, expiresAt: 1000 + METERED_TTL_SECONDS * 1000 };
  assert.equal(hasRelay(servers), true);
  assert.equal(hasRelay([{ urls: 'stun:stun.l.google.com:19302' }]), false);
  assert.equal(usableRelay(cache, 1000), false);
  assert.equal(usableRelay(cache, 1000 + METERED_PROPAGATION_MS), true);
  assert.equal(usableRelay(cache, cache.expiresAt - 60000), false);
  assert.equal(staleRelay(cache, cache.expiresAt + 1), true);
  assert.equal(staleRelay(null), true);
});
