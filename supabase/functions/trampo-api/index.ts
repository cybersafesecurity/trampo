import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { createMeteredRelay, hasRelay, meteredConfig, staleRelay, usableRelay, METERED_ROTATE_AFTER_MS } from '../../../server/metered.js';
import { createPhotonProxy } from '../../../server/photonProxy.js';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const allowed = (Deno.env.get('TRAMPO_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
const photonLookup = createPhotonProxy({ base: Deno.env.get('PHOTON_URL') || '' });
let relayCache: { servers: RTCIceServer[]; createdAt: number; expiresAt: number } | null = null;
let relayRefresh: Promise<typeof relayCache> | null = null;

function cors(origin: string | null) {
  const ok = origin && (allowed.includes(origin) || allowed.includes('*'));
  return { 'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}
function json(body: unknown, status: number, headers: Record<string,string>) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } }); }

async function readSharedRelay() {
  const { data, error } = await supabase.rpc('trampo_relay_cache', { p_action: 'get', p_id: 'metered-turn' });
  if (error || !data || typeof data !== 'object') return null;
  const cache = data as { servers?: unknown; createdAt?: unknown; expiresAt?: unknown };
  if (!Array.isArray(cache.servers) || typeof cache.createdAt !== 'number' || typeof cache.expiresAt !== 'number') return null;
  return { servers: cache.servers as RTCIceServer[], createdAt: cache.createdAt, expiresAt: cache.expiresAt };
}
async function refreshRelay(config: { app: string; secret: string }) {
  const cache = await createMeteredRelay(config);
  relayCache = cache;
  await supabase.rpc('trampo_relay_cache', { p_action: 'set', p_id: 'metered-turn', p_servers: cache.servers, p_created_at: cache.createdAt, p_expires_at: cache.expiresAt });
  return cache;
}
async function iceConfig() {
  const servers: RTCIceServer[] = [];
  const stun = Deno.env.get('STUN_URL');
  if (stun !== '') servers.push({ urls: stun || 'stun:stun.l.google.com:19302' });
  const turn = Deno.env.get('TURN_URLS');
  if (turn && Deno.env.get('TURN_USERNAME') && Deno.env.get('TURN_CREDENTIAL')) {
    const staticRelay = { urls: turn.split(',').map(s => s.trim()).filter(Boolean), username: Deno.env.get('TURN_USERNAME')!, credential: Deno.env.get('TURN_CREDENTIAL')! };
    if (hasRelay([staticRelay])) servers.push(staticRelay);
  }
  let config: { app: string; secret: string } | null = null;
  try { config = meteredConfig(Deno.env.toObject()); } catch { /* Misconfiguration must not expose the secret or break direct/STUN calling. */ }
  if (config) {
    const now = Date.now();
    if (!usableRelay(relayCache, now)) relayCache = await readSharedRelay();
    if (usableRelay(relayCache, now) && now - relayCache!.createdAt < METERED_ROTATE_AFTER_MS) return [...servers, ...relayCache!.servers];
    if (!relayRefresh) relayRefresh = refreshRelay(config).catch(() => null).finally(() => { relayRefresh = null; });
    if (usableRelay(relayCache, now)) { void relayRefresh; return [...servers, ...relayCache!.servers]; }
    if (staleRelay(relayCache, now)) await relayRefresh;
    if (usableRelay(relayCache)) return [...servers, ...relayCache!.servers];
    // A brand-new Metered credential can take ~2 minutes to propagate. Do not
    // hand it out as "working relay" before then; static fallback/STUN remains.
  }
  return servers;
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get('origin');
  const headers = cors(origin);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (origin && allowed.length && !allowed.includes(origin) && !allowed.includes('*')) return json({ error: 'Origin not allowed.' }, 403, headers);
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/trampo-api/, '') || '/';
    const method = req.method;
    let body: unknown = {};
    if (!['GET','HEAD'].includes(method)) {
      const text = await req.text();
      if (text.length > 32768) return json({ error: 'Request too large.' }, 413, headers);
      body = text ? JSON.parse(text) : {};
    }
    let uid: string | null = null;
    const auth = req.headers.get('authorization') || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const publicPath = path === '/health' || path === '/config' || path.startsWith('/shared/');
    if (token && !publicPath) {
      const { data, error } = await supabase.auth.getUser(token);
      if (error || !data.user) return json({ error: 'Please sign in to continue.' }, 401, headers);
      uid = data.user.id;
    } else if (!publicPath) return json({ error: 'Please sign in to continue.' }, 401, headers);

    if ((path === '/places/search' || path === '/places/reverse') && method === 'GET') {
      const { data: permitted, error: rateError } = await supabase.rpc('trampo_places_rate', { p_uid: uid });
      if (rateError) return json({ error: 'Address lookup is temporarily unavailable.' }, 503, headers);
      if (!permitted) return json({ error: 'Address search is busy. Please wait a moment and try again.' }, 429, headers);
      try { return json(await photonLookup(path.endsWith('/search') ? 'search' : 'reverse', url.searchParams), 200, headers); }
      catch (error) { return json({ error: (error as Error).message || 'Address lookup is temporarily unavailable.' }, (error as { status?: number }).status || 503, headers); }
    }

    const { data, error } = await supabase.rpc('trampo_dispatch', { p_uid: uid, p_method: method, p_path: path + url.search, p_body: body });
    if (error) return json({ error: 'Something went wrong. Please try again.' }, 500, headers);
    const result = data as { status: number; body: Record<string, unknown> };
    if (result.status < 400 && (path.endsWith('/call') || path.endsWith('/call/config'))) result.body = { ...result.body, iceServers: await iceConfig() };
    return json(result.body, result.status, headers);
  } catch {
    return json({ error: 'Invalid request.' }, 400, headers);
  }
});
