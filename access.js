 /* Public browser client only. RLS and restricted RPCs enforce every permission. */
(() => {
  'use strict';
  const roles = new Set(['admin', 'editor', 'viewer']);
  const statuses = new Set(['pending', 'approved', 'rejected', 'revoked']);

  function permissions(member) {
    const approved = member?.status === 'approved' && roles.has(member.role);
    return { read: approved, edit: approved && ['admin', 'editor'].includes(member.role), admin: approved && member.role === 'admin' };
  }

  function resultRow(result, churchId, userId) {
    if (result.error) throw result.error;
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!row || row.church_id !== churchId || row.user_id !== userId || !statuses.has(row.status) || !roles.has(row.role)) {
      throw new Error('The church membership response is invalid. Ask your administrator to check the Gather upgrade.');
    }
    return row;
  }

  async function request(client, churchId, user) {
    if (!user?.id || !user.email_confirmed_at) throw new Error('Verify your email before requesting church access.');
    const name = [user.user_metadata?.full_name, user.user_metadata?.name].find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 120) || null;
    return resultRow(await client.rpc('gather_request_access', { p_church_id: churchId, p_full_name: name }), churchId, user.id);
  }

  // The database constructs this allowlist before sending any data to visitors.
  // Validate its contract too; never fall back to the private JSON document.
  function validatePublic(planner) {
    const fields = (value, required, optional = []) => {
      if (!value || typeof value !== 'object' || Array.isArray(value) || required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
        throw new Error('The public schedule response is invalid. Ask an administrator to check the public-view migration.');
      }
    };
    fields(planner, ['services', 'songs']);
    if (!Array.isArray(planner.services) || !Array.isArray(planner.songs)) throw new Error('Invalid public schedule lists.');
    for (const [kind, records] of [['services', planner.services], ['songs', planner.songs]]) {
      const ids = new Set();
      for (const record of records) {
        fields(record, kind === 'services' ? ['id', 'title', 'date', 'time', 'theme', 'location', 'program'] : ['id', 'title']);
        if (typeof record.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(record.id) || ids.has(record.id) || typeof record.title !== 'string' || !record.title.trim()) throw new Error('Invalid public record.');
        ids.add(record.id);
        if (kind !== 'services') continue;
        if (typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date) || typeof record.time !== 'string' || !/^\d{2}:\d{2}$/.test(record.time) || typeof record.theme !== 'string' || typeof record.location !== 'string' || !Array.isArray(record.program)) throw new Error('Invalid public service.');
        for (const item of record.program) {
          fields(item, ['title', 'minutes'], ['person']);
          if (typeof item.title !== 'string' || !item.title.trim() || !Number.isInteger(item.minutes) || item.minutes < 1 || item.minutes > 300 || Object.hasOwn(item, 'person') && typeof item.person !== 'string') throw new Error('Invalid public program item.');
        }
      }
    }
    return planner;
  }

  async function publicPlanner(client, churchId) {
    const result = await client.rpc('gather_public_planner', { p_church_id: churchId });
    if (result.error) throw result.error;
    return validatePublic(result.data);
  }

  async function refresh(client, churchId) {
    const { data, error } = await client.auth.getUser();
    if (error) throw error;
    if (!data?.user) return { user: null, member: null, planner: null };
    const user = data.user;
    const member = await request(client, churchId, user);
    if (!permissions(member).read) return { user, member, planner: null };
    const result = await client.from('gather_planners').select('data,version').eq('id', churchId).single();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('Your church planner is unavailable. Check your access again.');
    return { user, member, planner: result.data };
  }

  async function save(client, churchId, snapshot, version) {
    const result = await client.from('gather_planners').update({ data: snapshot, version: version + 1 })
      .eq('id', churchId).eq('version', version).select('version').maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('The planner changed or your access changed. Refresh before editing again.');
    return result.data.version;
  }

  async function list(client, churchId) {
    const result = await client.rpc('gather_list_members', { p_church_id: churchId });
    if (result.error) throw result.error;
    if (!Array.isArray(result.data) || result.data.some(m => m.church_id !== churchId || !statuses.has(m.status) || !roles.has(m.role))) {
      throw new Error('The member list could not be verified.');
    }
    return result.data;
  }

  async function review(client, churchId, member, action, role = 'viewer') {
    if (member.church_id !== churchId) throw new Error('This member belongs to a different church.');
    if (!member.updated_at) throw new Error('Reload the member list before making changes.');
    return resultRow(await client.rpc('gather_review_member', {
      p_church_id: churchId, p_user_id: member.user_id, p_action: action,
      p_role: role, p_expected_updated_at: member.updated_at
    }), churchId, member.user_id);
  }

  window.GatherAccess = Object.freeze({ permissions, request, refresh, save, list, review, publicPlanner, validatePublic });
})();
