-- Run in Supabase SQL Editor as postgres after the three upgrade migrations.
-- Owner-only READ ONLY metadata inspection: no fake users, role changes, writes,
-- private row values, settings values, or routine bodies. SQL string literals
-- in policy/constraint expressions are redacted; object names remain visible.
-- This does not verify Supabase Auth/OAuth delivery.
begin transaction read only;

-- Expected: both rows exist; rls_enabled = true; anonymous private read/write
-- and authenticated table-wide write = false. Authenticated SELECT is true,
-- constrained by the policies below; UPDATE is granted only on data/version.
select c.relname as table_name, c.relrowsecurity as rls_enabled,
  pg_catalog.has_table_privilege('anon', c.oid, 'SELECT') as anonymous_table_read,
  pg_catalog.has_any_column_privilege('anon', c.oid, 'SELECT') as anonymous_column_read,
  pg_catalog.has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') as anonymous_table_write,
  pg_catalog.has_any_column_privilege('anon', c.oid, 'INSERT,UPDATE') as anonymous_column_write,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'SELECT') as authenticated_read,
  pg_catalog.has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') as authenticated_table_write
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname in ('gather_planners', 'gather_members')
order by c.relname;

-- Expected: only authenticated planner data/version columns have UPDATE.
-- No member columns or planner identity/name columns are browser-writable.
select c.relname as table_name, a.attname as column_name,
  pg_catalog.has_column_privilege('authenticated', c.oid, a.attnum, 'UPDATE') as authenticated_update
from pg_catalog.pg_class c
join pg_catalog.pg_namespace n on n.oid = c.relnamespace
join pg_catalog.pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
where n.nspname = 'public' and c.relname in ('gather_planners', 'gather_members')
order by c.relname, a.attnum;

-- Expected: precisely three policies, all authenticated. Membership SELECT
-- uses auth.uid() for the caller's own status; planner SELECT/UPDATE use
-- gather_private.gather_can_access(id,false/true). No extra permissive policy.
-- Redact ordinary, doubled-quote, and backslash-escaped SQL string literals.
select tablename, policyname, roles, cmd, permissive,
  pg_catalog.regexp_replace(qual, $literal$'(?:[^'\\]|\\.|'')*'$literal$, $replacement$'[redacted]'$replacement$, 'g') as qual,
  pg_catalog.regexp_replace(with_check, $literal$'(?:[^'\\]|\\.|'')*'$literal$, $replacement$'[redacted]'$replacement$, 'g') as with_check
from pg_catalog.pg_policies
where schemaname = 'public' and tablename in ('gather_planners', 'gather_members')
order by tablename, policyname;

-- Expected: all present with an empty search_path. Only public_planner grants
-- anonymous execution. Authenticated execution is true for its four public
-- RPCs and private RLS/write-authorization helpers only. Trigger/lock/date
-- helpers are not RPCs. Write authorization is VOLATILE for fresh snapshots.
with expected(signature, returns_set, definer, anonymous_execute, authenticated_execute) as (values
  ('public.gather_public_planner(uuid)', false, true, true, true),
  ('public.gather_request_access(uuid,text)', true, true, false, true),
  ('public.gather_list_members(uuid)', true, true, false, true),
  ('public.gather_review_member(uuid,uuid,text,text,timestamp with time zone)', true, true, false, true),
  ('public.gather_check_version()', false, false, false, false),
  ('gather_private.gather_can_access(uuid,boolean)', false, true, false, true),
  ('gather_private.gather_lock_church(uuid)', false, true, false, false),
  ('gather_private.gather_member_write_guard()', false, true, false, false),
  ('gather_private.gather_authorize_planner_write(uuid)', false, true, false, true),
  ('gather_private.gather_planner_write_guard()', false, false, false, false),
  ('gather_private.gather_valid_date(text)', false, false, false, false)
)
select e.signature, p.oid is not null as installed, p.proargnames as argument_names,
  p.provolatile as volatility,
  pg_catalog.pg_get_function_result(p.oid) as result_type,
  p.proretset = e.returns_set as expected_set_result,
  p.prosecdef = e.definer as expected_definer,
  p.proconfig @> array['search_path=""'] as empty_search_path,
  pg_catalog.has_function_privilege('anon', p.oid, 'EXECUTE') = e.anonymous_execute as expected_anon_grant,
  pg_catalog.has_function_privilege('authenticated', p.oid, 'EXECUTE') = e.authenticated_execute as expected_auth_grant
from expected e left join pg_catalog.pg_proc p on p.oid = pg_catalog.to_regprocedure(e.signature)
order by e.signature;

-- Expected: private schema CREATE false for both roles, USAGE false for anon
-- and true for authenticated; lock-table access false for both roles.
select role_name,
  pg_catalog.has_schema_privilege(role_name, 'gather_private', 'USAGE') as private_schema_usage,
  pg_catalog.has_schema_privilege(role_name, 'gather_private', 'CREATE') as private_schema_create,
  pg_catalog.has_table_privilege(role_name, 'gather_private.gather_membership_locks', 'SELECT,INSERT,UPDATE,DELETE') as private_locks_access
from (values ('anon'), ('authenticated')) roles(role_name);

-- Expected: gather_version, gather_planner_write_guard, and
-- gather_member_write_guard are enabled (O), with matching function names.
select c.relname as table_name, t.tgname as trigger_name, t.tgenabled as enabled,
  t.tgfoid::regprocedure as function_signature
from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
where t.tgrelid in ('public.gather_planners'::regclass, 'public.gather_members'::regclass)
  and not t.tgisinternal
order by c.relname, t.tgname;

-- Expected: strict gather_planner_document_shape exists and is NOT VALID
-- (false). Historical malformed documents are retained; new writes are checked.
select conname, convalidated,
  pg_catalog.regexp_replace(pg_catalog.pg_get_constraintdef(oid),
    $literal$'(?:[^'\\]|\\.|'')*'$literal$, $replacement$'[redacted]'$replacement$, 'g') as definition
from pg_catalog.pg_constraint
where conrelid = 'public.gather_planners'::regclass and contype = 'c'
order by conname;

-- Investigate every unexpected routine here before exposing it through the
-- API. This lists signatures/privileges only, never routine bodies or data.
-- Text inspection cannot detect every dynamically constructed SQL reference.
with routines as (
  select p.*, n.nspname,
    pg_catalog.pg_get_functiondef(p.oid) as body
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('public', 'gather_private') and p.prokind in ('f', 'p')
)
select oid::regprocedure as signature, prosecdef as security_definer,
  pg_catalog.has_function_privilege('anon', oid, 'EXECUTE') as anonymous_execute,
  pg_catalog.has_function_privilege('authenticated', oid, 'EXECUTE') as authenticated_execute,
  proconfig @> array['search_path=""'] as empty_search_path
from routines
where proname like 'gather_%' or body ~ 'gather_(planners|members)'
order by nspname, proname, oid;

-- Unknown/null church must return only empty allowlisted collections.
select public.gather_public_planner(null) = '{"services":[],"songs":[]}'::jsonb as empty_null_public_response;

-- Aggregated legacy-data health only: no church IDs, names, contacts or notes.
-- Nonzero counts need a private backup and owner review, not a reset or a bulk
-- rewrite. The frontend rejects invalid private calendars until corrected.
select count(*) filter (where (
  jsonb_typeof(data) = 'object' and jsonb_typeof(data->'services') = 'array'
  and jsonb_typeof(data->'team') = 'array' and jsonb_typeof(data->'songs') = 'array'
) is not true) as malformed_planner_documents
from public.gather_planners;

with services as (
  select item from public.gather_planners p
  cross join lateral jsonb_array_elements(case when jsonb_typeof(p.data->'services') = 'array'
    then p.data->'services' else '[]'::jsonb end) as service(item)
)
select count(*) filter (where not gather_private.gather_valid_date(item->>'date')) as invalid_service_dates,
  count(*) filter (where coalesce((item->>'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$', false) = false) as invalid_service_times
from services;

-- Optional: replace the UUID below and execute separately to inspect only the
-- actual public projection under the anonymous DB role. Do not SELECT data
-- from gather_planners. Public results may contain intentionally public names.
-- set local role anon;
-- select public.gather_public_planner('REPLACE_WITH_CHURCH_UUID'::uuid);
-- reset role;

rollback;
