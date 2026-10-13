-- Run AFTER both migrations, as postgres, in a disposable development database.
-- Creates fake users/claims; no Auth/OAuth delivery test. All changes roll back.
-- Stop on the first error. The local test-local.ps1 runner executes this file.
begin;
create temporary table gather_public_baseline as
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
  begin execute p_sql;
  exception when others then v_code := sqlstate;
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
  select 1 from auth.users where id::text like 'f4000000-0000-4000-8000-0000000000%'
), 'public-test auth fixture UUIDs unused');
select pg_temp.gather_assert(not exists (
  select 1 from public.gather_planners where id in
    ('f4100000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002')
), 'public-test church fixture UUIDs unused');

insert into auth.users(id, aud, role, email, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('f4000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'gather-public-test-' || n || '@example.invalid',
  clock_timestamp(), '{"provider":"email","providers":["email"]}'::jsonb,
  '{"full_name":"Private Account Name","role":"admin"}'::jsonb,
  clock_timestamp(), clock_timestamp()
from generate_series(1, 8) n;
insert into public.gather_planners(id, name, data, version) values
('f4100000-0000-4000-8000-000000000001', 'Private Church Name', $json$
{
  "services": [
    {"id":"public-service","title":"Sunday Worship","date":"2026-10-18","time":"09:00",
     "theme":"Hope","is_public":true,"public_location":"Main Sanctuary",
     "location":"PRIVATE HOME ADDRESS","notes":"PRIVATE PREPARATION NOTES",
     "contacts":{"email":"private-contact@example.invalid"},"assignments":[{"name":"PRIVATE ASSIGNMENT"}],
     "program":[
       {"title":"Welcome","minutes":5,"person":"PRIVATE LEADER","email":"leader@example.invalid"},
       {"title":"Reading","minutes":10,"person":"Public Reader","public_assignment":true,
        "notes":"PRIVATE READING NOTES","contacts":{"phone":"PRIVATE PHONE"}},
       {"title":"Prayer","minutes":3,"person":"PRIVATE STRING OPT IN","public_assignment":"true"},
       {"title":"String duration","minutes":"9","person":"PRIVATE MEMBER","email":"private-string@example.invalid","notes":"PRIVATE STRING NOTES"},
       {"title":"Integral decimal duration","minutes":5.0,"person":"PRIVATE DECIMAL MEMBER"},
       {"title":"Invalid string duration","minutes":"PRIVATE DURATION"},
       {"title":"Zero duration","minutes":0},
       {"title":"Negative duration","minutes":-5},
       {"title":"Fraction duration","minutes":1.5},
       {"title":"Huge duration","minutes":10000000000000000000000000000},
       {"title":"Long duration","minutes":1441},
       {"title":"Maximum duration","minutes":300},
       {"title":"Over maximum","minutes":301},
       {"title":{"notes":"PRIVATE NESTED TITLE"},"minutes":{"notes":"PRIVATE NESTED DURATION"},
        "person":{"email":"private-nested@example.invalid"},"public_assignment":true},
       "PRIVATE NONOBJECT ITEM",null
     ]},
    {"id":"private-service","title":"PRIVATE SERVICE","location":"PRIVATE LOCATION","program":[{"person":"PRIVATE"}]},
    {"id":"string-opt-in","title":"PRIVATE STRING SERVICE","is_public":"true"},
    {"id":"false-opt-in","title":"PRIVATE FALSE SERVICE","is_public":false},
    {"id":"public-no-location","title":"Public Without Address","date":"2026-10-19","time":"19:00","is_public":true,"location":"PRIVATE LEGACY LOCATION"},
    {"id":"invalid-date","title":"PRIVATE MALFORMED DATE","date":"2026-99-99","time":"09:00","is_public":true},
    {"id":"invalid-time","title":"PRIVATE MALFORMED TIME","date":"2026-10-18","time":"29:99","is_public":true},
    {"id":"invalid-id!","title":"PRIVATE MALFORMED ID","date":"2026-10-18","time":"09:00","is_public":true},
    {"id":"invalid-title","title":"   ","date":"2026-10-18","time":"09:00","is_public":true},
    {"id":{"secret":"PRIVATE ID"},"title":{"secret":"PRIVATE TITLE"},"date":{"secret":"PRIVATE DATE"},
     "time":["PRIVATE TIME"],"theme":{"secret":"PRIVATE THEME"},"public_location":{"secret":"PRIVATE LOCATION"},
     "program":{"notes":"PRIVATE PROGRAM OBJECT"},"is_public":true}
  ],
  "songs":[
    {"id":"public-song","title":"Amazing Grace","is_public":true,"key":"D","number":"42","notes":"PRIVATE SONG NOTES","email":"private-song@example.invalid"},
    {"id":"private-song","title":"PRIVATE SONG"},
    {"id":"string-song","title":"PRIVATE STRING SONG","is_public":"true"},
    {"id":{"secret":"PRIVATE SONG ID"},"title":{"secret":"PRIVATE SONG TITLE"},"is_public":true}
  ],
  "team":[{"name":"PRIVATE VOLUNTEER","email":"private-volunteer@example.invalid","phone":"PRIVATE PHONE"}],
  "members":[{"email":"private-membership@example.invalid","role":"admin"}],
  "backups":{"data":"PRIVATE BACKUP"},"notes":"PRIVATE TOP LEVEL NOTES","version":99999
}
$json$::jsonb, 40),
('f4100000-0000-4000-8000-000000000002', 'Other Private Church Name',
 '{"services":[{"id":"other-service","title":"Other Public Service","date":"2026-10-18","time":"11:00","is_public":true}],"songs":[],"team":[]}', 12);

-- Roles: two admins, editor, approved viewer, pending, rejected, revoked,
-- and an approved admin belonging exclusively to the other church.
insert into public.gather_members(church_id, user_id, role, status, full_name, email)
select 'f4100000-0000-4000-8000-000000000001', u.id,
  case right(u.id::text, 2) when '01' then 'admin' when '02' then 'admin' when '03' then 'editor' else 'viewer' end,
  case right(u.id::text, 2) when '05' then 'pending' when '06' then 'rejected' when '07' then 'revoked' else 'approved' end,
  'PRIVATE MEMBERSHIP NAME', u.email
from auth.users u where u.id::text like 'f4000000-0000-4000-8000-0000000000%'
  and u.id <> 'f4000000-0000-4000-8000-000000000008';
insert into public.gather_members(church_id,user_id,role,status)
values ('f4100000-0000-4000-8000-000000000002','f4000000-0000-4000-8000-000000000008','admin','approved');

select set_config('gather.public_expected', $json$
{
  "services":[
    {"id":"public-service","title":"Sunday Worship","date":"2026-10-18","time":"09:00","theme":"Hope","location":"Main Sanctuary",
     "program":[
       {"title":"Welcome","minutes":5},
       {"title":"Reading","minutes":10,"person":"Public Reader"},
       {"title":"Prayer","minutes":3},
       {"title":"String duration","minutes":9},
       {"title":"Integral decimal duration","minutes":5},
       {"title":"Maximum duration","minutes":300}
     ]},
    {"id":"public-no-location","title":"Public Without Address","date":"2026-10-19","time":"19:00","theme":"","location":"","program":[]}
  ],
  "songs":[{"id":"public-song","title":"Amazing Grace"}]
}
$json$, true);

select pg_temp.gather_assert((select prosecdef and provolatile = 's' and proconfig = array['search_path=""']
  from pg_proc where oid = 'public.gather_public_planner(uuid)'::regprocedure),
  'public interface is stable definer with empty search path');
select pg_temp.gather_assert(not has_table_privilege('anon','public.gather_planners','SELECT')
  and not has_table_privilege('anon','public.gather_members','SELECT'), 'anonymous roles have no private table SELECT grants');
select pg_temp.gather_assert((select bool_and(relrowsecurity) from pg_class
  where oid in ('public.gather_planners'::regclass,'public.gather_members'::regclass)), 'RLS remains enabled on both private tables');

set local role anon;
select pg_temp.gather_actor(null);
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000001') =
  current_setting('gather.public_expected')::jsonb,
  'logged-out API returns exact allowlist at every nested level and preserves program order');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000001')::text !~ 'PRIVATE|@example.invalid',
  'public response contains no private field values, volunteer contacts, accounts, notes or backups');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000002')->'services'->0->>'id' = 'other-service'
  and jsonb_array_length(public.gather_public_planner('f4100000-0000-4000-8000-000000000002')->'services') = 1,
  'public response is confined to precisely requested church');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000009999') = '{"services":[],"songs":[]}'::jsonb
  and public.gather_public_planner(null) = '{"services":[],"songs":[]}'::jsonb,
  'unknown or null church produces only empty public collections');
select pg_temp.gather_denied('select data from public.gather_planners', 'anonymous whole-document SELECT denied');
select pg_temp.gather_denied('select * from public.gather_members', 'anonymous membership SELECT denied');
select pg_temp.gather_denied('select * from auth.users', 'anonymous account SELECT denied');
select pg_temp.gather_denied($q$update public.gather_planners set data = '{}'::jsonb, version = version + 1$q$, 'anonymous UPDATE denied');
select pg_temp.gather_denied($q$insert into public.gather_planners(name) values ('Injected')$q$, 'anonymous INSERT denied');
select pg_temp.gather_denied('delete from public.gather_planners', 'anonymous DELETE denied');
select pg_temp.gather_denied($q$insert into public.gather_members(church_id,user_id,role,status)
  values ('f4100000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000005','admin','approved')$q$,
  'anonymous membership creation or escalation denied');
select pg_temp.gather_denied($q$select public.gather_request_access('f4100000-0000-4000-8000-000000000001')$q$,
  'anonymous access-request RPC denied');
select pg_temp.gather_denied($q$select public.gather_list_members('f4100000-0000-4000-8000-000000000001')$q$,
  'anonymous admin-list RPC denied');
select pg_temp.gather_denied($q$select public.gather_review_member('f4100000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000005','approve','admin',now())$q$, 'anonymous admin-write RPC denied');
reset role;

set local role authenticated;
select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000005');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000001') = current_setting('gather.public_expected')::jsonb,
  'pending user browses same public projection');
select pg_temp.gather_assert((select count(*) = 0 from public.gather_planners), 'pending private planner SELECT denied by RLS');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'pending planner edits denied by RLS');
select pg_temp.gather_denied($q$update public.gather_members set role='admin',status='approved'$q$,
  'pending user cannot self-approve or escalate role');
select pg_temp.gather_denied($q$select public.gather_review_member('f4100000-0000-4000-8000-000000000001',
  'f4000000-0000-4000-8000-000000000006','reopen','viewer',now())$q$, 'pending admin action denied');

select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000006');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000001') = current_setting('gather.public_expected')::jsonb,
  'rejected user browses public projection');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'rejected planner edits denied by RLS');
select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000007');
select pg_temp.gather_assert(public.gather_public_planner('f4100000-0000-4000-8000-000000000001') = current_setting('gather.public_expected')::jsonb,
  'revoked user retains public browsing');

select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000004');
select pg_temp.gather_assert((select count(*) = 1 from public.gather_planners), 'approved viewer retains private church read');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000001' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'approved viewer remains read-only');

select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000003');
with changed as (update public.gather_planners set data = jsonb_set(data,'{services,0,is_public}','false'::jsonb), version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000001' and version = 40 returning version)
select pg_temp.gather_assert((select count(*) = 1 and min(version) = 41 from changed), 'approved editor writes private planner and increments version');
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000001' and version = 40 returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'stale shared-save version cannot overwrite editor save');
select pg_temp.gather_denied($q$update public.gather_planners set version=version
  where id='f4100000-0000-4000-8000-000000000001'$q$, 'planner version trigger preserved', array['P0001']);
with changed as (update public.gather_planners set data = data, version = version + 1
  where id = 'f4100000-0000-4000-8000-000000000002' returning id)
select pg_temp.gather_assert((select count(*) = 0 from changed), 'editor cannot write another church');
select pg_temp.gather_denied($q$select public.gather_list_members('f4100000-0000-4000-8000-000000000001')$q$,
  'editor does not acquire admin workspace RPC access');

reset role;
set local role anon;
select pg_temp.gather_actor(null);
select pg_temp.gather_assert(jsonb_array_length(public.gather_public_planner('f4100000-0000-4000-8000-000000000001')->'services') = 1,
  'unpublishing removes service from subsequent public API reads');
reset role;

set local role authenticated;
select pg_temp.gather_actor('f4000000-0000-4000-8000-000000000001');
select pg_temp.gather_assert((select count(*) = 7 from public.gather_list_members('f4100000-0000-4000-8000-000000000001')),
  'admin workspace still lists only own church members');
select pg_temp.gather_assert((select status='approved' and role='editor' from public.gather_review_member(
  'f4100000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000005','approve','editor',
  (select updated_at from public.gather_list_members('f4100000-0000-4000-8000-000000000001')
   where user_id='f4000000-0000-4000-8000-000000000005'))), 'admin approval retains explicit editor assignment');
select pg_temp.gather_assert((select status='approved' and role='viewer' from public.gather_review_member(
  'f4100000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000005','role','viewer',
  (select updated_at from public.gather_list_members('f4100000-0000-4000-8000-000000000001')
   where user_id='f4000000-0000-4000-8000-000000000005'))), 'admin role management remains available');
select pg_temp.gather_denied($q$select public.gather_list_members('f4100000-0000-4000-8000-000000000002')$q$,
  'admin member listing cannot cross church boundary');
select pg_temp.gather_denied($q$select public.gather_review_member('f4100000-0000-4000-8000-000000000002',
  'f4000000-0000-4000-8000-000000000008','role','viewer',now())$q$, 'admin writes cannot cross church boundary');
select pg_temp.gather_assert((select status='revoked' from public.gather_review_member(
  'f4100000-0000-4000-8000-000000000001','f4000000-0000-4000-8000-000000000002','revoke','viewer',
  (select updated_at from public.gather_list_members('f4100000-0000-4000-8000-000000000001')
   where user_id='f4000000-0000-4000-8000-000000000002'))), 'one of two approved admins can still be revoked');
reset role;
select pg_temp.gather_denied($q$update public.gather_members set role='viewer'
  where church_id='f4100000-0000-4000-8000-000000000001' and user_id='f4000000-0000-4000-8000-000000000001'$q$,
  'last-admin protection still rejects privileged demotion', array['23514']);
select pg_temp.gather_denied($q$delete from auth.users where id='f4000000-0000-4000-8000-000000000001'$q$,
  'last-admin protection still rejects auth-user deletion cascade', array['23514']);

select pg_temp.gather_assert((select snapshot from gather_public_baseline where kind = 'planners') =
  (select coalesce(jsonb_agg(to_jsonb(p) order by p.id), '[]'::jsonb) from public.gather_planners p
   where p.id not in ('f4100000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002')),
  'public tests preserve all existing planner JSON and versions');
select pg_temp.gather_assert((select snapshot from gather_public_baseline where kind = 'members') =
  (select coalesce(jsonb_agg(to_jsonb(m) order by m.church_id, m.user_id), '[]'::jsonb) from public.gather_members m
   where m.church_id not in ('f4100000-0000-4000-8000-000000000001', 'f4100000-0000-4000-8000-000000000002')),
  'public tests preserve all existing memberships');
rollback;
