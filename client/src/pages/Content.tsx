// Content: the month's long-form roadmap, read from its PDF (server/roadmaps.ts). A hero with the next upload's
// countdown and the month's progress, the lineup (a card per video with its six-stage pipeline), the schedule as a
// timeline, the production matrix the PDF has, or a list, who is on each role (managers change them), and the
// playbook. The person on a deliverable, or a manager, ticks it done. Managers upload a PDF (Claude reads it and
// gives each role to someone) and remove a roadmap. Everyone signed in sees it.

import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import {
  AlertTriangle, CalendarRange, Check, CheckCircle2, ChevronRight, Clapperboard, Clock, FileText, Film, LayoutGrid, ListChecks, Pencil, Rocket, Sparkles,
  Trash2, Upload, UserRound, Users,
} from 'lucide-react';
import { api, queryClient, useSave } from '../api';
import type { RoadmapDetail, RoadmapListItem, RoadmapTask, RoadmapVideo } from '../../../shared/types';
import {
  fmtClock, ROADMAP_ROLE_LABEL, ROADMAP_STAGE_LABEL, ROADMAP_STAGES, ROADMAP_STEP_LABEL, ROADMAP_STEPS, STEP_STAGE, taskState,
  type RoadmapOp, type RoadmapStage, type RoadmapTaskState,
} from '../../../shared/roadmap';
import { addDays, diffDays, eachDay, type ISODate } from '../../../shared/dates';
import { isManager } from '../../../shared/workflow';
import { fmtDate, fmtDow, fmtTimeZoneAbbr, fmtWeekday, fmtYearMonth, plural } from '../../../shared/format';
import { PageHeader, useBoot, useUserName } from '../components/Shell';
import { Avatar, Button, Dialog, Empty, ErrorState, FormError, Loading, Panel, Ring, Seg, useToast } from '../components/ui';
import { SOFT, SPRING } from '../motion';
import { burst, confetti } from '../fx';

const STATE_WORDS: Record<RoadmapTaskState, string> = { done: 'Done', overdue: 'Overdue', today: 'Due today', soon: 'Due soon', upcoming: 'Upcoming' };
const STATE_COLOR: Record<RoadmapTaskState, string> = { done: 'var(--mint)', overdue: 'var(--red)', today: 'var(--yellow)', soon: 'var(--cyan)', upcoming: 'var(--neutral)' };
/** each video's colour, by its place in the month */
const HUES = ['var(--lavender)', 'var(--cyan)', 'var(--salmon)', 'var(--mint)', 'var(--pink)', 'var(--yellow)'];
const hueOf = (v: RoadmapVideo | undefined) => HUES[((v?.position ?? 1) - 1) % HUES.length];

const STAGGER = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.05 } } };
const RISE = { hidden: { opacity: 0, y: 18, scale: 0.98 }, show: { opacity: 1, y: 0, scale: 1, transition: SOFT } };

/** Where a roadmap's tasks stand, and what the viewer may do with them. */
function useRoadmap(r: RoadmapDetail) {
  const { me } = useBoot();
  const manager = isManager(me.role);
  return useMemo(() => {
    const state = (t: RoadmapTask) => taskState({ date: t.date, time: t.time, done: !!t.doneAt }, r.now, r.defaultTime);
    const videoOf = new Map(r.videos.map((v) => [v.id, v]));
    const roleOf = new Map(r.roles.map((x) => [x.key, x]));
    const canTick = (t: RoadmapTask) => manager || t.assigneeId === me.id;
    const timeOf = (t: RoadmapTask) => fmtClock(t.time ?? r.defaultTime);
    return { state, videoOf, roleOf, canTick, timeOf, manager };
  }, [r, manager, me.id]);
}
type RM = ReturnType<typeof useRoadmap>;

export function ContentPage() {
  const boot = useBoot();
  const manager = isManager(boot.me.role);
  const { id } = useParams();
  const nav = useNavigate();
  const [importing, setImporting] = useState(false);
  const list = useQuery({ queryKey: ['roadmaps'], queryFn: () => api<{ roadmaps: RoadmapListItem[] }>('/api/roadmaps') });
  const roadmaps = list.data?.roadmaps ?? [];
  // without an id: this month's roadmap, else the next one coming, else the newest
  const thisMonth = boot.clock.today.slice(0, 7);
  const chosen = id ? Number(id) : (roadmaps.find((x) => x.month === thisMonth) ?? [...roadmaps].reverse().find((x) => x.month > thisMonth) ?? roadmaps[0])?.id;
  const detail = useQuery({
    queryKey: ['roadmap', chosen], enabled: !!chosen,
    queryFn: () => api<{ roadmap: RoadmapDetail }>(`/api/roadmaps/${chosen}`),
  });
  const canImport = manager && boot.roadmapImport;
  const upload = canImport ? <Button variant="primary pill lg" icon={<Upload aria-hidden />} onClick={() => setImporting(true)}>Upload roadmap</Button> : null;

  return (
    <div className="cr">
      <PageHeader title="Content" sub="The long-form roadmap: what’s publishing, who owns each step, and when it’s due." hideNewWork>
        {upload}
      </PageHeader>
      {roadmaps.length > 1 && (
        <Seg role="tablist" aria-label="Roadmaps" className="cr-months">
          {roadmaps.map((x) => (
            <button key={x.id} role="tab" aria-selected={x.id === chosen} onClick={() => nav(`/content/${x.id}`)}>
              {fmtYearMonth(x.month)}{roadmaps.filter((y) => y.month === x.month).length > 1 ? ` · ${x.title}` : ''}
            </button>
          ))}
        </Seg>
      )}
      {list.isLoading && <Loading height={480} />}
      {list.isError && <ErrorState error={list.error} retry={() => list.refetch()} />}
      {list.data && !roadmaps.length && (
        <EmptyRoadmap canImport={canImport} manager={manager} onUpload={() => setImporting(true)} />
      )}
      {chosen && detail.isLoading && <Loading height={480} />}
      {chosen && detail.isError && <ErrorState error={detail.error} retry={() => detail.refetch()} />}
      {detail.data && <Roadmap key={detail.data.roadmap.id} r={detail.data.roadmap} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
    </div>
  );
}

function EmptyRoadmap({ canImport, manager, onUpload }: { canImport: boolean; manager: boolean; onUpload: () => void }) {
  return (
    <m.div className="cr-empty" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}>
      <div className="cr-empty-art" aria-hidden>
        {[0, 1, 2, 3].map((i) => <m.span key={i} initial={{ scaleY: 0.2, opacity: 0 }} animate={{ scaleY: 1, opacity: 1 }} transition={{ ...SOFT, delay: 0.1 + i * 0.08 }} style={{ ['--c' as string]: HUES[i] }} />)}
      </div>
      <h2>No roadmap yet</h2>
      <p>{canImport
        ? 'Upload the month’s long-form roadmap as a PDF. It’s read for you: every video, deadline and owner lands here and on the Calendar, with each role given to someone on the team.'
        : manager ? 'Reading a roadmap PDF needs the AI key (ANTHROPIC_API_KEY) on the server.' : 'When a manager uploads the month’s long-form roadmap, every video, deadline and owner shows up here.'}</p>
      {canImport && <Button variant="primary pill lg" icon={<Upload aria-hidden />} onClick={onUpload}>Upload a roadmap PDF</Button>}
    </m.div>
  );
}

// ── the roadmap ──────────────────────────────────────────────────────────

function Roadmap({ r }: { r: RoadmapDetail }) {
  const rm = useRoadmap(r);
  const { me } = useBoot();
  const [params, setParams] = useSearchParams();
  const taskId = Number(params.get('task')) || null;
  const videoId = Number(params.get('video')) || null;
  const open = (k: 'task' | 'video', v: number | null) => {
    const p = new URLSearchParams(params);
    p.delete('task'); p.delete('video');
    if (v) p.set(k, String(v));
    setParams(p, { replace: true });
  };
  const task = r.tasks.find((t) => t.id === taskId) ?? null;
  const video = r.videos.find((v) => v.id === videoId) ?? null;
  const mine = r.tasks.filter((t) => t.assigneeId === me.id);

  return (
    <m.div className="cr-body" variants={STAGGER} initial="hidden" animate="show">
      <Hero r={r} rm={rm} />
      {mine.length > 0 && <Mine r={r} rm={rm} tasks={mine} onOpen={(id) => open('task', id)} />}
      <m.section variants={RISE} aria-labelledby="cr-lineup">
        <div className="cr-h"><h2 id="cr-lineup">The lineup</h2><span>{plural(r.videos.length, 'upload')} · tap one for its brief</span></div>
        <m.div className="cr-lineup" variants={STAGGER}>
          {r.videos.map((v) => <VideoCard key={v.id} v={v} r={r} rm={rm} onOpen={() => open('video', v.id)} />)}
        </m.div>
      </m.section>
      <m.div variants={RISE}><Schedule r={r} rm={rm} onOpen={(id) => open('task', id)} /></m.div>
      <m.div variants={RISE}><Crew r={r} rm={rm} /></m.div>
      <m.div variants={RISE}><Playbook r={r} /></m.div>
      <m.div variants={RISE}><Source r={r} rm={rm} /></m.div>
      {task && <TaskDialog t={task} r={r} rm={rm} onClose={() => open('task', null)} onVideo={(id) => open('video', id)} />}
      {video && <VideoDialog v={video} r={r} rm={rm} onClose={() => open('video', null)} onTask={(id) => open('task', id)} />}
    </m.div>
  );
}

function Hero({ r, rm }: { r: RoadmapDetail; rm: RM }) {
  const done = r.tasks.filter((t) => t.doneAt).length;
  const pct = r.tasks.length ? Math.round((done / r.tasks.length) * 100) : 0;
  const late = r.tasks.filter((t) => rm.state(t) === 'overdue').length;
  const next = r.tasks.filter((t) => t.step === 'publish' && !t.doneAt && t.date >= r.now.date).sort((a, b) => a.date.localeCompare(b.date))[0];
  const nextVideo = next?.videoId ? rm.videoOf.get(next.videoId) : undefined;
  const days = next ? diffDays(next.date, r.now.date) : 0;
  const published = r.tasks.filter((t) => t.step === 'publish' && t.doneAt).length;
  return (
    <m.section className="cr-hero" variants={RISE} aria-label={`${fmtYearMonth(r.month)} roadmap`}>
      <div className="cr-hero-glow" aria-hidden />
      <div className="cr-hero-main">
        <span className="cr-eyebrow"><Clapperboard aria-hidden />{r.brand ?? 'Long-form'} · long-form roadmap</span>
        <h2 className="cr-month">{fmtYearMonth(r.month)}</h2>
        {r.summary && <p className="cr-summary">{r.summary}</p>}
        <div className="cr-facts">
          <span><Film aria-hidden />{plural(r.videos.length, 'upload')}</span>
          <span><ListChecks aria-hidden />{plural(r.tasks.length, 'deliverable')}</span>
          <span><Users aria-hidden />{plural(r.roles.filter((x) => x.userId).length, 'person', 'people')} on it</span>
          {late > 0 && <span className="late"><AlertTriangle aria-hidden />{late} overdue</span>}
        </div>
      </div>
      <div className="cr-hero-side">
        {next ? (
          <div className="cr-next">
            <span className="k">Next upload</span>
            <span className="cr-count"><b>{days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days}</b>{days > 1 && <i>days</i>}</span>
            <span className="t">{nextVideo?.title ?? next.title}</span>
            <span className="w">{fmtWeekday(next.date)} · {rm.timeOf(next)} {fmtTimeZoneAbbr(r.timezone)}</span>
          </div>
        ) : (
          <div className="cr-next"><span className="k">Month</span><span className="cr-count"><b>{published}</b><i>published</i></span><span className="t">Every upload in this roadmap is out.</span></div>
        )}
        <Ring pct={pct} size={112} stroke={9} color="var(--mint)" large>
          <span className="cr-ring"><b>{pct}%</b><small>{done}/{r.tasks.length} done</small></span>
        </Ring>
      </div>
    </m.section>
  );
}

/** The viewer's own deliverables still to do, soonest first, with a link to all of them. */
function Mine({ r, rm, tasks, onOpen }: { r: RoadmapDetail; rm: RM; tasks: RoadmapTask[]; onOpen: (id: number) => void }) {
  const open = tasks.filter((t) => !t.doneAt);
  const roles = [...new Set(tasks.map((t) => rm.roleOf.get(t.role)?.label ?? ROADMAP_ROLE_LABEL[t.role]))];
  return (
    <m.section className="cr-mine" variants={RISE} aria-labelledby="cr-mine">
      <div className="cr-h">
        <h2 id="cr-mine"><UserRound aria-hidden />Yours</h2>
        <span>{roles.join(' · ')} · {open.length ? `${plural(open.length, 'deliverable')} to go` : 'all done'}</span>
      </div>
      {open.length ? (
        <div className="cr-mine-row">
          {open.slice(0, 4).map((t) => <TaskRow key={t.id} t={t} r={r} rm={rm} onOpen={() => onOpen(t.id)} card />)}
        </div>
      ) : <p className="muted">Everything you own on this roadmap is ticked off. Nice work.</p>}
    </m.section>
  );
}

// ── the lineup ───────────────────────────────────────────────────────────

/** A video's six stages: done, late, the one it's on, still to come, or none in this roadmap. */
function stagesOf(v: RoadmapVideo, r: RoadmapDetail, rm: RM): { stage: RoadmapStage; s: 'done' | 'late' | 'now' | 'todo' | 'none' }[] {
  const tasks = r.tasks.filter((t) => t.videoId === v.id);
  let current = false;
  return ROADMAP_STAGES.map((stage) => {
    const list = tasks.filter((t) => STEP_STAGE[t.step] === stage);
    if (!list.length) return { stage, s: 'none' as const };
    if (list.every((t) => t.doneAt)) return { stage, s: 'done' as const };
    if (list.some((t) => rm.state(t) === 'overdue')) { current = true; return { stage, s: 'late' as const }; }
    if (!current) { current = true; return { stage, s: 'now' as const }; }
    return { stage, s: 'todo' as const };
  });
}

function ThumbArt({ v, big }: { v: RoadmapVideo; big?: boolean }) {
  return (
    <div className={`cr-thumb${big ? ' big' : ''}`} style={{ ['--c' as string]: hueOf(v) }}>
      <span className="cr-thumb-grain" aria-hidden />
      <b>{v.thumbnailText ?? v.title}</b>
      {v.tag && <span className="cr-thumb-tag">{v.tag}</span>}
    </div>
  );
}

function VideoCard({ v, r, rm, onOpen }: { v: RoadmapVideo; r: RoadmapDetail; rm: RM; onOpen: () => void }) {
  const name = useUserName();
  const tasks = r.tasks.filter((t) => t.videoId === v.id);
  const next = tasks.find((t) => !t.doneAt);
  const nextState = next ? rm.state(next) : null;
  const live = tasks.some((t) => t.step === 'publish' && t.doneAt);
  const done = tasks.filter((t) => t.doneAt).length;
  return (
    <m.button type="button" className={`cr-card${live ? ' live' : ''}`} variants={RISE} whileHover={{ y: -4 }} whileTap={{ scale: 0.985 }} transition={SPRING}
      onClick={onOpen} style={{ ['--c' as string]: hueOf(v) }} aria-label={`Week ${v.position}: ${v.title}, publishing ${fmtWeekday(v.publishDate)}. Open its brief.`}>
      <ThumbArt v={v} />
      <div className="cr-card-top">
        <span className="cr-week">Week {v.position}</span>
        {live ? <span className="cr-live"><Rocket aria-hidden />Live</span> : v.tag && <span className="cr-tag">{v.tag}</span>}
      </div>
      <div className="cr-card-date">
        <b>{fmtDate(v.publishDate).replace(/,.*$/, '')}</b>
        <span>{fmtDow(v.publishDate)}{v.publishTime ? ` · ${fmtClock(v.publishTime)}` : ''}</span>
      </div>
      <h3>{v.title}</h3>
      <p className="cr-card-meta">{[v.format, v.runtime].filter(Boolean).join(' · ')}</p>
      <div className="cr-pipe" aria-label={`${done} of ${tasks.length} deliverables done`}>
        {stagesOf(v, r, rm).map(({ stage, s }) => (
          <span key={stage} className={`p s-${s}`} title={`${ROADMAP_STAGE_LABEL[stage]}: ${s === 'none' ? 'not in this roadmap' : s === 'now' ? 'in progress' : s}`}>
            <i /><small>{ROADMAP_STAGE_LABEL[stage]}</small>
          </span>
        ))}
      </div>
      <div className="cr-card-next">
        {next ? (
          <>
            <span className="d" style={{ ['--s' as string]: STATE_COLOR[nextState!] }} aria-hidden />
            <span className="ellipsis"><b>{next.title}</b> · {nextState === 'overdue' ? 'overdue' : fmtDate(next.date, r.now.date)}</span>
            {next.assigneeId && <Avatar name={name(next.assigneeId)} id={next.assigneeId} small />}
          </>
        ) : <><CheckCircle2 aria-hidden /><span>Everything done</span></>}
      </div>
    </m.button>
  );
}

// ── one deliverable ──────────────────────────────────────────────────────

/** Ticks a deliverable done or not; a refusal shows as a toast. */
function useTick(r: RoadmapDetail) {
  const toast = useToast();
  const save = useSave((v: { id: number; done: boolean; at?: { x: number; y: number } }) => api<{ roadmap: RoadmapDetail }>(`/api/roadmap-tasks/${v.id}/done`, { body: { done: v.done } }), {
    onSuccess: (res, v) => {
      queryClient.setQueryData(['roadmap', r.id], res);
      if (v.done && v.at) burst(v.at.x, v.at.y);
      if (!v.done) toast('Marked not done');
    },
  });
  return { ...save, mutate: (v: { id: number; done: boolean; at?: { x: number; y: number } }) => save.mutate(v, { onError: (e) => toast(e.message, 'error') }) };
}

function Tick({ t, r, rm }: { t: RoadmapTask; r: RoadmapDetail; rm: RM }) {
  const tick = useTick(r);
  const allowed = rm.canTick(t);
  const done = !!t.doneAt;
  return (
    <button type="button" className={`cr-tick${done ? ' on' : ''}`} disabled={!allowed || tick.isPending} aria-pressed={done}
      aria-label={`${done ? 'Done' : 'Mark done'}: ${t.title}`} title={allowed ? undefined : 'Only the person on it, or a manager, can tick this'}
      onClick={(e) => { e.stopPropagation(); const b = e.currentTarget.getBoundingClientRect(); tick.mutate({ id: t.id, done: !done, at: { x: b.left + b.width / 2, y: b.top + b.height / 2 } }); }}>
      <AnimatePresence initial={false}>{done && <m.span key="c" initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} exit={{ scale: 0 }} transition={SPRING}><Check aria-hidden /></m.span>}</AnimatePresence>
    </button>
  );
}

function TaskRow({ t, r, rm, onOpen, card, showVideo = true }: { t: RoadmapTask; r: RoadmapDetail; rm: RM; onOpen: () => void; card?: boolean; showVideo?: boolean }) {
  const name = useUserName();
  const st = rm.state(t);
  const v = t.videoId ? rm.videoOf.get(t.videoId) : undefined;
  const role = rm.roleOf.get(t.role);
  return (
    <m.div layout="position" transition={SOFT} className={`cr-task ${st}${card ? ' card' : ''}`} style={{ ['--c' as string]: hueOf(v), ['--s' as string]: STATE_COLOR[st] }}>
      <Tick t={t} r={r} rm={rm} />
      <button type="button" className="cr-task-main" onClick={onOpen}>
        <span className="t">{t.title}{t.step === 'publish' && <Rocket aria-hidden />}</span>
        <span className="s">{showVideo && v ? <><i className="vd" aria-hidden />{v.title}</> : role?.label ?? ROADMAP_ROLE_LABEL[t.role]}</span>
      </button>
      <span className="cr-task-when">
        <b>{card ? fmtDate(t.date, r.now.date) : rm.timeOf(t)}</b>
        <small style={{ color: STATE_COLOR[st] }}>{st === 'upcoming' ? (card ? rm.timeOf(t) : '') : STATE_WORDS[st]}</small>
      </span>
      <span className="cr-task-who" title={t.assigneeId ? `${name(t.assigneeId)} · ${role?.label ?? ''}` : `${role?.label ?? ROADMAP_ROLE_LABEL[t.role]} · nobody yet`}>
        {t.assigneeId ? <Avatar name={name(t.assigneeId)} id={t.assigneeId} small /> : <span className="avatar sm nobody" aria-hidden>?</span>}
      </span>
    </m.div>
  );
}

function TaskDialog({ t, r, rm, onClose, onVideo }: { t: RoadmapTask; r: RoadmapDetail; rm: RM; onClose: () => void; onVideo: (id: number) => void }) {
  const name = useUserName();
  const tick = useTick(r);
  const st = rm.state(t);
  const v = t.videoId ? rm.videoOf.get(t.videoId) : undefined;
  const role = rm.roleOf.get(t.role);
  const [editing, setEditing] = useState(false);
  if (editing) return <TaskEdit t={t} r={r} onDone={() => setEditing(false)} onGone={onClose} />;
  return (
    <Dialog open onClose={onClose} size="narrow" title={t.title} sub={v ? `Week ${v.position} · ${v.title}` : r.title}
      footer={<div className="form-actions">
        {rm.manager && <Button variant="ghost" icon={<Pencil aria-hidden />} onClick={() => setEditing(true)} className="left">Change</Button>}
        {v && <Button variant="ghost" icon={<ChevronRight aria-hidden />} onClick={() => onVideo(v.id)}>Open the video’s brief</Button>}
        {rm.canTick(t) && <Button variant={t.doneAt ? '' : 'primary pill'} busy={tick.isPending} icon={t.doneAt ? undefined : <Check aria-hidden />}
          onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); tick.mutate({ id: t.id, done: !t.doneAt, at: { x: b.left + b.width / 2, y: b.top } }); }}>
          {t.doneAt ? 'Mark not done' : 'Mark done'}
        </Button>}
      </div>}>
      <div className="cr-facts-list">
        <div><span>Due</span><b>{fmtWeekday(t.date)} · {rm.timeOf(t)} {fmtTimeZoneAbbr(r.timezone)}</b></div>
        <div><span>Status</span><b style={{ color: STATE_COLOR[st] }}>{STATE_WORDS[st]}{t.doneAt && t.doneByName ? ` · by ${t.doneByName}` : ''}</b></div>
        <div><span>Owner</span><b className="who">{t.assigneeId ? <><Avatar name={name(t.assigneeId)} id={t.assigneeId} small />{name(t.assigneeId)}</> : 'Nobody yet'}<small>{role?.label ?? ROADMAP_ROLE_LABEL[t.role]}</small></b></div>
        {role?.responsibility && <div><span>Their part</span><b className="plain">{role.responsibility}</b></div>}
      </div>
      {!rm.canTick(t) && <p className="muted" style={{ fontSize: 13 }}>The person on it, or a manager, ticks it off.</p>}
    </Dialog>
  );
}

/** A manager changes one deliverable by hand: its day, time and who it's for, or removes it. Only what changed is sent. */
function TaskEdit({ t, r, onDone, onGone }: { t: RoadmapTask; r: RoadmapDetail; onDone: () => void; onGone: () => void }) {
  const { users } = useBoot();
  const name = useUserName();
  const toast = useToast();
  const roleUser = r.roles.find((x) => x.key === t.role)?.userId ?? null;
  const [date, setDate] = useState(t.date);
  const [time, setTime] = useState(t.time ?? '');
  const [who, setWho] = useState(t.ownAssignee && t.assigneeId ? String(t.assigneeId) : '');
  const change = useSave((ops: RoadmapOp[]) => api<{ roadmap: RoadmapDetail; lines: string[] }>(`/api/roadmaps/${r.id}/changes`, { body: { ops } }), {
    onSuccess: (res, ops) => {
      queryClient.setQueryData(['roadmap', r.id], { roadmap: res.roadmap });
      toast(res.lines[0] ?? 'Saved');
      if (ops[0]?.op === 'remove_task') onGone(); else onDone();
    },
  });
  const save = () => {
    const op: Extract<RoadmapOp, { op: 'update_task' }> = { op: 'update_task', taskId: t.id };
    if (date !== t.date) op.date = date;
    if ((time || null) !== (t.time ?? null)) op.time = time || null;
    const nextWho = who ? Number(who) : null;
    if (nextWho !== (t.ownAssignee ? t.assigneeId : null)) op.assigneeId = nextWho;
    if (Object.keys(op).length === 2) { onDone(); return; }
    change.mutate([op]);
  };
  return (
    <Dialog open onClose={onDone} size="narrow" title={`Change “${t.title}”`} sub="Only this deliverable changes."
      footer={<div className="form-actions">
        <Button variant="danger" icon={<Trash2 aria-hidden />} className="left" busy={change.isPending}
          onClick={() => { if (window.confirm(`Remove “${t.title}” from the roadmap?`)) change.mutate([{ op: 'remove_task', taskId: t.id }]); }}>Remove</Button>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button variant="primary pill" busy={change.isPending} disabled={!date} onClick={save}>Save</Button>
      </div>}>
      <div className="form">
        <FormError error={change.error} />
        <div className="row-flex s3" style={{ flexWrap: 'wrap' }}>
          <label className="field" style={{ flex: 1, minWidth: 150 }}><span>Due</span><input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="field" style={{ flex: 1, minWidth: 130 }}><span>Time</span><input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: -6 }}>No time: {fmtClock(r.defaultTime)}, the roadmap’s usual deadline.</p>
        <label className="field"><span>Who it’s for</span>
          <select className="select" value={who} onChange={(e) => setWho(e.target.value)}>
            <option value="">{`The ${ROADMAP_ROLE_LABEL[t.role].toLowerCase()} (${roleUser ? name(roleUser) : 'nobody yet'})`}</option>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

// ── a video's brief ──────────────────────────────────────────────────────

function VideoDialog({ v, r, rm, onClose, onTask }: { v: RoadmapVideo; r: RoadmapDetail; rm: RM; onClose: () => void; onTask: (id: number) => void }) {
  const tasks = r.tasks.filter((t) => t.videoId === v.id);
  return (
    <Dialog open onClose={onClose} size="wide" title={v.title} sub={`Week ${v.position} · publishes ${fmtWeekday(v.publishDate)}${v.publishTime ? ` at ${fmtClock(v.publishTime)} ${fmtTimeZoneAbbr(r.timezone)}` : ''}`}>
      <div className="cr-brief" style={{ ['--c' as string]: hueOf(v) }}>
        <div className="cr-brief-side">
          <ThumbArt v={v} big />
          {v.thumbnailConcept && <p className="cr-small"><b>Thumbnail.</b> {v.thumbnailConcept}</p>}
          <div className="cr-chips">{[v.tag, v.format, v.runtime].filter(Boolean).map((x) => <span key={x} className="chip">{x}</span>)}</div>
          <div className="cr-pipe wide">
            {stagesOf(v, r, rm).map(({ stage, s }) => <span key={stage} className={`p s-${s}`}><i /><small>{ROADMAP_STAGE_LABEL[stage]}</small></span>)}
          </div>
        </div>
        <div className="cr-brief-main">
          {v.idea && <section><h4>The idea</h4><p>{v.idea}</p></section>}
          {v.why && <section><h4>Why owners would watch</h4><p>{v.why}</p></section>}
          {v.beats.length > 0 && (
            <section>
              <h4>What happens in the video</h4>
              <ol className="cr-beats">
                {v.beats.map((b, i) => (
                  <m.li key={i} initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ ...SOFT, delay: 0.05 * i }}>
                    <span className="n">{i + 1}</span><span><b>{b.title}.</b> {b.body}</span>
                  </m.li>
                ))}
              </ol>
            </section>
          )}
          {v.prep && <section><h4>Before filming</h4><p>{v.prep}</p></section>}
          <section>
            <h4>Deliverables</h4>
            <div className="cr-tasks">{tasks.map((t) => <TaskRow key={t.id} t={t} r={r} rm={rm} onOpen={() => onTask(t.id)} showVideo={false} card />)}</div>
          </section>
        </div>
      </div>
    </Dialog>
  );
}

// ── the schedule ─────────────────────────────────────────────────────────

type View = 'timeline' | 'matrix' | 'list';

function Schedule({ r, rm, onOpen }: { r: RoadmapDetail; rm: RM; onOpen: (id: number) => void }) {
  const { me } = useBoot();
  const [view, setView] = useState<View>(() => (window.matchMedia('(max-width: 760px)').matches ? 'list' : 'timeline'));
  const [onlyMine, setOnlyMine] = useState(false);
  const hasMine = r.tasks.some((t) => t.assigneeId === me.id);
  const tasks = onlyMine ? r.tasks.filter((t) => t.assigneeId === me.id) : r.tasks;
  return (
    <Panel className="cr-schedule" title="Schedule" sub={`All times ${fmtTimeZoneAbbr(r.timezone)} · deadlines ${fmtClock(r.defaultTime)} unless shown`}
      tools={<>
        {hasMine && (
          <Seg role="group" aria-label="Whose deliverables">
            <button aria-pressed={!onlyMine} onClick={() => setOnlyMine(false)}>Everyone</button>
            <button aria-pressed={onlyMine} onClick={() => setOnlyMine(true)}>Mine</button>
          </Seg>
        )}
        <Seg role="group" aria-label="Schedule view">
          <button aria-pressed={view === 'timeline'} onClick={() => setView('timeline')}><CalendarRange aria-hidden />Timeline</button>
          <button aria-pressed={view === 'matrix'} onClick={() => setView('matrix')}><LayoutGrid aria-hidden />By week</button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}><ListChecks aria-hidden />List</button>
        </Seg>
      </>}>
      <AnimatePresence mode="wait" initial={false}>
        <m.div key={view} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.22, ease: [0.23, 1, 0.32, 1] }}>
          {view === 'timeline' && <Timeline r={r} rm={rm} tasks={tasks} onOpen={onOpen} />}
          {view === 'matrix' && <Matrix r={r} rm={rm} tasks={tasks} onOpen={onOpen} />}
          {view === 'list' && <Agenda r={r} rm={rm} tasks={tasks} onOpen={onOpen} />}
        </m.div>
      </AnimatePresence>
      <div className="cr-legend" aria-hidden>
        {(['done', 'overdue', 'today', 'soon', 'upcoming'] as RoadmapTaskState[]).map((s) => <span key={s}><i style={{ background: STATE_COLOR[s] }} />{STATE_WORDS[s]}</span>)}
      </div>
    </Panel>
  );
}

/** A lane per video across the days, a mark on each deliverable's day, and a line at today. */
function Timeline({ r, rm, tasks, onOpen }: { r: RoadmapDetail; rm: RM; tasks: RoadmapTask[]; onOpen: (id: number) => void }) {
  const scroller = useRef<HTMLDivElement>(null);
  const from = r.tasks.reduce((a, t) => (t.date < a ? t.date : a), r.tasks[0]?.date ?? r.now.date);
  const to = r.tasks.reduce((a, t) => (t.date > a ? t.date : a), from);
  const days = eachDay(addDays(from, -1), addDays(to, 1));
  const col = (d: ISODate) => diffDays(d, days[0]) + 2;
  const todayIn = r.now.date >= days[0] && r.now.date <= days[days.length - 1];
  // start scrolled to a few days before today
  useEffect(() => {
    const el = scroller.current;
    if (!el || !todayIn) return;
    const cell = el.querySelector<HTMLElement>('.cr-tl-day.today');
    if (cell) el.scrollLeft = Math.max(0, cell.offsetLeft - 220 - cell.offsetWidth * 3);
  }, [todayIn]);
  const lanes = [...r.videos.map((v) => ({ key: `v${v.id}`, v, label: v.title, list: tasks.filter((t) => t.videoId === v.id) })),
    ...(tasks.some((t) => !t.videoId) ? [{ key: 'other', v: undefined, label: 'Other', list: tasks.filter((t) => !t.videoId) }] : [])];
  const style = { gridTemplateColumns: `minmax(170px, 220px) repeat(${days.length}, minmax(34px, 1fr))` } as CSSProperties;
  return (
    <div className="cr-tl-scroll" ref={scroller}>
      <div className="cr-tl" style={style} role="table" aria-label="Timeline of deliverables">
        <div className="cr-tl-corner" role="columnheader">Video</div>
        {days.map((d, i) => (
          <div key={d} role="columnheader" className={`cr-tl-day${d === r.now.date ? ' today' : ''}${[0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) ? ' wkend' : ''}`} style={{ gridColumn: i + 2 }}>
            {(i === 0 || d.endsWith('-01') || d === r.now.date) && <span className="mo">{fmtDate(d).replace(/\s\d+.*$/, '')}</span>}
            <small>{fmtDow(d).slice(0, 1)}</small><b>{Number(d.slice(8))}</b>
          </div>
        ))}
        {lanes.map((lane, li) => {
          const first = lane.list[0]?.date;
          const pub = lane.v?.publishDate ?? lane.list[lane.list.length - 1]?.date;
          const byDay = new Map<string, RoadmapTask[]>();
          for (const t of lane.list) byDay.set(t.date, [...(byDay.get(t.date) ?? []), t]);
          return (
            <div key={lane.key} className="cr-tl-lane" role="row" style={{ ['--c' as string]: hueOf(lane.v), gridRow: li + 2 }}>
              <div className="cr-tl-name" role="rowheader"><i aria-hidden />{lane.v && <small>Wk {lane.v.position}</small>}<span className="ellipsis">{lane.label}</span></div>
              {days.map((d, i) => <div key={d} className={`cr-tl-cell${d === r.now.date ? ' today' : ''}${[0, 6].includes(new Date(d + 'T00:00:00Z').getUTCDay()) ? ' wkend' : ''}`} style={{ gridColumn: i + 2, gridRow: li + 2 }} />)}
              {first && pub && (
                <m.span className="cr-tl-bar" style={{ gridColumn: `${col(first)} / ${col(pub) + 1}`, gridRow: li + 2 }}
                  initial={{ scaleX: 0 }} animate={{ scaleX: 1 }} transition={{ ...SOFT, delay: 0.1 + li * 0.08 }} aria-hidden />
              )}
              {[...byDay.entries()].map(([d, list]) => (
                <div key={d} className="cr-tl-marks" style={{ gridColumn: col(d), gridRow: li + 2 }}>
                  {list.map((t, k) => {
                    const st = rm.state(t);
                    return (
                      <m.button key={t.id} type="button" className={`cr-tl-dot ${st}${t.step === 'publish' ? ' pub' : ''}`} style={{ ['--s' as string]: STATE_COLOR[st] }}
                        initial={{ scale: 0 }} animate={{ scale: 1 }} transition={{ ...SPRING, delay: 0.25 + li * 0.08 + k * 0.03 }} whileHover={{ scale: 1.25 }}
                        onClick={() => onOpen(t.id)} title={`${t.title} · ${fmtWeekday(t.date)} ${rm.timeOf(t)} · ${STATE_WORDS[st]}`}
                        aria-label={`${t.title}, ${lane.label}, ${fmtWeekday(t.date)} ${rm.timeOf(t)}, ${STATE_WORDS[st]}`}>
                        {t.step === 'publish' ? <Rocket aria-hidden /> : t.doneAt ? <Check aria-hidden /> : null}
                      </m.button>
                    );
                  })}
                </div>
              ))}
            </div>
          );
        })}
        {todayIn && <m.span className="cr-tl-now" style={{ gridColumn: col(r.now.date), gridRow: `1 / ${lanes.length + 2}` }} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.5 }} aria-hidden><i>Today</i></m.span>}
      </div>
    </div>
  );
}

/** The PDF's production calendar: a row per kind of deliverable, a column per video. */
function Matrix({ r, rm, tasks, onOpen }: { r: RoadmapDetail; rm: RM; tasks: RoadmapTask[]; onOpen: (id: number) => void }) {
  const steps = ROADMAP_STEPS.filter((s) => tasks.some((t) => t.step === s));
  return (
    <div className="cr-mx-scroll">
      <table className="cr-mx">
        <thead>
          <tr>
            <th scope="col">Milestone</th>
            {r.videos.map((v) => (
              <th key={v.id} scope="col" style={{ ['--c' as string]: hueOf(v) }}>
                <span className="wk">Week {v.position}{v.tag ? ` · ${v.tag}` : ''}</span>
                <span className="vt ellipsis" title={v.title}>{v.title}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s} className={s === 'publish' ? 'pub' : ''}>
              <th scope="row">{ROADMAP_STEP_LABEL[s]}</th>
              {r.videos.map((v) => {
                const list = tasks.filter((t) => t.videoId === v.id && t.step === s);
                return (
                  <td key={v.id}>
                    {list.map((t) => {
                      const st = rm.state(t);
                      return (
                        <button key={t.id} type="button" className={`cr-mx-cell ${st}`} style={{ ['--s' as string]: STATE_COLOR[st] }} onClick={() => onOpen(t.id)}
                          aria-label={`${t.title}, week ${v.position}: ${fmtWeekday(t.date)} ${rm.timeOf(t)}, ${STATE_WORDS[st]}`}>
                          <i aria-hidden />
                          <span><b>{fmtDow(t.date)} {fmtDate(t.date).replace(/,.*$/, '')}</b>{(t.time || s === 'publish') && <small>{rm.timeOf(t)}</small>}</span>
                          {list.length > 1 && <small className="sub">{t.title}</small>}
                        </button>
                      );
                    })}
                    {!list.length && <span className="muted">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Every deliverable by day, from today on (earlier days folded). */
function Agenda({ r, rm, tasks, onOpen }: { r: RoadmapDetail; rm: RM; tasks: RoadmapTask[]; onOpen: (id: number) => void }) {
  const [past, setPast] = useState(false);
  const days = [...new Set(tasks.map((t) => t.date))].sort();
  const earlier = days.filter((d) => d < r.now.date);
  const shown = past ? days : days.filter((d) => d >= r.now.date || tasks.some((t) => t.date === d && rm.state(t) === 'overdue'));
  const hidden = days.length - shown.length;
  return (
    <div className="cr-agenda">
      {hidden > 0 && <button type="button" className="cr-more" onClick={() => setPast(true)}>Show {plural(hidden, 'earlier day')} (all done)</button>}
      {past && earlier.length > 0 && <button type="button" className="cr-more" onClick={() => setPast(false)}>Hide earlier days</button>}
      {!shown.length && <Empty title="Nothing left to do" boxed>Every deliverable here is done.</Empty>}
      {shown.map((d) => (
        <div key={d} className={`cr-day${d === r.now.date ? ' today' : ''}`}>
          <div className="cr-day-h"><b>{fmtWeekday(d)}</b>{d === r.now.date && <span>Today</span>}</div>
          <div className="cr-tasks">{tasks.filter((t) => t.date === d).map((t) => <TaskRow key={t.id} t={t} r={r} rm={rm} onOpen={() => onOpen(t.id)} />)}</div>
        </div>
      ))}
    </div>
  );
}

// ── who's on it ──────────────────────────────────────────────────────────

function Crew({ r, rm }: { r: RoadmapDetail; rm: RM }) {
  const { users } = useBoot();
  const name = useUserName();
  const toast = useToast();
  const assign = useSave((v: { key: string; userId: number | null }) => api<{ roadmap: RoadmapDetail }>(`/api/roadmaps/${r.id}/roles/${v.key}`, { method: 'PATCH', body: { userId: v.userId } }), {
    onSuccess: (res, v) => {
      queryClient.setQueryData(['roadmap', r.id], res);
      toast(v.userId ? `${name(v.userId)} has it now, and has been told` : 'Nobody is on it now');
    },
  });
  const people = users.filter((u) => u.active);
  return (
    <Panel title="Who’s on it" sub={rm.manager ? 'Each role was matched to someone on the team. Change anyone here; their deliverables move with them.' : 'Who owns each stage this month.'}>
      <m.div className="cr-crew" variants={STAGGER} initial="hidden" animate="show">
        {r.roles.map((x) => {
          const list = r.tasks.filter((t) => t.role === x.key);
          const done = list.filter((t) => t.doneAt).length;
          const late = list.filter((t) => rm.state(t) === 'overdue').length;
          return (
            <m.div key={x.key} className={`cr-role${x.userId ? '' : ' open'}`} variants={RISE}>
              <div className="cr-role-top">
                {x.userId ? <Avatar name={name(x.userId)} id={x.userId} /> : <span className="avatar nobody" aria-hidden>?</span>}
                <div style={{ minWidth: 0 }}>
                  <span className="k">{x.label}{x.label !== ROADMAP_ROLE_LABEL[x.key] ? ` · ${ROADMAP_ROLE_LABEL[x.key]}` : ''}</span>
                  <b className="ellipsis">{x.userId ? name(x.userId) : 'Nobody yet'}</b>
                </div>
              </div>
              {x.responsibility && <p>{x.responsibility}</p>}
              <div className="cr-role-bar" aria-label={`${done} of ${list.length} done`}><m.i initial={{ width: 0 }} animate={{ width: `${list.length ? (done / list.length) * 100 : 0}%` }} transition={SOFT} /></div>
              <div className="cr-role-foot">
                <span>{done}/{list.length} done{late ? <b className="late"> · {late} overdue</b> : ''}</span>
                {rm.manager && (
                  <select className="select sm" value={x.userId ?? ''} aria-label={`Who is the ${x.label}`} disabled={assign.isPending}
                    onChange={(e) => assign.mutate({ key: x.key, userId: e.target.value ? Number(e.target.value) : null }, { onError: (err) => toast(err.message, 'error') })}>
                    <option value="">Nobody yet</option>
                    {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                )}
              </div>
            </m.div>
          );
        })}
      </m.div>
    </Panel>
  );
}

// ── the playbook ─────────────────────────────────────────────────────────

function Playbook({ r }: { r: RoadmapDetail }) {
  const x = r.extras;
  if (!x.workflow.length && !x.checklist.length && !x.contingency.length && !x.notes.length && !x.standardTimes) return null;
  return (
    <Panel title="Playbook" sub="How the month runs, from the PDF.">
      <div className="cr-play">
        {x.workflow.length > 0 && (
          <section className="cr-flow">
            <h4><Clock aria-hidden />Weekly workflow</h4>
            <ol>{x.workflow.map((w, i) => <li key={i}><span className="n">{i + 1}</span><div><b>{w.when}</b><p>{w.what}</p></div></li>)}</ol>
          </section>
        )}
        <div className="cr-play-side">
          {x.standardTimes && <section><h4><Clock aria-hidden />Standard times</h4><p>{x.standardTimes}</p></section>}
          {x.checklist.length > 0 && <section><h4><ListChecks aria-hidden />Before scheduling</h4><ul className="cr-checks">{x.checklist.map((c, i) => <li key={i}><CheckCircle2 aria-hidden />{c}</li>)}</ul></section>}
          {x.contingency.length > 0 && <section><h4><AlertTriangle aria-hidden />If something slips</h4><ul>{x.contingency.map((c, i) => <li key={i}>{c}</li>)}</ul></section>}
          {x.notes.length > 0 && <section><h4><Sparkles aria-hidden />Notes</h4><ul>{x.notes.map((c, i) => <li key={i}>{c}</li>)}</ul></section>}
        </div>
      </div>
    </Panel>
  );
}

function Source({ r, rm }: { r: RoadmapDetail; rm: RM }) {
  const nav = useNavigate();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const remove = useSave(() => api(`/api/roadmaps/${r.id}`, { method: 'DELETE' }), {
    onSuccess: () => {
      setConfirm(false);
      toast('Roadmap removed');
      nav('/content');
    },
  });
  return (
    <div className="cr-source">
      <FileText aria-hidden />
      <span>Read from <b>{r.sourceName ?? 'a PDF'}</b>{r.createdByName ? ` by ${r.createdByName}` : ''} · {fmtDate(r.createdAt.slice(0, 10))}</span>
      {rm.manager && <Button variant="ghost sm" icon={<Trash2 aria-hidden />} onClick={() => setConfirm(true)}>Remove roadmap</Button>}
      <Dialog open={confirm} onClose={() => setConfirm(false)} size="narrow" title="Remove this roadmap?" sub={r.title}
        footer={<div className="form-actions"><Button variant="ghost" onClick={() => setConfirm(false)}>Keep it</Button><Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(undefined)}>Remove</Button></div>}>
        <FormError error={remove.error} />
        <p style={{ fontSize: 14 }}>Its videos and deliverables leave the Content tab and the Calendar for everyone. Upload the PDF again to bring it back.</p>
      </Dialog>
    </div>
  );
}

// ── uploading a PDF ──────────────────────────────────────────────────────

const READING = ['Opening the PDF', 'Finding each video', 'Reading every deadline', 'Working out who owns what', 'Matching roles to your team', 'Laying out the schedule'];

function ImportDialog({ onClose }: { onClose: () => void }) {
  const { uploadLimitMb } = useBoot();
  const nav = useNavigate();
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [markPast, setMarkPast] = useState(true);
  const [over, setOver] = useState(false);
  const [step, setStep] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const read = useSave((f: File) => {
    const form = new FormData();
    form.append('markPast', markPast ? '1' : '0');
    form.append('file', f);
    return api<{ roadmap: RoadmapDetail }>('/api/roadmaps/import', { form });
  }, {
    onSuccess: (res) => {
      queryClient.setQueryData(['roadmap', res.roadmap.id], res);
      confetti();
      toast(`${fmtYearMonth(res.roadmap.month)} roadmap is live: ${plural(res.roadmap.videos.length, 'video')}, ${plural(res.roadmap.tasks.length, 'deliverable')}`);
      onClose();
      nav(`/content/${res.roadmap.id}`);
    },
  });
  useEffect(() => {
    if (!read.isPending) { setStep(0); return; }
    const t = setInterval(() => setStep((s) => Math.min(s + 1, READING.length - 1)), 2600);
    return () => clearInterval(t);
  }, [read.isPending]);
  const pick = (f: File | undefined | null) => { if (f) { setFile(f); read.reset(); } };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files[0]); };
  const tooBig = !!file && file.size > Math.min(uploadLimitMb, 30) * 1024 * 1024;
  const fileError = read.error?.fields?.file;
  return (
    <Dialog open onClose={() => { if (!read.isPending) onClose(); }} title="Upload a roadmap" sub="The month’s long-form roadmap as a PDF. It’s read for you and laid out as a schedule."
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose} disabled={read.isPending}>Cancel</Button>
        <Button variant="primary pill" icon={<Sparkles aria-hidden />} busy={read.isPending} disabled={!file || tooBig} onClick={() => file && read.mutate(file)}>{read.isPending ? 'Reading…' : 'Read roadmap'}</Button>
      </div>}>
      <AnimatePresence mode="wait" initial={false}>
        {read.isPending ? (
          <m.div key="reading" className="cr-reading" initial={{ opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={SOFT} role="status" aria-live="polite">
            <div className="cr-reading-doc" aria-hidden><span /><span /><span /><span /><i /></div>
            <ol>
              {READING.map((w, i) => (
                <li key={w} className={i < step ? 'done' : i === step ? 'now' : ''}>{i < step ? <Check aria-hidden /> : <span className="d" aria-hidden />}{w}</li>
              ))}
            </ol>
            <p className="muted">This takes up to a minute. Keep this open.</p>
          </m.div>
        ) : (
          <m.div key="pick" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="stack s3">
            <FormError error={read.error && !fileError ? read.error : null} />
            <button type="button" className={`cr-drop${over ? ' over' : ''}${file ? ' has' : ''}`} onClick={() => input.current?.click()}
              onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}>
              {file ? <FileText aria-hidden /> : <Upload aria-hidden />}
              <b>{file ? file.name : 'Drop the PDF here, or choose it'}</b>
              <span>{file ? `${(file.size / 1024 / 1024).toFixed(1)} MB · choose another` : 'Videos, deadlines and owners are read from it'}</span>
            </button>
            <input ref={input} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => pick(e.target.files?.[0])} />
            {(fileError || tooBig) && <p className="field-error" role="alert">{tooBig ? 'PDFs can be up to 30 MB' : fileError}</p>}
            <label className="check"><input type="checkbox" checked={markPast} onChange={(e) => setMarkPast(e.target.checked)} />Mark deliverables dated before today as done</label>
            <p className="muted" style={{ fontSize: 12.5 }}>Each role (writer, thumbnail designer, editor…) is given to someone on the team: the person the PDF names, else whoever has the least on. You can change anyone after.</p>
          </m.div>
        )}
      </AnimatePresence>
    </Dialog>
  );
}

