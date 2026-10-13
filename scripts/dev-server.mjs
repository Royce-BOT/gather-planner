import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The local server uses the deployment policy so regressions can be caught locally.
const deployment = JSON.parse(readFileSync(resolve(root, 'vercel.json'), 'utf8'));
export const securityHeaders = Object.freeze({ ...deployment.routes[0].headers });
// Serve only the public app files. SQL, Git metadata, tests, and local files stay private.
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ...['config.js', 'planner.js', 'render.js', 'app.js', 'auth.js', 'access.js', 'admin.js'].map(file => [`/${file}`, [file, 'text/javascript; charset=utf-8']])
]);

export function createGatherServer() {
  return createServer(async (request, response) => {
    for (const [name, value] of Object.entries(securityHeaders)) response.setHeader(name, value);
    if (!['GET', 'HEAD'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, HEAD' });
      response.end();
      return;
    }
    let pathname;
    try { pathname = new URL(request.url, 'http://localhost').pathname; }
    catch { response.writeHead(400); response.end(); return; }
    const asset = assets.get(pathname);
    if (!asset) { response.writeHead(404); response.end('Not found'); return; }
    try {
      const body = await readFile(resolve(root, asset[0]));
      response.writeHead(200, { 'Content-Type': asset[1] });
      response.end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(500); response.end('Could not read app asset'); }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be between 1 and 65535');
  createGatherServer().listen(port, 'localhost', () => {
    console.log(`Gather is available at http://localhost:${port}/ (Ctrl+C to stop).`);
  });
}
