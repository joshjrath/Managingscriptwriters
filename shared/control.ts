// Control Center: the world model and everything derived from it.
//
// A ControlWorld is one snapshot of the operation: writers placed on Earth,
// clients, projects, scripts, recent activity and handoffs. The server builds
// it from a source (the simulated network, or the real workspace), so the
// visual system never knows where the data came from. Everything that depends
// on the clock (local times, the sun, who's on shift, coverage, anomalies) is
// computed here from real time, never stored.

// ── model ────────────────────────────────────────────────────────────────

export type NodeStatus = 'active' | 'deep_work' | 'reviewing' | 'away' | 'offline';
export type NodeRole = 'lead' | 'reviewer' | 'editor' | 'writer' | 'researcher';

export const SCRIPT_STATES = ['research', 'concept', 'writing', 'internal_review', 'revision', 'client_review', 'approved', 'delivered'] as const;
export type ScriptState = (typeof SCRIPT_STATES)[number];

export const STATE_LABEL: Record<ScriptState, string> = {
  research: 'RESEARCH', concept: 'CONCEPT', writing: 'WRITING', internal_review: 'INTERNAL REVIEW',
  revision: 'REVISION', client_review: 'CLIENT REVIEW', approved: 'APPROVED', delivered: 'DELIVERED',
};

export const STATUS_LABEL: Record<NodeStatus, string> = {
  active: 'ACTIVE', deep_work: 'DEEP WORK', reviewing: 'REVIEWING', away: 'AWAY', offline: 'OFFLINE',
};

export const ROLE_LABEL: Record<NodeRole, string> = {
  lead: 'NETWORK LEAD', reviewer: 'REVIEWER', editor: 'EDITOR', writer: 'WRITER', researcher: 'RESEARCHER',
};

/** A project's journey, as drawn on its orbit. */
export const PHASES = ['RESEARCH', 'WRITING', 'REVIEW', 'REVISION', 'CLIENT', 'DELIVERY'] as const;
/** approved work is on its way out, so it sits in DELIVERY with what's already delivered */
export const phaseOf = (s: ScriptState): number =>
  s === 'research' || s === 'concept' ? 0 : s === 'writing' ? 1 : s === 'internal_review' ? 2 : s === 'revision' ? 3 : s === 'client_review' ? 4 : 5;

export interface Fraction { done: number; total: number }

export interface CcWriter {
  id: string;
  name: string;
  /** first name, uppercase: JOSH */
  callsign: string;
  initials: string;
  city: string;
  /** three letters: TOR */
  cityCode: string;
  country: string;
  lat: number;
  lon: number;
  /** IANA zone; every clock is computed from it */
  timezone: string;
  role: NodeRole;
  /** what they're doing when on shift; the clock decides whether they are */
  status: NodeStatus;
  /** local working hours, e.g. [9, 18] (end may pass midnight: [20, 28]) */
  workHours: [number, number];
  currentAssignment: string | null;
  projectId: string | null;
  clientId: string | null;
  progress: Fraction | null;
  deadline: string | null;
  stage: ScriptState | null;
  weeklyOutput: number;
  /** 1 = a full load */
  workload: number;
  lastActivity: string | null;
}

export interface CcClient {
  id: string;
  name: string;
}

export type Priority = 'low' | 'normal' | 'high' | 'urgent';

export interface CcProject {
  id: string;
  title: string;
  clientId: string;
  client: string;
  writers: string[];
  stage: ScriptState;
  progress: Fraction;
  deadline: string | null;
  scripts: string[];
  priority: Priority;
  /** finished work, drifting into the archive */
  archived: boolean;
  completedAt: string | null;
  /** production is held up, with why */
  blocked: string | null;
  /** how long it has been waiting on the client, when it is */
  clientWaitingSince: string | null;
}

export interface CcScript {
  id: string;
  title: string;
  /** "VIDEO 024" */
  code: string;
  projectId: string;
  writerId: string | null;
  reviewerId: string | null;
  state: ScriptState;
  deadline: string | null;
  /** 0–1 */
  progress: number;
  wordCount: number | null;
  updatedAt: string;
}

export interface CcActivity {
  id: string;
  timestamp: string;
  actorId: string | null;
  actor: string;
  action: string;
  subject: string;
  origin: string | null;
  destination: string | null;
}

export interface CcHandoff {
  id: string;
  originNode: string;
  destinationNode: string;
  script: string | null;
  /** what arrives: VIDEO 024 */
  label: string;
  /** what it becomes: REVIEW QUEUED */
  state: string;
  timestamp: string;
}

export type LinkKind = 'review' | 'edit' | 'research' | 'collab';

export interface CcLink {
  from: string;
  to: string;
  kind: LinkKind;
  /** something is moving along it right now */
  active: boolean;
}

export interface ControlSource {
  kind: 'simulated' | 'workspace';
  /** SIMULATED NETWORK / LIVE WORKSPACE */
  label: string;
  /** team members who have no city yet, so aren't on the globe */
  unplaced: number;
  /** handoffs are replayed from a scripted sequence rather than observed */
  replayed: boolean;
}

export interface ControlWorld {
  version: string;
  source: ControlSource;
  generatedAt: string;
  orgName: string;
  writers: CcWriter[];
  clients: CcClient[];
  projects: CcProject[];
  scripts: CcScript[];
  activity: CcActivity[];
  handoffs: CcHandoff[];
  links: CcLink[];
}

export interface ControlStatus {
  signedIn: boolean;
  /** a signed-in admin or manager: only they can be cleared */
  eligible: boolean;
  cleared: boolean;
  clearedUntil: string | null;
  operator: { name: string; callsign: string } | null;
  demo: boolean;
}

export const CONTROL_VERSION = 'CC.01';

// ── time ─────────────────────────────────────────────────────────────────

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

const partsCache = new Map<string, Intl.DateTimeFormat>();
function fmtFor(tz: string): Intl.DateTimeFormat {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsCache.set(tz, f);
  }
  return f;
}

export interface LocalClock {
  /** fractional hour of day, 0–24 */
  hour: number;
  /** "01:24:18" */
  time: string;
  /** "01:24" */
  short: string;
  /** "WED 30 SEP" */
  date: string;
  /** minutes east of UTC */
  offset: number;
  /** "UTC−04:00" */
  offsetLabel: string;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export function localClock(tz: string, at: Date): LocalClock {
  const parts = fmtFor(tz).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const [y, mo, d, h, mi, s] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map((k) => Number(get(k)));
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  const offset = Math.round((asUtc - Math.floor(at.getTime() / 1000) * 1000) / MINUTE);
  const p2 = (n: number) => String(n).padStart(2, '0');
  const sign = offset < 0 ? '−' : '+';
  const abs = Math.abs(offset);
  return {
    hour: h + mi / 60 + s / 3600,
    time: `${p2(h)}:${p2(mi)}:${p2(s)}`,
    short: `${p2(h)}:${p2(mi)}`,
    date: `${get('weekday').toUpperCase()} ${p2(d)} ${MONTHS[mo - 1]}`,
    offset,
    offsetLabel: `UTC${sign}${p2(Math.floor(abs / 60))}:${p2(abs % 60)}`,
  };
}

export function utcClock(at: Date): string {
  return at.toISOString().slice(11, 19);
}

/** "04H 36M", "2D 06H", "00H 00M". Negative durations read as the time since. */
export function fmtCountdown(ms: number): string {
  const a = Math.abs(ms);
  const p2 = (n: number) => String(n).padStart(2, '0');
  if (a >= 2 * DAY) return `${Math.floor(a / DAY)}D ${p2(Math.floor((a % DAY) / HOUR))}H`;
  return `${p2(Math.floor(a / HOUR))}H ${p2(Math.floor((a % HOUR) / MINUTE))}M`;
}

/** "4S AGO", "12M AGO", "3H AGO", "2D AGO" */
export function fmtAgo(ms: number): string {
  const a = Math.max(0, ms);
  if (a < MINUTE) return `${Math.floor(a / 1000)}S AGO`;
  if (a < HOUR) return `${Math.floor(a / MINUTE)}M AGO`;
  if (a < DAY) return `${Math.floor(a / HOUR)}H AGO`;
  return `${Math.floor(a / DAY)}D AGO`;
}

// ── the sun ──────────────────────────────────────────────────────────────

const RAD = Math.PI / 180;

/**
 * Where the sun is directly overhead (degrees), from the standard low-precision
 * solar position (good to about a tenth of a degree, plenty for a terminator).
 */
export function subsolarPoint(at: Date): { lat: number; lon: number } {
  const n = at.getTime() / DAY - 10957.5; // days since J2000.0
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = ((357.528 + 0.9856003 * n) % 360) * RAD;
  const lambda = (L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const eps = (23.439 - 0.0000004 * n) * RAD;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda));
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  let lon = ra / RAD - gmst;
  lon = ((((lon + 180) % 360) + 360) % 360) - 180;
  return { lat: dec / RAD, lon };
}

/** Sine of the sun's elevation at a place: > 0 is day, < 0 night, ~0 dawn or dusk. */
export function sunHeight(lat: number, lon: number, at: Date): number {
  const s = subsolarPoint(at);
  const a = lat * RAD, b = s.lat * RAD;
  return Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos((lon - s.lon) * RAD);
}

// ── presence: who is on shift ────────────────────────────────────────────

/** on shift · waking (the hour before) · late (off shift but still working) · off */
export type Phase = 'on' | 'waking' | 'late' | 'off';

export interface Presence {
  phase: Phase;
  /** what the node shows: its status while on shift or working late, otherwise offline */
  status: NodeStatus;
  clock: LocalClock;
  /** sine of the sun's elevation over the city */
  sun: number;
  /** ms until the shift starts (0 while on shift) */
  untilStart: number;
  /** ms until the shift ends (0 while off shift) */
  untilEnd: number;
}

const inWindow = (hour: number, [start, end]: [number, number]) => {
  const h = ((hour % 24) + 24) % 24;
  if (end <= 24) return h >= start && h < end;
  return h >= start || h < end - 24;
};
const hoursUntil = (from: number, to: number) => ((((to - from) % 24) + 24) % 24);

export function presenceOf(w: Pick<CcWriter, 'timezone' | 'workHours' | 'status' | 'lastActivity' | 'lat' | 'lon'>, at: Date): Presence {
  const clock = localClock(w.timezone, at);
  const on = inWindow(clock.hour, w.workHours);
  const recent = w.lastActivity ? at.getTime() - new Date(w.lastActivity).getTime() < 75 * MINUTE : false;
  const untilStart = on ? 0 : hoursUntil(clock.hour, w.workHours[0]) * HOUR;
  const untilEnd = on ? hoursUntil(clock.hour, w.workHours[1] % 24) * HOUR || DAY : 0;
  const phase: Phase = on ? 'on' : recent ? 'late' : untilStart <= HOUR ? 'waking' : 'off';
  const status: NodeStatus = w.status === 'offline' ? 'offline' : phase === 'on' || phase === 'late' ? w.status : 'offline';
  return { phase, status, clock, sun: sunHeight(w.lat, w.lon, at), untilStart, untilEnd };
}

// ── follow the sun: coverage across a UTC day ────────────────────────────

export const SLOT_MIN = 5;
export const SLOTS = (24 * 60) / SLOT_MIN;

export interface Coverage {
  /** on-shift writers in each 5-minute slot of the UTC day */
  slots: number[];
  /** each writer's shift in UTC hours; end may exceed 24 */
  windows: { writerId: string; start: number; end: number }[];
  coveredMinutes: number;
  /** writers on shift right now */
  overlapNow: number;
  gaps: { start: number; end: number }[];
  nextOnline: { writerId: string; in: number } | null;
  /** the next shift that ends while work is in flight */
  nextHandoff: { writerId: string; in: number } | null;
}

export function coverageOf(writers: CcWriter[], at: Date): Coverage {
  const slots = new Array<number>(SLOTS).fill(0);
  const windows: Coverage['windows'] = [];
  let nextOnline: Coverage['nextOnline'] = null;
  let nextHandoff: Coverage['nextHandoff'] = null;
  let overlapNow = 0;
  for (const w of writers) {
    if (w.status === 'offline') continue;
    const clock = localClock(w.timezone, at);
    const start = ((((w.workHours[0] - clock.offset / 60) % 24) + 24) % 24);
    const end = start + (w.workHours[1] - w.workHours[0]);
    windows.push({ writerId: w.id, start, end });
    for (let s = Math.round(start * 60 / SLOT_MIN); s < Math.round(end * 60 / SLOT_MIN); s++) slots[s % SLOTS]++;
    const p = presenceOf(w, at);
    if (p.phase === 'on') {
      overlapNow++;
      if (!nextHandoff || p.untilEnd < nextHandoff.in) nextHandoff = { writerId: w.id, in: p.untilEnd };
    } else if (!nextOnline || p.untilStart < nextOnline.in) nextOnline = { writerId: w.id, in: p.untilStart };
  }
  const gaps: Coverage['gaps'] = [];
  const zero = slots.map((n) => n === 0);
  if (zero.some((z) => !z) && zero.some(Boolean)) {
    // walk from a covered slot so a gap across midnight stays one gap
    const first = zero.findIndex((z) => !z);
    let open: number | null = null;
    for (let i = 1; i <= SLOTS; i++) {
      const idx = (first + i) % SLOTS;
      if (zero[idx] && open === null) open = first + i;
      if (!zero[idx] && open !== null) {
        gaps.push({ start: ((open * SLOT_MIN) / 60) % 24, end: ((open * SLOT_MIN) / 60) % 24 + ((first + i - open) * SLOT_MIN) / 60 });
        open = null;
      }
    }
  } else if (zero.every(Boolean)) gaps.push({ start: 0, end: 24 });
  return { slots, windows, coveredMinutes: slots.filter((n) => n > 0).length * SLOT_MIN, overlapNow, gaps, nextOnline, nextHandoff };
}

export function fmtHoursMinutes(minutes: number): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${p2(Math.floor(minutes / 60))}H ${p2(Math.round(minutes % 60))}M`;
}

// ── deadlines as orbits ──────────────────────────────────────────────────

export const BANDS = ['24H', '48H', '7D', '30D'] as const;
export type Band = (typeof BANDS)[number] | 'OVERDUE' | 'LATER';
const BAND_HOURS: [Band, number][] = [['24H', 24], ['48H', 48], ['7D', 168], ['30D', 720]];

/** Which orbit a deadline sits on, and how far along the band it is (0 inner edge → 1 outer). */
export function bandOf(deadline: string | null, at: Date): { band: Band; hours: number; t: number } {
  if (!deadline) return { band: 'LATER', hours: Infinity, t: 1 };
  const hours = (new Date(deadline).getTime() - at.getTime()) / HOUR;
  if (hours < 0) return { band: 'OVERDUE', hours, t: 0 };
  let lo = 0;
  for (const [band, hi] of BAND_HOURS) {
    if (hours <= hi) return { band, hours, t: (hours - lo) / (hi - lo) };
    lo = hi;
  }
  return { band: 'LATER', hours, t: 1 };
}

// ── pressure: anomalies ──────────────────────────────────────────────────

export type AnomalyKind =
  | 'deadline_collision' | 'overload' | 'revision_pileup' | 'review_wait'
  | 'client_block' | 'blocked' | 'coverage_gap' | 'off_hours_handoff' | 'review_convergence';

export interface Anomaly {
  id: string;
  kind: AnomalyKind;
  /** REVIEW COLLISION */
  title: string;
  /** label / value pairs: [3, 'DELIVERABLES'], ['00H 38M', 'ARRIVAL WINDOW'] */
  lines: { value: string; label: string }[];
  /** 0–1 */
  severity: number;
  /** the node it disturbs, when it's about a person */
  writerId: string | null;
  projectId: string | null;
  /** where it sits when it isn't about a person (coverage gaps) */
  at: { lat: number; lon: number } | null;
  /** writers whose trajectories feed into it */
  sources: string[];
}

const OPEN: ScriptState[] = ['research', 'concept', 'writing', 'internal_review', 'revision', 'client_review'];
export const isOpen = (s: ScriptState) => OPEN.includes(s);
export const inMotion = (s: ScriptState) => s !== 'delivered';

export function anomaliesOf(world: ControlWorld, at: Date): Anomaly[] {
  const out: Anomaly[] = [];
  const now = at.getTime();
  const byWriter = new Map(world.writers.map((w) => [w.id, w]));
  const live = world.scripts.filter((s) => inMotion(s.state) && !world.projects.find((p) => p.id === s.projectId)?.archived);

  // deadlines converging on one person: three or more deliverables due within the same three hours, in the next two days
  for (const w of world.writers) {
    const mine = live
      .filter((s) => s.deadline && (s.writerId === w.id || (s.reviewerId === w.id && (s.state === 'internal_review' || s.state === 'approved'))))
      .map((s) => ({ s, t: new Date(s.deadline!).getTime() }))
      .filter((x) => x.t > now && x.t - now < 48 * HOUR)
      .sort((a, b) => a.t - b.t);
    // a deliverable is one project's work; many scripts of the same batch due together is just a batch
    const projectsIn = (g: typeof mine) => new Set(g.map((x) => x.s.projectId)).size;
    let best: typeof mine = [];
    for (let i = 0; i < mine.length; i++) {
      const group = mine.filter((x) => x.t >= mine[i].t && x.t - mine[i].t <= 3 * HOUR);
      if (projectsIn(group) > projectsIn(best)) best = group;
    }
    const deliverables = projectsIn(best);
    if (deliverables >= 3) {
      const reviewing = best.some((x) => x.s.reviewerId === w.id);
      out.push({
        id: `collision:${w.id}`, kind: 'deadline_collision', title: reviewing ? 'REVIEW COLLISION' : 'DEADLINE COLLISION',
        lines: [
          { value: String(deliverables).padStart(2, '0'), label: 'DELIVERABLES' },
          { value: fmtCountdown(best[0].t - now), label: 'ARRIVAL WINDOW' },
        ],
        severity: Math.min(1, deliverables / 5 + (best[0].t - now < 12 * HOUR ? 0.3 : 0)),
        writerId: w.id, projectId: null, at: null,
        sources: [...new Set(best.map((x) => (x.s.writerId === w.id ? x.s.reviewerId : x.s.writerId)).filter((id): id is string => !!id && id !== w.id))],
      });
    }
  }

  // carrying too much
  for (const w of world.writers) {
    if (w.workload <= 1.2) continue;
    const mine = live.filter((s) => s.writerId === w.id && isOpen(s.state));
    const soon = mine.filter((s) => s.deadline && new Date(s.deadline).getTime() - now < 12 * HOUR && new Date(s.deadline).getTime() > now);
    out.push({
      id: `overload:${w.id}`, kind: 'overload', title: 'NETWORK LOAD',
      lines: [
        { value: `${Math.round(w.workload * 100)}%`, label: 'CAPACITY' },
        { value: String(mine.length).padStart(2, '0'), label: 'ACTIVE ITEMS' },
        { value: String(soon.length).padStart(2, '0'), label: 'DEADLINES WITHIN 12H' },
      ],
      severity: Math.min(1, (w.workload - 1) / 0.8), writerId: w.id, projectId: null, at: null, sources: [],
    });
  }

  // revisions piling up on one writer
  for (const w of world.writers) {
    const back = live.filter((s) => s.writerId === w.id && s.state === 'revision');
    if (back.length < 3) continue;
    out.push({
      id: `revisions:${w.id}`, kind: 'revision_pileup', title: 'REVISION PILEUP',
      lines: [{ value: String(back.length).padStart(2, '0'), label: 'SCRIPTS RETURNED' }],
      severity: Math.min(1, back.length / 6), writerId: w.id, projectId: null, at: null,
      sources: [...new Set(back.map((s) => s.reviewerId).filter((id): id is string => !!id))],
    });
  }

  // scripts waiting on internal review too long, and too many landing on one reviewer
  const waiting = new Map<string, CcScript[]>();
  for (const s of live) if (s.state === 'internal_review' && s.reviewerId) waiting.set(s.reviewerId, [...(waiting.get(s.reviewerId) ?? []), s]);
  for (const [rid, list] of waiting) {
    if (!byWriter.has(rid)) continue;
    const stale = list.filter((s) => now - new Date(s.updatedAt).getTime() > 48 * HOUR);
    if (stale.length) {
      const oldest = Math.max(...stale.map((s) => now - new Date(s.updatedAt).getTime()));
      out.push({
        id: `wait:${rid}`, kind: 'review_wait', title: 'REVIEW STALLED',
        lines: [{ value: String(stale.length).padStart(2, '0'), label: stale.length === 1 ? 'SCRIPT WAITING' : 'SCRIPTS WAITING' }, { value: fmtCountdown(oldest), label: 'LONGEST WAIT' }],
        severity: Math.min(1, oldest / (6 * DAY)), writerId: rid, projectId: null, at: null,
        sources: [...new Set(stale.map((s) => s.writerId).filter((id): id is string => !!id))],
      });
    }
    if (list.length >= 8) {
      out.push({
        id: `converge:${rid}`, kind: 'review_convergence', title: 'REVIEW CONVERGENCE',
        lines: [{ value: String(list.length).padStart(2, '0'), label: 'ITEMS INBOUND' }, { value: String(new Set(list.map((s) => s.writerId)).size).padStart(2, '0'), label: 'SOURCES' }],
        severity: Math.min(1, list.length / 16), writerId: rid, projectId: null, at: null,
        sources: [...new Set(list.map((s) => s.writerId).filter((id): id is string => !!id))],
      });
    }
  }

  // projects held up by the client, or blocked outright
  for (const p of world.projects) {
    if (p.archived) continue;
    const lead = p.writers.find((id) => byWriter.has(id)) ?? null;
    if (p.blocked) {
      out.push({
        id: `blocked:${p.id}`, kind: 'blocked', title: 'PRODUCTION BLOCKED',
        lines: [{ value: p.client.toUpperCase(), label: 'CLIENT' }, { value: p.blocked.toUpperCase().slice(0, 80), label: 'REASON' }],
        severity: 0.8, writerId: lead, projectId: p.id, at: null, sources: p.writers.filter((id) => byWriter.has(id)),
      });
    } else if (p.clientWaitingSince && now - new Date(p.clientWaitingSince).getTime() > 3 * DAY) {
      const blockedScripts = world.scripts.filter((s) => s.projectId === p.id && s.state === 'client_review').length;
      out.push({
        id: `client:${p.id}`, kind: 'client_block', title: 'CLIENT APPROVAL BLOCKING',
        lines: [{ value: fmtCountdown(now - new Date(p.clientWaitingSince).getTime()), label: 'WAITING' }, { value: String(blockedScripts).padStart(2, '0'), label: 'SCRIPTS HELD' }],
        severity: 0.55, writerId: lead, projectId: p.id, at: null, sources: p.writers.filter((id) => byWriter.has(id)),
      });
    }
  }

  // nobody on shift
  const cov = coverageOf(world.writers, at);
  for (const g of cov.gaps) {
    if (g.end - g.start >= 24) continue;
    const mid = (g.start + g.end) / 2;
    const midDate = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) + mid * HOUR);
    // pin it where it's midday during the gap: the part of the world nobody is covering
    const sun = subsolarPoint(midDate);
    out.push({
      id: `gap:${g.start.toFixed(2)}`, kind: 'coverage_gap', title: 'COVERAGE GAP',
      lines: [{ value: fmtHoursMinutes((g.end - g.start) * 60), label: 'NO NODES ON SHIFT' }, { value: `${fmtUtcHour(g.start)}–${fmtUtcHour(g.end)}`, label: 'UTC WINDOW' }],
      severity: Math.min(1, (g.end - g.start) / 6), writerId: null, projectId: null, at: { lat: 0, lon: sun.lon }, sources: [],
    });
  }

  // work landing on someone after hours (the most recent one; it's a pattern worth one flag, not a list)
  for (const h of [...world.handoffs].sort((a, b) => b.timestamp.localeCompare(a.timestamp))) {
    const dest = byWriter.get(h.destinationNode);
    if (!dest || now - new Date(h.timestamp).getTime() > 12 * HOUR) continue;
    const when = new Date(h.timestamp);
    const local = localClock(dest.timezone, when);
    if (inWindow(local.hour, dest.workHours)) continue;
    out.push({
      id: `offhours:${dest.id}`, kind: 'off_hours_handoff', title: 'HANDOFF OUTSIDE HOURS',
      lines: [{ value: `${local.short} LOCAL`, label: 'LANDED' }, { value: h.label, label: 'PACKET' }],
      severity: 0.35, writerId: dest.id, projectId: null, at: null, sources: [h.originNode],
    });
    break;
  }

  return out.sort((a, b) => b.severity - a.severity);
}

const fmtUtcHour = (h: number) => {
  const m = Math.round((((h % 24) + 24) % 24) * 60);
  return `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};

// ── headline numbers ─────────────────────────────────────────────────────

export interface WorldMetrics {
  nodes: number;
  onShift: number;
  scriptsInMotion: number;
  reviewsPending: number;
  clientQueue: number;
  activeProjects: number;
  handoffChannels: number;
  coveredMinutes: number;
}

export function metricsOf(world: ControlWorld, at: Date): WorldMetrics {
  const cov = coverageOf(world.writers, at);
  const liveProjects = world.projects.filter((p) => !p.archived);
  const liveIds = new Set(liveProjects.map((p) => p.id));
  const live = world.scripts.filter((s) => liveIds.has(s.projectId));
  return {
    nodes: world.writers.length,
    onShift: world.writers.filter((w) => { const p = presenceOf(w, at); return p.phase === 'on' || p.phase === 'late'; }).length,
    scriptsInMotion: live.filter((s) => s.state !== 'delivered' && s.state !== 'approved').length,
    reviewsPending: live.filter((s) => s.state === 'internal_review').length,
    clientQueue: liveProjects.filter((p) => p.stage === 'client_review').length,
    activeProjects: liveProjects.length,
    handoffChannels: world.links.filter((l) => l.active).length,
    coveredMinutes: cov.coveredMinutes,
  };
}

/** The least advanced state across a set of scripts (a project is only as far along as its slowest script). */
export function stageOf(states: ScriptState[]): ScriptState {
  if (!states.length) return 'research';
  let min = SCRIPT_STATES.length - 1;
  for (const s of states) min = Math.min(min, SCRIPT_STATES.indexOf(s));
  return SCRIPT_STATES[min];
}

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export const callsignOf = (name: string) => (name.trim().split(/\s+/)[0] ?? name).toUpperCase();
