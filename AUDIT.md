# Gather audit — 2026-10-13

This audit changes the existing buildless app locally. Initial Git status was clean at `2628577`; there were no user edits to overwrite. No project-specific `AGENTS.md` was found. Existing public browsing, email/password and Google authentication, recovery, member approval, church roles, service/program/team/song planning, printing, and private backups remain part of the app. No framework or npm runtime dependency was introduced.

No live database was changed, no deployment or push was performed, no credentials were rotated, and Git history was not rewritten. Database changes require the owner to apply the migration described below. This report records source findings and local verification, not a guarantee about the hosted project.

## Ranked security findings

| Severity | Confirmed finding or review limit | Fix / required action |
| --- | --- | --- |
| Medium | An editor UPDATE already waiting on a planner row could complete after a concurrent membership revocation committed. RLS authorization from the original statement snapshot was insufficient for this race. Reproduced with two real local PostgreSQL connections. | The audit migration adds a write guard that rechecks verified, approved editor/admin access around the church/revision lock. Revocation and demotion tests reject stale writes without changing JSON/version. Existing RLS and optimistic versions remain enabled. |
| Medium | Authentication lifecycle races allowed old session results to override later events; a natural `SIGNED_OUT` event also prevented a later cross-tab sign-in. Failed sign-out/recovery handling could allow session restoration contrary to the user's action. | Auth action/session generations, deduplicated sign-out, retained recovery markers, and a per-tab sign-out suppression flag protect restoration and overlapping actions. Markers contain a user ID or boolean, not access tokens. Hosted Auth behavior still needs the manual checklist. |
| Medium | Admin cleanup could retain member markup and handlers after lost permission; remounts could reset busy state and repeat requests. | Immediate member DOM/handler cleanup, permission-aware clearing, and idempotent mounting. Late results are discarded. RPC authorization remains authoritative. |
| Medium | Backup imports did not reject unsafe nested property names or enforce file/depth limits. This was an input-hardening gap; no production exploitation was observed. | Reject prototype-sensitive keys, excessive nesting and files over 10 MiB before installing imported data. Existing valid backups and publication flags remain supported. |
| Medium | No deployment CSP/frame/referrer policy was configured. Serving the entire repository root through a generic static host could expose future local SQL, test or backup files. No private production backup was found in current tracked files. | `vercel.json` adds restrictive headers and a public-asset route allowlist; `.vercelignore` restricts uploads. The local server applies the same headers and serves only approved assets. Actual hosted enforcement remains unverified. |
| Medium, conditional | Three historical `app.js` blobs contain an old hardcoded initializer with person/volunteer names and two preparation notes. Contacts are empty and no account emails were detected there. These appear to be default/demo records; their real-world status cannot be determined from source. | Owner should privately inspect history objects `2ac7d95f97f4` (line 73), `c3a8b838449d` (line 73), and `8d32879443d1` (line 1). They are absent from the current production source. Any history-removal decision needs explicit authorization. No values are reproduced here. |
| Low | The SDK URL floated at `@2` and had no content integrity check. This audit found no evidence of a compromised SDK. | Pin Supabase JS `2.117.3`, check SHA-384 SRI, and require anonymous CORS. Update URL/hash/CSP together when upgrading. |
| Review limit | The actual hosted schema may have additional functions, policies, defaults or grants not present in this checkout. Hosted Supabase Auth/Google/Vercel were not tested. | Run `sql/verify-live-readonly.sql`, review unexpected objects, then use separate test accounts for the README live checklist. |

No privileged credential candidate was found by the scoped repository/history scan. The Supabase publishable key, project URL and church UUID are public browser configuration, not administrative secrets. The scanner distinguishes publishable/anonymous keys from secret/service-role keys and reports only locations, classifications and counts. Synthetic test emails and private-field fixtures are marked separately; high-confidence privileged credential patterns remain actionable even in test files.

The scan covered nonignored working files, all **30 unique reachable Git blobs**, and commit messages in **five reachable commits**, including deleted files. It does not establish that ignored files, remote-only or unreachable Git objects, encoded/encrypted data, or author metadata contain no private information. Commit author email metadata is not an app account record. No credential rotation is warranted solely because public Supabase configuration is present.

## Access boundaries retained

Anonymous and pending/rejected/revoked accounts use only `gather_public_planner(p_church_id)`. The SQL projection returns explicit public service/program/song fields; it never downloads the private JSON and then hides fields in JavaScript. Publication flags must be JSON booleans. Member-only locations have no public fallback, assignments require their own explicit publication flag, and the volunteer directory, contacts, membership emails, preparation notes and backups remain private.

Approved, email-verified members can read the private planner; only approved editors/admins can write. Membership metadata does not choose roles. Admin list/review RPCs require an approved, verified admin in the same church, deny self-review and stale updates, and preserve verified last-admin protection under concurrent actions. Anonymous writes, viewer writes, pending/rejected/revoked access, role escalation, metadata spoofing, unauthorized RPC calls and cross-church access are exercised by local SQL tests. Trigger functions/private helpers have restricted execution; security-definer functions use explicit schemas and empty search paths.

## Confirmed reliability fixes and refactoring

- Auth retry reuses the existing client/subscription instead of creating duplicates. Startup and rechecks discard obsolete results. Overlapping login/logout actions and recovery cancellation failures have focused regressions.
- Admin role selections survive search/status redraws. Remounting preserves filters and in-flight work. Cleanup removes private markup immediately; failed access rechecks show feedback instead of rejecting an unhandled promise.
- Calendar validation rejects impossible dates, invalid years/times, duplicate IDs, unsafe nested property names and invalid program durations. The database projection skips malformed historical public entries rather than returning a response that breaks browsing. A `NOT VALID` root-shape constraint preserves old rows while enforcing future document writes.
- Invalid form drafts previously changed the in-memory planner and closed before validation. Edits now validate a candidate first and keep the form open on error. A missing save version response could previously show success; save now requires exactly the expected next version, and ambiguous network failures say **Save not confirmed**.
- Repeated refreshes previously duplicated requests and reset private program navigation; loads now coalesce for the same account/epoch. The overview previously labeled a past service as the next gathering when every service was historical; it now chooses by the actual service date/time and retains the archive. Async event actions use a shared rejection handler.
- Private refreshes are tied to the verified account ID. If a later user lookup belongs to a different account, protected requests stop before membership/planner loading, the old workspace clears, and Auth re-verifies the active identity.
- `config.js` centralizes the preserved public configuration and SDK pin. `planner.js` centralizes model/public-response validation, escaping, calendar formatting and readable error messages. `render.js` creates view markup separately from application state and event handling. Auth and Admin use the same shared helpers.

The app never treats registration or a successful login as editor approval. Protected frontend controls supplement database permissions. A failed or ambiguous network save cannot be presented as confirmed success; the server's expected-version condition and version trigger still prevent stale overwrites.

## Removals and retained uncertainty

- Removed the floating `@2` SDK URL: the configured exact URL/SRI replaces its only active load path.
- Removed the retry branch that rebuilt an Auth client/subscription: retry now reuses the existing instance.
- Removed duplicate HTML escaping implementations after replacing their active callers with the shared model helper.
- Moved renderer/date/validation logic to active shared files; the HTML script order and local/hosting asset allowlists include those files. This is extraction of used code, not deletion of a planner feature.
- Replaced the sole generated inline heading style with a stylesheet class so the restrictive CSP can apply.

No migration history, planner records, backups, configuration or active workflow was deleted. The base schema and both earlier upgrades remain required for fresh installs. No stylesheet was deleted merely because usage was uncertain. Historical initialization records remain in Git pending owner review.

## Important changed files

| Files | Purpose |
| --- | --- |
| `app.js`, `render.js`, `planner.js`, `config.js`, `index.html`, `style.css` | Shared model/configuration and view extraction; lifecycle, validation and event fixes; required script/style references. |
| `auth.js`, `admin.js`, `access.js` | Authentication/admin races, protected cleanup, duplicate request prevention, shared validation and matching RPC contracts. |
| `migrations/20261013_audit_hardening.sql` | Concurrent permission recheck on planner writes; safe public calendar/deduplication; future root-array constraint without rewriting old data. |
| `sql/verify-live-readonly.sql` | Owner-only, read-only schema/grant/function/trigger inspection and aggregate data-health counts; no private planner/member rows, routine bodies or setting values. |
| `sql/security-tests.sql`, `sql/public-security-tests.sql`, `sql/test-local.ps1`, `tests/*.test.mjs` | Synthetic regression and actual local RLS/concurrency tests. |
| `vercel.json`, `.vercelignore`, `scripts/dev-server.mjs`, `tests/server.test.mjs` | Shared headers and public-file allowlists for local/hosted static serving. |
| `scripts/audit-secrets.mjs`, `tests/secrets.test.mjs`, `.gitignore`, `package.json` | Redacted scoped history/config audit, credential classification and local checks. |
| `README.md`, `AUDIT.md` | Exact migration/configuration order, operations, evidence and limits. |

## Dependency and hosting review

There are **zero direct npm dependencies** in this repository and no bundle/build step. Browser dependencies are the pinned Supabase UMD SDK and Google Fonts. The downloaded SDK's exact 217,907 bytes produced the configured SHA-384 hash. The public npm registry confirmed the `2.117.3` package and its five Supabase sibling versions; npm's bulk-advisory endpoint returned no advisories for those versions, `tslib 2.8.1`, and `@supabase/phoenix 0.4.5` queried on 2026-10-13. `iceberg-js` is declared with range `^0.8.1`; its exact resolved CDN transitive version was not established, so this is a scoped dependency check, not a full signed dependency attestation.

The former auth-js [CVE-2025-48370 advisory](https://github.com/supabase/auth-js/security/advisories/GHSA-8r88-6cj9-9fh5) lists affected versions through `2.69.1` and patched `2.70.0`; the selected auth-js version is outside that range. The [current Supabase JS advisory page](https://github.com/supabase/supabase-js/security/advisories) had no published advisories at review. See the [official package metadata](https://registry.npmjs.org/@supabase/supabase-js/2.117.3) and [Supabase installation documentation](https://supabase.com/docs/reference/javascript/installing). Absence of a published advisory is not proof that no vulnerability exists.

The CSP permits the exact SDK URL, local scripts/styles, Google font resources and the configured Supabase HTTPS/WSS origins. It denies framing, arbitrary script sources, inline scripts and `eval`, and sets base/object/form restrictions. Headers are checked on local success and error responses. Route simulation checks deny repository paths, writes, partial filename matches and unexpected subpaths. The local server also verifies every current HTML script/stylesheet reference can load. Hosting setup follows [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json) and [file exclusions](https://vercel.com/docs/deployments/vercel-ignore); applying those settings on the deployed site still requires verification.

## Verification and limitations

- JavaScript syntax check passed. The integrated Node suite passed **105 tests**, including behavioral regressions with mocked Auth/RPCs and a small DOM harness, calendar/import validation, invalid draft retention, incomplete/ambiguous save responses, account-bound/coalesced loads, future-service selection, redacted secret classifications, actual local HTTP responses, and static route-policy checks.
- Isolated PostgreSQL 18: **130 SQL assertions** (81 core permission/member checks plus 49 public-interface checks), **nine preservation checks**, and **six two-connection concurrency scenarios** passed. These cover last-admin/admin races and writes racing revocation/demotion under Read Committed/Repeatable Read. Rejected writes leave planner data/version unchanged.
- Migration/bootstrap reruns preserve planner JSON, version, roles, status and review timestamps, including intentionally malformed historical test rows. Synthetic fixtures use a minimal local `auth.users`/`auth.uid()` setup and database roles; they do not emulate all hosted Auth/PostgREST behavior.
- SDK metadata/bytes, advisory queries, source contract review and local HTTP checks are separate from a real rendered-browser end-to-end test.

Hosted Supabase/PostgREST, email/SMTP delivery, Google consent/redirects, recovery email links, saved-session behavior across actual browser tabs, rendered desktop/mobile layout, print dialogs and deployed Vercel headers remain unverified. No production tests were run.

## Migration/configuration and remaining actions

1. If approval and public viewing are installed, run only `migrations/20261013_audit_hardening.sql` as the project owner in Supabase SQL Editor. Otherwise follow `member_approval` → `public_view` → `audit_hardening`. A new database alone needs `setup.sql` before those files. Bootstrap `sql/first-admin.sql` afterward only if no approved admin exists. Do not reset the database or rerun the base schema on an existing church.
2. Keep Email confirmation, Google provider, SMTP and existing allowed redirects. Public browsing does not require anonymous Auth sign-ins. Keep the public values in `config.js`; if changing project/SDK, update the matching `vercel.json` CSP origins/URL and the SDK integrity hash.
3. Run `npm.cmd run check`, `npm.cmd test`, `npm.cmd run audit:secrets`, then `npm.cmd run dev`; open `http://localhost:3000/`. No npm packages need installing. See README for the isolated PostgreSQL runner.
4. Use the owner-only, read-only hosted verification script, then run the README live checklist with separate test accounts. The script outputs metadata and aggregate health counts, not private planner/member rows, routine bodies or setting values. Quoted literals in policy/constraint definitions are redacted; custom object and argument names remain visible, so keep this output with the project owner. Review any unexpected exposed function/policy before relying on source-only access claims. Check Admin last-admin actions against the database: the UI member list does not include every verification fact used by the server guard.
5. Privately confirm whether the historical initializer's people/notes are demonstrations or real records. Decide on any history cleanup separately; changing current source alone cannot erase past commits.
6. Deploy only when you choose to. Retain the Vercel config/file allowlists, then verify response headers, blocked repository paths, SDK SRI/CSP loading, auth redirects, public privacy, conflict handling and mobile/print rendering before inviting users.

If a read-only review or a private load reveals malformed historical planner data, preserve an owner-only database backup and prepare a reviewed correction. The audit migration intentionally leaves those rows intact; it does not silently normalize dates, remove records, or rewrite planner versions.

## Follow-up: repeated token refreshes, 2026-10-13

A browser screenshot showed repeated successful token refresh/user requests,
then HTTP 429, with an OAuth session expiry already far in the past relative to
the browser clock. Read-only hosted Auth logs confirmed repeated refreshes and
`over_request_rate_limit`. The screenshot does not establish the cause of the
earlier Google-hosted 401 page or conclusively distinguish an inaccurate device
clock from stale callback data.

Source inspection and an isolated experiment with the pinned SDK confirmed an
amplification path: parameterless `getUser()` checks the locally stored expiry,
refreshes, emits `TOKEN_REFRESHED`, and causes Gather to verify again. If every
fresh token still appears expired, that chain repeats. `auth.js` now verifies an
event's access token directly with the Auth server and still checks the expected
user ID. Fresh refresh events with unusable expiry pause once, clear protected
workspace access, and show date/time/session guidance. Reentrant events remain
blocked until an explicit retry or new login has usable timing. Recovery markers
are preserved. Guard-owned refresh controls are serialized and retain foreground
visibility handling when resumed.

The integrated suite now passes **111 JavaScript tests**, including **36 Auth
tests** and six new regressions for this failure, retry, recovery, and delayed
refresh restart behavior. Syntax and whitespace checks pass. No SDK files,
database schema/data, rate limits, or live Auth settings were changed. These
source changes remain local; the reported browser flow still needs retesting
after checking the device clock and starting a fresh sign-in.
