// Demo workspace. Only ever runs against an empty database (the demo uses its
// own data directory), and marks the workspace as demo so every screen says so.
// Dates are relative to today so the dashboard always has something to show.
//
//   npm run demo          → dev servers on a separate demo database
//   npm run seed:demo     → seed DATA_DIR / DATABASE_URL if it is empty

import { crc32, deflateSync } from 'node:zlib';
import type { Db } from './db';
import { hashPassword } from './auth';
import { clockFor, loadSettings, managerIds, notify, type Ctx } from './core';
import { applyScriptAction, insertBatch } from './routes/batches';
import { sendDocument } from './submissions';
import { bufferFile, storeFile } from './files';
import { asImageUpload, imageInfoOf } from './images';
import { recordThumbMoment } from './moments';
import { insertShoot } from './routes/shoots';
import { insertBriefing } from './routes/clients';
import { addPastThumbnail, tellImported } from './youtube';
import { addDays } from '../shared/dates';
import { fmtDate } from '../shared/format';
import { THUMBNAIL_LIVE_NOTIFICATION, type Me } from '../shared/types';
import { OPTION_LETTERS, portfolioPath, thumbBriefPath, thumbImportKey, thumbLiveKey, tidySecondLook, type BrandKitFields, type ThumbAction, type ThumbPinTag } from '../shared/workflow';
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
  const me = (key: string, role: 'manager' | 'writer' = 'writer'): Me => ({ id: ids[key], name: people.find((p) => p[1].toLowerCase().startsWith(key))![1], email: '', role, capacityPerDay: null, editorKind: null });
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

  // 12 · Thumbnail Studio · Ana, a thumbnail designer, with a pick from last week (marked live, with its Test & Compare
  // winner), one just picked after changes (a standout, with its celebration waiting for her), changes asked with notes
  // pinned on the image, a round waiting on review, an option in her private tray (with a second look kept on it), one
  // to start, one needing a designer, and two of her older Northwind thumbnails added from YouTube. The demo has no copy of Timeliner, so no brief names a Timeliner video and the
  // board's "Posted in Timeliner — mark it live?" stays empty
  const ana = (await db.one<{ id: number }>(
    `insert into users (email, name, role, editor_kind, password_hash) values ('ana@scalemedia.demo', 'Ana Torres', 'editor', 'thumbnail', $1) returning id`, [hash],
  ))!.id;
  const lisbon = findCity('Lisbon')!;
  await db.query(`update users set city = $2, city_code = $3, country = $4, lat = $5, lon = $6, timezone = $7, work_start = 9, work_end = 18 where id = $1`,
    [ana, lisbon.name, lisbon.code, lisbon.country, lisbon.lat, lisbon.lon, lisbon.timezone]);
  const anaMe: Me = { id: ana, name: 'Ana Torres', email: '', role: 'editor', capacityPerDay: null, editorKind: 'thumbnail' };
  const ago = (hours: number) => new Date(now.getTime() - hours * 3600_000).toISOString();
  const thumbBrief = async (clientId: number, title: string, o: { at: number; due?: number; shootId?: number; brief?: string; onImage?: string; noDesigner?: boolean }) =>
    (await db.one<{ id: number }>(
      `insert into thumbnail_briefs (client_id, shoot_id, title, brief, on_image, due_on, designer_id, created_by, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) returning id`,
      [clientId, o.shootId ?? null, title, o.brief ?? null, o.onImage ?? null, o.due == null ? null : d(o.due), o.noDesigner ? null : ana, ids.josh, ago(o.at)],
    ))!.id;
  // a round of Ana's options, sent or still in her tray; each image's type and size are read from its own bytes
  const thumbRound = async (briefId: number, number: number, looks: DemoLook[], o: { at: number; sent?: number; note?: string }) => {
    const roundId = (await db.one<{ id: number }>(
      `insert into thumbnail_rounds (brief_id, number, note, created_by, created_at, sent_at) values ($1,$2,$3,$4,$5,$6) returning id`,
      [briefId, number, o.note ?? null, ana, ago(o.at), o.sent == null ? null : ago(o.sent)],
    ))!.id;
    const options: number[] = [];
    for (const [i, look] of looks.entries()) {
      const data = demoThumb(look);
      const info = (await imageInfoOf(data))!;
      const fileId = await storeFile(db, anaMe, bufferFile(`option-${OPTION_LETTERS[i].toLowerCase()}.png`, info.mime, data));
      options.push((await db.one<{ id: number }>(
        `insert into thumbnail_variants (round_id, letter, file_id, mime, width, height, note, uploaded_by, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [roundId, OPTION_LETTERS[i], fileId, info.mime, info.width, info.height, look.note ?? null, ana, ago(o.at)],
      ))!.id);
    }
    return { id: roundId, options };
  };
  const thumbDecision = async (roundId: number, action: ThumbAction, at: number, o: { optionId?: number; note?: string; standout?: boolean }) =>
    (await db.one<{ id: number }>(
      `insert into thumbnail_decisions (round_id, action, variant_id, note, decided_by, created_at, standout) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [roundId, action, o.optionId ?? null, o.note ?? null, ids.josh, ago(at), !!o.standout],
    ))!.id;
  // a manager's numbered notes on spots of a round's options, dropped with a decision
  const thumbPins = async (decisionId: number, pins: { optionId: number; x: number; y: number; body: string; tag?: ThumbPinTag }[]) => {
    for (const [i, p] of pins.entries()) {
      await db.query(`insert into thumbnail_pins (decision_id, variant_id, x, y, n, body, tag) values ($1,$2,$3,$4,$5,$6,$7)`,
        [decisionId, p.optionId, p.x, p.y, i + 1, p.body, p.tag ?? null]);
    }
  };
  const C = {
    salmon: [255, 138, 117], cyan: [120, 220, 230], lavender: [190, 170, 255], mint: [140, 230, 180], pink: [255, 150, 190], yellow: [255, 230, 90],
    navy: [20, 40, 80], plum: [62, 32, 90], forest: [24, 60, 48], coffee: [70, 40, 30], latte: [200, 140, 90], ink: [40, 30, 50], cream: [250, 240, 230], white: [255, 255, 255],
  } as const;

  // Acme: picked last week, and (after changes on round 1) B of round 2 picked this morning
  const bag = await thumbBrief(acme, 'Autumn in one bag', { at: 13 * 24, brief: 'The whole autumn kit packed into the trail pack, held up to the camera.', onImage: 'ONE BAG' });
  const bagR1 = await thumbRound(bag, 1, [
    { from: C.salmon, to: C.plum, subject: C.ink, words: C.yellow, note: 'The pack as the hero, big and warm.' },
    { from: C.cyan, to: C.navy, subject: C.cream, words: C.white, left: true },
  ], { at: 12 * 24, sent: 11 * 24 });
  const bagPick = await thumbDecision(bagR1.id, 'pick', 10 * 24, { optionId: bagR1.options[0], note: 'The bag reads from across the room.' });
  // it went live two days later, and YouTube's Test & Compare against B agreed with the pick
  const bagLive = { on: d(-8), at: ago(8 * 24 - 2) };
  await db.query(
    `update thumbnail_briefs set published_url = $2, published_on = $3, published_by = $4, published_at = $5, test_winner_variant_id = $6, test_note = $7,
            youtube_video_id = $8 where id = $1`,
    [bag, 'https://www.youtube.com/watch?v=dmAutumnBag', bagLive.on, ids.josh, bagLive.at, bagR1.options[0], 'Ran A against B for two weeks: A kept people watching longer, mostly on phones.', 'dmAutumnBag'],
  );

  const jacket = await thumbBrief(acme, 'The jacket that folds into itself', {
    at: 4 * 24, due: -1, brief: 'Founder holding the jacket folded into its own pocket, surprised face.', onImage: 'FITS IN A POCKET',
  });
  const jacketR1 = await thumbRound(jacket, 1, [
    { from: C.mint, to: C.forest, subject: C.cream, words: C.yellow },
    { from: C.salmon, to: C.coffee, subject: C.cream, words: C.white, left: true, note: 'Closer on the face.' },
    { from: C.lavender, to: C.plum, subject: C.pink, words: C.yellow },
  ], { at: 60, sent: 48 });
  await thumbDecision(jacketR1.id, 'changes', 36, { note: 'Keep B’s face, but make the words bigger and cut them to three.' });
  const jacketR2 = await thumbRound(jacket, 2, [
    { from: C.salmon, to: C.coffee, subject: C.cream, words: C.yellow, left: true, note: 'Three words.' },
    { from: C.salmon, to: C.plum, subject: C.cream, words: C.yellow, left: true, note: 'Two words, bigger.' },
  ], { at: 24, sent: 20, note: 'Both keep B’s face. A has three words, B has two.' });
  const jacketPick = await thumbDecision(jacketR2.id, 'pick', 5, { optionId: jacketR2.options[1], note: 'Two words read best small.', standout: true });

  // Northwind: changes asked on round 1, so it's the first thing on Ana's Studio
  const harvest = await thumbBrief(northwind, 'What’s in the harvest box', {
    at: 3 * 24, due: 2, brief: 'Open box from above: the bags, a handwritten card, beans spilling out.', onImage: 'WHAT’S INSIDE?',
  });
  const harvestR1 = await thumbRound(harvest, 1, [
    { from: C.latte, to: C.coffee, subject: C.cream, words: C.white },
    { from: C.yellow, to: C.coffee, subject: C.ink, words: C.white, left: true },
  ], { at: 54, sent: 50 });
  const harvestChanges = await thumbDecision(harvestR1.id, 'changes', 22, { note: 'Show the beans, not the box. Warmer light, and put the words on the left.' });
  await thumbPins(harvestChanges, [
    { optionId: harvestR1.options[0], x: 0.64, y: 0.5, body: 'The closed box hides the point: tip it open and let the beans spill out here.', tag: 'composition' },
    { optionId: harvestR1.options[0], x: 0.2, y: 0.24, body: 'Words up here, on the left, and twice the size.', tag: 'text' },
    { optionId: harvestR1.options[1], x: 0.3, y: 0.55, body: 'Much warmer light on the bags: this reads cold at feed size.', tag: 'contrast' },
  ]);

  // Brightline: round 1 waiting on review (C is 4:3, so its shape check warns)
  const sameWeek = await thumbBrief(brightline, 'Same-week appointments, really', { at: 2 * 24, due: 3, brief: 'A smiling patient and a calendar page with this week circled.', onImage: 'SEEN THIS WEEK' });
  await thumbRound(sameWeek, 1, [
    { from: C.pink, to: C.plum, subject: C.cream, words: C.yellow, note: 'The bold one.' },
    { from: C.cyan, to: C.navy, subject: C.cream, words: C.white, left: true },
    { from: C.mint, to: C.forest, subject: C.cream, words: C.white, width: 1280, height: 960, note: 'The safe one.' },
  ], { at: 6, sent: 3, note: 'C is the safe one, A the bold one.' });

  // Lumen: one option in Ana's tray, not sent yet (managers see only that she's drafting)
  const serum = await thumbBrief(lumen, 'What the night serum actually does', { at: 30, due: 4, brief: 'The bottle on a bedside table at night, soft blue light.', onImage: 'WHILE YOU SLEEP' });
  const serumTray = await thumbRound(serum, 1, [{ from: C.lavender, to: C.navy, subject: C.cream, words: C.white, note: 'Night blue, bottle centre.' }], { at: 1 });
  // the second look she asked for on it (kept, so the demo shows one without an API key); private to her
  const look = tidySecondLook({
    oneLiner: 'Calm and on-brief, but the bottle gets lost at feed size: give it more light and fewer, bolder words.',
    checks: [
      { key: 'reads_small', status: 'watch', note: 'At phone size the bottle melts into the blue; it needs a rim light or a lighter backdrop.' },
      { key: 'focal_point', status: 'ok', note: 'The bottle is centred, but the lamp glow in the top right pulls the eye away.' },
      { key: 'words', status: 'watch', note: 'Three words in a light weight won’t survive 120 px wide. Go heavier, on two lines.' },
      { key: 'contrast', status: 'watch', note: 'Navy on lavender is close in value; the bottle should be the brightest thing.' },
      { key: 'brief_fit', status: 'strong', note: 'Bedside table, night, soft blue light: it’s all there.' },
      { key: 'brand_fit', status: 'ok', note: 'Soft and clean like their other covers, a touch darker than usual.' },
    ],
    suggestions: [
      'Add a warm rim light down the bottle’s left edge so it lifts off the backdrop.',
      'Set the words in a heavy weight, two lines, in the left third.',
      'Dim the lamp glow in the top right.',
    ],
  });
  await db.query(`insert into thumbnail_second_looks (variant_id, requested_by, result, created_at) values ($1,$2,$3::jsonb,$4)`,
    [serumTray.options[0], ana, JSON.stringify(look), ago(0.5)]);

  // Kinetic: just handed out, for the coach intro shoot; Harbor & Pine: waiting for a designer
  const dana = await thumbBrief(kinetic, 'Meet coach Dana', {
    at: 2, due: 6, shootId: k.shootId, brief: 'Dana mid-lift, looking straight at the camera. Bright studio, not gym-dark.', onImage: 'DAY 1 vs DAY 90',
  });
  await thumbBrief(harbor, 'Riverside in 60 seconds', { at: 20, due: 8, noDesigner: true, brief: 'The riverfront at golden hour, a front door in the foreground.', onImage: 'WOULD YOU LIVE HERE?' });

  // Northwind: two of Ana's thumbnails from before the site, added from YouTube yesterday (Add past thumbnails): picked
  // and live on the day each went up, on her wall and in her portfolio, from a channel named like the client. The video
  // ids are made up but well-formed, so "Watch on YouTube" leads nowhere real
  const past: { videoId: string; title: string; day: number; look: DemoLook }[] = [
    { videoId: 'dmRoastDay1', title: 'A day at the roastery', day: -41, look: { from: C.latte, to: C.forest, subject: C.cream, words: C.yellow } },
    { videoId: 'dmFarmTrip2', title: 'We went to the farm in Huila', day: -76, look: { from: C.mint, to: C.coffee, subject: C.cream, words: C.white, left: true } },
  ];
  const fromYoutube: { briefId: number; title: string }[] = [];
  for (const p of past) {
    const data = demoThumb(p.look);
    const info = (await imageInfoOf(data))!;
    fromYoutube.push({
      title: p.title,
      briefId: await addPastThumbnail(db, josh, { id: ana, name: 'Ana Torres' }, {
        videoId: p.videoId, clientId: northwind, title: p.title, publishedOn: d(p.day), channel: 'Northwind Coffee Roasters',
        channelUrl: 'https://www.youtube.com/@northwindcoffee', upload: asImageUpload(bufferFile(p.title, info.mime, data), info), info,
      }, settings.timezone),
    });
  }
  await db.query(`update thumbnail_briefs set created_at = $2, updated_at = $2, imported_at = $2, published_at = $2 where id = any($1::bigint[])`,
    [fromYoutube.map((b) => b.briefId), ago(26)]);
  // and the history says so at the same time
  await db.query(`update activity set created_at = $2 where action = 'thumbnail.imported' and entity_id = any($1::bigint[])`, [fromYoutube.map((b) => b.briefId), ago(26)]);
  await tellImported(db, josh, ana, fromYoutube);
  await db.query(`update notifications set created_at = $3 where user_id = $1 and dedupe_key = $2`, [ana, thumbImportKey(fromYoutube.map((b) => b.briefId)), ago(26)]);

  // what Ana and the managers were told
  const toAna = (briefId: number) => thumbBriefPath(anaMe, briefId);
  await notify(db, [ana], { type: 'thumbnail_new', title: 'New thumbnail · Meet coach Dana', body: 'Josh Rath gave you the thumbnail for “Meet coach Dana” (Kinetic Fitness Studios).', link: toAna(dana) });
  await notify(db, [ana], {
    type: 'thumbnail_changes', title: 'Changes asked · What’s in the harvest box', body: 'Josh Rath on round 1: “Show the beans, not the box. Warmer light, and put the words on the left.”',
    link: toAna(harvest), thumbnailDecisionId: harvestChanges,
  });
  await notify(db, [ana], {
    type: 'thumbnail_picked', title: 'Option B picked · The jacket that folds into itself', body: 'Josh Rath picked option B of round 2 and marked it Standout: “Two words read best small.”',
    link: toAna(jacket), thumbnailDecisionId: jacketPick,
  });
  // told once when the bag went live (read since, so it sits in her history at the day it happened)
  await notify(db, [ana], {
    type: THUMBNAIL_LIVE_NOTIFICATION, title: 'Your thumbnail for “Autumn in one bag” went live', body: `Josh Rath marked it live on ${fmtDate(bagLive.on)}.`,
    link: portfolioPath({ card: bagR1.options[0] }), dedupeKey: thumbLiveKey(bag, bagR1.options[0]), thumbnailDecisionId: bagPick,
  });
  await db.query(`update notifications set created_at = $3, read_at = $3 where user_id = $1 and dedupe_key = $2`, [ana, thumbLiveKey(bag, bagR1.options[0]), bagLive.at]);
  await notify(db, await managerIds(db), {
    type: 'thumbnail_sent', title: 'Round 1 to review · Same-week appointments, really', body: 'Ana Torres sent round 1 of “Same-week appointments, really”: 3 options. “C is the safe one, A the bold one.”',
    link: thumbBriefPath(josh, sameWeek),
  });

  // leave a few celebrations to greet people on their first visit; the rest are history
  await db.query(
    `update moments set seen_at = now()
      where not (kind = 'approved' and user_id = $1 and batch_id = $4) and not (kind in ('approved', 'revisions') and user_id = $2 and batch_id = $5) and not (kind = 'team_batch_done' and user_id = $3)`,
    [ids.sarah, ids.marcus, ids.josh, a.batchId, l.batchId],
  );
  // and Ana's standout pick, the next time she opens the site
  await recordThumbMoment(db, jacketPick, { name: 'Josh Rath' });

  // 13 · Brand kits for Acme and Northwind (colours, a font, do's and don'ts, and a logo resource drawn like the demo
  // thumbnails, in the kit's own colours so "Pick colours from logo" finds them), and three pictures on Ana's
  // reference boards: one she uploaded (General), her first Acme winner, and Acme's logo
  const brandKit = (clientId: number, kit: BrandKitFields) =>
    db.query(`insert into client_brand (client_id, colours, fonts, dos, donts, updated_by, updated_at) values ($1,$2::jsonb,$3::jsonb,$4,$5,$6,$7)`,
      [clientId, JSON.stringify(kit.colours), JSON.stringify(kit.fonts), kit.dos, kit.donts, ids.josh, ago(3 * 24)]);
  const logo = async (clientId: number, title: string, look: DemoLogo) => {
    const data = demoLogo(look);
    const info = (await imageInfoOf(data))!;
    const fileId = await storeFile(db, josh, bufferFile(`${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.png`, info.mime, data));
    return (await db.one<{ id: number }>(
      `insert into resources (client_id, kind, category, title, file_id, created_by, created_at) values ($1,'file','logo',$2,$3,$4,$5) returning id`,
      [clientId, title, fileId, ids.josh, ago(4 * 24)],
    ))!.id;
  };
  const K = {
    trail: [47, 93, 80], ember: [232, 116, 59], charcoal: [35, 38, 43], roast: [59, 36, 24], crema: [217, 160, 102], leaf: [78, 125, 74],
  } as const;
  await brandKit(acme, {
    colours: [{ name: 'Trail green', hex: '#2F5D50' }, { name: 'Ember', hex: '#E8743B' }, { name: 'Bone', hex: '#F3EDE2' }, { name: 'Charcoal', hex: '#23262B' }],
    fonts: [{ name: 'Bricolage Grotesque', url: 'https://fonts.google.com/specimen/Bricolage+Grotesque', resourceId: null }],
    dos: 'The product big and in use, outdoors, in real weather: rain, mud, low sun. Words in Bone or Ember, top left. Logo bottom right, small.',
    donts: 'No studio-white backgrounds. No superlatives on the image (“best”, “ultimate”). Never the old orange-only logo.',
  });
  const acmeLogo = await logo(acme, 'Acme logo', { mark: K.ember, inner: K.trail, words: K.charcoal });
  await brandKit(northwind, {
    colours: [{ name: 'Roast', hex: '#3B2418' }, { name: 'Crema', hex: '#D9A066' }, { name: 'Oat', hex: '#F6EFE4' }, { name: 'Leaf', hex: '#4E7D4A' }],
    fonts: [{ name: 'Fraunces', url: 'https://fonts.google.com/specimen/Fraunces', resourceId: null }],
    dos: 'Name the origin on the image when there’s room. Warm, natural light. Hands and beans, close up.',
    donts: 'No “bold” or “smooth”. No dark, moody café shots. Never coffee in a paper cup.',
  });
  await logo(northwind, 'Northwind logo', { mark: K.roast, inner: K.crema, words: K.leaf });

  const ref = (at: number, r: { clientId: number | null; fileId?: number; optionId?: number; resourceId?: number; caption: string }) =>
    db.query(`insert into thumbnail_refs (user_id, client_id, file_id, variant_id, resource_id, caption, created_at) values ($1,$2,$3,$4,$5,$6,$7)`,
      [ana, r.clientId, r.fileId ?? null, r.optionId ?? null, r.resourceId ?? null, r.caption, ago(at)]);
  const mood = demoThumb({ from: C.pink, to: C.navy, subject: C.cream, words: C.yellow, left: true });
  const moodFile = await storeFile(db, anaMe, bufferFile('big-face-one-word.png', (await imageInfoOf(mood))!.mime, mood));
  await ref(50, { clientId: null, fileId: moodFile, caption: 'Big face, one heavy word: the contrast I keep coming back to.' });
  await ref(26, { clientId: acme, optionId: bagR1.options[0], caption: 'Reads from across the room. Keep the warmth.' });
  await ref(2, { clientId: acme, resourceId: acmeLogo, caption: 'Logo bottom right, small.' });

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

type RGB = readonly [number, number, number];
/** How a demo thumbnail option looks: a gradient, a round subject (on the right unless `left`), bars where the words go. */
interface DemoLook { from: RGB; to: RGB; subject: RGB; words: RGB; left?: boolean; width?: number; height?: number; note?: string }

/**
 * A plain PNG sketch of a thumbnail for the demo (1280×720 unless asked otherwise): a diagonal gradient, a round
 * subject with a white cut-out edge and two bars for the words. About 20 KB: each row is stored as the change from
 * the pixel to its left, which a gradient keeps tiny.
 */
function demoThumb(look: DemoLook): Buffer {
  const w = look.width ?? 1280;
  const h = look.height ?? 720;
  const stride = 1 + w * 3;
  const raw = Buffer.alloc(stride * h);
  const cx = (look.left ? 0.3 : 0.7) * w;
  const cy = 0.6 * h;
  const r2 = (0.36 * h) ** 2;
  const edge2 = (0.385 * h) ** 2;
  const x0 = look.left ? 0.56 * w : 0.07 * w;
  const inBars = (x: number, y: number) => x >= x0 && ((y >= 0.2 * h && y < 0.4 * h && x < x0 + 0.37 * w) || (y >= 0.46 * h && y < 0.62 * h && x < x0 + 0.26 * w));
  const white: RGB = [255, 255, 255];
  const px = [0, 0, 0];
  const prev = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 1; // PNG's "Sub" filter
    prev.fill(0);
    for (let x = 0; x < w; x++) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      const solid = d < r2 ? look.subject : d < edge2 ? white : inBars(x, y) ? look.words : null;
      if (solid) { px[0] = solid[0]; px[1] = solid[1]; px[2] = solid[2]; } else {
        const t = (x + y) / (w + h);
        for (let k = 0; k < 3; k++) px[k] = Math.round(look.from[k] + (look.to[k] - look.from[k]) * t);
      }
      const at = y * stride + 1 + x * 3;
      for (let k = 0; k < 3; k++) { raw[at + k] = (px[k] - prev[k]) & 0xff; prev[k] = px[k]; }
    }
  }
  return demoPng(w, h, 2, raw);
}

/** How a demo client's logo looks: a round mark, a peak inside it, and two bars for the name, on a see-through background. */
interface DemoLogo { mark: RGB; inner: RGB; words: RGB }

/**
 * A plain PNG logo for the demo (640×320, with transparency): solid shapes in the logo's three colours and nothing
 * else, so "Pick colours from logo" finds exactly those, most of the mark first.
 */
function demoLogo(look: DemoLogo): Buffer {
  const [w, h] = [640, 320];
  const stride = 1 + w * 4;
  const raw = Buffer.alloc(stride * h);
  const [cx, cy, r2] = [0.25 * w, 0.5 * h, (0.36 * h) ** 2];
  const [top, base, half] = [cy - 0.2 * h, cy + 0.16 * h, 0.22 * h];
  const inPeak = (x: number, y: number) => y >= top && y <= base && Math.abs(x - cx) <= ((y - top) / (base - top)) * half;
  const inBars = (x: number, y: number) => x >= 0.47 * w && ((y >= 0.3 * h && y < 0.46 * h && x < 0.92 * w) || (y >= 0.54 * h && y < 0.66 * h && x < 0.78 * w));
  const px = [0, 0, 0, 0];
  const prev = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 1; // PNG's "Sub" filter
    prev.fill(0);
    for (let x = 0; x < w; x++) {
      const solid = inPeak(x, y) ? look.inner : (x - cx) ** 2 + (y - cy) ** 2 < r2 ? look.mark : inBars(x, y) ? look.words : null;
      if (solid) { px[0] = solid[0]; px[1] = solid[1]; px[2] = solid[2]; px[3] = 255; } else px.fill(0);
      const at = y * stride + 1 + x * 4;
      for (let k = 0; k < 4; k++) { raw[at + k] = (px[k] - prev[k]) & 0xff; prev[k] = px[k]; }
    }
  }
  return demoPng(w, h, 6, raw);
}

/** A PNG file from its filtered rows: 8 bits a channel, colour type 2 (RGB) or 6 (RGB with alpha). */
function demoPng(w: number, h: number, colourType: 2 | 6, raw: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body) >>> 0, body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8; // 8 bits a channel
  header[9] = colourType;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}
