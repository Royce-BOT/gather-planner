import assert from 'node:assert/strict';
import test from 'node:test';
import { scanText } from '../scripts/audit-secrets.mjs';

const jwt = role => [Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url'), Buffer.from(JSON.stringify({ role })).toString('base64url'), 'syntheticSignature'].join('.');

test('secret report distinguishes browser configuration from privileged keys and never returns values', () => {
  const publicKey = 'sb_' + 'publishable_' + 'a'.repeat(32);
  const privateKey = 'sb_' + 'secret_' + 'b'.repeat(32);
  const googleSecret = 'GOCSP' + 'X-' + 'c'.repeat(24);
  const source = `${publicKey}\n${privateKey}\n${googleSecret}\n${jwt('anon')}\n${jwt('service_role')}`;
  const report = scanText(source, 'config.js');
  assert.deepEqual(report.map(item => item.classification).sort(), ['public-supabase-publishable-key', 'supabase-secret-key', 'google-client-secret', 'public-supabase-anon-key', 'supabase-service-role-jwt'].sort());
  const output = JSON.stringify(report);
  for (const value of source.split('\n')) assert.equal(output.includes(value), false);
  assert.ok(report.every(item => Number.isInteger(item.line) && item.occurrences > 0));
});

test('secret scan redacts database credentials, generic secret assignments, and private records', () => {
  const password = ['production', 'credential'].join('-');
  const mailbox = ['person', 'private-domain.org'].join('@');
  const source = `postgresql://owner:${password}@db.invalid/database\nCLIENT_SECRET = '${password}'\n${mailbox}\ncontact: '${password}'`;
  const report = scanText(source, 'backup.json');
  for (const classification of ['database-password-url', 'secret-assignment-candidate', 'personal-email-candidate', 'embedded-private-record-candidate']) {
    assert.ok(report.some(item => item.classification === classification));
  }
  assert.doesNotMatch(JSON.stringify(report), new RegExp(password));
  assert.equal(JSON.stringify(report).includes(mailbox), false);
});

test('placeholder configuration is ignored and isolated fixtures are clearly classified', () => {
  assert.deepEqual(scanText("CLIENT_SECRET = 'REPLACE_WITH_SECRET'\nDB_PASSWORD = 'YOUR_PASSWORD'"), []);
  const report = scanText("email: 'user@example.test', person: 'Synthetic Reader'", 'tests/fake.test.mjs');
  assert.ok(report.length > 0);
  assert.ok(report.every(item => item.fixture));
});

test('scan recognizes literal and env credentials without confusing DOM identifiers or interpolation', () => {
  const credential = ['unique', 'credential'].join('-');
  const literal = `clientSecret: '${credential}'\nDB_PASSWORD=${credential}`;
  assert.equal(scanText(literal).filter(item => item.classification === 'secret-assignment-candidate').length, 2);
  const code = "const password = $('#auth-password').value;\nmode ? 'new-password' : 'current-password';\npostgresql://owner:${password}@db.invalid/database";
  assert.deepEqual(scanText(code), []);
});
