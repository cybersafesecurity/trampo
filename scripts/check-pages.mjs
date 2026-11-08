// Verifies the artifact produced by `npm run build:pages:live`.
// GitHub Pages ignores an uploaded CNAME when the site is published by Actions,
// so the workflow also registers public/CNAME through the Pages settings API.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';

const expectedDomain = 'trampo.lat';
const source = fs.readFileSync('public/CNAME', 'utf8').trim();
const artifact = fs.readFileSync('dist/CNAME', 'utf8').trim();
assert.equal(source, expectedDomain, 'public/CNAME must contain the production domain');
assert.equal(artifact, expectedDomain, 'the Pages artifact must include the production CNAME');

const html = fs.readFileSync('dist/index.html', 'utf8');
assert.match(html, /(?:src|href)="\/assets\/[^"]+"/, 'live Pages assets must use root-domain paths');
assert.doesNotMatch(html, /(?:src|href)="\.\/assets\//, 'live Pages assets must not depend on the old /trampo/ subpath');
assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/, 'the PWA manifest must be linked from the document');
assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon\.png"/, 'iOS home-screen icon must be linked');
assert.ok(fs.existsSync('dist/call-sw.js'), 'the legacy call-worker entry must remain available');
assert.match(fs.readFileSync('dist/call-sw.js', 'utf8'), /importScripts\(new URL\('sw\.js'/, 'legacy call worker must delegate to the single PWA worker');
const js = fs.readdirSync('dist/assets').filter(name => name.endsWith('.js')).map(name => fs.readFileSync(`dist/assets/${name}`, 'utf8')).join('\n');
assert.ok(js.includes('euknlccrsfvuaymuecpd.supabase.co'), 'the Pages artifact must be the live Supabase bundle, not the browser-only demo');

const manifest = JSON.parse(fs.readFileSync('dist/manifest.webmanifest', 'utf8'));
assert.equal(manifest.short_name, 'Trampo');
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/');
assert.equal(manifest.scope, '/');
assert.equal(manifest.theme_color, '#2c001e');
assert.ok(manifest.icons.some(icon => icon.sizes === '192x192' && icon.purpose === 'any'));
assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'any'));
assert.ok(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable'));
for (const icon of manifest.icons) {
  const file = `dist${icon.src}`;
  assert.ok(fs.existsSync(file), `missing manifest icon ${icon.src}`);
  const meta = await sharp(file).metadata();
  assert.equal(`${meta.width}x${meta.height}`, icon.sizes, `icon dimensions must match ${icon.src}`);
  assert.equal(meta.format, 'png');
}
const worker = fs.readFileSync('dist/sw.js', 'utf8');
assert.ok(fs.existsSync('dist/offline.html'), 'the honest offline fallback must be deployed');
assert.ok(worker.includes('offline.html'), 'the worker must cache the offline fallback');
assert.ok(worker.includes('TRAMPO_UPDATE'), 'the worker must support user-controlled updates');
assert.ok(worker.includes('notificationclick'), 'the worker must keep incoming-call notification focus');
assert.ok(!worker.includes('supabase.co'), 'the worker must not contain or cache backend traffic');
const version = JSON.parse(fs.readFileSync('dist/pwa-version.json', 'utf8'));
assert.equal(version.base, '/');
assert.ok(version.files > 5 && /^[a-f0-9]{12}$/.test(version.version));

const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
assert.match(workflow, /pages:\s*write/, 'the workflow needs Pages write permission to register the custom domain');
assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/pages/, 'the workflow must register the domain in Pages settings, not only upload CNAME');
assert.match(workflow, /npm run build:pages:live/, 'the workflow must deploy the live Supabase bundle');

console.log(`Pages artifact OK: https://${expectedDomain}/ (root assets, CNAME, installable PWA, offline shell, call worker, live workflow).`);
