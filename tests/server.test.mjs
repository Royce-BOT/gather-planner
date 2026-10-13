import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createGatherServer } from '../scripts/dev-server.mjs';

test('local server serves the app and never serves repository or SQL files', async t => {
  const server = createGatherServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type'), /text\/html/);
  assert.match(await page.text(), /Worship/);
  for (const path of ['/.git/config', '/setup.sql', '/sql/first-admin.sql', '/package.json', '/README.md', '/missing.js']) {
    assert.equal((await fetch(base + path)).status, 404, path);
  }
  const head = await fetch(`${base}/style.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(base, { method: 'POST' })).status, 405);
});
