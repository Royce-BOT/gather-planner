import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const flush = () => new Promise(resolve => setImmediate(resolve));
const rows = [
  { church_id: 'church-a', user_id: 'admin-a', full_name: 'Existing Admin', email: 'admin@example.test', status: 'approved', role: 'admin', requested_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
  { church_id: 'church-a', user_id: 'pending-a', full_name: 'Pending Person', email: 'pending@example.test', status: 'pending', role: 'viewer', requested_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' },
  { church_id: 'church-a', user_id: 'rejected-a', full_name: 'Rejected Person', email: 'rejected@example.test', status: 'rejected', role: 'viewer', requested_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' }
];

async function fixture({ allowed = true, confirm = true, listResult = rows, reviewError = null } = {}) {
  const calls = [];
  const fields = new Map();
  const container = {
    innerHTML: '',
    querySelector(selector) {
      if (!fields.has(selector)) fields.set(selector, { value: 'viewer', focus() {}, setSelectionRange() {} });
      return fields.get(selector);
    }
  };
  const access = {
    async list(client, church) { calls.push(['list', church]); return await listResult; },
    async review(client, church, member, kind, role) {
      calls.push(['review', church, member.user_id, kind, role]);
      if (reviewError) throw reviewError;
      return { ...member, status: kind === 'reopen' ? 'pending' : kind === 'approve' ? 'approved' : kind === 'revoke' ? 'revoked' : 'rejected', role };
    }
  };
  const context = vm.createContext({ window: { confirm(label) { calls.push(['confirm', label]); return confirm; } }, GatherAccess: access });
  vm.runInContext(readFileSync(new URL('../admin.js', import.meta.url), 'utf8'), context);
  const admin = context.window.GatherAdmin;
  admin.mount({
    container, client: {}, churchId: 'church-a', userId: 'admin-a',
    isAdmin: () => allowed,
    recheck: async () => { calls.push(['recheck']); },
    notify: message => { calls.push(['notify', message]); }
  });
  await flush();
  return {
    admin, container, calls, fields,
    async click(dataset, id = '') {
      const button = { dataset, id };
      container.onclick({ target: { closest: () => button } });
      await flush();
    },
    async filter(value) { container.onchange({ target: { id: 'member-status', value } }); await flush(); }
  };
}

test('admin workspace starts at pending requests with names, email, count, date and viewer default', async () => {
  const f = await fixture();
  assert.match(f.container.innerHTML, /Pending Person/);
  assert.match(f.container.innerHTML, /pending@example.test/);
  assert.match(f.container.innerHTML, /Requested/);
  assert.match(f.container.innerHTML, /value="viewer" selected/);
  assert.match(f.container.innerHTML, /PENDING<\/span><b>1/);
  assert.doesNotMatch(f.container.innerHTML, /<h2>Rejected Person/);
});

test('non-admins cannot mount member data or invoke admin actions', async () => {
  const f = await fixture({ allowed: false });
  await f.click({ member: 'pending-a', memberAction: 'approve' });
  assert.equal(f.container.innerHTML, '');
  assert.deepEqual(f.calls, []);
});

test('approval requires confirmation and defaults to viewer, with feedback', async () => {
  const f = await fixture();
  await f.click({ member: 'pending-a', memberAction: 'approve' });
  assert.ok(f.calls.some(c => c[0] === 'confirm' && c[1].includes('as viewer')));
  assert.deepEqual(f.calls.find(c => c[0] === 'review'), ['review', 'church-a', 'pending-a', 'approve', 'viewer']);
  assert.match(f.container.innerHTML, /Access updated/);
});

test('cancelling a sensitive action prevents the review RPC', async () => {
  const f = await fixture({ confirm: false });
  await f.click({ member: 'pending-a', memberAction: 'reject' });
  assert.equal(f.calls.some(c => c[0] === 'review'), false);
  assert.match(f.container.innerHTML, /Pending Person/);
});

test('self-review is rejected before confirmation or database calls', async () => {
  const f = await fixture();
  await f.filter('approved');
  await f.click({ member: 'admin-a', memberAction: 'revoke' });
  assert.equal(f.calls.some(c => ['review', 'confirm'].includes(c[0])), false);
  assert.match(f.container.innerHTML, /Last approved admin/);
  assert.match(f.container.innerHTML, /data-member-action="revoke"[^>]*disabled/);
});

test('explicit role selection is passed to backend review', async () => {
  const f = await fixture();
  f.fields.set('[data-member-role="pending-a"]', { value: 'editor' });
  await f.click({ member: 'pending-a', memberAction: 'approve' });
  assert.deepEqual(f.calls.find(c => c[0] === 'review'), ['review', 'church-a', 'pending-a', 'approve', 'editor']);
});

test('rejected requests can be reconsidered and status filters show empty states', async () => {
  const f = await fixture();
  await f.filter('rejected');
  assert.match(f.container.innerHTML, /Rejected Person/);
  await f.click({ member: 'rejected-a', memberAction: 'reopen' });
  assert.match(f.container.innerHTML, /No rejected members/);
  await f.filter('pending');
  assert.match(f.container.innerHTML, /Rejected Person/);
});

test('search filters private member rows using name or email and retains accessible feedback', async () => {
  const f = await fixture();
  await f.filter('all');
  f.container.oninput({ target: { id: 'member-search', value: 'rejected@example', selectionStart: 16 } });
  assert.match(f.container.innerHTML, /Rejected Person/);
  assert.doesNotMatch(f.container.innerHTML, /<h2>Pending Person/);
  assert.match(f.container.innerHTML, /id="admin-feedback" role="status"/);
  f.container.oninput({ target: { id: 'member-search', value: 'missing', selectionStart: 7 } });
  assert.match(f.container.innerHTML, /No matching members/);
});

test('backend authorization or last-admin errors show feedback and trigger access recheck', async () => {
  const f = await fixture({ reviewError: new Error('Cannot remove the last approved admin') });
  await f.click({ member: 'pending-a', memberAction: 'approve' });
  assert.match(f.container.innerHTML, /Cannot remove the last approved admin/);
  assert.ok(f.calls.some(c => c[0] === 'recheck'));
});

test('clearing the workspace discards late private member responses', async () => {
  let resolveList;
  const listResult = new Promise(resolve => { resolveList = resolve; });
  const f = await fixture({ listResult });
  f.admin.clear();
  f.container.innerHTML = 'Signed out';
  resolveList(rows);
  await flush();
  assert.equal(f.container.innerHTML, 'Signed out');
  await f.click({ member: 'pending-a', memberAction: 'approve' });
  assert.equal(f.calls.some(c => c[0] === 'review'), false);
});
