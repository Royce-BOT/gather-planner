const { url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY, churchId: CHURCH_ID } = window.GatherConfig;
// Authentication and member management use the same public Supabase client.
let cloud, cloudReady = false, cloudVersion = 0, saving = false, canEdit = false;
// cloudReady means approved private data has loaded; publicReady never grants that access.
let member = null, currentUser = null, accessEpoch = 0, checking = false;
let publicReady = false, publicLoading = false, publicError = '', publicEpoch = 0, accountMessage = '';
let publicDb = { services: [], songs: [] };
let privateLoad = null, publicLoad = null;
const emptyPlanner = GatherPlanner.empty;
let db = emptyPlanner(), confirmed = emptyPlanner();
let view = 'overview', selected = null, editing = null;
const $ = selector => document.querySelector(selector);
const esc = GatherPlanner.escape;

const validatePlanner = GatherPlanner.validate;

// Event listeners deliberately handle rejected promises; browser events do not await them.
async function runAction(action) {
    try { return await action(); }
    catch (error) { toast(GatherPlanner.message(error)); return false; }
}

function syncAccount() {
    const permissions = GatherAccess.permissions(member);
    $('#admin-nav').hidden = !cloudReady || !permissions.admin;
    $('#cloud-status').textContent = currentUser ? `${currentUser.email || 'Signed in'} · ${member?.status === 'approved' ? member.role : member?.status || 'Checking access'}` : '';
    const profile = $('.profile');
    const displayName = typeof currentUser?.user_metadata?.full_name === 'string' ? currentUser.user_metadata.full_name : currentUser?.email || 'Gather';
    profile.textContent = currentUser ? displayName.split(/[\s@]+/).filter(Boolean).slice(0, 2).map(word => word[0]).join('').toUpperCase() : '✦';
    $('#logout-cloud').hidden = !currentUser;
    $('#signin-cloud').hidden = !!currentUser;
    $('#register-cloud').hidden = !!currentUser;
    $('#refresh-cloud').hidden = false;
    $('#refresh-cloud').textContent = cloudReady ? 'Refresh data' : 'Refresh schedules';
    $('#refresh-cloud').disabled = saving;
    $('#public-nav-team').hidden = !cloudReady;
    document.querySelectorAll('nav button').forEach(button => { button.disabled = !cloudReady && (!publicReady || ['team', 'admin'].includes(button.dataset.view)); });
    $('#export').hidden = !cloudReady;
    $('#export').disabled = !cloudReady;
    $('#import-label').hidden = !cloudReady || !canEdit;
    $('#import').disabled = !cloudReady || !canEdit || saving;
    const notice = $('#access-notice');
    notice.hidden = !currentUser || cloudReady;
    if (notice.hidden) { notice.replaceChildren(); return; }
    const statuses = {
        pending: ['Awaiting admin approval', 'You can browse public schedules while your church access request is reviewed.'],
        rejected: ['Your access request was declined', 'Public schedules remain available. Contact your church administrator to reconsider church access.'],
        revoked: ['Your church access has been revoked', 'Public schedules remain available. Contact your church administrator to request a review.']
    };
    const [title, message] = statuses[member?.status] || ['Your account', accountMessage || 'Checking church access. Public schedules remain available.'];
    notice.innerHTML = `<div><strong>${title}</strong><p>${esc(message)}</p></div><button class="secondary" id="check-access">Check status</button>`;
    $('#check-access').onclick = () => runAction(refreshCloud);
}

function lockCloud(message) {
    accessEpoch++;
    cloudReady = false; canEdit = false; member = null; cloudVersion = 0;
    db = emptyPlanner(); confirmed = emptyPlanner(); editing = null;
    accountMessage = message;
    if (['team', 'admin'].includes(view)) { view = 'overview'; selected = null; }
    if (view === 'program' && !publicDb.services.some(service => service.id === selected)) { view = 'services'; selected = null; }
    GatherAdmin.clear();
    if ($('#modal').open) $('#modal').close();
    $('#modaltitle').textContent = '';
    $('#fields').replaceChildren(); $('#import').value = '';
    $('#toast').textContent = ''; $('#toast').style.display = 'none';
    $('#content').onclick = null; $('#content').oninput = null; $('#content').onchange = null;
    syncAccount(); render();
}

function showAccess(memberRecord) {
    member = memberRecord; accountMessage = ''; syncAccount(); render();
}

async function refreshPublic(force = false) {
    if (!cloud) return;
    if (publicLoad && !force) return publicLoad.promise;
    const epoch = ++publicEpoch;
    publicLoading = true; publicError = ''; syncAccount();
    if (!cloudReady) render();
    const request = { epoch };
    publicLoad = request;
    request.promise = loadPublic(epoch);
    try { return await request.promise; }
    finally { if (publicLoad === request) publicLoad = null; }
}

async function loadPublic(epoch) {
    try {
        const planner = await GatherAccess.publicPlanner(cloud, CHURCH_ID);
        if (epoch !== publicEpoch) return;
        publicDb = planner; publicReady = true;
    } catch (error) {
        if (epoch !== publicEpoch) return;
        publicError = ['PGRST202', '42883'].includes(error?.code)
            ? 'Public schedules are not configured yet. The project owner needs to run the public-view migration in README.md.'
            : 'Public schedules could not be loaded. Check your connection and try again.';
    } finally {
        if (epoch === publicEpoch) {
            publicLoading = false; syncAccount();
            if (!cloudReady) render();
        }
    }
}

async function retryPublic() {
    if (cloud) return refreshPublic();
    publicError = ''; publicLoading = true; syncAccount(); render();
    try { await GatherAuth.retry(); }
    finally {
        if (!cloud) {
            publicLoading = false;
            publicError ||= 'Could not connect to public schedules. Check your connection and try again.';
            syncAccount(); render();
        }
    }
}

function accessError(error) {
    const text = GatherPlanner.message(error, 'Could not check church access. Check your connection and try again.');
    if (['PGRST202', '42883', '42703'].includes(error?.code)) return 'The Gather approval upgrade is not installed yet. Ask the project owner to run the migration described in README.md.';
    return text;
}

async function refreshCloud() {
    if (!cloud) return;
    if (privateLoad?.epoch === accessEpoch && privateLoad.userId === currentUser?.id) return privateLoad.promise;
    const returnView = view;
    const returnSelected = selected;
    lockCloud('Checking your church access…');
    const request = { epoch: accessEpoch, userId: currentUser?.id };
    privateLoad = request;
    request.promise = loadPrivate(returnView, returnSelected, request.epoch, request.userId);
    try { return await request.promise; }
    finally { if (privateLoad === request) privateLoad = null; }
}

async function loadPrivate(returnView, returnSelected, epoch, expectedUserId) {
    try {
        const result = await GatherAccess.refresh(cloud, CHURCH_ID, expectedUserId);
        if (epoch !== accessEpoch) return;
        currentUser = result.user;
        if (!currentUser) { lockCloud('Public schedules are available without an account.'); GatherAuth.hide(); return; }
        member = result.member;
        GatherAuth.hide();
        if (!GatherAccess.permissions(member).read) { showAccess(member); return; }
        validatePlanner(result.planner.data);
        if (!Number.isInteger(result.planner.version) || result.planner.version < 0) throw new Error('Invalid planner version.');
        db = result.planner.data; confirmed = structuredClone(db); cloudVersion = result.planner.version;
        cloudReady = true; canEdit = GatherAccess.permissions(member).edit;
        view = returnView === 'admin' && member.role !== 'admin' ? 'overview' : returnView;
        selected = returnSelected; accountMessage = ''; syncAccount(); render();
    } catch (error) {
        if (epoch !== accessEpoch) return;
        if (error?.code === 'GATHER_SESSION_CHANGED') {
            currentUser = null; lockCloud('Verifying the current account…');
            await GatherAuth.checkSession(); return;
        }
        lockCloud(accessError(error));
        GatherAuth.hide();
    }
}

async function recheckAccess() {
    if (!cloud || !currentUser || checking || saving || document.visibilityState === 'hidden') return;
    checking = true; const epoch = accessEpoch;
    try {
        const { data, error } = await cloud.auth.getUser();
        if (epoch !== accessEpoch) return;
        if (error) throw error;
        if (!data.user) { currentUser = null; lockCloud('Public schedules are available without an account.'); GatherAuth.hide(); return; }
        if (data.user.id !== currentUser?.id) {
            currentUser = null; lockCloud('Verifying the current account…');
            await GatherAuth.checkSession(); return;
        }
        const latest = await GatherAccess.request(cloud, CHURCH_ID, data.user);
        if (epoch !== accessEpoch) return;
        if (!member || latest.status !== member.status || latest.role !== member.role) await refreshCloud();
    } catch (error) {
        if (epoch === accessEpoch) lockCloud(accessError(error) + ' Use Refresh data to check access again.');
    } finally { checking = false; }
}

async function bootCloud() {
    lockCloud('Connecting to your church workspace…');
    $('#refresh-cloud').onclick = () => runAction(() => Promise.all([retryPublic(), currentUser ? refreshCloud() : Promise.resolve()]));
    $('#signin-cloud').onclick = () => GatherAuth.show('signin');
    $('#register-cloud').onclick = () => GatherAuth.show('register');
    $('#logout-cloud').onclick = () => runAction(() => GatherAuth.logout());
    if ([SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CHURCH_ID].some(value => value.startsWith('YOUR_'))) {
        publicError = 'Set your public Supabase URL, publishable key, and church UUID in config.js.'; render(); return;
    }
    await GatherAuth.start({
        ...window.GatherConfig,
        onReady: client => { cloud = client; void runAction(refreshPublic); },
        onSession: async user => { currentUser = user; await refreshCloud(); },
        onSignedOut: () => {
            currentUser = null; lockCloud('Public schedules are available without an account.');
            if (cloud && !publicLoading) void runAction(refreshPublic);
        },
        onError: error => {
            lockCloud(accessError(error));
            if (!cloud) { publicError = 'Could not connect to public schedules. Check your connection and try again.'; render(); }
        }
    });
    window.addEventListener('focus', () => { void runAction(recheckAccess); });
    document.addEventListener('visibilitychange', () => { void runAction(recheckAccess); });
    setInterval(() => { void runAction(recheckAccess); }, 60000);
}

async function save() {
    if (!cloudReady || !canEdit || saving) return false;
    const snapshot = structuredClone(db), epoch = accessEpoch, version = cloudVersion;
    const actorId = currentUser?.id;
    let failed = false, failureMessage = '', requestStarted = false;
    saving = true;
    try {
        validatePlanner(snapshot);
        syncAccount(); render();
        requestStarted = true;
        const nextVersion = await GatherAccess.save(cloud, CHURCH_ID, snapshot, version);
        if (epoch !== accessEpoch || !cloudReady) return false;
        cloudVersion = nextVersion; confirmed = structuredClone(snapshot); toast('Saved to Supabase');
    } catch (error) {
        if (epoch !== accessEpoch || !cloudReady) return false;
        db = structuredClone(confirmed); failed = true;
        const prefix = !requestStarted || ['GATHER_CONFLICT', '42501'].includes(error?.code) ? 'Not saved: ' : 'Save not confirmed: ';
        failureMessage = prefix + GatherPlanner.message(error) + ' Refresh before editing again.';
    } finally {
        saving = false;
        if (epoch === accessEpoch && cloudReady) { syncAccount(); render(); }
        else if (currentUser) await refreshCloud();
    }
    if (failed && epoch === accessEpoch) {
        await refreshCloud();
        if (currentUser?.id === actorId) toast(failureMessage);
    }
    if (!failed && epoch === accessEpoch && cloudReady) void runAction(() => refreshPublic(true));
    return !failed;
}

let toastTimer;
function toast(message) {
    clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').style.display = 'block';
    toastTimer = setTimeout(() => { $('#toast').style.display = 'none'; $('#toast').textContent = ''; }, 6000);
}
function render() {
    if (!cloudReady && ['team', 'admin'].includes(view)) view = 'overview';
    if (view === 'admin' && member?.role !== 'admin') view = 'overview';
    if (view === 'admin') {
        $('#breadcrumb').textContent = 'Workspace / Admin workspace';
        document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
        GatherAdmin.mount({ container: $('#content'), client: cloud, churchId: CHURCH_ID, userId: currentUser.id, isAdmin: () => cloudReady && member?.role === 'admin' && member?.status === 'approved', recheck: recheckAccess, notify: toast });
        return;
    }
    GatherAdmin.clear();
    $('#content').onclick = null; $('#content').oninput = null; $('#content').onchange = null;
    const output = GatherView.page({ planner: cloudReady ? db : { ...publicDb, team: [] }, privateAccess: cloudReady, canEdit, publicReady, publicError, publicLoading, view, selected });
    view = output.view;
    $('#breadcrumb').textContent = output.breadcrumb;
    document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $('#content').innerHTML = output.html;
    if ($('#retry-public')) $('#retry-public').onclick = () => runAction(retryPublic);
    document.querySelectorAll('[data-add],[data-edit],[data-delete],[data-add-item],[data-item],[data-remove-item],[data-move]').forEach(button => {
        button.disabled = saving || !canEdit || ('move' in button.dataset && Number(button.dataset.move) === 0);
    });
    $('#import').disabled = saving || !canEdit;
}

const specs = {
    services: [['title', 'Service name', 'text'], ['date', 'Date', 'date'], ['time', 'Start time', 'time'], ['theme', 'Theme', 'text'], ['location', 'Church member location', 'text'], ['notes', 'Preparation notes', 'textarea'], ['is_public', 'Publish this schedule, theme, and program for visitors', 'checkbox'], ['public_location', 'Public attendance location (optional)', 'text']],
    team: [['name', 'Full name', 'text'], ['role', 'Role', 'text'], ['ministry', 'Ministry', 'text'], ['contact', 'Contact (optional)', 'text']],
    songs: [['title', 'Song title', 'text'], ['key', 'Musical key', 'text'], ['number', 'Hymn number (optional)', 'text'], ['notes', 'Notes', 'textarea'], ['is_public', 'Publish this song title for visitors', 'checkbox']],
    item: [['title', 'Program item', 'text'], ['minutes', 'Duration in minutes', 'number'], ['person', 'Assigned volunteer / team', 'text'], ['public_assignment', 'Show this assignment in the public program when its service is published', 'checkbox']]
};
function modal(kind, id = null, index = null) {
    if (!cloudReady || !canEdit || saving || !Object.hasOwn(specs, kind)) return;
    const program = kind === 'item' ? selectedProgram() : null;
    if (index !== null && !validIndex(index, program?.length)) return;
    const value = kind === 'item' ? program[index] || {} : db[kind].find(record => record.id === id) || {};
    if (id && !value.id) { toast('This record is no longer available. Refresh data.'); return; }
    editing = { kind, id, index };
    $('#modaltitle').textContent = (id || index !== null ? 'Edit ' : 'Add ') + ({ services: 'service', team: 'volunteer', songs: 'song', item: 'program item' }[kind]);
    $('#fields').innerHTML = specs[kind].map(([key, label, type], i) => type === 'checkbox'
        ? `<label class="visibility-field"><input name="${key}" type="checkbox" value="on" ${value[key] === true ? 'checked' : ''}><span>${label}</span></label>`
        : `<label>${label}${type === 'textarea' ? `<textarea name="${key}">${esc(value[key] || '')}</textarea>` : `<input name="${key}" type="${type}" value="${esc(value[key] ?? '')}" ${i === 0 || ['date', 'time', 'minutes'].includes(key) ? 'required' : ''} ${type === 'number' ? 'min="1" max="300"' : ''} ${key === 'person' ? 'list="volunteers"' : ''}>`}</label>`).join('')
        + (kind === 'services' ? '<p class="field-help">Visitors see only the public attendance location above. Preparation notes and unmarked assignments stay within your church.</p>' : '')
        + `<datalist id="volunteers">${db.team.map(person => `<option value="${esc(person.name)}">${esc(person.role)}</option>`).join('')}</datalist>`;
    $('#modal').showModal();
}

function validIndex(index, length) { return Number.isInteger(index) && index >= 0 && index < length; }
function selectedProgram(planner = db) {
    const service = planner.services.find(record => record.id === selected);
    if (!service) throw new Error('This service is no longer available. Refresh data.');
    return service.program;
}
async function changePlanner(change) {
    if (!cloudReady || !canEdit || saving) return false;
    const candidate = structuredClone(db);
    change(candidate);
    validatePlanner(candidate);
    db = candidate;
    return save();
}

async function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || button.disabled || !cloudReady && !publicReady) return;
    const data = button.dataset;
    if (data.view) {
        if (saving || !['overview', 'services', 'team', 'songs', 'admin'].includes(data.view) || ['team', 'admin'].includes(data.view) && !cloudReady || data.view === 'admin' && member?.role !== 'admin') return;
        view = data.view; render();
    }
    if (data.open) { selected = data.open; view = 'program'; render(); }
    if ('print' in data) window.print();
    if (saving || !canEdit || !cloudReady) return;
    if (data.add) modal(data.add);
    if (data.edit) modal(data.kind, data.edit);
    if (data.delete && ['services', 'team', 'songs'].includes(data.kind) && db[data.kind].some(record => record.id === data.delete) && confirm('Delete this entry?')) {
        await changePlanner(candidate => { candidate[data.kind] = candidate[data.kind].filter(record => record.id !== data.delete); });
    }
    if ('addItem' in data) modal('item');
    if ('item' in data) modal('item', null, Number(data.item));
    if ('removeItem' in data) {
        const index = Number(data.removeItem);
        if (validIndex(index, selectedProgram().length) && confirm('Remove this program item?')) {
            await changePlanner(candidate => { selectedProgram(candidate).splice(index, 1); });
        }
    }
    if ('move' in data) {
        const index = Number(data.move);
        if (index > 0 && validIndex(index, selectedProgram().length)) {
            await changePlanner(candidate => {
                const program = selectedProgram(candidate);
                [program[index], program[index - 1]] = [program[index - 1], program[index]];
            });
        }
    }
}
document.addEventListener('click', event => { void runAction(() => handleClick(event)); });
function cancelEditing() {
    $('#modal').close(); editing = null; $('#fields').replaceChildren();
}
$('#close').onclick = cancelEditing;
$('#modal').onclose = () => { if (!$('#modal').open) { editing = null; $('#fields').replaceChildren(); } };

async function submitForm(event) {
    event.preventDefault(); if (!cloudReady || saving || !canEdit || !editing) return;
    const { kind, id, index } = editing;
    const raw = Object.fromEntries(new FormData(event.target));
    const values = Object.fromEntries(specs[kind].map(([key, , type]) => [key, type === 'checkbox' ? raw[key] === 'on' : String(raw[key] ?? '').trim()]));
    const candidate = structuredClone(db);
    if (kind === 'item') {
        values.minutes = GatherPlanner.duration(values.minutes);
        const program = selectedProgram(candidate);
        if (index !== null && !validIndex(index, program.length)) throw new Error('This program item is no longer available.');
        index !== null ? program[index] = values : program.push(values);
    } else if (id) {
        const record = candidate[kind].find(record => record.id === id);
        if (!record) throw new Error('This record is no longer available. Refresh data.');
        Object.assign(record, values);
    } else candidate[kind].push({ ...values, id: crypto.randomUUID(), ...(kind === 'services' ? { program: [] } : {}) });
    // Validate before changing visible state or closing a draft with an invalid date/duration.
    validatePlanner(candidate);
    db = candidate; cancelEditing();
    await save();
}
$('#form').onsubmit = event => runAction(() => submitForm(event));
document.addEventListener('input', event => {
    if (event.target.id !== 'search') return;
    let visible = 0;
    document.querySelectorAll('[data-search]').forEach(card => { card.hidden = !card.dataset.search.includes(event.target.value.toLowerCase()); if (!card.hidden) visible++; });
    if ($('#noresults')) $('#noresults').hidden = !!visible;
});
$('#export').onclick = () => {
    if (!cloudReady) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'gather-backup.json'; link.click(); URL.revokeObjectURL(url);
};
$('#import').onchange = async event => {
    const epoch = accessEpoch;
    if (!cloudReady || saving || !canEdit) { event.target.value = ''; return; }
    const file = event.target.files[0]; if (!file) return;
    try {
        if (file.size > 10 * 1024 * 1024) throw new Error('Backups must be no larger than 10 MiB.');
        const backup = JSON.parse(await file.text()); validatePlanner(backup);
        if (epoch !== accessEpoch || !cloudReady || !canEdit || saving) return;
        if (confirm('Replace your current planner with this backup?')) { db = backup; await save(); }
    } catch (error) { if (epoch === accessEpoch) toast('This file is not a valid Gather backup. ' + GatherPlanner.message(error)); }
    finally { event.target.value = ''; }
};
bootCloud().catch(error => {
    lockCloud(accessError(error));
    publicError = 'Public schedules could not be loaded. Check your connection and try again.'; render();
});
