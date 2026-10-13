-- Upgrade the existing setup.sql schema; run as postgres in Supabase SQL Editor.
-- This migration changes access rules, never planner data or planner versions.
-- Existing editor/viewer memberships remain approved. New requests are pending.
begin;

do $$
begin
  if pg_catalog.to_regclass('public.gather_planners') is null
     or pg_catalog.to_regclass('public.gather_members') is null then
    raise exception 'Gather tables are missing. Run setup.sql first, then this upgrade.';
  end if;
end;
$$;

-- Serialize the upgrade with existing membership writes while replacing policies.
lock table public.gather_members in access exclusive mode;
alter table public.gather_members
  add column if not exists status text not null default 'approved',
  add column if not exists full_name text not null default '',
  add column if not exists email text not null default '',
  add column if not exists requested_at timestamptz not null default statement_timestamp(),
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists updated_at timestamptz not null default clock_timestamp();

alter table public.gather_members alter column status set default 'pending';
alter table public.gather_members drop constraint if exists gather_members_role_check;
alter table public.gather_members drop constraint if exists gather_members_status_check;
alter table public.gather_members drop constraint if exists gather_members_name_length_check;
alter table public.gather_members
  add constraint gather_members_role_check check (role in ('admin', 'editor', 'viewer')),
  add constraint gather_members_status_check check (status in ('pending', 'approved', 'rejected', 'revoked')),
  add constraint gather_members_name_length_check check (char_length(full_name) <= 120);

-- Metadata supplies display names only. Roles/status never come from auth metadata.
-- The migration date represents legacy membership import, not a historical request.
update public.gather_members m
set full_name = case when m.full_name = '' then
      left(coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
                    nullif(btrim(u.raw_user_meta_data->>'name'), ''), ''), 120)
      else m.full_name end,
    email = coalesce(u.email, '')
from auth.users u
where u.id = m.user_id
  and ((m.full_name = '' and coalesce(nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
                                    nullif(btrim(u.raw_user_meta_data->>'name'), ''), '') <> '')
       or m.email is distinct from coalesce(u.email, ''));

create index if not exists gather_members_review_queue
  on public.gather_members(church_id, status, requested_at);

-- Private lock rows keep member changes serial across a church. Updating a lock
-- revision also forces stale REPEATABLE READ/SERIALIZABLE transactions to abort.
-- Planner JSON/version and the existing optimistic-version trigger stay intact.
create schema if not exists gather_private;
revoke all on schema gather_private from public, anon, authenticated;
grant usage on schema gather_private to authenticated;
create table if not exists gather_private.gather_membership_locks (
  church_id uuid primary key references public.gather_planners(id) on delete cascade,
  revision bigint not null default 0
);
revoke all on gather_private.gather_membership_locks from public, anon, authenticated;
insert into gather_private.gather_membership_locks(church_id)
select id from public.gather_planners on conflict (church_id) do nothing;

create or replace function gather_private.gather_lock_church(p_church_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.gather_planners p where p.id = p_church_id for update;
  if not found then
    raise exception 'Church does not exist.' using errcode = '23503';
  end if;
  insert into gather_private.gather_membership_locks(church_id)
    values (p_church_id) on conflict (church_id) do nothing;
  update gather_private.gather_membership_locks
    set revision = revision + 1 where church_id = p_church_id;
end;
$$;
revoke all on function gather_private.gather_lock_church(uuid) from public, anon, authenticated;

-- The trigger protects even privileged direct membership changes and auth-user
-- deletion cascades. Deleting a whole church intentionally removes its members.
create or replace function gather_private.gather_member_write_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_church_id uuid;
begin
  if tg_op = 'UPDATE' and
     (new.church_id is distinct from old.church_id or new.user_id is distinct from old.user_id) then
    raise exception 'Membership identity cannot be changed.' using errcode = '23514';
  end if;
  v_church_id := case when tg_op = 'DELETE' then old.church_id else new.church_id end;
  if tg_op = 'DELETE' and not exists (
    select 1 from public.gather_planners where id = v_church_id
  ) then
    return old;
  end if;
  perform gather_private.gather_lock_church(v_church_id);

  if tg_op <> 'INSERT' and old.status = 'approved' and old.role = 'admin' then
    if tg_op = 'DELETE' or new.status <> 'approved' or new.role <> 'admin' then
      if not exists (
        select 1 from public.gather_members m
        join auth.users u on u.id = m.user_id
        where m.church_id = old.church_id and m.user_id <> old.user_id
          and m.status = 'approved' and m.role = 'admin'
          and u.email_confirmed_at is not null
      ) then
        raise exception 'The last approved admin cannot be removed or demoted.' using errcode = '23514';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then return old; end if;
  if new.status = 'approved' and
     (tg_op = 'INSERT' or old.status is distinct from 'approved'
       or (new.role = 'admin' and old.role is distinct from 'admin')) then
    if not exists (select 1 from auth.users u
                   where u.id = new.user_id and u.email_confirmed_at is not null) then
      raise exception 'Email verification is required before approval.' using errcode = '42501';
    end if;
  end if;
  if tg_op = 'UPDATE' then
    new.requested_at := old.requested_at;
    new.updated_at := greatest(clock_timestamp(), old.updated_at + interval '1 microsecond');
  else
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function gather_private.gather_member_write_guard() from public, anon, authenticated;
drop trigger if exists gather_member_write_guard on public.gather_members;
create trigger gather_member_write_guard before insert or update or delete
  on public.gather_members for each row execute function gather_private.gather_member_write_guard();

-- A scalar policy helper sees only the calling user's membership. Keeping it in
-- the private schema avoids exposing membership rows or auth.users via the API.
create or replace function gather_private.gather_can_access(p_church_id uuid, p_write boolean default false)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.gather_members m
    join auth.users u on u.id = m.user_id
    where m.church_id = p_church_id and m.user_id = (select auth.uid())
      and m.status = 'approved' and u.email_confirmed_at is not null
      and (not p_write or m.role in ('admin', 'editor'))
  );
$$;
revoke all on function gather_private.gather_can_access(uuid, boolean) from public, anon, authenticated;
grant execute on function gather_private.gather_can_access(uuid, boolean) to authenticated;

-- Remove ALL old policies on both tables. Otherwise an old permissive policy
-- would OR with these new policies and bypass approval requirements.
do $$
declare v_policy record;
begin
  for v_policy in select schemaname, tablename, policyname from pg_catalog.pg_policies
    where schemaname = 'public' and tablename in ('gather_members', 'gather_planners')
  loop
    execute format('drop policy %I on %I.%I', v_policy.policyname, v_policy.schemaname, v_policy.tablename);
  end loop;
end;
$$;
alter table public.gather_members enable row level security;
alter table public.gather_planners enable row level security;
revoke all on public.gather_members, public.gather_planners from public, anon, authenticated;
grant select on public.gather_members, public.gather_planners to authenticated;
grant update(data, version) on public.gather_planners to authenticated;
create policy "Gather members see only themselves" on public.gather_members
  for select to authenticated using (user_id = (select auth.uid()));
create policy "Gather approved verified members read planner" on public.gather_planners
  for select to authenticated using (gather_private.gather_can_access(id, false));
create policy "Gather approved verified editors update planner" on public.gather_planners
  for update to authenticated using (gather_private.gather_can_access(id, true))
  with check (gather_private.gather_can_access(id, true));

create or replace function public.gather_request_access(p_church_id uuid, p_full_name text default null)
returns setof public.gather_members language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_name text;
begin
  if v_user_id is null then
    raise exception 'Sign in before requesting church access.' using errcode = '42501';
  end if;
  select u.email,
    coalesce(nullif(btrim(p_full_name), ''), nullif(btrim(u.raw_user_meta_data->>'full_name'), ''),
             nullif(btrim(u.raw_user_meta_data->>'name'), ''), '')
    into v_email, v_name from auth.users u
    where u.id = v_user_id and u.email_confirmed_at is not null;
  if not found then
    raise exception 'Verify your email before requesting church access.' using errcode = '42501';
  end if;
  if char_length(v_name) > 120 then
    raise exception 'Full name must be 120 characters or fewer.' using errcode = '22023';
  end if;
  perform gather_private.gather_lock_church(p_church_id);
  -- No DO UPDATE: repeat sign-ins must never overwrite status, role or reviews.
  insert into public.gather_members(church_id, user_id, role, status, full_name, email)
    values (p_church_id, v_user_id, 'viewer', 'pending', v_name, coalesce(v_email, ''))
    on conflict (church_id, user_id) do nothing;
  return query select m.* from public.gather_members m
    where m.church_id = p_church_id and m.user_id = v_user_id;
end;
$$;

create or replace function public.gather_list_members(p_church_id uuid)
returns setof public.gather_members language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.gather_members m join auth.users u on u.id = m.user_id
    where m.church_id = p_church_id and m.user_id = (select auth.uid())
      and m.status = 'approved' and m.role = 'admin' and u.email_confirmed_at is not null
  ) then
    raise exception 'An approved church admin is required.' using errcode = '42501';
  end if;
  return query select m.* from public.gather_members m where m.church_id = p_church_id
    order by m.requested_at desc, m.user_id;
end;
$$;

create or replace function public.gather_review_member(
  p_church_id uuid, p_user_id uuid, p_action text,
  p_role text default 'viewer', p_expected_updated_at timestamptz default null
)
returns setof public.gather_members language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := auth.uid();
  v_member public.gather_members%rowtype;
begin
  if v_actor is null then
    raise exception 'Sign in before managing members.' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('approve', 'reject', 'reopen', 'revoke', 'role')
     or p_role is null or p_role not in ('admin', 'editor', 'viewer') then
    raise exception 'Invalid member action or role.' using errcode = '22023';
  end if;
  if p_expected_updated_at is null then
    raise exception 'Refresh members before submitting this action.' using errcode = '22023';
  end if;
  -- Lock before authorization/target reads. Concurrent revocations cannot leave
  -- the actor authorized from an earlier snapshot within this transaction.
  perform gather_private.gather_lock_church(p_church_id);
  if not exists (
    select 1 from public.gather_members m join auth.users u on u.id = m.user_id
    where m.church_id = p_church_id and m.user_id = v_actor
      and m.status = 'approved' and m.role = 'admin' and u.email_confirmed_at is not null
  ) then
    raise exception 'An approved church admin is required.' using errcode = '42501';
  end if;
  if p_user_id = v_actor then
    raise exception 'Admins cannot change their own membership.' using errcode = '42501';
  end if;
  select m.* into v_member from public.gather_members m
    where m.church_id = p_church_id and m.user_id = p_user_id for update;
  if not found then
    raise exception 'Member not found in this church.' using errcode = '22023';
  end if;
  if v_member.updated_at is distinct from p_expected_updated_at then
    raise exception 'Membership changed. Refresh members and try again.' using errcode = '40001';
  end if;
  if (p_action in ('approve', 'reject') and v_member.status <> 'pending')
     or (p_action = 'reopen' and v_member.status not in ('rejected', 'revoked'))
     or (p_action in ('role', 'revoke') and v_member.status <> 'approved') then
    raise exception 'This action is unavailable for the current member status.' using errcode = '22023';
  end if;
  if p_action in ('approve', 'role') and not exists (
    select 1 from auth.users u where u.id = p_user_id and u.email_confirmed_at is not null
  ) then
    raise exception 'The member must verify their email first.' using errcode = '42501';
  end if;
  update public.gather_members m
    set status = case p_action when 'approve' then 'approved' when 'reject' then 'rejected'
                   when 'reopen' then 'pending' when 'revoke' then 'revoked' else m.status end,
        role = case when p_action in ('approve', 'role') then p_role else 'viewer' end,
        reviewed_at = clock_timestamp(), reviewed_by = v_actor
    where m.church_id = p_church_id and m.user_id = p_user_id;
  return query select m.* from public.gather_members m
    where m.church_id = p_church_id and m.user_id = p_user_id;
end;
$$;

revoke all on function public.gather_request_access(uuid, text) from public, anon, authenticated;
revoke all on function public.gather_list_members(uuid) from public, anon, authenticated;
revoke all on function public.gather_review_member(uuid, uuid, text, text, timestamptz) from public, anon, authenticated;
grant execute on function public.gather_request_access(uuid, text) to authenticated;
grant execute on function public.gather_list_members(uuid) to authenticated;
grant execute on function public.gather_review_member(uuid, uuid, text, text, timestamptz) to authenticated;

-- Trigger functions are never callable RPCs. Preserve the planner version guard.
revoke all on function public.gather_check_version() from public, anon, authenticated;
notify pgrst, 'reload schema';
commit;
