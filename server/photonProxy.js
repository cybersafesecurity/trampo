// Shared by the Node demo and Supabase Edge Function. Never forward account or
// trip identifiers. Public Photon is a fair-use fallback, not an SLA-backed API.
export const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';
export function validatePhotonBase(value = '') {
  const url = new URL(value || DEFAULT_PHOTON_URL);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-z0-9.-]+$/i.test(url.hostname)) throw new Error('Address lookup is not configured correctly.');
  return url.origin + url.pathname.replace(/\/$/, '');
}
export function photonRequest(base, kind, query) {
  const coordinateQuery = kind === 'reverse' ? query.has('lat') || query.has('latitude') : query.has('lat') && (query.has('lon') || query.has('lng') || query.has('longitude'));
  const q = String(query.get('q') || '').trim().slice(0, 180);
  const lat = Number(query.get('lat') ?? query.get('latitude'));
  const lon = Number(query.get('lon') ?? query.get('lng') ?? query.get('longitude'));
  if (coordinateQuery && (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -1.49 || lat > 4.24 || lon < 29.55 || lon > 35.01)) throw new Error('Address lookup requires a location inside Uganda.');
  if (kind === 'search' && q.length < 3) throw new Error('Enter at least three characters to search.');
  const url = new URL(`${validatePhotonBase(base)}/${kind === 'search' ? 'api/' : 'reverse'}`);
  url.searchParams.set('lang', 'en'); url.searchParams.set('limit', '6');
  if (coordinateQuery) { url.searchParams.set('lat', String(lat)); url.searchParams.set('lon', String(lon)); }
  if (kind === 'search') {
    url.searchParams.set('q', q); url.searchParams.set('countrycode', 'UG');
    url.searchParams.set('zoom', '12'); url.searchParams.set('location_bias_scale', '0.2');
  } else url.searchParams.set('radius', '0.2');
  return { url: url.href, key: `${kind}:${url.searchParams.toString().replace(/&lat=[^&]+&lon=[^&]+/, '').replace(/&lon=[^&]+/, '')}:${lat.toFixed(4)}:${lon.toFixed(4)}` };
}

/** A small TTL cache plus a global concurrency limit prevents a typing storm. */
export function createPhotonProxy({ base = '', fetcher = fetch, now = () => Date.now(), maxEntries = 500 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let active = 0;
  return async function lookup(kind, query) {
    if (kind !== 'search' && kind !== 'reverse') throw new Error('Unknown address lookup.');
    const request = photonRequest(base, kind, query);
    const time = now();
    for (const [key, entry] of cache) if (entry.expires <= time) cache.delete(key);
    const hit = cache.get(request.key);
    if (hit && hit.expires > time) return hit.data;
    if (pending.has(request.key)) return pending.get(request.key);
    if (active >= 8) { const error = new Error('Address search is busy. Please try again in a moment.'); error.status = 429; throw error; }
    active++;
    const task = (async () => {
      try {
      const response = await fetcher(request.url, { signal: AbortSignal.timeout(9000), headers: { Accept: 'application/json', 'User-Agent': 'Trampo/1.0 (Uganda address lookup)' }, redirect: 'error' });
      if (!response.ok) { const error = new Error(response.status === 429 ? 'Address search is busy. Try again in a moment.' : 'Address lookup is temporarily unavailable.'); error.status = 503; throw error; }
      const data = await response.json();
      if (!data || !Array.isArray(data.features)) throw new Error('The address provider returned an invalid response.');
      data.features = data.features.slice(0, 6);
      cache.delete(request.key);
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
      cache.set(request.key, { data, expires: time + (kind === 'reverse' ? 30 * 60000 : 5 * 60000) });
      return data;
      } finally { active--; pending.delete(request.key); }
    })();
    pending.set(request.key, task);
    return task;
  };
}