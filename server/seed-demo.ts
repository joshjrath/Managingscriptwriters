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
import { sendDocument } from './submissions';
import { bufferFile } from './files';
import { insertShoot } from './routes/shoots';
import { insertBriefing } from './routes/clients';
import { addDays } from '../shared/dates';
import type { Me } from '../shared/types';
import { findCity } from '../shared/cities';

export const DEMO_PASSWORD = 'scalemedia-demo';

/**
 * Fills an empty database with the sample workspace, all or nothing: seeding is skipped once there are
 * users, so a half-finished seed would otherwise never be completed.
 */
export async function seedDemo(db: Db, now = new Date()): Promise<boolean> {
  return db.tx((t) => seed(t, now));
}

async function seed(db: Db, now: Date): Promise<boolean> {
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
  // where everyone on the demo team works from
  for (const [key, city, hours] of [['josh', 'Toronto', [9, 18]], ['sarah', 'London', [9, 18]], ['marcus', 'Cape Town', [8, 17]], ['priya', 'Bengaluru', [10, 19]], ['leo', 'Mexico City', [9, 18]]] as const) {
    const c = findCity(city)!;
    await db.query(`update users set city = $2, city_code = $3, country = $4, lat = $5, lon = $6, timezone = $7, work_start = $8, work_end = $9 where id = $1`,
      [ids[key], c.name, c.code, c.country, c.lat, c.lon, c.timezone, hours[0], hours[1]]);
  }
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

  const shoot = async (clientId: number, title: string, start: number, end: number | null, batch: NonNullable<Parameters<typeof insertShoot>[2]['batch']>) => {
    const r = await insertShoot(db, josh, { clientId, title, startDate: d(start), endDate: end == null ? null : d(end), location: null, notes: null, batch }, settings, clock);
    return { ...r, batchId: r.batchId! };
  };

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

  // writers send their scripts as one document: a PDF, or a Google Doc link
  const send = (who: Me, batchId: number, sids: number[], doc: { pdf?: string; url?: string }, note: string | null = null, lines: string[] = []) =>
    sendDocument(ctx, who, batchId, {
      scriptIds: sids, url: doc.url ?? null, note,
      file: doc.pdf ? bufferFile(`${doc.pdf}.pdf`, 'application/pdf', demoPdf(doc.pdf, lines)) : null,
    });

  let rows = await scriptIds(a.batchId);
  await send(me('sarah'), a.batchId, pick(rows, 1, 12), { pdf: 'Acme autumn range - scripts 1-12' }, 'All twelve in one PDF. 4 and 9 run a little long.',
    ['Layer up without the bulk', 'The 3-piece travel kit', 'Rain-proof, not style-proof', 'Autumn in one bag', 'What 400 miles taught us', 'The jacket that folds into itself',
      'Made for the school run', 'Warm hands, cold mornings', 'The founder’s favourite', 'Recycled, and it feels it', 'Your weekend uniform', 'Built to be handed down']);
  await act(josh, a.batchId, 'approve', pick(rows, 1, 8));
  await act(me('sarah'), a.batchId, 'start', pick(rows, 13, 15));
  await send(me('marcus'), a.batchId, pick(rows, 21, 28), { url: 'https://docs.google.com/document/d/demo-acme-founder-stories/edit' }, 'First 8 founder stories. Comment straight in the doc.');
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
  await send(me('leo'), b.batchId, pick(rows, 1, 6), { url: 'https://docs.google.com/document/d/demo-brightline-appointments/edit' });
  await act(me('leo'), b.batchId, 'start', pick(rows, 7, 10));

  // 4 · Kinetic · final delivery due today, partially delivered
  const k = await shoot(kinetic, 'Coach intro series', 3, 4, {
    title: 'Coach intro series', targetCount: 8, priority: 'urgent', plannedStart: d(-10), draftDue: null, finalDue: null,
    brief: null, nextAction: 'Sarah to add the last 3 to Timeliner', briefingIds: [], split: [{ writerId: ids.josh, count: 3 }, { writerId: ids.sarah, count: 5 }],
  });
  rows = await scriptIds(k.batchId);
  await act(josh, k.batchId, 'submit', pick(rows, 1, 3));
  await act(me('sarah'), k.batchId, 'submit', pick(rows, 4, 8));
  // a manager's delivery covers every approved script, so 6–8 are approved after it: 1–5 delivered, 6–8 still to add
  await act(josh, k.batchId, 'approve', pick(rows, 1, 5));
  await act(josh, k.batchId, 'deliver', pick(rows, 1, 3), 'Scheduled for next Tuesday', 'https://timeliner.io/');
  await act(josh, k.batchId, 'approve', pick(rows, 6, 8));

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
  await send(me('marcus'), l.batchId, pick(rows, 1, 6), { pdf: 'Lumen night serum - all 6' });
  await act(josh, l.batchId, 'approve', pick(rows, 1, 4));
  await applyScriptAction(ctx, josh, l.batchId, 'request_revisions', pick(rows, 5, 6), {
    note: 'Claim “repairs overnight” isn’t on the approved sheet — rephrase to “supports overnight recovery”. My edits are in the doc.', timelinerUrl: null,
    review: { url: 'https://docs.google.com/document/d/demo-lumen-edits/edit', fileId: null },
  });
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

  // 10 · Harbor & Pine · a shoot booked before anyone knows the script count
  await insertShoot(db, josh, { clientId: harbor, title: 'Neighbourhood tours', startDate: d(12), endDate: null, location: 'Riverside', notes: null }, settings, clock);

  // 11 · people we're still talking to
  for (const [name, desc] of [
    ['Sunny Side Bakery', 'Met at the food expo. Wants 20 short scripts a month for Reels; proposal sent.'],
    ['Peak Physio Group', 'Intro call booked for next week. Three clinics, interested in patient stories.'],
  ]) {
    await db.query(`insert into clients (name, status, owner_id, description, created_by) values ($1, 'prospect', $2, $3, $2)`, [name, ids.josh, desc]);
  }

  // leave a few celebrations to greet people on their first visit; the rest are history
  await db.query(
    `update moments set seen_at = now()
      where not (kind = 'approved' and user_id = $1 and batch_id = $4) and not (kind in ('approved', 'revisions') and user_id = $2 and batch_id = $5) and not (kind = 'team_batch_done' and user_id = $3)`,
    [ids.sarah, ids.marcus, ids.josh, a.batchId, l.batchId],
  );

  // make the first few days of history look like history
  await db.query(`update activity set created_at = created_at - interval '2 days' where action in ('client.created','briefing.created','shoot.created','batch.created')`);
  return true;
}

/** A small, valid one-page PDF with a line per script, for demo documents. */
function demoPdf(title: string, lines: string[]): Buffer {
  const esc = (t: string) => t.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7e]/g, '').replace(/([\\()])/g, '\\$1');
  const body = [`BT /F1 18 Tf 60 780 Td (${esc(title)}) Tj ET`, ...lines.map((l, i) => `BT /F1 12 Tf 60 ${740 - i * 22} Td (${i + 1}. ${esc(l)}) Tj ET`)].join('\n');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
