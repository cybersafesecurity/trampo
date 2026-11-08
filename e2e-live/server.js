// Serve the production live bundle at the custom-domain root.
// Auth/API calls are intercepted by the tests; this server never proxies secrets.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(process.env.PAGES_DIST || 'dist-live');
const port = Number(process.env.PORT || 3003);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);
  // Keep old project-page links working during the custom-domain migration.
  if (pathname === '/trampo' || pathname.startsWith('/trampo/')) {
    const target = pathname.replace(/^\/trampo\/?/, '/') || '/';
    res.writeHead(301, { Location: `${target.startsWith('/') ? target : `/${target}`}${url.search}` });
    res.end();
    return;
  }
  const relative = pathname.replace(/^\/+/, '');
  let file = path.resolve(root, relative || 'index.html');
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(port, '0.0.0.0', () => console.log(`Live auth test site: http://0.0.0.0:${port}/`));
