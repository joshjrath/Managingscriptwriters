// Calendar: writing periods, draft deadlines, final delivery deadlines and
// shoot dates, each with its own colour, icon and label. Click an event to
// open its batch. Month grid on desktop, agenda list on phones.

import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Camera, Check, ChevronLeft, ChevronRight, FileText, PenLine, Send } from 'lucide-react';
import { api, qs } from '../api';
import type { CalendarEvent } from '../../../shared/types';
import { addDays, addMonths, eachDay, startOfMonth, startOfWeek, type ISODate } from '../../../shared/dates';
import { fmtMonth, fmtWeekday, fmtDate } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Empty, ErrorState, Loading } from '../components/ui';

const TYPE = {
  writing: { label: 'Writing', icon: PenLine, c: 'var(--cyan)' },
  draft: { label: 'Drafts due', icon: FileText, c: 'var(--lavender)' },
  final: { label: 'Final → Timeliner', icon: Send, c: 'var(--yellow)' },
  shoot: { label: 'Shoot', icon: Camera, c: 'var(--salmon)' },
} as const;

export function CalendarPage() {
  const { clock, users, clients } = useBoot();
  const nav = useNavigate();
  const [params, setParams] = useSearchParams();
  const month = params.get('m') && /^\d{4}-\d{2}$/.test(params.get('m')!) ? `${params.get('m')}-01` : startOfMonth(clock.today);
  const writerId = params.get('writerId') ?? '';
  const clientId = params.get('clientId') ?? '';
  const [view, setView] = useState<'month' | 'list'>(() => (window.matchMedia('(max-width: 760px)').matches ? 'list' : 'month'));
  const [hidden, setHidden] = useState<Set<CalendarEvent['type']>>(new Set());
  const gridStart = startOfWeek(month);
  const gridEnd = addDays(startOfWeek(addDays(addMonths(month, 1), -1)), 6);
  const q = useQuery({
    queryKey: ['calendar', gridStart, gridEnd, writerId, clientId],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: gridStart, to: gridEnd, writerId, clientId })}`),
  });
  const setP = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const events = (q.data?.events ?? []).filter((e) => !hidden.has(e.type));
  const byDay = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    const order = { shoot: 0, final: 1, draft: 2, writing: 3 };
    for (const e of events) for (const d of eachDay(e.start > gridStart ? e.start : gridStart, e.end < gridEnd ? e.end : gridEnd)) m.set(d, [...(m.get(d) ?? []), e]);
    for (const list of m.values()) list.sort((a, b) => order[a.type] - order[b.type]);
    return m;
  }, [events, gridStart, gridEnd]);
  const open = (e: CalendarEvent) => { if (e.batchId) nav(`/batches/${e.batchId}`); else if (e.shootId) nav('/production'); };
  const days = eachDay(gridStart, gridEnd);

  const Ev = ({ e, day }: { e: CalendarEvent; day: ISODate }) => {
    const T = TYPE[e.type];
    const Icon = e.overdue && e.type !== 'writing' ? AlertTriangle : e.complete && e.type !== 'writing' ? Check : T.icon;
    const showLabel = e.type !== 'writing' || day === e.start || new Date(day + 'T00:00:00Z').getUTCDay() === 1;
    const status = e.overdue ? ' (overdue)' : e.complete ? ' (complete)' : '';
    return (
      <button className={`ev ${e.type}${showLabel ? '' : ' cont'}${e.overdue ? ' overdue' : ''}${e.complete ? ' done' : ''}`} onClick={() => open(e)} title={`${T.label}: ${e.clientName} · ${e.title}${status}`}
        aria-label={`${T.label}${status}: ${e.clientName}, ${e.title}${e.type === 'writing' ? `, ${fmtDate(e.start)} to ${fmtDate(e.end)}` : ''}`}>
        <Icon aria-hidden />
        <span>{showLabel ? `${e.type === 'writing' ? 'Writing · ' : ''}${e.clientName}` : ' '}</span>
      </button>
    );
  };

  return (
    <>
      <PageHeader title="Calendar" sub="Writing periods, draft deadlines, final deliveries and shoots.">
        <div className="seg" role="group" aria-label="Calendar view">
          <button aria-pressed={view === 'month'} onClick={() => setView('month')}>Month</button>
          <button aria-pressed={view === 'list'} onClick={() => setView('list')}>List</button>
        </div>
      </PageHeader>
      <div className="cal-bar">
        <Button variant="sm" onClick={() => setP('m', addMonths(month, -1).slice(0, 7))} aria-label="Previous month" icon={<ChevronLeft aria-hidden />} />
        <span className="month" aria-live="polite">{fmtMonth(month)}</span>
        <Button variant="sm" onClick={() => setP('m', addMonths(month, 1).slice(0, 7))} aria-label="Next month" icon={<ChevronRight aria-hidden />} />
        <Button variant="sm ghost" onClick={() => setP('m', '')}>Today</Button>
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
      {q.isLoading && <Loading height={560} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && view === 'month' && (
        <div className="cal">
          <div className="cal-grid month">
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="wd">{d}</div>)}
            {days.map((d) => {
              const list = byDay.get(d) ?? [];
              const out = d.slice(0, 7) !== month.slice(0, 7);
              return (
                <div key={d} className={`cell${out ? ' out' : ''}${d === clock.today ? ' today' : ''}`}>
                  <span className="dn"><span>{Number(d.slice(8))}</span>{d === clock.today && <span style={{ fontSize: 10, letterSpacing: '.12em', textTransform: 'uppercase' }}>Today</span>}</span>
                  {list.slice(0, 5).map((e) => <Ev key={e.id} e={e} day={d} />)}
                  {list.length > 5 && <button className="more" onClick={() => setView('list')}>+{list.length - 5} more</button>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {q.data && view === 'list' && (
        <div className="panel">
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
                          <div className="side">{e.overdue ? <span className="chip red"><AlertTriangle aria-hidden />Overdue</span> : e.complete ? <span className="chip mint"><Check aria-hidden />Complete</span> : null}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
}
