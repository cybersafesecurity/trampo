// Serve the production live bundle under the same subpath as GitHub Pages.
// Auth/API calls are intercepted by the tests; this server never proxies secrets.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve('dist-live');
const port = Number(process.env.PORT || 3003);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };
http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (pathname === '/' || pathname === '/trampo') { res.writeHead(302, { Location: '/trampo/' }); res.end(); return; }
  if (!pathname.startsWith('/trampo/')) { res.writeHead(404); res.end('Not found'); return; }
  const relative = pathname.slice('/trampo/'.length);
  let file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Live auth test site: http://0.0.0.0:${port}/trampo/`));
