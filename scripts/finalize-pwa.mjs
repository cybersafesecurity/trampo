// Build a self-contained classic service worker and base-aware manifest after Vite.
// No third-party runtime scripts, API responses or user data enter the precache.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { pwaManifest } from '../src/pwa-config.ts';

const out = path.resolve(process.argv[2] || 'dist');
assert.ok(fs.existsSync(path.join(out, 'index.html')), `Build output not found: ${out}`);
const html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const match = html.match(/(?:src|href)="([^"]*assets\/[^"]+\.js)"/);
assert.ok(match, 'Could not find the Vite entry asset');
const rawEntry = match[1];
const entry = new URL(rawEntry, 'https://trampo.invalid');
const base = rawEntry.slice(0, rawEntry.indexOf('assets/')) || entry.pathname.slice(0, entry.pathname.indexOf('assets/')) || '/';
const files = [];
function walk(dir, prefix = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isDirectory()) walk(path.join(dir, item.name), rel);
    else if (/^assets\/.+\.(js|css|woff2?|png|svg|jpg|webp)$/.test(rel) || /^(favicon\.svg|icons\/.+\.png)$/.test(rel)) files.push(rel);
  }
}
walk(out);
files.sort();
assert.ok(files.some(file => file.endsWith('.js')) && files.includes('icons/icon-192.png') && files.includes('icons/icon-512.png'), 'Incomplete PWA build assets');
const hash = crypto.createHash('sha256');
for (const file of files) hash.update(file).update(fs.readFileSync(path.join(out, file)));
hash.update(fs.readFileSync(path.join(out, 'offline.html')));
const version = hash.digest('hex').slice(0, 12);
const result = await build({
  entryPoints: ['src/service-worker.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022', minify: true,
  define: { __TRAMPO_PRECACHE__: JSON.stringify(files), __TRAMPO_VERSION__: JSON.stringify(version) },
});
fs.writeFileSync(path.join(out, 'sw.js'), result.outputFiles[0].text);
// Migrate windows that still have the earlier notification-only worker registered.
fs.writeFileSync(path.join(out, 'call-sw.js'), `/* Compatibility entry; sw.js is the single active app/call worker. */\nimportScripts(new URL('sw.js', self.location).href);\n`);
fs.writeFileSync(path.join(out, 'manifest.webmanifest'), JSON.stringify(pwaManifest(base), null, 2) + '\n');
fs.writeFileSync(path.join(out, 'pwa-version.json'), JSON.stringify({ version, base, files: files.length }) + '\n');
console.log(`PWA ready: base ${base}, ${files.length} public files, shell ${version}. No API/auth/trip data is cached.`);
