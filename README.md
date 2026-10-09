# SCALE Media · Script production

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
- **Admins and managers have the same permissions for the work** (the first account is the admin). Only they approve, request revisions (a note is required), assign/reassign, change deadlines or script counts, move shoots, and manage clients, briefings, the team and settings. The admin-only tools (Master log, View as, Recording mode, Settings → Editors, the colour palette) are the exception, and so that they stay admin-only, **only an admin can make someone an admin or change an admin’s role, password or access** (a manager can’t promote themselves or reset the admin’s password), and there is always at least one active admin.
- **A script must be approved before it can be marked delivered** — no action, bulk selection or quick control can skip review.
- **A manager's delivery covers the whole batch:** when an admin or manager confirms delivery (from My work, the batch page's “Mark delivered” block or the checklist), every approved script in the batch is delivered, whoever wrote it. The other writers are notified and the history says it was on their behalf. A writer's confirmation covers only their own scripts.
- Partial review is normal: approve ten scripts while the rest are still being written.
- Lowering a batch's script count needs an explicit choice of which not-started / in-progress scripts to remove. Submitted, approved and delivered work is never removed; removed scripts stay in history and come back first if the count goes up again.
- Stale edits are rejected (409) instead of overwriting someone else's change.

### Sending and reviewing scripts as one document

Writers don't send scripts one at a time. On **My work** (or the batch page) they press **Send for review**, upload one PDF or paste one Google Doc / Drive link, and pick which of their scripts it covers — all of them by default, or a range like 1–10 — and add a note. Scripts have no titles of their own: the document is the deliverable.

- The **Review queue** shows **one card per document**: "Sarah Chen sent 12 scripts (1–12) as one document", with the file or link and the note. Managers choose **Approve all**, **Send back for revisions** (a note, plus an optional marked-up PDF or edited Google Doc), or **Approve with my edits** (attach the final version). "Review scripts one by one" is there for the rare partial decision.
- Sending back is one request with one note, so the writer sees one card — "12 scripts sent back to you" — with the reviewer's changes and a **Send revised version** button. The new document becomes version 2; every version and decision stays on the batch page under **Drafts & documents**.
- My work shows exactly where each script is: not sent (split into not started / writing), in review, sent back, approved and delivered. The old +/− counter is gone.
- Everything is still recorded per script, so progress, deadlines and delivery rules work exactly as before.

### My work

A writer's home. **New work** comes first: batches with scripts given to them in the last 7 days (`scripts.assigned_at`, set whenever a script gets a writer) that they haven't touched (nothing on the counter, nothing sent), marked New until they start (`isNewWork` in `shared/workflow.ts`). The My work menu link says New, and their Overview shows a banner. Then **To do** (sent back, to write, approved to deliver), soonest deadline first; **Waiting on review**, collapsed; and **Finished** (delivered in the last week, plus their delivery confirmations) at the bottom. Today and to-dos sit in a column beside the work on wide screens, and below New work on smaller ones. Each batch card leads with the client and its next deadline. Below that: one bar for where the writer's scripts are, a block per job with its button, the dates in the order they happen, and the brief and files.

### "Written so far" counter

Writers work in one master document, so each batch on **My work**, and their share on the batch page, has a **Written so far** counter (+ / −) they tap to keep their manager posted. Admins and managers also get a small + / − on each writer's row on the batch page. It is only an update: it never sends, withdraws or changes any script. It can't go below the scripts they've already sent or above how many they have. Managers see it as a lighter "written" layer in every progress bar, as "12 / 25 written · 8 sent" next to each writer on the batch page, and as one line in the history per writing session (repeated taps within 15 minutes update the same line).

### Script bank

**Script bank** in the sidebar lists every deliverable ever sent, across all clients and batches (archived ones included), for everyone on the team. A deliverable is one document, the PDF or link a writer sent covering their scripts for a batch ("scripts 1–45"), so it's one entry however many scripts are in it; only its newest version is listed (older ones are on the batch page). **Open** opens the document, **Approved edit** the version a manager approved with edits, and Timeliner once delivered. Search by client, batch, writer, file name or note, or type `#12` to find the document script 12 is in; filter by client, writer and status. Press `/` to jump to the search box.

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

**Your time zone.** Each person has their own time zone (`users.timezone`); the first time they open the site after it's unconfirmed (`timezone_confirmed_at`), a dialog asks for it with the device's zone preselected, and it asks again if the device later reports a different zone. Every time of day shown (notifications, activity, reviews, deliveries, Master log, the header clock) uses it via `useDisplayTz()`, falling back to the workspace time zone. Deadline dates and the daily cutoff stay on the workspace (HQ) time zone for everyone, and anyone whose own clock differs sees HQ time under theirs at the top of each page; the batch page also shows the cutoff converted to the viewer's time. While viewing as someone, the site shows their time zone. Change it from the account menu → Time zone.

**Synced calendars (Google Calendar).** Settings → Synced calendars takes a calendar's *Secret address in iCal format* (Google Calendar → Settings → the calendar → Integrate calendar). The server reads it on add, every 15 minutes (`CALENDAR_SYNC_MINUTES`, `CALENDAR_SYNC=off` to stop) and on *Sync now*, and stores the occurrences from 60 days back to 400 days ahead in `calendar_events` (`server/ical.ts` handles all-day and timed events, TZID, RRULE with EXDATE, moved and cancelled occurrences). Events show on the Calendar in the calendar's colour, in each viewer's time zone; writers see a calendar only when it's set to *Everyone*. It's read-only. A failed read keeps the last events and shows the reason in Settings. The secret address is stored on the server and never sent back to the browser; private network addresses are refused.

**Shoots that need writers.** For admins and managers, the Overview lists events on synced calendars (next 180 days) whose title looks like a shoot (`SHOOT_WORDS` in `server/calendar-shoots.ts`: shoot, filming, content day…) and that aren't fully planned on the site: no matching shoot (same client, a day either side), a shoot with no scripts, or scripts without a writer. The client comes from the event title (full name, or a distinctive word of it), and a client named in the calendar's own name (Google adds the owner to booked events) only wins when nothing else matches; without one it doesn't guess. A batch for that client with no shoot, due in the 3 weeks before the event, also counts as planning it. *Plan scripts* opens New shoot or New batch prefilled with the client, dates and that client's last script count and writer split; *Assign writers* opens the batch. Managers are notified once per new shoot after a sync (`calendar_shoot_marks`), and × hides one.

**Editors.** The *Editor* role is for video editors: they sign in like anyone else (Settings → Team → Add person → Editor, or **Give site access** beside someone in Settings → Editors, which moves them from that list to the team) and land on their own Home (`/editor`): their videos from Timeliner with the script to cut from (see *Editors tab and Timeliner*), shoots and final-script dates for the next 4 weeks, the newest finished scripts, and their to-dos. Their menu is Home, Calendar, Script bank, Clients and Resources, and all of it is read-only apart from their to-dos and saying which video they're on. They only see scripts once they're approved or delivered (plus past scripts): the Script bank hides everything else, and `/api/files/:id` only opens resource files, past scripts, approved reviews and documents whose scripts are all finished. The Calendar shows shoots, final dates and synced calendars set to *+ Editors* or *Everyone*; Clients shows guidance, shoots and resources but no batches or history. The server enforces it with a route allowlist (`server/editor-access.ts`): any other API call from an editor gets a 403. Editors are never offered as writers, can't be assigned or split scripts, and someone with unfinished scripts can't be made an editor until they're reassigned. Settings → Editors (admin only) is a separate list of editors who don't sign in, kept with a city, time zone and working hours; the same fields are on each person in Settings → Team (the time zone follows the city unless it's changed, and the same start and end means around the clock).

**To-dos.** Admins and managers can give anyone a to-do (with an optional due date), from **Team to-dos** on the Overview or **Add to-do** on a writer's row on a batch page (which links it to that batch). It shows on that person's My work and Overview, they're notified, and whoever gave it is notified when it's ticked off. Everyone can also add their own. Only the person it's for (or a manager) can tick it off; only whoever added it (or a manager) can change or remove it. Finished to-dos stay visible for a week.

**Sending approved work back.** On a batch page, each writer's row has **Send back for revisions…** for managers whenever that writer has approved or in-review scripts: pick the scripts (all by default) and write what to change.

**Colour palette** (Settings, admin only) changes the colours of the whole site for everyone, the sign-in page included. Six presets keep the house look (near-black shell, bright pastel accents): SCALE Media (the original), Sunset, Rose gold, Glacier, Citrus and Iris. **Customise colours** changes any of the seven accents (brand, action, in progress, review, done, revisions, alert) and the background tone; the server refuses an accent too dark for the dark text drawn on it (under 4.5:1). Picking previews instantly; Save applies it. The palette is stored in `settings.theme` and each browser remembers the last one so pages open in the right colours.

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

**Master log**, next to your name in the sidebar, lists every change (from the activity history), every page or file someone opened, sign-ins and failed sign-ins, and anything someone tried that they weren't allowed to do. Filter by person or kind, or search. Repeat views of the same page by the same person within 10 minutes count once. Page views, and failed sign-ins not tied to a team member's account (unknown emails), are kept for 400 days; changes and other sign-in records are kept indefinitely. Managers and writers can't open it.

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

### Timeliner delivery: confirmed by Timeliner itself

With `TIMELINER_API_KEY` set (Timeliner → Settings → Developers → Create API Key, with **Webhooks: read & write**, **Projects: read** and **Workspace: read**, plus **Tasks: read** for the Editors tab below; a read-only key can't connect, and the API needs Timeliner's Agency plan), the batch is marked delivered as soon as its script document lands in Timeliner — nobody pastes a link or presses a button.

- **Connecting.** The server registers a webhook with Timeliner the first time it starts with the key (or from **Settings → Timeliner → Connect**). It uses `PUBLIC_URL`, or the address Render sets, plus `/hooks/timeliner`. **Test** asks Timeliner to send a sample message and shows when it arrived.
- **What counts.** A PDF, Word or text file uploaded to a task or a project in Timeliner (`version.uploaded`, `file.uploaded`). The videos and images editors upload, and documents on a video's task, are ignored; a file put straight into a project counts only when its name says "script" or names a batch. Every message is checked against the secret Timeliner signs it with, refused if it's more than five minutes old, and acted on once even if Timeliner sends it twice.
- **One PDF per shoot, matched once.** Each shoot has one scripts PDF in Timeliner, and changes to it are new versions of the same task. The first time a PDF arrives it's linked to its batch, and every later version follows that link, whatever it's called. A batch is found by its PDF's task: the Timeliner project is only a hint about the client.
- **Which batch, the first time** (`server/matching.ts`). The client is the one whose PDFs are already in that Timeliner project, else the one whose name the Timeliner brand or project carries. Then: a date or word of one batch in the PDF's name (the task, file, sub-folder or project), else the shoot waiting for its scripts from 45 days after to 3 days before the day the PDF's task was made (a later version arriving weeks later doesn't change that day; a shoot whose scripts were all delivered by hand, without a PDF, isn't waiting for one), else a shoot that just happened and is still waiting, else the client's only undated batch with approved scripts.
- **What happens.** Every approved script in the batch is delivered, recorded under the uploader when their Timeliner email is on the team (else whoever connected Timeliner), and shown as **Confirmed by Timeliner**. Each new version delivers whatever was approved since; one with nothing new to deliver is listed as a new version and bothers nobody. Editors with a video from that shoot are told once per version. Managers and writers are notified as usual. Managers can undo a delivery (it's logged).
- **When it can't tell.** Two waiting shoots within 3 days, a name pointing at a batch that already has its PDF, a name like the PDF of a shoot still ahead (probably that PDF uploaded again as a new task), only a shoot delivered by hand around then, or no client or shoot that fits: the upload waits in **Settings → Timeliner** with why, and the batch it most likely belongs to. A manager picks the batch (any batch still without a PDF around then is offered, approved scripts or not); that links the PDF (so its next versions follow) and delivers what's approved, or nothing yet. When it picks the earliest of several waiting shoots, the managers are told which other it could have been. A PDF linked to the wrong shoot is moved with **Move to another batch** on its upload, once its delivery on the wrong batch is undone there; its next versions then follow it to the right one. A file put straight into a project with the same name as one linked there is a new version of it only while that shoot isn't past.

Without the key, delivery works as before: the writer adds scripts in Timeliner, selects them here, and clicks **Mark delivered to Timeliner**, optionally adding the Timeliner link and a note. The app records who confirmed and when, labels it **"Writer-confirmed delivery"**, and notifies managers. A batch is fully delivered only when every script is recorded as delivered.

### Editors tab and Timeliner

Videos are given to editors in Timeliner. The site reads them from there and shows who is cutting what; nobody assigns or claims a video on the site, and the site never changes anything in Timeliner (`server/editing.ts`). Each client has its dedicated editor, who in Timeliner is on the client's brand as an editor: a video nobody is assigned to on the video is that editor's (shown quietly as "via client"), and someone assigned on the video wins. A workspace admin's automatic access to every brand, and a supervisor on a brand, don't make them anyone's editor. Only editors are editors: someone the site knows by their Timeliner email as a writer, manager or admin (a writer on a brand to upload its scripts PDFs, say) is never anyone's editor, on a video or on its brand, and a video only they are on goes to its client's editor. A brand with two editors gives its videos to both, and the client is flagged ("Brightside has 2 editors in Timeliner — one editor per client"). A video is *not assigned* only when nobody is on it or on its brand.

- **What it reads.** With `TIMELINER_API_KEY` set, the server reads Timeliner every `TIMELINER_SYNC_MINUTES` (default 5, 1–1440; `TIMELINER_SYNC=off` stops it), and when a manager presses **Read Timeliner now** (at the top of the Editors tab, or in Settings → Timeliner). It reads the workspace's members, its brands and who is on each brand that has videos (one call per brand; a brand Timeliner can't answer for keeps what was read last), its tasks (newest first, up to 3,000; trashed tasks, documents, and videos approved or posted and untouched for 30 days are left out), the projects and sub-folders they sit in, and, for a video in revisions, review or with the client, the exact step name and when it moved there. It keeps a copy, so pages never wait on Timeliner; when a read fails, the last copy stays and the Editors tab shows Timeliner's message. Real data is read leniently: a field Timeliner leaves out or sends in another form takes a safe default, and a task, member, brand or project the site can't read at all is skipped and counted (its id goes to the server log once) while the rest is read. An answer that isn't a list is an error, never "nothing in Timeliner", so it can't empty the copy. The tab says what the last read found ("Read 214 videos · 6 people · 9 clients from Timeliner", plus how many were skipped).
- **Key permissions.** Reading needs **Tasks: read**, **Projects: read** (brands, and who is on them, come with it) and **Workspace: read** (the members), so a read-only key is enough. **Webhooks: read & write** is only for the webhook: with it, Timeliner tells the site when a video is added, changed, reassigned or trashed and it shows up straight away instead of at the next read, and it's what delivery by upload (above) needs. One key with all four does both. A webhook connected before the Editors tab existed is given the video messages the next time the server starts (when the key can write webhooks). A webhook switched off in Timeliner stays off until a manager presses **Connect** in Settings → Timeliner.
- **How it matches** (worked out again after every read, video message and pin; the rules are in `server/matching.ts`):
  - **People:** everyone in Timeliner with videos there (assigned on the video, or through their client) gets a card, as does every client's editor in Timeliner and every editor on the site. A Timeliner member's email is matched against the team's emails (any case): only then do their taps on the site (I'm on this) show on the card. Someone on the site under the same name (any case or spacing) but another email is flagged "Their email here … differs from Timeliner … — change one so they match", with their Timeliner work on the card. Someone not on the site is flagged "Not on the site — add them in Settings → Team as an Editor with <their Timeliner email>", or, when their name is in Settings → Editors, "give them site access in Settings → Editors" (their card then uses that city, time zone and hours). An editor on the site with nothing in Timeliner says which email Timeliner needs. Someone deactivated in Timeliner with nothing open isn't listed.
  - **Clients:** the client whose scripts PDFs are in the video's Timeliner project, else the client whose name the Timeliner brand carries, else the project's name. When two clients fit equally well it doesn't guess. A video whose Timeliner brand is no client here, or whose client has no scripts on the site, is normal work with no shoot ("No scripts on the site", under the brand's name), never "Not matched"; Not matched is only for a client that has scripts where the video couldn't be placed.
  - **Batches, by date:** of that client's batches with finished scripts (or a scripts PDF), never one whose shoot is after the video is due: the shoot that had just happened when the video was made in Timeliner (within 90 days). The day it was made counts, never its later versions, so a revision can't move it. A folder made for one shoot's scripts, or a folder or title naming the shoot's date ("Oct 14"), decides first. A video made up to 7 days before a shoot goes with that shoot when the shoot before already has one of that title in the same folder, or its number is past the shoot before's scripts. The folder's word (Organic, Ads) only decides between batches of the same shoot.
  - **Raw clips:** raw camera clips ("C0045", "IMG_1234.MOV", "20261006_143022", cinema cameras' "A001_C002_0101AB.R3D"), uploaded to Timeliner right after a shoot, go with the shoot that had just happened, never the next one, and have no script number. The titled, numbered video an editor then makes as a new task goes with the shoot whose raw clips that editor has been cutting (the folder's word still decides between batches of that shoot); the site remembers each clip's shoot for 45 days, because the raw clips are deleted soon after, and a clip moved to another shoot (a shoot date fixed, a pin) takes that with it.
  - **Kept:** a video that has been in review keeps its batch (unless it's moved to another folder, or it was matched by date before anyone had it and is then given to its editor), so fixing a shoot date on the site moves only videos that haven't been reviewed yet. Two videos with the same title in one folder on the same batch are flagged to check.
  - **Pins:** a manager can pin a video to a batch (and a script), or to no batch (`POST /api/editing/videos/:id/pin`; `DELETE` takes the pin off). A read never undoes a pin.
  - **Scripts:** "#12", "Script 12" or "No. 12" in the title, else the number standing on its own ("05 – Morning routine" → 5, not a date, a version or "9-5"), when the batch has that script. A video still To be edited gets one only when its title says it outright, and a raw clip never. An Ad numbered like an Organic video of the same batch gets none.
  - **The document:** with a number, the shoot's scripts PDF from Timeliner (its newest version), with the site's document (the edited version a manager approved, else the newest document it was sent in) as the second link; the site's document comes first when the script was approved here after that PDF version. Without a number (a raw clip), the shoot's whole scripts PDF, with the site's document holding most of the shoot's approved scripts as the second link; until a scripts PDF is linked (a read-only key never sees uploads, so this is the usual case without a webhook), that site document alone. A script that isn't approved gets no link, nor does a PDF that delivered nothing while some of its shoot's scripts aren't approved. A browser tab that can't open the PDF gets a short page saying why, with the way back. The PDF opens through `/api/editing/script-pdf/:batchId` (managers, and whoever has a video from that batch), which asks Timeliner for a fresh download link each time and redirects to it: Timeliner's links expire, so they're never stored or sent to the page, only kept in the server's memory until shortly before they expire.
- **States.** A few plain states, with Timeliner's step underneath: **To edit** (To be edited, In progress), **Revisions** (Revisions requested), **In review** (Needs review, Internal approval), **With client** (Awaiting client review) and **Approved** (Approved, Posted).
- **I'm on this, Pause, Done.** The site's own layer: what each editor is doing right now. On their Home, an editor taps **I'm on this** on one of their own videos in To edit or Revisions (it replaces whatever they were on). **Pause** keeps the time worked so far and shows them as paused; **Resume** carries on. **Done** records that they finished, ends what they were on, tells the managers at once, and the video waits under *Waiting on review* until Timeliner moves it. **Done never changes Timeliner**: the editor still moves the video to Needs review there. When Timeliner moves the video they're on to review (or further), what they were on ends by itself and that video becomes their last finished one. When Timeliner gives it to someone else or it's trashed, what they were on just ends: it isn't counted as theirs any more, so it's not their last finished video.
- **Editors tab** (managers, after Team): at the top, what the last read found and **Read Timeliner now**; when the last read failed, a red banner with Timeliner's answer, and the summary cards say how old their copy is instead of an all clear (an empty tab then says Timeliner couldn't be read, never "No editors yet"). Then four summary cards (editing now, with who's paused; due today, with how many of today's videos are sent to review; revisions; and waiting on you, by step), the one count of videos not matched to a shoot, and **Editors by client** ("one editor per client since Oct 9"): each client (or Timeliner brand) with its editor ("assigned in Timeliner", or whoever has most of its videos), its open videos, and a chip when it has two editors, its videos are split, or some aren't assigned (a client's warnings show only here; clients on the rule come first, the flagged ones first among them, and always show; one with no videos since the rule began reads "Before the one-editor rule"; on a phone each client is one line and the rest fold away); a client with an editor links to their card. Then a **Fix these people** line when anyone is flagged (each name scrolls to their card), and a calm card per editor: their name and biggest client ("Dentist Mike + 2 more", the rest on hover) and, when flagged, what to fix with the email to use and a link to Settings → Team (or Settings → Editors). Someone not on the site has no taps, so their card goes by next up and last finished. An admin or supervisor in Timeliner who is on a video to review it isn't counted as its editor and is never flagged to be added as one. Each card shows at most two pills (overdue or due today, revisions, off hours), what they're on (Editing now, Paused, Next up by deadline, or Off hours from their time zone and working hours) as one line ("#2 · Dentist Rates Viral Dental Hacks") with one line under it (its client and where it is, or "No scripts on the site", "Not matched to a shoot"), their plate as a bar with one line of counts, and the last video they finished beside **Videos**. An I'm on this left running for 10 hours, or outside the editor's working hours, shows as *Still marked as editing* and isn't counted as editing now (`isFocusStale` in `shared/workflow.ts`). Below the editors, videos created in the last 60 days that nobody has been given in Timeliner, grouped by folder and client ("Organic 26–30"), raw clips by the shoot they matched ("Oct 6 shoot · 9 clips not assigned"), with the script documents they're cut from and whom to give them ("usually Leo", the client's editor). Raw clips count as clips on an editor's plate ("24 clips to edit"). An editor's **Videos** lists their videos one row each, the title on one line with its script number up front, and in small words its client, "via client", "no scripts on the site" (a client without scripts on the site, or a Timeliner brand that isn't a client here: normal work, never asked to be pinned, though one whose brand isn't named like any client here can still be pinned), "not matched" (no shoot found; counted once above the client strip) or "check its shoot" (two with the same title on one shoot). Tapping a video shows its shoot, how it was matched and why, its script, and **Wrong shoot? Pin it** pins it to a batch of that client (and a script), or to no batch, until someone unpins it.
- **One editor per client.** Each client's videos go to one editor, who keeps its style from shoot to shoot. The rule began on Oct 9, 2026 (Settings → Timeliner → **One editor per client since**): only videos made in Timeliner since that day (HQ time) are checked against it, so older ones, given out before, still show on their editor's card and in every count but never flag a client or decide whom its videos usually go to. The site works it out from Timeliner, with nothing to fill in: a client's editor is the editor on its brand in Timeliner; for a client with nobody there, whoever has had most of its videos made in the last 60 days (a tie: whoever had one most recently; a manager or supervisor on a video only to review it doesn't count, unless nobody else is on it). Each editor's card leads with their clients ("Joshua Shalimar · 32 videos"), a client with two editors on its brand, or whose open videos are with more than one editor, is flagged ("Brightside: 18 with Maya, 3 with Sam — one editor per client"), and a shoot's clips nobody has been given yet name the client's editor ("Joshua Shalimar · 9 clips not assigned (usually Leo)").
- **Editor's Home.** Titled videos are listed one per row, the title on one line with its script number up front ("#5 · …"), with their script link: "Script 5", from "Scripts PDF · v3 · from Timeliner" (plus "being reviewed again" when that PDF is back in review), with the site's version as a smaller second link. Raw clips are folded by shoot under To edit ("Oct 6 shoot · 24 raw clips"), shown as "Raw clip C0045", each with its own I'm on this, and open the shoot's whole scripts PDF, or the shoot's script document on the site until there is one ("Scripts for the Oct 6 shoot"). A video the site couldn't match says "Not matched yet — a manager has been asked", and one for a client without scripts on the site says "No scripts on the site"; a video that's theirs through its client in Timeliner (nobody is on the video) says "via client"; a titled video matched only by its date says "matched by date" (raw clips by their date, and titled videos by their editor's raw clips, are the usual way and say nothing). The managers' notes on why a video was matched stay on the Editors tab.

### Quick entry (natural language)

"New work → Quick entry" reads sentences like *"Acme has a shoot October 12–13, 2026, needs 45 scripts, and Sarah is writing them."* and shows a structured preview (client, shoot dates, script count, writers, draft and final deadlines) that must be confirmed. It is a **pattern-based parser that runs locally — no AI provider is used**. It asks instead of guessing: missing years, 10/12-style dates, two people called Sarah, or an unknown client ("create it as a new client?", which needs an explicit tick). The structured forms are always available.

### Notifications, reminders and history

In-app notifications cover assignments, deadline changes, approaching / due-today / overdue deadlines, review requests, revision requests, blockers and delivery confirmations. Reminder notifications are deduplicated per user, batch, milestone and date. Overdue badges on the dashboard, production board and batch pages come from the data, so they stay visible after a notification is read.

**Reminders run inside the web server every 10 minutes while it is running** (on Render that means a paid instance; free instances sleep). Running several instances is safe: a Postgres advisory lock lets one run at a time, and deduplication prevents repeats. To use an external scheduler instead, set `REMINDERS=off` and run `npm run reminders` from a cron service.

Every meaningful change (creation, assignments, status changes, reviews, deliveries, deadline moves, blockers, target changes, archiving) is written to the activity history with actor and timestamp, shown on batch and client pages.

## Screens

Overview · My work · Script bank · Production (board + table, filters, search) · Calendar (month + list; writing periods, drafts due, final delivery, shoots) · Clients and client detail · Batch detail (drafts & documents, script checklist with range selection and bulk actions, brief, deadlines, review notes, delivery records, history) · Review queue (one card per document) · Resources · Settings (deadline rules, timezone & cutoff, reminders, team, editors) · Master log (admins) · What's new · Editors (managers: each editor's videos from Timeliner) · Editor home (editors). Dashboard cards link to the matching filtered records; chart bars reveal the underlying batches. Admins and managers see the whole team on the Overview; a writer's Overview counts only the scripts assigned to them.

Responsive: full sidebar on wide screens, collapsible icon rail on smaller desktops/tablets, navigation drawer and card layouts on phones (My work, deadlines, briefs and delivery confirmation are prioritised).

## Deploy to Render

1. Push this repo to GitHub, then in Render choose **New → Blueprint** and pick the repo. `render.yaml` creates:
   - the web service (`npm ci && npm run build`, then `node --max-old-space-size=200 --max-semi-space-size=2 dist/server/index.mjs`, health check `/healthz`, Node 22)
   - a PostgreSQL 16 database, with `DATABASE_URL` wired in automatically
2. When Render asks, fill in `MANAGER_EMAIL`, `MANAGER_NAME` and `MANAGER_PASSWORD` (at least 10 characters). That account is created on first start.
3. Open the `.onrender.com` URL, sign in, and add your second manager and writers in **Settings → Team**. The app doesn't send email: after you add someone (or reset their password) it shows a ready-to-send message with the sign-in link, their email and a generated temporary password, with a **Copy message** button to paste into WhatsApp, Slack or email.

**Team:** roles are Admin, Manager and Writer. A person's temporary password stays readable in Team (with **Copy sign-in details**) until they set their own; passwords people choose themselves are never stored readable — use **Reset password** to issue a new temporary one. **Remove** signs someone out for good, hands their unfinished scripts to a person you pick (or leaves them unassigned), and keeps their name in the history; adding the same email again restores the account.

`MANAGER_*` values are only used the first time the server starts with an empty database; changing them later does nothing. To change your password, use **Change password** in the menu under your name. If you're locked out, set `MANAGER_RESET_PASSWORD=1`, deploy (that account's password becomes `MANAGER_PASSWORD`, and it's created as a manager if missing), then remove the variable again.

**Keep the web service on a paid instance (the blueprint uses Starter).** Render's free web services sleep when nobody is using them, and the deadline reminders run inside the server, so they would stop. If you want the free plan anyway, set `REMINDERS=off` and add a Render **Cron Job** on the same repo that runs `npm run reminders` every 15 minutes, with build command `npm ci && npm run build`, `NODE_VERSION=22` and the same `DATABASE_URL` (it refuses to run without one).

The server creates its tables on first start and refuses to start without `DATABASE_URL`, so nothing is ever written to Render's temporary disk. Uploaded files are stored in Postgres, so no Render disk is needed. Pick a database plan with backups; check Render's current terms, because free databases are time-limited.

To set it up by hand instead of using the blueprint: create a PostgreSQL database, then a Node web service with build command `npm ci && npm run build`, start command `node --max-old-space-size=200 --max-semi-space-size=2 dist/server/index.mjs`, health check path `/healthz`, and environment variables `NODE_VERSION=22`, `DATABASE_URL` (the database's internal connection string), the three `MANAGER_*` values and, recommended, `TRUST_PROXY` (see Security).

**Memory.** The server runs in about 90–130 MB on the Starter plan's 512 MB, including during 25 MB uploads and in Recording mode:
- Start it with `node` directly, as above, not `npm start`: npm stays running next to the server and costs about 60 MB on its own. If your service was set up by hand, change its start command in Render → Settings.
- Uploads are streamed to a temporary file and written to the database in 4 MB pieces; downloads are streamed back out in 512 KB pieces. A file is never held in memory whole.
- Recording mode copies the workspace inside the database (see above), and its connections close when idle. The main connection pool is capped at 6, to spare the database plan's memory too.
- The Claude SDK loads the first time notes are read, and Paste notes accepts at most 20 MB of files per read.
- The embedded database (PGlite) is only for local use and the demo; it needs about 500 MB by itself, so production always uses PostgreSQL.

Any other Node 22 host with PostgreSQL works the same way (`railway.json` is kept for Railway).

## Security

- Passwords hashed with scrypt; sessions are random tokens (only their hash is stored) in an HTTP-only, SameSite=Lax cookie, `Secure` in production; sign-in is rate-limited per address and per account (the address comes from the proxy's `X-Forwarded-For`; set `TRUST_PROXY` to the number of proxies in front of the server to stop clients choosing it; use the smallest number for which your address in the Master log, after you sign in, matches what a "what is my IP" site shows: too low a number gives everyone the proxy's address, and too high a number lets clients choose their address again).
- Every permission is checked on the server; the UI only hides what you can't do.
- State-changing requests need a custom header and a same-origin `Origin`, which blocks cross-site request forgery.
- Recording mode fails closed: a page that's still recording when its practice copy is gone (a restart, or the copy was closed) gets an error instead of making the change on the real workspace.
- Uploaded files are stored in Postgres (up to 25 MB each), served only to signed-in users while a live resource references them, with `nosniff`, a sandboxing CSP, and forced download for anything that isn't a PDF, image or plain text. Executables are refused.
- Nothing is reported as saved until the server confirms it; failed saves show the error in place with the form still filled in.

## Tests

```sh
npm test                                              # embedded Postgres (PGlite)
TEST_DATABASE_URL=postgres://user@host/db npm test    # a real PostgreSQL (the schema is wiped first)
npm run typecheck
npm run lint                                          # ESLint, zero warnings allowed
npm run verify                                        # typecheck, lint, tests and build: what CI runs on every push
```

CI (`.github/workflows/ci.yml`) runs `npm run verify` and, alongside it, the API suites on PostgreSQL 16.

They cover: deadline maths across month and year boundaries, leap days, DST, multi-day shoots, business-day mode, timezones and the daily cutoff; progress (20 / 45 · 44%), stages and partial delivery; workflow permissions; the quick-entry parser; and through the real API — creating a client with a recording, document and uploaded file (and denying anonymous file access), both example shoots, the 20 / 25 split without double counting, draft completion not delivering, partial review and delivery, delivery records, moving a shoot with a manual override, batches without shoots, the dashboard's overdue / blocked / unassigned lists, writers being refused on every manager action sent directly to the API, CSRF, stale-edit rejection, target changes that protect work, reminder deduplication, sending ten scripts as one PDF and getting one review card and one revision request back, versioned resubmissions, script titles, the admin-only master log (views, sign-ins, blocked attempts), celebration moments (once each, never for your own decisions, milestones never twice), the "written so far" counter never touching script statuses, moving a shoot shifting writing starts, batch names and (optionally) manual dates, the changelog staying ordered with unique ids, and data persisting across restarts. `test/access.test.ts` lists who may call every API route and checks it against the running server, so a new route fails the tests until it's added there.

## Layout

```
shared/         date & deadline maths, workflow rules, quick-entry parser, API types (used by server and client)
                cities.ts: the cities and time zones people can be placed in
server/         Fastify API: auth, routes/ and the feature modules beside it (submissions, script bank, today…), reminders, migrations, demo seed
                control/: the editors list
client/         React app (Vite): styles/tokens.css holds every colour, radius, spacing and type token
scripts/        dev runner
test/           vitest suites
```

`ARCHITECTURE.md` explains how the code fits together (requests, access, data, invariants) and where new code goes; `CLAUDE.md` has the rules for changing it.

## Limitations

- Without `TIMELINER_API_KEY`, Timeliner delivery is **confirmed by the writer** here, not checked against Timeliner, and the Editors tab has no videos.
- Without Timeliner's webhook, the Editors tab can be up to `TIMELINER_SYNC_MINUTES` behind Timeliner.
- Quick entry is pattern-based; unusual phrasing falls back to the structured form.
- Scripts aren't written in the app — writers send a PDF or a Google Doc link, and edits happen in that document.
- Notifications are in-app only (no email or Slack yet).
- Board columns follow the workflow stage computed from scripts; cards open a details drawer rather than supporting drag-and-drop, so nothing can bypass review or delivery confirmation.
- Uploaded files live in the database, which is simple and private but best kept to documents and images rather than video.
