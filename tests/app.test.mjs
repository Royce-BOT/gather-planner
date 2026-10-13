import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const verifiedUser = { id: 'existing-member', email: 'member@example.test', email_confirmed_at: '2026-10-13T00:00:00Z', user_metadata: { full_name: 'Existing Member' } };
const plannerData = () => ({
  services: [{ id: 'service-1', title: 'Existing Service', date: '2026-10-17', time: '09:00', location: 'Sanctuary', theme: 'Gather together', notes: 'Existing notes', program: [{ title: 'Opening prayer', person: 'Volunteer One', minutes: 5 }, { title: 'Reading', person: 'Volunteer Two', minutes: 7 }] }],
  team: [{ id: 'team-1', name: 'Volunteer One', role: 'Leader', ministry: 'Worship', contact: '' }],
  songs: [{ id: 'song-1', title: 'Existing Song', key: 'D', number: '100', notes: '' }]
});
const publicData = () => ({
  services: [{ id: 'public-service', title: 'Public Sunday Worship', date: '2026-10-18', time: '09:00', location: 'Public sanctuary entrance', theme: 'Hope', program: [{ title: 'Welcome', minutes: 5 }, { title: 'Public reading', minutes: 7, person: 'Published Reader' }] }],
  songs: [{ id: 'public-song', title: 'Public Song' }]
});

async function fixture({ status = 'approved', role = 'editor', deferredRead = null, deferredWrite = null, deferredPublic = null, publicError = null, projection = publicData(), conflict = false, writeError = null } = {}) {
  const calls = [], elements = new Map(), handlers = new Map();
  function element(selector) {
    if (!elements.has(selector)) elements.set(selector, {
      id: selector.slice(1), textContent: '', innerHTML: '', value: '', open: false, hidden: false, disabled: false, dataset: {}, style: {},
      classList: { toggle() {} },
      close() { this.open = false; }, showModal() { this.open = true; },
      replaceChildren() { this.innerHTML = ''; }, insertAdjacentHTML(where, content) { this.innerHTML += content; }
    });
    return elements.get(selector);
  }
  let callbacks, currentStatus = status, currentRole = role, saved = plannerData(), version = 4;
  let authUser = verifiedUser, nextUserResponse = null, nextReadResponse = null, nextPublicResponse = null;
  const query = {
    select() { return this; }, eq(column, value) { calls.push(['eq', column, value]); return this; },
    update(value) { this.payload = value; calls.push(['write', structuredClone(value)]); return this; },
    async single() {
      calls.push(['read']);
      if (nextReadResponse) { const response = nextReadResponse; nextReadResponse = null; return await response; }
      return deferredRead ? await deferredRead : { data: { data: structuredClone(saved), version }, error: null };
    },
    async maybeSingle() {
      if (deferredWrite) return await deferredWrite;
      if (conflict) return { data: null, error: null };
      if (writeError) return { data: null, error: writeError };
      saved = structuredClone(this.payload.data); version = this.payload.version;
      return { data: { version }, error: null };
    }
  };
  const client = {
    auth: { async getUser() { if (nextUserResponse) { const result = nextUserResponse; nextUserResponse = null; return await result; } return { data: { user: authUser }, error: null }; } },
    async rpc(name, args) {
      if (name === 'gather_public_planner') {
        calls.push(['public-read', args.p_church_id]);
        if (nextPublicResponse) { const response = nextPublicResponse; nextPublicResponse = null; return await response; }
        return deferredPublic ? await deferredPublic : { data: structuredClone(projection), error: publicError };
      }
      calls.push(['request']);
      return { data: { church_id: args.p_church_id, user_id: authUser.id, status: currentStatus, role: currentRole, updated_at: '2026-10-13T00:00:00Z' }, error: null };
    },
    from(table) { calls.push(['from', table]); return query; }
  };
  const auth = {
    async start(options) { callbacks = options; options.onReady(client); },
    show(...args) { calls.push(['auth-show', ...args]); }, hide() { calls.push(['auth-hide']); },
    async logout() { callbacks.onSignedOut(); },
    async checkSession() { calls.push(['session-recheck']); }
  };
  const admin = { clear() { calls.push(['admin-clear']); }, mount(options) { calls.push(['admin-mount']); } };
  const document = {
    visibilityState: 'visible',
    querySelector: element,
    querySelectorAll: () => [],
    addEventListener(type, listener) { handlers.set(type, listener); },
    createElement() { return { click() { calls.push(['download']); } }; }
  };
  const context = vm.createContext({
    window: { GatherAuth: auth, GatherAdmin: admin, addEventListener() {}, print() { calls.push(['print']); } },
    GatherAuth: auth, GatherAdmin: admin, document, structuredClone,
    setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}, confirm() { calls.push(['confirm']); return true; },
    crypto: { randomUUID: () => 'new-record' }, Blob,
    URL: { createObjectURL() { calls.push(['blob']); return 'blob:backup'; }, revokeObjectURL() {} },
    FormData: class { constructor(form) { return Object.entries(form.values); } }
  });
  vm.runInContext(read('config.js'), context);
  vm.runInContext(read('planner.js'), context);
  context.GatherPlanner = context.window.GatherPlanner;
  vm.runInContext(read('render.js'), context);
  context.GatherView = context.window.GatherView;
  vm.runInContext(read('access.js'), context);
  context.GatherAccess = context.window.GatherAccess;
  vm.runInContext(read('app.js'), context);
  await flush();
  return {
    context, calls, elements, element, handlers,
    async signIn(user = verifiedUser) { authUser = user; await callbacks.onSession(user); },
    async logout() { await auth.logout(); },
    setMembership(status, role = currentRole) { currentStatus = status; currentRole = role; },
    setAuthUser(user) { authUser = user; },
    deferNextUser(response) { nextUserResponse = response; },
    deferNextRead(response) { nextReadResponse = response; },
    deferNextPublic(response) { nextPublicResponse = response; },
    run(expression) { return vm.runInContext(expression, context); },
    state() { return JSON.parse(vm.runInContext('JSON.stringify({cloudReady, publicReady, publicDb, canEdit, db, confirmed, member, view, selected, cloudVersion, saving})', context)); },
    async click(dataset) { handlers.get('click')({ target: { closest: () => ({ dataset, disabled: false }) } }); await flush(); }
  };
}

test('logged-out initial load immediately shows the public planner without private queries or forced login', async () => {
  const f = await fixture();
  assert.equal(f.state().publicReady, true);
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().canEdit, false);
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
  assert.equal(f.calls.some(c => ['read', 'from', 'request', 'auth-show'].includes(c[0])), false);
  assert.equal(f.element('#signin-cloud').hidden, false);
  assert.equal(f.element('#register-cloud').hidden, false);
  assert.equal(f.element('#admin-nav').hidden, true);
  assert.equal(f.element('#export').hidden, true);
  assert.equal(f.element('#import').disabled, true);
  assert.doesNotMatch(f.element('#content').innerHTML, /Existing notes|Volunteer One|Existing Service|data-add|data-delete|data-edit/);
  await f.click({ view: 'services' });
  await f.click({ open: 'public-service' });
  assert.match(f.element('#content').innerHTML, /Public sanctuary entrance|Public reading/);
  assert.match(f.element('#content').innerHTML, /Published Reader/);
  assert.doesNotMatch(f.element('#content').innerHTML, /Preparation notes|Existing notes|data-add|data-delete|data-edit/);
  await f.click({ view: 'songs' });
  assert.match(f.element('#content').innerHTML, /Public Song/);
  await f.click({ view: 'team' });
  assert.notEqual(f.state().view, 'team');
});

test('public loading and error states do not force authentication or expose private records', async () => {
  let resolvePublic;
  const f = await fixture({ deferredPublic: new Promise(resolve => { resolvePublic = resolve; }) });
  assert.equal(f.state().publicReady, false);
  assert.match(f.element('#content').innerHTML, /loading/i);
  assert.equal(f.calls.some(c => c[0] === 'auth-show'), false);
  resolvePublic({ data: publicData(), error: null });
  await flush();
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
  const failed = await fixture({ publicError: { message: 'Unable to fetch public schedules' } });
  assert.equal(failed.state().publicReady, false);
  assert.match(failed.element('#content').innerHTML, /Unable|unavailable|could not/i);
  assert.match(failed.element('#content').innerHTML, /retry|try again/i);
  assert.equal(failed.calls.some(c => ['read', 'auth-show'].includes(c[0])), false);
});

test('public header keeps separate sign-in and registration entry points', async () => {
  const f = await fixture();
  f.element('#signin-cloud').onclick();
  f.element('#register-cloud').onclick();
  assert.deepEqual(f.calls.filter(call => call[0] === 'auth-show'), [['auth-show', 'signin'], ['auth-show', 'register']]);
  assert.equal(f.state().publicReady, true);
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
});

test('invalid public responses fail without private fallback and public text is escaped', async () => {
  const leaking = publicData(); leaking.services[0].notes = 'Secret preparation notes';
  const denied = await fixture({ projection: leaking });
  assert.equal(denied.state().publicReady, false);
  assert.equal(denied.calls.some(call => ['from', 'read'].includes(call[0])), false);
  assert.doesNotMatch(denied.element('#content').innerHTML, /Secret preparation notes|Existing notes|Volunteer One/);
  const text = publicData(); text.services[0].title = '<img src=x onerror="steal()">';
  const escaped = await fixture({ projection: text });
  assert.match(escaped.element('#content').innerHTML, /&lt;img/);
  assert.doesNotMatch(escaped.element('#content').innerHTML, /<img/);
});

test('visitors cannot trigger private backup downloads, import reads, or writes through direct handlers', async () => {
  const f = await fixture();
  f.element('#export').onclick();
  const target = { value: 'private.json', files: [{ async text() { assert.fail('Visitors cannot read/import a private backup'); } }] };
  await f.element('#import').onchange({ target });
  await f.run('save()');
  assert.equal(target.value, '');
  assert.equal(f.calls.some(call => ['write', 'download', 'blob'].includes(call[0])), false);
  assert.equal(f.element('#import-label').hidden, true);
});

test('pending, rejected and revoked accounts browse public data with a nonblocking status and no private records', async () => {
  for (const status of ['pending', 'rejected', 'revoked']) {
    const f = await fixture({ status });
    await f.signIn();
    assert.equal(f.state().cloudReady, false);
    assert.deepEqual(f.state().db, { services: [], team: [], songs: [] });
    assert.equal(f.calls.some(c => c[0] === 'read'), false);
    assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
    assert.match(f.element('#access-notice').innerHTML, status === 'pending' ? /approval|pending/i : status === 'rejected' ? /declined|rejected/i : /revoked/i);
    assert.equal(f.state().publicReady, true);
    assert.equal(f.element('#admin-nav').hidden, true);
    assert.equal(f.element('#export').disabled, true);
    await f.run('save()');
    f.run('modal("services")');
    await f.click({ view: 'admin' });
    await f.click({ add: 'services' });
    await f.click({ delete: 'public-service', kind: 'services' });
    assert.equal(f.calls.some(c => ['write', 'admin-mount', 'download'].includes(c[0])), false);
    assert.equal(f.element('#modal').open, false);
    assert.doesNotMatch(f.element('#content').innerHTML, /Existing notes|Volunteer One|Existing Service/);
  }
});

test('approved roles retain existing planner, with admin navigation only for admins', async () => {
  for (const role of ['viewer', 'editor', 'admin']) {
    const f = await fixture({ role });
    await f.signIn();
    assert.equal(f.state().cloudReady, true);
    assert.equal(f.state().db.services[0].title, 'Existing Service');
    assert.match(f.element('#content').innerHTML, /Existing Service/);
    assert.equal(f.element('#admin-nav').hidden, role !== 'admin');
    assert.equal(f.element('#import').disabled, role === 'viewer');
    assert.equal(f.element('#export').disabled, false);
  }
});

test('viewer direct client save/modal calls and forged admin navigation cannot edit or list members', async () => {
  const f = await fixture({ role: 'viewer' });
  await f.signIn();
  await f.run('save()');
  f.run('modal("services")');
  await f.click({ view: 'admin' });
  assert.equal(f.calls.some(c => ['write', 'admin-mount'].includes(c[0])), false);
  assert.equal(f.element('#modal').open, false);
  assert.equal(f.state().view, 'overview');
});

test('approved editor cannot open admin workspace through a forged navigation event', async () => {
  const f = await fixture();
  await f.signIn();
  await f.click({ view: 'admin' });
  assert.equal(f.calls.some(c => c[0] === 'admin-mount'), false);
  assert.equal(f.state().view, 'overview');
});

test('approval recheck loads planner and revocation immediately clears protected state', async () => {
  const f = await fixture({ status: 'pending' });
  await f.signIn();
  f.setMembership('approved', 'editor');
  await f.run('refreshCloud()');
  assert.equal(f.state().cloudReady, true);
  f.run('modal("services", "service-1")');
  assert.equal(f.element('#modal').open, true);
  f.setMembership('revoked');
  await f.run('recheckAccess()');
  assert.equal(f.state().cloudReady, false);
  assert.deepEqual(f.state().db, { services: [], team: [], songs: [] });
  assert.equal(f.element('#modal').open, false);
  assert.equal(f.element('#fields').innerHTML, '');
  assert.doesNotMatch(f.element('#content').innerHTML, /Existing Service/);
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
});

test('logout clears planner, modal, backups, private admin handlers and navigation', async () => {
  const f = await fixture({ role: 'admin' });
  await f.signIn();
  f.run('modal("services", "service-1")');
  await f.logout();
  assert.deepEqual(f.state().db, { services: [], team: [], songs: [] });
  assert.deepEqual(f.state().confirmed, { services: [], team: [], songs: [] });
  assert.equal(f.state().member, null);
  assert.equal(f.state().selected, null);
  assert.equal(f.element('#content').onclick, null);
  assert.equal(f.element('#cloud-status').textContent, '');
  assert.equal(f.element('#admin-nav').hidden, true);
  assert.equal(f.element('#export').disabled, true);
  assert.equal(f.element('#modal').open, false);
  assert.doesNotMatch(f.element('#content').innerHTML, /Existing Service|Volunteer One/);
  assert.equal(f.state().publicReady, true);
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
  assert.equal(f.element('#signin-cloud').hidden, false);
  assert.equal(f.calls.some(c => c[0] === 'auth-show'), false);
});

test('late planner reads cannot revive protected content after logout', async () => {
  let resolveRead;
  const f = await fixture({ deferredRead: new Promise(resolve => { resolveRead = resolve; }) });
  const loading = f.signIn();
  await flush();
  await f.logout();
  resolveRead({ data: { data: plannerData(), version: 4 }, error: null });
  await loading;
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().db.services.length, 0);
  assert.doesNotMatch(f.element('#content').innerHTML, /Existing Service/);
  assert.match(f.element('#content').innerHTML, /Public Sunday Worship/);
});

test('late successful save cannot revive protected records after logout', async () => {
  let resolveWrite;
  const f = await fixture({ deferredWrite: new Promise(resolve => { resolveWrite = resolve; }) });
  await f.signIn();
  f.run('db.services[0].title = "Private edit"');
  const saving = f.run('save()');
  await flush();
  await f.logout();
  resolveWrite({ data: { version: 5 }, error: null });
  await saving;
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().db.services.length, 0);
  assert.equal(f.state().confirmed.services.length, 0);
  assert.equal(f.state().cloudVersion, 0);
});

test('late old save after a new sign-in reloads current data and re-enables editing', async () => {
  let resolveWrite;
  const f = await fixture({ deferredWrite: new Promise(resolve => { resolveWrite = resolve; }) });
  await f.signIn();
  f.run('db.services[0].title = "Old private edit"');
  const saving = f.run('save()');
  assert.equal(f.element('#refresh-cloud').disabled, true);
  await f.logout();
  await f.signIn();
  resolveWrite({ data: { version: 5 }, error: null });
  await saving;
  assert.equal(f.state().saving, false);
  assert.equal(f.state().canEdit, true);
  assert.equal(f.state().db.services[0].title, 'Existing Service');
  assert.equal(f.state().confirmed.services[0].title, 'Existing Service');
  assert.equal(f.element('#refresh-cloud').disabled, false);
  assert.equal(f.element('#import').disabled, false);
  assert.doesNotMatch(f.element('#content').innerHTML, /Old private edit/);
});

test('late signed-out recheck does not erase a newer signed-in session', async () => {
  let resolveUser;
  const f = await fixture();
  await f.signIn();
  f.deferNextUser(new Promise(resolve => { resolveUser = resolve; }));
  const rechecking = f.run('recheckAccess()');
  await f.logout();
  await f.signIn();
  resolveUser({ data: { user: null }, error: null });
  await rechecking;
  assert.equal(f.state().cloudReady, true);
  assert.match(f.element('#content').innerHTML, /Existing Service/);
});

test('account identity changes clear previous content before requesting membership', async () => {
  const f = await fixture();
  await f.signIn();
  const requests = f.calls.filter(c => c[0] === 'request').length;
  f.setAuthUser({ ...verifiedUser, id: 'different-member' });
  await f.run('recheckAccess()');
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().db.services.length, 0);
  assert.equal(f.calls.filter(c => c[0] === 'request').length, requests);
  assert.ok(f.calls.some(c => c[0] === 'session-recheck'));
});

test('stale saves retain server data and report the conflict instead of overwriting', async () => {
  const f = await fixture({ conflict: true });
  await f.signIn();
  f.run('db.services[0].title = "Stale edit"');
  await f.run('save()');
  assert.equal(f.state().db.services[0].title, 'Existing Service');
  assert.equal(f.state().cloudVersion, 4);
  assert.match(f.element('#toast').textContent, /Not saved/);
  assert.match(f.element('#toast').textContent, /planner changed/);
});

test('late backup import cannot restore planner state after logout', async () => {
  let resolveBackup;
  const f = await fixture();
  await f.signIn();
  const file = { text: () => new Promise(resolve => { resolveBackup = resolve; }) };
  const target = { files: [file], value: 'backup.json' };
  const importing = f.element('#import').onchange({ target });
  await f.logout();
  resolveBackup(JSON.stringify(plannerData()));
  await importing;
  assert.equal(f.state().db.services.length, 0);
  assert.equal(f.calls.some(c => c[0] === 'write'), false);
  assert.equal(target.value, '');
});

test('service program ordering, assigned volunteers, printing and backups stay available', async () => {
  const f = await fixture();
  await f.signIn();
  await f.click({ open: 'service-1' });
  assert.match(f.element('#content').innerHTML, /Volunteer One/);
  await f.click({ move: '1' });
  assert.equal(f.state().db.services[0].program[0].title, 'Reading');
  assert.equal(f.state().cloudVersion, 5);
  await f.click({ print: '' });
  f.element('#export').onclick();
  assert.ok(f.calls.some(c => c[0] === 'print'));
  assert.ok(f.calls.some(c => c[0] === 'download'));
});

test('volunteer and song forms save records without replacing existing planner data', async () => {
  const f = await fixture();
  await f.signIn();
  f.run('modal("team")');
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: { name: 'New Volunteer', role: 'Singer', ministry: 'Music', contact: '' } } });
  await flush();
  assert.equal(f.state().db.team.length, 2);
  f.run('modal("songs", "song-1")');
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: { title: 'Updated Song', key: 'E', number: '100', notes: 'Updated' } } });
  await flush();
  assert.equal(f.state().db.songs[0].title, 'Updated Song');
  assert.equal(f.state().db.services[0].title, 'Existing Service');
});

test('editors explicitly publish services, attendance locations, song titles and individual assignments', async () => {
  const f = await fixture();
  await f.signIn();
  assert.equal(f.state().db.services[0].is_public, undefined);
  assert.equal(f.state().db.services[0].public_location, undefined);
  assert.equal(f.state().db.services[0].program[0].public_assignment, undefined);
  f.run('modal("services", "service-1")');
  assert.match(f.element('#fields').innerHTML, /name="is_public" type="checkbox"/);
  assert.doesNotMatch(f.element('#fields').innerHTML, /name="is_public"[^>]*checked/);
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: {
    title: 'Existing Service', date: '2026-10-17', time: '09:00', theme: 'Gather together',
    location: 'Private planning room', public_location: 'Main entrance', notes: 'Existing notes', is_public: 'on'
  } } });
  await flush();
  assert.equal(f.state().db.services[0].is_public, true);
  assert.equal(f.state().db.services[0].location, 'Private planning room');
  assert.equal(f.state().db.services[0].public_location, 'Main entrance');
  assert.equal(f.state().db.services[0].program.length, 2);
  assert.equal(f.state().db.services[0].notes, 'Existing notes');
  await f.click({ open: 'service-1' });
  f.run('modal("item", null, 0)');
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: { title: 'Opening prayer', person: 'Volunteer One', minutes: '5', public_assignment: 'on' } } });
  await flush();
  assert.equal(f.state().db.services[0].program[0].public_assignment, true);
  assert.equal(f.state().db.services[0].program[1].public_assignment, undefined);
  f.run('modal("songs", "song-1")');
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: { title: 'Existing Song', key: 'D', number: '100', notes: '', is_public: 'on' } } });
  await flush();
  assert.equal(f.state().db.songs[0].is_public, true);
  assert.equal(f.state().db.team.length, 1);
  f.run('modal("songs", "song-1")');
  f.element('#form').onsubmit({ preventDefault() {}, target: { values: { title: 'Existing Song', key: 'D', number: '100', notes: '' } } });
  await flush();
  assert.equal(f.state().db.songs[0].is_public, false);
  assert.ok(f.calls.filter(call => call[0] === 'write').length >= 4);
});

test('private backups retain legacy records while publication and assignment flags require actual booleans', async () => {
  const f = await fixture();
  f.run('validatePlanner(' + JSON.stringify(plannerData()) + ')');
  for (const invalid of ['true', 'false', 1, null, {}]) {
    const service = plannerData(); service.services[0].is_public = invalid;
    assert.throws(() => f.run('validatePlanner(' + JSON.stringify(service) + ')'));
    const song = plannerData(); song.songs[0].is_public = invalid;
    assert.throws(() => f.run('validatePlanner(' + JSON.stringify(song) + ')'));
    const assignment = plannerData(); assignment.services[0].program[0].public_assignment = invalid;
    assert.throws(() => f.run('validatePlanner(' + JSON.stringify(assignment) + ')'));
  }
  for (const bool of [true, false]) {
    const valid = plannerData(); valid.services[0].is_public = bool; valid.songs[0].is_public = bool;
    valid.services[0].program[0].public_assignment = bool; valid.services[0].public_location = 'Public entrance';
    f.run('validatePlanner(' + JSON.stringify(valid) + ')');
  }
});

test('an invalid calendar draft remains open and never changes the saved planner', async () => {
  const f = await fixture(); await f.signIn();
  f.run('modal("services", "service-1")');
  await f.element('#form').onsubmit({ preventDefault() {}, target: { values: { title: 'Invalid date draft', date: '2026-02-30', time: '09:00' } } });
  assert.equal(f.element('#modal').open, true);
  assert.equal(f.state().db.services[0].title, 'Existing Service');
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  assert.match(f.element('#toast').textContent, /valid calendar date/);
});

test('offline writes restore confirmed records and never announce success', async () => {
  const f = await fixture({ writeError: new Error('Network unavailable') }); await f.signIn();
  f.run('db.services[0].title = "Offline draft"');
  assert.equal(await f.run('save()'), false);
  assert.equal(f.state().db.services[0].title, 'Existing Service');
  assert.equal(f.state().cloudVersion, 4);
  assert.equal(f.state().saving, false);
  assert.match(f.element('#toast').textContent, /Save not confirmed.*Network unavailable/);
  assert.doesNotMatch(f.element('#toast').textContent, /Saved to Supabase/);
});

test('repeated private refreshes share a read and preserve the current private program', async () => {
  const f = await fixture(); await f.signIn(); await f.click({ open: 'service-1' });
  let resolve;
  f.deferNextRead(new Promise(done => { resolve = done; }));
  const reads = f.calls.filter(call => call[0] === 'read').length;
  const first = f.run('refreshCloud()'); await flush();
  const second = f.run('refreshCloud()'); await flush();
  assert.equal(f.calls.filter(call => call[0] === 'read').length, reads + 1);
  resolve({ data: { data: plannerData(), version: 4 }, error: null });
  await Promise.all([first, second]);
  assert.equal(f.state().view, 'program');
  assert.equal(f.state().selected, 'service-1');
});

test('repeated public refreshes share a request without requiring authentication', async () => {
  const f = await fixture(); let resolve;
  f.deferNextPublic(new Promise(done => { resolve = done; }));
  const reads = f.calls.filter(call => call[0] === 'public-read').length;
  const first = f.run('refreshPublic()'), second = f.run('refreshPublic()');
  await flush();
  assert.equal(f.calls.filter(call => call[0] === 'public-read').length, reads + 1);
  resolve({ data: publicData(), error: null });
  await Promise.all([first, second]);
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().publicReady, true);
});

test('unsafe and oversized backups fail before confirmation or any database write', async () => {
  const f = await fixture(); await f.signIn();
  const unsafe = JSON.parse(JSON.stringify(plannerData()));
  unsafe.services[0].program[0] = JSON.parse('{"title":"Reading","minutes":5,"person":"Reader","__proto__":{"polluted":true}}');
  await f.element('#import').onchange({ target: { files: [{ text: async () => JSON.stringify(unsafe) }], value: 'unsafe.json' } });
  assert.match(f.element('#toast').textContent, /unsafe property/);
  await f.element('#import').onchange({ target: { files: [{ size: 11 * 1024 * 1024, text() { assert.fail('Oversized backup must not be read'); } }], value: 'large.json' } });
  assert.match(f.element('#toast').textContent, /10 MiB/);
  assert.equal(f.calls.some(call => call[0] === 'write'), false);
  assert.equal(f.calls.some(call => call[0] === 'confirm'), false);
});

test('private loading re-verifies a changed identity without fetching its protected data', async () => {
  const f = await fixture(); await f.signIn();
  const reads = f.calls.filter(call => call[0] === 'read').length;
  f.setAuthUser({ ...verifiedUser, id: 'different-account' });
  await f.run('refreshCloud()');
  assert.equal(f.state().cloudReady, false);
  assert.equal(f.state().db.services.length, 0);
  assert.equal(f.calls.filter(call => call[0] === 'read').length, reads);
  assert.ok(f.calls.some(call => call[0] === 'session-recheck'));
});
