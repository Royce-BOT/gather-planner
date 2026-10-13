(() => {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let rows = [], active = false, busy = false, generation = 0, search = '', filter = 'pending', feedback = '';
  let context;
  const date = value => value ? new Date(value).toLocaleString() : '—';
  const roleOptions = selected => ['viewer', 'editor', 'admin'].map(role => `<option value="${role}" ${role === selected ? 'selected' : ''}>${role[0].toUpperCase() + role.slice(1)}</option>`).join('');

  function clear() {
    active = false; generation++; rows = []; feedback = ''; context = null; busy = false;
  }

  function draw() {
    if (!active || !context?.isAdmin()) return;
    const counts = Object.fromEntries(['pending', 'approved', 'rejected', 'revoked'].map(status => [status, rows.filter(m => m.status === status).length]));
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
        const role = m.status === 'pending' ? 'viewer' : m.role;
        let actions = '';
        if (m.status === 'pending') actions = `<label>Approve as<select data-member-role="${m.user_id}" ${disabled ? 'disabled' : ''}>${roleOptions('viewer')}</select></label><button class="primary" data-member-action="approve" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Approve</button><button class="secondary" data-member-action="reject" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Reject</button>`;
        if (m.status === 'approved') actions = `<label>Church role<select data-member-role="${m.user_id}" ${disabled || last ? 'disabled' : ''}>${roleOptions(role)}</select></label><button class="secondary" data-member-action="role" data-member="${m.user_id}" ${disabled || last ? 'disabled' : ''}>Save role</button><button class="secondary danger" data-member-action="revoke" data-member="${m.user_id}" ${disabled || last ? 'disabled' : ''}>Revoke access</button>`;
        if (['rejected', 'revoked'].includes(m.status)) actions = `<button class="secondary" data-member-action="reopen" data-member="${m.user_id}" ${disabled ? 'disabled' : ''}>Reconsider request</button>`;
        return `<article class="member-row"><div class="member-identity"><h2>${esc(m.full_name || 'Church member')} ${self ? '<small>(you)</small>' : ''}</h2><p>${esc(m.email)}</p><span class="status-badge status-${m.status}">${esc(m.status)}</span> <span class="tag">${esc(m.role)}</span><p>Requested ${esc(date(m.requested_at))}</p>${m.reviewed_at ? `<p>Last reviewed ${esc(date(m.reviewed_at))} by ${esc(names.get(m.reviewed_by) || m.reviewed_by || 'Project owner')}</p>` : ''}${last ? '<p>Last approved admin · add another admin before changing this access.</p>' : ''}</div><div class="member-actions">${actions}</div></article>`;
      }).join('') || `<div class="empty"><h2>${search ? 'No matching members' : `No ${filter === 'all' ? '' : filter + ' '}members`}</h2><p>${search ? 'Try a different name, email, or status.' : 'New verified registrations appear here after their first sign-in.'}</p></div>`}</div></section>`;
  }

  async function load() {
    if (!active || !context?.isAdmin() || busy) return;
    const token = ++generation;
    const current = context;
    busy = true; feedback = 'Loading church members…'; draw();
    try {
      const members = await GatherAccess.list(current.client, current.churchId);
      if (!active || token !== generation || !current.isAdmin()) return;
      rows = members; feedback = '';
    } catch (error) {
      if (!active || token !== generation) return;
      rows = []; feedback = error.message;
      await current.recheck();
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
      feedback = 'Access updated. The member can use Check status or Refresh data to see the change.';
    } catch (error) {
      if (!active || token !== generation) return;
      feedback = error.message + ' Refresh members before trying again.';
      current.notify(feedback);
      await current.recheck();
    } finally {
      if (active && token === generation) { busy = false; draw(); }
    }
  }

  function mount(options) {
    clear(); context = options; active = true; search = ''; filter = 'pending';
    options.container.onclick = event => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.id === 'reload-members') load();
      if (button.dataset.memberFilter) { filter = button.dataset.memberFilter; draw(); }
      if (button.dataset.memberAction) action(button);
    };
    options.container.oninput = event => {
      if (event.target.id !== 'member-search') return;
      search = event.target.value; const position = event.target.selectionStart; draw();
      const input = options.container.querySelector('#member-search'); input.focus();
      if (position !== null) input.setSelectionRange(position, position);
    };
    options.container.onchange = event => { if (event.target.id === 'member-status') { filter = event.target.value; draw(); } };
    draw(); load();
  }

  window.GatherAdmin = Object.freeze({ mount, clear });
})();
