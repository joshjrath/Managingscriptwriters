// Deadline reminders: approaching, due today, and overdue.
//
// Runs inside the web process every REMINDER_INTERVAL_MINUTES (default 10),
// and can also be run once from a cron job with `npm run reminders`.
// Every reminder has a dedupe key per user, batch, milestone and date, so
// repeated runs (or several instances) never send the same reminder twice.
// A moved deadline gets a new key, so it is reminded about again.

import { batchLink, clockFor, loadBatches, loadSettings, managerIds, notify, type Ctx, type ScriptLiteRow } from './core';
import { isDraftReady } from '../shared/workflow';
import { fmtDate, plural } from '../shared/format';

export async function runReminders(ctx: Ctx): Promise<{ created: number; skipped?: boolean }> {
  return ctx.db.tx(async (t) => {
    // one runner at a time across instances (released at commit)
    const lock = await t.one<{ ok: boolean }>(`select pg_try_advisory_xact_lock(724001) as ok`);
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
    await t.query(`update settings set reminders_last_run_at = now() where id = 1`);
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
  const first = setTimeout(tick, 5_000);
  const every = setInterval(tick, minutes * 60_000);
  return () => { clearTimeout(first); clearInterval(every); };
}
