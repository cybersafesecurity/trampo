// Deterministic, non-billable Google Maps browser tests. The test key is only used to
// exercise the loader; Playwright intercepts Google's script and geocoder responses.
import { spawnSync } from 'node:child_process';
const env = { ...process.env, VITE_GOOGLE_MAPS_API_KEY: 'test-only-browser-key', TRAMPO_MAPS_E2E: 'true' };
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const [cmd, args] of [[npm, ['run', 'build:live']], [npx, ['playwright', 'test', '--config=playwright.live.config.js', 'e2e-live/maps.spec.js']]]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
