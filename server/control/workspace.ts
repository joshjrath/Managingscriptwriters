// The live workspace as a Control Center world: team members who have a city
// become nodes, batches become projects, every script becomes an object in
// the system, and recent submissions and reviews become handoffs between the
// people who actually sent and reviewed them.

import type { Db } from '../db';
import { loadSettings } from '../core';
import {
  callsignOf, initialsOf, localClock,
  type CcActivity, type CcClient, type CcHandoff, type CcLink, type CcProject, type CcScript, type CcWriter,
  type ControlWorld, type NodeRole, type NodeStatus, type ScriptState,
} from '../../shared/control';
import type { ScriptStatus } from '../../shared/workflow';
import { finishWorld } from './finish';
import { loadEditorRows } from './editors';
import type { Role } from '../../shared/workflow';

const H = 3_600_000;
const D = 24 * H;
/** finished scripts sent with each snapshot, for the galaxy and the archive */
const ARCHIVE_SCRIPTS = 1500;

const STATE: Record<ScriptStatus, ScriptState> = {
  not_started: 'research', in_progress: 'writing', ready_for_review: 'internal_review',
  revisions_needed: 'revision', approved: 'approved', delivered: 'delivered',
};
const PROGRESS: Record<ScriptStatus, number> = {
  not_started: 0.05, in_progress: 0.45, ready_for_review: 0.75, revisions_needed: 0.6, approved: 0.95, delivered: 1,
};

interface UserRow {
  id: number; name: string; role: Role; capacity_per_day: number | null;
  city: string | null; city_code: string | null; country: string | null; lat: number | null; lon: number | null;
  timezone: string | null; work_start: number | null; work_end: number | null;
}
interface BatchRow {
  id: number; client_id: number; client_name: string; title: string; priority: CcProject['priority'];
  draft_due: string | null; final_due: string | null; blocked: boolean; blocker_note: string | null;
  archived_at: string | null; created_by: number | null; owner_id: number | null;
}
interface ScriptRow {
  id: number; batch_id: number; number: number; title: string | null; assignee_id: number | null; status: ScriptStatus;
  approved_by: number | null; submitted_at: string | null; delivered_at: string | null; updated_at: string;
}

/** A calendar date's deadline as an instant: the organisation's cutoff on that day, in its timezone. */
export function deadlineInstant(date: string, tz: string, cutoff: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = cutoff.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let at = guess - localClock(tz, new Date(guess)).offset * 60_000;
  at = guess - localClock(tz, new Date(at)).offset * 60_000; // settle across a DST change
  return new Date(at).toISOString();
}

export async function workspaceWorld(db: Db, at: Date): Promise<ControlWorld> {
  const settings = await loadSettings(db);
  const now = at.getTime();
  const users = await db.query<UserRow>(
    `select id, name, role, capacity_per_day, city, city_code, country, lat, lon, timezone, work_start, work_end
       from users where active and removed_at is null order by name`,
  );
  const placed = users.filter((u) => u.lat != null && u.lon != null && u.timezone);
  const placedIds = new Set(placed.map((u) => u.id));
  const nid = (id: number | null | undefined) => (id != null && placedIds.has(id) ? `u${id}` : null);

  // live batches, plus the most recently finished ones for the archive; kept to
  // what the view can show so each refresh stays small on the server and the device
  const cols = `b.id, b.client_id, c.name as client_name, b.title, b.priority, b.draft_due, b.final_due, b.blocked, b.blocker_note,
            b.archived_at, b.created_by, c.owner_id`;
  const batches = [
    ...await db.query<BatchRow>(`select ${cols} from batches b join clients c on c.id = b.client_id where b.archived_at is null order by b.id desc limit 200`),
    ...await db.query<BatchRow>(`select ${cols} from batches b join clients c on c.id = b.client_id where b.archived_at is not null order by b.archived_at desc limit 60`),
  ];
  const scriptRows = batches.length
    ? await db.query<ScriptRow>(
      `select id, batch_id, number, title, assignee_id, status, approved_by, submitted_at, delivered_at, updated_at
         from scripts where removed_at is null and batch_id in (${batches.map((_, i) => `$${i + 1}`).join(',')})
        order by batch_id, number`, batches.map((b) => b.id),
    )
    : [];
  const byBatch = new Map<number, ScriptRow[]>();
  for (const s of scriptRows) byBatch.set(s.batch_id, [...(byBatch.get(s.batch_id) ?? []), s]);

  // finished batches drift into the archive; keep a year of them
  const finishedAt = (b: BatchRow) => {
    const list = byBatch.get(b.id) ?? [];
    if (!list.length) return b.archived_at;
    if (list.every((s) => s.status === 'delivered')) {
      return list.reduce<string | null>((m, s) => (s.delivered_at && (!m || s.delivered_at > m) ? s.delivered_at : m), null) ?? b.archived_at;
    }
    return b.archived_at;
  };
  // live batches always; finished ones (newest first) until the snapshot holds ARCHIVE_SCRIPTS of their scripts
  let archiveBudget = ARCHIVE_SCRIPTS;
  const kept = batches.filter((b) => {
    const done = finishedAt(b);
    const n = byBatch.get(b.id)?.length ?? 0;
    if (!n) return !b.archived_at;
    if (!done) return true;
    if (now - new Date(done).getTime() > 365 * D || archiveBudget < n) return false;
    archiveBudget -= n;
    return true;
  });

  // who reviews each batch: whoever reviewed it last, else the client's owner, else whoever created it
  const lastReviewer = new Map((await db.query<{ batch_id: number; reviewed_by: number }>(
    `select distinct on (batch_id) batch_id, reviewed_by from reviews order by batch_id, created_at desc`,
  )).map((r) => [r.batch_id, r.reviewed_by]));
  const firstLead = placed.find((u) => u.role === 'owner' || u.role === 'manager')?.id ?? null;
  const reviewerOf = (b: BatchRow) => nid(lastReviewer.get(b.id)) ?? nid(b.owner_id) ?? nid(b.created_by) ?? nid(firstLead);

  const due = (date: string | null) => (date ? deadlineInstant(date, settings.timezone, settings.cutoff) : null);
  const projects: CcProject[] = [];
  const scripts: CcScript[] = [];
  const clients = new Map<string, CcClient>();
  for (const b of kept) {
    const list = byBatch.get(b.id) ?? [];
    const done = finishedAt(b);
    const archived = !!done;
    const reviewer = reviewerOf(b);
    clients.set(`c${b.client_id}`, { id: `c${b.client_id}`, name: b.client_name });
    const writing = list.some((s) => s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed');
    projects.push({
      id: `b${b.id}`, title: b.title, clientId: `c${b.client_id}`, client: b.client_name, writers: [], stage: 'research',
      progress: { done: 0, total: 0 }, deadline: due(writing ? b.draft_due ?? b.final_due : b.final_due ?? b.draft_due),
      scripts: [], priority: b.priority, archived, completedAt: archived ? done : null,
      blocked: b.blocked ? b.blocker_note || 'Blocked' : null, clientWaitingSince: null,
    });
    for (const s of list) {
      const drafting = s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed';
      scripts.push({
        id: `s${s.id}`, title: s.title || `${b.title} · ${s.number}`, code: `SCRIPT ${String(s.id).padStart(3, '0')}`,
        projectId: `b${b.id}`, writerId: nid(s.assignee_id), reviewerId: nid(s.approved_by) ?? reviewer,
        state: STATE[s.status], deadline: due(drafting ? b.draft_due ?? b.final_due : b.final_due ?? b.draft_due),
        progress: PROGRESS[s.status], wordCount: null, updatedAt: s.updated_at,
      });
    }
  }

  // how busy each person is, and when they last did something
  const openCount = new Map<number, number>();
  const writingNow = new Set<number>();
  for (const s of scriptRows) {
    if (s.assignee_id == null || s.status === 'delivered' || s.status === 'approved') continue;
    openCount.set(s.assignee_id, (openCount.get(s.assignee_id) ?? 0) + 1);
    if (s.status === 'in_progress' && now - new Date(s.updated_at).getTime() < 3 * D) writingNow.add(s.assignee_id);
  }
  const weekly = new Map((await db.query<{ assignee_id: number; n: number }>(
    `select assignee_id, count(*) as n from scripts where removed_at is null and submitted_at > $1 and assignee_id is not null group by assignee_id`,
    [new Date(now - 7 * D).toISOString()],
  )).map((r) => [r.assignee_id, Number(r.n)]));
  const last = new Map((await db.query<{ id: number; at: string }>(
    `select actor_id as id, max(created_at) as at from activity where actor_id is not null group by actor_id
     union all select user_id as id, max(updated_at) as at from writer_progress group by user_id`,
  )).reduce((m, r) => { if (!m.has(r.id) || r.at > m.get(r.id)!) m.set(r.id, r.at); return m; }, new Map<number, string>()));
  const awaitingReview = scriptRows.some((s) => s.status === 'ready_for_review');

  const writers: CcWriter[] = placed.map((u) => {
    const lead = u.role === 'owner' || u.role === 'manager';
    const role: NodeRole = u.role === 'owner' ? 'lead' : u.role === 'manager' ? 'reviewer' : u.role === 'editor' ? 'editor' : 'writer';
    const status: NodeStatus = lead && awaitingReview ? 'reviewing' : writingNow.has(u.id) ? 'deep_work' : 'active';
    const weekCapacity = (u.capacity_per_day ?? 4) * 5;
    return {
      id: `u${u.id}`, name: u.name, callsign: callsignOf(u.name), initials: initialsOf(u.name),
      city: u.city ?? '', cityCode: (u.city_code ?? u.city ?? '').slice(0, 3).toUpperCase(), country: u.country ?? '',
      lat: u.lat!, lon: u.lon!, timezone: u.timezone!, role, status,
      workHours: [u.work_start ?? 9, u.work_end ?? 18],
      currentAssignment: null, projectId: null, clientId: null, progress: null, deadline: null, stage: null,
      weeklyOutput: weekly.get(u.id) ?? 0, workload: (openCount.get(u.id) ?? 0) / weekCapacity, lastActivity: last.get(u.id) ?? null,
    };
  });

  // editors: on the globe with their city and hours, but no scripts or sign-ins
  for (const e of await loadEditorRows(db)) {
    writers.push({
      id: `e${e.id}`, name: e.name, callsign: callsignOf(e.name), initials: initialsOf(e.name),
      city: e.city, cityCode: e.city_code, country: e.country, lat: e.lat, lon: e.lon, timezone: e.timezone,
      role: 'editor', status: 'active', workHours: [e.work_start, e.work_end],
      currentAssignment: null, projectId: null, clientId: null, progress: null, deadline: null, stage: null,
      weeklyOutput: 0, workload: 0, lastActivity: null,
    });
  }

  // handoffs: scripts sent for review, and approvals or revisions sent back, in the last three days
  const since = new Date(now - 3 * D).toISOString();
  const batchById = new Map(batches.map((b) => [b.id, b]));
  const handoffs: CcHandoff[] = [];
  const moves = await db.query<{ id: number; batch_id: number; actor_id: number | null; action: string; detail: { scripts?: number[] } | string | null; created_at: string }>(
    `select id, batch_id, actor_id, action, detail, created_at from activity
      where created_at > $1 and batch_id is not null and action in ('scripts.submit', 'scripts.approve', 'scripts.request_revisions')
      order by created_at desc, id desc limit 60`, [since],
  );
  const label = (list: ScriptRow[]) => (list.length > 1 ? `${list.length} SCRIPTS` : `SCRIPT ${String(list[0].id).padStart(3, '0')}`);
  for (const m of moves) {
    const b = batchById.get(m.batch_id);
    const detail = (typeof m.detail === 'string' ? JSON.parse(m.detail) : m.detail) ?? {};
    const moved = (byBatch.get(m.batch_id) ?? []).filter((s) => (detail.scripts ?? []).includes(s.number));
    const from = nid(m.actor_id);
    if (!b || !from || !moved.length) continue;
    if (m.action === 'scripts.submit') {
      const to = reviewerOf(b);
      if (to && to !== from) handoffs.push({ id: `h${m.id}`, originNode: from, destinationNode: to, script: `s${moved[0].id}`, label: label(moved), state: 'REVIEW QUEUED', timestamp: m.created_at });
      continue;
    }
    // a review goes back to each writer whose scripts it covered
    const byWriter = new Map<string, ScriptRow[]>();
    for (const s of moved) { const w = nid(s.assignee_id); if (w && w !== from) byWriter.set(w, [...(byWriter.get(w) ?? []), s]); }
    for (const [to, list] of byWriter) {
      handoffs.push({
        id: `h${m.id}-${to}`, originNode: from, destinationNode: to, script: `s${list[0].id}`, label: label(list),
        state: m.action === 'scripts.approve' ? 'APPROVED' : 'REVISIONS RETURNED', timestamp: m.created_at,
      });
    }
  }
  handoffs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // relationships: each writer to whoever reviews their open work, and writers sharing a batch
  const linkMap = new Map<string, CcLink>();
  const liveProjects = new Set(projects.filter((p) => !p.archived).map((p) => p.id));
  for (const s of scripts) {
    if (!liveProjects.has(s.projectId) || !s.writerId || s.state === 'delivered') continue;
    if (s.reviewerId && s.reviewerId !== s.writerId) {
      const key = `${s.writerId}>${s.reviewerId}`;
      const l = linkMap.get(key) ?? { from: s.writerId, to: s.reviewerId, kind: 'review' as const, active: false };
      if (s.state === 'internal_review') l.active = true;
      linkMap.set(key, l);
    }
  }
  for (const p of projects) {
    if (p.archived) continue;
    const ws = [...new Set(scripts.filter((s) => s.projectId === p.id && s.writerId && s.state !== 'delivered').map((s) => s.writerId!))];
    for (let i = 0; i < ws.length; i++) for (let j = i + 1; j < ws.length; j++) {
      const key = [ws[i], ws[j]].sort().join('~');
      if (!linkMap.has(key) && !linkMap.has(`${ws[i]}>${ws[j]}`) && !linkMap.has(`${ws[j]}>${ws[i]}`)) linkMap.set(key, { from: ws[i], to: ws[j], kind: 'collab', active: false });
    }
  }

  // the signal feed: recent history, in the system's voice
  const acts = await db.query<{ id: number; created_at: string; actor_id: number | null; actor: string | null; summary: string; title: string | null }>(
    `select a.id, a.created_at, a.actor_id, u.name as actor, a.summary, b.title
       from activity a left join users u on u.id = a.actor_id left join batches b on b.id = a.batch_id
      order by a.created_at desc, a.id desc limit 40`,
  );
  const activity: CcActivity[] = acts.map((a) => ({
    id: `a${a.id}`, timestamp: a.created_at, actorId: nid(a.actor_id), actor: a.actor ? callsignOf(a.actor) : 'NETWORK',
    // the system's voice: the change itself, without the quoted notes
    action: a.summary.replace(/\s+—\s+“[\s\S]*$/, '').replace(/\s*\((?:edited version|changes) attached\)/, '').replace(/\.$/, '').slice(0, 90).toUpperCase(), subject: (a.title ?? '').toUpperCase(), origin: nid(a.actor_id), destination: null,
  }));

  return finishWorld({
    source: { kind: 'workspace', label: 'LIVE WORKSPACE', unplaced: users.length - placed.length, replayed: false },
    generatedAt: at.toISOString(), orgName: settings.orgName, writers, clients: [...clients.values()],
    projects, scripts, activity, handoffs, links: [...linkMap.values()],
  }, at);
}
