export const UGANDA_BOUNDS = { south: -1.55, north: 4.6, west: 29.4, east: 35.1 };
export const GPS_MAX_AGE_MS = 15_000;
export const GPS_MAX_ACCURACY = 50;
export const DISPATCH_MAX_AGE_MS = 30_000;
export const SHIFT_MAX_AGE_MS = 12 * 3_600_000;
// Pickup distance is informational only. Dispatch has no maximum radius either.
export const OFFICE = 'Plot 14 Martyrs Drive, Ntinda Ministers Village, Kampala, Uganda';
export const SERVICES = {
  boda: { name: 'Trampo Boda', base: 2000, perKm: 900, perMinute: 60, capacity: 1, minimum: 3500 },
  comfort: { name: 'Trampo Comfort', base: 4000, perKm: 1600, perMinute: 120, capacity: 4, minimum: 7000 },
  vip: { name: 'Trampo VIP', base: 15000, perKm: 2800, perMinute: 250, capacity: 4, minimum: 25000 },
};
export function distanceMeters(a, b) {
  if (!a || !b) return Infinity;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}
export function inUganda(p) {
  return p && Number.isFinite(p.lat) && Number.isFinite(p.lng) && p.lat >= UGANDA_BOUNDS.south && p.lat <= UGANDA_BOUNDS.north && p.lng >= UGANDA_BOUNDS.west && p.lng <= UGANDA_BOUNDS.east;
}
export function isNight(date = new Date(), preview = false) {
  if (preview) return true;
  const hour = (date.getUTCHours() + 3) % 24;
  return hour >= 19 || hour < 6;
}
export function quote(pickup, dropoff, service = 'boda') {
  const rate = SERVICES[service];
  if (!rate || !inUganda(pickup) || !inUganda(dropoff)) throw new Error('Choose valid pickup and destination locations in Uganda.');
  const straightLine = distanceMeters(pickup, dropoff) / 1000;
  if (straightLine < 0.15) throw new Error('Your destination needs to be at least 150 m from pickup.');
  // Preview only: a straight-line estimate, not a road-routing or live traffic quote.
  const km = Math.round(straightLine * 1.25 * 10) / 10;
  const minutes = Math.ceil(km / 22 * 60 + 5);
  const fare = Math.max(rate.minimum, Math.ceil((rate.base + km * rate.perKm + minutes * rate.perMinute) / 500) * 500);
  return { distanceKm: km, minutes, fare, currency: 'UGX', estimate: true };
}
// Testing mode: boarding no longer waits for GPS freshness, accuracy or proximity.
// The PIN, passenger confirmation, shift checklist and Night Shield acknowledgement
// still run server-side. Dispatch eligibility keeps its own availability GPS checks.
export function gpsMatch(riderFix, driverFix, _now = Date.now(), _night = false) {
  const distance = distanceMeters(riderFix, driverFix);
  return { matched: true, distance: Number.isFinite(distance) ? Math.round(distance) : null, threshold: null, reasons: [], maxAccuracy: null, maxAgeSeconds: null, testingBypass: true };
}
/**
 * Dispatch ranking. Availability is an eligibility gate; among available
 * drivers the closest wins. There is deliberately no maximum radius.
 * Caller supplies `busy` from the transactional active-trip check.
 */
export function dispatchCandidates(drivers, pickup, now = Date.now()) {
  return drivers.map(d => {
    const f = d.location;
    const available = d.status === 'approved' && !!d.online && d.account_status !== 'suspended' && !d.busy
      && Number.isFinite(d.shift_check_at) && now - d.shift_check_at < SHIFT_MAX_AGE_MS && d.shift_check_at <= now + 5000
      && f && inUganda(f) && Number.isFinite(f.updatedAt) && now - f.updatedAt <= DISPATCH_MAX_AGE_MS && f.updatedAt <= now + 5000
      && Number.isFinite(f.accuracy) && f.accuracy >= 0 && f.accuracy <= GPS_MAX_ACCURACY;
    if (!available || d.vehicle_type !== pickup.service) return null;
    const distance = distanceMeters(f, pickup);
    return Number.isFinite(distance) ? { ...d, dispatchDistance: distance } : null;
  }).filter(Boolean).sort((a, b) => a.dispatchDistance - b.dispatchDistance || (b.rating ?? 0) - (a.rating ?? 0) || String(a.user_id).localeCompare(String(b.user_id)));
}
export function interpolate(a, b, fraction) {
  return { lat: a.lat + (b.lat - a.lat) * fraction, lng: a.lng + (b.lng - a.lng) * fraction };
}
export function normalizePhone(value) {
  const p = String(value).replace(/[\s()-]/g, '');
  if (/^0[37]\d{8}$/.test(p)) return '+256' + p.slice(1);
  if (/^\+256[37]\d{8}$/.test(p)) return p;
  throw new Error('Enter a Uganda mobile number, e.g. 0772 000 101.');
}
export function publicUser(user) {
  if (!user) return null;
  const type = user.account_type || (user.role === 'driver' ? 'car_driver' : user.role);
  return { id: user.id, name: user.name, role: user.role, accountType: type, phone: user.phone || '', avatarUrl: /^https:\/\//i.test(user.avatar_url || '') ? user.avatar_url : '', initials: user.name.trim().split(/\s+/).map(s => s[0]).slice(0, 2).join('').toUpperCase() };
}
