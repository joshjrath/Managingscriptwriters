# Architecture

How the code is put together, where things belong, and the rules that keep it
working. The README covers what the product does and how to deploy it; this file
is for whoever changes the code next (a person or an AI agent).

## What it is

A script-production workspace for one team: clients → shoots → script batches →
scripts, with writers, reviews, deadlines, reminders and delivery records.
Roles are **Admin** (`owner` in code), **Manager**, **Writer** and **Editor** (video editors: read-only, never given scripts).

- **Server:** Fastify 5 on Node 22 in `server/`. It serves the JSON API under `/api/` and, in production, the built client.
- **Database:** PostgreSQL via `pg` in production. Locally, in the demo and in tests it uses PGlite, an embedded Postgres. Both engines run the same SQL and the same migrations.
- **Client:** React 19, react-query 5 and react-router 7, built with Vite, in `client/`.
- **Shared:** domain rules used by both sides live in `shared/`. That folder imports nothing from `server/` or `client/`.

## Where things live

| Area | Files |
|---|---|
| Configuration (every environment variable) | `server/config.ts` (`loadConfig`), documented in `.env.example` |
| Start-up, shutdown, first admin | `server/index.ts` |
| App assembly: hooks, error handler, route registration | `server/app.ts` (`buildApp`) |
| Errors, validation, request helpers | `server/http.ts` (`HttpError`, `parse`, `zs`, `requestPath`, `isApiRequest`) |
| Passwords, sessions, guards, sign-in throttle | `server/auth.ts` |
| View as, Recording mode, per-request database | `server/recording.ts` |
| Database interface, engines, migrations runner, `LOCKS` | `server/db.ts` |
| Migrations (append only) | `server/schema.ts`, with data fixes in `server/backfill.ts` |
| Settings, users, activity, notifications, batch summaries | `server/core.ts` |
| Row → API shape loaders (and the documents sent, `loadDeliverables`, which the Script bank and the Editors tab share) | `server/records.ts` |
| Account, team, settings, setup | `server/routes/account.ts` |
| Batches, scripts, and **every script status change** (`applyScriptAction`) | `server/routes/batches.ts` |
| Clients, resources, uploaded files, search | `server/routes/clients.ts`, `server/files.ts` |
| Shoots | `server/routes/shoots.ts` |
| Read-only screens (overview, calendar, bootstrap…) | `server/routes/views.ts` |
| Sending documents and reviews | `server/submissions.ts` |
| Script bank, Today, to-dos, celebrations | `server/script-bank.ts`, `today.ts`, `todos.ts`, `moments.ts` |
| Synced calendars (Google Calendar iCal), and shoots found on them | `server/calendar-feeds.ts`, `server/ical.ts`, `server/calendar-shoots.ts` |
| What an editor may call (an allowlist checked before every route) | `server/editor-access.ts` |
| Master log (activity and audit) | `server/audit.ts` |
| Reminders (in-process timer, or `npm run reminders` from cron) | `server/reminders.ts`, `server/reminders-cli.ts` |
| Paste notes (Anthropic API) | `server/notes-import.ts` |
| Timeliner: its API client and webhook; a shoot's scripts PDF is linked to its batch once and each version delivers it (Settings → Timeliner, Pick batch) | `server/timeliner.ts` |
| Matching Timeliner to shoots, as pure rules: a scripts PDF's batch (`placePdf`), each video's batch and script number (`matchVideos`), or why it has none (`no_scripts`, `no_client`), names and numbers | `server/matching.ts` |
| Editors tab: the timed read of Timeliner's videos and who is on each brand (lenient: an odd item is skipped and counted), whom a video belongs to (`OWNER_IDS`: its assignees, else its client's editors in Timeliner), matching the copy again after every write (`rematch`), the board (`loadBoard`: a card for everyone in Timeliner with videos, flagged when not on the site; each client's editor and split), the editor's script link (`GET /api/editing/script-pdf/:batchId`), pins, and I'm on this / Pause / Resume / Done | `server/editing.ts` |
| Editors who don't sign in (Settings → Editors) | `server/control/editors.ts` |
| Demo data | `server/seed-demo.ts`, `server/seed-cli.ts` |
| Dates, deadlines, clock, due state | `shared/dates.ts` |
| Statuses, roles, action rules, progress, document state, ranges; a video's state, title ranges (`compressTitles`), a raw camera clip (`isRawTitle`) and a focus left running (`isFocusStale`) | `shared/workflow.ts` |
| Display wording shared by server and client (dates, times, a video's due words, time worked) | `shared/format.ts` |
| Quick-entry parser | `shared/parse.ts` |
| API types and header names | `shared/types.ts` |
| What's new entries | `shared/changelog.ts` |
| Theme palettes and contrast rule | `shared/palettes.ts` |
| Client API wrapper (`api`, `useSave`, `qs`) | `client/src/api.ts` |
| Routes (pages) and app shell | `client/src/main.tsx`, `client/src/components/Shell.tsx` |
| Editors page (managers, `/editors`): what the last read found and Read Timeliner now (in the page header), summary cards (after a failed read they say how old the copy is instead of an all-clear), the one "not matched" count, "Editors by client" ("one editor per client since Oct 9"; each client's editor, open videos, and its only warnings as chips; clients on the rule first, flagged ones first among them and always shown, "Before the one-editor rule" for the rest, one line each on a phone), a calm card per person in Timeliner and per site editor (biggest client "+ N more", two pills at most, what they're on in one line plus one, the plate bar and one line of counts, last finished and Videos; flagged when not on the site, listed in a "Fix these people" line above the cards), videos not assigned in Timeliner (raw clips by shoot, with their client's usual editor); in an editor's Videos, one row a video ("#2 · Title", with via client / no scripts on the site / not matched in small words), a tapped video's match and "Wrong shoot? Pin it" | `client/src/pages/Editors.tsx` |
| Editor home: the hero (Next up / You're on / Paused) and Your videos with script links (raw clips folded by shoot under To edit), above shoots and finished scripts | `client/src/pages/EditorHome.tsx` |
| What both share: the read line (`syncWords`, `readWords`), a video's name ("Raw clip C0045", and on one line in lists with its script number up front: `VideoLine`), square and client (the Timeliner brand when it isn't a site client), "matched by date", "No scripts on the site", and the script link ("Scripts PDF · v3 · from Timeliner", with the site's version as the quieter second link) | `client/src/components/EditingBits.tsx` |
| Settings → Timeliner: connect, recent uploads with their version and Pick batch (the likely batch preselected), the scripts PDFs linked to their shoots, and "One editor per client since" (`settings.one_editor_since`) | `client/src/components/TimelinerPanel.tsx` |
| UI primitives (Dialog, Panel, buttons…) | `client/src/components/ui.tsx` |
| Design tokens (every colour, radius, spacing) | `client/src/styles/tokens.css` |

### Where to add things

- **A new API endpoint.**
  1. Put it in the module that owns the resource, or in a new `register…Routes(app, ctx)` registered in `buildApp`.
  2. Begin the handler with a guard (see Access below).
  3. Validate input with `parse(schema, req.body)` and reuse the `zs` fields.
  4. Add the route to the `ACCESS` table in `test/access.test.ts`. The test fails until you do.
- **A new rule both sides need** (a status, a deadline, a permission): add it to `shared/`. Never copy it into a page or a route.
- **A schema change:** append a migration to `MIGRATIONS`. Prefer additive changes, and do backfills as function migrations.
- **A new environment variable:** add it to `Config` in `server/config.ts`, with its default and range, and to `.env.example`. Server code never reads `process.env` directly; the entry points hand it to `loadConfig`.
- **A new page:** add a route in `client/src/main.tsx` and a nav item in `Shell.tsx`. Build it from `ui.tsx` primitives and `tokens.css`.
- **A job that must never run twice at once:** add an id to `LOCKS` in `server/db.ts` and take it with `pg_advisory_xact_lock` inside a transaction.

## A request, start to finish

1. **CSRF** (`app.ts`): any `/api/` request other than GET or HEAD needs the header `x-scale-media: 1` (`CSRF_HEADER`). If an `Origin` header is present, its host must match. The server never grants CORS.
2. **Who is asking** (`recording.ts`):
   - The `sm_session` cookie is resolved against the **real** database. Only the token's SHA-256 is stored; a session lasts 30 days and is not extended by use.
   - This sets `req.realUser` (who signed in) and `req.user` (who the request acts as). They differ only during View as.
   - **View as** is read-only on the real workspace. Writes are refused, except a few background writes that quietly do nothing.
   - **Recording mode** sends the session's requests to a cloned `rec_<12 hex>` schema through `AsyncLocalStorage`, so `ctx.db` is the practice copy and route code doesn't need to know.
   - It **fails closed**: a write whose `x-scale-recording` header names a practice copy that no longer exists gets 409 `recording_ended`. It never falls through to the real data. The same applies once an admin is demoted. Sign-in and `/api/admin/*` calls are exempt, because they only change the real sign-in.
   - `/api/auth/*` and `/api/admin/*` always use the real database.
3. **Handler:** guard → `parse` → work. A change to a batch or its scripts runs in `db.tx` and locks rows first: the batch row (`for no key update`) for batch-wide changes, then the script rows (`for update`) it touches. Other transactional changes lock their own row (a client, a shoot). Simple single-record edits (a team member, client, shoot or editor) write the row and its history line without a transaction.
4. **Errors** (`app.ts`):
   - An `HttpError` becomes `{ error: { message, fields?, code? } }` with its status code.
   - A unique violation that slipped past the explicit checks becomes 409 `duplicate`.
   - Anything else is logged and becomes a 500 that says nothing was saved.
   - The client's `api()` turns all of these into an `ApiError`, which forms show beside the field it names.
5. **Audit** (`audit.ts`, `onResponse`): page views and refused attempts go to `audit_log`, but not in Recording mode. During View as they are attributed to the admin.

## Access

- **Guards** (`server/auth.ts`):

  | Guard | Who passes |
  |---|---|
  | `requireUser` | anyone signed in |
  | `requireManager` | Admin or Manager |
  | `requireAdmin` | Admin only |

  Role checks use `isManager`, `isAdmin`, `isEditor` and `canWrite` from `shared/workflow.ts`. Never compare role strings in routes.
- **Editors** get only the routes listed in `server/editor-access.ts`; every other route is refused before it runs, so a new route is closed to editors until it's added there on purpose. Their reads are also scoped to finished (approved or delivered) work; which stored files they may open is `EDITOR_FILES` in `server/files.ts`. Of the Editors routes they get only `GET /api/editing/me`, `POST /api/editing/focus` and `GET /api/editing/script-pdf/:batchId`, all for the session user's own videos (matched by email; a video is theirs when it's assigned to them in Timeliner, or nobody is on it and they're its client's editor there: `OWNER_IDS` in `server/editing.ts`): focus refuses a video that isn't theirs, and the scripts PDF a batch they have no video from (403; opened in a browser tab, it answers with a short page saying why rather than JSON). The managers' match notes are never in what editors get, nor what the read found across the workspace (`sync.counts`). `GET /api/editing`, `POST /api/editing/sync` and the pins (`POST` and `DELETE /api/editing/videos/:id/pin`) are `requireManager`.
- **Script actions:** every status change goes through `applyScriptAction`. It locks the rows and checks each one with `checkAction` and `ACTION_RULES`. Writers can act only on their own scripts.
- **Ownership checks** live in the route: the assignee on a script edit, `isAssignedTo` for blockers and resources. A personal view (My work, Today, to-dos) always gives a writer their own data, from the session. A manager may name someone with `?userId=`, and may ask for the whole team on Today (no `userId`) and to-dos (`?all=1`). Notifications always use the session user.
- **Admin protection:** only an Admin can grant the Admin role or change anything on an Admin's account. The last Admin can't be removed or demoted. Temporary passwords are shown only to managers, and never an Admin's to a non-admin.
- **Sign-in throttle:** 8 wrong passwords per address and account, and 30 per account from any address, in 15 minutes. The address comes from `X-Forwarded-For`, trusted as far as `TRUST_PROXY` allows.

## Data

- **`Db`** (`server/db.ts`) has `query`, `one`, `tx`, `close` and `withSchema`.
  - Route code always uses `ctx.db`, which follows Recording mode.
  - `ctx.realDb` is only for session and sign-in plumbing (`recording.ts`), for streaming file contents that stay on the real workspace (`/api/files/:id`), and for the timed background reads of calendars and Timeliner (`startCalendarSync`, `startTimelinerSync`), which never write to a practice copy.
- **Migrations** run at start-up, in order, one transaction each, under `LOCKS.migrations`.
  - SQL migrations are split into statements on `;` at a line end. Anything that can't be split that way is written as a function migration.
  - Function migrations import `shared/dates.ts`. Changing those helpers changes what a fresh database's backfill produces.
- **Optimistic concurrency:** scripts carry a `version`, and a stale edit gets 409 `stale` (the script dialog sends all its fields with the version it started from). Edit batch, Edit client and Script titles send only the fields the person changed, compared with a snapshot taken when the dialog opened. Other edit forms (deadline rules in Settings, team members, to-dos) still send the whole form, so a route must compare the input with the stored row before treating a field as changed, as `PATCH /api/users/:id` does.
- **Files** are stored in Postgres, in the `files.data` column (`server/files.ts`). An upload is read in 4 MB pieces into a scratch table and written as one value (linear in the file's size; appending piece by piece would be quadratic), and downloads stream back out in 512 KB pieces. A single value can't exceed 1 GB, and `UPLOAD_LIMIT_MB` caps uploads at 100. Names are cleaned up by `storedFileName`, and executables are refused.
- **Timeliner copy** (`server/editing.ts`): `timeliner_tasks`, `timeliner_members`, `timeliner_names` (brands, projects, sub-folders, with when each was made) and `timeliner_brand_members` (who is on each brand, with their brand-level role and whether the access is automatic) are a copy of Timeliner, written only by its reads and webhook. `settings.timeliner_sync_counts` keeps what the last complete read found (videos, people, clients, skipped) for the tab's sync line. Each task row also stores its match (`client_id`, `batch_id`, `script_number`, and `match_how`, `match_note`, `match_check`, `match_kept`), worked out again after every write by `rematch`. The site's own layer is `editor_focus` (one row per person: the video they're on, `on` or `paused`, with time worked), `editing_done` (Done marks, which count until Timeliner moves the video) and `timeliner_video_pins` (a manager's "this video is from that batch", or from none). `timeliner_removed` keeps removed task ids for a day; `timeliner_editor_clips` remembers each editor's raw clips, clip by clip, for 45 days with the batch each was last matched to (so a clip moved to another shoot takes its memory with it), because the clips are trashed soon after the titled videos are made. `has_video` on a task row says it held a video file, so a document uploaded to it later is notes on the video, while one uploaded to a task first read with no file is a scripts PDF. Nothing here writes to Timeliner.
- **Scripts PDFs** (`server/timeliner.ts`): `timeliner_pdfs` links each shoot's scripts PDF (by its task id, or `file:<id>` for a file put straight into a project) to its batch, once, with its version, newest file and step, and `gone_at` when trashed. Only an upload or a manager's pick creates (or moves) a link; reads only keep it current. Editors are offered a batch's PDF only when it delivered scripts still delivered there, or everything there is delivered: one that delivered nothing may hold scripts that aren't approved. Timeliner's download links are never stored: `GET /api/editing/script-pdf/:batchId` fetches one and redirects to it.
- **Retention:** the reminders run deletes expired sessions. It also deletes `audit_log` page views, and anonymous sign-in records, after 400 days. Activity and everything else is kept.
- **Single instance:** some state lives in the server's memory: the sign-in throttle, View-as and Recording-mode state, the Paste-notes rate limit, the de-duplication of page views, and Timeliner's download links for scripts PDFs (until 10 minutes before they expire). A restart clears it, and it isn't shared between instances, so run one web instance. The reminders and migrations are safe with several, because they use advisory locks.

## Background work and outside services

- **Reminders** (`server/reminders.ts`):
  - They run every `REMINDER_INTERVAL_MINUTES` inside the server (`REMINDERS=off` turns them off), or from `npm run reminders` on a cron, which needs `DATABASE_URL`.
  - Each run takes `LOCKS.reminders`, and notifications are de-duplicated by key, so overlapping runs are harmless.
- **Calendar sync** re-reads each synced calendar every `CALENDAR_SYNC_MINUTES` (15) inside the server (`CALENDAR_SYNC=off` turns it off), and tells managers once about each new shoot it finds.
- **Paste notes** calls the Anthropic API, only when `ANTHROPIC_API_KEY` is set. Each person can run one read at a time and 30 an hour. If the API fails, the person gets a clear message and nothing is created.
- **Timeliner** (`server/timeliner.ts`), only when `TIMELINER_API_KEY` is set:
  - On start-up (once) or from Settings → Timeliner, the server registers a webhook (`TIMELINER_EVENTS`: `version.uploaded` and `file.uploaded`, plus the `task.*` and `project.trashed` messages for the Editors tab) pointing at `PUBLIC_URL` (or `RENDER_EXTERNAL_URL`) + `/hooks/timeliner`, and keeps the signing secret Timeliner returns in `settings`. Already connected, start-up adds any events it lacks (best effort: a read-only key can't) and leaves it switched on or off as Timeliner has it; Connect in Settings switches it back on.
  - `POST /hooks/timeliner` is public and outside `/api` (so the same-page header check doesn't apply); it refuses a message unless `X-Timeliner-Signature` checks out against that secret and is under five minutes old. Each message id is claimed in `timeliner_events` before anything happens, so a repeat is a no-op.
  - **A batch is found by its PDF's task.** An upload on a task already in `timeliner_pdfs` is a new version of that PDF: it goes to the same batch, whatever its name or date. A new PDF's client is the one whose PDFs sit in that project, else the one the Timeliner brand or project is named after (a batch's old `timeliner_project_id` is only this hint). Its batch is then a date or word of one batch in its name, else the shoot waiting for its scripts from 45 days after to 3 days before the day the PDF's task was made (never one whose scripts were all delivered by hand, without a PDF), else a shoot just behind that is still waiting, else the client's only undated batch waiting (`placePdf`). Two waiting shoots within 3 days, a name pointing at a batch that already has its PDF, a name like the PDF of a shoot still ahead, or only a shoot delivered by hand around then: it waits for a manager, with the likely batch suggested. Pick batch links it (`how = 'manager'`), offering every batch still without a PDF around then, approved scripts or not. It also moves a PDF linked to the wrong shoot, once none of the scripts it delivered there are still delivered (the manager undoes that delivery on the batch's page first; Move, which would undo it too, isn't built).
  - Each version delivers the batch's approved scripts through `applyScriptAction` with `viaTimeliner`, which records the delivery with `source = 'timeliner'`; one with nothing new to deliver is `new_version`. The link row is locked first, then the batch row. Editors with an open video from that batch are told once per version.
  - Uploads on a video's task (one that held a video file) are ignored; a file put straight into a project counts only when its name says "script" or names a batch, and is a new version of a linked file with the same name only while that file's shoot isn't past.
  - Lookups (task, project, brand, members) are best effort: when Timeliner can't be reached the upload is matched on what's known, or kept as unmatched for a manager to place.
- **Timeliner sync** (`server/editing.ts`, `syncTimeliner`), only when `TIMELINER_API_KEY` is set:
  - **Polling is the baseline.** Every `TIMELINER_SYNC_MINUTES` (5; the first 15 seconds after start-up) inside the server (`TIMELINER_SYNC=off` turns it off), and on Read Timeliner now (`POST /api/editing/sync`). It only reads, so a read-only key works. The timed read uses `ctx.realDb ?? ctx.db`, never a practice copy.
  - A read takes members, brands, tasks newest first (at most 30 pages of 100; trashed, archived, document and long-finished tasks are dropped), who is on each brand those videos are under (one call per brand, open videos' brands first, at most 60; a brand whose list fails, or that Timeliner says it doesn't have, keeps its last one and is counted as skipped; a list with an entry that can't be read never takes anyone off the brand, since that entry may be its editor: whoever it could read is added, and the rest stay as read last), the projects open videos sit in (names and sub-folders, re-read at most hourly) and the last step move of videos whose step changed (capped per read). A 429 or no connection stops these optional lookups for that read.
  - **Real data is read leniently.** Every task, member, brand, brand member, project and sub-folder is checked field by field with zod (`taskSchema`, `memberSchema`, `brandSchema`, `membershipSchema`, `projectSchema`): an odd field (null, missing, another type, a number for an id, an epoch for a time, an odd item in `assigneeIds`) takes a safe default; only an item with no usable id (or a brand or project with no name) is skipped, counted in the read's `skipped`, and its id logged once. One odd item never fails the read. A list answer that isn't a list (a 404, an HTML page) is an error, never an empty list, so it can't empty the copy; a member list none of which can be read keeps the last members. A webhook task that can't be read leaves its last copy as it is.
  - **Its lock:** everything is written in one `db.tx` under `LOCKS.timeliner`, which the webhook's one-video write also takes. A row written after a read began isn't overwritten by that read, and a removed id stays in `timeliner_removed` so an older read can't write it back. A complete read removes tasks it no longer lists; one stopped by the page cap removes only within the stretch it read.
  - **The webhook makes it faster:** when connected, `task.*` and `project.trashed` messages go to `applyTaskMessage`, which re-reads that one task (or removes it). The message is answered even when the task can't be read; the next timed read catches up.
  - **Matching** (`rematch`, under the same lock after every write, and after a pin): the whole copy is matched again by `matchVideos` in `server/matching.ts`. A video whose brand (or project) is no site client is `no_client`, and one whose client has no scripts on the site is `no_scripts`: normal work with no batch, never counted as not matched (`isNotMatched` in `shared/workflow.ts`). Videos go by date: the shoot that had just happened when the video was made in Timeliner (raw camera clips never take the shoot after, and never a script number); a titled video takes the shoot whose raw clips its editor has been cutting; the folder's word (Organic, Ads) only decides between batches of the same shoot. A pin wins; a video that has been in review keeps its batch (unless it moves folder, or it was matched by date alone before anyone had it and is then given to its first editor). Raw clips by their date and titled videos by their editor's raw clips are sure; a titled video by its date alone shows "matched by date". Linked scripts PDFs and tasks whose file is a document aren't videos: a read keeps their step, newest file and trashed state.
  - **Whom a video belongs to** (rule A, `OWNER_IDS` in `server/editing.ts`, the one place it lives): its assignees in Timeliner when it has any; otherwise its brand's editors there, because each client has its dedicated editor and Timeliner assigns them on the client's brand, not on each video. A brand's editor is a brand member with the brand role `editor`, not `automatic` (a workspace admin's access to every brand), still active, and not a workspace admin, supervisor or guest. A brand with two editors gives the video to both. The board, an editor's Home, I'm on this, the scripts PDF link, the new-version notice, the shoot an editor's raw clips are from and their last finished video all go by it; a video is "not assigned" only when nobody is on it or on its brand. Only editors are editors: a member whose email is a site writer's, manager's or Admin's (`SITE_NON_EDITOR`, the roles `isEditor` says aren't editors) is never one of a brand's editors nor a video's owner, so a video only they are on goes to its brand's editors.
  - **The board** (`loadBoard`): a card for every Timeliner member with videos in the copy (any state, theirs by rule A), every editor of a brand with videos, and every editor on the site (`peopleOf`). A member is matched to a site account by email (their taps count), else by name (any case, spacing or accents) to someone on the site with no Timeliner work under their email (flag `email_differs`), else they're only in Timeliner (flag `not_on_site`, or `no_site_access` with the city, time zone and hours of the same name in Settings → Editors). A Timeliner admin, supervisor or guest (`REVIEW_ROLES`) on a video is reviewing it: they never count as its editor (`editorsOn`), have a card only for videos nobody else is on (`onCardOf`, so such a video isn't on nobody's card), and are never flagged to be added as an editor. A site editor with nothing in Timeliner gets `nothing_assigned`. Someone deactivated in Timeliner with nothing open gets no card. Totals count everyone's work, each video once. Each client (the site's client, else the Timeliner brand) has an editor: the editor on its brand in Timeliner (`editorFrom: 'client'`; with several, the one with the most of its videos); else whoever has the most of its videos made in the last 60 days (a tie: the most recent), counting only a video's editors, and never someone who has left Timeliner. A client with more than one editor on its brand is flagged ("has 2 editors in Timeliner"), else one whose open videos are with more than one editor is flagged as split; its unassigned videos (grouped by client, or by Timeliner brand, never across them) suggest its editor. Only videos made on or after `settings.one_editor_since` (Settings → Timeliner; Oct 9, 2026, when the rule began), in HQ time (`onOrAfterDay` in `shared/dates.ts`), judge the rule (`underRule`): the split, the two-editors flag and the editor worked out from videos; older ones still count everywhere else. A client with none (`beforeRule`) is never flagged and names only the one editor on its brand. Clients on the rule are listed first, flagged ones first among them. Nothing here is stored: it's worked out from the copy on every load.
  - After every write, a focus whose video left the editor's plate, was given to someone else or is gone ends by itself. One still running after `FOCUS_STALE_HOURS`, or outside the editor's working hours, stays as it is but isn't counted as editing now (`isFocusStale` in `shared/workflow.ts`). A failed read keeps the copy and stores Timeliner's message in `settings.timeliner_sync_error`; a good one sets `timeliner_synced_at`.
- **No email:** the app never sends email. Sign-in details are copied by hand.

## Invariants (break one and something real breaks)

1. Every number on every screen (progress, stages, charts, counts) is computed from script rows. Nothing stores a total.
2. A script has at most one assignee.
3. Only `applyScriptAction` changes a script's status.
4. The written-so-far counter never changes a script's status.
5. A shipped migration is never edited.
6. View as never writes to the real workspace. A Recording-mode write never reaches it either.
7. Every `/api/` route has a guard (or is deliberately public), and is listed in `test/access.test.ts`.
8. Secrets are never sent to the browser. The client bundle reads no environment variables.
9. Every user-visible change has a What's new entry in `shared/changelog.ts`.

## Testing

- **Commands:** `npm run verify` runs typecheck, lint (zero warnings), tests and build, which is what CI runs. `TEST_DATABASE_URL=postgres://… npm test` runs the suites on a real PostgreSQL; it wipes that database's schema first. CI also runs the API suites on Postgres 16.
- **`test/api.test.ts`** is one long scenario that runs in order. Don't filter it with `-t`, because later tests depend on earlier ones. Add self-contained cases to `test/workspace.test.ts` with `freshDb()`, or write a new file.
- **`test/access.test.ts`** checks every route against its `ACCESS` table, and that anonymous users, writers and managers are refused where they should be.
- **Pure rules** (dates, workflow, parser, config) have unit tests in `test/*.test.ts`. Change a rule and add a case for it.

## Deploy and operations

- **Build:** `npm ci && npm run build`. **Start:** `node --max-old-space-size=200 --max-semi-space-size=2 dist/server/index.mjs`. Use `node` rather than `npm start`, which keeps npm running alongside and uses memory. Health check: `/healthz`.
- **Production needs `DATABASE_URL`.** The server refuses to start on the host's temporary disk. The first Admin comes from the `MANAGER_*` variables, used once, on an empty database.
- **Backups** are the database host's. Pick a plan that has them. Uploaded files are in the database, so a database backup covers them.
- **Rollback:** deploy the previous commit. Migrations so far only add or widen, so older code runs on a newer schema. A migration that isn't additive must say so in its comment, with how to undo it.

## Rules for changing this code (people and AI agents)

Read `CLAUDE.md`. In short:

1. Read the code you are about to change, and its callers.
2. Reuse what's in `shared/`, `server/http.ts`, `server/records.ts` and `client/src/components/ui.tsx`.
3. Keep the change to what was asked.
4. Add or update tests.
5. Run `npm run verify`.
6. Add a What's new entry.
