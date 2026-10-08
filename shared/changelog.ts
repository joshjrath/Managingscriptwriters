// What's new: every change to the platform, newest first, since the first
// version. Add an entry here with every change you ship (see CLAUDE.md).
// `id` must be unique and never change; it's how the "new" dot knows what
// someone has already seen.

import type { ISODate } from './dates';

export type ChangeTag = 'new' | 'improved' | 'fixed';

/** Who an update matters to. Entries not listed in ONLY_FOR are for everyone. */
export type Audience = 'managers' | 'writers' | 'editors';

/** Updates that only matter to some people (Admins count as managers). */
export const ONLY_FOR: Record<string, Audience[]> = {
  '2026-10-07-calendar-shoots-match': ['managers'], '2026-10-07-editors': ['managers', 'editors'], '2026-10-07-calendar-shoots': ['managers'],
  '2026-10-07-calendar-embed': ['managers'], '2026-10-02-fill-missing-deadlines': ['managers'], '2026-10-02-drafts-from-final': ['managers'],
  '2026-10-01-palettes': ['managers'], '2026-09-30-control-center-people': ['managers'], '2026-09-30-control-center-admin-editors': ['managers'],
  '2026-09-30-control-center': ['managers'], '2026-10-08-control-center-removed': ['managers'], '2026-09-30-batch-delivery-catch-up': ['managers'], '2026-09-30-batch-delivery': ['managers'],
  '2026-09-29-potential-label': ['managers'], '2026-09-29-view-as-recording': ['managers'], '2026-09-28-paste-notes': ['managers'],
  '2026-09-28-potential-clients': ['managers'], '2026-09-28-plan-later': ['managers'], '2026-09-28-admin-name': ['managers'],
  '2026-09-28-calendar-drag': ['managers'], '2026-09-28-team': ['managers'], '2026-09-28-signin-details': ['managers'],
  '2026-10-07-my-work-redesign': ['writers', 'managers'], '2026-09-28-written-counter': ['writers', 'managers'], '2026-10-08-writers-never-miss': ['writers', 'managers'],
  '2026-10-08-manager-editor-screens': ['managers', 'editors'], '2026-10-08-overview-cards': ['managers', 'writers'], '2026-10-08-writers-overview-back': ['writers', 'managers'], '2026-10-08-feedback-match-fix': ['managers'], '2026-10-08-editors-never-get-scripts': ['managers'], '2026-10-08-due-tiles': ['managers', 'writers'], '2026-10-08-master-log-everything': ['managers'], '2026-10-08-no-script-titles': ['managers', 'writers'], '2026-10-08-timeliner-auto-delivery': ['managers', 'writers'], '2026-10-08-timeliner-key-permissions': ['managers'],
  '2026-10-08-editors-tab-timeliner': ['managers', 'editors'],
};
/** Behind-the-scenes updates (hosting, setup, speed): folded away by default. */
export const TECHNICAL = new Set(['2026-09-29-memory', '2026-09-28-setup-fixes', '2026-09-28-render']);

export interface ChangelogEntry {
  id: string;
  date: ISODate;
  title: string;
  summary: string;
  changes: { tag: ChangeTag; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: '2026-10-08-editors-tab-timeliner',
    date: '2026-10-08',
    title: 'The Editors tab: who’s cutting what, read from Timeliner',
    summary: 'Each editor’s videos now come straight from Timeliner with the script to cut from, and editors can say which one they’re on.',
    changes: [
      { tag: 'new', text: 'Managers have a new Editors tab, after Team. Each editor has a card: what they’re on right now (Editing now, Paused, Next up by deadline, or Off hours), how many videos they have to edit and in revisions, what’s due today, the last video they finished, and the script documents they’re cutting from. Four cards along the top show who’s editing now (and who’s paused), what’s due today and how much of it is sent to review, the videos in revisions, and what’s waiting on you to review. Below the editors are the videos nobody has been given in Timeliner yet, with the script documents they’re cut from.' },
      { tag: 'new', text: 'If an editor taps I’m on this and forgets to pause, their card says Still marked as editing after 10 hours, or once they’re outside their working hours, and they aren’t counted as editing now.' },
      { tag: 'new', text: 'Videos come from Timeliner automatically. Keep giving videos to editors in Timeliner as you do now: nobody picks or claims them here. Each editor is matched by their email, and each video to its client, batch and script number, so it links to the script to cut from (the edited version a manager approved, when there is one).' },
      { tag: 'new', text: 'Editors see their own videos on their Home: what to do next, then Revisions, To edit and Waiting on review, each with a link to its script. Tap I’m on this when you start a video, Pause and Resume when you step away, and Done when it’s finished.' },
      { tag: 'new', text: 'Done tells the managers straight away. It doesn’t change anything in Timeliner: move the video to Needs review there as usual, and it moves on here once Timeliner has it.' },
      { tag: 'new', text: 'The site reads Timeliner by itself every few minutes, and Settings → Timeliner has a Read Timeliner now button. When Timeliner’s webhook is connected, changes show up straight away.' },
    ],
  },
  {
    id: '2026-10-08-timeliner-key-permissions',
    date: '2026-10-08',
    title: 'Settings → Timeliner says which key permissions it needs',
    summary: 'The Timeliner section lists the three permissions the API key needs, so a read-only key is easy to spot.',
    changes: [
      { tag: 'improved', text: 'Settings → Timeliner says the key needs Webhooks (read & write), Projects (read) and Workspace (read), and when Timeliner refuses a key it names all three, not just the first one missing.' },
    ],
  },
  {
    id: '2026-10-08-timeliner-auto-delivery',
    date: '2026-10-08',
    title: 'Timeliner marks batches delivered by itself',
    summary: 'Upload the batch’s script PDF or Doc to Timeliner and the batch is marked delivered here, with no link to paste or button to press.',
    changes: [
      { tag: 'new', text: 'When a batch’s script document (PDF or Word) is uploaded to the client’s project in Timeliner, every approved script in that batch is marked delivered here straight away, labelled “Confirmed by Timeliner”. Videos and images editors upload don’t count.' },
      { tag: 'new', text: 'The app works out the batch from the Timeliner brand or project name (the client), and remembers the project after the first match. If it can’t tell, the upload waits in Settings → Timeliner and managers are told: pick the batch once and it’s delivered.' },
      { tag: 'new', text: 'Settings → Timeliner shows whether it’s connected, lets you send a test from Timeliner, and lists recent uploads and what happened to each.' },
      { tag: 'improved', text: 'You can still mark scripts delivered by hand, the same as before.' },
    ],
  },
  {
    id: '2026-10-08-no-script-titles',
    date: '2026-10-08',
    title: 'Scripts no longer have titles',
    summary: 'Scripts go out as one PDF or Doc link per batch, so the per-script titles are gone.',
    changes: [
      { tag: 'improved', text: 'The Titles buttons on the batch page and My work, “Add titles” when sending scripts, the titles under review cards and the Title box on each script are gone. Scripts are just numbered (Script 12), and the PDF or Doc link you send is the deliverable. Search and the Script bank find scripts by number (#12), client, batch, writer or document name.' },
    ],
  },
  {
    id: '2026-10-08-master-log-everything',
    date: '2026-10-08',
    title: 'The Master log opens on Everything',
    summary: 'The Master log shows every kind of entry when you open it.',
    changes: [
      { tag: 'improved', text: 'The Master log now opens on Everything (changes, views, sign-ins and blocked attempts together) instead of just Changes. The filters above it still narrow it down.' },
    ],
  },
  {
    id: '2026-10-08-scale-caps',
    date: '2026-10-08',
    title: 'It’s SCALE Media',
    summary: 'The name is now written SCALE Media everywhere on the site.',
    changes: [
      { tag: 'fixed', text: 'The wordmark, the sign-in page, browser tab titles and the original colour palette now read SCALE Media. A workspace still using the original name is renamed to match; one you renamed yourself keeps its name.' },
    ],
  },
  {
    id: '2026-10-08-editors-never-get-scripts',
    date: '2026-10-08',
    title: 'Editors never get scripts by accident',
    summary: 'Two ways scripts could end up with an editor are closed, and a few smaller fixes.',
    changes: [
      { tag: 'fixed', text: 'Raising a batch’s script count gives brought-back scripts to their old writer only if they still write: someone who has since become an editor no longer gets them. Scripts brought back to a writer now show as newly added on their My work.' },
      { tag: 'fixed', text: 'Paste notes never gives scripts to an editor named in the notes. Those scripts stay unassigned, with a warning, like any name it can’t match.' },
      { tag: 'fixed', text: 'Settings says reminders are off whenever the server has them switched off, however that setting was written.' },
      { tag: 'improved', text: 'Behind the scenes: moving scripts to another writer and undoing a review now wait their turn like every other change to a batch, so two people working on the same batch at once can’t hold each other up.' },
    ],
  },
  {
    id: '2026-10-08-faster-large-uploads',
    date: '2026-10-08',
    title: 'Large uploads save faster',
    summary: 'Big files are saved in one go instead of piece by piece.',
    changes: [
      { tag: 'improved', text: 'Uploading a large file (a PDF, a recording, a document) now saves several times faster: a 50 MB file takes about a second instead of about six, and the server does far less work while it saves. Small files feel the same. Nothing about your existing files changes.' },
    ],
  },
  {
    id: '2026-10-08-safer-accounts-recording-uploads',
    date: '2026-10-08',
    title: 'Safer admin accounts, Recording mode and uploads',
    summary: 'Admin powers stay with admins, Recording mode can never touch real work, and uploads and Paste notes have firmer limits.',
    changes: [
      { tag: 'improved', text: 'There’s always at least one active admin, and an admin’s temporary password is shown only to admins.' },
      { tag: 'fixed', text: 'If the server restarts, or a practice copy is closed, while a page is still in Recording mode, changes from that page are refused with “Recording mode has ended… nothing was saved” instead of going to the real workspace. Reload to carry on.' },
      { tag: 'improved', text: 'Wrong passwords are now limited per account as well (30 in 15 minutes), not only per connection.' },
      { tag: 'fixed', text: 'A very long file name ending in something like “.exe.pdf” could be shortened into a blocked program type. Names are now shortened without losing their type, and a few more program types are refused.' },
      { tag: 'improved', text: 'Paste notes: text files count toward the same 60,000-character limit as pasted text, each person runs one read at a time (up to 30 an hour), and when two teammates share the first name in the notes, those scripts are left unassigned with a warning naming both instead of guessing.' },
      { tag: 'fixed', text: 'Past-document links must be web links (https://), like every other link.' },
      { tag: 'fixed', text: 'Editors’ read-only access can’t be got round by writing a page’s web address in a different form: they still only see finished scripts.' },
      { tag: 'improved', text: 'Behind the scenes: the server keeps running if its database connection drops for a moment, two copies starting at once no longer clash, and expired sign-ins are cleared out.' },
    ],
  },
  {
    id: '2026-10-08-batches-reviews-forms',
    date: '2026-10-08',
    title: 'Fixes for batches, reviews and forms',
    summary: 'Review notes stay on their own batch, script counts change safely, and Edit batch and Edit client keep what you type.',
    changes: [
      { tag: 'fixed', text: 'A batch page could list revision notes from a different batch. It now shows only its own.' },
      { tag: 'fixed', text: 'Raising a batch’s script count brings back removed scripts to the writer you pick in “Assign the new scripts to” (or to their old writer if still on the team), never to someone who has left.' },
      { tag: 'improved', text: 'Lowering a batch’s script count tells the writers whose scripts were taken off.' },
      { tag: 'fixed', text: 'Edit batch and Edit client keep what you’re typing when the page refreshes in the background, and save only the fields you changed, so they can’t undo a date someone else just moved. Settings no longer resets a form you’re editing.' },
      { tag: 'fixed', text: 'Saving a script checks it against the version you opened, so it can’t overwrite a change someone else made in the meantime. If that happens, the script shows as it is now (replacing what you typed) so you can check it and make your edit again.' },
      { tag: 'fixed', text: 'A year typed as “26” is no longer read as 1926, which made a batch look decades overdue.' },
      { tag: 'improved', text: 'Quick entry reads dates like 25/12/2026 correctly, refuses impossible ones, and matches names with accents or hyphens (José, Anne-Marie). Script ranges accept “1 - 20” as well as “1-20”. If saving the shoot fails, trying again reuses the client it just made instead of creating a second one.' },
      { tag: 'fixed', text: 'The Today pill counts a script as overdue once the daily cutoff passes, like everywhere else, and keeps an archived client’s unfinished batches.' },
      { tag: 'fixed', text: 'A double click can’t send “Approve selected” or “Mark as client” twice, and a “written so far” tap isn’t lost when you change page.' },
      { tag: 'fixed', text: 'Review notes, sending scripts back, blockers and to-dos now really start with the cursor in their text box, and script titles in a batch’s checklist open from the keyboard.' },
      { tag: 'fixed', text: 'What’s new keeps its “New for you” highlight while you’re on the page, and the search boxes on Resources and Script bank keep a filter picked while typing.' },
      { tag: 'fixed', text: 'The Master log no longer skips entries saved at the same moment, and its “Today” uses your time zone.' },
      { tag: 'improved', text: 'Upload help shows the server’s real file size limit, and something too big to send now says what was too big.' },
    ],
  },
  {
    id: '2026-10-08-due-tiles',
    date: '2026-10-08',
    title: 'Work due by day, redrawn as glowing day tiles',
    summary: 'The Overview chart is now a row of day tiles that fill up against a full day’s work, in the same gradient style as the cards above it.',
    changes: [
      { tag: 'improved', text: 'Each of the next 14 days is a tile, with overdue work in its own salmon tile and today always in yellow. A tile fills against a full day’s work: everyone’s scripts per day added up (yours, on your own Overview). So a quiet day still shows how full it is, instead of a sliver next to the busiest day.' },
      { tag: 'new', text: 'A day with more work than a full day glows pink and says how far over it is, like “+33 over”. The busiest of those gets a spinning border. With no daily capacity set, tiles fill against the busiest day instead.' },
      { tag: 'improved', text: 'The batches behind a day sit under the tiles as cards, with their writers and a stage strip; overdue ones say how many days late they are. Today’s are shown until you pick another day.' },
      { tag: 'improved', text: 'The Final delivery / Drafts switch slides between the two and shows each count. The chart now runs the full width of the Overview, with Upcoming shoots in columns right below it.' },
      { tag: 'improved', text: 'Set each writer’s scripts per day in Settings → Team; the chart’s “Full tile =” chip links there and says if anyone isn’t counted yet.' },
    ],
  },
  {
    id: '2026-10-08-feedback-match-fix',
    date: '2026-10-08',
    title: 'Review cards quote the right feedback',
    summary: 'A fix to “Revised after this feedback” on review cards.',
    changes: [
      { tag: 'fixed', text: 'A review card only shows “Revised after this feedback” when that document really answers a send-back on the same scripts in the same batch. Before, a batch could show another batch’s feedback when their script numbers matched, and a later version kept repeating feedback an earlier one had already answered.' },
    ],
  },
  {
    id: '2026-10-08-control-center-removed',
    date: '2026-10-08',
    title: 'The Control Center has been retired',
    summary: 'The admin-only Control Center (the globe view of the team) is gone. Everything else works as before.',
    changes: [
      { tag: 'improved', text: 'The Control Center link and page are gone. The rest of the site has less code to keep up to date.' },
      { tag: 'improved', text: 'Nothing else changes: each person’s city, time zone and working hours stay, and Settings → Editors (now just called Editors, since there’s no map) and Give site access work as before.' },
    ],
  },
  {
    id: '2026-10-08-writers-overview-back',
    date: '2026-10-08',
    title: 'Writers have Overview and Production back',
    summary: 'Writers’ menu has their Overview and the Production board again, next to My work.',
    changes: [
      { tag: 'fixed', text: 'Writers see Overview (counting only their own scripts) and the Production board again. Their menu is My work, Overview, Production, Calendar, Script bank, Resources and Clients. The Review queue stays with managers.' },
      { tag: 'improved', text: 'A writer’s Needs attention leaves out deadline checks only a manager can confirm.' },
    ],
  },
  {
    id: '2026-10-08-overview-cards',
    date: '2026-10-08',
    title: 'New summary cards on the Overview',
    summary: 'The four cards at the top of the Overview are now gradient cards in their own colours, a little shorter, and each one says what’s behind its number.',
    changes: [
      { tag: 'improved', text: 'Every card keeps its gradient, busy day or quiet: warm for Overdue, yellow for Due today, violet for In review and mint for Delivered this week.' },
      { tag: 'improved', text: 'Overdue says “Needs you” and names the late batches and how many days late, or “All clear” and the next deadline.' },
      { tag: 'improved', text: 'Due today shows the cutoff time and a bar for how much of today’s work is done, or “Nothing due” and what’s next.' },
      { tag: 'improved', text: 'In review shows how long the oldest script has waited and which batches they’re in (“Queue clear” when empty). Delivered this week has a small bar for each day, Monday to Sunday.' },
      { tag: 'fixed', text: 'Under More on the Overview, Active batches and Writing progress sit side by side again instead of being pushed apart.' },
    ],
  },
  {
    id: '2026-10-08-phones-admin-polish',
    date: '2026-10-08',
    title: 'Chat removed, Overview numbers back on top, and phones, keyboard and setup polish',
    summary: 'The last round of fixes from the site review, plus the chat bubble taken out.',
    changes: [
      { tag: 'improved', text: 'Messages and the chat bubble are gone from the site. Writers’ menu is My work, Calendar, Script bank, Resources and Clients; managers keep the Team page.' },
      { tag: 'improved', text: 'Overview starts with the four summary cards, Work due by day and Upcoming shoots again, with Needs attention right below.' },
      { tag: 'new', text: 'A new workspace asks for the organisation name, head office time zone and when deadlines end, and shows a three-step Get started card until the team, a client and a shoot are added.' },
      { tag: 'improved', text: 'Signing in with a temporary password asks you to choose your own, and the temporary one can’t be kept. If you’re signed out because of a reset, the sign-in page says so.' },
      { tag: 'improved', text: 'Settings: every time zone is in the list, unsaved changes show a bar with Save and Discard, and the browser asks before you leave. “Editors on the map” is clearly separate from editors who can sign in, and asks before removing anyone.' },
      { tag: 'improved', text: 'View as says up front that it’s look-only. The Control Center explains its numbers in plain words. A calendar link that can’t be reached says how to fix it. What’s new shows the updates for your role first.' },
      { tag: 'improved', text: 'Phones: the menu button shows when something inside needs you, Production filters fold behind one button and its table becomes cards, inputs no longer zoom on iPhone, dialogs keep their main button in reach, and long names wrap instead of pushing the page sideways.' },
      { tag: 'improved', text: 'Tablets show a small label under each sidebar icon and real numbers. Buttons are easier to tap on touch screens, and the sidebar footer stays in view on short screens.' },
      { tag: 'improved', text: 'Keyboard: a Skip to content link, dialogs start on their first field and return you to the button that opened them.' },
      { tag: 'improved', text: 'Approve with a note, with or without your own version attached. A batch’s document history is grouped by document, each version with its decisions. “Their changes” now says whose. Singular and plural words are right on the cards and labels, and missing pages offer a way home.' },
    ],
  },
  {
    id: '2026-10-08-manager-editor-screens',
    date: '2026-10-08',
    title: 'Clearer Overview, Production, Calendar and search, and a better editor home',
    summary: 'The third round of fixes: manager and editor screens show what needs you first and say the same thing everywhere.',
    changes: [
      { tag: 'improved', text: 'Overview starts with Needs attention, at full height, with Today and the team’s to-dos beside it. Shoots to plan is one list for calendar events and site shoots with no scripts, and offers to link a batch that has no shoot. Active batches and writing progress fold away under More.' },
      { tag: 'improved', text: 'When drafts and final delivery are both missed, every page says both: “Drafts 4 days overdue · Final delivery 2 days overdue”. The chart says it counts scripts.' },
      { tag: 'improved', text: 'Production board: columns show how many scripts are at each stage, and batches that have scripts further along are listed there too, so In review is never empty while scripts wait. The table shows flags under each batch name and fits on smaller screens.' },
      { tag: 'improved', text: 'On a batch page, “Change dates” for the shoot is now “Move shoot…”, and each writer row has “Move scripts…”, which says what you’re handing over and can mark half-written scripts as not started.' },
      { tag: 'improved', text: 'Deadline fields point out weekends and say when drafts come from the final delivery date. The shoot and batch names are on the main form, defaulting to the client and date or the calendar event’s title.' },
      { tag: 'improved', text: 'Calendar: writing periods start hidden in Month view, names wrap instead of being cut off, “+N more” opens that day, List starts at today, writers start on their own work, and a Google event can be planned from the calendar (and shows once when it already has a shoot).' },
      { tag: 'improved', text: 'Search finds people, shoots, briefing calls, recordings and script numbers (“#12”), opens the first result on Enter, and its results are no longer cut off by the sidebar. Editors can search too.' },
      { tag: 'improved', text: 'To-dos say who they’re for and can be tied to one of the person’s batches. Writers is now Team: anyone writing scripts is listed (the Admin included), with editors in their own section.' },
      { tag: 'improved', text: 'Sidebar numbers say what they count when you hover them, and the Review queue counts scripts the same way. Celebrations about the whole team are a short notice instead of a full-screen pop-up. The Master log opens on Changes and names the document version a decision was made on. Paste notes is hidden until it’s set up.' },
      { tag: 'new', text: 'Editors: the home page lists each upcoming shoot with “6 of 10 scripts final” and Ready, On track or Late, opening just that shoot’s scripts. Editors are notified when a shoot’s scripts are all final or a shoot moves.' },
      { tag: 'improved', text: 'Client pages: briefing calls sit with the other Resources and their writing instructions move to About & guidance. Everyone gets a Scripts link, and shoot names open their scripts. Editors see next shoot and finished scripts on client cards, and no links that send them home.' },
    ],
  },
  {
    id: '2026-10-08-writers-never-miss',
    date: '2026-10-08',
    title: 'Writers never miss new work, and one set of words everywhere',
    summary: 'The second round of fixes: new work and send-backs are impossible to miss, deadlines are each writer’s own, and every page uses the same words for where a script is.',
    changes: [
      { tag: 'new', text: 'New work stays at the top of My work until you press “Got it”, open the batch or send something. Scripts added to a batch you’ve already started show as new too, with their numbers.' },
      { tag: 'new', text: 'A “Due now” strip at the top of My work lists anything due today, tomorrow or overdue. Tap a line to jump to it.' },
      { tag: 'improved', text: 'Deadlines on My work are your own: your drafts are done when your scripts are sent, whoever else is still writing. Each one says the time it’s due in your time zone.' },
      { tag: 'improved', text: 'Sent-back scripts are counted in the page header, tagged on their batch and listed first. The pop-up when you come back leads with them, and approvals that were sent back since aren’t celebrated.' },
      { tag: 'improved', text: 'Cards stay where they are while you update Written so far, instead of jumping to another section.' },
      { tag: 'improved', text: 'The Today pill says how many tasks are done and how many are overdue in plain words, counts to-dos with a date, and takes you to the work when you tap it.' },
      { tag: 'improved', text: 'One word for each step, on every page: Not started, Writing, In review, Sent back, Approved, Delivered. Progress reads “drafts sent”, and the last deadline is “Final delivery”.' },
      { tag: 'improved', text: 'Writers’ menu has just what they use: My work, Calendar, Messages, Script bank, Resources and Clients. A batch page starts with “Your scripts”.' },
      { tag: 'improved', text: 'Writers can undo their own delivery on the same day, from the confirmation or the batch page. Managers are told.' },
      { tag: 'improved', text: 'Sending a revised version shows the feedback you’re answering, and the reviewer sees it next to the new version. “Replace document” is now “Send a newer version”.' },
      { tag: 'improved', text: 'Script numbers can be typed the way people write them: “1 to 5”, “1 - 5 and 8”, “scripts 2–4”. Examples use your own numbers, and only scripts you can send are offered.' },
      { tag: 'improved', text: 'The time zone question lets you search by city, preselects a zone an Admin set for you, waits until other pop-ups are closed, and “Not now” holds for 30 days.' },
      { tag: 'improved', text: '“Owner” on clients is now “Account lead”, the first sign-up creates the “admin account”, and “New work” is “+ Create”. Hover or tap Timeliner and Phantom for a short explanation.' },
      { tag: 'fixed', text: 'Writers and editors no longer see notes about potential clients or a client’s internal history. Date checks and the next action on a batch are for managers only, and a blocker says who flagged it.' },
    ],
  },
  {
    id: '2026-10-08-safety-fixes',
    date: '2026-10-08',
    title: 'Safer approvals, a Script bank that keeps everything, and other fixes',
    summary: 'The first round of fixes from a full review of the site: the problems that could lose work, give the wrong access, or do more than a button said.',
    changes: [
      { tag: 'fixed', text: 'Only the Admin can make someone an Admin, or change the Admin’s account. Managers no longer see the Admin option.' },
      { tag: 'fixed', text: 'The Script bank keeps every finished script. When a writer resends only some scripts from a document, the others stay findable under the earlier one. Scripts finished without any document get a row of their own too.' },
      { tag: 'fixed', text: 'You can’t approve a version you haven’t seen: if a writer sends a newer version while the Review queue is open, the site asks you to open it first.' },
      { tag: 'new', text: 'Approving or sending back now has an Undo on the confirmation for a few minutes. It puts the scripts back in review and takes back the notification.' },
      { tag: 'new', text: 'When you approve with your own edits, the writer sees “Final version (your edits) · use this one” on My work and when they mark scripts delivered. In the Script bank, “Final version” is the main button.' },
      { tag: 'fixed', text: 'Adding a second writer to a new shoot or batch splits the scripts evenly, and you can’t create work with a writer who has no scripts.' },
      { tag: 'fixed', text: 'Moving a shoot warns when drafts would end up due after final delivery, and moves the manual date too unless you untick it. “Dates are fine” is off while the order is wrong.' },
      { tag: 'improved', text: 'Shoots that need writers: a shoot you plan from the list stays linked to its calendar event, so it never shows up again. You can create the client right there, hide a shoot with “Not ours” (with Undo), and bring hidden ones back.' },
      { tag: 'improved', text: 'Deactivating someone lets you hand their unfinished scripts to someone else. Scripts left with someone who can’t sign in show up in Needs attention.' },
      { tag: 'fixed', text: 'Recording mode labels every confirmation “Practice copy · not kept”, shows a badge in the sidebar, keeps its dot clear of the chat button, and always asks before turning off. Password and time zone changes are off while it’s on.' },
      { tag: 'fixed', text: 'Settings checks deadline rules as you type, says what’s wrong in plain words, and asks whether new rules should also update existing batches.' },
      { tag: 'improved', text: 'Sending scripts back from a writer’s row starts with nothing picked and warns before un-approving anything.' },
      { tag: 'improved', text: 'Delivering as a manager says exactly which scripts it marks delivered, and records it as “confirmed by Josh for Priya” rather than writer-confirmed. Writers can tick which documents they’ve added to Timeliner.' },
      { tag: 'fixed', text: 'Notifications only list each writer’s own scripts, and include the reviewer’s note.' },
      { tag: 'improved', text: 'Send for review starts with the scripts your Written so far count says are written. Batches without a shoot name are named after the client. Form errors disappear as soon as you fix the field.' },
    ],
  },
  {
    id: '2026-10-07-my-work-redesign',
    date: '2026-10-07',
    title: 'My work, rebuilt: new work first',
    summary: 'New assignments are at the very top of My work, and every batch is easier to read on a phone, tablet or computer.',
    changes: [
      { tag: 'new', text: 'Work given to you in the last week sits at the top of My work under “New work”, marked New, until you start it. The My work link in the menu says New, and your Overview shows a banner, so you can’t miss it.' },
      { tag: 'improved', text: 'The rest is grouped by what you need to do: To do (sent back, to write, to deliver), soonest deadline first, then Waiting on review, folded away. Finished work is at the bottom.' },
      { tag: 'improved', text: 'Each batch leads with the client’s name and its next deadline in big type. Then one bar shows where your scripts are, each job has its button (write and send, revise, mark delivered), the dates are in the order they happen, and the brief, recording and files are together.' },
      { tag: 'improved', text: 'On phones the buttons are full width and easier to tap, and the page is about a third shorter.' },
      { tag: 'improved', text: 'If a batch you’re already writing gets more scripts for you, it says how many are new.' },
    ],
  },
  {
    id: '2026-10-07-calendar-shoots-match',
    date: '2026-10-07',
    title: 'Fewer false “Shoots that need writers”',
    summary: 'Shoots you’ve already planned stop showing up in the list on the Overview.',
    changes: [
      { tag: 'fixed', text: 'Google adds the calendar owner’s name to booked events (“Shimonov Law Filming Session and Joshua Shalamov”), so they were being matched to the client named after Joshua instead of the real one. The real client now comes first.' },
      { tag: 'fixed', text: 'A shoot counts as planned when that client has a batch without a booked shoot that’s due in the 3 weeks before it, with every script assigned.' },
    ],
  },
  {
    id: '2026-10-07-editors',
    date: '2026-10-07',
    title: 'Editors get their own sign-in',
    summary: 'Video editors can sign in to see the shoot calendar, the finished scripts to cut from, and each client’s resources. They can’t change anything.',
    changes: [
      { tag: 'new', text: 'There’s a new Editor role. Add an editor in Settings → Team → Add person, or use Give site access next to them in Settings → Editors. They get a sign-in message to send, the same as writers.' },
      { tag: 'new', text: 'Editors land on their own Home page: shoots and final-script dates for the next 4 weeks, the newest finished scripts, and their to-dos. Their menu has Calendar, Script bank, Clients, Resources and Messages.' },
      { tag: 'new', text: 'Editors only see scripts once they’re approved or delivered, never drafts or reviews in progress. On Clients they see the guidance, shoots and resources, but not batches or history.' },
      { tag: 'new', text: 'Synced calendars have a new “+ Editors” option, so a calendar like Joshua’s can be shown to editors without showing it to writers.' },
      { tag: 'improved', text: 'Editors are never offered as writers when you split, assign or reassign scripts.' },
    ],
  },
  {
    id: '2026-10-07-calendar-shoots',
    date: '2026-10-07',
    title: 'Shoots on Joshua’s calendar that need writers',
    summary: 'The Overview now lists shoots from your synced Google Calendar that don’t have writers yet, with one click to plan them.',
    changes: [
      { tag: 'new', text: 'Admins and managers get a “Shoots that need writers” list at the top of the Overview. It reads synced calendars for events that look like shoots (shoot, filming, content day…), works out the client from the title, and checks the site: not booked yet, booked with no scripts, or scripts without a writer.' },
      { tag: 'new', text: 'Plan scripts opens New shoot (or New batch) already filled in with the client, the shoot dates, and last time’s script count and writers for that client, so it’s usually just a check and Create. If only writers are missing, Assign writers opens the batch.' },
      { tag: 'new', text: 'A notification goes out once when new ones appear after a sync. Hide one with × if it isn’t a shoot you write for.' },
    ],
  },
  {
    id: '2026-10-07-calendar-embed',
    date: '2026-10-07',
    title: 'Add a calendar from its embed code',
    summary: 'Synced calendars also take a Google Calendar’s embed code, embed link or email address.',
    changes: [
      { tag: 'improved', text: 'In Settings → Synced calendars, you can paste a Google Calendar’s embed code (<iframe …>), its embed or share link, or just its address (name@gmail.com) instead of the secret iCal address. That works when the calendar is public in Google; if it isn’t, the site says so and asks for the secret address.' },
    ],
  },
  {
    id: '2026-10-07-google-calendar',
    date: '2026-10-07',
    title: 'Google Calendar on the Calendar',
    summary: 'Show a Google Calendar’s shoots and calls on the site’s Calendar. It stays in sync on its own.',
    changes: [
      { tag: 'new', text: 'Settings → Synced calendars → Add calendar: paste a Google Calendar’s “Secret address in iCal format” (the steps are in the dialog), pick a colour and who sees it. Its events show on the Calendar in that colour, with times in your own time zone, alongside shoots and deadlines.' },
      { tag: 'new', text: 'It re-reads the calendar every 15 minutes, or straight away with Sync now, so new, moved and cancelled events (repeating ones too) update here by themselves. Click an event to see its time, place, notes and meeting link.' },
      { tag: 'new', text: 'By default only admins and managers see a synced calendar; choose “Everyone” to show it to writers too. It’s read-only: nothing is changed in Google.' },
    ],
  },
  {
    id: '2026-10-02-fill-missing-deadlines',
    date: '2026-10-02',
    title: 'Existing batches got their missing deadline',
    summary: 'Batches that had only a final delivery date now have drafts due too, and the other way round.',
    changes: [
      { tag: 'fixed', text: 'Every batch that had only one of its two deadlines now has both. Batches on a shoot got the shoot’s date for the missing one; others got it from the date they had, by the same gap as your deadline rules (for example drafts 2 days before final delivery). Each batch’s history notes the date that was added.' },
    ],
  },
  {
    id: '2026-10-02-drafts-from-final',
    date: '2026-10-02',
    title: 'Drafts follow the final delivery date',
    summary: 'Enter a final delivery date and drafts due fills itself in, using the same gap as your shoot rules.',
    changes: [
      { tag: 'new', text: 'When you set a final delivery date (New batch, New shoot overrides, or Edit batch), drafts due is set for you by the same gap as your deadline rules in Settings. With drafts 5 days and final 3 days before a shoot, that’s 2 days before final delivery (working days if you count working days). You can still change drafts yourself; once you do, it stays put.' },
      { tag: 'improved', text: 'The client page no longer shows an empty “Briefings & ideation calls” panel. Recordings and documents go in Resources. Older briefing records still show, as “Briefing calls”, for clients that have them.' },
    ],
  },
  {
    id: '2026-10-02-hq-clock',
    date: '2026-10-02',
    title: 'HQ time at the top',
    summary: 'People outside HQ’s time zone see HQ time under their own clock.',
    changes: [
      { tag: 'new', text: 'If your time zone isn’t HQ’s (EST for SCALE Media), the clock at the top of every page shows your time with HQ time underneath, e.g. “HQ · 3:07 AM EDT”, plus the day when it’s different. Deadlines follow HQ time.' },
      { tag: 'improved', text: 'Settings calls the workspace time zone the HQ time zone.' },
    ],
  },
  {
    id: '2026-10-02-your-timezone',
    date: '2026-10-02',
    title: 'Times in your own time zone',
    summary: 'Everyone picks their time zone, and messages, notifications, activity and the clock show in it.',
    changes: [
      { tag: 'new', text: 'The next time you open the site it asks which time zone you’re in, with your device’s already picked. After that, message times, notifications, activity, review and delivery times, the Master log and the clock at the top all show in your time. Change it any time from your name in the sidebar → Time zone.' },
      { tag: 'new', text: 'If your device moves to a different time zone (travelling, say), the site asks whether to switch.' },
      { tag: 'improved', text: 'Deadlines stay on the workspace’s time so everyone shares one cutoff, and the batch page now shows it in yours too, e.g. “due by 11:59 PM EDT · 9:29 AM (next day) your time”.' },
      { tag: 'improved', text: 'A time zone can be set without a city in Settings → Team, and clearing someone’s city keeps their time zone.' },
    ],
  },
  {
    id: '2026-10-02-batch-resources',
    date: '2026-10-02',
    title: 'Give a batch the client’s links and files',
    summary: 'When you create a batch, pick which of the client’s resources (links and PDFs) its writers get.',
    changes: [
      { tag: 'new', text: 'New work → New batch (and New shoot when you plan the scripts now): once you choose the client, “Client resources for the writers” lists its links and files. Tick the ones the writers need, or Select all. They show on the writers’ My work with the batch.' },
      { tag: 'new', text: 'On a batch page, Brief & resources shows the picked ones under This batch and the client’s other resources under “More from …”. Admins and managers can Add to batch, Add all to batch or Take off batch at any time. Taking one off only removes it from the batch, not from the client.' },
    ],
  },
  {
    id: '2026-10-01-pips-sent-back',
    date: '2026-10-01',
    title: 'Sent-back scripts show in Writing progress',
    summary: 'Scripts sent back for revisions now have their own colour in the script blocks.',
    changes: [
      { tag: 'fixed', text: 'In Writing progress and on the batch page, scripts sent back for revisions showed as “written, not sent”. They now show in the revisions colour as “Sent back”, with an “N sent back” tag next to the writer, until the writer sends the new version.' },
      { tag: 'fixed', text: 'Long names no longer get cut off next to the “+3 today” and “sent back” tags.' },
    ],
  },
  {
    id: '2026-10-01-messages',
    date: '2026-10-01',
    title: 'Messages, and a Writers tab',
    summary: 'Message anyone on the team from inside the site. Chats pop up in the bottom-right corner, like Messenger.',
    changes: [
      { tag: 'new', text: 'Messages: the round button in the bottom-right corner lists your conversations. Each chat opens as a small window along the bottom of the screen; minimise it to its name bar or close it. Up to three can be open at once (one on a phone). Enter sends, Shift+Enter starts a new line, and you can see when your message was seen.' },
      { tag: 'new', text: 'When someone messages you, their chat pops open on its own, and the button and the sidebar show how many messages you haven’t read.' },
      { tag: 'new', text: 'Writers (admins and managers): everyone on the team on one page, with their batches, scripts left to write and deliver, open to-dos, local time, next deadline and the latest message. Message, Their work and Add to-do are one click away. Writers get the same page as Messages.' },
    ],
  },
  {
    id: '2026-10-01-todos',
    date: '2026-10-01',
    title: 'To-dos for anyone, and sending approved scripts back',
    summary: 'Give any writer a to-do that shows on their My work and Overview, and send approved scripts back for revisions from the batch page.',
    changes: [
      { tag: 'new', text: 'To-dos: admins and managers can give anyone a to-do, with an optional date, from the Overview (Team to-dos) or from a writer’s row on a batch page (linked to that batch). It shows on their My work and Overview and they get a notification. They tick it off and you’re told. Finished to-dos stay for a week.' },
      { tag: 'new', text: 'Everyone can keep their own to-dos too, from Your to-dos on My work or the Overview.' },
      { tag: 'new', text: 'Batch page → a writer’s row → Send back for revisions: pick which of their approved or in-review scripts to send back and say what to change. They see it on My work and get a notification.' },
    ],
  },
  {
    id: '2026-10-01-palettes',
    date: '2026-10-01',
    title: 'Colour palettes',
    summary: 'The admin can change the site’s colours for everyone: six palettes with the same feel, or your own tweaks.',
    changes: [
      { tag: 'new', text: 'Settings → Colour palette (admin only): pick SCALE Media (the original), Sunset, Rose gold, Glacier, Citrus or Iris. Each keeps the dark look with bright pastel accents. You see it as you click, and Save applies it across the whole site for everyone, the sign-in page included.' },
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
      { tag: 'new', text: 'Admins and managers can open the Control Center from the small link under the SCALE Media wordmark, or from the sign-in page. It asks for your password first, and stays open for 12 hours on that device. Writers can’t open it.' },
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
    title: 'SCALE Media scripts launches',
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
