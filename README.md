# Gather — Supabase setup

This package replaces app.js and keeps your existing HTML/CSS. Email/password login is injected by app.js, so no HTML script changes are needed. The Supabase JS v2 client loads from jsDelivr. Keep an internet connection available.

## 1. Back up before replacing
Export a backup from your current Gather app. Keep a copy of your old app.js. The new version starts with an empty database and does not automatically upload sample or browser data. Your original browser data is left intact.

## 2. Create the database
Create a project at https://supabase.com/dashboard. Open SQL Editor, paste setup.sql, and Run once. Copy the UUID returned by the insert. If already run, get the id from the gather_planners table instead. Do not rerun setup.sql on an existing installation.

## 3. Configure app.js
Replace the three placeholders at the very top:

```js
const SUPABASE_URL = 'https://YOUR_PROJECT.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'YOUR_PUBLISHABLE_KEY';
const CHURCH_ID = 'UUID_RETURNED_BY_SETUP';
```

Copy your Project URL and publishable API key from the project Connect dialog or Settings > API Keys. Do not use a secret or service_role key. These three configuration values are intentionally visible in browser code; access is enforced by SQL policies, not by hiding the URL/key.

Replace app.js in your existing project with this one. Keep index.html and style.css alongside it. Test using VS Code Live Server, not file://.

## 4. Configure email authentication
In Supabase Authentication, enable email/password sign-in. Set Site URL to your deployed Vercel URL and add the exact localhost/Live Server URL you use under allowed Redirect URLs. Keep email confirmation enabled if you want confirmed addresses. Signup uses Supabase's configured Site URL for email confirmation redirects. This version supports signup, signin, and logout; a password-reset screen is not included. Administrators can use Supabase's dashboard password recovery options when needed.

## 5. Create an account and grant membership
Open Gather and click Create account. If confirmation is enabled, check the email and confirm. In Supabase Authentication > Users, copy that account's UUID.

Run in SQL Editor with actual values:

```sql
insert into public.gather_members (church_id, user_id, role)
values ('YOUR_CHURCH_UUID', 'YOUR_USER_UUID', 'editor');
```

Click Refresh data after signing in. Accounts do not automatically get access. Add other members in the same way; use `viewer` for read-only access. Editors can modify/import all planner data; only the project owner managing Supabase can grant/revoke membership. This compact implementation uses one JSON document per church rather than separate tables for every record type.

## 6. Restore existing records
As an editor, import the backup exported in step 1. Import replaces the shared church planner for everyone, so coordinate with your team first. Export remains available to both editors and viewers.

## 7. Deploy
Commit app.js to GitHub and let Vercel deploy. Keep Framework Preset Other and the Build Command blank. Plain static JS does not read Vercel environment variables automatically; set the three public values in app.js as described above.

## 8. Test access and shared saving
- Account A (editor): create a service and save.
- Account B (editor): sign in in another browser, click Refresh data, confirm the service appears.
- Account C (viewer): confirm records are readable, editing/import controls disabled, and direct database update is denied by RLS.
- Account D (no membership): confirm no church data loads.
- Open two editor tabs, edit/save in tab A, then edit/save stale tab B: tab B must report a conflict instead of overwriting A. Refresh tab B and re-enter the edit.
- Disconnect internet, edit and save: the app must show Not saved and restore its last confirmed data.
- Log out: church records must disappear and signin must be shown.

Shared changes appear after Refresh data or page reload; realtime push updates are not included. Saves use a version condition, so stale edits are rejected. Failed edits are rolled back; re-enter them after Refresh data. This is a connected starter, not a verified deployment to your own Supabase project.
