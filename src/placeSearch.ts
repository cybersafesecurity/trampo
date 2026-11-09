import type { Place, Position } from './types';

export type PlaceProvider = 'saved' | 'google' | 'openstreetmap' | 'coordinates';
export type LocatedPlace = Place & { provider: PlaceProvider; approximate?: boolean };
/** A Google prediction has no coordinates until the user selects it. Keeping it
 * lazy avoids fetching (and billing) Place Details for every typed character. */
export type GooglePlaceSuggestion = { provider: 'google'; name: string; area: string; approximate: true; prediction: google.maps.places.PlacePrediction };
export type PlaceCandidate = LocatedPlace | GooglePlaceSuggestion;
export const isGoogleSuggestion = (p: PlaceCandidate): p is GooglePlaceSuggestion => 'prediction' in p;
export const PROVIDER_LABELS: Record<PlaceProvider, string> = {
  saved: 'Saved place', google: 'Google Maps', openstreetmap: 'OpenStreetMap', coordinates: 'GPS coordinates',
};
export const OSM_ATTRIBUTION = '© OpenStreetMap contributors';

/** Only accept real, finite Uganda coordinates; a provider must never move a GPS fix. */
export function inUganda(p: Position) {
  return Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= -1.49 && p.lat <= 4.24 && p.lng >= 29.55 && p.lng <= 35.01;
}
export const coordinateLabel = (p: Position) => `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, max) : '';
const unique = (values: string[]) => [...new Set(values.filter(Boolean))];

export function googleResult(result: google.maps.GeocoderResult, fixedPosition?: Position, preferredName = ''): LocatedPlace | null {
  const lat = fixedPosition?.lat ?? result.geometry?.location?.lat();
  const lng = fixedPosition?.lng ?? result.geometry?.location?.lng();
  if (lat === undefined || lng === undefined || !inUganda({ lat, lng })) return null;
  if (!fixedPosition && result.partial_match) return null;
  const component = (...types: string[]) => result.address_components?.find(c => types.some(t => c.types.includes(t)))?.long_name || '';
  const country = result.address_components?.find(c => c.types.includes('country'));
  if (country && country.short_name !== 'UG') return null;
  const business = component('establishment', 'point_of_interest', 'premise');
  const local = component('route', 'neighborhood', 'sublocality') || business;
  const city = component('locality', 'administrative_area_level_2', 'administrative_area_level_1');
  const formatted = clean(result.formatted_address, 240);
  const name = unique([clean(preferredName, 140), clean(business || local, 100), clean(city, 38)]).join(', ').slice(0, 140)
    || formatted.split(',').slice(0, 2).join(',').trim() || 'Selected location';
  return { lat, lng, name, area: formatted || coordinateLabel({ lat, lng }), provider: 'google', approximate: !fixedPosition && result.geometry?.location_type !== 'ROOFTOP' };
}

type PhotonFeature = { geometry?: { coordinates?: unknown }; properties?: Record<string, unknown> };
export function photonResult(feature: PhotonFeature, fixedPosition?: Position, preserveQuery = false): LocatedPlace | null {
  const coordinates = feature.geometry?.coordinates;
  const p = feature.properties || {};
  const lat = fixedPosition?.lat ?? (Array.isArray(coordinates) ? Number(coordinates[1]) : NaN);
  const lng = fixedPosition?.lng ?? (Array.isArray(coordinates) ? Number(coordinates[0]) : NaN);
  if (!inUganda({ lat, lng }) || (p.countrycode && p.countrycode !== 'UG')) return null;
  const business = clean(p.name, 100);
  const street = unique([clean(p.housenumber, 15), clean(p.street, 80)]).join(' ');
  const locality = clean(p.district || p.suburb || p.city || p.county || p.state, 60);
  const city = clean(p.city || p.county || p.state, 38);
  // Do not overwrite a passenger's business name with a nearby street. The full
  // address remains visible so they can reject an approximate search result.
  const name = (preserveQuery && business ? unique([business, city]) : unique([business || street, city])).join(', ').slice(0, 140)
    || clean(p.osm_value, 60) || 'Selected location';
  const area = unique([street, clean(p.suburb || p.district, 60), locality, clean(p.state, 50), 'Uganda']).join(', ').slice(0, 240)
    || coordinateLabel({ lat, lng });
  return { lat, lng, name, area, provider: 'openstreetmap', approximate: !fixedPosition && Boolean(business && street && business !== street) };
}

export function parsePhoton(data: unknown, preserveQuery = false): LocatedPlace[] {
  const features = data && typeof data === 'object' && 'features' in data && Array.isArray(data.features) ? data.features : [];
  const places = features.slice(0, 12).map((f: PhotonFeature) => photonResult(f, undefined, preserveQuery)).filter((p: LocatedPlace | null): p is LocatedPlace => !!p);
  return places.filter((p, i) => places.findIndex(other => other.name === p.name && Math.abs(other.lat - p.lat) < .00001 && Math.abs(other.lng - p.lng) < .00001) === i).slice(0, 6);
}

export function mergePlaces(saved: Place[], found: PlaceCandidate[]): PlaceCandidate[] {
  const all: PlaceCandidate[] = [...saved.map(p => ({ ...p, provider: 'saved' as const })), ...found];
  return all.filter((p, i) => all.findIndex(other => other.name.toLowerCase() === p.name.toLowerCase()
    || (!isGoogleSuggestion(p) && !isGoogleSuggestion(other) && Math.abs(other.lat - p.lat) < .00005 && Math.abs(other.lng - p.lng) < .00005)) === i);
}