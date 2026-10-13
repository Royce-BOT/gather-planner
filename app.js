// Fill these three values before opening the app. Use only a publishable key.
const SUPABASE_URL = 'https://psicnbamvqhdygrwxgdf.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_W-TIgy6d2iu4HCUDI5ma8g_i7a7hbMt';
const CHURCH_ID = 'd6a9a7e3-5227-439b-952d-8985e7a27178';
// Authentication and member management use the same public Supabase client.
let cloud, cloudReady = false, cloudVersion = 0, saving = false, canEdit = false;
let member = null, currentUser = null, accessEpoch = 0, checking = false;
let publicReady = false, publicLoading = false, publicError = '', publicEpoch = 0, accountMessage = '';
let publicDb = { services: [], songs: [] };
const emptyPlanner = () => ({ services: [], team: [], songs: [] });
let db = emptyPlanner(), confirmed = emptyPlanner();
let view = 'overview', selected = null, editing = null;
const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function validatePlanner(planner) {
    if (!planner || !['services', 'team', 'songs'].every(k => Array.isArray(planner[k]))) throw new Error('Invalid planner data');
    for (const kind of ['services', 'team', 'songs']) {
        const ids = new Set();
        for (const record of planner[kind]) {
            if (!record || typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.id) || ids.has(record.id)) throw new Error('Invalid or duplicate record ID');
            ids.add(record.id);
            for (const [key, value] of Object.entries(record)) {
                if (key === 'is_public') {
                    if (typeof value !== 'boolean') throw new Error('Invalid publication visibility');
                    continue;
                }
                if (key === 'program') continue;
                if (typeof value !== 'string') throw new Error('Invalid record field');
            }
            const name = kind === 'team' ? record.name : record.title;
            if (typeof name !== 'string' || !name.trim()) throw new Error('Missing record name');
            if (kind === 'services') {
                if (!/^\d{4}-\d{2}-\d{2}$/.test(record.date) || !/^\d{2}:\d{2}$/.test(record.time) || !Array.isArray(record.program)) throw new Error('Invalid service');
                for (const item of record.program) {
                    if (!item || typeof item.title !== 'string' || !item.title.trim() || typeof item.person !== 'string' || !['number', 'string'].includes(typeof item.minutes) || !Number.isInteger(Number(item.minutes)) || Number(item.minutes) < 1 || Number(item.minutes) > 300) throw new Error('Invalid program item');
                    if (Object.hasOwn(item, 'public_assignment') && typeof item.public_assignment !== 'boolean') throw new Error('Invalid assignment visibility');
                }
            }
        }
    }
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
    $('#check-access').onclick = () => refreshCloud();
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

async function refreshPublic() {
    if (!cloud) return;
    const epoch = ++publicEpoch;
    publicLoading = true; publicError = ''; syncAccount();
    if (!cloudReady) render();
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
    const text = error?.message || 'Could not check church access. Check your connection and try again.';
    if (['PGRST202', '42883', '42703'].includes(error?.code)) return 'The Gather approval upgrade is not installed yet. Ask the project owner to run the migration described in README.md.';
    return text;
}

async function refreshCloud() {
    if (!cloud) return;
    const returnView = view;
    const returnSelected = selected;
    lockCloud('Checking your church access…');
    const epoch = accessEpoch;
    try {
        const result = await GatherAccess.refresh(cloud, CHURCH_ID);
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
    $('#refresh-cloud').onclick = () => { retryPublic(); if (currentUser) refreshCloud(); };
    $('#signin-cloud').onclick = () => GatherAuth.show('signin');
    $('#register-cloud').onclick = () => GatherAuth.show('register');
    $('#logout-cloud').onclick = () => GatherAuth.logout();
    if ([SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CHURCH_ID].some(value => value.startsWith('YOUR_'))) {
        publicError = 'Set your public Supabase URL, publishable key, and church UUID at the top of app.js.'; render(); return;
    }
    await GatherAuth.start({
        url: SUPABASE_URL, key: SUPABASE_PUBLISHABLE_KEY,
        onReady: client => { cloud = client; void refreshPublic(); },
        onSession: async user => { currentUser = user; await refreshCloud(); },
        onSignedOut: () => {
            currentUser = null; lockCloud('Public schedules are available without an account.');
            if (cloud && !publicLoading) void refreshPublic();
        },
        onError: error => {
            lockCloud(accessError(error));
            if (!cloud) { publicError = 'Could not connect to public schedules. Check your connection and try again.'; render(); }
        }
    });
    window.addEventListener('focus', recheckAccess);
    document.addEventListener('visibilitychange', recheckAccess);
    setInterval(recheckAccess, 60000);
}

async function save() {
    if (!cloudReady || !canEdit || saving) return;
    saving = true; syncAccount(); render();
    const snapshot = structuredClone(db), epoch = accessEpoch, version = cloudVersion;
    const actorId = currentUser?.id;
    let failed = false, failureMessage = '';
    try {
        validatePlanner(snapshot);
        const nextVersion = await GatherAccess.save(cloud, CHURCH_ID, snapshot, version);
        if (epoch !== accessEpoch || !cloudReady) return;
        cloudVersion = nextVersion; confirmed = structuredClone(snapshot); toast('Saved to Supabase');
    } catch (error) {
        if (epoch !== accessEpoch || !cloudReady) return;
        db = structuredClone(confirmed); failed = true;
        failureMessage = 'Not saved: ' + error.message;
    } finally {
        saving = false;
        if (epoch === accessEpoch && cloudReady) { syncAccount(); render(); }
        else if (currentUser) await refreshCloud();
    }
    if (failed && epoch === accessEpoch) {
        await refreshCloud();
        if (currentUser?.id === actorId) toast(failureMessage);
    }
    if (!failed && epoch === accessEpoch && cloudReady) void refreshPublic();
}

let toastTimer;
function toast(message) {
    clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').style.display = 'block';
    toastTimer = setTimeout(() => { $('#toast').style.display = 'none'; $('#toast').textContent = ''; }, 6000);
}
function date(value) { return new Date(value + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }); }
function displayPlanner() { return cloudReady ? db : { services: publicDb.services, team: [], songs: publicDb.songs }; }
function upcoming() { return [...displayPlanner().services].sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)); }
function heading(title, subtitle, action = '') { return `<div class="heading"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`; }
function serviceRow(service) {
    const day = new Date(service.date + 'T12:00:00');
    return `<div class="row"><div class="date">${day.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}<b>${day.getDate()}</b></div><div class="rowinfo"><b>${esc(service.title)}</b><p>${esc(service.time)} · ${esc(service.location || 'Location to be announced')}</p></div><button class="textbutton" data-open="${service.id}">View →</button></div>`;
}

function render() {
    if (!cloudReady && ['team', 'admin'].includes(view)) view = 'overview';
    if (view === 'admin' && member?.role !== 'admin') view = 'overview';
    document.querySelectorAll('nav button').forEach(button => button.classList.toggle('active', button.dataset.view === view));
    $('#breadcrumb').textContent = (cloudReady ? 'Workspace / ' : 'Public / ') + ({ overview: 'Overview', services: 'Worship schedules', team: 'Ministry team', songs: 'Song library', program: 'Service program', admin: 'Admin workspace' }[view]);
    if (view === 'admin') {
        GatherAdmin.mount({ container: $('#content'), client: cloud, churchId: CHURCH_ID, userId: currentUser.id, isAdmin: () => cloudReady && member?.role === 'admin' && member?.status === 'approved', recheck: recheckAccess, notify: toast });
        return;
    }
    GatherAdmin.clear();
    $('#content').onclick = null; $('#content').oninput = null; $('#content').onchange = null;
    if (!cloudReady && !publicReady) {
        const message = publicError || 'Loading public worship schedules…';
        $('#content').innerHTML = `<section class="panel access-panel"><span class="eyebrow">WELCOME TO GATHER</span><h1>${publicError ? 'Schedules unavailable' : 'Gather for worship.'}</h1><p role="status">${esc(message)}</p>${publicError ? '<button class="secondary" id="retry-public">Try again</button>' : ''}</section>`;
        if (publicError) $('#retry-public').onclick = () => retryPublic();
        return;
    }
    const planner = displayPlanner();
    let output = !cloudReady && publicError ? `<p class="notice" role="status">${esc(publicError)} Showing the last loaded public schedules.</p>` : '';
    if (!cloudReady && publicLoading) output += '<p class="notice" role="status">Updating public schedules…</p>';
    if (view === 'overview') {
        const today = new Date(), localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
        const next = upcoming().find(service => service.date >= localDate) || upcoming()[0];
        output += heading(cloudReady ? 'A little planning. A lot of purpose.' : 'Gather for worship.', cloudReady ? 'Welcome to your ministry workspace. Let’s prepare for what’s ahead.' : 'Explore worship schedules, service programs, and songs.', canEdit ? '<button class="primary" data-add="services">+ Plan a service</button>' : '');
        output += next ? `<section class="hero"><div><span class="eyebrow">COMING TOGETHER NEXT</span><h2>${esc(next.title)}</h2><p>${date(next.date)} · ${esc(next.time)} · ${esc(next.location || 'Location to be announced')}</p><button class="secondary" data-open="${next.id}">Open service program &nbsp; ↗</button></div></section>` : `<div class="hero">${cloudReady ? 'Your next meaningful gathering starts here.' : 'Public worship schedules will appear here when the church publishes them.'}</div>`;
        output += `<div class="stats ${cloudReady ? '' : 'public-stats'}"><div class="stat"><span>${cloudReady ? 'PLANNED' : 'PUBLIC'} SERVICES</span><b>${planner.services.length}</b><small>Moments to gather</small></div>${cloudReady ? `<div class="stat"><span>MINISTRY VOLUNTEERS</span><b>${db.team.length}</b><small>People making it possible</small></div>` : ''}<div class="stat"><span>${cloudReady ? 'SONGS IN YOUR LIBRARY' : 'PUBLISHED SONGS'}</span><b>${planner.songs.length}</b><small>Worship with one voice</small></div></div>`;
        output += `<div class="columns"><section class="panel"><div class="panelhead"><h2>${cloudReady ? 'Your service calendar' : 'Worship schedules'}</h2><button class="textbutton" data-view="services">View all →</button></div>${upcoming().slice(0, 4).map(serviceRow).join('') || '<p>No services published yet.</p>'}</section>`;
        if (cloudReady) output += `<section class="panel"><div class="panelhead"><h2>People behind the ministry</h2><button class="textbutton" data-view="team">View team →</button></div>${db.team.slice(0, 4).map(person => `<div class="row"><span class="avatar">${esc(person.name.split(' ').filter(Boolean).map(word => word[0]).slice(0, 2).join(''))}</span><div class="rowinfo"><b>${esc(person.name)}</b><p>${esc(person.role)} · ${esc(person.ministry)}</p></div></div>`).join('') || '<p>Add your first volunteer.</p>'}</section>`;
        else output += `<section class="panel"><div class="panelhead"><h2>Worship with one voice</h2><button class="textbutton" data-view="songs">View songs →</button></div>${planner.songs.slice(0, 4).map(song => `<div class="row"><div class="rowinfo"><b>${esc(song.title)}</b></div></div>`).join('') || '<p>No songs published yet.</p>'}</section>`;
        output += '</div>';
    } else if (view === 'program') {
        const service = planner.services.find(record => record.id === selected);
        if (!service) { view = 'services'; return render(); }
        output += heading(esc(service.title), `${date(service.date)} · ${esc(service.time)} · ${esc(service.location || 'Location to be announced')}`, '<button class="primary" data-print>Print program</button>');
        output += `<section class="panel"><div class="panelhead"><div><span class="eyebrow">SERVICE THEME</span><h2 style="margin-top:10px">${esc(service.theme || 'Worship together')}</h2></div><span class="tag">${service.program.reduce((total, item) => total + Number(item.minutes), 0)} minutes</span></div>${service.program.map((item, index) => `<div class="programrow"><small>${String(index + 1).padStart(2, '0')}</small><div><b>${esc(item.title)}</b><p>${cloudReady ? `${esc(item.person || 'Volunteer needed')} · ` : item.person ? `${esc(item.person)} · ` : ''}${esc(item.minutes)} min</p></div>${canEdit ? `<div><button class="textbutton" data-item="${index}">Edit</button><button class="textbutton" data-move="${index}" ${index === 0 ? 'disabled' : ''} aria-label="Move program item up">↑</button><button class="textbutton" data-remove-item="${index}" aria-label="Remove program item">×</button></div>` : ''}</div>`).join('') || '<p>The service program will be added here.</p>'}${canEdit ? `<div class="actions"><button class="secondary" data-add-item>+ Add program item</button><button class="secondary" data-edit="${service.id}" data-kind="services">Edit service</button></div>` : ''}${cloudReady ? `<p>${esc(service.notes)}</p>` : ''}</section><button class="secondary back" data-view="services">← All services</button>`;
    } else {
        const titles = { services: [cloudReady ? 'Service planner' : 'Worship schedules', 'Make space for worship, fellowship, and prayer.', 'Plan a service'], team: ['Ministry team', 'Keep the people who serve connected and organized.', 'Add volunteer'], songs: ['Song library', 'Worship with the songs your congregation loves.', 'Add song'] };
        const kind = Object.hasOwn(titles, view) ? view : 'services';
        const [title, subtitle, action] = titles[kind];
        output += heading(title, subtitle, canEdit ? `<button class="primary" data-add="${kind}">+ ${action}</button>` : '');
        output += `<input class="search" id="search" placeholder="Search ${title.toLowerCase()}…" aria-label="Search"><div class="grid">${planner[kind].map(record => `<article class="card" data-search="${esc(Object.values(record).filter(value => typeof value === 'string').join(' ').toLowerCase())}"><span class="tag">${esc(kind === 'services' ? date(record.date) : kind === 'team' ? record.ministry : cloudReady ? 'Key ' + record.key : 'Worship song')}</span><h2>${esc(record.title || record.name)}</h2>${cloudReady && ['services', 'songs'].includes(kind) ? `<span class="tag">${record.is_public === true ? 'Published for visitors' : 'Church members'}</span>` : ''}<p>${esc(kind === 'services' ? record.theme : kind === 'team' ? record.role : cloudReady ? record.number ? 'Hymn #' + record.number : 'Worship song' : '')}</p><p>${esc(kind === 'services' ? record.time + ' · ' + (record.location || 'Location to be announced') : kind === 'team' ? record.contact : cloudReady ? record.notes : '')}</p><div class="actions">${kind === 'services' ? `<button class="primary" data-open="${record.id}">Open program →</button>` : ''}${canEdit ? `<button class="secondary" data-edit="${record.id}" data-kind="${kind}">Edit</button><button class="textbutton" data-delete="${record.id}" data-kind="${kind}">Delete</button>` : ''}</div></article>`).join('') || `<div class="empty">${cloudReady ? 'Nothing here yet.' : 'No public entries have been published yet.'}</div>`}</div><p id="noresults" hidden>No matching entries.</p>`;
    }
    $('#content').innerHTML = output;
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
    const value = kind === 'item' ? db.services.find(service => service.id === selected)?.program[index] || {} : db[kind].find(record => record.id === id) || {};
    editing = { kind, id, index };
    $('#modaltitle').textContent = (id || index !== null ? 'Edit ' : 'Add ') + ({ services: 'service', team: 'volunteer', songs: 'song', item: 'program item' }[kind]);
    $('#fields').innerHTML = specs[kind].map(([key, label, type], i) => type === 'checkbox'
        ? `<label class="visibility-field"><input name="${key}" type="checkbox" value="on" ${value[key] === true ? 'checked' : ''}><span>${label}</span></label>`
        : `<label>${label}${type === 'textarea' ? `<textarea name="${key}">${esc(value[key] || '')}</textarea>` : `<input name="${key}" type="${type}" value="${esc(value[key] ?? '')}" ${i === 0 || ['date', 'time', 'minutes'].includes(key) ? 'required' : ''} ${type === 'number' ? 'min="1" max="300"' : ''} ${key === 'person' ? 'list="volunteers"' : ''}>`}</label>`).join('')
        + (kind === 'services' ? '<p class="field-help">Visitors see only the public attendance location above. Preparation notes and unmarked assignments stay within your church.</p>' : '')
        + `<datalist id="volunteers">${db.team.map(person => `<option value="${esc(person.name)}">${esc(person.role)}</option>`).join('')}</datalist>`;
    $('#modal').showModal();
}

document.addEventListener('click', event => {
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
    if (data.delete && Object.hasOwn(db, data.kind) && confirm('Delete this entry?')) { db[data.kind] = db[data.kind].filter(record => record.id !== data.delete); save(); }
    if ('addItem' in data) modal('item');
    if ('item' in data) modal('item', null, Number(data.item));
    if ('removeItem' in data && confirm('Remove this program item?')) { db.services.find(service => service.id === selected).program.splice(Number(data.removeItem), 1); save(); }
    if ('move' in data) {
        const program = db.services.find(service => service.id === selected).program, index = Number(data.move);
        if (index > 0 && index < program.length) { [program[index], program[index - 1]] = [program[index - 1], program[index]]; save(); }
    }
});
$('#close').onclick = () => $('#modal').close();
$('#form').onsubmit = event => {
    event.preventDefault(); if (!cloudReady || saving || !canEdit || !editing) return;
    const { kind, id, index } = editing;
    const values = Object.fromEntries(new FormData(event.target));
    Object.keys(values).forEach(key => { values[key] = values[key].trim(); });
    if (['services', 'songs'].includes(kind)) values.is_public = values.is_public === 'on';
    if (kind === 'item') values.public_assignment = values.public_assignment === 'on';
    if (!values.title && !values.name) { toast('Please enter a name.'); return; }
    if (kind === 'item') {
        values.minutes = Number(values.minutes); const program = db.services.find(service => service.id === selected).program;
        index !== null ? program[index] = values : program.push(values);
    } else if (id) Object.assign(db[kind].find(record => record.id === id), values);
    else db[kind].push({ ...values, id: crypto.randomUUID(), ...(kind === 'services' ? { program: [] } : {}) });
    $('#modal').close(); editing = null; save();
};
document.addEventListener('input', event => {
    if (event.target.id !== 'search') return;
    let visible = 0;
    document.querySelectorAll('[data-search]').forEach(card => { card.hidden = !card.dataset.search.includes(event.target.value.toLowerCase()); if (!card.hidden) visible++; });
    $('#noresults').hidden = !!visible;
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
        const backup = JSON.parse(await file.text()); validatePlanner(backup);
        if (epoch !== accessEpoch || !cloudReady || !canEdit || saving) return;
        if (confirm('Replace your current planner with this backup?')) { db = backup; await save(); }
    } catch (error) { if (epoch === accessEpoch) toast('This file is not a valid Gather backup. ' + error.message); }
    finally { event.target.value = ''; }
};
bootCloud().catch(error => {
    lockCloud(accessError(error));
    publicError = 'Public schedules could not be loaded. Check your connection and try again.'; render();
});
