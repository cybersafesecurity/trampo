import type { Place, Position, Service } from './types';
import { isStaticDemo, staticApi } from './staticDemo';
export const asset = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`;
export const HEAD_OFFICE = 'Plot 14 Martyrs Drive, Ntinda Ministers Village';
export const DEFAULT_PICKUP: Place = { name: 'Acacia Mall, Kisementi', area: 'Kampala', lat: 0.3354, lng: 32.5769 };
export const PLACES: Place[] = [
  DEFAULT_PICKUP,
  { name: 'Garden City Shopping Mall', area: 'Kampala Central', lat: 0.3117, lng: 32.5750 },
  { name: 'Ntinda Ministers Village', area: 'Trampo head office · Plot 14 Martyrs Drive', lat: 0.3476, lng: 32.6155 },
  { name: 'Makerere University', area: 'Kawempe, Kampala', lat: 0.3349, lng: 32.5686 },
  { name: 'Kololo Airstrip', area: 'Kololo, Kampala', lat: 0.3264, lng: 32.5891 },
  { name: 'Kabalagala', area: 'Makindye, Kampala', lat: 0.2969, lng: 32.5894 },
  { name: 'Nakasero Market', area: 'Kampala Central', lat: 0.3136, lng: 32.5740 },
  { name: 'Bugolobi', area: 'Nakawa, Kampala', lat: 0.3130, lng: 32.6030 },
  { name: 'Entebbe International Airport', area: 'Entebbe · Airport transfer', lat: 0.0445, lng: 32.4435 },
  { name: 'Entebbe Town Centre', area: 'Entebbe', lat: 0.0510, lng: 32.4637 },
  { name: 'Jinja City Centre', area: 'Jinja · Eastern Region', lat: 0.4479, lng: 33.2026 },
  { name: 'Mbarara City Centre', area: 'Mbarara · Western Region', lat: -0.6072, lng: 30.6545 },
  { name: 'Gulu City Centre', area: 'Gulu · Northern Region', lat: 2.7746, lng: 32.2990 },
  { name: 'Mbale City Centre', area: 'Mbale · Eastern Region', lat: 1.0752, lng: 34.1758 },
  { name: 'Fort Portal City', area: 'Fort Portal · Western Region', lat: 0.6611, lng: 30.2748 },
  { name: 'Arua City Centre', area: 'Arua · West Nile', lat: 3.0201, lng: 30.9110 },
  { name: 'Masaka City Centre', area: 'Masaka · Central Region', lat: -0.3338, lng: 31.7341 },
  { name: 'Lira City Centre', area: 'Lira · Northern Region', lat: 2.2499, lng: 32.8999 },
  { name: 'Hoima City Centre', area: 'Hoima · Western Region', lat: 1.4356, lng: 31.3436 },
];
export const SERVICE_INFO = {
  boda: { name: 'Trampo Boda', short: 'Boda', description: 'Beat the traffic. Get there faster.', eta: '2–4 min', seats: 1, tag: 'EVERYDAY ESSENTIAL' },
  comfort: { name: 'Trampo Comfort', short: 'Comfort', description: 'A cool, comfortable everyday ride.', eta: '3–6 min', seats: 4, tag: 'A LITTLE MORE COMFORT' },
  vip: { name: 'Trampo VIP', short: 'VIP', description: 'Premium cars. A first-class journey.', eta: '5–8 min', seats: 4, tag: 'THE TRAMPO VIP EXPERIENCE' },
} satisfies Record<Service, unknown>;
export const money = (value: number) => new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(value);
export const dateTime = (value: number) => new Intl.DateTimeFormat('en-UG', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' }).format(value);
export function distance(a: Position, b: Position) {
  const r = Math.PI / 180, dl = (b.lat - a.lat) * r, dn = (b.lng - a.lng) * r;
  return 6371000 * 2 * Math.atan2(Math.sqrt(Math.sin(dl / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2), Math.sqrt(1 - Math.sin(dl / 2) ** 2 - Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dn / 2) ** 2));
}
export function estimate(pickup: Position, dropoff: Position, service: Service) {
  const rates = { boda: [2000, 900, 60, 3500], comfort: [4000, 1600, 120, 7000], vip: [15000, 2800, 250, 25000] }[service];
  const km = Math.round(distance(pickup, dropoff) / 1000 * 1.25 * 10) / 10;
  const minutes = Math.ceil(km / 22 * 60 + 5);
  return { distanceKm: km, minutes, fare: Math.max(rates[3], Math.ceil((rates[0] + km * rates[1] + minutes * rates[2]) / 500) * 500), currency: 'UGX', estimate: true };
}
export class ApiError extends Error { constructor(message: string, public code?: string, public details?: unknown) { super(message); } }
export async function api<T = any>(path: string, body?: unknown, method?: string): Promise<T> {
  if (isStaticDemo) return staticApi<T>(path, body, method);
  const response = await fetch(`/api${path}`, { method: method || (body !== undefined ? 'POST' : 'GET'), credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Trampo-Client': 'web' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(data.error || 'Unable to connect to Trampo.', data.code, data.details);
  return data;
}
export const statusLabel = (status: string) => ({ searching: 'Finding your driver', assigned: 'Driver on the way', in_progress: 'On the move', completed: 'Completed', cancelled: 'Cancelled', scheduled: 'Scheduled' }[status] || status);
