export const UGANDA_BOUNDS = { south: -1.55, north: 4.6, west: 29.4, east: 35.1 };
export const GPS_MAX_AGE_MS = 15_000;
export const GPS_MAX_ACCURACY = 50;
export const NIGHT_MATCH_METERS = 25;
export const DAY_MATCH_METERS = 35;
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
export function gpsMatch(riderFix, driverFix, now = Date.now(), night = false) {
  const threshold = night ? NIGHT_MATCH_METERS : DAY_MATCH_METERS;
  const reasons = [];
  for (const [role, fix] of [['passenger', riderFix], ['driver', driverFix]]) {
    if (!fix || !inUganda(fix)) reasons.push(`${role}_missing`);
    else {
      if (!Number.isFinite(fix.updatedAt) || now - fix.updatedAt > GPS_MAX_AGE_MS || fix.updatedAt > now + 5000) reasons.push(`${role}_stale`);
      if (!Number.isFinite(fix.accuracy) || fix.accuracy < 0 || fix.accuracy > GPS_MAX_ACCURACY) reasons.push(`${role}_inaccurate`);
    }
  }
  const distance = distanceMeters(riderFix, driverFix);
  if (Number.isFinite(distance) && distance > threshold) reasons.push('too_far');
  return { matched: reasons.length === 0 && Number.isFinite(distance), distance: Number.isFinite(distance) ? Math.round(distance) : null, threshold, reasons, maxAccuracy: GPS_MAX_ACCURACY, maxAgeSeconds: GPS_MAX_AGE_MS / 1000 };
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
