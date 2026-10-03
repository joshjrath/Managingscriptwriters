// One-time data fixes that need app logic, run as migrations (see MIGRATIONS
// in schema.ts). Each runs once, inside the migration's transaction.
//
// These are shipped migrations: databases that haven't run them yet (a fresh
// install, a restored backup) run them with today's code. So they may only use
// columns that existed when they shipped, and changing what a helper they call
// does (the deadline maths in shared/dates.ts, for example) changes what they
// do. If such a helper has to change, copy its current version in here first.

import type { Db } from './db';
import { computeDeadlines, draftFromFinal, finalFromDraft, type DeadlineRules, type ISODate } from '../shared/dates';
import { fmtDate } from '../shared/format';

/**
 * Batches with only one of their two deadlines get the other one: from the
 * shoot rules when the batch has a shoot (as long as the order still holds),
 * otherwise by the gap the rules leave between drafts and final delivery.
 */
export async function fillMissingDeadlines(t: Db): Promise<void> {
  const s = await t.one<{ draft_offset_days: number; final_offset_days: number; day_mode: 'calendar' | 'business'; working_days: number[] | string }>(
    `select draft_offset_days, final_offset_days, day_mode, working_days from settings where id = 1`,
  );
  if (!s) return; // a brand-new workspace has no batches yet
  const rules: DeadlineRules = {
    draftOffsetDays: s.draft_offset_days, finalOffsetDays: s.final_offset_days, dayMode: s.day_mode,
    workingDays: typeof s.working_days === 'string' ? JSON.parse(s.working_days) : s.working_days,
  };
  const rows = await t.query<{ id: number; client_id: number; draft_due: ISODate | null; final_due: ISODate | null; shoot_start: ISODate | null }>(
    `select b.id, b.client_id, b.draft_due::text as draft_due, b.final_due::text as final_due, sh.start_date::text as shoot_start
       from batches b left join shoots sh on sh.id = b.shoot_id
      where (b.draft_due is null) <> (b.final_due is null)`,
  );
  for (const r of rows) {
    const auto = r.shoot_start ? computeDeadlines(r.shoot_start, rules) : null;
    if (!r.draft_due && r.final_due) {
      const fromShoot = auto && auto.draftDue <= r.final_due ? auto.draftDue : null;
      const fill = fromShoot ?? draftFromFinal(r.final_due, rules).date;
      const why = fromShoot ? auto!.draftRule : draftFromFinal(r.final_due, rules).rule;
      await t.query(`update batches set draft_due = $2, draft_due_mode = $3, updated_at = now() where id = $1`, [r.id, fill, fromShoot ? 'auto' : 'manual']);
      await t.query(
        `insert into activity (client_id, batch_id, entity_type, entity_id, action, summary, detail) values ($1, $2, 'batch', $2, 'batch.deadlines_filled', $3, $4::jsonb)`,
        [r.client_id, r.id, `Drafts due set to ${fmtDate(fill)} (${why}); it was missing`, JSON.stringify({ draftDue: fill })],
      );
    } else if (r.draft_due && !r.final_due) {
      const fromShoot = auto && auto.finalDue >= r.draft_due ? auto.finalDue : null;
      const fill = fromShoot ?? finalFromDraft(r.draft_due, rules).date;
      const why = fromShoot ? auto!.finalRule : finalFromDraft(r.draft_due, rules).rule;
      await t.query(`update batches set final_due = $2, final_due_mode = $3, updated_at = now() where id = $1`, [r.id, fill, fromShoot ? 'auto' : 'manual']);
      await t.query(
        `insert into activity (client_id, batch_id, entity_type, entity_id, action, summary, detail) values ($1, $2, 'batch', $2, 'batch.deadlines_filled', $3, $4::jsonb)`,
        [r.client_id, r.id, `Final delivery set to ${fmtDate(fill)} (${why}); it was missing`, JSON.stringify({ finalDue: fill })],
      );
    }
  }
}
