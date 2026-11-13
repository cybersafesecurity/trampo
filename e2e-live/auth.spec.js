import { test, expect } from '@playwright/test';

const ORIGIN = 'https://euknlccrsfvuaymuecpd.supabase.co';
const ADMIN = 'trampo.the.app@gmail.com';
const PASSWORD = process.env.E2E_TEST_PASSWORD || 'mock-password-for-stubbed-tests-only';
const user = {
  id: '00000000-0000-4000-8000-000000000001', aud: 'authenticated', role: 'authenticated', email: ADMIN,
  email_confirmed_at: '2026-11-08T00:00:00Z', created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z',
  app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { name: 'Trampo Admin' }, identities: [],
};
const session = () => ({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user });
const publicUser = { id: user.id, name: 'Trampo Admin', role: 'admin', accountType: 'admin', phone: '', initials: 'TA', avatarUrl: '' };
const bootstrap = () => ({
  user: publicUser,
  profile: { ...publicUser, email: ADMIN, emailVerified: true, phoneVerified: false, googleLinked: false, hasPassword: true, city: 'Kampala', bio: '', preferredService: null, accessibilityNote: '', jobTitle: 'Operations Lead', department: 'Safety & Partner Operations', status: 'active', isDemo: false, createdAt: Date.now(), updatedAt: Date.now(), driver: null },
  googleSignIn: false, driver: null, demo: false, night: false, nightPreview: false, office: 'Plot 14 Martyrs Drive, Ntinda Ministers Village', location: null, activeTrip: null, trips: [], upcoming: [], nearby: [], offers: [], contacts: [], serverTime: Date.now(),
  operations: { alerts: [], drivers: [], trips: [], stats: { drivers: 0, approved: 0, pending: 0, active: 0, completed: 0, openAlerts: 0 } },
});

async function setup(page, { recoverError, googleEnabled = false } = {}) {
  const calls = { signup: null, recover: null, exchange: null, update: null };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-trampo-client', 'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', headers, body: JSON.stringify(body) });
    const body = ['POST', 'PUT'].includes(request.method()) ? request.postDataJSON() : {};
    if (url.pathname === '/auth/v1/settings') return json({ external: { email: true, google: googleEnabled } });
    if (url.pathname === '/auth/v1/authorize' || url.pathname === '/auth/v1/user/identities/authorize') return route.fulfill({ status: 200, contentType: 'text/html', headers, body: 'Supabase Google OAuth redirect' });
    if (url.pathname === '/auth/v1/signup') { calls.signup = { ...body, query: Object.fromEntries(url.searchParams) }; return json({ ...user, email_confirmed_at: null }); }
    if (url.pathname === '/auth/v1/recover') {
      calls.recover = { ...body, query: Object.fromEntries(url.searchParams) };
      return recoverError ? json(recoverError, recoverError.status || 400) : json({});
    }
    if (url.pathname === '/auth/v1/token') { calls.exchange = { ...body, grantType: url.searchParams.get('grant_type') }; return json(session()); }
    if (url.pathname === '/auth/v1/user' && request.method() === 'PUT') { calls.update = body; return json(user); }
    if (url.pathname === '/auth/v1/user') return json(user);
    if (url.pathname.endsWith('/functions/v1/trampo-api/bootstrap')) return json(bootstrap());
    if (url.pathname.endsWith('/functions/v1/trampo-api/config')) return json({ ok: true, demo: false, googleSignIn: false });
    return json({ error: `Unexpected test request: ${url.pathname}` }, 500);
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Trampo.' })).toBeVisible();
  return { calls, errors };
}

test('first admin signup keeps the chosen password and activates Operations only after the email callback', async ({ page }) => {
  const { calls, errors } = await setup(page);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.getByLabel('Full name').fill('Trampo Admin');
  await page.getByLabel('Email address').fill(ADMIN);
  await expect(dialog).toContainText('Set up your admin account.');
  await page.getByLabel(/^Password/).fill(PASSWORD);
  await page.getByLabel('Confirm password', { exact: true }).fill(PASSWORD);
  await page.getByRole('button', { name: 'Create admin account' }).click();
  await expect(dialog).toContainText('Your admin account and password are saved.');
  expect(calls.signup.email).toBe(ADMIN);
  expect(calls.signup.password).toBe(PASSWORD);
  expect(calls.signup.query.redirect_to).toContain('http://127.0.0.1:3003/');
  expect(calls.signup.data).toEqual({ name: 'Trampo Admin' });
  await expect(page.getByRole('button', { name: 'Operations', exact: true })).toHaveCount(0);
  await page.goto('/?code=test-signup-callback');
  await expect(page.getByRole('button', { name: 'Operations', exact: true })).toBeVisible();
  expect(calls.exchange.grantType).toBe('pkce');
  expect(calls.exchange.code_verifier).toBeTruthy();
  expect(errors).toEqual([]);
});

test('forgot password sends a PKCE reset link, opens the new-password form, validates confirmation and saves it', async ({ page }) => {
  const { calls, errors } = await setup(page);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address').fill(ADMIN);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('a reset link has been sent');
  await expect(page.getByRole('button', { name: /Resend reset email/ })).toBeDisabled();
  expect(calls.recover.email).toBe(ADMIN);
  expect(calls.recover.query.redirect_to).toContain('http://127.0.0.1:3003/');
  expect(calls.recover.code_challenge).toBeTruthy();
  await page.goto('/?code=test-recovery-callback');
  await expect(page.getByRole('heading', { name: 'Choose a new password.' })).toBeVisible();
  await page.getByLabel(/^New password/).fill(PASSWORD);
  await page.getByLabel('Confirm new password').fill('not-the-same-password');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(dialog).toContainText('The passwords do not match.');
  expect(calls.update).toBeNull();
  await page.getByLabel('Confirm new password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('button', { name: 'Operations', exact: true })).toBeVisible();
  expect(calls.update.password).toBe(PASSWORD);
  expect(calls.exchange.grantType).toBe('pkce');
  expect(errors).toEqual([]);
});

test('mail errors explain the quota and expired links without a false success notice', async ({ page }) => {
  const { errors } = await setup(page, { recoverError: { status: 429, code: 'over_email_send_rate_limit', message: 'For security purposes, you can only request this after 55 seconds.' } });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address').fill(ADMIN);
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('dialog')).toContainText('two emails per hour');
  await expect(page.getByRole('button', { name: 'Forgot password?' })).toBeEnabled();
  await page.goto('/?error=access_denied&error_code=otp_expired&error_description=Email%20link%20is%20invalid%20or%20has%20expired');
  await expect(page.getByRole('dialog')).toContainText('This email link has expired');
  await expect(page.getByRole('dialog')).toContainText('newest email');
  await expect(page).not.toHaveURL(/error_code/);
  expect(errors).toEqual([]);
});

test('non-team addresses get the custom-SMTP explanation rather than a false success message', async ({ page }) => {
  const { errors } = await setup(page, { recoverError: { status: 400, code: 'email_address_not_authorized', message: 'Email address not authorized.' } });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByLabel('Email address').fill('someone@example.test');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('custom SMTP configured in Supabase');
  await expect(dialog).not.toContainText('a reset link has been sent');
  expect(errors).toEqual([]);
});


test('live Google button follows Supabase Auth settings and starts a PKCE OAuth redirect', async ({ page }) => {
  const { errors } = await setup(page, { googleEnabled: true });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const google = page.getByRole('button', { name: 'Continue with Google' });
  await expect(google).toBeEnabled();
  await google.click();
  await page.waitForURL(/\/auth\/v1\/authorize/);
  const url = new URL(page.url());
  expect(url.searchParams.get('provider')).toBe('google');
  expect(url.searchParams.get('redirect_to')).toContain('http://127.0.0.1:3003/');
  expect(url.searchParams.get('code_challenge')).toBeTruthy();
  expect(errors).toEqual([]);
});

test('dark Ubuntu theme and the prominent Trampo logo are present before sign-in', async ({ page }) => {
  const { errors } = await setup(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#2c001e');
  const theme = await page.evaluate(() => ({
    font: getComputedStyle(document.body).fontFamily,
    background: getComputedStyle(document.body).backgroundColor,
    logo: document.querySelector('.boot-screen .brand img')?.getBoundingClientRect().width || 0,
    wordmark: document.querySelector('.boot-screen .brand > span')?.getBoundingClientRect().height || 0,
  }));
  expect(theme.font).toContain('Ubuntu');
  expect(theme.background).not.toBe('rgb(255, 255, 255)');
  expect(theme.logo).toBeGreaterThanOrEqual(60);
  expect(theme.wordmark).toBeGreaterThanOrEqual(40);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(errors).toEqual([]);
});

test('legacy project-page URLs redirect to the custom-domain root without dropping callback query parameters', async ({ request }) => {
  const response = await request.get('/trampo/?code=legacy-callback', { maxRedirects: 0 });
  expect(response.status()).toBe(301);
  expect(response.headers().location).toBe('/?code=legacy-callback');
});
