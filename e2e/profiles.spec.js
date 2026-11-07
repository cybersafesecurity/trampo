import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const headers = { 'X-Trampo-Client': 'web' };
  await request.post('/api/demo/session', { data: { role: 'passenger' }, headers });
  await request.post('/api/settings/night-preview', { data: { enabled: false }, headers });
});

test('passenger profile edits persist and Google setup is honest when unconfigured', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/#profile');
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
  await page.getByLabel('City / district').fill('Jinja');
  await page.getByLabel('About you').fill('Profile browser test');
  await page.getByLabel('Preferred ride').selectOption('comfort');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Your profile is saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('City / district')).toHaveValue('Jinja');
  await expect(page.getByLabel('About you')).toHaveValue('Profile browser test');
  await expect(page.getByLabel('Preferred ride')).toHaveValue('comfort');
  await expect(page.getByRole('button', { name: 'Connect Google account' })).toBeDisabled();
  await expect(page.getByText(/Google sign-in is not configured yet/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('admin, car driver and motorbike rider each get the right profile workspace', async ({ page }) => {
  await page.goto('/#profile');
  await page.getByRole('button', { name: 'Account options' }).click();
  await page.getByRole('button', { name: 'Car driver workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Sarah.' })).toBeVisible();
  await page.goto('/#profile');
  await expect(page.getByRole('heading', { name: 'Vehicle & driver details' })).toBeVisible();
  await expect(page.getByLabel('Partner / vehicle class')).toHaveValue('comfort');
  await page.getByRole('button', { name: 'Account options' }).click();
  await page.getByRole('button', { name: 'Motorbike rider workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Musa.' })).toBeVisible();
  await page.goto('/#profile');
  await expect(page.getByRole('heading', { name: 'Motorbike & rider details' })).toBeVisible();
  await expect(page.getByLabel('Partner / vehicle class')).toHaveValue('boda');
  await page.getByRole('button', { name: 'Account options' }).click();
  await page.getByRole('button', { name: 'Admin / operations dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Every journey, in view.' })).toBeVisible();
  await page.goto('/#profile');
  await expect(page.getByRole('heading', { name: 'Operations profile' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'People & partner profiles' })).toBeVisible();
  await page.getByLabel('Search profiles').fill('Musa');
  await expect(page.getByRole('row').filter({ hasText: 'Musa Kato' })).toBeVisible();
  await page.getByRole('button', { name: 'View profile' }).first().click();
  await expect(page.getByRole('dialog', { name: 'Musa Kato' })).toBeVisible();
});

test('profile layout fits a mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/#profile');
  await expect(page.getByRole('heading', { name: 'My profile', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'artifacts/profile-mobile.png', fullPage: true });
});
