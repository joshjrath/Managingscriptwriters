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
- **Admins and managers have exactly the same permissions** (Admin is a label; the first account is the admin). Only they approve, request revisions (a note is required), assign/reassign, change deadlines or script counts, move shoots, and manage clients, briefings, the team and settings.
- **A script must be approved before it can be marked delivered** — no action, bulk selection or quick control can skip review.
- **A manager's delivery covers the whole batch:** when an admin or manager confirms delivery (from My work, the batch page's “Mark delivered” block or the checklist), every approved script in the batch is delivered, whoever wrote it. The other writers are notified and the history says it was on their behalf. A writer's confirmation covers only their own scripts.
- Partial review is normal: approve ten scripts while the rest are still being written.
- Lowering a batch's script count needs an explicit choice of which not-started / in-progress scripts to remove. Submitted, approved and delivered work is never removed; removed scripts stay in history and come back first if the count goes up again.
- Stale edits are rejected (409) instead of overwriting someone else's change.

### Sending and reviewing scripts as one document

Writers don't send scripts one at a time. On **My work** (or the batch page) they press **Send for review**, upload one PDF or paste one Google Doc / Drive link, and pick which of their scripts it covers — all of them by default, or a range like 1–10. They can add titles for all of them at once (one per line) and a note.

- The **Review queue** shows **one card per document**: "Sarah Chen sent 12 scripts (1–12) as one document", with the file or link, the note and the titles. Managers choose **Approve all**, **Send back for revisions** (a note, plus an optional marked-up PDF or edited Google Doc), or **Approve with my edits** (attach the final version). "Review scripts one by one" is there for the rare partial decision.
- Sending back is one request with one note, so the writer sees one card — "12 scripts sent back to you" — with the reviewer's changes and a **Send revised version** button. The new document becomes version 2; every version and decision stays on the batch page under **Drafts & documents**.
- My work shows exactly where each script is: not sent (split into not started / writing), in review, sent back, approved and delivered. The old +/− counter is gone.
- Script titles can also be set from **Titles** on the batch page or My work: paste a list and it's applied in order, or keep the "3. Title" numbers.
- Everything is still recorded per script, so progress, deadlines and delivery rules work exactly as before.

### "Written so far" counter

Writers work in one master document, so each batch on **My work**, and their share on the batch page, has a **Written so far** counter (+ / −) they tap to keep their manager posted. Admins and managers also get a small + / − on each writer's row on the batch page. It is only an update: it never sends, withdraws or changes any script. It can't go below the scripts they've already sent or above how many they have. Managers see it as a lighter "written" layer in every progress bar, as "12 / 25 written · 8 sent" next to each writer on the batch page, and as one line in the history per writing session (repeated taps within 15 minutes update the same line).

### Script bank

**Script bank** in the sidebar lists every deliverable ever sent, across all clients and batches (archived ones included), for everyone on the team. A deliverable is one document, the PDF or link a writer sent covering their scripts for a batch ("scripts 1–45"), so it's one entry however many scripts are in it; only its newest version is listed (older ones are on the batch page). **Open** opens the document, **Approved edit** the version a manager approved with edits, and Timeliner once delivered. Search by client, batch, writer, file name, note or a script's title, or type `#12` to find the document script 12 is in; filter by client, writer and status. Press `/` to jump to the search box.

**Past scripts:** admins and managers can add documents from before the platform with **Add past scripts**: upload one or more PDFs (or paste a link), choose the client, and optionally who wrote them (a team member's name links it to them), when, and how many scripts each holds. They show as "Past script" entries, are searched with everything else, and can be removed.

### Calendar views

**Days** is a timeline you scroll left and right freely (trackpad, swipe, or grab the background and fling it); more days load in both directions as you go. Choose 1, 3 or 5 days, a week or 2 weeks on screen; wider days show each event's details. **Month** slides between months, and **List** is an agenda. Shoots can be dragged between days in Days and Month.

### Paste notes (AI)

**New work → Paste notes** (or **Paste notes** on the Clients page): paste notes the way you'd text them — or attach a PDF / text file — and Claude reads them into clients (with description, brand voice and guidance such as posting instructions), briefings, shoots and script batches. You get an editable preview: fix any date or count, type writer names, untick clients you don't want, and answer its questions ("does next Wednesday mean Sep 30 or Oct 7?") to have it read the notes again. **Nothing is saved until you press Save**, and then everything is saved together or not at all. Existing clients (matched by name) keep what they have and get the new notes added underneath; importing the same notes twice doesn't duplicate shoots, batches or briefings. Unknown script counts don't create batches; writer names are matched to the team.

To turn it on, add `ANTHROPIC_API_KEY` (from console.anthropic.com → API keys) to the server's environment — on Render: web service → Environment. It uses Claude Opus 5.5 with structured output (and the API's automatic fallback if a request is declined); expect roughly 5–10 cents per import. Only the notes you paste are sent.

### Potential clients

The Clients page has a **Potential clients** section for people you're talking to (add one with **Potential client**, or pick *Potential client* in New work → New client). It's only a label: a potential client can have shoots, batches and deadlines like any client, and they show on the calendar, in Production and in reminders as usual. When they sign, **drag the card into Clients** — or press **Mark as client** (on the card or their page) — and it moves across; the history records when they became a client, and new clients get a "New client" tag for a week. Any client can be dragged into Potential clients too, and nothing about their work changes.

### Shoots before scripts

A shoot can be booked on its own: New shoot → **Plan scripts later**. Writers are optional too — scripts can be created unassigned. When you know more, use **Add scripts** on the shoot (calendar, client page or Overview). Managers get a **planning reminder** a set number of days before the shoot (Settings → *Remind managers to plan scripts*, default 14) while a shoot has no scripts or has unassigned scripts, then again at 7, 3 and 1 days — each once. Batches without a shoot are counted from their drafts-due date.

### Moving a shoot

Change a shoot's dates from **Change dates** on the batch or client page, by clicking the shoot on the calendar, or by **dragging it to another day on the calendar** (multi-day shoots keep their length). A preview lists everything that moves before anything changes: automatic draft and final deadlines are recalculated, the planned writing start moves by the same number of days, and batches named after the shoot's dates ("Shoot · Oct 7, 2026") get the new dates. Manually set deadlines are kept and flagged for a check, or moved by the same number of days if you tick that option. Writers are notified and each batch's history records the change.

### Today pill

**Drafts from final delivery.** Entering a final delivery date fills drafts due with the same gap the shoot rules leave between them (`draftFromFinal` in `shared/dates.ts`: draft offset − final offset, in calendar or working days), in New batch, the New shoot overrides and Edit batch, until drafts are changed by hand. The server does the same for a batch created without a shoot and without a drafts date. Migration 18 (`fillMissingDeadlines` in `server/backfill.ts`, a one-time function migration) gave every existing batch with only one deadline the other one: from its shoot when it has one, otherwise by the same gap.

**Client resources on a batch.** When creating a batch (or a shoot with its scripts), the form lists the chosen client's resources (links and files) to pick for the writers; picked ones are stored in `batch_resources` and show on those writers' My work with the batch. A batch page lists the picked ones under *This batch* and the rest under *More from {client}*, where managers can add or take off resources (taking one off never deletes it from the client). Resources must belong to the batch's client.

**Your time zone.** Each person has their own time zone (`users.timezone`); the first time they open the site after it's unconfirmed (`timezone_confirmed_at`), a dialog asks for it with the device's zone preselected, and it asks again if the device later reports a different zone. Every time of day shown (messages, notifications, activity, reviews, deliveries, Master log, the header clock) uses it via `useDisplayTz()`, falling back to the workspace time zone. Deadline dates and the daily cutoff stay on the workspace (HQ) time zone for everyone, and anyone whose own clock differs sees HQ time under theirs at the top of each page; the batch page also shows the cutoff converted to the viewer's time. While viewing as someone, the site shows their time zone. Change it from the account menu → Time zone.

**Synced calendars (Google Calendar).** Settings → Synced calendars takes a calendar's *Secret address in iCal format* (Google Calendar → Settings → the calendar → Integrate calendar). The server reads it on add, every 15 minutes (`CALENDAR_SYNC_MINUTES`, `CALENDAR_SYNC=off` to stop) and on *Sync now*, and stores the occurrences from 60 days back to 400 days ahead in `calendar_events` (`server/ical.ts` handles all-day and timed events, TZID, RRULE with EXDATE, moved and cancelled occurrences). Events show on the Calendar in the calendar's colour, in each viewer's time zone; writers see a calendar only when it's set to *Everyone*. It's read-only. A failed read keeps the last events and shows the reason in Settings. The secret address is stored on the server and never sent back to the browser; private network addresses are refused.

**Shoots that need writers.** For admins and managers, the Overview lists events on synced calendars (next 180 days) whose title looks like a shoot (`SHOOT_WORDS` in `server/calendar-shoots.ts`: shoot, filming, content day…) and that aren't fully planned on the site: no matching shoot (same client, a day either side), a shoot with no scripts, or scripts without a writer. The client comes from the event title (full name, or a distinctive word of it); without one it doesn't guess. *Plan scripts* opens New shoot or New batch prefilled with the client, dates and that client's last script count and writer split; *Assign writers* opens the batch. Managers are notified once per new shoot after a sync (`calendar_shoot_marks`), and × hides one.

**Messages.** Anyone on the team can message anyone else. The round button in the bottom-right corner lists conversations; each one opens as a docked chat window along the bottom (up to three, one on phones), Messenger-style, and an incoming message pops its window open. Unread counts show on the button and in the sidebar. **Writers** (managers; **Messages** for writers) lists the team with workload, open to-dos, local time and the latest message. The client polls lightly: the inbox every 8 seconds and an open chat every 3 seconds for only newer messages, and nothing while the tab is hidden. While viewing as someone, chats are read-only and opening one doesn't mark anything read.

**To-dos.** Admins and managers can give anyone a to-do (with an optional due date), from **Team to-dos** on the Overview or **Add to-do** on a writer's row on a batch page (which links it to that batch). It shows on that person's My work and Overview, they're notified, and whoever gave it is notified when it's ticked off. Everyone can also add their own. Only the person it's for (or a manager) can tick it off; only whoever added it (or a manager) can change or remove it. Finished to-dos stay visible for a week.

**Sending approved work back.** On a batch page, each writer's row has **Send back for revisions…** for managers whenever that writer has approved or in-review scripts: pick the scripts (all by default) and write what to change.

**Colour palette** (Settings, admin only) changes the colours of the whole site for everyone, the sign-in page included. Six presets keep the house look (near-black shell, bright pastel accents): Scale Media (the original), Sunset, Rose gold, Glacier, Citrus and Iris. **Customise colours** changes any of the seven accents (brand, action, in progress, review, done, revisions, alert) and the background tone; the server refuses an accent too dark for the dark text drawn on it (under 4.5:1). Picking previews instantly; Save applies it. The palette is stored in `settings.theme` and each browser remembers the last one so pages open in the right colours.

**Writing progress** on the Overview shows the latest + / − counter updates (newest first, from the past week): who, which batch, how many are written and how long ago. Each writer's share is drawn as one block per script (delivered, approved, sent for review, sent back for revisions, written but not sent, still to write), and the ones counted today glow. A **+N today** badge shows how far a counter went up today, on the Overview, the batch page's Assignments and the batch cards. The counter remembers where it stood at the start of each day (workspace time) to work this out. Writers see only their own.

At the top of My work and the Overview. **Today's tasks** are the scripts due today (drafts or final delivery), plus anything overdue that's still open or was finished today. Drafts count as done once sent for review, final delivery once delivered. Writers see their own day; on the Overview admins and managers see the whole team, and a writer's My work page shows that writer's day. When everything is done the pill turns into rolling green waves for the rest of the day, with confetti the first time (once per day). A day with nothing due is all clear, so it shows the waves too (no confetti). Animations follow the account menu's Animations switch and the system's reduce-motion setting.

### Celebrations and animation

- Progress bars fill like liquid, with a moving edge and rising bubbles; they spark when a batch moves forward, and the big ring on a batch page fills with water.
- Sending scripts launches a paper plane. Approving throws a little confetti from the button and the card glides out of the queue (sent-back cards glide the other way).
- **Moments**: when a writer's scripts are approved, the next time they open the app they get "Congrats! Your scripts for … just got approved". Finishing all your drafts or delivering your whole batch gets full-screen confetti; managers are told when a writer finishes their drafts and when a whole batch is delivered. A send-back shows a calm heads-up with the note instead. Each moment shows once.
- Pages, lists, dialogs, toasts, tabs, the sidebar highlight and numbers animate smoothly. Animations follow the device's "reduce motion" setting, and anyone can switch them off in their account menu (remembered in that browser).

### What's new

**What's new**, at the very bottom of the sidebar, lists every change to the platform since the first version, with a dot when there's something you haven't seen. Entries live in `shared/changelog.ts`; every change adds one (see `CLAUDE.md`).

### Master log (admins only)

**Master log**, next to your name in the sidebar, lists every change (from the activity history), every page or file someone opened, sign-ins and failed sign-ins, and anything someone tried that they weren't allowed to do. Filter by person or kind, or search. Repeat views of the same page by the same person within 10 minutes count once. Page views are kept for 400 days; changes and sign-ins are kept indefinitely. Managers and writers can't open it.

### View as and Recording mode (admins only)

For recording tutorials. From your account menu:

- **View as…** shows the whole site exactly as that person sees it (their My work, their notifications, their menu). On the real workspace it's **view only**: changes are refused, and the app's own background writes (dismissing their celebrations, marking their notifications read) quietly do nothing.
- **Recording mode** makes a private practice copy of the whole workspace for your sign-in only: a separate schema in the same database, filled by the database itself, so it costs the server about 1 MB (no second database engine). Everything works in it, including viewing as someone and acting as them. Turning it off (or signing out, 6 idle hours, or a server restart) drops the copy; nobody else ever sees it. Uploaded files stay readable in it without being copied, and only the newest 500 Master log entries are copied. At most 2 copies exist at once.

A small bar at the bottom shows what's on (Switch person, Back to me, Turn off) and can shrink to a dot. The Master log records when each starts and stops, and pages viewed as someone are logged under the admin with "(viewing as …)".

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

### Control Center (admin only)

A separate, private view of the whole operation, built as its own visual world rather than another page of the app. A tiny **CONTROL CENTER** link sits under the wordmark in the admin's sidebar; anyone else only reaches it by going to `/control-center` directly. Clicking it drains the page into darkness (colour, depth and the wordmark go, a scan passes) while the Control Center loads, then a minimal portal asks for authorization.

**Clearance** uses the platform's own accounts: a signed-in admin re-enters their password; someone signed out gives their email and password (which also signs them in). The server then marks that session *cleared* for 12 hours (`sessions.control_until`). Every Control Center request checks it, managers and writers are always refused ("clearance insufficient"; `isAdmin` in `server/control/access.ts`), failed attempts are throttled like sign-in, and clearances, failures and refusals go to the Master log. **Lock clearance** (System view or the command palette) ends it; signing out ends it too. Hiding the link is only an aesthetic choice: the world data is never served to a session that isn't cleared, and nothing secret is in the page. `verifyOperator` in `server/control/routes.ts` is the one place to swap in another identity check.

After a short initialization (each line is a real step: identity, the snapshot, nodes, timezones, operations, the renderer) a point becomes a cloud of particles, the outline of Earth settles first, then the planet. On a repeat visit within the clearance the sequence is shorter.

**The world.** A particle globe (Natural Earth land, lit by the real sun, with a warm band on the terminator) carries every placed team member as a node on their city, plus the editors the admin adds (city, time zone and working hours only: they can't sign in, have no scripts and are never offered as writers). Nodes follow local time: a pulse when active, a slow heartbeat in deep work, a bead in orbit while reviewing, dim when off shift, a breath in the hour before a shift, a different ring for late-night work, a warm ring at local dawn and dusk, and a faster rhythm when a deadline is under 12 hours away. Their scripts orbit them (wider while in review, higher with the client). Arcs join writers and reviewers; handoffs travel them as packets of light and land with a *TRANSFER RECEIVED* label. Pressure appears in place as a broken amber ring and converging arcs: deadline collisions, overload, revision pile-ups, reviews waiting over 48 hours, too much converging on one reviewer, blocked batches, client approvals holding things up, hours nobody covers, and work landing after hours. Clicking a person turns the planet to their city and sets their name, local time, status, current signal, progress, next deadline and orbiting scripts beside it.

**Views** (keys 1–9, or the left edge): World · Missions (projects on an orbit; opening one draws its phase arc, RESEARCH → DELIVERY, with its scripts sitting in their phase) · Deadlines (24H / 48H / 7D / 30D orbits: the closer the deadline, the tighter and faster the orbit) · Timezones (a 24-hour dial of shifts and coverage, with a scrubber and *Follow the sun*, which turns the planet and the terminator through the day) · Signals (handoffs and the full feed) · Constellation (people, projects and clients as a network) · Galaxy (every script as a star round its writer) · Archive (delivered work as constellations deeper in space) · System (diagnostics, data source, renderer).

**People** (the PEOPLE control at the top, *people* in the palette, or the prompt when no one is on the map yet) is where the admin places everyone without leaving the Control Center: each team member's city, time zone and working hours, and editors added, edited or removed. The time zone follows the city unless it's changed (for someone whose city isn't listed: pick the nearest one and set their zone); a shift can be any length, and the same start and end means around the clock. A live preview shows their local time and whether they're on shift, and saving turns the globe to them. The same fields are in Settings → Team and Settings → Editors.

**Controls:** drag to turn (with inertia), scroll or pinch to zoom (scrolling past the limit enters or leaves a layer), ⌘K / Ctrl+K or `/` for the command palette (people, cities, clients, projects, script codes and commands such as *deadlines*, *writers online*, *reviews*, *follow the sun*, *lock*), arrows to turn or step through operations and hours, Esc to step back out. Sound is off by default (a very quiet synthesized hum and ticks when on).

**Data.** The server builds one snapshot (`shared/control.ts` describes it; `server/control/`) from the real workspace: team members and editors with a city, live batches (and the 60 most recently finished, for the archive) as projects with their scripts, recent submissions and reviews as handoffs between the people who sent and reviewed them, and the activity history as the feed. With no one placed yet the globe is simply empty and offers to place people. There's no sample data unless the server is started with `CONTROL_CENTER_DATA=simulated`, which swaps in a clearly labelled sample operation (`server/control/simulated.ts`, handoffs replayed rather than observed). Clocks, the sun, shifts, coverage and anomalies are computed from real time on each device (`shared/control.ts`), never stored. The snapshot refreshes every 20 seconds.

**Rendering.** three.js, loaded only with the Control Center (its own chunk, so the rest of the app is unaffected), and kept light on the GPU and memory: no multisampling (the dots are smoothed in their shader), the pixel ratio capped at 1.5, particle counts per quality tier picked from the device and stepped down if it can't keep up, and whichever GPU the system prefers rather than the high-performance one. It draws at 60 fps only while something moves (a drag, a camera move, a handoff in flight), 30 while the planet just turns, 15 when the window isn't in front, and not at all in a hidden tab. Buffers are reused across the 20-second refreshes (a refresh with nothing new on the map changes nothing), static geometry drops its CPU copy once it's on the GPU, and leaving the Control Center releases the whole WebGL context. The 2D fallback is paced the same way. Reduced-motion turns off auto-rotation, parallax and the long reveal. Without WebGL it draws the same globe, nodes, arcs and handoffs on a 2D canvas. Phones keep the globe, nodes, focus and search, with the typography set under the planet.

## Screens

Overview · My work · Script bank · Production (board + table, filters, search) · Calendar (month + list; writing periods, drafts due, final delivery, shoots) · Clients and client detail · Batch detail (drafts & documents, script checklist with range selection and bulk actions, brief, deadlines, review notes, delivery records, history) · Review queue (one card per document) · Resources · Settings (deadline rules, timezone & cutoff, reminders, team, editors for the Control Center) · Master log (admins) · What's new · Control Center (admin only). Dashboard cards link to the matching filtered records; chart bars reveal the underlying batches. Admins and managers see the whole team on the Overview; a writer's Overview counts only the scripts assigned to them.

Responsive: full sidebar on wide screens, collapsible icon rail on smaller desktops/tablets, navigation drawer and card layouts on phones (My work, deadlines, briefs and delivery confirmation are prioritised).

## Deploy to Render

1. Push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` creates:
   - the web service (`npm ci && npm run build`, then `node --max-old-space-size=200 --max-semi-space-size=2 dist/server/index.mjs`, health check `/healthz`, Node 22)
   - a PostgreSQL 16 database, with `DATABASE_URL` wired in automatically
2. When Render asks, fill in `MANAGER_EMAIL`, `MANAGER_NAME` and `MANAGER_PASSWORD` (at least 10 characters). That account is created on first start.
3. Open the `.onrender.com` URL, sign in, and add your second manager and writers in **Settings → Team**. The app doesn't send email: after you add someone (or reset their password) it shows a ready-to-send message with the sign-in link, their email and a generated temporary password, with a **Copy message** button to paste into WhatsApp, Slack or email.

**Team:** roles are Admin, Manager and Writer. A person's temporary password stays readable in Team (with **Copy sign-in details**) until they set their own; passwords people choose themselves are never stored readable — use **Reset password** to issue a new temporary one. **Remove** signs someone out for good, hands their unfinished scripts to a person you pick (or leaves them unassigned), and keeps their name in the history; adding the same email again restores the account.

`MANAGER_*` values are only used the first time the server starts with an empty database; changing them later does nothing. To change your password, use **Change password** in the menu under your name. If you're locked out, set `MANAGER_RESET_PASSWORD=1`, deploy (that account's password becomes `MANAGER_PASSWORD`, and it's created as a manager if missing), then remove the variable again.

**Keep the web service on a paid instance (the blueprint uses Starter).** Render's free web services sleep when nobody is using them, and the deadline reminders run inside the server, so they would stop. If you want the free plan anyway, set `REMINDERS=off` and add a Render **Cron Job** on the same repo that runs `npm run reminders` every 15 minutes with the same `DATABASE_URL`.

The server creates its tables on first start and refuses to start without `DATABASE_URL`, so nothing is ever written to Render's temporary disk. Uploaded files are stored in Postgres, so no Render disk is needed. Pick a database plan with backups; check Render's current terms, because free databases are time-limited.

To set it up by hand instead of using the blueprint: create a PostgreSQL database, then a Node web service with build command `npm ci && npm run build`, start command `node --max-old-space-size=200 --max-semi-space-size=2 dist/server/index.mjs`, health check path `/healthz`, and environment variables `NODE_VERSION=22`, `DATABASE_URL` (the database's internal connection string) and the three `MANAGER_*` values.

**Memory.** The server runs in about 90–130 MB on the Starter plan's 512 MB, including during 25 MB uploads and in Recording mode:
- Start it with `node` directly, as above, not `npm start`: npm stays running next to the server and costs about 60 MB on its own. If your service was set up by hand, change its start command in Render → Settings.
- Uploads are streamed to a temporary file and written to the database in 4 MB pieces; downloads are streamed back out in 512 KB pieces. A file is never held in memory whole.
- Recording mode copies the workspace inside the database (see above), and its connections close when idle. The main connection pool is capped at 6, to spare the database plan's memory too.
- The Claude SDK loads the first time notes are read, and Paste notes accepts at most 20 MB of files per read.
- The embedded database (PGlite) is only for local use and the demo; it needs about 500 MB by itself, so production always uses PostgreSQL.

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

They cover: deadline maths across month and year boundaries, leap days, DST, multi-day shoots, business-day mode, timezones and the daily cutoff; progress (20 / 45 · 44%), stages and partial delivery; workflow permissions; the quick-entry parser; and through the real API — creating a client with a recording, document and uploaded file (and denying anonymous file access), both example shoots, the 20 / 25 split without double counting, draft completion not delivering, partial review and delivery, delivery records, moving a shoot with a manual override, batches without shoots, the dashboard's overdue / blocked / unassigned lists, writers being refused on every manager action sent directly to the API, CSRF, stale-edit rejection, target changes that protect work, reminder deduplication, sending ten scripts as one PDF and getting one review card and one revision request back, versioned resubmissions, script titles, the admin-only master log (views, sign-ins, blocked attempts), celebration moments (once each, never for your own decisions, milestones never twice), the "written so far" counter never touching script statuses, moving a shoot shifting writing starts, batch names and (optionally) manual dates, the changelog staying complete and ordered, and data persisting across restarts.

## Layout

```
shared/         date & deadline maths, workflow rules, quick-entry parser, API types (used by server and client)
                control.ts: the Control Center's world model, clocks, sun, coverage and anomalies; cities.ts
server/         Fastify API: auth, routes/, reminders, migrations, demo seed
                control/: Control Center clearance and world sources (live workspace, simulated network)
client/         React app (Vite): styles/tokens.css holds every colour, radius, spacing and type token
                src/control/: the Control Center (its own styles, overlay typography, engine/ for three.js)
scripts/        dev runner; gen-landmask.mjs regenerates the globe's land mask from Natural Earth
test/           vitest suites
```

## Limitations

- Timeliner delivery is **manually confirmed by the writer**, not verified. An official Timeliner API integration could be added later without changing this flow.
- Quick entry is pattern-based; unusual phrasing falls back to the structured form.
- Scripts aren't written in the app — writers send a PDF or a Google Doc link, and edits happen in that document.
- Notifications are in-app only (no email or Slack yet).
- Board columns follow the workflow stage computed from scripts; cards open a details drawer rather than supporting drag-and-drop, so nothing can bypass review or delivery confirmation.
- Uploaded files live in the database, which is simple and private but best kept to documents and images rather than video.
