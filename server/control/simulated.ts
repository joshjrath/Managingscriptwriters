// The simulated network: a centralized, believable Scale Media operation with
// sample people and clients, used only when the server sets
// CONTROL_CENTER_DATA=simulated (the default is the real workspace). Every time is relative to now, so deadlines
// keep approaching and the world always looks current. It's labelled
// "SIMULATED NETWORK" everywhere it matters, and nothing here pretends to be a
// live integration.

import { localClock } from '../../shared/control';
import type { CcActivity, CcClient, CcHandoff, CcLink, CcProject, CcScript, CcWriter, ControlWorld, NodeRole, NodeStatus, Priority, ScriptState } from '../../shared/control';
import { findCity } from '../../shared/cities';
import { finishWorld } from './finish';

const H = 3_600_000;
const M = 60_000;
const D = 24 * H;

interface WriterSeed {
  id: string; name: string; city: string; role: NodeRole; status: NodeStatus; hours: [number, number];
  workload: number; weekly: number; activeAgo: number;
  /** keeps working after hours, so shows up late at night */
  nightOwl?: boolean;
}

const WRITERS: WriterSeed[] = [
  { id: 'josh', name: 'Josh Rath', city: 'Toronto', role: 'lead', status: 'reviewing', hours: [9, 18], workload: 1.08, weekly: 23, activeAgo: 4 * M, nightOwl: true },
  { id: 'maya', name: 'Maya Lindqvist', city: 'London', role: 'writer', status: 'deep_work', hours: [9, 18], workload: 0.92, weekly: 17, activeAgo: 2 * M },
  { id: 'arjun', name: 'Arjun Mehta', city: 'Mumbai', role: 'writer', status: 'active', hours: [10, 19], workload: 1.54, weekly: 21, activeAgo: 6 * M },
  { id: 'emi', name: 'Emi Sato', city: 'Tokyo', role: 'editor', status: 'reviewing', hours: [10, 19], workload: 0.74, weekly: 12, activeAgo: 3 * H },
  { id: 'lucia', name: 'Lucia Ferreyra', city: 'Buenos Aires', role: 'writer', status: 'deep_work', hours: [9, 18], workload: 0.88, weekly: 15, activeAgo: 41 * M, nightOwl: true },
  { id: 'noah', name: 'Noah Kessler', city: 'Los Angeles', role: 'researcher', status: 'active', hours: [9, 17], workload: 0.61, weekly: 9, activeAgo: 5 * H },
  { id: 'kofi', name: 'Kofi Mensah', city: 'Lagos', role: 'writer', status: 'active', hours: [8, 17], workload: 0.97, weekly: 14, activeAgo: 58 * M },
  { id: 'ava', name: 'Ava Brennan', city: 'Sydney', role: 'writer', status: 'deep_work', hours: [11, 19], workload: 0.83, weekly: 13, activeAgo: 7 * H },
];

const CLIENTS: CcClient[] = [
  { id: 'downtown-dental', name: 'Downtown Dental' },
  { id: 'pharmaconic', name: 'Pharmaconic' },
  { id: 'scale-media', name: 'Scale Media Ads' },
  { id: 'specular', name: 'Specular' },
  { id: 'halberg-law', name: 'Halberg Law' },
  { id: 'northshore', name: 'Northshore Fitness' },
  { id: 'verdant', name: 'Verdant Home' },
];

type Plan = [ScriptState, number, string, string | null][]; // state, count, writer, reviewer

interface ProjectSeed {
  id: string; client: string; title: string; priority: Priority; due: number; plan: Plan; titles: string[];
  /** per-state deadline overrides, ms from now */
  dueBy?: Partial<Record<ScriptState, number>>;
  clientWaiting?: number; archivedAgo?: number;
}

const LIVE: ProjectSeed[] = [
  {
    id: 'dd-master', client: 'downtown-dental', title: 'Master Script Batch', priority: 'urgent', due: 4 * H + 36 * M,
    dueBy: { internal_review: 4 * H + 36 * M, writing: 4 * H + 36 * M, revision: 4 * H + 36 * M },
    plan: [['delivered', 3, 'maya', 'josh'], ['approved', 7, 'maya', 'josh'], ['approved', 4, 'arjun', 'josh'], ['writing', 2, 'arjun', 'josh'], ['writing', 1, 'maya', 'josh'], ['internal_review', 1, 'maya', 'josh'], ['internal_review', 1, 'arjun', 'josh'], ['revision', 1, 'arjun', 'josh']],
    titles: ['Same-day crowns, explained', 'Why we open at 7', 'The two-minute check-up', 'Nervous? Start here', 'What a cleaning actually does', 'Invisalign, honestly', 'Kids’ first visit', 'The whitening myth', 'Emergency? Call us first', 'Meet Dr. Amara', 'Floss or brush first?', 'The 6-month rule', 'Gum health in 30 seconds', 'Your insurance, decoded', 'Before the wedding', 'Grinding at night', 'Coffee and your smile', 'The quiet clinic', 'Crowns vs. veneers', 'Downtown, in and out'],
  },
  {
    id: 'ph-patient', client: 'pharmaconic', title: 'Patient Stories · Q4', priority: 'high', due: 2 * D + 6 * H, clientWaiting: 4 * D + 2 * H,
    plan: [['client_review', 6, 'lucia', 'emi'], ['approved', 4, 'lucia', 'emi'], ['revision', 2, 'lucia', 'emi']],
    titles: ['Maria’s first month', 'Living with it, not around it', 'The pharmacist who called back', 'Three questions for your doctor', 'A normal Tuesday', 'What changed for Dev', 'Back on the trail', 'The side-effect conversation', 'Caregiver’s view', 'One year in', 'Small wins', 'Talk to someone'],
  },
  {
    id: 'sm-october', client: 'scale-media', title: 'In-House Ads · October', priority: 'normal', due: 6 * D + 3 * H,
    plan: [['research', 2, 'noah', 'josh'], ['concept', 3, 'noah', 'josh'], ['writing', 3, 'josh', 'josh']],
    titles: ['Scripts that sell while you sleep', 'The 45-script week', 'Why founders hate ad copy', 'Hook, story, ask', 'Our writers never sleep (literally)', 'One brief, forty videos', 'The follow-the-sun studio', 'What 10,000 scripts taught us'],
  },
  {
    id: 'sp-films', client: 'specular', title: 'Product Films · Series 2', priority: 'normal', due: 19 * D,
    dueBy: { internal_review: 7 * H + 5 * M },
    plan: [['approved', 3, 'kofi', 'josh'], ['internal_review', 1, 'maya', 'josh'], ['internal_review', 3, 'kofi', 'josh'], ['writing', 3, 'kofi', 'josh']],
    titles: ['Light, measured', 'The lens that listens', 'Calibrate everything', 'Inside the reflectance lab', 'One surface, eight readings', 'Specular for small teams', 'Colour you can prove', 'The field kit', 'From lab to line', 'Why accuracy is a feeling'],
  },
  {
    id: 'hl-07', client: 'halberg-law', title: 'Attorney Ad Batch 07', priority: 'high', due: 30 * H,
    plan: [['writing', 4, 'arjun', 'josh'], ['writing', 2, 'ava', 'josh'], ['concept', 3, 'ava', 'josh'], ['internal_review', 3, 'ava', 'josh'], ['revision', 3, 'arjun', 'josh']],
    titles: ['Hurt at work? Read this first', 'The insurance call not to take', 'Your case in 30 seconds', 'No fee unless we win', 'What a settlement really means', 'After the accident', 'Talk to Halberg', 'The first 72 hours', 'Rear-ended, now what', 'Slip, fall, file', 'The statute clock', 'Don’t sign that yet', 'Who pays the bills', 'Real clients, real outcomes', 'Straight answers'],
  },
  {
    id: 'ns-coach', client: 'northshore', title: 'Coach Intro Series', priority: 'urgent', due: 11 * H,
    dueBy: { internal_review: 5 * H + 12 * M },
    plan: [['writing', 2, 'lucia', 'josh'], ['internal_review', 2, 'kofi', 'josh'], ['approved', 2, 'lucia', 'josh']],
    titles: ['Coach Dana, 5:40 a.m.', 'Why we lift slow', 'Your first class', 'The Northshore warm-up', 'Strength is a skill', 'Meet the floor team'],
  },
  {
    id: 've-spring', client: 'verdant', title: 'Spring Catalogue Spots', priority: 'low', due: 26 * D,
    plan: [['research', 4, 'noah', 'emi'], ['concept', 3, 'ava', 'emi'], ['writing', 2, 'ava', 'emi']],
    titles: ['Bring the garden in', 'The linen edit', 'Soft light, long evenings', 'A table for eight', 'Terracotta season', 'The reading chair', 'Balcony gardens', 'Made to be moved', 'Spring, room by room'],
  },
];

const ARCHIVE: ProjectSeed[] = [
  { id: 'sm-sept', client: 'scale-media', title: 'In-House Ads · September', priority: 'normal', due: -5 * D, archivedAgo: 5 * D, plan: [['delivered', 8, 'josh', 'josh']], titles: [] },
  { id: 'hl-06', client: 'halberg-law', title: 'Attorney Ad Batch 06', priority: 'high', due: -12 * D, archivedAgo: 12 * D, plan: [['delivered', 9, 'arjun', 'josh'], ['delivered', 6, 'ava', 'josh']], titles: [] },
  { id: 'ns-wins', client: 'northshore', title: 'Member Wins', priority: 'normal', due: -18 * D, archivedAgo: 18 * D, plan: [['delivered', 6, 'lucia', 'josh']], titles: [] },
  { id: 'ph-hcp', client: 'pharmaconic', title: 'HCP Explainers', priority: 'high', due: -25 * D, archivedAgo: 25 * D, plan: [['delivered', 12, 'lucia', 'emi']], titles: [] },
  { id: 'hl-05', client: 'halberg-law', title: 'Attorney Ad Batch 05', priority: 'normal', due: -33 * D, archivedAgo: 33 * D, plan: [['delivered', 15, 'arjun', 'josh']], titles: [] },
  { id: 'dd-launch', client: 'downtown-dental', title: 'Launch Set', priority: 'high', due: -40 * D, archivedAgo: 40 * D, plan: [['delivered', 10, 'maya', 'josh'], ['delivered', 6, 'kofi', 'josh']], titles: [] },
  { id: 'sp-brand', client: 'specular', title: 'Brand Film', priority: 'urgent', due: -70 * D, archivedAgo: 70 * D, plan: [['delivered', 4, 'maya', 'josh']], titles: [] },
  { id: 've-winter', client: 'verdant', title: 'Winter Collection', priority: 'normal', due: -120 * D, archivedAgo: 120 * D, plan: [['delivered', 10, 'ava', 'emi']], titles: [] },
  { id: 'ph-launch', client: 'pharmaconic', title: 'Launch Campaign', priority: 'urgent', due: -150 * D, archivedAgo: 150 * D, plan: [['delivered', 20, 'lucia', 'emi']], titles: [] },
];

const PROGRESS: Record<ScriptState, number> = {
  research: 0.08, concept: 0.2, writing: 0.45, internal_review: 0.72, revision: 0.62, client_review: 0.88, approved: 0.95, delivered: 1,
};

/** A tiny deterministic PRNG so the same moment always builds the same world. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * `epoch` anchors the deadlines: pass the start of a stable cycle and they
 * count down between refreshes instead of being rebuilt from now each time.
 * Activity and handoffs stay relative to now, since they're replayed anyway.
 */
export function simulatedWorld(at: Date, orgName: string, epoch: Date = at): ControlWorld {
  const now = at.getTime();
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const due = (ms: number) => new Date(epoch.getTime() + ms).toISOString();
  const rand = rng(Math.floor(now / D) * 7919 + 17);

  const writers: CcWriter[] = WRITERS.map((w) => {
    const c = findCity(w.city)!;
    const [first, last] = w.name.split(' ');
    // people were last active during their own working day, unless they're up late
    const hour = localClock(c.timezone, at).hour;
    const [start, end] = w.hours;
    const on = hour >= start && hour < end;
    const sinceEnd = ((((hour - end) % 24) + 24) % 24) * H;
    const lastActive = on || w.nightOwl ? w.activeAgo : sinceEnd + 12 * M;
    return {
      id: w.id, name: w.name, callsign: first.toUpperCase(), initials: `${first[0]}${last[0]}`,
      city: c.name, cityCode: c.code, country: c.country, lat: c.lat, lon: c.lon, timezone: c.timezone,
      role: w.role, status: w.status, workHours: w.hours,
      currentAssignment: null, projectId: null, clientId: null, progress: null, deadline: null, stage: null,
      weeklyOutput: w.weekly, workload: w.workload, lastActivity: iso(-lastActive),
    };
  });

  const clientName = new Map(CLIENTS.map((c) => [c.id, c.name]));
  const projects: CcProject[] = [];
  const scripts: CcScript[] = [];
  let code = 1;
  for (const p of [...ARCHIVE.slice().reverse(), ...LIVE]) {
    const archived = p.archivedAgo != null;
    projects.push({
      id: p.id, title: p.title, clientId: p.client, client: clientName.get(p.client)!, writers: [], stage: 'research',
      progress: { done: 0, total: 0 }, deadline: archived ? iso(p.due) : due(p.due), scripts: [], priority: p.priority, archived,
      completedAt: archived ? iso(-p.archivedAgo!) : null, blocked: null,
      clientWaitingSince: p.clientWaiting ? iso(-p.clientWaiting) : null,
    });
    let n = 0;
    for (const [state, count, writer, reviewer] of p.plan) {
      for (let i = 0; i < count; i++) {
        const title = p.titles[n] ?? `${p.title} · ${String(n + 1).padStart(2, '0')}`;
        const when = archived ? p.due - rand() * 2 * D : (p.dueBy?.[state] ?? p.due) + (p.dueBy?.[state] ? rand() * 40 * M : -rand() * 8 * H);
        const age = archived ? p.archivedAgo! + rand() * 3 * D : state === 'internal_review' ? (0.3 + rand() * 20) * H : (0.2 + rand() * 30) * H;
        scripts.push({
          id: `${p.id}-${n + 1}`, title, code: `VIDEO ${String(code).padStart(3, '0')}`, projectId: p.id,
          writerId: writer, reviewerId: reviewer, state, deadline: archived ? iso(when) : due(when), progress: PROGRESS[state],
          wordCount: state === 'research' ? null : Math.round(140 + rand() * 260), updatedAt: iso(-age),
        });
        n++;
        code++;
      }
    }
  }

  const script = (id: string) => scripts.find((s) => s.id === id)!;
  const handoffs: CcHandoff[] = [
    { id: 'h1', originNode: 'arjun', destinationNode: 'josh', script: 'dd-master-19', label: script('dd-master-19').code, state: 'REVIEW QUEUED', timestamp: iso(-9 * M) },
    { id: 'h2', originNode: 'maya', destinationNode: 'josh', script: 'dd-master-18', label: script('dd-master-18').code, state: 'REVIEW QUEUED', timestamp: iso(-2 * M) },
    { id: 'h3', originNode: 'emi', destinationNode: 'lucia', script: 'ph-patient-11', label: script('ph-patient-11').code, state: 'REVISIONS RETURNED', timestamp: iso(-47 * M) },
    { id: 'h4', originNode: 'lucia', destinationNode: 'emi', script: 'ph-patient-3', label: script('ph-patient-3').code, state: 'EDIT PASS', timestamp: iso(-2 * H - 10 * M) },
    { id: 'h5', originNode: 'noah', destinationNode: 'maya', script: 'sm-october-2', label: script('sm-october-2').code, state: 'RESEARCH DELIVERED', timestamp: iso(-5 * H) },
    { id: 'h6', originNode: 'kofi', destinationNode: 'josh', script: 'ns-coach-3', label: script('ns-coach-3').code, state: 'REVIEW QUEUED', timestamp: iso(-58 * M) },
    { id: 'h7', originNode: 'ava', destinationNode: 'arjun', script: 'hl-07-7', label: script('hl-07-7').code, state: 'DRAFT HANDED OVER', timestamp: iso(-7 * H) },
    { id: 'h8', originNode: 'emi', destinationNode: 'josh', script: 'ph-patient-1', label: script('ph-patient-1').code, state: 'CLIENT PACKAGE READY', timestamp: iso(-3 * H - 20 * M) },
    { id: 'h9', originNode: 'josh', destinationNode: 'arjun', script: 'dd-master-20', label: script('dd-master-20').code, state: 'REVISIONS RETURNED', timestamp: iso(-1 * H - 32 * M) },
    { id: 'h10', originNode: 'kofi', destinationNode: 'maya', script: 'sp-films-4', label: script('sp-films-4').code, state: 'PAIR PASS', timestamp: iso(-4 * H - 15 * M) },
  ];

  const links: CcLink[] = [
    { from: 'maya', to: 'josh', kind: 'review', active: true },
    { from: 'arjun', to: 'josh', kind: 'review', active: true },
    { from: 'kofi', to: 'josh', kind: 'review', active: true },
    { from: 'ava', to: 'josh', kind: 'review', active: true },
    { from: 'lucia', to: 'emi', kind: 'edit', active: true },
    { from: 'emi', to: 'josh', kind: 'review', active: false },
    { from: 'lucia', to: 'josh', kind: 'review', active: false },
    { from: 'noah', to: 'maya', kind: 'research', active: true },
    { from: 'noah', to: 'emi', kind: 'research', active: false },
    { from: 'ava', to: 'arjun', kind: 'collab', active: true },
    { from: 'kofi', to: 'maya', kind: 'collab', active: false },
    { from: 'ava', to: 'emi', kind: 'edit', active: false },
  ];

  const A = (ago: number, actorId: string | null, action: string, subject: string, origin: string | null = null, destination: string | null = null): CcActivity => ({
    id: `a${ago}`, timestamp: iso(-ago), actorId, actor: actorId ? writers.find((w) => w.id === actorId)!.callsign : 'NETWORK',
    action, subject, origin, destination,
  });
  const activity: CcActivity[] = [
    A(2 * M, 'maya', 'MOVED', `${script('dd-master-18').code} → REVIEW`, 'maya', 'josh'),
    A(6 * M, 'arjun', 'STARTED', 'ATTORNEY AD BATCH 07'),
    A(9 * M, 'arjun', 'SENT', `${script('dd-master-19').code} → REVIEW`, 'arjun', 'josh'),
    A(20 * M, 'josh', 'APPROVED', '3 DOWNTOWN DENTAL SCRIPTS'),
    A(41 * M, 'lucia', 'COMPLETED', `REVISION · ${script('ph-patient-9').code}`),
    A(47 * M, 'emi', 'RETURNED', `${script('ph-patient-11').code} → LUCIA`, 'emi', 'lucia'),
    A(58 * M, 'kofi', 'SENT', `2 NORTHSHORE SCRIPTS → REVIEW`, 'kofi', 'josh'),
    A(63 * M, null, 'CLIENT FEEDBACK RECEIVED', 'PHARMACONIC'),
    A(92 * M, 'josh', 'RETURNED', `${script('dd-master-20').code} → ARJUN`, 'josh', 'arjun'),
    A(2 * H + 10 * M, 'lucia', 'HANDED', `${script('ph-patient-3').code} → EMI`, 'lucia', 'emi'),
    A(3 * H + 20 * M, 'emi', 'PACKAGED', 'PHARMACONIC · CLIENT REVIEW', 'emi', 'josh'),
    A(4 * H + 15 * M, 'kofi', 'PAIRED WITH', 'MAYA · SPECULAR', 'kofi', 'maya'),
    A(5 * H, 'noah', 'DELIVERED RESEARCH', 'IN-HOUSE ADS · OCTOBER', 'noah', 'maya'),
    A(7 * H, 'ava', 'HANDED', `${script('hl-07-7').code} → ARJUN`, 'ava', 'arjun'),
    A(9 * H, 'emi', 'SIGNED OFF', 'VERDANT HOME · BRIEF'),
    A(13 * H, 'josh', 'DELIVERED', 'IN-HOUSE ADS · SEPTEMBER'),
  ];

  return finishWorld({
    source: { kind: 'simulated', label: 'SIMULATED NETWORK', unplaced: 0, replayed: true },
    generatedAt: at.toISOString(), orgName, writers, clients: CLIENTS, projects, scripts, activity, handoffs, links,
  }, at);
}
