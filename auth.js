/* Gather authentication. Only the public Supabase URL and publishable key belong here. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const RECOVERY_KEY = 'gather-password-recovery';
    const labels = { signin: 'Sign in', register: 'Create account', reset: 'Send reset link', recovery: 'Save new password' };
    let client = null, callbacks = {}, mode = 'signin', busy = false, ready = false;
    let user = null, recovery = false, locallySignedOut = false, lifecycle = 0, eventTimer = null;
    let subscription = null, retryAction = null, startPromise = null, suppressSignedOutMessage = false;

    function storedRecovery() {
        try { return window.sessionStorage.getItem(RECOVERY_KEY) || ''; } catch { return ''; }
    }
    function rememberRecovery(id = '') {
        try { id ? window.sessionStorage.setItem(RECOVERY_KEY, id) : window.sessionStorage.removeItem(RECOVERY_KEY); } catch { /* Private browsing may disable storage. */ }
    }
    function status(message = '', kind = 'info') {
        $('auth-status').textContent = message;
        $('auth-status').dataset.kind = kind;
        $('auth-status').setAttribute('role', kind === 'error' ? 'alert' : 'status');
    }
    function clearPasswords() {
        $('auth-password').value = '';
        $('auth-confirm').value = '';
    }
    function clearForm() {
        $('auth-form').reset();
        clearPasswords();
    }
    function controls() {
        document.querySelectorAll('[data-auth-control]').forEach(element => { element.disabled = busy || !ready; });
        $('auth-name').disabled = busy || !ready || mode !== 'register';
        $('auth-email').disabled = busy || !ready || mode === 'recovery';
        $('auth-password').disabled = busy || !ready || mode === 'reset';
        $('auth-confirm').disabled = busy || !ready || !['register', 'recovery'].includes(mode);
        $('auth-panel').setAttribute('aria-busy', String(busy));
        $('auth-submit').textContent = labels[mode];
    }
    function setBusy(value, label = '') {
        busy = value;
        controls();
        if (value && label) $('auth-submit').textContent = label;
    }
    function show(nextMode = 'signin', message = '') {
        if (!labels[nextMode]) nextMode = 'signin';
        // A recovery session must stay on the password screen until completed or cancelled.
        if (recovery && nextMode !== 'recovery') nextMode = 'recovery';
        if (mode !== nextMode) clearPasswords();
        mode = nextMode;
        $('auth-screen').hidden = false;
        document.body.classList.add('auth-open');
        $('workspace-sidebar').inert = true;
        $('workspace-main').inert = true;
        const titles = { signin: 'Welcome back.', register: 'Make room for meaningful moments.', reset: 'Let’s get you back in.', recovery: 'Choose a new password.' };
        const descriptions = {
            signin: 'Sign in to your church’s ministry workspace.',
            register: 'Create your account. Your church admin will approve access after you verify your email.',
            reset: 'We’ll email you a secure link to reset your password.',
            recovery: 'Set a new password below. You’ll sign in again when it’s saved.'
        };
        $('auth-title').textContent = titles[mode];
        $('auth-description').textContent = descriptions[mode];
        const accountMode = mode === 'signin' || mode === 'register';
        $('auth-tabs').hidden = !accountMode;
        $('auth-google').hidden = !accountMode;
        $('auth-divider').hidden = !accountMode;
        $('auth-name-field').hidden = mode !== 'register';
        $('auth-email-field').hidden = mode === 'recovery';
        $('auth-password-field').hidden = mode === 'reset';
        $('auth-confirm-field').hidden = !['register', 'recovery'].includes(mode);
        $('auth-password-help').hidden = !['register', 'recovery'].includes(mode);
        $('auth-forgot-wrap').hidden = mode !== 'signin';
        $('auth-back').hidden = accountMode;
        $('auth-back').textContent = mode === 'recovery' ? 'Cancel and sign out' : 'Back to sign in';
        $('close-auth').textContent = mode === 'recovery' ? 'Cancel recovery and view public schedules' : 'Back to public schedules';
        $('auth-access-note').hidden = !accountMode;
        $('auth-name').required = mode === 'register';
        $('auth-email').required = mode !== 'recovery';
        $('auth-password').required = mode !== 'reset';
        $('auth-password').minLength = mode === 'signin' ? 1 : 8;
        $('auth-password').autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
        $('auth-confirm').required = ['register', 'recovery'].includes(mode);
        document.querySelectorAll('[data-auth-mode]').forEach(tab => {
            const active = tab.dataset.authMode === mode;
            tab.setAttribute('aria-selected', String(active));
            tab.tabIndex = active ? 0 : -1;
        });
        $('auth-retry').hidden = !retryAction;
        status(message);
        controls();
    }
    function hide() {
        if (recovery) return;
        $('auth-screen').hidden = true;
        document.body.classList.remove('auth-open');
        $('workspace-sidebar').inert = false;
        $('workspace-main').inert = false;
        clearPasswords();
    }
    async function dismiss() {
        // A reset link creates a privileged auth session: cancel it before public browsing.
        if (recovery) return logout();
        clearForm();
        status();
        hide();
        return true;
    }
    function redirectUrl() {
        const target = new URL(window.location.href);
        target.search = '';
        target.hash = '';
        return target.href;
    }
    function friendlyError(error) {
        const code = error?.code || '';
        const message = String(error?.message || 'Something went wrong. Please try again.');
        if (code === 'invalid_credentials' || /invalid login credentials/i.test(message)) return 'The email or password is incorrect. Please try again.';
        if (code === 'email_not_confirmed' || /email not confirmed/i.test(message)) return 'Verify your email using the link in your inbox, then sign in. Check your spam folder too.';
        if (/rate.?limit|too many|security purposes/i.test(message)) return 'Too many attempts. Please wait a moment, then try again.';
        if (/provider.*not.*enabled|unsupported provider/i.test(message)) return 'Google sign-in is not enabled yet. Your church admin can enable Google in Supabase Authentication.';
        if (/fetch|network|connection/i.test(message)) return 'We couldn’t connect. Check your internet connection and try again.';
        if (/expired|invalid.*token|session.*missing/i.test(message)) return 'This link or session has expired. Request a fresh password reset link and try again.';
        return message;
    }
    function emailValue(values) {
        const email = String(values.email || '').trim();
        if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Enter a valid email address.');
        return email;
    }
    function passwordValue(values, confirm = false) {
        const password = String(values.password || '');
        if (password.length < (confirm ? 8 : 1)) throw new Error(confirm ? 'Use a password with at least 8 characters.' : 'Enter your password.');
        if (password.length > 128) throw new Error('Use a password with no more than 128 characters.');
        if (confirm && password !== String(values.confirm_password || '')) throw new Error('Your passwords do not match.');
        return password;
    }
    async function action(work, label) {
        if (busy) return false;
        if (!client || !ready) { status('Gather is still connecting. Please try again in a moment.', 'error'); return false; }
        retryAction = null;
        $('auth-retry').hidden = true;
        status();
        setBusy(true, label);
        try { await work(); return true; }
        catch (error) { status(friendlyError(error), 'error'); return false; }
        finally { setBusy(false); }
    }
    function notifySignedOut() {
        user = null;
        clearForm();
        callbacks.onSignedOut?.();
    }
    function cancelPending() {
        lifecycle++;
        if (eventTimer !== null) { clearTimeout(eventTimer); eventTimer = null; }
    }
    async function receiveSession(session, event, ticket) {
        if (ticket !== lifecycle || locallySignedOut) return;
        if (!session) {
            recovery = false;
            rememberRecovery();
            notifySignedOut();
            hide();
            return;
        }
        try {
            const result = await client.auth.getUser();
            if (ticket !== lifecycle || locallySignedOut) return;
            if (result.error) throw result.error;
            const verified = result.data?.user;
            if (!verified || verified.id !== session.user?.id) throw new Error('Your session changed. Please sign in again.');
            if (!verified.email_confirmed_at) {
                locallySignedOut = true;
                recovery = false;
                rememberRecovery();
                notifySignedOut();
                show('signin', 'Verify your email using the link in your inbox, then sign in to request church access.');
                suppressSignedOutMessage = true;
                await client.auth.signOut({ scope: 'local' });
                suppressSignedOutMessage = false;
                return;
            }
            user = verified;
            if (recovery || storedRecovery() === verified.id) {
                recovery = true;
                rememberRecovery(verified.id);
                show('recovery');
                return;
            }
            // The caller checks approval before loading private data; public browsing stays available.
            clearPasswords();
            if (!$('auth-screen').hidden) status('Checking your church access…');
            await callbacks.onSession?.(verified, event);
        } catch (error) {
            if (ticket !== lifecycle || locallySignedOut) return;
            const wasAuthOpen = !$('auth-screen').hidden;
            user = null;
            callbacks.onSignedOut?.();
            if (recovery) {
                recovery = false;
                rememberRecovery();
                show('reset', 'This reset link could not be verified. Request a new link below.');
            } else {
                if (wasAuthOpen) show('signin');
                status(friendlyError(error), 'error');
            }
            retryAction = () => checkSession();
            $('auth-retry').hidden = false;
            callbacks.onError?.(error);
        }
    }
    function scheduleSession(session, event = 'SIGNED_IN') {
        cancelPending();
        const ticket = lifecycle;
        // Supabase can hold an auth lock while delivering events. Never await its API inside that callback.
        eventTimer = setTimeout(() => { eventTimer = null; void receiveSession(session, event, ticket); }, 0);
    }
    function authEvent(event, session) {
        if (event === 'SIGNED_OUT') {
            cancelPending();
            locallySignedOut = true;
            recovery = false;
            rememberRecovery();
            notifySignedOut();
            if (!suppressSignedOutMessage) hide();
            return;
        }
        if (event === 'PASSWORD_RECOVERY') {
            recovery = true;
            locallySignedOut = false;
            rememberRecovery(session?.user?.id || 'pending');
            callbacks.onSignedOut?.();
            show('recovery');
        }
        if (user && session?.user?.id && session.user.id !== user.id) {
            user = null;
            callbacks.onSignedOut?.();
            show('signin', 'Verifying your new session…');
        }
        if (['INITIAL_SESSION', 'SIGNED_IN', 'PASSWORD_RECOVERY', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) && !locallySignedOut) scheduleSession(session, event);
    }
    async function checkSession() {
        if (!client || locallySignedOut) return false;
        const ticket = ++lifecycle;
        try {
            const { data, error } = await client.auth.getSession();
            if (error) throw error;
            await receiveSession(data.session, 'SESSION_RECHECK', ticket);
            return Boolean(user);
        } catch (error) {
            user = null;
            callbacks.onSignedOut?.();
            status(friendlyError(error), 'error');
            callbacks.onError?.(error);
            return false;
        }
    }
    async function signIn(values) {
        return action(async () => {
            const email = emailValue(values), password = passwordValue(values);
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (error) throw error;
            locallySignedOut = false;
            clearPasswords();
            scheduleSession(data.session, 'SIGNED_IN');
        }, 'Signing in…');
    }
    async function register(values) {
        return action(async () => {
            const fullName = String(values.full_name || '').trim();
            if (!fullName || fullName.length > 120) throw new Error('Enter your full name (up to 120 characters).');
            const email = emailValue(values), password = passwordValue(values, true);
            const { data, error } = await client.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: redirectUrl() } });
            if (error) throw error;
            clearForm();
            show('signin', 'Check your inbox to verify your email, then sign in. Your church access request will be sent after verified sign-in; admin approval is a separate step.');
            if (data.session) { locallySignedOut = false; scheduleSession(data.session, 'SIGNED_IN'); }
        }, 'Creating your account…');
    }
    async function requestPasswordReset(values) {
        return action(async () => {
            const email = emailValue(values);
            const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
            if (error) throw error;
            clearForm();
            status('If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.');
        }, 'Sending reset link…');
    }
    async function updatePassword(values) {
        return action(async () => {
            if (!recovery || !user) throw new Error('Open a valid password reset link first.');
            const password = passwordValue(values, true);
            const { error } = await client.auth.updateUser({ password });
            if (error) throw error;
            recovery = false;
            rememberRecovery();
            const signedOut = await logout();
            if (signedOut) show('signin', 'Your password has been updated. Sign in with your new password.');
        }, 'Saving your password…');
    }
    async function continueWithGoogle() {
        return action(async () => {
            const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
            if (error) throw error;
            if (!data?.url) throw new Error('Google sign-in could not start. Please try again.');
            clearPasswords();
            status('Opening Google’s secure sign-in page…');
        }, 'Opening Google…');
    }
    async function logout() {
        locallySignedOut = true;
        recovery = false;
        rememberRecovery();
        cancelPending();
        notifySignedOut();
        retryAction = null;
        hide();
        try {
            if (client) {
                const { error } = await client.auth.signOut({ scope: 'local' });
                if (error) throw error;
            }
            hide();
            return true;
        } catch (error) {
            show('signin');
            status('Private church data is hidden. We couldn’t clear the saved session: ' + friendlyError(error) + ' Retry logging out before closing this browser.', 'error');
            retryAction = logout;
            $('auth-retry').textContent = 'Retry log out';
            $('auth-retry').hidden = false;
            callbacks.onError?.(error);
            return false;
        }
    }
    function cleanCallbackUrl() {
        const url = new URL(window.location.href);
        const authKeys = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'expires_in', 'expires_at', 'token_type', 'code', 'error', 'error_code', 'error_description'];
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (authKeys.some(key => fragment.has(key))) url.hash = '';
        authKeys.forEach(key => url.searchParams.delete(key));
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    async function loadSupabase() {
        if (window.supabase?.createClient) return;
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
            script.onload = resolve;
            script.onerror = () => { script.remove(); reject(new Error('Could not load Supabase. Check your connection and try again.')); };
            document.head.append(script);
        });
    }
    async function start(options) {
        callbacks = options;
        if (startPromise) return startPromise;
        startPromise = (async () => {
            const fragment = new URLSearchParams(window.location.hash.slice(1));
            const query = new URLSearchParams(window.location.search);
            const callbackError = fragment.get('error_description') || query.get('error_description') || fragment.get('error') || query.get('error');
            recovery = fragment.get('type') === 'recovery';
            if (recovery) rememberRecovery('pending');
            if (recovery) show('recovery', 'Connecting securely…');
            else if (callbackError) show('signin', 'Connecting securely…');
            else if (!$('auth-screen').hidden) status('Connecting securely…');
            setBusy(true, 'Connecting…');
            try {
                await loadSupabase();
                client = window.supabase.createClient(options.url, options.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
                callbacks.onReady?.(client);
                subscription?.unsubscribe();
                subscription = client.auth.onAuthStateChange(authEvent).data.subscription;
                const { data, error } = await client.auth.getSession();
                cleanCallbackUrl();
                ready = true;
                setBusy(false);
                if (error) throw error;
                if (callbackError) {
                    cancelPending();
                    locallySignedOut = true;
                    user = null;
                    recovery = false;
                    rememberRecovery();
                    callbacks.onSignedOut?.();
                    show('signin');
                    status('Sign-in could not be completed: ' + callbackError.slice(0, 240) + ' Please try again.', 'error');
                } else if (data.session) {
                    scheduleSession(data.session, recovery ? 'PASSWORD_RECOVERY' : 'INITIAL_SESSION');
                } else {
                    // getSession and INITIAL_SESSION describe the same startup result.
                    // Cancel the queued event so it cannot dismiss an expired-reset message.
                    cancelPending();
                    const wasRecovery = recovery;
                    recovery = false;
                    rememberRecovery();
                    notifySignedOut();
                    if (wasRecovery) show('reset', 'This reset link has expired. Request a new one below.');
                    else hide();
                }
                return client;
            } catch (error) {
                cancelPending();
                user = null;
                ready = Boolean(client);
                recovery = false;
                rememberRecovery();
                setBusy(false);
                callbacks.onSignedOut?.();
                status(friendlyError(error), 'error');
                retryAction = retry;
                $('auth-retry').textContent = 'Try again';
                $('auth-retry').hidden = false;
                callbacks.onError?.(error);
                return null;
            }
        })();
        return startPromise;
    }
    function retry() {
        // Reuse an in-flight connection attempt when visitors click retry twice.
        if (busy && startPromise) return startPromise;
        startPromise = null;
        return start(callbacks);
    }

    document.querySelectorAll('[data-auth-mode]').forEach(tab => {
        tab.addEventListener('click', () => { retryAction = null; show(tab.dataset.authMode); });
        tab.addEventListener('keydown', event => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || busy) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'signin' : event.key === 'End' ? 'register' : mode === 'signin' ? 'register' : 'signin';
            show(next);
            $('auth-tab-' + next).focus();
        });
    });
    $('auth-google').addEventListener('click', () => { void continueWithGoogle(); });
    $('auth-forgot').addEventListener('click', () => { retryAction = null; clearPasswords(); show('reset'); });
    $('auth-back').addEventListener('click', () => { recovery ? void logout() : show('signin'); });
    $('close-auth').addEventListener('click', () => { void dismiss(); });
    $('auth-retry').addEventListener('click', () => { if (retryAction) void retryAction(); });
    $('auth-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!$('auth-form').reportValidity()) return;
        const values = Object.fromEntries(new FormData($('auth-form')));
        void ({ signin: signIn, register, reset: requestPasswordReset, recovery: updatePassword }[mode])(values);
    });
    window.GatherAuth = { start, retry, logout, show, hide, dismiss, redirectUrl, signIn, register, requestPasswordReset, updatePassword, continueWithGoogle, checkSession, get currentUser() { return user; } };
})();
