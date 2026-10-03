// Deadline reminders: approaching, due today, and overdue. Planning
// reminders for managers: a shoot coming up with no scripts planned yet, or
// a batch with scripts nobody is assigned to, starting planReminderDays
// before the shoot (or drafts, with no shoot) and again at 7, 3 and 1 days.
//
// Runs inside the web process every REMINDER_INTERVAL_MINUTES (default 10),
// and can also be run once from a cron job with `npm run reminders`.
// Every reminder has a dedupe key per user, batch, milestone and date, so
// repeated runs (or several instances) never send the same reminder twice.
// A moved deadline gets a new key, so it is reminded about again.

import { LOCKS } from './db';
import { batchLink, clockFor, loadBatches, loadSettings, managerIds, notify, rulesOf, type Ctx, type ScriptLiteRow } from './core';
import { addDays, computeDeadlines, diffDays, type ISODate } from '../shared/dates';
import { isDraftReady } from '../shared/workflow';
import { fmtDate, fmtRange, plural } from '../shared/format';

export async function runReminders(ctx: Ctx): Promise<{ created: number; skipped?: boolean }> {
  return ctx.db.tx(async (t) => {
    // one runner at a time across instances (released at commit)
    const lock = await t.one<{ ok: boolean }>(`select pg_try_advisory_xact_lock(${LOCKS.reminders}) as ok`);
    if (!lock?.ok) return { created: 0, skipped: true };

    const c: Ctx = { ...ctx, db: t };
    const settings = await loadSettings(t);
    const clock = await clockFor(c, settings);
    const { summaries, scripts } = await loadBatches(c, {}, clock);
    const managers = await managerIds(t);
    let created = 0;

    for (const b of summaries) {
      if (b.stage === 'delivered') continue;
      const rows = scripts.get(b.id) ?? [];
      for (const m of [b.draft, b.final]) {
        if (!m.date || m.complete || m.daysUntil == null) continue;
        const behind = (s: ScriptLiteRow) => (m.kind === 'draft' ? !isDraftReady(s.status) : s.status !== 'delivered');
        const writers = [...new Set(rows.filter(behind).map((s) => s.assignee_id).filter((x): x is number => x != null))];
        const what = m.kind === 'draft' ? 'Drafts' : 'Final delivery to Timeliner';
        const left = `${plural(m.remaining, 'script')} ${m.kind === 'draft' ? 'not yet draft-ready' : 'not yet delivered'}`;
        const base = `${m.kind}:${b.id}:${m.date}`;

        if (m.overdue) {
          created += await notify(t, [...writers, ...managers], {
            type: 'overdue', title: `Overdue · ${b.clientName}`,
            body: `${b.title}: ${what} was due ${fmtDate(m.date)}. ${left}.`, link: batchLink(b.id), dedupeKey: `overdue:${base}`,
          });
        } else if (m.dueToday) {
          created += await notify(t, writers, {
            type: 'deadline', title: `Due today · ${b.clientName}`,
            body: `${b.title}: ${what} is due today. ${left}.`, link: batchLink(b.id), dedupeKey: `today:${base}`,
          });
        } else if (m.daysUntil > 0 && m.daysUntil <= settings.reminderLeadDays) {
          created += await notify(t, writers, {
            type: 'deadline', title: `Due ${m.daysUntil === 1 ? 'tomorrow' : `in ${m.daysUntil} days`} · ${b.clientName}`,
            body: `${b.title}: ${what} is due ${fmtDate(m.date)}. ${left}.`, link: batchLink(b.id), dedupeKey: `soon:${base}`,
          });
        }
      }
    }
    // planning: nudge managers while there's still time to brief writers
    const lead = settings.planReminderDays;
    const stages = [...new Set([lead, 7, 3, 1].filter((x) => x <= lead))].sort((a, b) => a - b);
    const stageFor = (days: number) => (days < 0 ? undefined : stages.find((x) => days <= x));
    const inDays = (days: number) => (days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`);
    const unplanned = await t.query<{ id: number; client_id: number; client_name: string; title: string | null; start_date: ISODate; end_date: ISODate | null }>(
      `select s.id, s.client_id, c.name as client_name, s.title, s.start_date, s.end_date
         from shoots s join clients c on c.id = s.client_id
        where s.cancelled_at is null and c.status <> 'archived' and s.start_date between $1 and $2
          and not exists (select 1 from batches b where b.shoot_id = s.id and b.archived_at is null)`,
      [clock.today, addDays(clock.today, lead)],
    );
    for (const sh of unplanned) {
      const days = diffDays(sh.start_date, clock.today);
      const stage = stageFor(days);
      if (stage == null) continue;
      const draftDue = computeDeadlines(sh.start_date, rulesOf(settings)).draftDue;
      created += await notify(t, managers, {
        type: 'planning', title: `Shoot ${inDays(days)} · ${sh.client_name}: no scripts planned`,
        body: `${sh.title || 'The shoot'} (${fmtRange(sh.start_date, sh.end_date)}) has no scripts yet. Add the script count and writers so drafts${draftDue ? ` (due ${fmtDate(draftDue)})` : ''} can start.`,
        link: `/clients/${sh.client_id}`, dedupeKey: `plan:shoot:${sh.id}:${sh.start_date}:${stage}`,
      });
    }
    for (const b of summaries) {
      if (b.stage === 'delivered' || !b.progress.unassigned) continue;
      const ref = b.shootStart ?? b.draftDue;
      if (!ref) continue;
      const days = diffDays(ref, clock.today);
      const stage = stageFor(days);
      if (stage == null) continue;
      created += await notify(t, managers, {
        type: 'planning', title: `${plural(b.progress.unassigned, 'script')} unassigned · ${b.clientName}`,
        body: `${b.title}: ${b.shootStart ? `shoot ${inDays(days)}` : `drafts due ${inDays(days)}`}${b.draftDue && b.shootStart ? `, drafts due ${fmtDate(b.draftDue)}` : ''}. Assign ${b.progress.unassigned === 1 ? 'it' : 'them'} to a writer.`,
        link: `${batchLink(b.id)}#scripts`, dedupeKey: `plan:batch:${b.id}:${ref}:${stage}`,
      });
    }

    await t.query(`update settings set reminders_last_run_at = now() where id = 1`);
    // keep a year of page views (and of failed sign-ins for emails that aren't on the team) in the
    // master log; changes and team members' sign-ins are kept. Expired sessions are no use to anyone.
    await t.query(`delete from audit_log where (kind = 'view' or (kind = 'auth' and user_id is null)) and created_at < now() - interval '400 days'`);
    await t.query(`delete from sessions where expires_at < now()`);
    return { created };
  });
}

export function startReminderScheduler(ctx: Ctx, minutes: number, log: (msg: string) => void): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runReminders(ctx);
      if (r.created) log(`reminders: sent ${r.created}`);
    } catch (err) {
      log(`reminders failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  const first = setTimeout(() => void tick(), 5_000);
  const every = setInterval(() => void tick(), minutes * 60_000);
  return () => { clearTimeout(first); clearInterval(every); };
}
