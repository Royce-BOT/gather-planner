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
    if (Array.isArray(result.data) && result.data.length !== 1) throw new Error('The church membership response is invalid.');
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    if (!validMember(row) || row.church_id !== churchId || row.user_id !== userId) {
      throw new Error('The church membership response is invalid. Ask your administrator to check the Gather upgrade.');
    }
    return row;
  }

  function validMember(row) {
    return row !== null && typeof row === 'object' && !Array.isArray(row)
      && typeof row.church_id === 'string' && typeof row.user_id === 'string' && /^[a-zA-Z0-9_-]+$/.test(row.user_id)
      && statuses.has(row.status) && roles.has(row.role)
      && ['full_name', 'email'].every(key => !Object.hasOwn(row, key) || typeof row[key] === 'string');
  }

  async function request(client, churchId, user) {
    if (!user?.id || !user.email_confirmed_at) throw new Error('Verify your email before requesting church access.');
    const name = [user.user_metadata?.full_name, user.user_metadata?.name].find(value => typeof value === 'string' && value.trim())?.trim().slice(0, 120) || null;
    return resultRow(await client.rpc('gather_request_access', { p_church_id: churchId, p_full_name: name }), churchId, user.id);
  }

  // PostgreSQL filters public fields before download; validate the response contract too.
  const validatePublic = GatherPlanner.validatePublic;

  async function publicPlanner(client, churchId) {
    const result = await client.rpc('gather_public_planner', { p_church_id: churchId });
    if (result.error) throw result.error;
    return validatePublic(result.data);
  }

  async function refresh(client, churchId, expectedUserId = null) {
    const { data, error } = await client.auth.getUser();
    if (error) throw error;
    if (!data?.user) return { user: null, member: null, planner: null };
    const user = data.user;
    if (expectedUserId && user.id !== expectedUserId) throw Object.assign(new Error('Your session changed. Verify the current account before loading church data.'), { code: 'GATHER_SESSION_CHANGED' });
    const member = await request(client, churchId, user);
    if (!permissions(member).read) return { user, member, planner: null };
    const result = await client.from('gather_planners').select('data,version').eq('id', churchId).single();
    if (result.error) throw result.error;
    if (!result.data) throw new Error('Your church planner is unavailable. Check your access again.');
    GatherPlanner.validate(result.data.data);
    if (!Number.isInteger(result.data.version) || result.data.version < 0 || result.data.version > 2147483647) throw new Error('Invalid planner version.');
    return { user, member, planner: result.data };
  }

  async function save(client, churchId, snapshot, version) {
    GatherPlanner.validate(snapshot);
    if (!Number.isInteger(version) || version < 0 || version >= 2147483647) throw new Error('Planner version is invalid or has reached its limit. Contact the project owner.');
    const result = await client.from('gather_planners').update({ data: snapshot, version: version + 1 })
      .eq('id', churchId).eq('version', version).select('version').maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) throw Object.assign(new Error('The planner changed or your access changed. Refresh before editing again.'), { code: 'GATHER_CONFLICT' });
    if (result.data.version !== version + 1) throw new Error('The save response could not be confirmed. Refresh data before editing again.');
    return result.data.version;
  }

  async function list(client, churchId) {
    const result = await client.rpc('gather_list_members', { p_church_id: churchId });
    if (result.error) throw result.error;
    if (!Array.isArray(result.data) || result.data.some(m => !validMember(m) || m.church_id !== churchId)) {
      throw new Error('The member list could not be verified.');
    }
    return result.data;
  }

  async function review(client, churchId, member, action, role = 'viewer') {
    if (!validMember(member)) throw new Error('Reload the member list before making changes.');
    if (member.church_id !== churchId) throw new Error('This member belongs to a different church.');
    if (!member.updated_at) throw new Error('Reload the member list before making changes.');
    if (!['approve', 'reject', 'reopen', 'revoke', 'role'].includes(action) || !roles.has(role)) throw new Error('Invalid member action or role.');
    return resultRow(await client.rpc('gather_review_member', {
      p_church_id: churchId, p_user_id: member.user_id, p_action: action,
      p_role: role, p_expected_updated_at: member.updated_at
    }), churchId, member.user_id);
  }

  window.GatherAccess = Object.freeze({ permissions, request, refresh, save, list, review, publicPlanner, validatePublic });
})();
