import { test, expect } from '@playwright/test';

test.beforeEach(async ({ request }) => {
  const headers = { 'X-Trampo-Client': 'web' };
  await request.post('/api/demo/session', { data: { role: 'passenger' }, headers });
  await request.post('/api/location', { data: { lat: 0.3354, lng: 32.5769, accuracy: 8, source: 'simulated' }, headers });
  await request.post('/api/settings/night-preview', { data: { enabled: false }, headers });
});

test('demo ride completes the full GPS + passenger + PIN flow', async ({ page }) => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where are we going?' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Garden City', exact: true }).click();
  await page.getByRole('button', { name: 'Request Trampo Boda' }).click();
  await expect(page.getByRole('heading', { name: 'Musa Kato' })).toBeVisible();
  await page.locator('.demo-tools summary').click();
  await page.getByRole('button', { name: 'Simulate driver arrival' }).click();
  await expect(page.getByText('Pickup locations match', { exact: true })).toBeVisible();
  const nightCheck = page.getByLabel('I’m at a well-lit pickup point.');
  if (await nightCheck.isVisible()) await nightCheck.check();
  await page.getByRole('button', { name: 'I’m in the right vehicle' }).click();
  await expect(page.getByText('Boarding confirmed. Your driver can now start the trip.')).toBeVisible();
  await page.getByRole('button', { name: 'Open driver controls' }).click();
  await expect(page.getByRole('heading', { name: 'Hello, Musa.' })).toBeVisible();
  const pin = await page.locator('.demo-pin strong').innerText();
  await page.locator('.pin-input').fill(pin);
  await page.getByRole('button', { name: 'Verify & start trip' }).click();
  await expect(page.getByText('Verified start recorded. Drive safely to the destination.')).toBeVisible();
  await page.getByRole('button', { name: 'Simulate arrival at destination' }).click();
  await page.getByRole('button', { name: /Complete trip · UGX/ }).click();
  await expect(page.getByRole('heading', { name: 'Ready for your next journey.' })).toBeVisible();
  await page.locator('.sidebar-profile').click();
  await page.getByRole('button', { name: 'Passenger experience' }).click();
  await page.getByRole('button', { name: 'My trips', exact: true }).click();
  await expect(page.getByRole('article').getByText('Completed', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Rate trip' }).click();
  await page.getByRole('button', { name: 'Submit rating' }).click();
  await expect(page.getByText('Thanks for sharing. Your rating is saved.')).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile navigation, destination search and night safety tools work', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where are we going?' })).toBeVisible();
  await page.screenshot({ path: 'artifacts/mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Safety centre', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little more peace of mind.' })).toBeVisible();
  await page.getByLabel(/Preview night mode/).check();
  await expect(page.getByText('ACTIVE', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Add a trusted contact' }).click();
  await page.getByLabel('Their name').fill('Test Trusted Person');
  await page.getByLabel('Uganda mobile number').fill('0772123456');
  await page.getByRole('button', { name: 'Save trusted contact' }).click();
  await expect(page.getByText('Test Trusted Person', { exact: true })).toBeVisible();
});

test('driver registration is persisted and pending review', async ({ page }) => {
  await page.goto('/#drive');
  await page.getByLabel('Full name', { exact: true }).fill('Browser Test Driver');
  await page.getByLabel('Uganda mobile number').fill('0772555444');
  await page.getByLabel('Create a password').fill('BrowserTestPassword123!');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Vehicle registration plate').fill('UBT999X');
  await page.getByLabel('Make & model').fill('Toyota Corolla');
  await page.getByLabel('Colour', { exact: true }).fill('Silver');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Driving permit reference').fill('DEMO-PERMIT-BROWSER');
  await page.getByLabel('Vehicle insurance reference').fill('DEMO-INSURANCE-BROWSER');
  await page.locator('.registration-form input[type=checkbox]').check();
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page.getByRole('heading', { name: 'Your next chapter is in review.' })).toBeVisible();
});

test('matched participants can connect a real browser WebRTC audio call', async ({ browser, baseURL }) => {
  const passengerContext = await browser.newContext({ permissions: ['microphone'] });
  const driverContext = await browser.newContext({ permissions: ['microphone'] });
  const passenger = await passengerContext.newPage(), driver = await driverContext.newPage();
  await passenger.goto(baseURL); await expect(passenger.getByRole('heading', { name: 'Where are we going?' })).toBeVisible();
  await passenger.getByRole('button', { name: 'Garden City', exact: true }).click();
  await passenger.getByRole('button', { name: 'Request Trampo Boda' }).click();
  await expect(passenger.getByRole('heading', { name: /Musa Kato|David Okello|Isaac Ssemakula/ })).toBeVisible();
  const state = await passenger.evaluate(async () => (await fetch('/api/bootstrap')).json());
  const driverId = state.activeTrip.driver.id;
  await driver.goto(baseURL); await expect(driver.locator('.sidebar-profile')).toBeVisible();
  await driver.evaluate(async id => { await fetch('/api/demo/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Trampo-Client': 'web' }, body: JSON.stringify({ role: 'driver', userId: id }) }); }, driverId);
  await driver.goto(`${baseURL}/#drive`); await driver.reload();
  await expect(driver.getByRole('heading', { name: /Hello,/ })).toBeVisible();
  await passenger.getByRole('button', { name: 'Call driver for free' }).click();
  await expect(driver.getByRole('button', { name: 'Answer', exact: true })).toBeVisible();
  await driver.getByRole('button', { name: 'Answer', exact: true }).click();
  await expect(passenger.locator('.call-person p')).toContainText('Connected', { timeout: 30000 });
  await expect(driver.locator('.call-person p')).toContainText('Connected', { timeout: 30000 });
  await passenger.getByRole('button', { name: 'End call', exact: true }).click();
  await expect(passenger.locator('.call-overlay')).toHaveCount(0);
  await expect(driver.locator('.call-overlay')).toHaveCount(0);
  await passengerContext.close(); await driverContext.close();
});
