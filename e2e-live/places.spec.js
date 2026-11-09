import { test, expect } from '@playwright/test';

const ORIGIN = 'https://euknlccrsfvuaymuecpd.supabase.co';
const user = { id: '00000000-0000-4000-8000-000000000021', aud: 'authenticated', role: 'authenticated', email: 'places@example.test', email_confirmed_at: '2026-11-09T00:00:00Z', created_at: '2026-11-09T00:00:00Z', updated_at: '2026-11-09T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: 'Places Passenger' }, identities: [] };
const session = { access_token: 'places-token', refresh_token: 'places-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user };
const publicUser = { id: user.id, name: 'Places Passenger', role: 'passenger', accountType: 'passenger', phone: '+256772000401', initials: 'PP', avatarUrl: '' };
const bootstrap = { user: publicUser, profile: { ...publicUser, email: user.email, emailVerified: true, phoneVerified: true, googleLinked: false, hasPassword: true, city: 'Kampala', bio: '', preferredService: null, accessibilityNote: '', jobTitle: '', department: '', status: 'active', isDemo: false, createdAt: Date.now(), updatedAt: Date.now(), driver: null }, googleSignIn: false, driver: null, demo: false, night: false, nightPreview: false, office: 'Ntinda', location: null, activeTrip: null, trips: [], upcoming: [], nearby: [], offers: [], contacts: [], operations: null, serverTime: Date.now() };
const feature = { geometry: { coordinates: [32.5825, .3136] }, properties: { name: 'Cafe Javas', street: 'Acacia Avenue', city: 'Kampala', countrycode: 'UG', osm_value: 'cafe' } };

async function setup(page) {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const requests = [];
  await page.addInitScript(({ session }) => { if (location.protocol.startsWith('http')) localStorage.setItem('sb-euknlccrsfvuaymuecpd-auth-token', JSON.stringify(session)); }, { session });
  await page.route('https://tile.openstreetmap.org/**', route => route.abort());
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    if (url.pathname === '/auth/v1/settings') return json({ external: { email: true, google: false } });
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.endsWith('/trampo-api/config')) return json({ ok: true, demo: false, googleSignIn: false });
    if (url.pathname.endsWith('/trampo-api/bootstrap')) return json(bootstrap);
    if (url.pathname.endsWith('/trampo-api/places/search')) { requests.push({ kind: 'search', query: Object.fromEntries(url.searchParams) }); return json({ features: [feature] }); }
    if (url.pathname.endsWith('/trampo-api/places/reverse')) { requests.push({ kind: 'reverse', query: Object.fromEntries(url.searchParams) }); return json({ features: [feature] }); }
    return json({ error: `Unexpected places-test request: ${url.pathname}` }, 500);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where are we going?' })).toBeVisible();
  return { errors, requests };
}

test('typed destination resolves through the labelled no-key OpenStreetMap fallback and keeps manual coordinate naming', async ({ page }) => {
  const { errors, requests } = await setup(page);
  await page.locator('.destination-field').click();
  await page.getByLabel('Search destinations').fill('Cafe Javas');
  const result = page.locator('.place-result', { hasText: 'Cafe Javas, Kampala' });
  await expect(result).toBeVisible();
  await expect(result).toContainText('OpenStreetMap');
  await expect(page.locator('.geocoder-attribution')).toContainText('OpenStreetMap contributors');
  await result.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.destination-field')).toContainText('Cafe Javas, Kampala');
  expect(requests.some(r => r.kind === 'search' && r.query.q === 'Cafe Javas')).toBe(true);

  await page.locator('.route-field').first().click();
  await page.getByRole('button', { name: 'Have coordinates? Enter a custom location' }).click();
  await page.getByLabel('Location name').fill('My Hotel');
  await page.getByLabel('Latitude').fill('0.3354');
  await page.getByLabel('Longitude').fill('32.5769');
  await page.getByRole('button', { name: 'Use these coordinates' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.route-field').first()).toContainText('My Hotel');
  const reverse = requests.find(r => r.kind === 'reverse');
  expect(reverse.query.lat).toBe('0.3354'); expect(reverse.query.lon).toBe('32.5769');
  expect(errors).toEqual([]);
});
