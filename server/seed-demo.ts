// Demo workspace. Only ever runs against an empty database (the demo uses its
// own data directory), and marks the workspace as demo so every screen says so.
// Dates are relative to today so the dashboard always has something to show.
//
//   npm run demo          → dev servers on a separate demo database
//   npm run seed:demo     → seed DATA_DIR / DATABASE_URL if it is empty

import type { Db } from './db';
import { hashPassword } from './auth';
import { clockFor, loadSettings, type Ctx } from './core';
import { applyScriptAction, insertBatch } from './routes/batches';
import { insertShoot } from './routes/shoots';
import { insertBriefing } from './routes/clients';
import { addDays } from '../shared/dates';
import type { Me } from '../shared/types';

export const DEMO_PASSWORD = 'scalemedia-demo';

export async function seedDemo(db: Db, now = new Date()): Promise<boolean> {
  const existing = await db.one<{ n: number }>(`select count(*) as n from users`);
  if (existing?.n) return false;

  const ctx: Ctx = { db, now: () => now, secureCookies: false, allowSetup: false, uploadLimitBytes: 0 };
  const hash = await hashPassword(DEMO_PASSWORD);
  const people = [
    ['josh@scalemedia.demo', 'Josh Rath', 'owner', null],
    ['sarah@scalemedia.demo', 'Sarah Chen', 'writer', 4],
    ['marcus@scalemedia.demo', 'Marcus Webb', 'writer', 3],
    ['priya@scalemedia.demo', 'Priya Nair', 'writer', null],
    ['leo@scalemedia.demo', 'Leo Alvarez', 'writer', 2],
  ] as const;
  const ids: Record<string, number> = {};
  for (const [email, name, role, cap] of people) {
    const r = await db.one<{ id: number }>(`insert into users (email, name, role, password_hash, capacity_per_day) values ($1,$2,$3,$4,$5) returning id`, [email, name, role, hash, cap]);
    ids[name.split(' ')[0].toLowerCase()] = r!.id;
  }
  await db.query(`update settings set is_demo = true where id = 1`);
  const me = (key: string, role: 'manager' | 'writer' = 'writer'): Me => ({ id: ids[key], name: people.find((p) => p[1].toLowerCase().startsWith(key))![1], email: '', role, capacityPerDay: null });
  const josh = me('josh', 'manager');

  const settings = await loadSettings(db);
  const clock = await clockFor(ctx, settings);
  const T = clock.today;
  const d = (n: number) => addDays(T, n);

  const client = async (name: string, extra: { description?: string; brand?: string; guidance?: string; archived?: boolean } = {}) => {
    const r = await db.one<{ id: number }>(
      `insert into clients (name, owner_id, description, brand_voice, guidance, created_by, status, archived_at) values ($1,$2,$3,$4,$5,$2,$6,$7) returning id`,
      [name, ids.josh, extra.description ?? null, extra.brand ?? null, extra.guidance ?? null, extra.archived ? 'archived' : 'active', extra.archived ? now.toISOString() : null],
    );
    return r!.id;
  };
  const link = (clientId: number, title: string, url: string, category: string, extra: { batchId?: number; briefingId?: number } = {}) =>
    db.query(`insert into resources (client_id, batch_id, briefing_id, kind, category, title, url, created_by) values ($1,$2,$3,'link',$4,$5,$6,$7)`,
      [clientId, extra.batchId ?? null, extra.briefingId ?? null, category, title, url, ids.josh]);

  const acme = await client('Acme Outdoor Co.', {
    description: 'Outdoor gear brand. Short-form social ads and founder-led explainers for the autumn range.',
    brand: 'Warm, capable, a little dry. Talk like a friend who has actually been on the trail — never like a catalogue.',
    guidance: 'Open on the problem in the first 2 seconds. One product per script. No superlatives ("best", "ultimate"). End with the season line: "Built for the long way round."',
  });
  const northwind = await client('Northwind Coffee Roasters', { description: 'Specialty roaster, DTC subscriptions.', brand: 'Curious and precise; celebrates the farmers.', guidance: 'Always name the origin. Avoid "bold" and "smooth".' });
  const brightline = await client('Brightline Dental Group', { description: 'Multi-location dental practice.', brand: 'Reassuring, plain-spoken, never clinical.', guidance: 'No before/after claims. Mention same-week appointments.' });
  const kinetic = await client('Kinetic Fitness Studios', { description: 'Boutique strength studios in three cities.', brand: 'High energy but inclusive.', guidance: 'Coaches speak in first person. Keep scripts under 45 seconds.' });
  const harbor = await client('Harbor & Pine Real Estate', { description: 'Coastal residential brokerage, new client after ideation call.' });
  const lumen = await client('Lumen Skincare', { description: 'Clean skincare line.', brand: 'Calm, science-literate.', guidance: 'Every claim must match the approved claims sheet.' });
  const riverside = await client('The Greater Riverside Community Credit Union & Financial Services Cooperative', { description: 'Member-owned credit union; long-name client for layout testing.' });
  await client('Old Mill Bakery', { description: 'Past client.', archived: true });

  // Acme: ideation call with a recording and a document, attached to the shoot batch
  const acmeBrief = await insertBriefing(db, josh, acme, {
    title: 'Autumn range ideation call', callDate: d(-6),
    recordingUrl: 'https://app.phantom.example/recordings/acme-autumn-ideation',
    documentUrl: 'https://docs.google.com/document/d/acme-autumn-brief',
    summary: 'Founder wants 45 short scripts across the rain shell, trail pack and camp stove. Heavy emphasis on repairability.',
    instructions: 'Scripts 1–20: rain shell + trail pack. Scripts 21–45: camp stove and "long way round" founder stories. Keep each under 40 seconds.',
  });
  await link(acme, 'Acme brand folder', 'https://drive.google.com/drive/folders/acme-brand', 'folder');
  await link(acme, 'Best-performing spring scripts', 'https://docs.google.com/document/d/acme-spring-examples', 'example');
  await link(acme, 'Product photography (autumn)', 'https://drive.google.com/drive/folders/acme-autumn-assets', 'asset');

  const shoot = async (clientId: number, title: string, start: number, end: number | null, batch: Parameters<typeof insertShoot>[2]['batch']) =>
    insertShoot(db, josh, { clientId, title, startDate: d(start), endDate: end == null ? null : d(end), location: null, notes: null, batch }, settings, clock);

  // 1 · Acme · 45 scripts split 1–20 / 21–45, shoot in 14–15 days
  const a = await shoot(acme, 'Autumn range shoot', 14, 15, {
    title: 'Autumn range · 45 scripts', targetCount: 45, priority: 'high', plannedStart: d(-3), draftDue: null, finalDue: null,
    brief: 'See the ideation call. Scripts 1–20 are product-led; 21–45 are founder stories.', nextAction: 'Review Marcus’s first 8 founder stories',
    briefingIds: [acmeBrief], split: [{ writerId: ids.sarah, count: 20 }, { writerId: ids.marcus, count: 25 }],
  });
  const scriptIds = async (batchId: number) => (await db.query<{ id: number; number: number }>(`select id, number from scripts where batch_id = $1 order by number`, [batchId]));
  const pick = (rows: { id: number; number: number }[], from: number, to: number) => rows.filter((r) => r.number >= from && r.number <= to).map((r) => r.id);
  const act = (who: Me, batchId: number, action: Parameters<typeof applyScriptAction>[3], sids: number[], note: string | null = null, url: string | null = null) =>
    applyScriptAction(ctx, who, batchId, action, sids, { note, timelinerUrl: url });

  let rows = await scriptIds(a.batchId);
  await act(me('sarah'), a.batchId, 'submit', pick(rows, 1, 12));
  await act(josh, a.batchId, 'approve', pick(rows, 1, 8));
  await act(me('sarah'), a.batchId, 'start', pick(rows, 13, 15));
  await act(me('marcus'), a.batchId, 'submit', pick(rows, 21, 28));
  await act(me('marcus'), a.batchId, 'start', pick(rows, 29, 31));

  // 2 · Northwind · single-day shoot in 15 days, 12 scripts
  const n = await shoot(northwind, 'Harvest subscription shoot', 15, null, {
    title: 'Harvest subscription launch', targetCount: 12, priority: 'normal', plannedStart: d(2), draftDue: null, finalDue: null,
    brief: null, nextAction: null, briefingIds: [], split: [{ writerId: ids.priya, count: 8 }, { writerId: ids.josh, count: 4 }],
  });
  rows = await scriptIds(n.batchId);
  await act(me('priya'), n.batchId, 'start', pick(rows, 1, 3));
  await act(josh, n.batchId, 'submit', pick(rows, 9, 9));
  await act(josh, n.batchId, 'start', pick(rows, 10, 10));

  // 3 · Brightline · drafts overdue
  const b = await shoot(brightline, 'Same-week appointments', 4, null, {
    title: 'Same-week appointments', targetCount: 10, priority: 'high', plannedStart: d(-8), draftDue: null, finalDue: null,
    brief: null, nextAction: 'Chase Leo for the last 4 drafts', briefingIds: [], split: [{ writerId: ids.leo, count: 10 }],
  });
  rows = await scriptIds(b.batchId);
  await act(me('leo'), b.batchId, 'submit', pick(rows, 1, 6));
  await act(me('leo'), b.batchId, 'start', pick(rows, 7, 10));

  // 4 · Kinetic · final delivery due today, partially delivered
  const k = await shoot(kinetic, 'Coach intro series', 3, 4, {
    title: 'Coach intro series', targetCount: 8, priority: 'urgent', plannedStart: d(-10), draftDue: null, finalDue: null,
    brief: null, nextAction: 'Sarah to add the last 3 to Timeliner', briefingIds: [], split: [{ writerId: ids.josh, count: 3 }, { writerId: ids.sarah, count: 5 }],
  });
  rows = await scriptIds(k.batchId);
  await act(josh, k.batchId, 'submit', pick(rows, 1, 3));
  await act(me('sarah'), k.batchId, 'submit', pick(rows, 4, 8));
  await act(josh, k.batchId, 'approve', pick(rows, 1, 8));
  await act(josh, k.batchId, 'deliver', pick(rows, 1, 3), 'Scheduled for next Tuesday', 'https://timeliner.io/');
  await act(me('sarah'), k.batchId, 'deliver', pick(rows, 4, 5), null, 'https://timeliner.io/');

  // 5 · Harbor & Pine · no shoot, five scripts after the ideation call, unassigned
  const hpBrief = await insertBriefing(db, josh, harbor, {
    title: 'Kick-off ideation call', callDate: d(-2), recordingUrl: 'https://app.phantom.example/recordings/harbor-pine-kickoff', documentUrl: null,
    summary: 'Five initial scripts to test tone before a shoot is booked.', instructions: 'Lead with the neighbourhood, not the listing.',
  });
  await insertBatch(db, josh, {
    clientId: harbor, shootId: null, title: 'Initial 5 scripts (post-ideation)', targetCount: 5, priority: 'normal', plannedStart: null,
    draftDue: d(4), finalDue: d(6), brief: 'Test scripts to agree tone before booking a shoot.', nextAction: 'Assign a writer', briefingIds: [hpBrief], split: [],
  }, settings, clock);

  // 6 · Lumen · final delivery overdue, blocked, revisions requested
  const l = await shoot(lumen, 'Night serum launch', 1, null, {
    title: 'Night serum launch', targetCount: 6, priority: 'high', plannedStart: d(-12), draftDue: null, finalDue: null,
    brief: null, nextAction: null, briefingIds: [], split: [{ writerId: ids.marcus, count: 6 }],
  });
  rows = await scriptIds(l.batchId);
  await act(me('marcus'), l.batchId, 'submit', pick(rows, 1, 6));
  await act(josh, l.batchId, 'approve', pick(rows, 1, 4));
  await act(josh, l.batchId, 'request_revisions', pick(rows, 5, 6), 'Claim “repairs overnight” isn’t on the approved sheet — rephrase to “supports overnight recovery”.');
  await act(me('marcus'), l.batchId, 'deliver', pick(rows, 1, 2), null, 'https://timeliner.io/');
  await db.query(`update batches set blocked = true, blocker_note = 'Waiting on claims approval from Lumen’s legal team', blocked_at = now(), blocked_by = $2 where id = $1`, [l.batchId, ids.marcus]);

  // 7 · Long client name · 30 scripts, not started, planned start in 10 days
  await shoot(riverside, 'Member stories', 25, 26, {
    title: 'Member stories · spring campaign', targetCount: 30, priority: 'low', plannedStart: d(10), draftDue: null, finalDue: null,
    brief: null, nextAction: null, briefingIds: [], split: [{ writerId: ids.priya, count: 15 }, { writerId: ids.leo, count: 15 }],
  });

  // 8 · Kinetic · previous batch, fully delivered this week
  const k2 = await insertBatch(db, josh, {
    clientId: kinetic, shootId: null, title: 'Member win stories', targetCount: 4, priority: 'normal', plannedStart: null,
    draftDue: d(-6), finalDue: d(-3), brief: null, nextAction: null, briefingIds: [], split: [{ writerId: ids.sarah, count: 4 }],
  }, settings, clock);
  rows = await scriptIds(k2.batchId);
  await act(me('sarah'), k2.batchId, 'submit', pick(rows, 1, 4));
  await act(josh, k2.batchId, 'approve', pick(rows, 1, 4));
  await act(me('sarah'), k2.batchId, 'deliver', pick(rows, 1, 4), 'All four scheduled', 'https://timeliner.io/');

  // 9 · Northwind · shoot moved with a manual final date kept → needs review
  const n2 = await shoot(northwind, 'Café partner shoot', 9, null, {
    title: 'Café partner spotlights', targetCount: 6, priority: 'normal', plannedStart: d(0), draftDue: null, finalDue: d(5),
    brief: null, nextAction: null, briefingIds: [], split: [{ writerId: ids.priya, count: 3 }, { writerId: ids.leo, count: 3 }],
  });
  await db.query(
    `update batches set needs_date_review = true, date_review_note = $2 where id = $1`,
    [n2.batchId, 'Shoot moved by the client. The manual final delivery date was kept — confirm it still works.'],
  );

  // make the first few days of history look like history
  await db.query(`update activity set created_at = created_at - interval '2 days' where action in ('client.created','briefing.created','shoot.created','batch.created')`);
  return true;
}
