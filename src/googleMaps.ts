import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import { api } from './lib';
import { isStaticDemo } from './staticDemo';
import { coordinateLabel, googleResult, inUganda, parsePhoton, photonResult, type GooglePlaceSuggestion, type LocatedPlace, type PlaceCandidate } from './placeSearch';

// A referrer-restricted browser key, never a server secret. Enable Maps JavaScript
// and Geocoding (or Places when using autocomplete predictions).
export const googleMapsKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() || '';
export const googleMapsConfigured = Boolean(googleMapsKey);
const photonBase = (import.meta.env.VITE_PHOTON_URL as string | undefined)?.trim() || '';
let configured = false;
let loading: Promise<typeof google.maps> | null = null;
const loadedLibraries = new Set<'maps' | 'geocoding' | 'places'>();
let autocompleteSession: google.maps.places.AutocompleteSessionToken | null = null;
/** End the billing session when the picker closes or a place is selected. */
export function resetPlaceSearchSession() { autocompleteSession = null; }

async function deadline<T>(promise: Promise<T>, ms = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Address lookup timed out.')), ms); })]); }
  finally { clearTimeout(timer!); }
}

export function loadGoogleMaps(libraries: ('geocoding' | 'places')[] = ['geocoding']): Promise<typeof google.maps> {
  if (!googleMapsKey) return Promise.reject(new Error('Google Maps is not configured. OpenStreetMap address search is available.'));
  if (!configured) { setOptions({ key: googleMapsKey, v: 'weekly', language: 'en', region: 'UG' }); configured = true; }
  const needed = (['maps', ...libraries] as const).filter(library => !loadedLibraries.has(library));
  if (needed.length) {
    // A GPS reverse-geocode may load geocoding first; a later typed search must
    // still import places instead of reusing a geocoding-only loader promise.
    loading = Promise.resolve(loading)
      .then(() => deadline(Promise.all(needed.map(library => importLibrary(library))), 15000))
      .then(() => { needed.forEach(library => loadedLibraries.add(library)); return google.maps; })
      .catch(error => { loading = null; throw error; });
  }
  return loading || Promise.resolve(google.maps);
}
export const coordinateName = coordinateLabel;

export function photonEndpoint(configured: string, kind: 'search' | 'reverse', params: Record<string, string>) {
  const url = new URL(configured || 'https://photon.komoot.io');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('The address service must use a clean HTTPS endpoint.');
  url.pathname = `${url.pathname.replace(/\/$/, '')}/${kind === 'search' ? 'api/' : 'reverse'}`;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  url.searchParams.set('lang', 'en'); url.searchParams.set('limit', '6');
  if (kind === 'search') url.searchParams.set('countrycode', 'UG');
  return url;
}

async function photon(params: Record<string, string>, kind: 'search' | 'reverse', signal?: AbortSignal) {
  // The hosted Node backend proxies/caches the optional provider. The static
  // Supabase frontend uses a bounded, user-triggered request instead. No search
  // engine credentials or account/trip identifiers are sent to the provider.
  const query = new URLSearchParams(params).toString();
  if (!isStaticDemo && import.meta.env.VITE_TRAMPO_BACKEND === 'supabase') return api(`/places/${kind}?${query}`, undefined, 'GET', signal);
  const timeout = AbortSignal.timeout(10000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const url = isStaticDemo ? photonEndpoint(photonBase, kind, params).href : `/api/places/${kind}?${query}`;
  const response = await fetch(url, { signal: combined, headers: { Accept: 'application/json' }, credentials: 'omit' });
  if (!response.ok) throw new Error('Address search is temporarily unavailable. Try again or enter coordinates.');
  return response.json();
}

/** Reverse-geocode labels only. Exact device coordinates always win. */
export async function resolveCurrentPlace(p: { lat: number; lng: number; accuracy: number }): Promise<LocatedPlace> {
  const fallback: LocatedPlace = { lat: p.lat, lng: p.lng, name: 'My current location', area: `${coordinateName(p)} · ±${Math.round(p.accuracy)} m GPS`, provider: 'coordinates' };
  if (!inUganda(p)) return fallback;
  if (googleMapsKey) {
    try {
      const maps = await loadGoogleMaps();
      const response = await deadline(new maps.Geocoder().geocode({ location: { lat: p.lat, lng: p.lng } }));
      const result = response.results.find(r => r.address_components.some(c => c.short_name === 'UG' && c.types.includes('country')));
      const resolved = result && googleResult(result, p);
      if (resolved) return resolved;
    } catch { /* A provider outage must not discard a valid GPS fix. */ }
  }
  try {
    const response = await photon({ lat: String(p.lat), lon: String(p.lng), radius: '0.2' }, 'reverse');
    const feature = response.features?.[0];
    const resolved = feature && photonResult(feature, p);
    if (resolved) return resolved;
  } catch { /* Keep exact coordinates if both providers are unavailable. */ }
  return fallback;
}

/** Look up a typed destination. Return reviewable candidates, never silently book the first hit. */
export async function searchPlaces(query: string, signal?: AbortSignal, near?: { lat: number; lng: number }): Promise<PlaceCandidate[]> {
  const q = query.trim().slice(0, 180);
  if (q.length < 3 || signal?.aborted) return [];
  if (googleMapsKey) {
    try {
      const maps = await loadGoogleMaps(['places']);
      if (signal?.aborted) return [];
      if (maps.places?.AutocompleteSuggestion) {
        const center = near && inUganda(near) ? near : { lat: .3136, lng: 32.5825 };
        // Reuse one token across the debounce queries in this typing session;
        // selecting a prediction fetches Details once and ends the session.
        autocompleteSession ||= new maps.places.AutocompleteSessionToken();
        const { suggestions } = await deadline(maps.places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q, includedRegionCodes: ['ug'], language: 'en', region: 'ug',
          locationBias: { center, radius: 50000 }, sessionToken: autocompleteSession,
        }));
        if (signal?.aborted) return [];
        const places: GooglePlaceSuggestion[] = suggestions.map(s => s.placePrediction).filter((p): p is google.maps.places.PlacePrediction => !!p).slice(0, 6)
          .map(prediction => ({ provider: 'google', approximate: true, name: (prediction.mainText?.text || prediction.text?.text || 'Selected place').slice(0, 140), area: (prediction.secondaryText?.text || 'Google Maps address').slice(0, 240), prediction }));
        if (places.length) return places;
      } else {
        const response = await deadline(new maps.Geocoder().geocode({ address: q, componentRestrictions: { country: 'UG' }, region: 'UG' }));
        const places = response.results.map(r => googleResult(r)).filter((p): p is LocatedPlace => !!p).slice(0, 6);
        if (places.length) return places;
      }
    } catch (error) {
      if (signal?.aborted) return [];
      // Fall through to the independent OSM provider, including when a browser
      // key is restricted or an API has not been enabled in Google Cloud.
      void error;
      autocompleteSession = null;
    }
  }
  const params: Record<string, string> = { q, lat: String(near && inUganda(near) ? near.lat : .3136), lon: String(near && inUganda(near) ? near.lng : 32.5825), zoom: '12', location_bias_scale: '0.2' };
  const data = await photon(params, 'search', signal);
  if (signal?.aborted) return [];
  return parsePhoton(data, true);
}

/** Resolve only the prediction the passenger actually chose. */
export async function resolveGoogleSuggestion(suggestion: GooglePlaceSuggestion, signal?: AbortSignal): Promise<LocatedPlace | null> {
  try {
    const place = suggestion.prediction.toPlace();
    await deadline(place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location', 'addressComponents'] }));
    if (signal?.aborted || !place.location) return null;
    return googleResult({
      geometry: { location: place.location, location_type: 'ROOFTOP' }, formatted_address: place.formattedAddress || '',
      address_components: place.addressComponents?.map(c => ({ long_name: c.longText || '', short_name: c.shortText || '', types: c.types })) || [],
      partial_match: false,
    } as google.maps.GeocoderResult, undefined, typeof place.displayName === 'string' ? place.displayName : suggestion.name);
  } catch { return null; }
  finally { autocompleteSession = null; }
}

export async function resolveCoordinates(p: { lat: number; lng: number }, preferredName = ''): Promise<LocatedPlace> {
  const fallback: LocatedPlace = { ...p, name: preferredName.trim().slice(0, 140) || 'Pinned location', area: coordinateName(p), provider: 'coordinates' };
  if (!inUganda(p)) return fallback;
  const resolved = await resolveCurrentPlace({ ...p, accuracy: 0 });
  if (resolved.provider === 'coordinates') return fallback;
  return { ...resolved, name: preferredName.trim().slice(0, 140) || resolved.name };
}