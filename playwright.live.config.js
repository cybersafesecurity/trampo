import { defineConfig } from '@playwright/test';
const sandbox = process.env.TRAMPO_SANDBOX_BROWSER === 'true';
let executablePath = process.env.CHROMIUM_PATH;
let args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'];
if (sandbox) {
  const { default: chromium, inflate } = await import('@sparticuz/chromium');
  await inflate(new URL('./node_modules/@sparticuz/chromium/bin/al2023.tar.br', import.meta.url).pathname);
  process.env.LD_LIBRARY_PATH = '/tmp/al2023/lib:' + (process.env.LD_LIBRARY_PATH || '');
  executablePath = await chromium.executablePath();
  args = [...chromium.args.filter(x => !['--disable-web-security', '--allow-running-insecure-content', '--disable-site-isolation-trials', '--single-process'].includes(x)), ...args];
}
export default defineConfig({
  testDir: './e2e-live', timeout: 120000, expect: { timeout: 30000 }, fullyParallel: false, workers: 1,
  reporter: [['list']], outputDir: 'test-results/live-auth',
  use: { baseURL: 'http://127.0.0.1:3003', viewport: { width: 1440, height: 1000 }, launchOptions: { executablePath, args }, screenshot: 'only-on-failure', trace: sandbox ? 'off' : 'retain-on-failure' },
  webServer: { command: 'node e2e-live/server.js', url: 'http://127.0.0.1:3003/', reuseExistingServer: false, timeout: 30000, env: { PORT: '3003' } },
});
