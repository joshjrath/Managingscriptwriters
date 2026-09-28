# Scale Media · Script production

One place to run script production: clients and their briefing material, shoots, script batches, who is writing what, exact progress, reviews, and delivery to Timeliner. Managers see every writer's work and what is due; writers get a focused view of their own scripts, briefs and deadlines.

The visual language comes from the Specular dashboard (layout, summary cards, the "Work due by day" bars, nested operational rows) and Ash Health (charcoal cards, rings, type): a near-black shell, an inset sidebar with a salmon active item, one salmon and one yellow summary card, and colour that always comes with a label.

```sh
npm install
npm run demo     # sample workspace on its own database → http://localhost:5173
npm run dev      # your real workspace (data/pglite) → first visit creates the manager account
npm test         # date maths, workflow rules, quick-entry parser, and the full API
```

Demo sign-in: `josh@scalemedia.demo` (manager) or `sarah@scalemedia.demo` (writer), password `scalemedia-demo`. Demo data lives in `data/demo`, never in the real workspace, and every screen says "Demo workspace" while you're in it.

## How it's organised

**Client → Shoot → Script batch → Scripts.** A shoot is optional: a batch can exist on its own (e.g. five scripts after an ideation call). Every script is its own record with exactly one assignee (or none), so a 45-script batch split between two writers can never be double counted. **All progress, stages, charts and dashboard numbers are computed from those script records.**

| Script status | Counts as |
|---|---|
| Not started · In progress | — |
| Ready for review | draft-ready |
| Revisions needed | *not* draft-ready (clearly flagged) |
| Approved | draft-ready + approved |
| Delivered to Timeliner | draft-ready + approved + delivered |

A batch reads e.g. **"20 / 45 drafts ready · 44%"**, with approved and delivered counted separately. Its stage (Not started → Writing → In review → Approved · to deliver → Delivered) is the least advanced stage of any of its scripts, so a partly delivered batch never looks finished. **Blocked** is a separate flag with a note.

### Workflow rules (enforced on the server)

- Writers move their own scripts: start, submit for review, withdraw, and confirm delivery.
- **Owners and managers have exactly the same permissions** (Owner is a label; the first account is the owner). Only they approve, request revisions (a note is required), assign/reassign, change deadlines or script counts, move shoots, and manage clients, briefings, the team and settings.
- **A script must be approved before it can be marked delivered** — no action, bulk selection or quick control can skip review.
- The quick count control on My work changes real script records: **+** submits your next script for review, **−** withdraws the last one you submitted. It can never approve or deliver.
- Partial review is normal: approve ten scripts while the rest are still being written.
- Lowering a batch's script count needs an explicit choice of which not-started / in-progress scripts to remove. Submitted, approved and delivered work is never removed; removed scripts stay in history and come back first if the count goes up again.
- Stale edits are rejected (409) instead of overwriting someone else's change.

### Deadlines

Creating a shoot creates its batch and calculates, from the **first shoot day**:

- **Drafts due:** 5 calendar days before (a shoot on Oct 12–13, 2026 → Oct 7)
- **Final delivery to Timeliner:** 3 calendar days before (→ Oct 9)

The rule is shown beside every generated date. Offsets are editable in Settings; each batch can override either date manually. Calendar days are the default and weekend deadlines are never shifted silently; "working days" is an explicit setting with a configurable working week.

Shoot dates are stored as plain calendar dates, so timezones can't move them a day. The **organisation timezone** (default America/New_York) and **daily cutoff** (default 11:59 PM) decide what "today" is and when a deadline becomes overdue.

**Moving a shoot:** a preview lists every deadline change first. Applying it recalculates automatic dates, keeps manual overrides and flags the batch "deadlines need a check", flags dates that are already past, records the change in each batch's history, and notifies affected writers.

**Planned writing start** is tracked separately. If a writer has a capacity (scripts per working day) set in Settings → Team, the batch form offers an *estimated* start date; writers are only shown as over capacity when a capacity is configured.

### Timeliner delivery — manually confirmed

There is no Timeliner integration and no fake "send to Timeliner" button. The writer adds scripts in Timeliner, selects them here, and clicks **Mark delivered to Timeliner**, optionally adding the Timeliner link and a note. The app records who confirmed and when, labels it **"Writer-confirmed delivery"**, and notifies managers. A batch is fully delivered only when every script is recorded as delivered. Managers can undo a delivery (it's logged).

### Quick entry (natural language)

"New work → Quick entry" reads sentences like *"Acme has a shoot October 12–13, 2026, needs 45 scripts, and Sarah is writing them."* and shows a structured preview (client, shoot dates, script count, writers, draft and final deadlines) that must be confirmed. It is a **pattern-based parser that runs locally — no AI provider is used**. It asks instead of guessing: missing years, 10/12-style dates, two people called Sarah, or an unknown client ("create it as a new client?", which needs an explicit tick). The structured forms are always available.

### Notifications, reminders and history

In-app notifications cover assignments, deadline changes, approaching / due-today / overdue deadlines, review requests, revision requests, blockers and delivery confirmations. Reminder notifications are deduplicated per user, batch, milestone and date. Overdue badges on the dashboard, production board and batch pages come from the data, so they stay visible after a notification is read.

**Reminders run inside the web server every 10 minutes while it is running** (on Render that means a paid instance; free instances sleep). Running several instances is safe: a Postgres advisory lock lets one run at a time, and deduplication prevents repeats. To use an external scheduler instead, set `REMINDERS=off` and run `npm run reminders` from a cron service.

Every meaningful change (creation, assignments, status changes, reviews, deliveries, deadline moves, blockers, target changes, archiving) is written to the activity history with actor and timestamp, shown on batch and client pages.

## Screens

Overview · My work · Production (board + table, filters, search) · Calendar (month + list; writing periods, drafts due, final delivery, shoots) · Clients and client detail · Batch detail (script checklist with range selection and bulk actions, brief, deadlines, review notes, delivery records, history) · Review queue · Resources · Settings (deadline rules, timezone & cutoff, reminders, team). Dashboard cards link to the matching filtered records; chart bars reveal the underlying batches.

Responsive: full sidebar on wide screens, collapsible icon rail on smaller desktops/tablets, navigation drawer and card layouts on phones (My work, deadlines, briefs and delivery confirmation are prioritised).

## Deploy to Render

1. Push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` creates:
   - the web service (`npm ci && npm run build`, then `npm start`, health check `/healthz`, Node 22)
   - a PostgreSQL 16 database, with `DATABASE_URL` wired in automatically
2. When Render asks, fill in `MANAGER_EMAIL`, `MANAGER_NAME` and `MANAGER_PASSWORD` (at least 10 characters). That account is created on first start.
3. Open the `.onrender.com` URL, sign in, and add your second manager and writers in **Settings → Team**. The app doesn't send email: after you add someone (or reset their password) it shows a ready-to-send message with the sign-in link, their email and a generated temporary password, with a **Copy message** button to paste into WhatsApp, Slack or email.

**Team:** roles are Owner, Manager and Writer. A person's temporary password stays readable in Team (with **Copy sign-in details**) until they set their own; passwords people choose themselves are never stored readable — use **Reset password** to issue a new temporary one. **Remove** signs someone out for good, hands their unfinished scripts to a person you pick (or leaves them unassigned), and keeps their name in the history; adding the same email again restores the account.

`MANAGER_*` values are only used the first time the server starts with an empty database; changing them later does nothing. To change your password, use **Change password** in the menu under your name. If you're locked out, set `MANAGER_RESET_PASSWORD=1`, deploy (that account's password becomes `MANAGER_PASSWORD`, and it's created as a manager if missing), then remove the variable again.

**Keep the web service on a paid instance (the blueprint uses Starter).** Render's free web services sleep when nobody is using them, and the deadline reminders run inside the server, so they would stop. If you want the free plan anyway, set `REMINDERS=off` and add a Render **Cron Job** on the same repo that runs `npm run reminders` every 15 minutes with the same `DATABASE_URL`.

The server creates its tables on first start and refuses to start without `DATABASE_URL`, so nothing is ever written to Render's temporary disk. Uploaded files are stored in Postgres, so no Render disk is needed. Pick a database plan with backups; check Render's current terms, because free databases are time-limited.

To set it up by hand instead of using the blueprint: create a PostgreSQL database, then a Node web service with build command `npm ci && npm run build`, start command `npm start`, health check path `/healthz`, and environment variables `NODE_VERSION=22`, `DATABASE_URL` (the database's internal connection string) and the three `MANAGER_*` values.

Any other Node 22 host with PostgreSQL works the same way (`railway.json` is kept for Railway).

## Security

- Passwords hashed with scrypt; sessions are random tokens (only their hash is stored) in an HTTP-only, SameSite=Lax cookie, `Secure` in production; sign-in is rate-limited.
- Every permission is checked on the server; the UI only hides what you can't do.
- State-changing requests need a custom header and a same-origin `Origin`, which blocks cross-site request forgery.
- Uploaded files are stored in Postgres (up to 25 MB each), served only to signed-in users while a live resource references them, with `nosniff`, a sandboxing CSP, and forced download for anything that isn't a PDF, image or plain text. Executables are refused.
- Nothing is reported as saved until the server confirms it; failed saves show the error in place with the form still filled in.

## Tests

```sh
npm test                                              # embedded Postgres (PGlite)
TEST_DATABASE_URL=postgres://user@host/db npm test    # a real PostgreSQL (the schema is wiped first)
npm run typecheck
```

They cover: deadline maths across month and year boundaries, leap days, DST, multi-day shoots, business-day mode, timezones and the daily cutoff; progress (20 / 45 · 44%), stages and partial delivery; workflow permissions; the quick-entry parser; and through the real API — creating a client with a recording, document and uploaded file (and denying anonymous file access), both example shoots, the 20 / 25 split without double counting, draft completion not delivering, partial review and delivery, delivery records, moving a shoot with a manual override, batches without shoots, the dashboard's overdue / blocked / unassigned lists, writers being refused on every manager action sent directly to the API, CSRF, stale-edit rejection, target changes that protect work, reminder deduplication, and data persisting across restarts.

## Layout

```
shared/         date & deadline maths, workflow rules, quick-entry parser, API types (used by server and client)
server/         Fastify API: auth, routes/, reminders, migrations, demo seed
client/         React app (Vite): styles/tokens.css holds every colour, radius, spacing and type token
test/           vitest suites
```

## Limitations

- Timeliner delivery is **manually confirmed by the writer**, not verified. An official Timeliner API integration could be added later without changing this flow.
- Quick entry is pattern-based; unusual phrasing falls back to the structured form.
- Scripts aren't written in the app — each script links to its external writing document.
- Notifications are in-app only (no email or Slack yet).
- Board columns follow the workflow stage computed from scripts; cards open a details drawer rather than supporting drag-and-drop, so nothing can bypass review or delivery confirmation.
- Uploaded files live in the database, which is simple and private but best kept to documents and images rather than video.
