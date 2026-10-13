(() => {
  'use strict';
  const esc = GatherPlanner.escape;
  const message = GatherPlanner.message;
  const statuses = ['pending', 'approved', 'rejected', 'revoked'];
  const roleDrafts = new Map();
  let rows = [], active = false, busy = false, generation = 0, search = '', filter = 'pending', feedback = '';
  let context;
  const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString() : '—';
  const roleOptions = selected => ['viewer', 'editor', 'admin'].map(role => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role[0].toUpperCase() + role.slice(1)}</option>`).join('');

  function clear() {
    if (context) {
      context.container.onclick = null;
      context.container.oninput = null;
      context.container.onchange = null;
      context.container.innerHTML = '';
    }
    active = false; generation++; rows = []; feedback = ''; context = null; busy = false;
    roleDrafts.clear();
  }

  function draw() {
    if (!active) return;
    if (!context?.isAdmin()) { clear(); return; }
    const counts = Object.fromEntries(statuses.map(status => [status, rows.filter(m => m.status === status).length]));
    const visible = rows.filter(m => (filter === 'all' || m.status === filter) && `${m.full_name} ${m.email}`.toLowerCase().includes(search.toLowerCase()));
    const adminCount = rows.filter(m => m.status === 'approved' && m.role === 'admin').length;
    const names = new Map(rows.map(m => [m.user_id, m.full_name || m.email]));
    context.container.innerHTML = `<div class="heading"><div><h1>Admin workspace</h1><p>Welcome people into your church workspace and manage their access.</p></div><button class="secondary" id="reload-members" ${busy ? 'disabled' : ''}>Refresh members</button></div>
      <div class="member-counts">${Object.entries(counts).map(([status, count]) => `<button class="stat ${filter === status ? 'selected' : ''}" data-member-filter="${status}"><span>${status.toUpperCase()}</span><b>${count}</b></button>`).join('')}</div>
      <section class="panel"><div class="member-filters"><label>Search members<input id="member-search" type="search" placeholder="Name or email" value="${esc(search)}"></label><label>Status<select id="member-status">${['pending', 'approved', 'rejected', 'revoked', 'all'].map(s => `<option value="${s}" ${s === filter ? 'selected' : ''}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label></div>
      <p id="admin-feedback" role="status" class="notice">${esc(feedback)}</p>
      <p class="member-help">Viewer can view and export. Editor can also edit and import. Admin can also manage members. Your own access is managed by another admin.</p>
      <div class="member-list">${visible.map(m => {
        const self = m.user_id === context.userId;
        const last = m.status === 'approved' && m.role === 'admin' && adminCount === 1;
        const disabled = busy || self;
        const role = roleDrafts.get(m.user_id) || (m.status === 'pending' ? 'viewer' : m.role);
        let actions = '';
        if (m.status === 'pending') actions = `<label>Approve as<select data-member-role="${m.user_id}" ${disabled ? 'disabled' : ''}>${roleOptions(role)}</select></label><button class="primary" data-member-action="approve" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Approve</button><button class="secondary" data-member-action="reject" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Reject</button>`;
        if (m.status === 'approved') actions = `<label>Church role<select data-member-role="${m.user_id}" ${disabled || last ? 'disabled' : ''}>${roleOptions(role)}</select></label><button class="secondary" data-member-action="role" data-member="${m.user_id}" ${disabled || last ? 'disabled' : ''}>Save role</button><button class="secondary danger" data-member-action="revoke" data-member="${m.user_id}" ${disabled || last ? 'disabled' : ''}>Revoke access</button>`;
        if (['rejected', 'revoked'].includes(m.status)) actions = `<button class="secondary" data-member-action="reopen" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Reconsider request</button>`;
        return `<article class="member-row"><div class="member-identity"><h2>${esc(m.full_name || 'Church member')} ${self ? '<small>(you)</small>' : ''}</h2><p>${esc(m.email)}</p><span class="status-badge status-${m.status}">${esc(m.status)}</span> <span class="tag">${esc(m.role)}</span><p>Requested ${esc(date(m.requested_at))}</p>${m.reviewed_at ? `<p>Last reviewed ${esc(date(m.reviewed_at))} by ${esc(names.get(m.reviewed_by) || m.reviewed_by || 'Project owner')}</p>` : ''}${last ? '<p>Last approved admin · add another admin before changing this access.</p>' : ''}</div><div class="member-actions">${actions}</div></article>`;
      }).join('') || `<div class="empty"><h2>${search ? 'No matching members' : `No ${filter === 'all' ? '' : filter + ' '}members`}</h2><p>${search ? 'Try a different name, email, or status.' : 'New verified registrations appear here after their first sign-in.'}</p></div>`}</div></section>`;
  }

  async function recheck(current, token) {
    try { await current.recheck(); }
    catch (error) {
      if (active && token === generation) feedback += ' Access could not be checked: ' + message(error);
    }
  }

  async function load() {
    if (!active || !context?.isAdmin() || busy) return;
    const token = ++generation;
    const current = context;
    busy = true; feedback = 'Loading church members…'; draw();
    try {
      const members = await GatherAccess.list(current.client, current.churchId);
      if (!active || token !== generation || !current.isAdmin()) return;
      rows = members; roleDrafts.clear(); feedback = '';
    } catch (error) {
      if (!active || token !== generation) return;
      rows = []; roleDrafts.clear(); feedback = message(error);
      await recheck(current, token);
    } finally {
      if (active && token === generation) { busy = false; draw(); }
    }
  }

  async function action(button) {
    if (!active || busy || !context?.isAdmin()) return;
    const current = context;
    const member = rows.find(m => m.user_id === button.dataset.member);
    if (!member || member.user_id === current.userId) return;
    const kind = button.dataset.memberAction;
    const role = current.container.querySelector(`[data-member-role="${member.user_id}"]`)?.value || 'viewer';
    const label = { approve: `Approve ${member.full_name || member.email} as ${role}?`, reject: `Reject ${member.full_name || member.email}'s request?`, reopen: `Return ${member.full_name || member.email} to pending for review?`, revoke: `Revoke ${member.full_name || member.email}'s church access?`, role: `Change ${member.full_name || member.email}'s role to ${role}?` }[kind];
    if (!label || !window.confirm(label)) return;
    const token = ++generation;
    busy = true; feedback = 'Saving access change…'; draw();
    try {
      const updated = await GatherAccess.review(current.client, current.churchId, member, kind, role);
      if (!active || token !== generation || !current.isAdmin()) return;
      rows = rows.map(m => m.user_id === updated.user_id ? updated : m);
      roleDrafts.delete(updated.user_id);
      feedback = 'Access updated. The member can use Check status or Refresh data to see the change.';
    } catch (error) {
      if (!active || token !== generation) return;
      feedback = message(error) + ' Refresh members before trying again.';
      current.notify(feedback);
      await recheck(current, token);
    } finally {
      if (active && token === generation) { busy = false; draw(); }
    }
  }

  function mount(options) {
    if (active && context?.container === options.container && context.client === options.client
      && context.churchId === options.churchId && context.userId === options.userId) {
      // Ordinary page redraws must preserve filters, role choices and in-flight RPCs.
      context = options; draw(); return;
    }
    clear(); context = options; active = true; search = ''; filter = 'pending';
    options.container.onclick = event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.id === 'reload-members') load();
      if (statuses.includes(button.dataset.memberFilter)) { filter = button.dataset.memberFilter; draw(); }
      if (button.dataset.memberAction) action(button);
    };
    options.container.oninput = event => {
      if (event.target.id !== 'member-search') return;
      search = event.target.value; const position = event.target.selectionStart; draw();
      if (!active) return;
      const input = options.container.querySelector('#member-search');
      if (!input) return;
      input.focus();
      if (position !== null) input.setSelectionRange(position, position);
    };
    options.container.onchange = event => {
      if (event.target.id === 'member-status' && [...statuses, 'all'].includes(event.target.value)) { filter = event.target.value; draw(); }
      if (event.target.dataset?.memberRole && ['viewer', 'editor', 'admin'].includes(event.target.value)) {
        roleDrafts.set(event.target.dataset.memberRole, event.target.value);
      }
    };
    draw(); load();
  }

  window.GatherAdmin = Object.freeze({ mount, clear });
})();
