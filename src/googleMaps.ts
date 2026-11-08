import { importLibrary, setOptions } from '@googlemaps/js-api-loader';
import type { Place } from './types';

// This is a browser key, not a server secret. Restrict it by HTTP referrer and
// to Maps JavaScript API + Geocoding API in Google Cloud before publishing it.
export const googleMapsKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined)?.trim() || '';
export const googleMapsConfigured = Boolean(googleMapsKey);
let configured = false;
let loading: Promise<typeof google.maps> | null = null;

export function loadGoogleMaps(): Promise<typeof google.maps> {
  if (!googleMapsKey) return Promise.reject(new Error('Google Maps is not configured. GPS coordinates are still available.'));
  if (!loading) {
    if (!configured) {
      setOptions({ key: googleMapsKey, v: 'weekly', language: 'en', region: 'UG' });
      configured = true;
    }
    loading = Promise.race([
      Promise.all([importLibrary('maps'), importLibrary('geocoding')]).then(() => google.maps),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Google Maps took too long to load. Check the connection or try again.')), 15000)),
    ]).catch(error => { loading = null; throw error; });
  }
  return loading;
}

export const coordinateName = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;

/** Reverse-geocode the device fix without moving the pickup to a Google result. */
export async function resolveCurrentPlace(p: { lat: number; lng: number; accuracy: number }): Promise<Place & { provider: 'google' | 'coordinates' }> {
  const fallback: Place & { provider: 'coordinates' } = {
    lat: p.lat, lng: p.lng, name: 'My current location',
    area: `${coordinateName(p)} · ±${Math.round(p.accuracy)} m GPS`, provider: 'coordinates',
  };
  if (!googleMapsKey) return fallback;
  try {
    const maps = await loadGoogleMaps();
    const geocoder = new maps.Geocoder();
    const response = await Promise.race([
      geocoder.geocode({ location: { lat: p.lat, lng: p.lng } }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Address lookup timed out.')), 10000)),
    ]);
    const result = response.results.find(r => r.address_components.some(c => c.short_name === 'UG' && c.types.includes('country'))) || response.results[0];
    if (!result) return fallback;
    const component = (...types: string[]) => result.address_components.find(c => types.some(t => c.types.includes(t)))?.long_name;
    const local = component('route', 'neighborhood', 'sublocality', 'premise', 'point_of_interest');
    const city = component('locality', 'administrative_area_level_2', 'administrative_area_level_1');
    const name = [local, city].filter(Boolean).join(', ') || result.formatted_address.split(',').slice(0, 2).join(',').trim() || 'My current location';
    return { lat: p.lat, lng: p.lng, name: name.slice(0, 140), area: result.formatted_address.slice(0, 240) || fallback.area, provider: 'google' };
  } catch {
    // A geocoder outage must not discard a valid device fix or block booking.
    return fallback;
  }
}
