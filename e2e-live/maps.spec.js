import { test, expect } from '@playwright/test';

test.skip(process.env.TRAMPO_MAPS_E2E !== 'true', 'Run npm run test:e2e:maps to build with intercepted map/geocoder traffic.');

const ORIGIN = 'https://euknlccrsfvuaymuecpd.supabase.co';
const user = { id: '00000000-0000-4000-8000-000000000002', aud: 'authenticated', role: 'authenticated', email: 'maps-passenger@example.test', email_confirmed_at: '2026-11-08T00:00:00Z', created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: 'Maps Passenger' }, identities: [] };
const session = { access_token: 'mock-access-token', refresh_token: 'mock-refresh-token', expires_at: Math.floor(Date.now()/1000)+3600, expires_in: 3600, token_type: 'bearer', user };
const publicUser = { id: user.id, name: 'Maps Passenger', role: 'passenger', accountType: 'passenger', phone: '+256772000200', initials: 'MP', avatarUrl: '' };
const bootstrap = { user: publicUser, profile: { ...publicUser, email: user.email, emailVerified: true, phoneVerified: true, googleLinked: false, hasPassword: true, city: 'Kampala', bio: '', preferredService: null, accessibilityNote: '', jobTitle: '', department: '', status: 'active', isDemo: false, createdAt: Date.now(), updatedAt: Date.now(), driver: null }, googleSignIn: false, driver: null, demo: false, night: false, nightPreview: false, office: 'Ntinda', location: null, activeTrip: null, trips: [], upcoming: [], nearby: [], offers: [], contacts: [], operations: null, serverTime: Date.now() };
const mapsScript = `
window.google = window.google || {}; window.google.maps = window.google.maps || {};
const m = window.google.maps;
m.importLibrary = async () => ({});
m.Geocoder = class { async geocode(request) { window.__geocodeRequest = request; if (window.__geocodeFail) throw new Error('mock outage'); return { results: [{ formatted_address: 'Acacia Avenue, Kisementi, Kampala, Uganda', address_components: [{ long_name: 'Acacia Avenue', short_name: 'Acacia Avenue', types: ['route'] }, { long_name: 'Kampala', short_name: 'Kampala', types: ['locality'] }, { long_name: 'Uganda', short_name: 'UG', types: ['country', 'political'] }] }] }; } };
m.__ib__();
`;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVRPmP8/xAMAAK7sM9kAAAAASUVORK5CYII=', 'base64');
async function setup(page, { geocodeFail = false, tilesFail = false } = {}) {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.context().grantPermissions(['geolocation']);
  await page.context().setGeolocation({ latitude: 0.3354, longitude: 32.5769, accuracy: 8 });
  await page.addInitScript(({ fail, session }) => { window.__geocodeFail = fail; localStorage.setItem('sb-euknlccrsfvuaymuecpd-auth-token', JSON.stringify(session)); }, { fail: geocodeFail, session });
  await page.route('https://tile.openstreetmap.org/**', route => tilesFail ? route.abort() : route.fulfill({ contentType: 'image/png', body: PNG }));
  await page.route('https://maps.googleapis.com/maps/api/js?**', route => route.fulfill({ contentType: 'application/javascript', body: mapsScript }));
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = body => route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname === '/auth/v1/settings') return json({ external: { email: true, google: false } });
    if (url.pathname.endsWith('/trampo-api/bootstrap')) return json(bootstrap);
    if (url.pathname.endsWith('/trampo-api/location')) return json({ location: { lat: 0.3354, lng: 32.5769, accuracy: 8, source: 'browser', updatedAt: Date.now() } });
    return json({ error: `Unexpected ${url.pathname}` }, 500);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where are we going?' })).toBeVisible();
  return errors;
}
async function useCurrentLocation(page) {
  await page.locator('.route-field').first().click();
  await page.getByRole('button', { name: 'Use my current location' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
}

test('current location keeps the device fix, resolves a Google address and renders the Leaflet pickup marker', async ({ page }) => {
  const errors = await setup(page);
  await useCurrentLocation(page);
  await expect(page.locator('.route-field').first()).toContainText('Acacia Avenue, Kampala');
  await expect(page.locator('.leaflet-map-canvas')).toHaveAttribute('data-map-ready', 'true');
  await expect(page.locator('.trampo-marker').first()).toBeVisible();
  const request = await page.evaluate(() => window.__geocodeRequest);
  expect(request.location).toEqual({ lat: 0.3354, lng: 32.5769 });
  expect(errors).toEqual([]);
});

test('a Google geocoder outage keeps exact GPS coordinates instead of inventing an address', async ({ page }) => {
  const errors = await setup(page, { geocodeFail: true });
  await useCurrentLocation(page);
  await expect(page.locator('.route-field').first()).toContainText('My current location');
  await expect(page.locator('.route-field').first()).toContainText('0.335400, 32.576900');
  await expect(page.locator('.leaflet-map-canvas')).toHaveAttribute('data-map-ready', 'true');
  expect(errors).toEqual([]);
});

test('an OpenStreetMap tile outage falls back honestly to the illustrated map', async ({ page }) => {
  const errors = await setup(page, { tilesFail: true });
  await expect(page.getByText('Map tiles unavailable · illustrated fallback')).toBeVisible({ timeout: 30000 });
  await useCurrentLocation(page);
  await expect(page.locator('.route-field').first()).toContainText('Acacia Avenue, Kampala');
  expect(errors).toEqual([]);
});
