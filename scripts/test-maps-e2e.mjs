// Deterministic, non-billable map tests. The test key only exercises the optional
// Google geocoder; Playwright intercepts Google and OpenStreetMap tile traffic.
import { spawnSync } from 'node:child_process';
const env = {
  ...process.env,
  VITE_TRAMPO_BACKEND: 'supabase',
  VITE_SUPABASE_URL: process.env.VITE_SUPABASE_URL || 'https://euknlccrsfvuaymuecpd.supabase.co',
  VITE_SUPABASE_PUBLISHABLE_KEY: process.env.VITE_SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_Cp6uo1XC01OdaHeT5d8baw_9nnFkqhV',
  VITE_GOOGLE_MAPS_API_KEY: 'test-only-browser-key',
  TRAMPO_MAPS_E2E: 'true',
};
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const [cmd, args] of [[npm, ['run', 'build:live']], [npx, ['playwright', 'test', '--config=playwright.live.config.js', 'e2e-live/maps.spec.js']]]) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', env });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
