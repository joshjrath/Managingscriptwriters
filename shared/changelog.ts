// What's new: every change to the platform, newest first, since the first
// version. Add an entry here with every change you ship (see CLAUDE.md).
// `id` must be unique and never change; it's how the "new" dot knows what
// someone has already seen.

import type { ISODate } from './dates';

export type ChangeTag = 'new' | 'improved' | 'fixed';

export interface ChangelogEntry {
  id: string;
  date: ISODate;
  title: string;
  summary: string;
  changes: { tag: ChangeTag; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-01-palettes',
    date: '2026-10-01',
    title: 'Colour palettes',
    summary: 'The admin can change the site’s colours for everyone: six palettes with the same feel, or your own tweaks.',
    changes: [
      { tag: 'new', text: 'Settings → Colour palette (admin only): pick Scale Media (the original), Sunset, Rose gold, Glacier, Citrus or Iris. Each keeps the dark look with bright pastel accents. You see it as you click, and Save applies it across the whole site for everyone, the sign-in page included.' },
      { tag: 'new', text: 'Customise colours: change any of the seven colours (brand, action, in progress, review, done, revisions, alert) and the background tone (charcoal, warm, cool or plum). Colours too dark for the dark text on them are flagged and can’t be saved. Reset goes back to the palette.' },
      { tag: 'improved', text: 'Confetti and celebrations use the palette’s colours.' },
    ],
  },
  {
    id: '2026-09-30-today-clear',
    date: '2026-09-30',
    title: 'Green waves on a clear day',
    summary: 'When nothing is due today, the Today bar shows the green waves too.',
    changes: [
      { tag: 'improved', text: 'A day with nothing due now counts as all clear: the Today bar on My work and the Overview turns into rolling green waves instead of a grey “Nothing due today”.' },
    ],
  },
  {
    id: '2026-09-30-control-center-people',
    date: '2026-09-30',
    title: 'Control Center: real data, and placing people from inside it',
    summary: 'The Control Center now only shows your real team and work, you can place people and editors from inside it, and it’s much lighter on your computer.',
    changes: [
      { tag: 'improved', text: 'The Control Center only shows your real workspace now: your team, editors, batches and clients. The sample people and clients are gone. Until someone is on the map, the globe is empty and offers to place your team.' },
      { tag: 'new', text: 'PEOPLE, at the top of the Control Center: set each team member’s city, time zone and working hours, and add, edit or remove editors, without leaving it. You see their local time as you type, and saving turns the globe to them.' },
      { tag: 'new', text: 'Time zones: someone’s time zone follows their city, but you can change it (in the Control Center or in Settings). If their city isn’t listed, pick the nearest one and set their time zone.' },
      { tag: 'improved', text: 'Working hours can be any length now, up to around the clock (the same start and end). The 16-hour limit is gone.' },
      { tag: 'improved', text: 'The Control Center uses much less graphics memory and power: it draws less often when nothing is moving, stops completely in a hidden tab, and frees everything when you leave.' },
      { tag: 'fixed', text: 'The “network quiet” messages in the Control Center sat off to the side instead of under the numbers.' },
    ],
  },
  {
    id: '2026-09-30-writing-pulse',
    date: '2026-09-30',
    title: 'See writers’ counters move',
    summary: 'A new Writing progress panel on the Overview, a block for every script, and a “+3 today” badge when a writer taps +.',
    changes: [
      { tag: 'new', text: 'Overview → Writing progress: the latest counter updates, newest first, with who, which batch, how many are written and how long ago. Click one to open the batch.' },
      { tag: 'new', text: 'Every writer’s share is drawn as one block per script: delivered, approved, sent for review, written but not sent, and still to write. The ones counted today glow.' },
      { tag: 'new', text: 'A “+3 today” badge shows how far a writer’s counter went up today, on the Overview, the batch page’s Assignments, and the batch cards on the Production board and Overview.' },
    ],
  },
  {
    id: '2026-09-30-control-center-admin-editors',
    date: '2026-09-30',
    title: 'Control Center: admin only, and editors on the globe',
    summary: 'Only the admin can open the Control Center now, and you can add editors so their local time shows there too.',
    changes: [
      { tag: 'improved', text: 'The Control Center is now for the admin only. Managers and writers are refused, and the link only shows in the admin’s sidebar. It’s no longer on the sign-in page.' },
      { tag: 'new', text: 'Settings → Editors (admin only): add editors with their city and working hours. They appear in the Control Center with their local time, but they can’t sign in and aren’t offered as writers.' },
    ],
  },
  {
    id: '2026-09-30-control-center',
    date: '2026-09-30',
    title: 'The Control Center',
    summary: 'For admins and managers: a private view of the whole operation on a live globe.',
    changes: [
      { tag: 'new', text: 'Admins and managers can open the Control Center from the small link under the Scale Media wordmark, or from the sign-in page. It asks for your password first, and stays open for 12 hours on that device. Writers can’t open it.' },
      { tag: 'new', text: 'Everyone on the team appears on a globe at their city, with their local time, whether they’re on shift, what they’re working on and their next deadline. The planet is lit by the real sun, so you can see who is in daylight.' },
      { tag: 'new', text: 'Other views show each batch and where its scripts are, deadlines as orbits (the closer the deadline, the tighter the orbit), a 24-hour dial of who covers which hours, scripts travelling between writers and reviewers, the team as a network, every script as a star, and delivered work as an archive.' },
      { tag: 'new', text: 'It points out pressure: several deadlines landing on one person, someone with too much on, revisions piling up, reviews waiting too long, blocked batches and hours nobody covers.' },
      { tag: 'new', text: 'Settings → Team now has City and Working hours for each person. Until at least two people have a city, the Control Center shows a sample network, clearly labelled as simulated.' },
      { tag: 'fixed', text: 'The demo workspace sets itself up again.' },
    ],
  },
  {
    id: '2026-09-30-batch-delivery-catch-up',
    date: '2026-09-30',
    title: 'Batches an admin already delivered are now fully delivered',
    summary: 'Batches where an admin or manager confirmed delivery before the whole-batch rule have caught up.',
    changes: [
      { tag: 'fixed', text: 'If an admin or manager confirmed delivery on a batch before today’s change, the other writers’ approved scripts were left waiting. They’re now delivered too, so the Production board, Overview and calendar show the batch as delivered. The batch history notes the catch-up. Scripts that weren’t approved stay as they are.' },
    ],
  },
  {
    id: '2026-09-30-batch-delivery',
    date: '2026-09-30',
    title: 'Deliver a whole batch from its page',
    summary: 'Approved scripts now have a “Mark delivered” button on the batch page, and a manager’s delivery covers the whole batch.',
    changes: [
      { tag: 'new', text: 'The batch page shows approved scripts waiting for Timeliner at the top, with a button to confirm delivery. Writers see their own scripts there.' },
      { tag: 'improved', text: 'When an admin or manager marks delivery, every approved script in the batch is delivered for everyone working on it, not just their own share. Scripts that aren’t approved yet stay as they are.' },
      { tag: 'improved', text: 'The other writers get a notification, and the batch history says it was done on their behalf.' },
    ],
  },
  {
    id: '2026-09-29-past-scripts',
    date: '2026-09-29',
    title: 'Past scripts in the Script bank, and the counter on batch pages',
    summary: 'Add old scripts from before the platform, and tap + or − on a batch page too.',
    changes: [
      { tag: 'new', text: 'Script bank → Add past scripts: upload one or many PDFs (or paste a link), pick the client, and optionally who wrote them, when, and how many scripts are in each. They’re searchable with everything else and marked “Past script”.' },
      { tag: 'new', text: 'The “Written so far” + / − counter is now on the batch page as well as My work. Admins and managers get a small + / − on each writer’s row.' },
    ],
  },
  {
    id: '2026-09-29-memory',
    date: '2026-09-29',
    title: 'Recording mode fixed, and a much lighter server',
    summary: 'Recording mode works on the live site again, and the whole platform uses far less memory.',
    changes: [
      { tag: 'fixed', text: 'Turning on Recording mode no longer fails with “Request failed (502)”. The practice copy now lives inside the database instead of in the server’s memory, so it costs almost nothing.' },
      { tag: 'improved', text: 'Big files are streamed in small pieces when you upload or open them, instead of being loaded whole, so large PDFs can’t overload the server.' },
      { tag: 'improved', text: 'The server starts leaner and stays lean: roughly a quarter of the memory it could reach before under heavy use.' },
      { tag: 'improved', text: 'If the server is ever restarting, you now see “The server is restarting or busy. Wait a moment and try again.” instead of an error code.' },
    ],
  },
  {
    id: '2026-09-29-today-pill',
    date: '2026-09-29',
    title: 'The Today pill, and green waves when you’re done',
    summary: 'See how much of today’s work is done at a glance, and get rolling green waves once it all is.',
    changes: [
      { tag: 'new', text: 'A Today pill at the top of My work and the Overview. It counts the scripts due today, plus anything overdue that’s still open, and fills as drafts are sent for review and deliveries are confirmed.' },
      { tag: 'new', text: 'Finish everything due today and it turns into rolling green waves with rising sparkles for the rest of the day, with a burst of confetti the moment you finish.' },
      { tag: 'new', text: 'Writers see their own day. Admins and managers see the whole team on the Overview, or one writer’s day on their My work page.' },
      { tag: 'fixed', text: 'The Today pill is slim, and no longer grows huge when nothing is due.' },
    ],
  },
  {
    id: '2026-09-29-bank-deliverables',
    date: '2026-09-29',
    title: 'Script bank lists documents, not script numbers',
    summary: 'One entry per PDF or link a writer sent, however many scripts are in it.',
    changes: [
      { tag: 'improved', text: 'Each entry in the Script bank is one deliverable, like “Acme · scripts 1–45 · Sarah”, instead of one row per script. Only the newest version is listed.' },
      { tag: 'improved', text: 'Open goes to the document; Approved edit opens the version approved with a manager’s edits. You can still search a script title or type #12 to find the document script 12 is in.' },
    ],
  },
  {
    id: '2026-09-29-overview-per-person',
    date: '2026-09-29',
    title: 'An Overview of your own work',
    summary: 'Writers now see an Overview of just their scripts. Admins and managers still see the whole team.',
    changes: [
      { tag: 'improved', text: 'For writers, every number on the Overview counts only the scripts assigned to them: overdue, due today, in review, delivered this week, work due by day, needs attention, active batches, shoots and recent deliveries.' },
      { tag: 'fixed', text: 'The avatar in the View as bar is a neat circle again.' },
    ],
  },
  {
    id: '2026-09-29-potential-label',
    date: '2026-09-29',
    title: 'Potential client is just a label now',
    summary: 'Move any client to Potential clients and back without changing their work.',
    changes: [
      { tag: 'improved', text: 'Drag any client into Potential clients, even one with shoots and scripts. Nothing else changes: their shoots stay on the calendar, and their batches, deadlines and reminders carry on as before.' },
      { tag: 'improved', text: 'Potential clients can have shoots and batches too, and show up in every client picker and filter.' },
    ],
  },
  {
    id: '2026-09-29-script-bank',
    date: '2026-09-29',
    title: 'Script bank',
    summary: 'Every script for every client in one place, so you can pull any of them up at once.',
    changes: [
      { tag: 'new', text: 'A Script bank tab in the sidebar lists every script across all clients and batches, including archived ones.' },
      { tag: 'new', text: 'Search by title, number (like #12), client, batch or writer, and filter by client, writer and status (Finished pulls up everything approved or delivered).' },
      { tag: 'new', text: 'Open script opens the newest document the script is in: the writer’s latest version, or the one approved with a manager’s edits. Timeliner links are there too.' },
    ],
  },
  {
    id: '2026-09-29-view-as-recording',
    date: '2026-09-29',
    title: 'View as anyone, and Recording mode for tutorials',
    summary: 'Admins can see the site through anyone’s eyes, and practise on a throwaway copy where nothing is saved.',
    changes: [
      { tag: 'new', text: 'View as (account menu, Admins only): pick anyone on the team and the whole site shows exactly what they see. On the real workspace it’s view only, so nothing happens under their name.' },
      { tag: 'new', text: 'Recording mode (account menu): a private practice copy of the whole workspace. Send scripts, approve, drag shoots, add clients, and view as anyone to click through what they’d do. Turn it off and everything you did is thrown away.' },
      { tag: 'new', text: 'A small bar shows what’s on, with Switch person, Back to me and Turn off. Shrink it to a dot so it stays out of your recordings.' },
      { tag: 'new', text: 'The Master log notes when View as and Recording mode start and stop.' },
    ],
  },
  {
    id: '2026-09-29-soft-layers',
    date: '2026-09-29',
    title: 'Softer colours in the water',
    summary: 'Colour layers in the chart bars and progress bars now blend into each other.',
    changes: [
      { tag: 'improved', text: 'No more hard lines between colours: each layer in the “Work due by day” bars and the progress bars fades smoothly into the next, like liquid.' },
    ],
  },
  {
    id: '2026-09-28-paste-notes',
    date: '2026-09-28',
    title: 'Paste notes: type it how you’d text it',
    summary: 'Paste or upload rough notes about clients and they’re turned into clients, briefs, shoots and batches for you to check.',
    changes: [
      { tag: 'new', text: 'New work → Paste notes (also on the Clients page). Paste notes or attach a PDF or text file, and Claude reads them into clients, guidance, briefs, shoots and script batches.' },
      { tag: 'new', text: 'You see an editable preview first: fix dates or counts, add writers, untick anything, and answer any questions it had (like which Wednesday you meant) to have it read again.' },
      { tag: 'new', text: 'Existing clients get the new notes added underneath what they already have, and saving the same notes twice doesn’t create duplicates.' },
    ],
  },
  {
    id: '2026-09-28-potential-clients',
    date: '2026-09-28',
    title: 'Potential clients',
    summary: 'Keep track of people you’re talking to, and drag them into Clients when they sign.',
    changes: [
      { tag: 'new', text: 'A Potential clients section on the Clients page. Add one with “Potential client”, or choose Potential client in New work.' },
      { tag: 'new', text: 'When they sign, drag their card into Clients (or press Mark as client). Confetti included.' },
      { tag: 'new', text: 'Potential clients can hold notes, calls and files. Shoots and batches unlock once they’re a client. A client with no work yet can be dragged back.' },
    ],
  },
  {
    id: '2026-09-28-plan-later',
    date: '2026-09-28',
    title: 'Book shoots now, plan scripts later',
    summary: 'Schedule a shoot as soon as it’s booked, even before you know the script count or writers.',
    changes: [
      { tag: 'new', text: 'New shoot → “Plan scripts later” books just the shoot. Writers are optional too when you do add scripts.' },
      { tag: 'new', text: '“Add scripts” on the shoot (calendar, client page and Overview) when you’re ready. Unplanned shoots have a dashed outline on the calendar.' },
      { tag: 'new', text: 'Managers get a reminder 14 days before the shoot if its scripts aren’t planned or some are unassigned, then again at 7, 3 and 1 days. Change the 14 in Settings.' },
    ],
  },
  {
    id: '2026-09-28-admin-name',
    date: '2026-09-28',
    title: '“Owner” is now called “Admin”',
    summary: 'Just a new name — nothing else changes.',
    changes: [
      { tag: 'improved', text: 'The Owner role is now shown as Admin everywhere. Permissions are exactly the same, and Admins are still the only ones who can see the Master log.' },
    ],
  },
  {
    id: '2026-09-28-calendar-days',
    date: '2026-09-28',
    title: 'A free-scrolling Days view on the calendar',
    summary: 'Scroll left and right through time, and choose how many days fit on screen.',
    changes: [
      { tag: 'new', text: 'Calendar → Days: a timeline you scroll sideways as far as you like. Use a trackpad, swipe, or grab the background and fling it. More days load as you go.' },
      { tag: 'new', text: 'Choose 1 day, 3 days, 5 days, a week or 2 weeks on screen. Wider days show each shoot’s and deadline’s details.' },
      { tag: 'improved', text: 'Months slide in from the side you’re heading to, views fade in, and you can drag shoots between days in the Days view too.' },
    ],
  },
  {
    id: '2026-09-28-chart-water',
    date: '2026-09-28',
    title: 'Water in the “Work due by day” chart',
    summary: 'The chart’s bars now fill with the same liquid effect as the progress bars.',
    changes: [
      { tag: 'improved', text: 'Each bar in “Work due by day” pours in and holds water: a rolling surface, a glint and rising bubbles, which speed up when you hover a day.' },
    ],
  },
  {
    id: '2026-09-28-calendar-drag',
    date: '2026-09-28',
    title: 'Drag shoots on the calendar',
    summary: 'Move a shoot by dragging it to another day, and everything that depends on it follows.',
    changes: [
      { tag: 'new', text: 'Drag a shoot to a new day on the calendar. You see exactly what moves before anything changes, then confirm.' },
      { tag: 'new', text: 'Click a shoot on the calendar (or use Change dates on the batch or client page) to type new dates instead.' },
      { tag: 'improved', text: 'Moving a shoot now also moves the planned writing start, renames batches named after the shoot’s dates, and can move manually set deadlines by the same number of days.' },
    ],
  },
  {
    id: '2026-09-28-written-counter',
    date: '2026-09-28',
    title: '“Written so far” counter',
    summary: 'Writers can tap a counter to keep their manager posted while they work in their one master document.',
    changes: [
      { tag: 'new', text: 'A +/− “Written so far” counter on My work. It’s only an update: it never sends or changes any script.' },
      { tag: 'new', text: 'Managers see it as a lighter “written” layer in the progress bars and next to each writer on the batch page (“12 / 25 written · 8 sent”).' },
    ],
  },
  {
    id: '2026-09-28-motion',
    date: '2026-09-28',
    title: 'Celebrations, liquid progress and smoother everything',
    summary: 'Progress now fills like water, milestones get a proper celebration, and the whole app moves more smoothly.',
    changes: [
      { tag: 'new', text: 'Progress pills fill like liquid: a sloshing edge, rising bubbles, and sparks when a batch moves forward. The big progress ring on a batch fills with water too.' },
      { tag: 'new', text: 'Celebrations: confetti when you finish your drafts or deliver your whole batch, and a paper plane when you send scripts for review.' },
      { tag: 'new', text: '“Congrats, your scripts for … just got approved” — writers see it the next time they open the app. Send-backs show a calm heads-up with the note instead.' },
      { tag: 'new', text: 'Managers see when a writer finishes their drafts and when a whole batch is delivered.' },
      { tag: 'improved', text: 'Approved and sent-back cards glide out of the Review queue; pages, lists, dialogs, toasts, tabs, the sidebar highlight and numbers all animate smoothly.' },
      { tag: 'new', text: 'Animations can be switched off from your account menu, and they follow your device’s “reduce motion” setting.' },
      { tag: 'new', text: 'This What’s new page, listing every change since day one.' },
    ],
  },
  {
    id: '2026-09-28-documents',
    date: '2026-09-28',
    title: 'Send scripts as one document, titles and the master log',
    summary: 'Writers send one PDF or Google Doc for all their scripts, and reviews happen on that one document.',
    changes: [
      { tag: 'new', text: 'Send for review: upload one PDF or paste one Google Doc / Drive link covering all (or some) of your scripts, with a note.' },
      { tag: 'new', text: 'The Review queue shows one card per document: approve all, send back with your notes and a marked-up file, or approve with your own edits.' },
      { tag: 'new', text: 'Sending back is one request with one note; the writer sends a revised version, which becomes version 2. Every version is kept on the batch page.' },
      { tag: 'new', text: 'Titles: paste a list of titles for all your scripts at once.' },
      { tag: 'new', text: 'Master log (owners only): every change, page view, sign-in and blocked attempt.' },
      { tag: 'improved', text: 'My work shows exactly where each script is — not sent (not started or writing), in review, sent back, approved, delivered — instead of the +/− counter.' },
      { tag: 'improved', text: 'The “Work due by day” tooltip says which deadline it counts, and long script checklists start folded.' },
    ],
  },
  {
    id: '2026-09-28-attachments',
    date: '2026-09-28',
    title: 'Attach recordings and files when creating work',
    summary: 'New shoot and New batch take the recording link, a document link and PDFs up front.',
    changes: [
      { tag: 'new', text: 'Add a call recording link, a document link and files (PDFs and more) while creating a shoot or batch.' },
    ],
  },
  {
    id: '2026-09-28-team',
    date: '2026-09-28',
    title: 'Owner role, readable temporary passwords, removing people',
    summary: 'Clearer roles and simpler team management.',
    changes: [
      { tag: 'new', text: 'Roles are now Owner, Manager and Writer. Owners and managers have exactly the same permissions.' },
      { tag: 'new', text: 'A new person’s temporary password stays readable in Team until they choose their own.' },
      { tag: 'new', text: 'Remove someone from the team, handing their unfinished scripts to someone else. Their name stays in the history.' },
    ],
  },
  {
    id: '2026-09-28-signin-details',
    date: '2026-09-28',
    title: 'Copy sign-in details',
    summary: 'One block with everything a new team member needs.',
    changes: [
      { tag: 'new', text: '“Copy sign-in details” gives you the link, email and temporary password in one message you can paste to them.' },
    ],
  },
  {
    id: '2026-09-28-setup-fixes',
    date: '2026-09-28',
    title: 'Safer first sign-in setup',
    summary: 'Fixes for setting up the first account on the server.',
    changes: [
      { tag: 'fixed', text: 'A too-short first password no longer stops the server from starting; it explains what to change instead.' },
      { tag: 'fixed', text: 'Stray spaces around the first email and password are ignored.' },
      { tag: 'new', text: 'A reset switch to set the first account’s password again from the server settings.' },
    ],
  },
  {
    id: '2026-09-28-render',
    date: '2026-09-28',
    title: 'Hosting on Render',
    summary: 'Deploy the whole platform, with its database, in one step.',
    changes: [
      { tag: 'new', text: 'A Render blueprint that sets up the web service and a PostgreSQL database together.' },
    ],
  },
  {
    id: '2026-09-28-launch',
    date: '2026-09-28',
    title: 'Scale Media scripts launches',
    summary: 'The first version: one place to run script production from shoot to Timeliner.',
    changes: [
      { tag: 'new', text: 'Clients with briefing calls, recordings, documents, brand voice and resources.' },
      { tag: 'new', text: 'Shoots and script batches split between writers, with each script tracked from not started to delivered.' },
      { tag: 'new', text: 'Deadlines worked out from the first shoot day: drafts 5 days before, final delivery 3 days before, with overrides.' },
      { tag: 'new', text: 'Exact progress everywhere, like “20 / 45 drafts ready · 44%”.' },
      { tag: 'new', text: 'Review and revisions, and writer-confirmed delivery to Timeliner.' },
      { tag: 'new', text: 'Overview dashboard, Production board, Calendar, Review queue, Resources and Settings.' },
      { tag: 'new', text: 'Notifications and reminders for deadlines, reviews and deliveries, plus a full activity history.' },
      { tag: 'new', text: 'Quick entry: type “Acme has a shoot October 12–13 and needs 45 scripts” and confirm the preview.' },
    ],
  },
];

export const LATEST_CHANGE = CHANGELOG[0].id;
