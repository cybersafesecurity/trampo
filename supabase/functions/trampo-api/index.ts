import { createClient } from 'npm:@supabase/supabase-js@2.119.0';

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
const allowed = (Deno.env.get('TRAMPO_ALLOWED_ORIGINS') || '').split(',').map(s => s.trim()).filter(Boolean);
function cors(origin: string | null) {
  const ok = origin && (allowed.includes(origin) || allowed.includes('*'));
  return { 'Access-Control-Allow-Origin': ok ? origin : allowed[0] || 'null', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'Vary': 'Origin', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
}
function json(body: unknown, status: number, headers: Record<string,string>) { return new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } }); }
function iceConfig() {
  const servers: RTCIceServer[] = [];
  const stun = Deno.env.get('STUN_URL');
  if (stun !== '') servers.push({ urls: stun || 'stun:stun.l.google.com:19302' });
  const turn = Deno.env.get('TURN_URLS');
  if (turn) servers.push({ urls: turn.split(','), username: Deno.env.get('TURN_USERNAME'), credential: Deno.env.get('TURN_CREDENTIAL') });
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
    const { data, error } = await supabase.rpc('trampo_dispatch', { p_uid: uid, p_method: method, p_path: path + url.search, p_body: body });
    if (error) return json({ error: 'Something went wrong. Please try again.' }, 500, headers);
    const result = data as { status: number; body: Record<string, unknown> };
    if (path.endsWith('/call') || path.endsWith('/call/config')) result.body = { ...result.body, iceServers: iceConfig() };
    return json(result.body, result.status, headers);
  } catch {
    return json({ error: 'Invalid request.' }, 400, headers);
  }
});
