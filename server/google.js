import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const hash = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const secureUrl = value => {
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; }
  catch { return ''; }
};

/** Google OpenID Connect authorization-code flow. Secrets stay on the server. */
export function createGoogleAuth(db, options = {}) {
  const config = options.google || {};
  const clientId = config.clientId ?? process.env.GOOGLE_CLIENT_ID ?? '';
  const clientSecret = config.clientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
  const production = (config.production ?? process.env.NODE_ENV === 'production');
  const publicOrigin = config.publicOrigin ?? process.env.PUBLIC_ORIGIN ?? `http://localhost:${process.env.PORT || 3000}`;
  let redirectUri = config.redirectUri ?? process.env.GOOGLE_REDIRECT_URI ?? '';
  if (!redirectUri) {
    try { redirectUri = new URL('/api/auth/google/callback', new URL(publicOrigin).origin).href; }
    catch { redirectUri = ''; }
  }
  let redirectOK = false;
  try { const url = new URL(redirectUri); redirectOK = ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.hash && (!production || url.protocol === 'https:'); } catch {}
  const enabled = !!(clientId && clientSecret && redirectOK);
  const jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { cooldownDuration: 30000 });
  const exchangeCode = config.exchangeCode || (async (code, { verifier } = {}) => {
    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
      body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    if (!response.ok) throw new Error('Google token exchange failed.');
    const body = await response.json();
    if (typeof body.id_token !== 'string') throw new Error('Google did not return an identity token.');
    return body.id_token;
  });
  const verifyIdToken = config.verifyIdToken || (async idToken => {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'], audience: clientId,
      algorithms: ['RS256'], requiredClaims: ['sub', 'iss', 'aud', 'exp', 'iat'], maxTokenAge: '10m', clockTolerance: 5,
    });
    return payload;
  });
  function start({ intent = 'signin', userId = null } = {}) {
    if (!enabled) throw new Error('Google sign-in is not configured on this server.');
    if (!['signin', 'link'].includes(intent) || (intent === 'link' && !userId)) throw new Error('Invalid Google sign-in request.');
    const state = token(), nonce = token(), verifier = token();
    db.prepare('DELETE FROM oauth_flows WHERE expires_at<?').run(Date.now());
    db.prepare('INSERT INTO oauth_flows(state_hash,nonce,verifier,intent,user_id,expires_at) VALUES(?,?,?,?,?,?)')
      .run(hash(state), nonce, verifier, intent, userId, Date.now() + 600000);
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, nonce,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
    return { url: url.href, state, maxAge: 600000 };
  }
  async function finish({ state, cookieState, code }) {
    if (!enabled) throw new Error('Google sign-in is not configured on this server.');
    if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || state !== cookieState || typeof code !== 'string' || !code || code.length > 4096) throw new Error('Google sign-in expired or could not be verified. Start again.');
    // Atomic consumption prevents authorization-code/state replay.
    const flow = db.prepare('DELETE FROM oauth_flows WHERE state_hash=? AND expires_at>? RETURNING *').get(hash(state), Date.now());
    if (!flow) throw new Error('Google sign-in expired or was already used. Start again.');
    const idToken = await exchangeCode(code, { redirectUri, verifier: flow.verifier });
    const claims = await verifyIdToken(idToken);
    if (claims.nonce !== flow.nonce || typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true || typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email) || claims.email.length > 254) throw new Error('Google returned an invalid or unverified identity.');
    if (Array.isArray(claims.aud) && claims.azp !== clientId) throw new Error('Google identity audience could not be verified.');
    return { intent: flow.intent, userId: flow.user_id, identity: {
      subject: claims.sub, email: claims.email.toLowerCase(),
      name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 80) : claims.email.split('@')[0].slice(0, 80),
      avatarUrl: typeof claims.picture === 'string' ? secureUrl(claims.picture).slice(0, 2048) : '',
    } };
  }
  return { enabled, start, finish };
}
