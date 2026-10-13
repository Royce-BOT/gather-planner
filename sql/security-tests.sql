-- Run AFTER all three migrations in Supabase SQL Editor, as postgres, preferably in a
-- separate development project. This file creates fake accounts/claims only;
-- it does not test Supabase Auth emails, OAuth, or delivery. EVERYTHING rolls back.
-- Stop on the first error. A successful run prints PASS notices and ROLLBACK.
-- Fixed fixture UUIDs are checked for collisions before any insertion.
begin;
create temporary table gather_security_baseline as
select 'planners'::text as kind, coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb) as snapshot
from public.gather_planners p
union all
select 'members', coalesce(jsonb_agg(to_jsonb(m) order by m.church_id, m.user_id), '[]'::jsonb)
from public.gather_members m;

create function pg_temp.gather_assert(p_ok boolean, p_label text)
returns void language plpgsql as $$
begin
  if p_ok is distinct from true then raise exception 'FAIL: %', p_label; end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.gather_denied(p_sql text, p_label text, p_codes text[] default array['42501'])
returns void language plpgsql as $$
declare v_code text;
begin
  begin
    execute p_sql;
  exception when others then
    v_code := sqlstate;
  end;
  if v_code is null or not (v_code = any(p_codes)) then
    raise exception 'FAIL: % (expected %, received %)', p_label, p_codes, coalesce(v_code, 'success');
  end if;
  raise notice 'PASS: %', p_label;
end;
$$;
create function pg_temp.gather_actor(p_id uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', p_id, 'role', 'authenticated')::text, true);
end;
$$;

select pg_temp.gather_assert(not exists (
  select 1 from auth.users where id::text like 'f0000000-0000-4000-8000-0000000000%'
), 'fixture auth UUIDs are unused');
select pg_temp.gather_assert(not exists (
  select 1 from public.gather_planners where id in
    ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002')
), 'fixture church UUIDs are unused');

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('f0000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'gather-sql-test-' || n || '@example.invalid',
  case when n = 9 then null else clock_timestamp() end,
  '{"provider":"email","providers":["email"]}'::jsonb,
  jsonb_build_object('full_name', 'SQL fixture ' || n, 'role', 'admin'),
  clock_timestamp(), clock_timestamp()
from generate_series(1, 11) n;
-- Users: 1/2 admins, 3 editor, 4 viewer, 5 pending, 6 rejected, 7 revoked,
-- 8 new registrant, 9 unverified pending, 10 other-church admin,
-- 11 legacy approved account whose email verification was subsequently removed.
insert into public.gather_planners(id, name, data, version) values
  ('f1000000-0000-4000-8000-000000000001', 'SQL test church A',
   '{"services":[],"team":[],"songs":[],"fixture":"preserve-me"}', 7),
  ('f1000000-0000-4000-8000-000000000002', 'SQL test church B',
   '{"services":[],"team":[],"songs":[],"fixture":"other-church"}', 3);
insert into public.gather_members(church_id, user_id, role, status, full_name, email)
select 'f1000000-0000-4000-8000-000000000001', u.id,
  case right(u.id::text, 2) when '01' then 'admin' when '02' then 'admin'
    when '03' then 'editor' else 'viewer' end,
  case right(u.id::text, 2) when '05' then 'pending' when '06' then 'rejected'
    when '07' then 'revoked' when '09' then 'pending' else 'approved' end,
  u.raw_user_meta_data->>'full_name', u.email
from auth.users u
where u.id in (
  'f0000000-0000-4000-8000-000000000001', 'f0000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000003', 'f0000000-0000-4000-8000-000000000004',
  'f0000000-0000-4000-8000-000000000005', 'f0000000-0000-4000-8000-000000000006',
  'f0000000-0000-4000-8000-000000000007', 'f0000000-0000-4000-8000-000000000009',
  'f0000000-0000-4000-8000-000000000011'
);
insert into public.gather_members(church_id, user_id, role, status, full_name, email)
select 'f1000000-0000-4000-8000-000000000002', id, 'admin', 'approved', 'Church B admin', email
from auth.users where id = 'f0000000-0000-4000-8000-000000000010';
update auth.users set email_confirmed_at = null
where id = 'f0000000-0000-4000-8000-000000000011';

set local role anon;
select pg_temp.gather_denied('select * from public.gather_planners', 'anonymous planner read denied');
select pg_temp.gather_denied('select * from public.gather_members', 'anonymous membership read denied');
select pg_temp.gather_denied($q$select public.gather_request_access('f1000000-0000-4000-8000-000000000001')$q$,
  'anonymous request RPC denied');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000001')$q$,
  'anonymous listing RPC denied');
select pg_temp.gather_denied($q$select gather_private.gather_can_access('f1000000-0000-4000-8000-000000000001', true)$q$,
  'anonymous private policy helper denied');
select pg_temp.gather_denied($q$select gather_private.gather_authorize_planner_write('f1000000-0000-4000-8000-000000000001')$q$,
  'anonymous editor write authorization denied');
reset role;

set local role authenticated;
select pg_temp.gather_actor(null);
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'missing user claim reads no planners');
select pg_temp.gather_denied($q$select public.gather_request_access('f1000000-0000-4000-8000-000000000001')$q$,
  'missing user claim cannot request access');
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000009');
select pg_temp.gather_denied($q$select public.gather_request_access('f1000000-0000-4000-8000-000000000001')$q$,
  'email verification required for requests');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'unverified pending account reads no planners');
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000011');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'approval does not bypass missing email verification');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000005');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_members), 'members see only their own private record');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'pending user cannot read planner');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'pending direct API update changes zero rows');
select pg_temp.gather_denied($q$update public.gather_members set status = 'approved', role = 'admin'
  where user_id = 'f0000000-0000-4000-8000-000000000005'$q$, 'self approval through direct API denied');
select pg_temp.gather_denied($q$insert into public.gather_members(church_id, user_id, role, status)
  values ('f1000000-0000-4000-8000-000000000002', 'f0000000-0000-4000-8000-000000000005', 'admin', 'approved')$q$,
  'self privileged membership insertion denied');
select pg_temp.gather_denied($q$select gather_private.gather_authorize_planner_write('f1000000-0000-4000-8000-000000000001')$q$,
  'pending user cannot bypass approval through write authorization helper');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000001')$q$,
  'pending account cannot list private members');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000006');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'rejected user cannot read planner');
select pg_temp.gather_assert((select status = 'rejected' and role = 'viewer'
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001', 'Another name')),
  'repeat request keeps rejected status');
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000007');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'revoked user cannot read planner');
select pg_temp.gather_assert((select status = 'revoked'
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001')),
  'repeat request keeps revoked status');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000004');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_planners), 'approved viewer reads its church only');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'viewer direct API update changes zero rows');
select pg_temp.gather_denied($q$update public.gather_planners set name = 'unauthorized rename'
  where id = 'f1000000-0000-4000-8000-000000000001'$q$, 'viewer cannot update ungranted columns');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000001')$q$,
  'viewer cannot list private members');
select pg_temp.gather_denied($q$select gather_private.gather_authorize_planner_write('f1000000-0000-4000-8000-000000000001')$q$,
  'viewer cannot acquire editor write authorization');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000005', 'approve', 'admin', now())$q$, 'viewer cannot approve or choose privileged role');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000003');
select set_config('gather.test_legacy_updated_at', (select updated_at::text from public.gather_members), true);
select pg_temp.gather_assert((select status = 'approved' and role = 'editor'
  and updated_at = current_setting('gather.test_legacy_updated_at')::timestamptz
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001', 'Changed display name')),
  'existing approved editor membership and timestamp survive repeat sign in');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001' and version = 7 returning version)
select pg_temp.gather_assert((select version = 8 from changed), 'editor direct API save succeeds with version increment');
with changed as (update public.gather_planners set data = data, version = 8
  where id = 'f1000000-0000-4000-8000-000000000001' and version = 7 returning version)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'stale planner version cannot overwrite newer save');
select pg_temp.gather_denied($q$update public.gather_planners set version = version + 2
  where id = 'f1000000-0000-4000-8000-000000000001'$q$, 'planner version trigger remains active', array['P0001']);
select pg_temp.gather_denied($q$update public.gather_planners set data = '{}'::jsonb, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001'$q$, 'missing planner arrays denied even for editor', array['23514']);
select pg_temp.gather_denied($q$update public.gather_planners set data = '{"services":[],"team":null,"songs":[]}'::jsonb, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001'$q$, 'null planner array denied even for editor', array['23514']);
select pg_temp.gather_denied($q$update public.gather_planners set data = '{"services":[],"team":[],"songs":"invalid"}'::jsonb, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001'$q$, 'wrong planner array type denied even for editor', array['23514']);
select pg_temp.gather_assert((select version = 8 and data->>'fixture' = 'preserve-me'
  from public.gather_planners where id = 'f1000000-0000-4000-8000-000000000001'),
  'failed malformed writes preserve planner JSON and version');
select pg_temp.gather_denied('select * from gather_private.gather_membership_locks', 'authenticated membership lock rows denied');
select pg_temp.gather_denied($q$select gather_private.gather_lock_church('f1000000-0000-4000-8000-000000000001')$q$,
  'authenticated private lock function denied');
select pg_temp.gather_denied('select public.gather_check_version()', 'planner trigger cannot be called as an authenticated RPC');
select pg_temp.gather_denied('select gather_private.gather_planner_write_guard()', 'planner access guard cannot be called as an authenticated RPC');
select pg_temp.gather_assert((select prosecdef and provolatile='v' and proconfig=array['search_path=""']
  from pg_proc where oid='gather_private.gather_authorize_planner_write(uuid)'::regprocedure),
  'write authorization uses volatile snapshots and an empty search path');
select pg_temp.gather_denied($q$select gather_private.gather_authorize_planner_write('f1000000-0000-4000-8000-000000000002')$q$,
  'editor write authorization cannot cross church boundary');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners
  where id = 'f1000000-0000-4000-8000-000000000002'), 'cross church planner access denied');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000001')$q$,
  'editor cannot list private members');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000005', 'approve', 'viewer', now())$q$, 'editor cannot perform admin actions');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000008');
select pg_temp.gather_assert((select role = 'viewer' and status = 'pending' and full_name = 'New member'
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001', 'New member')),
  'new verified user requests pending viewer despite admin metadata');
select set_config('gather.test_new_updated_at', (select updated_at::text from public.gather_members), true);
select pg_temp.gather_assert((select updated_at = current_setting('gather.test_new_updated_at')::timestamptz
  and full_name = 'New member' and status = 'pending'
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001', 'Do not overwrite')),
  'duplicate request leaves the original row untouched');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_members), 'duplicate request creates one row');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000001');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_members), 'admin direct API still sees only own private record');
select pg_temp.gather_assert((select count(*) = 10
  from public.gather_list_members('f1000000-0000-4000-8000-000000000001')), 'approved admin lists church members by RPC');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000002')$q$,
  'admin cannot list another church members');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000010', 'role', 'viewer', now())$q$, 'admin cannot act in another church');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000010', 'role', 'viewer', now())$q$, 'target must belong to acting admin church', array['22023']);
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000001', 'role', 'viewer', now())$q$, 'admin cannot change own membership');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000008', 'approve')$q$, 'review must include expected timestamp', array['22023']);
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000009', 'approve', 'viewer',
  (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
   where user_id = 'f0000000-0000-4000-8000-000000000009'))$q$, 'admin approval cannot bypass email verification');
select pg_temp.gather_assert((select role = 'viewer' and status = 'approved'
  and reviewed_by = 'f0000000-0000-4000-8000-000000000001' and reviewed_at is not null
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000008', 'approve', 'viewer',
    current_setting('gather.test_new_updated_at')::timestamptz)), 'approval defaults viewer and records reviewer/time');
select set_config('gather.test_old_review', (select updated_at::text
  from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
  where user_id = 'f0000000-0000-4000-8000-000000000008'), true);
select pg_temp.gather_assert((select role = 'editor'
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000008', 'role', 'editor', current_setting('gather.test_old_review')::timestamptz)),
  'admin can explicitly grant editor role');
select pg_temp.gather_denied(format($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000008', 'role', 'viewer', %L::timestamptz)$q$,
  current_setting('gather.test_old_review')), 'stale member review cannot overwrite another action', array['40001']);

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000008');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_planners), 'approval enables planner read');
select pg_temp.gather_assert((select role = 'editor' and status = 'approved'
  from public.gather_request_access('f1000000-0000-4000-8000-000000000001')),
  'approved role survives subsequent sign in');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000001');
select pg_temp.gather_assert((select status = 'rejected' and reviewed_by = 'f0000000-0000-4000-8000-000000000001'
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000005', 'reject', 'viewer',
    (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
     where user_id = 'f0000000-0000-4000-8000-000000000005'))), 'admin rejects a pending request');
select pg_temp.gather_assert((select status = 'pending' and role = 'viewer'
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000005', 'reopen', 'admin',
    (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
     where user_id = 'f0000000-0000-4000-8000-000000000005'))), 'reconsidering always returns pending viewer');
select pg_temp.gather_denied($q$select public.gather_review_member('f1000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000005', 'role', 'admin',
  (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
   where user_id = 'f0000000-0000-4000-8000-000000000005'))$q$, 'pending user cannot receive role action', array['22023']);
select pg_temp.gather_assert((select status = 'revoked' and role = 'viewer'
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000008', 'revoke', 'viewer',
    (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
     where user_id = 'f0000000-0000-4000-8000-000000000008'))), 'admin revokes approved access');
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000008');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'revocation immediately denies future reads');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f1000000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'revocation immediately denies future writes');

select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000001');
select pg_temp.gather_assert((select status = 'revoked'
  from public.gather_review_member('f1000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002', 'revoke', 'viewer',
    (select updated_at from public.gather_list_members('f1000000-0000-4000-8000-000000000001')
     where user_id = 'f0000000-0000-4000-8000-000000000002'))), 'one of two admins can be revoked');
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000002');
select pg_temp.gather_denied($q$select public.gather_list_members('f1000000-0000-4000-8000-000000000001')$q$,
  'revoked admin loses admin RPC access');
reset role;

select pg_temp.gather_denied($q$update public.gather_members set role = 'viewer'
  where church_id = 'f1000000-0000-4000-8000-000000000001'
  and user_id = 'f0000000-0000-4000-8000-000000000001'$q$, 'owner cannot demote last approved admin', array['23514']);
select pg_temp.gather_denied($q$delete from public.gather_members
  where church_id = 'f1000000-0000-4000-8000-000000000001'
  and user_id = 'f0000000-0000-4000-8000-000000000001'$q$, 'owner cannot delete last approved admin', array['23514']);
select pg_temp.gather_denied($q$delete from auth.users
  where id = 'f0000000-0000-4000-8000-000000000001'$q$, 'auth deletion cascade cannot delete last admin', array['23514']);
select pg_temp.gather_denied($q$update public.gather_members
  set church_id = 'f1000000-0000-4000-8000-000000000002'
  where church_id = 'f1000000-0000-4000-8000-000000000001'
  and user_id = 'f0000000-0000-4000-8000-000000000003'$q$, 'owner cannot move membership identity', array['23514']);

savepoint intentional_church_delete;
delete from public.gather_planners where id = 'f1000000-0000-4000-8000-000000000001';
select pg_temp.gather_assert((select count(*) = 0 from public.gather_members
  where church_id = 'f1000000-0000-4000-8000-000000000001'), 'intentional whole church delete can cascade');
rollback to intentional_church_delete;

select pg_temp.gather_assert((select data->>'fixture' = 'preserve-me' and version = 8
  from public.gather_planners where id = 'f1000000-0000-4000-8000-000000000001'),
  'member actions preserve planner JSON and only editor save changed version');
select pg_temp.gather_assert((select snapshot from gather_security_baseline where kind = 'planners') =
  (select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb) from public.gather_planners p
   where p.id not in ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002')),
  'existing church planner records remain untouched by tests');
select pg_temp.gather_assert((select snapshot from gather_security_baseline where kind = 'members') =
  (select coalesce(jsonb_agg(to_jsonb(m) order by m.church_id, m.user_id), '[]'::jsonb) from public.gather_members m
   where m.church_id not in ('f1000000-0000-4000-8000-000000000001', 'f1000000-0000-4000-8000-000000000002')),
  'existing memberships remain untouched by tests');

-- An exhausted integer version must fail rather than wrap or overwrite data.
savepoint version_limit_fixture;
insert into public.gather_planners(id,name,data,version) values
  ('f1000000-0000-4000-8000-000000000003','Version limit fixture',
   '{"services":[],"team":[],"songs":[],"fixture":"version-limit-preserve"}',2147483647);
insert into public.gather_members(church_id,user_id,role,status) values
  ('f1000000-0000-4000-8000-000000000003','f0000000-0000-4000-8000-000000000003','editor','approved');
set local role authenticated;
select pg_temp.gather_actor('f0000000-0000-4000-8000-000000000003');
select pg_temp.gather_denied($q$update public.gather_planners set version=-2147483648,
  data='{"services":[],"team":[],"songs":[]}'::jsonb
  where id='f1000000-0000-4000-8000-000000000003'$q$, 'planner version overflow cannot wrap into a successful save', array['22003']);
select pg_temp.gather_assert((select version=2147483647 and data->>'fixture'='version-limit-preserve'
  from public.gather_planners where id='f1000000-0000-4000-8000-000000000003'),
  'version overflow leaves persisted planner unchanged');
reset role;
rollback to version_limit_fixture;
rollback;

-- Concurrency verification needs two database connections, so it cannot be
-- represented by this single-session rollback script. In a disposable project:
-- create one church with TWO verified approved admins A/B; capture each row's
-- updated_at. Connection 1, authenticated as A: BEGIN; review/revoke B using B's
-- timestamp; leave the transaction open. Connection 2, authenticated as B:
-- review/revoke A using A's timestamp. It must wait. COMMIT connection 1:
-- connection 2 must fail "An approved church admin is required", leaving A.
-- Repeat as postgres with direct UPDATEs demoting A/B: after connection 1
-- commits, connection 2 must fail the last-admin guard (or serialization failure
-- at REPEATABLE READ). Roll back/clean up only these disposable fixtures.
