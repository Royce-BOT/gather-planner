# Gather — Worship & Ministry Planner

Gather remains a static HTML/CSS/JavaScript app backed by Supabase. Visitors can browse published worship schedules, themes, attendance locations, program order, and song titles immediately. Header buttons open the existing email/Google sign-in and registration forms. Password recovery, church approval, and the Admin workspace remain available. Existing service plans, ordered programs, volunteers, songs, printing, and private JSON backups use the same shared planner document.

**Source changes are local. The live Supabase migration/settings have not been applied, and no deployment was performed.** Complete the setup below before using this release.

## 1. Upgrade your existing database

1. Export a private backup from your existing Gather app and retain a database backup/snapshot if available.
2. Open your existing Supabase project → SQL Editor → New query.
3. **If approval and public viewing are already installed**, run only the complete [audit-hardening migration](migrations/20261013_audit_hardening.sql).
4. **If your database still uses the original `setup.sql` schema**, run the [member-approval migration](migrations/20261013_member_approval.sql), then the [public-view migration](migrations/20261013_public_view.sql), then [audit hardening](migrations/20261013_audit_hardening.sql). If approval is installed but public viewing is not, start with public viewing. Each upgrade checks its prerequisites.
5. Confirm each transaction succeeds. A failure rolls back that migration; retain the error and fix its cause. Keep RLS enabled.

**Do not rerun `setup.sql` on an existing installation.** It creates original tables and a new church. Only a completely new project needs `setup.sql` first, member approval second, public viewing third, and audit hardening fourth. Bootstrap a first admin afterward only if needed.

The upgrades preserve planner JSON, church IDs, and planner versions. The approval upgrade retains existing editor/viewer roles and approves their legacy memberships; new requests default to pending/viewer. Legacy request dates reflect the upgrade because the previous schema did not record them. The public migration never marks old records public. Audit hardening rechecks editor permissions during writes against concurrent revocation/demotion, makes the public projection ignore invalid calendar dates and duplicate IDs, and enforces the three root arrays on future writes. Its `NOT VALID` constraint leaves malformed historical rows intact; if the app refuses to load them, retain an owner-only database backup and prepare a reviewed correction before editing. Rerunning the upgrades preserves statuses, review timestamps, and planner records.

Authenticated users can read only their own membership. Church admins use restricted RPCs to list/review their church members. Private planner RLS permits reads only for approved, email-verified members and writes only for approved admins/editors. Profile metadata supplies display names only; church memberships determine roles. Signing in alone never grants editing permission.

The new `gather_public_planner(p_church_id)` RPC constructs an explicit JSON allowlist inside PostgreSQL. Anonymous visitors and authenticated accounts can execute it for the selected church. It never returns the original planner document or grants anonymous SELECT access to `gather_planners`/`gather_members`. Anonymous writes and privileged admin RPCs remain denied. The existing approval workflow, church boundaries, last-admin guard, and optimistic planner-version guard stay in force.

### Choose which records to publish

Sign in as an approved editor/admin and edit a service. Enable **Publish this schedule, theme, and program for visitors**, review the public fields, and enter a **Public attendance location (optional)** if visitors should see where to attend. Edit each song you want listed publicly and enable **Publish this song title for visitors**. The service title, date, time, theme, and program titles/order/durations become public when its publication flag is enabled. Review this text before publishing.

Existing records remain private until explicitly published, so the first public page may show an empty state. A private service location is never used as an attendance-location fallback. Leave the public attendance location blank to omit its text. Service preparation notes, volunteer contacts, song notes/keys/numbers, account emails, member records, and private backups never enter the public projection.

Program assignments remain private by default. Enable **Show this assignment in the public program when its service is published** on an individual program item only when its volunteer/person name is intended for public viewing. Publishing a service alone does not publish its assignments. The volunteer directory is always private.

The projection contract is `{ services: [...], songs: [...] }`. Service records allow only `id`, `title`, `date`, `time`, `theme`, `location`, and `program`; program items allow `title`, `minutes`, and optional explicitly published `person`; song records allow only `id` and `title`. Publication requires actual JSON booleans (`is_public: true` / `public_assignment: true`), never truthy strings. The client rejects unexpected/private response fields as an additional check; the database performs the privacy filtering before download.

## 2. Promote your existing account to first admin

If your approval upgrade already has an admin, skip this section. Otherwise:

1. Ensure your existing account's email is verified.
2. In Supabase Table Editor → `gather_planners`, copy your existing church's `id` UUID.
3. In Authentication → Users, copy your account's user UUID.
4. Open [sql/first-admin.sql](sql/first-admin.sql). Replace **both** `REPLACE_WITH_CHURCH_UUID` and `REPLACE_WITH_EXISTING_USER_UUID` with those explicit UUIDs.
5. Paste the edited file into SQL Editor and Run once as the project owner, after the upgrade. It refuses an unverified account or a church that already has an approved admin.
6. Sign in to Gather and click Refresh data; the Admin workspace appears.

No registrant automatically becomes an admin. Manage subsequent approvals/roles inside Gather. Add a second trusted admin so another admin can manage your own account. Self-review is denied, and the database protects the last approved admin against removal/demotion, including concurrent actions. Refresh a stale member list before retrying.

## 3. Public app configuration

Your existing project URL, public publishable key, and church UUID were preserved in [config.js](config.js), under `url`, `key`, and `churchId`. Keep them unless intentionally connecting to a separate test project. A new installation needs the Project URL, publishable key, and church UUID.

These are public browser values. Never put a `service_role` key, Supabase secret key, Google Client Secret, or SMTP password in browser code or GitHub. Google/SMTP secrets belong in Supabase dashboard settings.

Public visitors use the publishable key and the database `anon` role without creating an Auth account. **Do not enable Supabase Anonymous Sign-Ins for this feature.** Keep your existing email, Google, SMTP, Site URL, and redirect settings. The SQL migration installs the public RPC permissions; there is no public table policy to add manually.

This app has no build step. Plain browser JavaScript cannot automatically read Vercel environment variables; setting them alone will not configure Gather.

The Supabase browser SDK is pinned to **2.117.3** with a SHA-384 integrity hash and `crossorigin="anonymous"`. The hash was computed from the exact CDN file; a changed file fails to load. If updating it, review the official package/advisories, recompute integrity for the exact URL, and update `sdkUrl`, `sdkIntegrity`, and `script-src` in [vercel.json](vercel.json) together. If changing Supabase projects, also change the exact HTTPS/WSS origins in that file's `connect-src`. The local server reads the same policy. Google Fonts remains an external stylesheet/font dependency with system-font fallbacks.

## 4. Supabase email and redirect settings

In Authentication → Sign In / Providers (or Providers), enable Email, allow new signups, and keep **Confirm email enabled**. Set minimum password length to at least 8. Gather requires matching 8–128 character passwords for registration/recovery. See [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords).

In Authentication → URL Configuration, substitute your actual domain:

| Setting | Exact value/example |
| --- | --- |
| Site URL | `https://YOUR-SITE.vercel.app/` |
| Redirect URL: development | `http://localhost:3000/` |
| Redirect URL: production | `https://YOUR-SITE.vercel.app/` |
| Custom domain, if used | `https://YOUR-DOMAIN/` |

During local-only setup Site URL may be the localhost URL; change it to production when deploying. Gather returns to the current page with query/fragment removed for confirmation, Google, and reset. Match the path and trailing slash exactly. If you open `/index.html`, additionally allow `http://localhost:3000/index.html` and its production equivalent, or consistently open `/`. Other ports/preview domains need their own exact allowed URL. See [Supabase redirect configuration](https://supabase.com/docs/guides/auth/redirect-urls).

Keep the default confirmation and Reset Password email links using `{{ .ConfirmationURL }}`. This browser app handles implicit callback sessions and `PASSWORD_RECOVERY` on the same page; it has no server `/auth/confirm` route. Restore the relevant default templates if another app customized them. See [Supabase email template variables](https://supabase.com/docs/guides/auth/auth-email-templates).

Configure **Custom SMTP** before inviting ordinary church users. Supabase's default mail service restricts recipients to the project organization's team and has low sending limits. Signup/reset delivery may fail without SMTP. Follow [Supabase SMTP setup](https://supabase.com/docs/guides/auth/auth-smtp), keeping its credentials in the dashboard.

Email registration creates the Auth account first. After confirming email, the person signs in and creates a pending church request. Church approval never confirms email. Password recovery saves a new password and signs out so the person can sign in again.

## 5. Google authentication settings

1. In Google Cloud Console → Google Auth Platform configure Branding and Audience. While in Testing, add the Google accounts you will test to its test-user list.
2. Create an OAuth client with application type **Web application**.
3. Add Authorized JavaScript origins `http://localhost:3000` and `https://YOUR-SITE.vercel.app`, plus your custom domain if used. Origins have no path/trailing slash.
4. Add Authorized redirect URI `https://YOUR-PROJECT-REF.supabase.co/auth/v1/callback`. Copy the exact callback from Supabase's Google provider page. This Google callback goes to Supabase; final app URLs belong in Supabase's allowlist.
5. In Supabase Authentication → Sign In / Providers → Google, enable Google and save the OAuth Client ID/Client Secret there. Leave skip-nonce-check disabled; Gather uses the OAuth redirect flow.

These settings follow [Supabase Google sign-in documentation](https://supabase.com/docs/guides/auth/social-login/auth-google). Google enters the same pending workflow. Repeated sign-ins preserve approved, rejected, and revoked memberships.

### Repeated token refreshes or a 429 error

If the browser shows `token?grant_type=refresh_token` repeatedly, followed by
`429 Too Many Requests`, inspect the warning immediately above it. A session
that "expires in" a negative number is already expired according to the browser.
An inaccurate device clock or an old OAuth return URL can cause this warning.
If even newly refreshed sessions appear expired, Gather pauses refresh handling
and keeps private records hidden instead of repeatedly verifying that session.

On the device running the browser, enable automatic date/time and check the
time zone. On Windows, use Settings → Time & language → Date & time → Sync now.
Close duplicate Gather tabs, allow the rate limit to recover, then open Gather's
normal address and start a fresh sign-in. Do not reopen a copied URL containing
OAuth session tokens. If the clock is correct and the problem remains, inspect
the failed request's Response tab for its error code; do not share access or
refresh tokens. See [Supabase Auth rate limits](https://supabase.com/docs/guides/auth/rate-limits).

## 6. Run locally

Install Node.js 22 or newer. In a terminal at this repository:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run audit:secrets
npm.cmd run dev
```

No npm dependencies need installing. On macOS/Linux use `npm` instead of `npm.cmd`. Open **http://localhost:3000/** and use Ctrl+C to stop. Actual authentication needs internet access for the SDK and Supabase. Do not open the app with `file://`.

Browser sign-in connects to the project configured in `config.js`. Use a separate test Supabase project for experiments that should not affect your church. Automated tests never connect to those live configuration values. The secret audit reads tracked/nonignored files, reachable Git blobs, and commit messages and reports only redacted locations/classifications/counts. Synthetic fixture matches are summarized by default; use `npm.cmd run audit:secrets -- --include-fixtures` for all redacted locations. A clean pattern scan is not proof that every possible credential or private record is absent.

| Access | Planner | Private backups | Member administration |
| --- | --- | --- | --- |
| Visitor or pending/rejected/revoked account | Published services/programs/song titles; public printing | Hidden | None |
| Approved viewer | Full private planner; view and print | Export | None |
| Approved editor | Full private planner; edit services/programs/volunteers/songs and publication settings | Export and import | None |
| Approved admin | Editor permissions | Export and import | Approve/reject, reconsider, revoke, change roles |

Pending/rejected/revoked users see a nonblocking approval notice with Check status while continuing to browse public content. Approval defaults to Viewer unless an admin explicitly chooses another role. Admin controls include search, status filters/counts, confirmations, and reviewer/date details. Logout clears private data, open editing forms, and admin handlers, then returns to public browsing.

Refresh data/Check status rechecks access. Focus, visibility changes, and a one-minute check also detect access changes while active. Database policies block future private access immediately; the interface updates when rechecked. Public loading/fetch errors have visible feedback and a retry action. Shared planner edits load with Refresh data; there is no realtime push. Stale versions cannot overwrite newer saves. A rejected save reports **Not saved**; an ambiguous network/response failure reports **Save not confirmed**. Gather reloads server data before further editing, so check it before retrying. Invalid form drafts stay open for correction. Backup imports require valid JSON/model data, safe property names and a file no larger than 10 MiB. Import replaces the shared planner, including its publication choices, so coordinate imports.

## 7. Verification: local results and live checklist

Locally passed:

- JavaScript syntax checks and **111 Node tests**, with mocked Auth/RPC responses and a small DOM harness plus actual local-server HTTP checks: public/role boundaries, email/Google/recovery and session races, account-bound private reads, existing planner/admin features, stale or ambiguous saves, invalid draft/calendar/import validation, coalesced refreshes, future-service selection, admin cleanup/role drafts, credential redaction, CSP/config consistency, static route restrictions, and expired-session refresh-loop handling. See [AUDIT.md](AUDIT.md) for evidence and scope.
- PostgreSQL 18 in a new isolated local cluster: **130 security assertions** (81 core permission/member checks plus 49 public-interface checks), nine migration/bootstrap preservation checks, and six two-connection concurrency scenarios. Public checks execute anonymous/pending/viewer/editor/admin roles, verify exact projection contents and omission of private fields, deny anonymous writes/private reads and pending edits, allow editor writes, and preserve church/last-admin protection. Concurrency cases cover admin RPC revocation, owner demotions, and editor saves racing revocation/demotion under Read Committed/Repeatable Read. Rejected writes leave planner JSON and versions unchanged.

Mocked client denials alone do not prove RLS. The local PostgreSQL checks execute actual RLS/RPCs, using a minimal `auth.users`/`auth.uid()` fixture and synthetic JWT claims. They do not exercise hosted Auth/PostgREST.

To repeat real SQL tests with installed Windows PostgreSQL:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File sql/test-local.ps1
# If installed elsewhere:
powershell -NoProfile -ExecutionPolicy Bypass -File sql/test-local.ps1 -PostgresBin "C:\path\to\PostgreSQL\bin"
```

The runner creates/removes a temporary local cluster and uses [sql/security-tests.sql](sql/security-tests.sql) and [sql/public-security-tests.sql](sql/public-security-tests.sql). It checks all three upgrade migrations and never connects to your live project.

**Rendered browser appearance, responsive layout, and screenshots remain unverified.** Client behavior was checked with the Node DOM harness. Check the finished app in your desktop and mobile browser during the manual checklist below.

After setup, run these remaining **live** checks with test accounts:

1. Open Gather in an incognito/logged-out browser. Confirm public loading/empty/error states, service/program/song browsing, clear Sign in/Register buttons, public printing, and desktop/mobile layout. Editing, volunteer directory, backups/import, and Admin controls should be hidden.
2. As an approved editor, publish a test service and song title, set a distinct public attendance location, and explicitly publish just one program assignment. Inspect the `gather_public_planner` response in browser Network tools while logged out: only the documented allowlist should appear. Private locations/notes/contacts/emails/member rows/backups and unmarked assignments must be absent. Unpublish it and confirm it disappears after Refresh schedules. Anonymous direct private-table reads, writes, and admin RPCs must fail.
3. Register, receive/confirm the email, and sign in. Before confirmation no church request should exist. Afterwards the person sees a pending notice and public content without any private planner fetch. Direct private reads/edits must fail. Sign in with Google; confirm redirects, the same pending workflow, saved-session restoration, and a cancelled OAuth callback that can be dismissed.
4. As admin approve as Viewer; Check status should reveal existing private records read-only. A direct planner update using that person's authenticated token must fail. Approve another test account as Editor and verify authenticated edits/publication. Editor member-list/review RPCs and cross-church private reads/admin actions must fail.
5. Reject/reconsider/revoke access; later sign-ins must preserve statuses and public browsing. Recheck a revoked session and confirm protected records/forms disappear. Self-review/last-admin removal must fail; test simultaneous admin actions.
6. Receive/follow a password-reset email, save a matching new password, and sign in again. Cancel recovery to return to public browsing. Expired links should show useful feedback.
7. In two editor sessions, save in one and attempt a stale save in the other: it must report a conflict. Verify service/program/volunteer/song editing, assignment/order, private printing, and backups. Logout must clear protected records/forms/Admin handlers while keeping public schedules available.

**Live migration application, email delivery/verification, Google consent/redirects, hosted RLS/PostgREST, and deployment remain unverified.**

## 8. GitHub/Vercel deployment

1. Run the checks, review changes, then commit/push to your GitHub repository.
2. Import/retain the repository's Vercel Git integration. Keep repository root and Framework Preset **Other**. [vercel.json](vercel.json) specifies empty build/install commands and Output Directory **`.`**, allows only the public app files, and adds security headers. [.vercelignore](.vercelignore) also restricts uploads. Retain both files; a generic static host serving the whole repository root does not apply this protection. See [Vercel configuration](https://vercel.com/docs/project-configuration/vercel-json) and [deployment exclusions](https://vercel.com/docs/deployments/vercel-ignore).
3. Deploy through Vercel. Set the actual production URL in Supabase Site URL/Redirect URLs and Google's origins.
4. Perform the live checklist before inviting your church.

Public source assets are `index.html`, `style.css`, `config.js`, `planner.js`, `render.js`, `auth.js`, `access.js`, `admin.js`, and `app.js`, plus `assets/gather-logo.png`, `assets/gather-icon-192.png`, and `assets/gather-icon-32.png`. The logo appears in the sidebar and sign-in screen; the smaller icons also supply the browser/touch icons. Its creation prompt is recorded in [assets/logo-design.md](assets/logo-design.md), which stays outside the public asset allowlist. Keep privileged credentials and private backups out of every repository file. Local test artifacts under `.local-qa` should not be committed. `.gitignore` excludes new environment files and private backups; it does not erase files already committed in Git history.

After deploying when you choose to, check response headers and confirm `/README.md`, `/setup.sql`, `/.env`, `/sql/first-admin.sql`, and `/tests/app.test.mjs` return 404. Check the browser console for CSP/SRI errors, public loading, and all login methods. The deployment configuration and headers were tested locally; hosted Vercel behavior remains unverified.

For owner-only, read-only hosted database inspection, run [sql/verify-live-readonly.sql](sql/verify-live-readonly.sql) and compare its schema/grant/function results with the expected migrations. It outputs metadata and aggregate legacy-data health counts, with no private planner/member rows, routine bodies or setting values, and makes no changes. Quoted literals in policy/constraint definitions are redacted; custom object and argument names remain visible, so keep the output with the project owner. Any additional live functions/policies need review before claiming that hosted access matches the repository. If health counts identify malformed legacy data, retain an owner-only backup and review a correction before editing. Read [AUDIT.md](AUDIT.md) for findings, removals, verification limits, and remaining actions.
