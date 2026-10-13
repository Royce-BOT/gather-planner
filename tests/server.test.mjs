import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { createGatherServer, securityHeaders } from '../scripts/dev-server.mjs';

test('local server serves the app and never serves repository or SQL files', async t => {
  const server = createGatherServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  const html = await page.text();
  assert.match(html, /Worship/);
  for (const [, asset] of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"#]+)"/g)) {
    if (/^https?:/.test(asset)) continue;
    const assetResponse = await fetch(new URL(asset, base + '/'));
    assert.equal(assetResponse.status, 200, asset);
    await assetResponse.arrayBuffer();
  }
  for (const file of ['gather-logo.png', 'gather-icon-192.png', 'gather-icon-32.png']) {
    const assetResponse = await fetch(`${base}/assets/${file}`);
    assert.equal(assetResponse.status, 200, file);
    assert.equal(assetResponse.headers.get('content-type'), 'image/png', file);
    const bytes = new Uint8Array(await assetResponse.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], file);
    const assetHead = await fetch(`${base}/assets/${file}`, { method: 'HEAD' });
    assert.equal(assetHead.status, 200, file);
    assert.equal(assetHead.headers.get('content-type'), 'image/png', file);
    assert.equal(await assetHead.text(), '');
    assert.equal((await fetch(`${base}/assets/${file}`, { method: 'POST' })).status, 405, file);
  }
  for (const path of ['/.git/config', '/.env', '/vercel.json', '/setup.sql', '/sql/first-admin.sql', '/package.json', '/README.md', '/AUDIT.md', '/tests/app.test.mjs', '/scripts/audit-secrets.mjs', '/backups/private.json', '/missing.js', '/app.js/extra', '/assets/private.png', '/assets/private.json', '/assets/gather-logo.png/extra', '/assets/gather-logoXpng', '/assets/nested/gather-logo.png', '/%2e%2e/.git/config']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const head = await fetch(`${base}/style.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});

test('local success and error responses carry the deployment security policy', async t => {
  const server = createGatherServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [path, method] of [['/', 'GET'], ['/auth.js', 'HEAD'], ['/.env', 'GET'], ['/', 'POST']]) {
    const response = await fetch(base + path, { method });
    for (const [header, value] of Object.entries(securityHeaders)) assert.equal(response.headers.get(header), value);
    await response.arrayBuffer();
  }
  const csp = securityHeaders['Content-Security-Policy'];
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self' https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js;/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https:\/\/\*|\*\.supabase/);
});

test('Vercel routes allow only known app assets and deny repository paths and writes', () => {
  const deployment = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  function route(path, method = 'GET') {
    return deployment.routes.find(rule => !rule.continue && new RegExp(rule.src).test(path) && (!rule.methods || rule.methods.includes(method)));
  }
  for (const path of ['/', '/index.html', '/style.css', '/config.js', '/planner.js', '/render.js', '/app.js', '/auth.js', '/access.js', '/admin.js', '/assets/gather-logo.png', '/assets/gather-icon-192.png', '/assets/gather-icon-32.png']) {
    assert.ok(route(path).dest, path);
    assert.ok(route(path, 'HEAD').dest, path);
    assert.equal(route(path, 'POST').status, 404, path);
    assert.equal(route(path, 'DELETE').status, 404, path);
  }
  for (const path of ['/.env', '/.git/config', '/setup.sql', '/sql/first-admin.sql', '/README.md', '/AUDIT.md', '/package.json', '/vercel.json', '/scripts/dev-server.mjs', '/tests/auth.test.mjs', '/app.js/extra', '/prefix/app.js', '/appXjs', '/assets/private.png', '/assets/private.json', '/assets/gather-logo.png/extra', '/assets/gather-logoXpng', '/assets/nested/gather-logo.png']) {
    assert.equal(route(path).status, 404, path);
  }
});

test('deployment policy matches the configured Supabase project and pinned SDK', () => {
  const context = { window: {} };
  vm.runInNewContext(readFileSync(new URL('../config.js', import.meta.url), 'utf8'), context);
  const config = context.window.GatherConfig;
  const origin = new URL(config.url).origin;
  const csp = securityHeaders['Content-Security-Policy'];
  assert.ok(csp.includes(`connect-src ${origin} ${origin.replace('https:', 'wss:')};`));
  assert.ok(csp.includes(`script-src 'self' ${config.sdkUrl};`));
  assert.match(config.sdkUrl, /^https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@\d+\.\d+\.\d+\/dist\/umd\/supabase\.js$/);
  assert.match(config.sdkIntegrity, /^sha384-[A-Za-z0-9+/]{64}$/);
});
