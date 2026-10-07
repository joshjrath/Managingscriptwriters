// Days view: a timeline you scroll left and right freely: trackpad, shift +
// wheel, swipe, or grab the background and fling it. Choose how many days fit
// on screen. It keeps loading days in both directions as you scroll, and
// shoots can be dragged between days here too.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { api, qs } from '../api';
import type { CalendarEvent } from '../../../shared/types';
import { addDays, diffDays, eachDay, type ISODate } from '../../../shared/dates';
import { fmtMonth } from '../../../shared/format';
import { motionAllowed } from '../motion';
import { Button, Seg } from './ui';

export const DAY_COUNTS = [1, 3, 5, 7, 14] as const;
export type DayCount = (typeof DAY_COUNTS)[number];
const LABEL: Record<DayCount, string> = { 1: '1 day', 3: '3 days', 5: '5 days', 7: 'Week', 14: '2 weeks' };
const CHUNK = 42; // days added at a time when you get near either end
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function DaysTimeline({ n, onN, today, writerId, clientId, hidden, renderEv, onOver, onDrop, isLanding, landingFrom, dragging }: {
  n: DayCount; onN: (n: DayCount) => void; today: ISODate; writerId: string; clientId: string; hidden: Set<CalendarEvent['type']>;
  renderEv: (e: CalendarEvent, day: ISODate, detail: boolean) => ReactNode;
  onOver: (x: DragEvent, d: ISODate) => void; onDrop: (x: DragEvent, d: ISODate) => void;
  isLanding: (d: ISODate) => boolean; landingFrom: ISODate | null; dragging: boolean;
}) {
  const [range, setRange] = useState(() => ({ from: addDays(today, -CHUNK), to: addDays(today, CHUNK * 2) }));
  const q = useQuery({
    queryKey: ['calendar', range.from, range.to, writerId, clientId],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: range.from, to: range.to, writerId, clientId })}`),
    placeholderData: keepPreviousData,
  });
  const scroller = useRef<HTMLDivElement>(null);
  const [col, setCol] = useState(0);
  const anchor = useRef<ISODate>(addDays(today, n >= 7 ? -1 : 0)); // leftmost day in view
  const [shown, setShown] = useState<ISODate>(anchor.current);
  const prevFrom = useRef(range.from);
  const [switching, setSwitching] = useState(0);

  const days = useMemo(() => eachDay(range.from, range.to), [range]);
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    const order = { shoot: 0, final: 1, draft: 2, writing: 3, external: 4 };
    for (const e of q.data?.events ?? []) {
      if (hidden.has(e.type)) continue;
      for (const d of eachDay(e.start > range.from ? e.start : range.from, e.end < range.to ? e.end : range.to)) map.set(d, [...(map.get(d) ?? []), e]);
    }
    for (const list of map.values()) list.sort((a, b) => order[a.type] - order[b.type]);
    return map;
  }, [q.data, hidden, range]);

  // column width: the chosen number of days fills the screen
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const size = () => setCol(Math.max(n === 1 ? 200 : 64, Math.floor(el.clientWidth / n)));
    size();
    const ro = new ResizeObserver(size);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n]);

  // keep the same day at the left edge when the width changes or days are added before it
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el || !col) return;
    el.scrollLeft = diffDays(anchor.current, range.from) * col;
    prevFrom.current = range.from;
  }, [col, range.from]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || !col) return;
    const first = addDays(range.from, Math.round(el.scrollLeft / col));
    anchor.current = first;
    if (first !== shown) setShown(first);
    if (el.scrollLeft < col * 10) setRange((r) => ({ ...r, from: addDays(r.from, -CHUNK) }));
    else if (el.scrollLeft + el.clientWidth > el.scrollWidth - col * 10) setRange((r) => ({ ...r, to: addDays(r.to, CHUNK) }));
  };

  const go = (day: ISODate) => {
    const el = scroller.current;
    if (!el || !col) return;
    if (day < range.from || day > range.to) {
      anchor.current = day;
      setRange({ from: addDays(day, -CHUNK), to: addDays(day, CHUNK * 2) });
      return;
    }
    el.scrollTo({ left: diffDays(day, range.from) * col, behavior: motionAllowed() ? 'smooth' : 'auto' });
  };
  const changeN = (next: DayCount) => { setSwitching((s) => s + 1); onN(next); };

  // grab the background and fling it; buttons (events) keep working, and shoots still drag
  const pan = useRef<{ x: number; t: number; v: number } | null>(null);
  const glide = useRef(0);
  const onPointerDown = (x: RPointerEvent<HTMLDivElement>) => {
    if (x.pointerType !== 'mouse' || x.button !== 0 || (x.target as HTMLElement).closest('button, a')) return;
    cancelAnimationFrame(glide.current);
    pan.current = { x: x.clientX, t: performance.now(), v: 0 };
    scroller.current!.setPointerCapture(x.pointerId);
    scroller.current!.classList.add('panning');
  };
  const onPointerMove = (x: RPointerEvent<HTMLDivElement>) => {
    const p = pan.current;
    if (!p) return;
    const el = scroller.current!;
    const now = performance.now();
    const before = el.scrollLeft;
    el.scrollLeft = before - (x.clientX - p.x);
    p.v = (el.scrollLeft - before) / Math.max(1, now - p.t); // px per ms, for the fling
    p.x = x.clientX;
    p.t = now;
  };
  const onPointerUp = () => {
    const p = pan.current;
    if (!p) return;
    pan.current = null;
    scroller.current?.classList.remove('panning');
    if (!motionAllowed()) return;
    if (performance.now() - p.t > 80) return; // let go after stopping: no fling
    let v = p.v * 16; // px per frame
    const step = () => {
      const el = scroller.current;
      if (!el || Math.abs(v) < 0.5) return;
      el.scrollLeft += v;
      v *= 0.94;
      glide.current = requestAnimationFrame(step);
    };
    glide.current = requestAnimationFrame(step);
  };
  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  const visibleTo = addDays(shown, n - 1);
  const title = shown.slice(0, 7) === visibleTo.slice(0, 7) ? fmtMonth(shown) : `${fmtMonth(shown).split(' ')[0]} – ${fmtMonth(visibleTo)}`;

  return (
    <>
      <div className="cal-bar">
        <Button variant="sm" onClick={() => go(addDays(shown, -n))} aria-label={`Back ${n} days`} icon={<ChevronLeft aria-hidden />} />
        <m.span key={title} className="month" aria-live="polite" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>{title}</m.span>
        <Button variant="sm" onClick={() => go(addDays(shown, n))} aria-label={`Forward ${n} days`} icon={<ChevronRight aria-hidden />} />
        <Button variant="sm ghost" onClick={() => go(addDays(today, n >= 7 ? -1 : 0))}>Today</Button>
        <span className="spacer" />
        <Seg role="group" aria-label="Days on screen">
          {DAY_COUNTS.map((c) => <button key={c} aria-pressed={n === c} onClick={() => changeN(c)}>{LABEL[c]}</button>)}
        </Seg>
      </div>
      <div className="cal days-cal">
        <div ref={scroller} className={`days-scroll${dragging ? ' dragging-shoot' : ''}`} onScroll={onScroll}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          tabIndex={0} aria-label="Days timeline. Scroll sideways to move through time."
          onKeyDown={(x) => { if (x.key === 'ArrowRight') { x.preventDefault(); go(addDays(shown, 1)); } if (x.key === 'ArrowLeft') { x.preventDefault(); go(addDays(shown, -1)); } }}>
          <div key={switching} className={`days-strip${switching ? ' reflow' : ''}`} style={{ width: days.length * col, ['--col' as string]: `${col}px` }}>
            {col > 0 && days.map((d) => {
              const wd = new Date(d + 'T00:00:00Z').getUTCDay();
              const list = byDay.get(d) ?? [];
              const land = isLanding(d);
              return (
                <div key={d} className={`dcol${d === today ? ' today' : ''}${wd === 0 || wd === 6 ? ' weekend' : ''}${d.endsWith('-01') ? ' first' : ''}${land ? ' landing' : ''}`}
                  onDragOver={(x) => onOver(x, d)} onDrop={(x) => onDrop(x, d)}>
                  <div className="dhead">
                    <span className="dow">{d === today ? 'Today' : DOW[wd]}</span>
                    <span className="dnum">{Number(d.slice(8))}</span>
                    {(d.endsWith('-01') || d === range.from) && <span className="dmon">{fmtMonth(d).split(' ')[0].slice(0, 3)}</span>}
                  </div>
                  <div className="dbody">
                    {land && landingFrom === d && <span className="landing-tag">{dragging ? 'Drop to move here' : 'Moving here…'}</span>}
                    {list.map((e) => renderEv(e, d, col >= 150))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
