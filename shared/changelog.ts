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
