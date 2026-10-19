# Gather developer guide

This guide covers the implementation, local development, database upgrades, authentication settings, deployment, and verification. See [README.md](README.md) for instructions for visitors, church members, editors, and admins.

Gather is a static HTML/CSS/JavaScript app backed by Supabase Auth and PostgreSQL. There is no application build step or custom application server in production. The Node server in this repository is a local static development server. The service-history and notification updates use existing data and require no new SQL migration or scheduled task.

## Architecture and file map

The browser loads the scripts in dependency order from `index.html`: configuration, model, views, access client, admin workspace, authentication, then the application controller. Modules expose small `window.Gather*` objects rather than using a bundler.

| File | Responsibility |
| --- | --- |
| [index.html](index.html) | App shell, navigation, account forms, edit dialog, script order, and accessible status notification |
| [style.css](style.css) | Navy & Sky theme tokens, responsive layouts, print rules, and notification animation |
| [config.js](config.js) | Public project URL, publishable key, church UUID, pinned SDK URL, and integrity hash |
| [planner.js](planner.js) | Model validation, escaping, safe import handling, public response validation, and service lifecycle calculations |
| [render.js](render.js) | Overview, service lists/programs, team/song views, publication badges, and finished banners |
| [access.js](access.js) | Membership and public RPC calls, private reads, versioned writes, response validation, and permission helpers |
| [auth.js](auth.js) | SDK loading, email/Google sign-in, registration, recovery, session restoration, and logout |
| [admin.js](admin.js) | Member review UI, role choices, status/search filters, confirmations, and handler cleanup |
| [app.js](app.js) | Shared state, navigation, editing, saves, public/private loading, access rechecks, imports/exports, and notifications |
| [migrations/](migrations/) | Upgrades for approval, public projection, and database hardening |
| [sql/](sql/) | First-admin bootstrap, isolated SQL tests, and read-only hosted verification |
| [tests/](tests/) | Node tests with mocked Auth/RPC/DOM fixtures and real local-server HTTP checks |
| [scripts/dev-server.mjs](scripts/dev-server.mjs) | Local static asset allowlist and deployment security headers |
| [scripts/audit-secrets.mjs](scripts/audit-secrets.mjs) | Redacted credential-pattern audit of repository files and reachable Git history |
| [vercel.json](vercel.json), [.vercelignore](.vercelignore) | Production routes, security headers, and upload restrictions |

### Theme

The Navy & Sky palette is centralized in `style.css` under `:root`. Use `--primary` for actions and branding, `--highlight` for selected items and banners, `--surface` for white panels, and `--ink` / `--muted` for readable text. Keep success, warning, and error tokens separate from decorative colors. Form controls use the darker `--control-border` for a visible boundary; cards and dividers use `--line`. Disabled controls use opaque colors, and keyboard focus uses a navy outline with an offset. The existing transparent logo supplies a CSS mask so the on-page mark follows the primary color without changing the original PNG files or Google's logo.

## Storage and access model

### Private planner document

Each church has one `public.gather_planners` row identified by its church UUID. Its `data` JSON document contains the `services`, `team`, and `songs` arrays; `version` is the shared optimistic-lock counter. Current and past services remain in the same `services` array. Import replaces the whole document rather than merging records.

`public.gather_members` holds church/user membership, role, approval status, display details, request/review timestamps, and an `updated_at` concurrency token. Supabase manages the underlying accounts in `auth.users`. Account metadata may supply a display name; it never determines church permissions.

| Account state | Private planner | Planner writes | Private backups | Member management |
| --- | --- | --- | --- | --- |
| Visitor, pending, rejected, or revoked | Denied; public projection only | Denied | Hidden | Denied |
| Approved, email-verified viewer | Read/print | Denied | Export | Denied |
| Approved, email-verified editor | Read/print | Allowed | Export/import | Denied |
| Approved, email-verified admin | Read/print | Allowed | Export/import | Own church only |

The UI permission helpers determine which controls to display. PostgreSQL policies and restricted functions enforce access independently of the UI. Keep RLS enabled. Authenticated users can select only their own membership directly; admins use RPCs to list or review members in their church.

### Public projection

Visitors do not download the private planner JSON. `GatherAccess.publicPlanner()` calls `gather_public_planner(p_church_id)`, which constructs an explicit field allowlist inside PostgreSQL. Both `anon` and `authenticated` can execute this function; anonymous private-table reads and all anonymous writes remain denied.

The response contract is `{ services: [...], songs: [...] }`:

| Record | Allowed fields |
| --- | --- |
| Service | `id`, `title`, `date`, `time`, `theme`, `location`, `program` |
| Program item | `title`, `minutes`, and optional explicitly published `person` |
| Song | `id`, `title` |

Only services and songs with the actual JSON boolean `is_public: true` are published. A program item's `person` is included only with `public_assignment: true`; publishing a service alone does not publish assignments. Truthy strings do not enable publication. Public `location` comes from the separate public attendance location; the private service location is never its fallback.

Private preparation notes, volunteer contact information/directory, account emails, memberships, song notes/keys/numbers, unmarked assignments, and backups are excluded at the database boundary. The client also rejects unexpected public response fields, but this validation is an additional check after the database projection. Do not replace the RPC with anonymous SELECT permission on `gather_planners`.

Existing records stay private until an editor/admin explicitly publishes them. An empty public page can therefore be the expected result of a successful upgrade.

### Authentication and private loading

The public page starts loading without a forced sign-in screen. `auth.js` loads the pinned Supabase browser SDK and creates one public client with persisted sessions, automatic token refresh, URL-session detection, and the implicit OAuth flow.

Email registration creates the Auth account first. The user confirms their email, then signs in. Google uses the same church approval workflow. `GatherAccess.refresh()` verifies the account using `auth.getUser()`, requests/reads membership through `gather_request_access`, and fetches `data,version` only when the membership is approved. Repeated sign-ins preserve existing approved, rejected, and revoked statuses and reviews.

The controller keeps public and private data separate. Request epochs and account identity checks prevent a stale asynchronous response from restoring an earlier account's private data. Logout/access loss clears private records, edit forms, import state, admin handlers, and notifications, while leaving public browsing available.

Focus, visibility changes, and a one-minute check recheck membership while the page is active. The database enforces future requests using current permissions; already downloaded data disappears from the interface when access is rechecked. Shared planner changes use **Refresh data** rather than a realtime push subscription.

### Administration and database guards

`gather_list_members` and `gather_review_member` require an approved, email-verified admin in the requested church. Reviews carry the member's `updated_at` value so stale actions fail. Admins cannot review themselves. Approval defaults to Viewer unless another role is explicitly selected.

Membership changes serialize through church lock rows in the private schema. The membership trigger protects the last approved admin, including privileged direct membership changes and user-deletion cascades. Planner writes use the same church lock plus fresh authorization checks to prevent a save waiting on concurrent revocation/demotion from succeeding with stale editing permission. Stronger-isolation transactions conflict through the lock revision. Whole-church deletion intentionally removes its members.

## Save, validation, and notification behavior

An edit updates the in-memory document, then `save()` validates a cloned snapshot. `GatherAccess.save()` updates the church row only when its `version` equals the version loaded by the client, sends `version + 1`, and verifies the returned version. The database also requires a one-step version increment. A stale editor cannot silently overwrite a newer save.

A confirmed save updates the controller's confirmed snapshot and displays **Saved**. A rejected save reports **Not saved**; an ambiguous request/response failure reports **Save not confirmed**. On failure, the controller restores its last confirmed snapshot and reloads server data before further editing. An uncertain result may already have reached the server, so inspect the reloaded plan before retrying.

Notifications remain visible for most of a six-second interval, then fade during its final 600 milliseconds. A new notification restarts the timer/animation. Reduced-motion preferences disable the animation while retaining timed dismissal. Logout clears the timer and message immediately.

`GatherPlanner.validate()` checks loaded/edit/import data, IDs, real calendar dates, times, whole-number durations, publication booleans, unsafe keys, and nesting. Invalid form drafts remain open for correction. Backup imports require valid model data, safe property names, and a file no larger than 10 MiB. Exports include the entire private document, including current and past services and publication choices.

## Service lifecycle and history

`GatherPlanner.serviceLifecycle(service, now)` calculates `finished`, `archived`, and `archiveDate` without mutating records. `localDate()` and the lifecycle helper use the browser's local calendar, avoiding UTC parsing and daylight-saving arithmetic.

- A service is finished when its date is before today's local date. Its scheduled time does not mark it finished during the same day.
- A service is archived on the same numbered date of the next calendar month, clamped to that month's final day.
- Invalid dates or clocks do not produce a finished/archive classification.

| Service date | Finished begins | Past programs begins |
| --- | --- | --- |
| September 19, 2026 | September 20, 2026 | October 19, 2026 |
| December 31, 2026 | January 1, 2027 | January 31, 2027 |
| January 31, 2027 | February 1, 2027 | February 28, 2027 |
| January 31, 2028 | February 1, 2028 | February 29, 2028 |

`render.js` partitions the same service array for **Current plans** and **Past programs**. Current plans sort by date/time ascending; past programs sort most recent first. The overview calendar and service count omit archived services. Search applies to the selected list. The program's Back target follows its calculated category, including after rescheduling a past service into the future.

The active page checks for a changed local date every minute and on focus/visibility changes. Reclassification performs no database write or history-specific request. Different device time zones can cross a cutoff at different moments. Service history does not delete records, alter permissions, unpublish services, or remove team/song records. Published history remains public until an editor/admin unpublishes it.

## Run locally

Use Node.js 22 or newer. No npm dependencies need installing. From the repository root:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:secrets
npm.cmd run dev
```

On macOS/Linux use `npm` instead of `npm.cmd`. Open **http://localhost:3000/** and stop the server with Ctrl+C. Authentication requires internet access for the SDK and Supabase. Use the HTTP server rather than opening `index.html` with `file://`.

Browser activity uses the Supabase project in `config.js`. Use a separate test project for experiments that should not affect church data. Automated Node tests use fixtures rather than the live project configuration.

The secret audit reads tracked/nonignored files, reachable Git blobs, and commit messages. It reports redacted locations/classifications/counts and summarizes synthetic fixture matches by default. Use `npm.cmd run audit:secrets -- --include-fixtures` to include all redacted fixture locations. A pattern scan cannot prove the absence of every possible credential or private record.

## Database installation and upgrades

### Existing installation

Export a private Gather backup and retain a database snapshot/backup if available. In the existing Supabase project's SQL Editor, run only missing upgrades, as the project owner (`postgres`), in this order:

1. [migrations/20261013_member_approval.sql](migrations/20261013_member_approval.sql)
2. [migrations/20261013_public_view.sql](migrations/20261013_public_view.sql)
3. [migrations/20261013_audit_hardening.sql](migrations/20261013_audit_hardening.sql)

If approval and public viewing are installed, apply only audit hardening if it is still missing. If approval alone is installed, begin with public viewing. Check the installed state before running SQL; the migrations also check prerequisites. Confirm each transaction succeeds; a failure rolls back that migration. Keep the error and address its cause before continuing.

**Do not rerun `setup.sql` on an existing installation.** It creates the original tables and a new church. The upgrades preserve existing church IDs, planner JSON, and planner versions. Rerunning the upgrades preserves membership statuses, review timestamps, and planner records, but does not replace verifying which upgrades are already installed.

The approval upgrade retains legacy editor/viewer roles and approves those memberships. New requests default to pending/viewer. Legacy request timestamps reflect the upgrade because the old schema did not record them. The public migration does not mark existing records public.

Audit hardening adds concurrent-write authorization checks, excludes invalid public calendar dates/duplicate IDs, and enforces the document's three root arrays on future writes. Its `NOT VALID` constraint leaves malformed historical rows intact. If the client refuses such a document, keep an owner-only database backup and prepare a reviewed correction before editing; do not reset or discard the planner.

### Completely new project

Run [setup.sql](setup.sql) once, retain the returned church UUID, then run all three upgrades in the order above. Configure that UUID in `config.js`. Bootstrap the first approved admin only after the upgrades.

### First-admin bootstrap

Skip this step when the church already has an approved admin. Subsequent promotions belong in the Admin workspace.

1. Create/sign in to the intended account and ensure its email is verified.
2. Copy the existing church UUID from `gather_planners.id` and the account UUID from Supabase Authentication → Users.
3. Open [sql/first-admin.sql](sql/first-admin.sql), replacing both `REPLACE_WITH_CHURCH_UUID` and `REPLACE_WITH_EXISTING_USER_UUID` with those explicit UUIDs.
4. Run the edited script once in SQL Editor as the project owner. It refuses an unverified user or a church that already has an approved admin.
5. Sign in and choose **Refresh data** to load the Admin workspace.

No registrant automatically becomes an admin. Keep a second trusted admin so another admin can manage your membership; self-review is denied and the last approved admin is protected against removal/demotion.

## Public browser configuration

[config.js](config.js) holds `url`, `key`, and `churchId`. Preserve the existing project values unless intentionally connecting to another project. New installations need the Project URL, public publishable key, and the church UUID.

These are public browser values. Never place a `service_role` key, Supabase secret key, Google Client Secret, or SMTP password in browser assets or Git history. Google/SMTP credentials belong in Supabase dashboard settings. Plain browser JavaScript does not automatically read Vercel environment variables, so setting them alone does not configure this app.

Public viewing uses the publishable key with the database `anon` role, without creating an Auth account. **Do not enable Supabase Anonymous Sign-Ins for this feature.** The public migration installs the RPC grants; no anonymous private-table SELECT policy should be added manually.

The Supabase browser SDK is pinned to **2.117.3**, loaded with a SHA-384 integrity hash and `crossorigin="anonymous"`. When upgrading it, review official package changes/advisories, recompute integrity from the exact CDN file, and update `sdkUrl`, `sdkIntegrity`, and `script-src` in `vercel.json` together. If changing projects, update the exact HTTPS/WSS origins in `connect-src` too. The local server uses the same security policy. Google Fonts remains an external dependency with system-font fallbacks.

## Authentication settings

### Email, redirects, and SMTP

In Supabase Authentication → Sign In / Providers (or Providers), enable Email, permit new signups, and keep **Confirm email enabled**. Set minimum password length to at least 8. Gather requires matching 8–128 character passwords for registration/recovery. See [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords).

Configure Authentication → URL Configuration with the actual app addresses:

| Setting | Example |
| --- | --- |
| Site URL | `https://YOUR-SITE.vercel.app/` |
| Development Redirect URL | `http://localhost:3000/` |
| Production Redirect URL | `https://YOUR-SITE.vercel.app/` |
| Custom-domain Redirect URL, if used | `https://YOUR-DOMAIN/` |

During local-only setup the Site URL may be localhost; change it for production. Gather returns to the current page without its query/fragment. Match the path and trailing slash. If using `/index.html`, allow that exact address too, or consistently open `/`. Other ports or preview domains require their own allowed return URLs. See [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).

Keep confirmation and Reset Password email links using `{{ .ConfirmationURL }}`. This browser app handles implicit callback sessions and `PASSWORD_RECOVERY` on the same page; it has no server `/auth/confirm` route. Restore the relevant default templates if another app customized them. See [Supabase email templates](https://supabase.com/docs/guides/auth/auth-email-templates).

Configure Custom SMTP before ordinary church users register. Supabase's default sender limits recipients to the project organization's team and imposes low sending limits; signup/reset delivery can fail without SMTP. Keep SMTP credentials in the dashboard. See [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp).

Church approval does not confirm an email address. Password recovery saves a new password, then signs out so the user can sign in again.

### Google sign-in

1. In Google Cloud Console → Google Auth Platform, configure Branding and Audience. While in Testing, add the accounts being tested to the test-user list.
2. Create an OAuth client of type **Web application**.
3. Add Authorized JavaScript origins for `http://localhost:3000`, `https://YOUR-SITE.vercel.app`, and any custom domain. Origins have no path or trailing slash.
4. Add Authorized redirect URI `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`, copying the exact value from Supabase's Google provider page.
5. Enable Google in Supabase Authentication → Sign In / Providers and save the Client ID/Client Secret there. Leave skip-nonce-check disabled.

The Google callback goes to Supabase; final app URLs belong in Supabase's redirect allowlist. Google sign-in still requires church approval and preserves existing membership status. See [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google).

## Verification and release checklist

### Recorded local results

On October 19, 2026, JavaScript syntax checks and **129 Node tests** passed, including 18 service-history regressions. The suite covers mocked Auth/RPC flows, account/session races, role boundaries, controller/view behavior, stale or ambiguous saves, validation/imports, admin cleanup, secret redaction, CSP/config consistency, and real local-server route checks. History tests cover month-end/leap-year cutoffs, finished banners, current/past filtering/order/counts/navigation, permission preservation, backups, and **Saved** feedback. Lifecycle checks also passed with Shanghai and New York time zones.

The October 13, 2026 SQL audit recorded **130 security assertions** in an isolated PostgreSQL 18 cluster: 81 core permission/member checks and 49 public-interface checks, plus nine migration/bootstrap preservation checks and six two-connection concurrency scenarios. These exercise actual RLS/RPCs using a minimal `auth.users`/`auth.uid()` fixture and synthetic claims. They include anonymous/pending/viewer/editor/admin access, exact public projection contents, denied writes, church/last-admin protections, and saves racing revocation/demotion. Rejected writes leave JSON and versions unchanged. The presentation/history updates added no migration and did not rerun that historical SQL suite.

To repeat the SQL checks with Windows PostgreSQL installed:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File sql/test-local.ps1
# If PostgreSQL is installed elsewhere:
powershell -NoProfile -ExecutionPolicy Bypass -File sql/test-local.ps1 -PostgresBin "C:\path\to\PostgreSQL\bin"
```

The runner creates/removes a temporary local cluster, tests all three upgrades, and uses [sql/security-tests.sql](sql/security-tests.sql) and [sql/public-security-tests.sql](sql/public-security-tests.sql). It does not connect to the live project. Mocked client tests do not prove database policies, and local SQL fixtures do not exercise hosted Auth/PostgREST.

These are recorded results, not a claim that every change or deployment has been verified. Local fixtures do not replace hosted desktop/mobile, print, and authentication checks. These source updates do not apply migrations, change hosted settings, or deploy the app. Use the checklist below to verify the full hosted release, including provider settings and end-to-end flows that local tests do not cover.

On October 20, 2026, the Navy & Sky update passed syntax checks and all **129 Node tests**. Headless Edge inspected 10 representative public, dashboard, planner/program, team, song, admin, and account screens at 1440, 390, and 320 CSS pixels using synthetic local fixtures. Those 30 combinations had no horizontal page overflow or sampled text-contrast failures. Browser checks also confirmed primary hover, keyboard focus, active and disabled states, the navy logo mask, and print visibility rules. These fixture checks cover presentation; they do not exercise live Google sign-in, email delivery, Supabase permissions, or a deployed site. Original PNG favicon and touch-icon files retain their original artwork and colors.

### Hosted/browser checklist

Use a separate test project and test accounts for writes or role changes:

1. Browse logged out/incognito. Check public loading/empty/error/retry states, schedules/programs/song titles, Sign in/Register, public printing, and desktop/mobile layout. Editing, team directory, backups/import, and Admin must be hidden.
2. Publish a service/song, set a distinct public attendance location, and mark only one assignment public. Inspect the logged-out `gather_public_planner` response for the exact allowlist. Confirm private locations/notes/contacts/emails/members/backups and unmarked assignments are absent. Unpublish and refresh. Direct anonymous private-table reads/writes/admin RPCs must fail.
3. Register and receive/confirm email. Before confirmation no church request should exist; afterwards the pending account should browse public content without a private fetch. Direct private reads/edits must fail. Test Google consent/redirects, persisted sessions, and dismissal of cancelled OAuth feedback.
4. Approve a Viewer and check status: private records become read-only and direct writes fail. Approve an Editor and verify saves/publication. Editor member-list/review RPCs and cross-church private/admin access must fail.
5. Reject/reconsider/revoke accounts and verify later sign-ins preserve status/public browsing. Recheck a revoked session and confirm private records/forms disappear. Check self-review, last-admin protection, stale member actions, and concurrent admin actions.
6. Receive a password-reset email, save a matching password, then sign in again. Check cancellation and expired links. Email delivery and Google flow require the actual hosted provider settings.
7. Use two editor sessions to check a stale-save conflict. Check services/programs/team/songs, assignments/order, printing, and backups. Logout must clear private records/forms/admin handlers and retain public browsing.
8. Create services dated today, yesterday, and one calendar month ago. Verify finished status, current/past filters, overview counts/calendar, sorting/search, and the month-end examples above. Reschedule an archived service into the future and check its Back target. Published history stays public; unpublished history stays private; viewer controls stay read-only; backups retain all services.
9. Check **Saved** after a successful edit and its fade/dismissal, a replacement message restarting its timer, reduced-motion behavior, and immediate message cleanup on logout.

For owner-only read-only hosted inspection, run [sql/verify-live-readonly.sql](sql/verify-live-readonly.sql) and compare installed schema/grants/functions with the migrations. It outputs metadata and aggregate legacy-data health counts, without private planner/member rows, routine bodies, or setting values. Policy/constraint literals are redacted; custom names remain visible, so retain output with the owner. Extra live functions/policies need review. If malformed-data counts appear, retain an owner-only backup and review a correction before editing.

## Deployment

When a release is authorized, run checks, review the diff, and commit/push through the repository's Vercel Git integration. Use repository root, Framework Preset **Other**, and Output Directory **`.`**. `vercel.json` specifies empty install/build commands, exact public routes, and security headers; `.vercelignore` restricts uploads. Keep both. A generic static host serving the entire repository root does not apply these restrictions. See [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json) and [deployment exclusions](https://vercel.com/docs/deployments/vercel-ignore).

The public asset allowlist contains `index.html`, `style.css`, `config.js`, `planner.js`, `render.js`, `auth.js`, `access.js`, `admin.js`, `app.js`, and three images: `assets/gather-logo.png`, `assets/gather-icon-192.png`, `assets/gather-icon-32.png`. Developer documentation, SQL, tests, backups, and local QA artifacts must remain outside public routes.

Keep privileged credentials/private backups out of the repository. Do not commit `.local-qa` artifacts. `.gitignore` excludes new environment files/private backups; it cannot erase already committed Git history.

After an authorized deployment:

1. Set the actual production Site URL/redirects in Supabase and origins in Google.
2. Check response security headers and confirm `/README.md`, `/DEVELOPER.md`, `/setup.sql`, `/.env`, `/sql/first-admin.sql`, and `/tests/app.test.mjs` return 404.
3. Check the console for CSP/SRI failures, then perform the hosted/browser checklist before inviting users.

Local route/header tests do not establish hosted Vercel behavior. Verify the deployed version when investigating a report; a correct workspace fix does not update an older deployment by itself.

## Troubleshooting authentication refresh loops

Repeated `token?grant_type=refresh_token` requests followed by `429 Too Many Requests` can accompany a browser warning that a session expires in a negative number. Check automatic device date/time and time zone, an old OAuth return URL, and the failed request's response error. If refreshed sessions still appear expired, Gather pauses session refresh handling and hides private records instead of continuously re-verifying the session.

On Windows, use Settings → Time & language → Date & time → Sync now. Close duplicate app tabs, let the rate limit recover, and start a fresh sign-in from the normal app address. Do not reopen or share URLs containing OAuth session tokens; do not share access/refresh tokens from Network tools. If the clock is correct, inspect the actual response error before assuming a cause. See [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).
