// Verifies the artifact produced by `npm run build:pages:live`.
// GitHub Pages ignores an uploaded CNAME when the site is published by Actions,
// so the workflow also registers public/CNAME through the Pages settings API.
import assert from 'node:assert/strict';
import fs from 'node:fs';

const expectedDomain = 'trampo.lat';
const source = fs.readFileSync('public/CNAME', 'utf8').trim();
const artifact = fs.readFileSync('dist/CNAME', 'utf8').trim();
assert.equal(source, expectedDomain, 'public/CNAME must contain the production domain');
assert.equal(artifact, expectedDomain, 'the Pages artifact must include the production CNAME');

const html = fs.readFileSync('dist/index.html', 'utf8');
assert.match(html, /(?:src|href)="\/assets\/[^"]+"/, 'live Pages assets must use root-domain paths');
assert.doesNotMatch(html, /(?:src|href)="\.\/assets\//, 'live Pages assets must not depend on the old /trampo/ subpath');
assert.ok(fs.existsSync('dist/call-sw.js'), 'the incoming-call notification worker must be deployed at the domain root');
const js = fs.readdirSync('dist/assets').filter(name => name.endsWith('.js')).map(name => fs.readFileSync(`dist/assets/${name}`, 'utf8')).join('\n');
assert.ok(js.includes('euknlccrsfvuaymuecpd.supabase.co'), 'the Pages artifact must be the live Supabase bundle, not the browser-only demo');

const workflow = fs.readFileSync('.github/workflows/pages.yml', 'utf8');
assert.match(workflow, /pages:\s*write/, 'the workflow needs Pages write permission to register the custom domain');
assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/pages/, 'the workflow must register the domain in Pages settings, not only upload CNAME');
assert.match(workflow, /npm run build:pages:live/, 'the workflow must deploy the live Supabase bundle');

console.log(`Pages artifact OK: https://${expectedDomain}/ (root assets, CNAME, call worker, live workflow).`);
