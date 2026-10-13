-- Run AFTER 20261013_member_approval.sql as postgres in Supabase SQL Editor.
-- Add a read-only public projection; preserve every planner JSON/version/member.
-- Existing records stay private until an editor explicitly publishes them.
begin;

do $$
begin
  if pg_catalog.to_regclass('public.gather_planners') is null
     or pg_catalog.to_regclass('public.gather_members') is null
     or pg_catalog.to_regprocedure('gather_private.gather_can_access(uuid,boolean)') is null then
    raise exception 'Apply migrations/20261013_member_approval.sql before this public-view upgrade.';
  end if;
end;
$$;

-- Anonymous callers never receive the underlying JSON or membership records.
-- The approval migration's authenticated table grants/policies stay unchanged.
alter table public.gather_planners enable row level security;
alter table public.gather_members enable row level security;
revoke all on public.gather_planners, public.gather_members from public, anon;

create or replace function public.gather_public_planner(p_church_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select coalesce((
    select pg_catalog.jsonb_build_object(
      'services', coalesce((
        select pg_catalog.jsonb_agg(
          pg_catalog.jsonb_build_object(
            'id', case when pg_catalog.jsonb_typeof(s.item->'id') = 'string' then s.item->'id' else '""'::jsonb end,
            'title', case when pg_catalog.jsonb_typeof(s.item->'title') = 'string' then s.item->'title' else '""'::jsonb end,
            'date', case when pg_catalog.jsonb_typeof(s.item->'date') = 'string' then s.item->'date' else '""'::jsonb end,
            'time', case when pg_catalog.jsonb_typeof(s.item->'time') = 'string' then s.item->'time' else '""'::jsonb end,
            'theme', case when pg_catalog.jsonb_typeof(s.item->'theme') = 'string' then s.item->'theme' else '""'::jsonb end,
            -- A separate explicit public location prevents publishing an old
            -- private meeting address merely by making a service public.
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
                -- Preserve valid program order, skip malformed entries. The
                -- CASE prevents casts of untrusted strings or huge numbers.
                -- Legacy backups may contain canonical digit strings. Publish
                -- a numeric integer without copying the original JSON value.
                and case when pg_catalog.jsonb_typeof(i.item->'minutes') in ('number', 'string')
                              and (i.item->>'minutes') ~ '^[1-9][0-9]{0,2}([.]0{1,8})?$'
                  then (i.item->>'minutes')::numeric::integer <= 300 else false end
            ), '[]'::jsonb)
          ) order by s.ordinal
        )
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(p.data->'services') = 'array' then p.data->'services'
          else '[]'::jsonb end) with ordinality as s(item, ordinal)
        where pg_catalog.jsonb_typeof(s.item) = 'object'
          and s.item->'is_public' = 'true'::jsonb
          and pg_catalog.jsonb_typeof(s.item->'id') = 'string'
          and (s.item->>'id') ~ '^[A-Za-z0-9_-]+$'
          and pg_catalog.jsonb_typeof(s.item->'title') = 'string'
          and pg_catalog.btrim(s.item->>'title') <> ''
          and pg_catalog.jsonb_typeof(s.item->'date') = 'string'
          and (s.item->>'date') ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$'
          and pg_catalog.jsonb_typeof(s.item->'time') = 'string'
          and (s.item->>'time') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
      ), '[]'::jsonb),
      'songs', coalesce((
        select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
          'id', case when pg_catalog.jsonb_typeof(s.item->'id') = 'string' then s.item->'id' else '""'::jsonb end,
          'title', case when pg_catalog.jsonb_typeof(s.item->'title') = 'string' then s.item->'title' else '""'::jsonb end
        ) order by s.ordinal)
        from pg_catalog.jsonb_array_elements(case
          when pg_catalog.jsonb_typeof(p.data->'songs') = 'array' then p.data->'songs'
          else '[]'::jsonb end) with ordinality as s(item, ordinal)
        where pg_catalog.jsonb_typeof(s.item) = 'object'
          and s.item->'is_public' = 'true'::jsonb
          and pg_catalog.jsonb_typeof(s.item->'id') = 'string'
          and (s.item->>'id') ~ '^[A-Za-z0-9_-]+$'
          and pg_catalog.jsonb_typeof(s.item->'title') = 'string'
          and pg_catalog.btrim(s.item->>'title') <> ''
      ), '[]'::jsonb)
    )
    from public.gather_planners p where p.id = p_church_id
  ), '{"services":[],"songs":[]}'::jsonb);
$$;

-- This is the sole anonymous Gather interface. There are no write parameters,
-- no membership input, no church listing and no privileged key in the client.
revoke all on function public.gather_public_planner(uuid) from public, anon, authenticated;
grant execute on function public.gather_public_planner(uuid) to anon, authenticated;
notify pgrst, 'reload schema';
commit;
