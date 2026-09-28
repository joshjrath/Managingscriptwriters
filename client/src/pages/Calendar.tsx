// Calendar: writing periods, draft deadlines, final delivery deadlines and
// shoot dates, each with its own colour, icon and label. Click an event to
// open its batch. Managers can drag a shoot to another day (or click it and
// choose "Change dates"); a preview shows everything that moves with it
// before anything changes. Month grid on desktop, agenda list on phones.

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { AlertTriangle, ArrowRight, CalendarClock, Camera, Check, ChevronLeft, ChevronRight, FileText, GripVertical, PenLine, Send } from 'lucide-react';
import { api, qs } from '../api';
import type { CalendarEvent } from '../../../shared/types';
import { addDays, addMonths, diffDays, eachDay, startOfMonth, startOfWeek, type ISODate } from '../../../shared/dates';
import { isManager } from '../../../shared/workflow';
import { fmtMonth, fmtWeekday, fmtDate, fmtRange } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Dialog, Empty, ErrorState, Loading, Seg } from '../components/ui';
import { SOFT } from '../motion';
import { RescheduleDialog } from './BatchDetail';
import { DAY_COUNTS, DaysTimeline, type DayCount } from '../components/DaysTimeline';

const TYPE = {
  writing: { label: 'Writing', icon: PenLine, c: 'var(--cyan)' },
  draft: { label: 'Drafts due', icon: FileText, c: 'var(--lavender)' },
  final: { label: 'Final → Timeliner', icon: Send, c: 'var(--yellow)' },
  shoot: { label: 'Shoot', icon: Camera, c: 'var(--salmon)' },
} as const;

/** A shoot being moved: where it is now, and (when dragged) where it's going. */
interface Move { shootId: number; start: ISODate; end: ISODate | null; toStart?: ISODate; toEnd?: ISODate | null }

export function CalendarPage() {
  const { clock, users, clients, me } = useBoot();
  const manager = isManager(me.role);
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('m') && /^\d{4}-\d{2}$/.test(params.get('m')!) ? `${params.get('m')}-01` : startOfMonth(clock.today);
  const writerId = params.get('writerId') ?? '';
  const clientId = params.get('clientId') ?? '';
  const phone = window.matchMedia('(max-width: 760px)').matches;
  const view = (['days', 'month', 'list'] as const).find((v) => v === params.get('view')) ?? (phone ? 'list' : 'month');
  const n = (DAY_COUNTS.find((c) => String(c) === params.get('days')) ?? (phone ? 3 : 7)) as DayCount;
  // months slide in from the side you're heading towards
  const lastMonth = useRef(month);
  const dir = month > lastMonth.current ? 1 : month < lastMonth.current ? -1 : 0;
  lastMonth.current = month;
  const [hidden, setHidden] = useState<Set<CalendarEvent['type']>>(new Set());
  const [drag, setDrag] = useState<{ e: CalendarEvent; offset: number; over: ISODate | null } | null>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [picked, setPicked] = useState<CalendarEvent | null>(null);
  const gridStart = startOfWeek(month);
  const gridEnd = addDays(startOfWeek(addDays(addMonths(month, 1), -1)), 6);
  const q = useQuery({
    queryKey: ['calendar', gridStart, gridEnd, writerId, clientId],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: gridStart, to: gridEnd, writerId, clientId })}`),
    enabled: view !== 'days',
  });
  const setP = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const setView = (v: 'days' | 'month' | 'list') => setP('view', v);
  const events = (q.data?.events ?? []).filter((e) => !hidden.has(e.type));
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const order = { shoot: 0, final: 1, draft: 2, writing: 3 };
    for (const e of events) for (const d of eachDay(e.start > gridStart ? e.start : gridStart, e.end < gridEnd ? e.end : gridEnd)) map.set(d, [...(map.get(d) ?? []), e]);
    for (const list of map.values()) list.sort((a, b) => order[a.type] - order[b.type]);
    return map;
  }, [events, gridStart, gridEnd]);
  const days = eachDay(gridStart, gridEnd);

  const canMove = (e: CalendarEvent) => manager && e.type === 'shoot' && e.shootId != null;
  const open = (e: CalendarEvent) => {
    if (canMove(e)) setPicked(e);
    else if (e.batchId) nav(`/batches/${e.batchId}`);
    else if (e.shootId) nav('/production');
  };
  const moveOf = (e: CalendarEvent, toStart?: ISODate): Move => {
    const len = diffDays(e.end, e.start);
    return { shootId: e.shootId!, start: e.start, end: len ? e.end : null, toStart, toEnd: toStart && len ? addDays(toStart, len) : null };
  };

  // where the dragged shoot would land, or is waiting to be confirmed
  const landing = drag?.over
    ? { from: addDays(drag.over, -drag.offset), len: diffDays(drag.e.end, drag.e.start) }
    : move?.toStart ? { from: move.toStart, len: move.toEnd ? diffDays(move.toEnd, move.toStart) : 0 } : null;
  const isLanding = (d: ISODate) => !!landing && d >= landing.from && d <= addDays(landing.from, landing.len);
  const onOver = (x: DragEvent, d: ISODate) => {
    if (!drag) return;
    x.preventDefault();
    x.dataTransfer.dropEffect = 'move';
    if (drag.over !== d) setDrag({ ...drag, over: d });
  };
  const onDrop = (x: DragEvent, d: ISODate) => {
    if (!drag) return;
    x.preventDefault();
    const to = addDays(d, -drag.offset);
    const e = drag.e;
    setDrag(null);
    if (to !== e.start) setMove(moveOf(e, to));
  };

  const ev = (e: CalendarEvent, day: ISODate, detail = false) => {
    const T = TYPE[e.type];
    const Icon = e.overdue && e.type !== 'writing' ? AlertTriangle : e.complete && e.type !== 'writing' ? Check : T.icon;
    const showLabel = e.type !== 'writing' || day === e.start || new Date(day + 'T00:00:00Z').getUTCDay() === 1;
    const status = e.overdue ? ' (overdue)' : e.complete ? ' (complete)' : '';
    const k = diffDays(day, e.start);
    const movable = canMove(e);
    return (
      // each day of a shoot keeps its identity, so a moved shoot glides to its new days
      <m.div key={`${e.id}:${k}`} className="ev-wrap" layout="position" layoutId={e.type === 'shoot' ? `ev-${e.id}-${k}` : undefined} transition={SOFT}>
        <button
          className={`ev ${e.type}${showLabel ? '' : ' cont'}${e.overdue ? ' overdue' : ''}${e.complete ? ' done' : ''}${movable ? ' movable' : ''}${drag?.e.id === e.id ? ' dragging' : ''}`}
          onClick={() => open(e)}
          title={`${T.label}: ${e.clientName} · ${e.title}${status}${movable ? ' — drag to another day to move it' : ''}`}
          draggable={movable || undefined}
          onDragStart={movable ? (x) => { x.dataTransfer.effectAllowed = 'move'; x.dataTransfer.setData('text/plain', `shoot:${e.shootId}`); setDrag({ e, offset: k, over: null }); } : undefined}
          onDragEnd={movable ? () => setDrag(null) : undefined}
          aria-label={`${T.label}${status}: ${e.clientName}, ${e.title}${e.type === 'writing' || (e.type === 'shoot' && e.end !== e.start) ? `, ${fmtDate(e.start)} to ${fmtDate(e.end)}` : ''}${movable ? '. Press to change the dates.' : ''}`}
        >
          <Icon aria-hidden />
          <span>{showLabel ? `${e.type === 'writing' ? 'Writing · ' : ''}${e.clientName}` : ' '}{detail && showLabel && <small className="ev-sub">{e.type === 'writing' ? `until ${fmtDate(e.end)}` : `${T.label} · ${e.title}`}</small>}</span>
          {movable && <GripVertical className="grip" aria-hidden />}
        </button>
      </m.div>
    );
  };

  return (
    <>
      <PageHeader title="Calendar" sub={manager ? 'Writing periods, draft deadlines, final deliveries and shoots. Drag a shoot to another day to move it — its deadlines follow.' : 'Writing periods, draft deadlines, final deliveries and shoots.'}>
        <Seg role="group" aria-label="Calendar view">
          <button aria-pressed={view === 'days'} onClick={() => setView('days')}>Days</button>
          <button aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </Seg>
      </PageHeader>
      <div className="cal-bar">
        {view !== 'days' && <>
        <Button variant="sm" onClick={() => setP('m', addMonths(month, -1).slice(0, 7))} aria-label="Previous month" icon={<ChevronLeft aria-hidden />} />
        <span className="month" aria-live="polite">{fmtMonth(month)}</span>
        <Button variant="sm" onClick={() => setP('m', addMonths(month, 1).slice(0, 7))} aria-label="Next month" icon={<ChevronRight aria-hidden />} />
        <Button variant="sm ghost" onClick={() => setP('m', '')}>Today</Button>
        </>}
        <span className="spacer" />
        <select className="select sm" style={{ width: 'auto' }} value={writerId} onChange={(e) => setP('writerId', e.target.value)} aria-label="Writer"><option value="">All writers</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select>
        <select className="select sm" style={{ width: 'auto', maxWidth: 220 }} value={clientId} onChange={(e) => setP('clientId', e.target.value)} aria-label="Client"><option value="">All clients</option>{clients.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      </div>
      <div className="quick" role="group" aria-label="Show event types">
        {(Object.keys(TYPE) as CalendarEvent['type'][]).map((t) => {
          const T = TYPE[t];
          return (
            <button key={t} aria-pressed={!hidden.has(t)} style={{ ['--c' as string]: T.c }} onClick={() => setHidden((h) => { const n = new Set(h); n.has(t) ? n.delete(t) : n.add(t); return n; })}>
              <T.icon size={14} aria-hidden color={T.c} />{T.label}
            </button>
          );
        })}
        <span className="muted" style={{ fontSize: 12.5, alignSelf: 'center', marginLeft: 6 }}>Red outline = overdue · faded = complete</span>
      </div>
      {view === 'days' && (
        <m.div key="days" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}>
          <DaysTimeline n={n} onN={(c) => setP('days', String(c))} today={clock.today} writerId={writerId} clientId={clientId} hidden={hidden}
            renderEv={ev} onOver={onOver} onDrop={onDrop} isLanding={isLanding} landingFrom={landing?.from ?? null} dragging={!!drag} />
        </m.div>
      )}
      {view !== 'days' && q.isLoading && <Loading height={560} />}
      {view !== 'days' && q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && view === 'month' && (
        <div className="cal month-cal">
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
          <m.div key={month} custom={dir}
            variants={{ in: (d: number) => ({ opacity: 0, x: d * 60 }), on: { opacity: 1, x: 0 }, out: (d: number) => ({ opacity: 0, x: d * -60 }) }}
            initial="in" animate="on" exit="out" transition={{ type: 'spring', stiffness: 260, damping: 30 }}>
          <div className={`cal-grid month${drag ? ' dragging-shoot' : ''}`} onDragLeave={(x) => { if (drag && !(x.currentTarget as HTMLElement).contains(x.relatedTarget as Node)) setDrag({ ...drag, over: null }); }}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="wd">{d}</div>)}
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const out = d.slice(0, 7) !== month.slice(0, 7);
              const land = isLanding(d);
              return (
                <div key={d} className={`cell${out ? ' out' : ''}${d === clock.today ? ' today' : ''}${land ? ' landing' : ''}`} onDragOver={(x) => onOver(x, d)} onDrop={(x) => onDrop(x, d)}>
                  <span className="dn"><span>{Number(d.slice(8))}</span>{d === clock.today && <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}>Today</span>}</span>
                  {land && landing && d === landing.from && <span className="landing-tag"><Camera aria-hidden />{drag ? 'Drop to move here' : 'Moving here…'}</span>}
                  {list.slice(0, 5).map((e) => ev(e, d))}
                  {list.length > 5 && <button className="more" onClick={() => setView('list')}>+{list.length - 5} more</button>}
                </div>
              );
            })}
          </div>
          </m.div>
          </AnimatePresence>
        </div>
      )}
      {q.data && view === 'list' && (
        <m.div key="list" className="panel" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3, ease: [0.23, 1, 0.32, 1] }}>
          {!events.length ? <Empty title="Nothing scheduled this month" /> : (
            <div className="agenda">
              {days.filter((d) => d.slice(0, 7) === month.slice(0, 7) && (byDay.get(d)?.some((e) => e.type !== 'writing' || e.start === d) ?? false)).map((d) => (
                <div key={d} className="agenda-day">
                  <h3>{fmtWeekday(d)}{d === clock.today && <span>today</span>}</h3>
                  <div className="rows">
                    {(byDay.get(d) ?? []).filter((e) => e.type !== 'writing' || e.start === d).map((e) => {
                      const T = TYPE[e.type];
                      return (
                        <button key={e.id} className={`item clickable ${e.overdue ? 'edge-red' : ''}`} style={{ border: 0, textAlign: 'left', color: 'inherit', font: 'inherit' }} onClick={() => open(e)}>
                          <div className="body">
                            <div className="top" style={{ color: T.c, fontWeight: 700 }}><T.icon size={14} aria-hidden />{T.label}{e.type === 'writing' && ` · until ${fmtDate(e.end)}`}{e.type === 'shoot' && e.end !== e.start && ` · until ${fmtDate(e.end)}`}</div>
                            <div className="title">{e.clientName}</div>
                            <div className="meta">{e.title}</div>
                          </div>
                          <div className="side">{e.overdue ? <span className="chip red"><AlertTriangle aria-hidden />Overdue</span> : e.complete ? <span className="chip mint"><Check aria-hidden />Complete</span> : canMove(e) ? <span className="btn sm"><CalendarClock aria-hidden />Change dates</span> : null}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </m.div>
      )}
      {picked && (
        <Dialog open onClose={() => setPicked(null)} size="narrow" title={`${picked.clientName} · ${picked.title}`} sub={fmtRange(picked.start, picked.end !== picked.start ? picked.end : null)}
          footer={<div className="form-actions">
            {picked.batchId && <Button variant="ghost" icon={<ArrowRight aria-hidden />} onClick={() => { const id = picked.batchId; setPicked(null); nav(`/batches/${id}`); }}>Open batch</Button>}
            <Button variant="primary pill" icon={<CalendarClock aria-hidden />} onClick={() => { setMove(moveOf(picked)); setPicked(null); }}>Change dates</Button>
          </div>}>
          <p className="muted" style={{ fontSize: 13.5 }}>Changing the dates moves the draft and final delivery deadlines and the planned writing start with it. You’ll see every change before it’s applied. You can also drag the shoot to another day on the calendar.</p>
        </Dialog>
      )}
      {move && <RescheduleDialog shootId={move.shootId} start={move.start} end={move.end} initialStart={move.toStart} initialEnd={move.toEnd} onClose={() => setMove(null)} />}
    </>
  );
}
