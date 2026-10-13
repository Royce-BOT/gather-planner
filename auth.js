/* Gather authentication. Only the public Supabase URL and publishable key belong here. */
(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const RECOVERY_KEY = 'gather-password-recovery';
    const SIGNOUT_KEY = 'gather-signout-pending';
    const labels = { signin: 'Sign in', register: 'Create account', reset: 'Send reset link', recovery: 'Save new password' };
    let client = null, callbacks = {}, mode = 'signin', busy = false, ready = false;
    let user = null, recovery = false, locallySignedOut = false, lifecycle = 0, eventTimer = null;
    let subscription = null, retryAction = null, startPromise = null, logoutPromise = null, suppressSignedOutMessage = false;
    let actionPromise = null, actionRevision = 0;
    let sessionTimingBlocked = false, refreshPaused = false, managesRefreshVisibility = false;
    let refreshControl = Promise.resolve();
    const sessionTimingMessage = 'Your new sign-in session is already expired or expires too soon. Check that your device uses automatic date, time and time zone, then try again or start a fresh sign-in.';

    function storedRecovery() {
        try { return window.sessionStorage.getItem(RECOVERY_KEY) || ''; } catch { return ''; }
    }
    function rememberRecovery(id = '') {
        try { id ? window.sessionStorage.setItem(RECOVERY_KEY, id) : window.sessionStorage.removeItem(RECOVERY_KEY); } catch { /* Private browsing may disable storage. */ }
    }
    function pendingSignout(value) {
        try {
            if (value === undefined) return window.sessionStorage.getItem(SIGNOUT_KEY) === 'true';
            value ? window.sessionStorage.setItem(SIGNOUT_KEY, 'true') : window.sessionStorage.removeItem(SIGNOUT_KEY);
        } catch { /* Private browsing may disable storage. */ }
        return false;
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
        const locked = busy || Boolean(logoutPromise);
        document.querySelectorAll('[data-auth-control]').forEach(element => { element.disabled = locked || !ready; });
        $('auth-name').disabled = locked || !ready || mode !== 'register';
        $('auth-email').disabled = locked || !ready || mode === 'recovery';
        $('auth-password').disabled = locked || !ready || mode === 'reset';
        $('auth-confirm').disabled = locked || !ready || !['register', 'recovery'].includes(mode);
        $('auth-panel').setAttribute('aria-busy', String(locked));
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
        if (busy || logoutPromise) return false;
        if (!client || !ready) { status('Gather is still connecting. Please try again in a moment.', 'error'); return false; }
        retryAction = null;
        $('auth-retry').hidden = true;
        status();
        setBusy(true, label);
        const revision = actionRevision;
        actionPromise = (async () => {
            try { return (await work(() => revision === actionRevision)) !== false; }
            catch (error) { if (revision === actionRevision) status(friendlyError(error), 'error'); return false; }
            finally { actionPromise = null; setBusy(false); }
        })();
        return actionPromise;
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
    function unusableSessionTiming(session) {
        if (!Number.isFinite(session?.expires_at)) return false;
        const margin = Number.isFinite(session.expires_in) && session.expires_in > 0 ? Math.min(90, session.expires_in / 10) : 0;
        return session.expires_at <= Date.now() / 1000 + margin;
    }
    function syncRefresh() {
        // SDK start awaits an internal stop. Serialize our controls and use the latest desired state.
        refreshControl = refreshControl.catch(() => {}).then(() => refreshPaused || document.visibilityState === 'hidden'
            ? client.auth.stopAutoRefresh?.() : client.auth.startAutoRefresh?.());
        return refreshControl;
    }
    async function pauseRefresh() {
        refreshPaused = true;
        // These SDK methods take over its visibility handling. Keep resumed refresh foreground-only.
        if (!managesRefreshVisibility) {
            managesRefreshVisibility = true;
            document.addEventListener?.('visibilitychange', () => {
                if (refreshPaused || !client) return;
                syncRefresh().catch(() => { /* A later explicit session check can retry. */ });
            });
        }
        await syncRefresh();
    }
    async function resumeRefresh() {
        if (!refreshPaused) return;
        refreshPaused = false;
        await syncRefresh();
    }
    async function blockSessionTiming() {
        if (sessionTimingBlocked) return;
        sessionTimingBlocked = true;
        cancelPending();
        user = null;
        // Run outside the SDK event lock, and block reentrant refresh events before clearing private data.
        const paused = pauseRefresh().catch(() => {});
        callbacks.onSignedOut?.();
        show(recovery ? 'recovery' : 'signin');
        status(sessionTimingMessage, 'error');
        retryAction = () => checkSession(true);
        $('auth-retry').textContent = 'Check session again';
        $('auth-retry').hidden = false;
        callbacks.onError?.(new Error(sessionTimingMessage));
        await paused;
    }
    async function receiveSession(session, event, ticket, allowTimingResume = false) {
        if (ticket !== lifecycle || locallySignedOut) return;
        if (!session) {
            const wasRecovery = recovery;
            recovery = false;
            rememberRecovery();
            notifySignedOut();
            if (wasRecovery) show('reset', 'This reset link has expired. Request a new one below.');
            else hide();
            return;
        }
        try {
            if (event === 'TOKEN_REFRESHED' && unusableSessionTiming(session)) { await blockSessionTiming(); return; }
            if (sessionTimingBlocked) {
                if (!allowTimingResume) return;
                if (unusableSessionTiming(session)) { status(sessionTimingMessage, 'error'); return; }
                sessionTimingBlocked = false;
            }
            if (allowTimingResume && !unusableSessionTiming(session)) await resumeRefresh();
            if (ticket !== lifecycle || locallySignedOut) return;
            // Verify this event's token with Auth directly. getUser() without a token can
            // refresh locally "expired" sessions and recursively emit TOKEN_REFRESHED.
            const result = await client.auth.getUser(session.access_token);
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
                try { await client.auth.signOut({ scope: 'local' }); }
                finally { suppressSignedOutMessage = false; }
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
                // A network failure does not invalidate the saved recovery session.
                // Keep its marker until verification succeeds or sign-out completes.
                show('recovery');
                status('This reset session could not be verified. Retry or cancel recovery. ' + friendlyError(error), 'error');
            } else {
                if (wasAuthOpen) show('signin');
                status(friendlyError(error), 'error');
            }
            retryAction = () => checkSession();
            $('auth-retry').textContent = 'Try again';
            $('auth-retry').hidden = false;
            callbacks.onError?.(error);
        }
    }
    function scheduleSession(session, event = 'SIGNED_IN', allowTimingResume = false) {
        cancelPending();
        const ticket = lifecycle;
        // Supabase can hold an auth lock while delivering events. Never await its API inside that callback.
        eventTimer = setTimeout(() => { eventTimer = null; void receiveSession(session, event, ticket, allowTimingResume); }, 0);
    }
    function authEvent(event, session) {
        if (event === 'SIGNED_OUT') {
            cancelPending();
            // A natural expiry/cross-tab logout must permit a later SIGNED_IN.
            locallySignedOut = Boolean(logoutPromise) || pendingSignout();
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
        if (sessionTimingBlocked) return;
        if (user && session?.user?.id && session.user.id !== user.id) {
            user = null;
            callbacks.onSignedOut?.();
            show('signin', 'Verifying your new session…');
        }
        if (['INITIAL_SESSION', 'SIGNED_IN', 'PASSWORD_RECOVERY', 'TOKEN_REFRESHED', 'USER_UPDATED'].includes(event) && !locallySignedOut) scheduleSession(session, event);
    }
    async function checkSession(allowTimingResume = false) {
        if (!client || locallySignedOut) return false;
        if (sessionTimingBlocked && !allowTimingResume) return false;
        cancelPending();
        const ticket = lifecycle;
        try {
            const { data, error } = await client.auth.getSession();
            if (ticket !== lifecycle || locallySignedOut) return false;
            if (error) throw error;
            await receiveSession(data.session, 'SESSION_RECHECK', ticket, allowTimingResume);
            return ticket === lifecycle && Boolean(user) && !recovery;
        } catch (error) {
            if (ticket !== lifecycle || locallySignedOut) return false;
            user = null;
            callbacks.onSignedOut?.();
            status(friendlyError(error), 'error');
            retryAction = checkSession;
            $('auth-retry').textContent = 'Try again';
            $('auth-retry').hidden = false;
            callbacks.onError?.(error);
            return false;
        }
    }
    async function signIn(values) {
        return action(async isCurrent => {
            const email = emailValue(values), password = passwordValue(values);
            const { data, error } = await client.auth.signInWithPassword({ email, password });
            if (!isCurrent()) return false;
            if (error) throw error;
            locallySignedOut = false;
            pendingSignout(false);
            clearPasswords();
            scheduleSession(data.session, 'SIGNED_IN', true);
        }, 'Signing in…');
    }
    async function register(values) {
        return action(async isCurrent => {
            const fullName = String(values.full_name || '').trim();
            if (!fullName || fullName.length > 120) throw new Error('Enter your full name (up to 120 characters).');
            const email = emailValue(values), password = passwordValue(values, true);
            const { data, error } = await client.auth.signUp({ email, password, options: { data: { full_name: fullName }, emailRedirectTo: redirectUrl() } });
            if (!isCurrent()) return false;
            if (error) throw error;
            clearForm();
            show('signin', 'Check your inbox to verify your email, then sign in. Your church access request will be sent after verified sign-in; admin approval is a separate step.');
            if (data.session) { locallySignedOut = false; pendingSignout(false); scheduleSession(data.session, 'SIGNED_IN', true); }
        }, 'Creating your account…');
    }
    async function requestPasswordReset(values) {
        return action(async isCurrent => {
            const email = emailValue(values);
            const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: redirectUrl() });
            if (!isCurrent()) return false;
            if (error) throw error;
            clearForm();
            status('If an account exists for that email, a reset link is on its way. Check your inbox and spam folder.');
        }, 'Sending reset link…');
    }
    async function updatePassword(values) {
        return action(async isCurrent => {
            if (!recovery || !user) throw new Error('Open a valid password reset link first.');
            const password = passwordValue(values, true);
            const { error } = await client.auth.updateUser({ password });
            if (!isCurrent()) return false;
            if (error) throw error;
            const signedOut = await beginLogout();
            if (signedOut) show('signin', 'Your password has been updated. Sign in with your new password.');
        }, 'Saving your password…');
    }
    async function continueWithGoogle() {
        return action(async isCurrent => {
            const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectUrl() } });
            if (!isCurrent()) return false;
            if (error) throw error;
            if (!data?.url) throw new Error('Google sign-in could not start. Please try again.');
            clearPasswords();
            status('Opening Google’s secure sign-in page…');
        }, 'Opening Google…');
    }
    function logout() {
        return beginLogout(actionPromise);
    }
    function beginLogout(pendingAction = null) {
        if (logoutPromise) return logoutPromise;
        actionRevision++;
        locallySignedOut = true;
        pendingSignout(true);
        recovery = false;
        cancelPending();
        notifySignedOut();
        retryAction = null;
        hide();
        setBusy(true);
        logoutPromise = (async () => {
            try {
                // Password sign-in can save its session outside the SDK auth lock.
                // Finish that request first, then clear the session it may have saved.
                if (pendingAction) await pendingAction;
                if (client) {
                    const { error } = await client.auth.signOut({ scope: 'local' });
                    if (error) throw error;
                }
                rememberRecovery();
                pendingSignout(false);
                locallySignedOut = false;
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
        })().finally(() => { logoutPromise = null; setBusy(false); });
        return logoutPromise;
    }
    function cleanCallbackUrl() {
        const url = new URL(window.location.href);
        const authKeys = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'expires_in', 'expires_at', 'token_type', 'code', 'error', 'error_code', 'error_description'];
        const fragment = new URLSearchParams(url.hash.slice(1));
        if (authKeys.some(key => fragment.has(key))) url.hash = '';
        authKeys.forEach(key => url.searchParams.delete(key));
        window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
    }
    async function loadSupabase(options) {
        if (window.supabase?.createClient) return;
        const sdkUrl = options.sdkUrl || window.GatherConfig?.sdkUrl;
        const sdkIntegrity = options.sdkIntegrity || window.GatherConfig?.sdkIntegrity;
        if (!sdkUrl || !sdkIntegrity) throw new Error('Configure the pinned Supabase SDK URL and integrity in config.js.');
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = sdkUrl;
            script.integrity = sdkIntegrity;
            script.crossOrigin = 'anonymous';
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
            locallySignedOut = pendingSignout();
            recovery = fragment.get('type') === 'recovery' || Boolean(storedRecovery());
            if (fragment.get('type') === 'recovery') rememberRecovery('pending');
            if (recovery) show('recovery', 'Connecting securely…');
            else if (callbackError) show('signin', 'Connecting securely…');
            else if (!$('auth-screen').hidden) status('Connecting securely…');
            setBusy(true, 'Connecting…');
            try {
                await loadSupabase(options);
                if (!client) client = window.supabase.createClient(options.url, options.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' } });
                callbacks.onReady?.(client);
                if (!subscription) subscription = client.auth.onAuthStateChange(authEvent).data.subscription;
                const ticket = lifecycle;
                const { data, error } = await client.auth.getSession();
                cleanCallbackUrl();
                ready = true;
                setBusy(false);
                // An auth event arriving during restoration owns the newer session.
                if (ticket !== lifecycle && !callbackError) return client;
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
                } else if (locallySignedOut) {
                    recovery = false;
                    notifySignedOut();
                    hide();
                    status('Private church data is hidden. Retry logging out to clear the saved session.', 'error');
                    retryAction = logout;
                    $('auth-retry').textContent = 'Retry log out';
                    $('auth-retry').hidden = false;
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
        if (sessionTimingBlocked) return checkSession(true);
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
