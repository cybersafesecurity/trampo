/** Metered secret stays on the server. Cached credentials are issued well before
 * use: Metered documents up to two minutes of propagation. Expiry invalidates
 * allocations even mid-call, so credentials cover a deliberately long trip. */
export const METERED_TTL_SECONDS = 4 * 60 * 60;
export const METERED_PROPAGATION_MS = 130000;
export const METERED_ROTATE_AFTER_MS = 2 * 60 * 60 * 1000;
export const METERED_STALE_MS = 3 * 60 * 60 * 1000 + 45 * 60 * 1000;

export function meteredConfig(env) {
  const app = (env.METERED_APP || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const secret = (env.METERED_SECRET_KEY || '').trim();
  if (!app && !secret) return null;
  if (!secret || !/^[a-z0-9][a-z0-9-]{0,62}\.metered\.live$/.test(app)) throw new Error('Configure both a valid METERED_APP hostname and METERED_SECRET_KEY on the server.');
  return { app, secret };
}

export function hasRelay(servers) {
  return Array.isArray(servers) && servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => /^turns?:/i.test(url)) && !!server.username && !!server.credential);
}

export function usableRelay(cache, now = Date.now()) {
  return !!cache && hasRelay(cache.servers) && now - cache.createdAt >= METERED_PROPAGATION_MS && cache.expiresAt - now > 15 * 60 * 1000;
}
export function staleRelay(cache, now = Date.now()) { return !cache || now - cache.createdAt >= METERED_STALE_MS || cache.expiresAt <= now; }
function validateServers(value) {
  if (!Array.isArray(value) || value.length > 32) throw new Error('Invalid Metered ICE response.');
  const servers = value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid Metered ICE server.');
    const urls = Array.isArray(item.urls) ? item.urls : [item.urls];
    if (!urls.length || urls.length > 16 || !urls.every((url) => typeof url === 'string' && /^(stun|turn|turns):[a-z0-9.\-]+(?::\d+)?(?:\?transport=(udp|tcp))?$/i.test(url))) throw new Error('Invalid Metered relay URL.');
    const server = { urls };
    if (typeof item.username === 'string') server.username = item.username.slice(0, 300);
    if (typeof item.credential === 'string') server.credential = item.credential.slice(0, 500);
    return server;
  });
  if (!hasRelay(servers)) throw new Error('Metered returned no authenticated TURN relay.');
  return servers;
}

export async function createMeteredRelay(config, fetcher = fetch, now = Date.now()) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}\.metered\.live$/.test(config.app) || !config.secret) throw new Error('Metered is not configured.');
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
  const response = await fetcher(`https://${config.app}/api/v1/turn/credential?secretKey=${encodeURIComponent(config.secret)}`, {
    method: 'POST', headers, body: JSON.stringify({ expiryInSeconds: METERED_TTL_SECONDS, label: 'trampo-private-calls' }),
    signal: AbortSignal.timeout(8000), credentials: 'omit',
  });
  if (!response.ok) throw new Error('Could not issue a Metered relay credential.');
  const credential = await response.json();
  if (typeof credential.apiKey !== 'string' || !credential.apiKey) throw new Error('Metered did not return a credential API key.');
  const ice = await fetcher(`https://${config.app}/api/v1/turn/credentials?apiKey=${encodeURIComponent(credential.apiKey)}`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000), credentials: 'omit' });
  if (!ice.ok) throw new Error('Could not fetch Metered relay addresses.');
  const servers = validateServers(await ice.json());
  const createdAt = now();
  return { servers, createdAt, expiresAt: createdAt + METERED_TTL_SECONDS * 1000 };
}