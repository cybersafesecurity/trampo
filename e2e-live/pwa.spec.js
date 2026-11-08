import { test, expect } from '@playwright/test';

const ORIGIN = 'https://euknlccrsfvuaymuecpd.supabase.co';

async function mockBackend(page) {
  await page.route(`${ORIGIN}/**`, route => {
    const url = new URL(route.request().url());
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (url.pathname === '/auth/v1/settings') return route.fulfill({ contentType: 'application/json', headers, body: JSON.stringify({ external: { email: true, google: false } }) });
    return route.fulfill({ status: 401, contentType: 'application/json', headers, body: JSON.stringify({ error: 'sign in' }) });
  });
}

async function readyWorker(page) {
  await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) throw new Error('Service workers unavailable');
    await navigator.serviceWorker.ready;
  });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
}

test('PWA manifest, icons and offline shell are published without caching account or trip traffic', async ({ page, context }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await mockBackend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Trampo.' })).toBeVisible();
  await readyWorker(page);

  const manifest = await page.evaluate(async () => (await fetch('/manifest.webmanifest')).json());
  expect(manifest.name).toContain('Trampo');
  expect(manifest.short_name).toBe('Trampo');
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.scope).toBe('/');
  expect(manifest.icons).toEqual(expect.arrayContaining([
    expect.objectContaining({ sizes: '192x192', purpose: 'any' }),
    expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
  ]));
  for (const icon of manifest.icons) {
    const response = await page.request.get(icon.src);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('image/png');
  }
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');

  const cacheAudit = await page.evaluate(async () => {
    const keys = await caches.keys();
    const urls = [];
    for (const key of keys) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return { keys, urls };
  });
  expect(cacheAudit.keys.some(key => key.startsWith('trampo-'))).toBe(true);
  expect(cacheAudit.urls.length).toBeGreaterThan(5);
  for (const url of cacheAudit.urls) {
    expect(url).not.toContain('supabase.co');
    expect(url).not.toMatch(/\/(api|auth|functions|rest|realtime|share)(\/|$)/);
    expect(url).not.toMatch(/[?&](code|token|access_token|refresh_token|token_hash)=/);
  }

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Let’s get you back online.' })).toBeVisible();
  await expect(page.getByText('For your safety, Trampo does not show cached driver locations')).toBeVisible();
  await context.setOffline(false);
  // Reconnect explicitly instead of racing the offline page's `online` auto-reload.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Trampo.' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('install entry point explains platform steps and uses the native prompt when the browser offers one', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Welcome to Trampo.' })).toBeVisible();
  await page.getByRole('button', { name: 'Install Trampo app' }).click();
  const dialog = page.getByRole('dialog', { name: 'Install Trampo' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Launch Trampo from your home screen');
  await expect(dialog).toContainText('closed-app push');

  await page.evaluate(() => {
    const event = new Event('beforeinstallprompt', { cancelable: true });
    window.__installPrompted = false;
    event.prompt = async () => { window.__installPrompted = true; };
    event.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
    window.dispatchEvent(event);
  });
  await dialog.getByRole('button', { name: 'Install now' }).click();
  await expect.poll(() => page.evaluate(() => window.__installPrompted)).toBe(true);
  await expect(page.getByText('Trampo is installed. Open it from your home screen or app launcher.')).toBeVisible();
});

test('credential-bearing auth callbacks and shared journeys are never served from the offline cache', async ({ page, context }) => {
  await mockBackend(page);
  await page.goto('/');
  await readyWorker(page);
  await context.setOffline(true);
  const callback = await page.goto('/?code=one-time-secret').catch(error => error.message);
  expect(String(callback)).toMatch(/net::|ERR_/);
  const share = await page.goto('/share/private-token').catch(error => error.message);
  expect(String(share)).toMatch(/net::|ERR_/);
  await context.setOffline(false);
  await page.goto('/');
  await readyWorker(page);
  const cached = await page.evaluate(async () => {
    const urls = [];
    for (const key of await caches.keys()) {
      const cache = await caches.open(key);
      for (const request of await cache.keys()) urls.push(request.url);
    }
    return urls;
  });
  expect(cached.some(url => url.includes('one-time-secret') || url.includes('private-token'))).toBe(false);
});
