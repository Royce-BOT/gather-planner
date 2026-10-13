import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(new URL('../planner.js', import.meta.url), 'utf8'), context);
context.GatherPlanner = context.window.GatherPlanner;
vm.runInContext(readFileSync(new URL('../access.js', import.meta.url), 'utf8'), context);
const access = context.window.GatherAccess;
const church = 'church-a';
const user = { id: 'user-a', email: 'member@example.test', email_confirmed_at: '2026-10-13T00:00:00Z', user_metadata: { full_name: 'Ministry Member', role: 'admin' } };
const membership = (status = 'approved', role = 'viewer') => ({ church_id: church, user_id: user.id, status, role, updated_at: '2026-10-13T00:00:00Z' });
const plain = value => JSON.parse(JSON.stringify(value));

const publicData = () => ({
  services: [{
    id: 'public-service', title: 'Sunday Worship', date: '2026-10-18', time: '09:00',
    theme: 'Hope', location: 'Public sanctuary entrance',
    program: [{ title: 'Opening prayer', minutes: 5 }, { title: 'Reading', minutes: 7, person: 'Published reader' }]
  }],
  songs: [{ id: 'public-song', title: 'Published song' }]
});

test('public viewing uses only the scoped projection RPC without authentication or private table reads', async () => {
  const calls = [], projected = publicData();
  const client = {
    async rpc(name, args) { calls.push([name, plain(args)]); return { data: projected, error: null }; },
    auth: { getUser() { assert.fail('Public browsing must not require signing in'); } },
    from() { assert.fail('Public browsing must not download the private planner document'); }
  };
  assert.deepEqual(plain(await access.publicPlanner(client, church)), projected);
  assert.deepEqual(calls, [['gather_public_planner', { p_church_id: church }]]);
});

test('public response validation rejects private or unknown fields instead of rendering them', async () => {
  const variants = [
    data => { data.team = [{ name: 'Private volunteer', contact: 'private@example.test' }]; },
    data => { data.members = [{ email: 'private@example.test', role: 'admin' }]; },
    data => { data.version = 7; },
    data => { data.services[0].notes = 'Private preparation notes'; },
    data => { data.services[0].public_location = 'Unexpected field'; },
    data => { data.services[0].program[0].contact = 'Private contact'; },
    data => { data.services[0].program[0].public_assignment = true; },
    data => { data.songs[0].notes = 'Private song notes'; },
    data => { data.songs[0].key = 'D'; }
  ];
  for (const mutate of variants) {
    const data = publicData(); mutate(data);
    await assert.rejects(access.publicPlanner({ async rpc() { return { data, error: null }; } }, church));
  }
});

test('malformed public responses fail closed and projection errors remain visible to callers', async () => {
  for (const data of [null, {}, { services: [], songs: null }, { services: {}, songs: [] }, { services: [null], songs: [] }]) {
    await assert.rejects(access.publicPlanner({ async rpc() { return { data, error: null }; } }, church));
  }
  const denied = { message: 'Public migration is missing', code: '42883' };
  await assert.rejects(access.publicPlanner({ async rpc() { return { data: null, error: denied }; } }, church), error => error === denied);
  assert.deepEqual(plain(await access.publicPlanner({ async rpc() { return { data: { services: [], songs: [] }, error: null }; } }, church)), { services: [], songs: [] });
});

function fakeClient({ member = membership(), currentUser = user, plannerError = null, writeResult = { data: { version: 8 }, error: null } } = {}) {
  const calls = [];
  const planner = { data: { services: [{ id: 'existing-service', title: 'Existing service', date: '2026-10-18', time: '09:00', program: [] }], team: [], songs: [] }, version: 7 };
  const query = {
    select(value) { calls.push(['select', value]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    update(value) { calls.push(['update', plain(value)]); return this; },
    async single() { calls.push(['single']); return { data: plannerError ? null : planner, error: plannerError }; },
    async maybeSingle() { return writeResult; }
  };
  return {
    calls, planner,
    auth: { async getUser() { calls.push(['getUser']); return { data: { user: currentUser }, error: null }; } },
    async rpc(name, args) { calls.push(['rpc', name, plain(args)]); return { data: member, error: null }; },
    from(table) { calls.push(['from', table]); return query; }
  };
}

test('approved church roles have distinct read/edit/admin permissions', () => {
  for (const [role, edit, admin] of [['viewer', false, false], ['editor', true, false], ['admin', true, true]]) {
    assert.deepEqual(plain(access.permissions(membership('approved', role))), { read: true, edit, admin });
  }
  for (const status of ['pending', 'rejected', 'revoked']) {
    assert.deepEqual(plain(access.permissions(membership(status, 'admin'))), { read: false, edit: false, admin: false });
  }
  assert.deepEqual(plain(access.permissions(membership('approved', 'owner'))), { read: false, edit: false, admin: false });
});

test('pending, rejected, revoked and signed-out users never request planner data', async () => {
  for (const status of ['pending', 'rejected', 'revoked']) {
    const client = fakeClient({ member: membership(status) });
    const result = await access.refresh(client, church);
    assert.equal(result.member.status, status);
    assert.equal(result.planner, null);
    assert.equal(client.calls.some(c => c[0] === 'from'), false);
  }
  const client = fakeClient({ currentUser: null });
  assert.deepEqual(plain(await access.refresh(client, church)), { user: null, member: null, planner: null });
  assert.deepEqual(client.calls, [['getUser']]);
});

test('email verification precedes membership requests and planner reads', async () => {
  const client = fakeClient({ currentUser: { ...user, email_confirmed_at: null } });
  await assert.rejects(access.refresh(client, church), /Verify your email/);
  assert.deepEqual(client.calls, [['getUser']]);
});

test('verified Google profile requests access without transmitting a privileged role', async () => {
  const client = fakeClient({ member: membership('pending') });
  await access.request(client, church, { ...user, user_metadata: { name: 'Google Member', role: 'admin' } });
  assert.deepEqual(client.calls, [['rpc', 'gather_request_access', { p_church_id: church, p_full_name: 'Google Member' }]]);
});

test('repeated access requests preserve the approved membership returned by the backend', async () => {
  const member = membership('approved', 'editor');
  const client = fakeClient({ member });
  assert.equal(await access.request(client, church, user), member);
  assert.equal(await access.request(client, church, user), member);
  assert.equal(client.calls.filter(c => c[0] === 'rpc').length, 2);
  assert.equal(client.calls.some(c => c[0] === 'update'), false);
});

test('approval makes stored planner records available without replacing them', async () => {
  const client = fakeClient();
  const pending = membership('pending');
  let current = pending;
  client.rpc = async () => ({ data: current, error: null });
  assert.equal((await access.refresh(client, church)).planner, null);
  current = membership('approved');
  const loaded = await access.refresh(client, church);
  assert.equal(loaded.planner, client.planner);
  assert.equal(loaded.planner.data.services[0].id, 'existing-service');
  assert.equal(client.calls.filter(c => c[0] === 'from').length, 1);
});

test('mismatched church/user or malformed membership responses fail before planner reads', async () => {
  for (const member of [
    { ...membership(), church_id: 'church-b' },
    { ...membership(), user_id: 'user-b' },
    membership('unexpected'),
    membership('approved', 'owner'),
    null
  ]) {
    const client = fakeClient({ member });
    await assert.rejects(access.refresh(client, church), /membership response is invalid/);
    assert.equal(client.calls.some(c => c[0] === 'from'), false);
  }
});

test('revocation on recheck discards access, including an account previously approved', async () => {
  const client = fakeClient();
  assert.ok((await access.refresh(client, church)).planner);
  client.rpc = async () => ({ data: membership('revoked'), error: null });
  assert.equal((await access.refresh(client, church)).planner, null);
  assert.equal(client.calls.filter(c => c[0] === 'from').length, 1);
});

test('save uses church and exact version conditions, leaving stale writes rejected', async () => {
  const client = fakeClient();
  const snapshot = { services: [], team: [], songs: [] };
  assert.equal(await access.save(client, church, snapshot, 7), 8);
  assert.deepEqual(client.calls, [
    ['from', 'gather_planners'], ['update', { data: snapshot, version: 8 }],
    ['eq', 'id', church], ['eq', 'version', 7], ['select', 'version']
  ]);
  await assert.rejects(access.save(fakeClient({ writeResult: { data: null, error: null } }), church, snapshot, 7), /planner changed or your access changed/);
});

test('direct write and admin RPC backend denials are surfaced to the client', async () => {
  const denied = { message: 'permission denied', code: '42501' };
  await assert.rejects(access.save(fakeClient({ writeResult: { data: null, error: denied } }), church, { services: [], team: [], songs: [] }, 7), error => error === denied);
  const client = fakeClient();
  client.rpc = async () => ({ data: null, error: denied });
  await assert.rejects(access.list(client, church), error => error === denied);
  await assert.rejects(access.review(client, church, membership(), 'approve'), error => error === denied);
});

test('member listing verifies every row belongs to the selected church', async () => {
  const client = fakeClient({ member: [membership('pending')] });
  assert.equal((await access.list(client, church))[0].status, 'pending');
  client.rpc = async () => ({ data: [{ ...membership(), church_id: 'church-b' }], error: null });
  await assert.rejects(access.list(client, church), /could not be verified/);
});

test('review defaults to viewer, supplies stale-review token, and rejects cross-church targets', async () => {
  const client = fakeClient();
  const member = membership('pending');
  await access.review(client, church, member, 'approve');
  assert.deepEqual(client.calls[0], ['rpc', 'gather_review_member', {
    p_church_id: church, p_user_id: member.user_id, p_action: 'approve',
    p_role: 'viewer', p_expected_updated_at: member.updated_at
  }]);
  await assert.rejects(access.review(client, church, { ...member, church_id: 'church-b' }, 'approve'), /different church/);
  await assert.rejects(access.review(client, church, { ...member, updated_at: null }, 'approve'), /Reload/);
  assert.equal(client.calls.length, 1);
});

test('a malformed successful write response cannot be reported as a confirmed save', async () => {
  for (const data of [{}, { version: '8' }, { version: 7 }, { version: 9 }]) {
    const client = fakeClient({ writeResult: { data, error: null } });
    await assert.rejects(access.save(client, church, { services: [], team: [], songs: [] }, 7), /could not be confirmed/);
  }
});

test('malformed membership rows and unsafe attribute identifiers fail before rendering or planner reads', async () => {
  for (const member of [null, [], { ...membership(), user_id: '\"><img src=x>' }, { ...membership(), full_name: {} }]) {
    const client = fakeClient({ member: [member] });
    await assert.rejects(access.list(client, church), /could not be verified/);
  }
  const client = fakeClient({ member: [membership(), membership()] });
  await assert.rejects(access.refresh(client, church), /response is invalid/);
  assert.equal(client.calls.some(call => call[0] === 'from'), false);
});

test('a private refresh cannot adopt a different identity before that session is verified', async () => {
  const client = fakeClient();
  await assert.rejects(access.refresh(client, church, 'previous-account'), error => error.code === 'GATHER_SESSION_CHANGED');
  assert.deepEqual(client.calls, [['getUser']]);
});
