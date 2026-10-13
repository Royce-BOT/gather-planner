# Requires installed PostgreSQL; no Supabase credentials, Docker, or live access.
# Runs the original schema, upgrade/first-admin preservation, rollback
# privacy/security suites and concurrent member changes in a temporary cluster.
param(
    [string]$PostgresBin = 'C:\Program Files\PostgreSQL\18\bin',
    [switch]$KeepFiles
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$testRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('gather-sql-' + [guid]::NewGuid().ToString('N'))
$dataRoot = Join-Path $testRoot 'data'
$psql = Join-Path $PostgresBin 'psql.exe'
$pgctl = Join-Path $PostgresBin 'pg_ctl.exe'
$pgready = Join-Path $PostgresBin 'pg_isready.exe'
$initdb = Join-Path $PostgresBin 'initdb.exe'
$postgres = Join-Path $PostgresBin 'postgres.exe'
foreach ($binary in @($psql, $pgctl, $pgready, $initdb, $postgres)) {
    if (-not (Test-Path -LiteralPath $binary)) { throw "PostgreSQL binary missing: $binary" }
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = $listener.LocalEndpoint.Port
$listener.Stop()
$dbArgs = @('-X', '-v', 'ON_ERROR_STOP=1', '-h', '127.0.0.1', '-p', "$port", '-U', 'postgres', '-d', 'postgres')
$server = $null

function Invoke-SqlFile([string]$Path) {
    & $psql @dbArgs -f $Path
    if ($LASTEXITCODE -ne 0) { throw "SQL failed: $Path" }
}
function Invoke-Sql([string]$Sql, [string]$Name) {
    $path = Join-Path $testRoot ($Name + '.sql')
    [System.IO.File]::WriteAllText($path, $Sql, [System.Text.UTF8Encoding]::new($false))
    Invoke-SqlFile $path
}
function Start-SqlJob([string]$Sql, [string]$Name) {
    $path = Join-Path $testRoot ($Name + '.sql')
    [System.IO.File]::WriteAllText($path, $Sql, [System.Text.UTF8Encoding]::new($false))
    $args = '-X -v ON_ERROR_STOP=1 -h 127.0.0.1 -p ' + $port + ' -U postgres -d postgres -f "' + $path + '"'
    $proc = Start-Process -FilePath $psql -ArgumentList $args -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $testRoot ($Name + '.out')) `
        -RedirectStandardError (Join-Path $testRoot ($Name + '.err'))
    # Retain the process handle so Windows PowerShell can retrieve ExitCode.
    $null = $proc.Handle
    return $proc
}
function Wait-SqlBlock([string]$ApplicationName) {
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
        $count = & $psql @dbArgs -A -t -q -c ("select count(*) from pg_stat_activity where application_name='" + $ApplicationName + "' and wait_event_type='Lock'")
        if ($LASTEXITCODE -ne 0) { throw 'Could not observe concurrency lock.' }
        if ("$count".Trim() -eq '1') { Write-Output "PASS: $ApplicationName waited on concurrent church lock"; return }
        Start-Sleep -Milliseconds 50
    }
    throw "Concurrency job did not block on the church lock: $ApplicationName"
}
function Wait-SqlJob($Job, [string]$Name, [bool]$ShouldSucceed, [string]$ExpectedError = '') {
    if (-not $Job.WaitForExit(20000)) { throw "Concurrent SQL job timed out: $Name" }
    $Job.Refresh()
    $stderr = Get-Content -LiteralPath (Join-Path $testRoot ($Name + '.err')) -Raw
    if ($ShouldSucceed -and $Job.ExitCode -ne 0) { throw "Concurrent SQL failed ($Name): $stderr" }
    if (-not $ShouldSucceed -and ($Job.ExitCode -eq 0 -or $stderr -notmatch $ExpectedError)) {
        throw "Expected concurrency denial ($Name), received exit $($Job.ExitCode): $stderr"
    }
    Write-Output "PASS: $Name"
}

try {
    & $initdb -D $dataRoot -U postgres -A trust --no-locale -E UTF8 --no-sync
    if ($LASTEXITCODE -ne 0) { throw 'Temporary PostgreSQL initialization failed.' }
    $server = Start-Process -FilePath $postgres -WindowStyle Hidden -PassThru `
        -ArgumentList ('-D "' + $dataRoot + '" -h 127.0.0.1 -p ' + $port + ' -c fsync=off -c synchronous_commit=off') `
        -RedirectStandardOutput (Join-Path $testRoot 'postgres.out') `
        -RedirectStandardError (Join-Path $testRoot 'postgres.err')
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        & $pgready -h 127.0.0.1 -p "$port" -U postgres -d postgres | Out-Null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw 'Temporary PostgreSQL did not become ready.' }

    Invoke-Sql @'
create role anon noinherit;
create role authenticated noinherit;
create schema auth;
create table auth.users (
  id uuid primary key, aud text, role text, email text unique,
  email_confirmed_at timestamptz, raw_app_meta_data jsonb default '{}',
  raw_user_meta_data jsonb default '{}', created_at timestamptz, updated_at timestamptz
);
create function auth.uid() returns uuid language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'sub')::uuid;
$$;
grant usage on schema auth to anon, authenticated;
revoke all on auth.users from public, anon, authenticated;
'@ 'auth-mock'
    Invoke-SqlFile (Join-Path $repoRoot 'setup.sql')
    Invoke-Sql @'
insert into auth.users(id, email, email_confirmed_at, raw_user_meta_data) values
('f2000000-0000-4000-8000-000000000001', 'legacy-editor@example.invalid', now(), '{"full_name":"Legacy Editor"}'),
('f2000000-0000-4000-8000-000000000002', 'legacy-viewer@example.invalid', now(), '{}');
insert into public.gather_planners(id, name, data, version) values
('f2100000-0000-4000-8000-000000000001', 'Legacy church',
 '{"services":[{"id":"legacy-service","title":"Existing service"}],"team":[],"songs":[]}', 23),
-- The original CHECK accepted this missing array. Audit must preserve this
-- historical row rather than rewrite it, fail installation, or publish it.
('f2100000-0000-4000-8000-000000000002', 'Historical malformed document',
 '{"services":[],"team":[],"legacy_private":"preserve-original-document"}', 17);
insert into public.gather_members(church_id, user_id, role) values
('f2100000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000001', 'editor'),
('f2100000-0000-4000-8000-000000000001', 'f2000000-0000-4000-8000-000000000002', 'viewer');
create table public.gather_test_baseline as select * from public.gather_planners;
'@ 'legacy-fixtures'
    Invoke-SqlFile (Join-Path $repoRoot 'migrations\20261013_member_approval.sql')
    Invoke-Sql @'
do $$ begin
  if exists ((select * from public.gather_planners except select * from public.gather_test_baseline)
    union all (select * from public.gather_test_baseline except select * from public.gather_planners)) then
    raise exception 'Migration changed legacy planner JSON/version';
  end if;
  if (select count(*) from public.gather_members where status='approved' and role in ('editor','viewer')) <> 2 then
    raise exception 'Legacy memberships were not preserved';
  end if;
  raise notice 'PASS: original setup upgrade preserves all planner JSON/versions and both existing membership roles';
end $$;
'@ 'upgrade-preservation'
    $bootstrap = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'first-admin.sql'))
    $bootstrap = $bootstrap.Replace('REPLACE_WITH_CHURCH_UUID', 'f2100000-0000-4000-8000-000000000001')
    $bootstrap = $bootstrap.Replace('REPLACE_WITH_EXISTING_USER_UUID', 'f2000000-0000-4000-8000-000000000001')
    Invoke-Sql $bootstrap 'first-admin-fixture'
    Invoke-Sql @'
do $$ begin
  if (select count(*) from public.gather_members where role='admin' and status='approved') <> 1
     or (select count(*) from public.gather_members where role='viewer' and status='approved') <> 1 then
    raise exception 'Explicit first admin promotion changed another membership';
  end if;
  raise notice 'PASS: explicit first admin promotion preserves another legacy viewer';
end $$;
create table public.gather_test_members_baseline as select * from public.gather_members;
'@ 'bootstrap-preservation'
    Invoke-SqlFile (Join-Path $repoRoot 'migrations\20261013_member_approval.sql')
    Invoke-Sql @'
do $$ begin
  if exists ((select * from public.gather_members except select * from public.gather_test_members_baseline)
    union all (select * from public.gather_test_members_baseline except select * from public.gather_members)) then
    raise exception 'Migration rerun changed an existing membership';
  end if;
  if exists ((select * from public.gather_planners except select * from public.gather_test_baseline)
    union all (select * from public.gather_test_baseline except select * from public.gather_planners)) then
    raise exception 'Bootstrap/rerun changed legacy planner';
  end if;
  raise notice 'PASS: migration rerun preserves member statuses/timestamps and planner records';
end $$;
'@ 'rerun-preservation'

    Invoke-Sql @'
create table public.gather_test_access_baseline as
select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb) as policies
from pg_catalog.pg_policies p where p.schemaname='public'
  and p.tablename in ('gather_members','gather_planners');
'@ 'public-upgrade-baseline'
    foreach ($pass in @(1, 2)) {
        Invoke-SqlFile (Join-Path $repoRoot 'migrations\20261013_public_view.sql')
        Invoke-Sql @'
do $$ begin
  if exists ((select * from public.gather_members except select * from public.gather_test_members_baseline)
    union all (select * from public.gather_test_members_baseline except select * from public.gather_members)) then
    raise exception 'Public migration changed an existing membership';
  end if;
  if exists ((select * from public.gather_planners except select * from public.gather_test_baseline)
    union all (select * from public.gather_test_baseline except select * from public.gather_planners)) then
    raise exception 'Public migration changed legacy planner JSON/version';
  end if;
  if (select policies from public.gather_test_access_baseline) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
      from pg_catalog.pg_policies p where p.schemaname='public'
        and p.tablename in ('gather_members','gather_planners')) then
    raise exception 'Public migration changed an authenticated membership or planner policy';
  end if;
  raise notice 'PASS: public migration/rerun preserves all planner JSON, versions, membership fields and private policies';
end $$;
set role anon;
do $$ begin
  if public.gather_public_planner('f2100000-0000-4000-8000-000000000001') <>
     '{"services":[],"songs":[]}'::jsonb then
    raise exception 'Public migration accidentally published an existing unmarked service';
  end if;
  raise notice 'PASS: legacy service stays private until explicit publication';
end $$;
reset role;
'@ ('public-upgrade-preservation-' + $pass)
    }
    foreach ($pass in @(1, 2)) {
        Invoke-SqlFile (Join-Path $repoRoot 'migrations\20261013_audit_hardening.sql')
        Invoke-Sql @'
do $$ begin
  if exists ((select * from public.gather_members except select * from public.gather_test_members_baseline)
    union all (select * from public.gather_test_members_baseline except select * from public.gather_members)) then
    raise exception 'Audit migration changed an existing membership';
  end if;
  if exists ((select * from public.gather_planners except select * from public.gather_test_baseline)
    union all (select * from public.gather_test_baseline except select * from public.gather_planners)) then
    raise exception 'Audit migration changed legacy planner JSON/version';
  end if;
  if (select policies from public.gather_test_access_baseline) is distinct from
     (select coalesce(jsonb_agg(to_jsonb(p) order by p.tablename, p.policyname), '[]'::jsonb)
      from pg_catalog.pg_policies p where p.schemaname='public'
        and p.tablename in ('gather_members','gather_planners')) then
    raise exception 'Audit migration changed authenticated church policies';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
    where conrelid='public.gather_planners'::regclass and conname='gather_planner_document_shape' and not convalidated) then
    raise exception 'Strict document shape constraint is absent or unexpectedly validated';
  end if;
  raise notice 'PASS: audit migration/rerun preserves planner JSON/versions, historical malformed rows, memberships and private policies';
end $$;
'@ ('audit-upgrade-preservation-' + $pass)
    }
    Invoke-SqlFile (Join-Path $PSScriptRoot 'verify-live-readonly.sql')
    Invoke-SqlFile (Join-Path $PSScriptRoot 'security-tests.sql')
    Invoke-SqlFile (Join-Path $PSScriptRoot 'public-security-tests.sql')

    Invoke-Sql @'
insert into auth.users(id, email, email_confirmed_at) values
('f3000000-0000-4000-8000-000000000001', 'race-admin-a@example.invalid', now()),
('f3000000-0000-4000-8000-000000000002', 'race-admin-b@example.invalid', now());
insert into public.gather_planners(id, name) values ('f3100000-0000-4000-8000-000000000001', 'Race fixture');
insert into public.gather_members(church_id,user_id,role,status) values
('f3100000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000001','admin','approved'),
('f3100000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000002','admin','approved');
'@ 'race-fixtures'
    $adminA = @'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000001',true);
select * from public.gather_review_member('f3100000-0000-4000-8000-000000000001',
 'f3000000-0000-4000-8000-000000000002','revoke','viewer',
 (select updated_at from public.gather_list_members('f3100000-0000-4000-8000-000000000001')
  where user_id='f3000000-0000-4000-8000-000000000002'));
select pg_sleep(2);
commit;
'@
    $adminB = @'
set application_name = 'gather-race-admin-B';
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000002',true);
select * from public.gather_review_member('f3100000-0000-4000-8000-000000000001',
 'f3000000-0000-4000-8000-000000000001','revoke','viewer',
 (select updated_at from public.gather_list_members('f3100000-0000-4000-8000-000000000001')
  where user_id='f3000000-0000-4000-8000-000000000001'));
commit;
'@
    $jobA = Start-SqlJob $adminA 'concurrent-admin-A'
    Start-Sleep -Milliseconds 500
    $jobB = Start-SqlJob $adminB 'concurrent-admin-B'
    Wait-SqlBlock 'gather-race-admin-B'
    Wait-SqlJob $jobA 'concurrent-admin-A' $true
    Wait-SqlJob $jobB 'concurrent-admin-B' $false 'approved church admin is required'
    Invoke-Sql "update public.gather_members set status='approved',role='admin' where church_id='f3100000-0000-4000-8000-000000000001';" 'restore-two-admins'
    foreach ($isolation in @('read committed', 'repeatable read')) {
        $ownerA = "begin; update public.gather_members set role='viewer' where user_id='f3000000-0000-4000-8000-000000000001'; select pg_sleep(2); commit;"
        $ownerB = "set application_name='gather-race-owner-B'; begin isolation level $isolation; update public.gather_members set role='viewer' where user_id='f3000000-0000-4000-8000-000000000002'; commit;"
        $nameA = 'concurrent-owner-A-' + $isolation.Replace(' ', '-')
        $nameB = 'concurrent-owner-B-' + $isolation.Replace(' ', '-')
        $jobA = Start-SqlJob $ownerA $nameA
        Start-Sleep -Milliseconds 500
        $jobB = Start-SqlJob $ownerB $nameB
        Wait-SqlBlock 'gather-race-owner-B'
        Wait-SqlJob $jobA $nameA $true
        Wait-SqlJob $jobB $nameB $false 'last approved admin|could not serialize access'
        Invoke-Sql "update public.gather_members set status='approved',role='admin' where church_id='f3100000-0000-4000-8000-000000000001';" ('restore-' + $isolation.Replace(' ', '-'))
    }
    Invoke-Sql @'
insert into auth.users(id,email,email_confirmed_at) values
('f3000000-0000-4000-8000-000000000003','race-editor@example.invalid',now());
insert into public.gather_members(church_id,user_id,role,status) values
('f3100000-0000-4000-8000-000000000001','f3000000-0000-4000-8000-000000000003','editor','approved');
'@ 'editor-race-fixture'
    foreach ($case in @(
        @{ Isolation = 'read committed'; Change = "status='revoked'"; Name = 'editor-revoked-read-committed' },
        @{ Isolation = 'repeatable read'; Change = "status='revoked'"; Name = 'editor-revoked-repeatable-read' },
        @{ Isolation = 'read committed'; Change = "role='viewer'"; Name = 'editor-demoted-read-committed' }
    )) {
        Invoke-Sql "update public.gather_members set status='approved',role='editor' where user_id='f3000000-0000-4000-8000-000000000003';" ('restore-' + $case.Name)
        $changingMember = "begin; update public.gather_members set " + $case.Change + " where user_id='f3000000-0000-4000-8000-000000000003'; select pg_sleep(2); commit;"
        $waitingWrite = @'
set application_name='gather-race-editor';
begin isolation level REPLACE_ISOLATION;
set local role authenticated;
select set_config('request.jwt.claim.sub','f3000000-0000-4000-8000-000000000003',true);
update public.gather_planners set data=jsonb_set(data,'{unauthorized_race_write}','true'::jsonb),version=version+1
where id='f3100000-0000-4000-8000-000000000001' and version=0;
commit;
'@
        $waitingWrite = $waitingWrite.Replace('REPLACE_ISOLATION', $case.Isolation)
        $jobA = Start-SqlJob $changingMember ($case.Name + '-member-change')
        Start-Sleep -Milliseconds 500
        $jobB = Start-SqlJob $waitingWrite ($case.Name + '-waiting-write')
        Wait-SqlBlock 'gather-race-editor'
        Wait-SqlJob $jobA ($case.Name + '-member-change') $true
        Wait-SqlJob $jobB ($case.Name + '-waiting-write') $false 'approved church editor is required|editing access changed|could not serialize access'
        Invoke-Sql @'
do $$ begin
  if not exists (select 1 from public.gather_planners
    where id='f3100000-0000-4000-8000-000000000001' and version=0
      and not (data ? 'unauthorized_race_write')) then
    raise exception 'Unauthorized concurrent save changed planner data or version';
  end if;
  raise notice 'PASS: concurrent access removal leaves planner JSON/version unchanged';
end $$;
'@ ($case.Name + '-preservation')
    }
    Write-Output 'PASS: local PostgreSQL migrations, bootstrap, public privacy, RLS/RPC, and concurrency checks complete.'
}
finally {
    if ($server) {
        & $pgctl -D $dataRoot -m fast -w stop
        if ($LASTEXITCODE -ne 0) { Write-Warning "Could not stop temporary server. Data directory: $dataRoot" }
    }
    if ($KeepFiles) {
        Write-Output "Temporary test files: $testRoot"
    } elseif (-not $server -or $server.HasExited) {
        # Verify the absolute generated target before this recursive removal.
        $resolved = [System.IO.Path]::GetFullPath($testRoot)
        $parent = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
        if ((Split-Path -Parent $resolved) -ne $parent -or (Split-Path -Leaf $resolved) -notmatch '^gather-sql-[a-f0-9]{32}$') {
            throw "Refusing cleanup outside the generated temporary test directory: $resolved"
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
