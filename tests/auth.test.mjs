import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../auth.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const tags = new Map([...markup.matchAll(/<[^>]*\bid="([^"]+)"[^>]*>/g)].map(match => [match[1], match[0]]));
const ids = [...tags.keys()];
const verifiedUser = { id: 'member-a', email: 'member@example.test', email_confirmed_at: '2026-10-13T00:00:00Z', user_metadata: { full_name: 'Church Member' } };
const sessionFor = user => ({ user });
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
const plain = value => JSON.parse(JSON.stringify(value));

async function fixture({ session = null, currentUser = verifiedUser, href = 'http://localhost:3000/', failure = {}, deferred = {}, storedRecovery = '', storedSignout = false, configureAuth } = {}) {
  const calls = [], elements = new Map(), store = new Map();
  if (storedRecovery) store.set('gather-password-recovery', storedRecovery);
  if (storedSignout) store.set('gather-signout-pending', 'true');
  for (const id of ids) {
    const handlers = new Map(), attrs = new Map();
    elements.set(id, {
      id, value: '', hidden: /\shidden(?:\s|>)/.test(tags.get(id)), disabled: false, inert: false, textContent: '', dataset: {},
      autocomplete: tags.get(id).match(/\bautocomplete="([^"]+)"/)?.[1],
      setAttribute(key, value) { attrs.set(key, value); },
      getAttribute(key) { return attrs.get(key); },
      addEventListener(type, listener) { handlers.set(type, listener); },
      async dispatch(type, event = {}) { return handlers.get(type)?.({ preventDefault() {}, ...event }); },
      focus() {}, reportValidity() { return true; },
      reset() { for (const name of ['auth-name', 'auth-email', 'auth-password', 'auth-confirm']) elements.get(name).value = ''; }
    });
  }
  elements.get('auth-tab-signin').dataset.authMode = 'signin';
  elements.get('auth-tab-register').dataset.authMode = 'register';
  const classes = new Set();
  let listener;
  const auth = {
    onAuthStateChange(callback) { calls.push(['subscribe']); listener = callback; return { data: { subscription: { unsubscribe() {} } } }; },
    async getSession() { calls.push(['getSession']); return { data: { session }, error: failure.getSession || null }; },
    async getUser() { calls.push(['getUser']); return deferred.getUser ? await deferred.getUser : { data: { user: currentUser }, error: failure.getUser || null }; },
    async signInWithPassword(values) {
      calls.push(['signInWithPassword', plain(values)]);
      if (!failure.signIn) { session = sessionFor(currentUser); listener?.('SIGNED_IN', session); }
      return { data: { session }, error: failure.signIn || null };
    },
    async signUp(values) { calls.push(['signUp', plain(values)]); return deferred.signUp ? await deferred.signUp : { data: { user: currentUser, session: null }, error: failure.signUp || null }; },
    async resetPasswordForEmail(email, options) { calls.push(['resetPasswordForEmail', email, plain(options)]); return { error: failure.reset || null }; },
    async updateUser(values) { calls.push(['updateUser', plain(values)]); if (!failure.updateUser) listener?.('USER_UPDATED', session); return { data: { user: currentUser }, error: failure.updateUser || null }; },
    async signInWithOAuth(values) { calls.push(['signInWithOAuth', plain(values)]); return { data: { url: 'https://google.example.test/oauth' }, error: failure.google || null }; },
    async signOut(values) { calls.push(['signOut', plain(values)]); if (!failure.signOut) { session = null; listener?.('SIGNED_OUT', null); } return { error: failure.signOut || null }; }
  };
  const location = new URL(href);
  const window = {
    location,
    sessionStorage: { getItem: key => store.get(key) || null, setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
    history: { state: null, replaceState(state, title, target) { calls.push(['replaceState', target]); window.location = new URL(target, window.location); } },
    supabase: { createClient(url, key, options) { calls.push(['createClient', plain(options)]); return { auth }; } }
  };
  const document = {
    getElementById: id => elements.get(id),
    body: { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } },
    querySelectorAll(selector) {
      if (selector === '[data-auth-mode]') return [elements.get('auth-tab-signin'), elements.get('auth-tab-register')];
      if (selector === '[data-auth-control]') return [...elements.values()].filter(element => /\bdata-auth-control\b/.test(tags.get(element.id)));
      return [...elements.values()];
    }
  };
  const context = vm.createContext({ window, document, URL, URLSearchParams, setTimeout, clearTimeout });
  vm.runInContext(source, context);
  const api = window.GatherAuth;
  const emit = (event, nextSession) => {
    session = nextSession;
    if (nextSession?.user) currentUser = nextSession.user;
    listener(event, nextSession);
  };
  configureAuth?.(auth, emit);
  await api.start({
    url: 'https://test.supabase.co', key: 'public-test-key',
    onReady() { calls.push(['ready']); },
    onSession(user, event) { calls.push(['session', user.id, event]); },
    onSignedOut() { calls.push(['signedOut']); },
    onError(error) { calls.push(['error', error.message]); }
  });
  await flush();
  return { api, calls, elements, window, store, auth, classes, emit, flush };
}

test('signed-out startup leaves the public workspace visible and login and registration can be dismissed', async () => {
  const f = await fixture();
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
  assert.equal(f.classes.has('auth-open'), false);
  assert.equal(f.calls.some(call => call[0] === 'getUser'), false);
  f.api.show('signin');
  assert.equal(f.elements.get('auth-screen').hidden, false);
  assert.equal(f.elements.get('auth-name-field').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, true);
  await f.elements.get('close-auth').dispatch('click');
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
  f.api.show('register');
  assert.equal(f.elements.get('auth-screen').hidden, false);
  assert.equal(f.elements.get('auth-name-field').hidden, false);
  f.elements.get('auth-email').value = 'private@example.test';
  f.elements.get('auth-password').value = 'private-password';
  await f.api.dismiss();
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('auth-email').value, '');
  assert.equal(f.elements.get('auth-password').value, '');
});

test('startup session errors report an error without blocking public browsing', async () => {
  const f = await fixture({ failure: { getSession: { message: 'Network connection failed' } } });
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
  assert.ok(f.calls.some(call => call[0] === 'error'));
});

test('public retry can recover a failed startup while keeping authentication optional', async () => {
  const failure = { getSession: { message: 'Network connection failed' } };
  const f = await fixture({ failure });
  delete failure.getSession;
  await f.api.retry();
  await flush();
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
  assert.equal(f.calls.filter(call => call[0] === 'getSession').length, 2);
  assert.equal(f.calls.filter(call => call[0] === 'createClient').length, 1);
  assert.equal(f.calls.filter(call => call[0] === 'subscribe').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
});

test('separate responsive auth modes configure name, confirmation and autocomplete fields', async () => {
  const f = await fixture();
  f.api.show('signin');
  assert.equal(f.elements.get('auth-name-field').hidden, true);
  assert.equal(f.elements.get('auth-password').autocomplete, 'current-password');
  f.api.show('register');
  assert.equal(f.elements.get('auth-name').required, true);
  assert.equal(f.elements.get('auth-confirm-field').hidden, false);
  assert.equal(f.elements.get('auth-password').autocomplete, 'new-password');
  assert.equal(f.elements.get('auth-tab-register').getAttribute('aria-selected'), 'true');
  f.api.show('reset');
  assert.equal(f.elements.get('auth-password-field').hidden, true);
  assert.equal(f.elements.get('auth-google').hidden, true);
});

test('registration validates full name, email, password length and matching confirmation before API calls', async () => {
  const f = await fixture();
  const valid = { full_name: 'Church Member', email: 'member@example.test', password: 'strong-pass', confirm_password: 'strong-pass' };
  for (const [values, message] of [
    [{ ...valid, full_name: '' }, /full name/],
    [{ ...valid, full_name: 'x'.repeat(121) }, /full name/],
    [{ ...valid, email: 'bad-email' }, /valid email/],
    [{ ...valid, password: 'short', confirm_password: 'short' }, /8 characters/],
    [{ ...valid, confirm_password: 'different-pass' }, /do not match/]
  ]) {
    assert.equal(await f.api.register(values), false);
    assert.match(f.elements.get('auth-status').textContent, message);
    assert.equal(f.elements.get('auth-status').getAttribute('role'), 'alert');
  }
  assert.equal(f.calls.some(call => call[0] === 'signUp'), false);
});

test('registration sends display name and confirmation redirect, with no session or approval before verification', async () => {
  const f = await fixture({ href: 'http://localhost:3000/?tracking=1#unused' });
  assert.equal(await f.api.register({ full_name: '  Church Member ', email: ' member@example.test ', password: 'strong-pass', confirm_password: 'strong-pass', role: 'admin' }), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'signUp')[1], {
    email: 'member@example.test', password: 'strong-pass',
    options: { data: { full_name: 'Church Member' }, emailRedirectTo: 'http://localhost:3000/' }
  });
  assert.match(f.elements.get('auth-status').textContent, /verify your email/);
  assert.match(f.elements.get('auth-status').textContent, /admin approval is a separate step/);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
});

test('registration loading disables controls and ignores duplicate submissions', async () => {
  let resolveSignUp;
  const f = await fixture({ deferred: { signUp: new Promise(resolve => { resolveSignUp = resolve; }) } });
  const values = { full_name: 'Member', email: 'member@example.test', password: 'strong-pass', confirm_password: 'strong-pass' };
  const first = f.api.register(values);
  assert.equal(f.elements.get('auth-submit').disabled, true);
  assert.equal(f.elements.get('auth-panel').getAttribute('aria-busy'), 'true');
  assert.equal(await f.api.register(values), false);
  resolveSignUp({ data: { session: null }, error: null });
  assert.equal(await first, true);
  assert.equal(f.elements.get('auth-submit').disabled, false);
  assert.equal(f.calls.filter(call => call[0] === 'signUp').length, 1);
});

test('verified sign-in is verified with getUser before notifying planner access', async () => {
  const f = await fixture();
  assert.equal(await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' }), true);
  await flush();
  assert.deepEqual(f.calls.find(call => call[0] === 'session'), ['session', verifiedUser.id, 'SIGNED_IN']);
  assert.equal(f.api.currentUser.id, verifiedUser.id);
  f.api.hide();
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
});

test('unverified sign-in is signed out locally and never notifies planner access', async () => {
  const f = await fixture({ currentUser: { ...verifiedUser, email_confirmed_at: null } });
  await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' });
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.api.currentUser, null);
  assert.match(f.elements.get('auth-status').textContent, /Verify your email/);
  assert.ok(f.calls.some(call => call[0] === 'signOut' && call[1].scope === 'local'));
});

test('invalid credentials and confirmation errors are readable and leave controls enabled', async () => {
  for (const [error, message] of [
    [{ code: 'invalid_credentials', message: 'Invalid login credentials' }, /email or password is incorrect/],
    [{ code: 'email_not_confirmed', message: 'Email not confirmed' }, /Verify your email/]
  ]) {
    const f = await fixture({ failure: { signIn: error } });
    assert.equal(await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' }), false);
    assert.match(f.elements.get('auth-status').textContent, message);
    assert.equal(f.elements.get('auth-submit').disabled, false);
  }
});

test('password reset uses the allowed return URL and a non-enumerating message', async () => {
  const f = await fixture({ href: 'https://gather.example.test/index.html?source=1#section' });
  f.api.show('reset');
  assert.equal(await f.api.requestPasswordReset({ email: 'member@example.test' }), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'resetPasswordForEmail'), ['resetPasswordForEmail', 'member@example.test', { redirectTo: 'https://gather.example.test/index.html' }]);
  assert.match(f.elements.get('auth-status').textContent, /If an account exists/);
});

test('password recovery events isolate the recovery screen from protected planner access', async () => {
  const f = await fixture();
  f.emit('PASSWORD_RECOVERY', sessionFor(verifiedUser));
  await flush();
  assert.equal(f.elements.get('auth-submit').textContent, 'Save new password');
  assert.equal(f.elements.get('auth-email-field').hidden, true);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  f.api.show('signin');
  f.api.hide();
  assert.equal(f.elements.get('auth-screen').hidden, false);
  assert.equal(await f.api.updatePassword({ password: 'new-password', confirm_password: 'different' }), false);
  assert.equal(await f.api.updatePassword({ password: 'new-password', confirm_password: 'new-password' }), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'updateUser'), ['updateUser', { password: 'new-password' }]);
  assert.equal(f.api.currentUser, null);
  assert.equal(f.store.has('gather-password-recovery'), false);
  assert.match(f.elements.get('auth-status').textContent, /password has been updated/);
});

test('recovery callback and refresh markers restore the password screen without loading church data', async () => {
  for (const options of [
    { href: 'http://localhost:3000/#access_token=redacted&refresh_token=redacted&type=recovery' },
    { storedRecovery: verifiedUser.id }
  ]) {
    const f = await fixture({ ...options, session: sessionFor(verifiedUser) });
    assert.equal(f.elements.get('auth-submit').textContent, 'Save new password');
    assert.equal(f.calls.some(call => call[0] === 'session'), false);
    assert.equal(f.store.get('gather-password-recovery'), verifiedUser.id);
    assert.equal(f.window.location.hash, '');
  }
});

test('expired password reset callbacks offer a fresh reset link', async () => {
  const f = await fixture({ href: 'http://localhost:3000/#type=recovery' });
  assert.equal(f.elements.get('auth-submit').textContent, 'Send reset link');
  assert.match(f.elements.get('auth-status').textContent, /expired/);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
});

test('Google authentication uses clean current-page redirect and handles provider setup errors', async () => {
  const f = await fixture({ href: 'http://localhost:3000/?q=tracking#foo' });
  assert.equal(await f.api.continueWithGoogle(), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'signInWithOAuth'), ['signInWithOAuth', { provider: 'google', options: { redirectTo: 'http://localhost:3000/' } }]);
  const failed = await fixture({ failure: { google: { message: 'Unsupported provider: provider is not enabled' } } });
  assert.equal(await failed.api.continueWithGoogle(), false);
  assert.match(failed.elements.get('auth-status').textContent, /Google sign-in is not enabled/);
});

test('Google callbacks and saved sessions are restored with URL detection and verified user lookup', async () => {
  const f = await fixture({ session: sessionFor(verifiedUser), href: 'http://localhost:3000/#access_token=redacted&refresh_token=redacted&provider_token=redacted&type=signup' });
  assert.equal(f.calls.filter(call => call[0] === 'session').length, 1);
  assert.equal(f.calls.some(call => call[0] === 'getUser'), true);
  assert.deepEqual(f.calls.find(call => call[0] === 'createClient')[1], { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
  assert.equal(f.window.location.hash, '');
  const restored = await fixture({ session: sessionFor(verifiedUser) });
  assert.equal(restored.api.currentUser.id, verifiedUser.id);
});

test('OAuth callback errors are sanitized from the address and shown as text', async () => {
  const f = await fixture({ href: 'http://localhost:3000/#error=access_denied&error_description=Access+was+cancelled' });
  assert.equal(f.window.location.hash, '');
  assert.match(f.elements.get('auth-status').textContent, /Access was cancelled/);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  f.emit('INITIAL_SESSION', sessionFor(verifiedUser));
  f.emit('TOKEN_REFRESHED', sessionFor(verifiedUser));
  await flush();
  f.api.hide();
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.elements.get('auth-screen').hidden, true);
});

test('auth events defer Supabase API work until after the callback returns', async () => {
  const f = await fixture();
  const count = f.calls.length;
  f.emit('SIGNED_IN', sessionFor(verifiedUser));
  assert.equal(f.calls.length, count);
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'session'), true);
});

test('logout clears passwords and protected workspace before network sign-out failure', async () => {
  const f = await fixture({ session: sessionFor(verifiedUser), failure: { signOut: { message: 'Network connection failed' } } });
  f.api.hide();
  f.elements.get('auth-password').value = 'private-password';
  assert.equal(await f.api.logout(), false);
  assert.equal(f.api.currentUser, null);
  assert.equal(f.elements.get('auth-password').value, '');
  assert.equal(f.elements.get('auth-screen').hidden, false);
  assert.equal(f.elements.get('workspace-main').inert, true);
  assert.match(f.elements.get('auth-status').textContent, /Private church data is hidden/);
  assert.equal(f.elements.get('auth-retry').hidden, false);
  await f.api.dismiss();
  assert.equal(f.elements.get('auth-screen').hidden, true);
  assert.equal(f.elements.get('workspace-main').inert, false);
});

test('logout invalidates a late verified-session response', async () => {
  let resolveUser;
  const f = await fixture({ deferred: { getUser: new Promise(resolve => { resolveUser = resolve; }) } });
  f.emit('SIGNED_IN', sessionFor(verifiedUser));
  await flush();
  await f.api.logout();
  resolveUser({ data: { user: verifiedUser }, error: null });
  await flush();
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.api.currentUser, null);
  assert.equal(f.elements.get('auth-screen').hidden, true);
});

test('successful logout returns to public browsing and cancelling recovery signs out the recovery session', async () => {
  const signedIn = await fixture({ session: sessionFor(verifiedUser) });
  signedIn.api.hide();
  assert.equal(await signedIn.api.logout(), true);
  assert.equal(signedIn.api.currentUser, null);
  assert.equal(signedIn.elements.get('auth-screen').hidden, true);
  assert.equal(signedIn.elements.get('workspace-main').inert, false);
  const recovering = await fixture({ session: sessionFor(verifiedUser), storedRecovery: verifiedUser.id });
  assert.equal(recovering.elements.get('auth-screen').hidden, false);
  assert.equal(await recovering.api.dismiss(), true);
  assert.equal(recovering.api.currentUser, null);
  assert.equal(recovering.store.has('gather-password-recovery'), false);
  assert.ok(recovering.calls.some(call => call[0] === 'signOut'));
  assert.equal(recovering.elements.get('auth-screen').hidden, true);
  assert.equal(recovering.elements.get('workspace-main').inert, false);
});

test('a session belonging to a different verified user is rejected', async () => {
  const f = await fixture({ session: sessionFor({ ...verifiedUser, id: 'other-user' }) });
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.api.currentUser, null);
  assert.match(f.elements.get('auth-status').textContent, /session changed/);
});

test('cross-tab logout permits a later verified cross-tab login', async () => {
  const f = await fixture({ session: sessionFor(verifiedUser) });
  f.emit('SIGNED_OUT', null);
  assert.equal(f.api.currentUser, null);
  const other = { ...verifiedUser, id: 'member-b' };
  f.emit('SIGNED_IN', sessionFor(other));
  await flush();
  assert.equal(f.api.currentUser.id, other.id);
  assert.equal(f.calls.filter(call => call[0] === 'session').at(-1)[1], other.id);
});

test('repeated logout shares one request and blocks sign-in until that request finishes', async () => {
  const f = await fixture({ session: sessionFor(verifiedUser) });
  let finishLogout;
  f.auth.signOut = async () => {
    f.calls.push(['delayedSignOut']);
    return new Promise(resolve => { finishLogout = resolve; });
  };
  const first = f.api.logout();
  const second = f.api.logout();
  assert.equal(first, second);
  assert.equal(f.api.currentUser, null);
  assert.equal(await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' }), false);
  assert.equal(f.calls.some(call => call[0] === 'signInWithPassword'), false);
  f.emit('SIGNED_OUT', null);
  finishLogout({ error: null });
  assert.equal(await first, true);
  assert.equal(f.calls.filter(call => call[0] === 'delayedSignOut').length, 1);
  assert.equal(await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' }), true);
  await flush();
  assert.equal(f.api.currentUser.id, verifiedUser.id);
});

test('a late failed session recheck cannot clear a newer account', async () => {
  const f = await fixture({ session: sessionFor(verifiedUser) });
  let finishCheck;
  f.auth.getSession = () => new Promise(resolve => { finishCheck = resolve; });
  const oldCheck = f.api.checkSession();
  const other = { ...verifiedUser, id: 'member-b' };
  f.emit('SIGNED_IN', sessionFor(other));
  await flush();
  const signoutCount = f.calls.filter(call => call[0] === 'signedOut').length;
  finishCheck({ data: { session: null }, error: { message: 'Network connection failed' } });
  assert.equal(await oldCheck, false);
  assert.equal(f.api.currentUser.id, other.id);
  assert.equal(f.calls.filter(call => call[0] === 'signedOut').length, signoutCount);
});

test('a newer auth event takes precedence over a stale signed-out startup snapshot', async () => {
  const f = await fixture({ configureAuth(auth, emit) {
    auth.getSession = async () => {
      emit('SIGNED_IN', sessionFor(verifiedUser));
      return { data: { session: null }, error: null };
    };
  } });
  assert.equal(f.api.currentUser.id, verifiedUser.id);
  assert.equal(f.calls.filter(call => call[0] === 'session').length, 1);
});

test('recovery verification failures and retries keep the saved recovery session out of private access', async () => {
  const failure = { getUser: { message: 'Network connection failed' } };
  const f = await fixture({ session: sessionFor(verifiedUser), storedRecovery: verifiedUser.id, failure });
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.store.get('gather-password-recovery'), verifiedUser.id);
  assert.match(f.elements.get('auth-status').textContent, /Retry or cancel recovery/);
  delete failure.getUser;
  await f.api.checkSession();
  assert.equal(f.elements.get('auth-submit').textContent, 'Save new password');
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.store.get('gather-password-recovery'), verifiedUser.id);
});

test('failed recovery cancellation remains suppressed after refresh until explicit logout succeeds', async () => {
  const failure = { signOut: { message: 'Network connection failed' } };
  const f = await fixture({ session: sessionFor(verifiedUser), storedRecovery: verifiedUser.id, failure });
  assert.equal(await f.api.dismiss(), false);
  assert.equal(f.store.get('gather-password-recovery'), verifiedUser.id);
  assert.equal(f.store.get('gather-signout-pending'), 'true');
  const refreshed = await fixture({ session: sessionFor(verifiedUser), storedRecovery: verifiedUser.id, storedSignout: true });
  assert.equal(refreshed.api.currentUser, null);
  assert.equal(refreshed.calls.some(call => call[0] === 'session'), false);
  assert.equal(refreshed.elements.get('auth-screen').hidden, true);
  assert.equal(await refreshed.api.logout(), true);
  assert.equal(refreshed.store.has('gather-password-recovery'), false);
  assert.equal(refreshed.store.has('gather-signout-pending'), false);
});

test('failed logout followed by explicit sign-in cannot restore its old logout error on retry', async () => {
  const failure = { signOut: { message: 'Network connection failed' } };
  const f = await fixture({ session: sessionFor(verifiedUser), failure });
  assert.equal(await f.api.logout(), false);
  assert.equal(await f.api.signIn({ email: 'member@example.test', password: 'strong-pass' }), true);
  await flush();
  assert.equal(f.api.currentUser.id, verifiedUser.id);
  assert.equal(f.store.has('gather-signout-pending'), false);
  assert.equal(f.elements.get('auth-retry').hidden, true);
});

test('logout during an unfinished password login suppresses its late event and clears its saved session', async () => {
  const f = await fixture();
  let finishSignin;
  f.auth.signInWithPassword = async () => {
    await new Promise(resolve => { finishSignin = resolve; });
    f.emit('SIGNED_IN', sessionFor(verifiedUser));
    return { data: { session: sessionFor(verifiedUser) }, error: null };
  };
  const signin = f.api.signIn({ email: 'member@example.test', password: 'strong-pass' });
  const logout = f.api.logout();
  assert.equal(f.calls.some(call => call[0] === 'signOut'), false);
  finishSignin();
  assert.equal(await signin, false);
  assert.equal(await logout, true);
  await flush();
  assert.equal(f.api.currentUser, null);
  assert.equal(f.calls.some(call => call[0] === 'session'), false);
  assert.equal(f.calls.filter(call => call[0] === 'signOut').length, 1);
  assert.equal(f.elements.get('auth-screen').hidden, true);
  await f.api.checkSession();
  assert.equal(f.api.currentUser, null);
});
