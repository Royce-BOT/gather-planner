-- Run ONCE in Supabase SQL Editor as postgres AFTER the upgrade migration.
-- Replace BOTH placeholders explicitly. Do not put a password or key here.
-- Church UUID: gather_planners.id. User UUID: Authentication > Users > your account.
-- The account must already have verified its email (Google also verifies email).
begin;
do $$
declare
  v_church_id uuid := 'REPLACE_WITH_CHURCH_UUID';
  v_user_id uuid := 'REPLACE_WITH_EXISTING_USER_UUID';
  v_email text;
  v_name text;
begin
  perform gather_private.gather_lock_church(v_church_id);
  select u.email,
    left(coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
                  nullif(btrim(u.raw_user_meta_data->>'name'), ''), ''), 120)
    into v_email, v_name from auth.users u
    where u.id = v_user_id and u.email_confirmed_at is not null;
  if not found then
    raise exception 'User not found or email is unverified. Verify your existing account first.';
  end if;
  if exists (select 1 from public.gather_members
             where church_id = v_church_id and role = 'admin' and status = 'approved') then
    raise exception 'This church already has an approved admin. Use the Admin workspace for role changes.';
  end if;
  insert into public.gather_members(church_id, user_id, role, status, full_name, email, reviewed_at, reviewed_by)
    values (v_church_id, v_user_id, 'admin', 'approved', v_name, coalesce(v_email, ''), clock_timestamp(), v_user_id)
    on conflict (church_id, user_id) do update
      set role = 'admin', status = 'approved', email = excluded.email,
          full_name = case when gather_members.full_name = '' then excluded.full_name else gather_members.full_name end,
          reviewed_at = excluded.reviewed_at, reviewed_by = excluded.reviewed_by;
end;
$$;
commit;
