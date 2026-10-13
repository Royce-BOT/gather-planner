-- Run AFTER member_approval and public_view, as postgres in Supabase SQL Editor.
-- No planner JSON, versions, memberships, or publication flags are rewritten.
begin;

do $$
begin
  if pg_catalog.to_regprocedure('public.gather_public_planner(uuid)') is null
     or pg_catalog.to_regprocedure('gather_private.gather_can_access(uuid,boolean)') is null then
    raise exception 'Apply the member-approval and public-view upgrades before audit hardening.';
  end if;
end;
$$;

-- CHECK accepts NULL unless explicitly rejected. The original planner_arrays
-- check therefore allowed missing arrays. NOT VALID preserves historical rows
-- while enforcing this basic document contract for future inserts/updates.
alter table public.gather_planners drop constraint if exists gather_planner_document_shape;
alter table public.gather_planners add constraint gather_planner_document_shape check (
  (pg_catalog.jsonb_typeof(data) = 'object'
   and pg_catalog.jsonb_typeof(data->'services') = 'array'
   and pg_catalog.jsonb_typeof(data->'team') = 'array'
   and pg_catalog.jsonb_typeof(data->'songs') = 'array') is true
) not valid;

-- RLS checks the original statement snapshot. An UPDATE already waiting on a
-- concurrent revocation could otherwise finish after access was revoked. This
-- VOLATILE helper checks fresh READ COMMITTED snapshots around the same church
-- lock used by member changes; the revision write aborts stale stronger-isolation
-- transactions. Authenticated callers can only lock churches they can edit.
create or replace function gather_private.gather_authorize_planner_write(p_church_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not exists (
    select 1 from public.gather_members m join auth.users u on u.id = m.user_id
    where m.church_id = p_church_id and m.user_id = (select auth.uid())
      and m.status = 'approved' and m.role in ('admin', 'editor')
      and u.email_confirmed_at is not null
  ) then
    raise exception 'An approved church editor is required.' using errcode = '42501';
  end if;
  perform gather_private.gather_lock_church(p_church_id);
  if not exists (
    select 1 from public.gather_members m join auth.users u on u.id = m.user_id
    where m.church_id = p_church_id and m.user_id = (select auth.uid())
      and m.status = 'approved' and m.role in ('admin', 'editor')
      and u.email_confirmed_at is not null
  ) then
    raise exception 'Your church editing access changed. Refresh before editing again.' using errcode = '42501';
  end if;
end;
$$;
revoke all on function gather_private.gather_authorize_planner_write(uuid) from public, anon, authenticated;
grant execute on function gather_private.gather_authorize_planner_write(uuid) to authenticated;

-- Keep this trigger SECURITY INVOKER: current_user remains the acting database
-- role, rather than the function owner. Trusted SQL administration is preserved.
-- Trigger execution itself does not require browser EXECUTE grants.
create or replace function gather_private.gather_planner_write_guard()
returns trigger language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') then
    perform gather_private.gather_authorize_planner_write(new.id);
  end if;
  return new;
end;
$$;
revoke all on function gather_private.gather_planner_write_guard() from public, anon, authenticated;
drop trigger if exists gather_planner_write_guard on public.gather_planners;
create trigger gather_planner_write_guard before update on public.gather_planners
  for each row execute function gather_private.gather_planner_write_guard();

-- Regex alone accepts February 30 and year 0000. make_date validates the real
-- calendar without DateStyle-dependent casts or exceptions reaching visitors.
create or replace function gather_private.gather_valid_date(p_value text)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or p_value !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
    return false;
  end if;
  return pg_catalog.make_date(
    pg_catalog.substr(p_value, 1, 4)::integer,
    pg_catalog.substr(p_value, 6, 2)::integer,
    pg_catalog.substr(p_value, 9, 2)::integer
  ) is not null;
exception when datetime_field_overflow then
  return false;
end;
$$;
revoke all on function gather_private.gather_valid_date(text) from public, anon, authenticated;

create or replace function public.gather_public_planner(p_church_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'services', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', s.item->'id', 'title', s.item->'title',
            'date', s.item->'date', 'time', s.item->'time',
            'theme', case when pg_catalog.jsonb_typeof(s.item->'theme') = 'string'
              then s.item->'theme' else '""'::jsonb end,
            -- Publishing a service never publishes its member-only address.
            'location', case when pg_catalog.jsonb_typeof(s.item->'public_location') = 'string'
              then s.item->'public_location' else '""'::jsonb end,
            'program', coalesce((
              select pg_catalog.jsonb_agg(
                pg_catalog.jsonb_build_object('title', i.item->'title', 'minutes', case
                  when pg_catalog.jsonb_typeof(i.item->'minutes') in ('number', 'string')
                       and (i.item->>'minutes') ~ '^[1-9][0-9]{0,2}([.]0{1,8})?$'
                    then (i.item->>'minutes')::numeric::integer else null end)
                || case when i.item->'public_assignment' = 'true'::jsonb
                              and pg_catalog.jsonb_typeof(i.item->'person') = 'string'
                  then pg_catalog.jsonb_build_object('person', i.item->'person') else '{}'::jsonb end
                order by i.ordinal
              )
              from pg_catalog.jsonb_array_elements(case
                when pg_catalog.jsonb_typeof(s.item->'program') = 'array' then s.item->'program'
                else '[]'::jsonb end) with ordinality as i(item, ordinal)
              where pg_catalog.jsonb_typeof(i.item) = 'object'
                and pg_catalog.jsonb_typeof(i.item->'title') = 'string'
                and pg_catalog.btrim(i.item->>'title') <> ''
                and case when pg_catalog.jsonb_typeof(i.item->'minutes') in ('number', 'string')
                              and (i.item->>'minutes') ~ '^[1-9][0-9]{0,2}([.]0{1,8})?$'
                  then (i.item->>'minutes')::numeric::integer <= 300 else false end
            ), '[]'::jsonb)
          ) order by s.ordinal
        )
        from (
          -- Old malformed documents may contain repeated IDs. Return the first
          -- valid published entry, preserving order and all stored records.
          select source.item, source.ordinal,
            pg_catalog.row_number() over (partition by source.item->>'id' order by source.ordinal) as occurrence
          from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(p.data->'services') = 'array' then p.data->'services'
            else '[]'::jsonb end) with ordinality as source(item, ordinal)
          where pg_catalog.jsonb_typeof(source.item) = 'object'
            and source.item->'is_public' = 'true'::jsonb
            and pg_catalog.jsonb_typeof(source.item->'id') = 'string'
            and (source.item->>'id') ~ '^[A-Za-z0-9_-]+$'
            and pg_catalog.jsonb_typeof(source.item->'title') = 'string'
            and pg_catalog.btrim(source.item->>'title') <> ''
            and pg_catalog.jsonb_typeof(source.item->'date') = 'string'
            and gather_private.gather_valid_date(source.item->>'date')
            and pg_catalog.jsonb_typeof(source.item->'time') = 'string'
            and (source.item->>'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
        ) s where s.occurrence = 1
      ), '[]'::jsonb),
      'songs', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', s.item->'id', 'title', s.item->'title'
        ) order by s.ordinal)
        from (
          select source.item, source.ordinal,
            pg_catalog.row_number() over (partition by source.item->>'id' order by source.ordinal) as occurrence
          from pg_catalog.jsonb_array_elements(case
            when pg_catalog.jsonb_typeof(p.data->'songs') = 'array' then p.data->'songs'
            else '[]'::jsonb end) with ordinality as source(item, ordinal)
          where pg_catalog.jsonb_typeof(source.item) = 'object'
            and source.item->'is_public' = 'true'::jsonb
            and pg_catalog.jsonb_typeof(source.item->'id') = 'string'
            and (source.item->>'id') ~ '^[A-Za-z0-9_-]+$'
            and pg_catalog.jsonb_typeof(source.item->'title') = 'string'
            and pg_catalog.btrim(source.item->>'title') <> ''
        ) s where s.occurrence = 1
      ), '[]'::jsonb)
    )
    from public.gather_planners p where p.id = p_church_id
  ), '{"services":[],"songs":[]}'::jsonb);
$$;

revoke all on function public.gather_public_planner(uuid) from public, anon, authenticated;
grant execute on function public.gather_public_planner(uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
