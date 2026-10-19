-- ORIGINAL BASE SCHEMA: new installations only. Never rerun on an existing church.
-- After this file, run the member_approval, public_view, and audit_hardening
-- migrations in that order. Then use sql/first-admin.sql only if needed.
-- Existing installations run only missing upgrades, following DEVELOPER.md.
begin;
create table public.gather_planners (
 id uuid primary key default gen_random_uuid(),
 name text not null,
 data jsonb not null default '{"services":[],"team":[],"songs":[]}'::jsonb,
 version integer not null default 0,
 constraint planner_arrays check (jsonb_typeof(data->'services')='array' and jsonb_typeof(data->'team')='array' and jsonb_typeof(data->'songs')='array')
);
create table public.gather_members (
 church_id uuid not null references public.gather_planners(id) on delete cascade,
 user_id uuid not null references auth.users(id) on delete cascade,
 role text not null check (role in ('editor','viewer')),
 primary key(church_id,user_id)
);
alter table public.gather_planners enable row level security;
alter table public.gather_members enable row level security;
revoke all on public.gather_planners,public.gather_members from anon,authenticated;
grant select on public.gather_members to authenticated;
grant select on public.gather_planners to authenticated;
grant update(data,version) on public.gather_planners to authenticated;
create policy "Members see own memberships" on public.gather_members for select to authenticated using(user_id=(select auth.uid()));
create policy "Members read church planner" on public.gather_planners for select to authenticated
 using(exists(select 1 from public.gather_members m where m.church_id=id and m.user_id=(select auth.uid())));
create policy "Editors update church planner" on public.gather_planners for update to authenticated
 using(exists(select 1 from public.gather_members m where m.church_id=id and m.user_id=(select auth.uid()) and m.role='editor'))
 with check(exists(select 1 from public.gather_members m where m.church_id=id and m.user_id=(select auth.uid()) and m.role='editor'));
create function public.gather_check_version() returns trigger language plpgsql set search_path='' as $$
begin
 if new.version <> old.version+1 then raise exception 'Planner version must increment by one'; end if;
 return new;
end;
$$;
create trigger gather_version before update on public.gather_planners for each row execute function public.gather_check_version();
insert into public.gather_planners(name) values ('My Church') returning id;
commit;
-- Copy the returned id into churchId in config.js.
-- Follow DEVELOPER.md to apply the upgrade and promote your verified existing account
-- with explicit church/user UUIDs. Subsequent approvals happen in Admin workspace.
