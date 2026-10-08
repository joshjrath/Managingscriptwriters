// The Today pill: fills as the day's work gets done (drafts sent, deliveries
// confirmed), and once everything due today is finished it turns into
// rolling green waves that keep going for the rest of the day. A day with
// nothing due is all clear, so it gets the waves too. The moment the day's
// work completes gets a one-time burst of confetti.

import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Sun } from 'lucide-react';
import { api, qs } from '../api';
import type { TodayTasks } from '../../../shared/types';
import { plural } from '../../../shared/format';
import { CountUp, useOnScreen, useRise } from './ui';
import { useMotionAllowed } from '../motion';
import { burst, confetti } from '../fx';

// A sine wave drawn across 240 units, where the SVG is two pills wide and rolls
// left by half its width (120 units). Each period divides 120, so it loops seamlessly.
function wave(period: number, amp: number): string {
  let d = `M0 26 Q${period / 4} ${26 - amp} ${period / 2} 26`;
  for (let x = period; x <= 240; x += period / 2) d += ` T${x} 26`;
  return `${d} V60 H0Z`;
}
const WAVES = [wave(40, 12), wave(30, 10), wave(24, 9)];
const SPARKS: [number, number, number][] = [[8, 0, 2.6], [19, 1.1, 3.1], [31, 0.4, 2.4], [44, 1.7, 2.9], [57, 0.8, 2.5], [69, 2.1, 3.2], [81, 0.2, 2.7], [92, 1.4, 3]];

function remainingText(t: TodayTasks): string {
  const open = t.items.filter((i) => i.done < i.total);
  if (!open.length) return '';
  const first = open[0];
  const what = first.kind === 'todo'
    ? `To-do: ${first.text}`
    : `${first.kind === 'draft' ? 'Drafts' : 'Final delivery'} · ${first.clientName}, ${first.batchTitle} · ${plural(first.total - first.done, 'script')} left`;
  return `${first.overdue ? 'Overdue · ' : ''}${what}${open.length > 1 ? ` · and ${open.length - 1} more` : ''}`;
}

/** "2 of 5 done · 1 overdue" in words. */
function countText(t: TodayTasks): string {
  const overdue = t.items.filter((i) => i.overdue && i.done < i.total).length;
  return `${t.done} of ${t.total} done${overdue ? ` · ${overdue} overdue` : ''}`;
}

export function TodayPill({ userId }: { userId?: number }) {
  const q = useQuery({ queryKey: ['today', userId ?? null], queryFn: () => api<TodayTasks>(`/api/today${qs({ userId })}`), refetchInterval: 60_000 });
  const t = q.data;
  const total = t?.total ?? 0;
  const done = t?.done ?? 0;
  const pct = total ? (done / total) * 100 : 0;
  const clear = !!t && total === 0;
  const allDone = clear || (total > 0 && done >= total);
  const [ref, on] = useOnScreen<HTMLElement>();
  const allowed = useMotionAllowed();
  const { shown } = useRise(allDone ? 100 : pct, on && !!t);
  const pill = useRef<HTMLElement | null>(null);

  // celebrate once per day, per person (or team)
  useEffect(() => {
    if (!t || !allDone || clear) return;
    const key = `sm.today-done.${t.scope}.${userId ?? 'me'}`;
    try { if (localStorage.getItem(key) === t.date) return; localStorage.setItem(key, t.date); } catch { return; }
    const id = setTimeout(() => {
      const r = pill.current?.getBoundingClientRect();
      if (!r) return;
      confetti({ x: r.left + r.width / 2, y: r.top + r.height / 2, count: 80, spread: 110, power: 12, colors: ['#60D1BE', '#9BE8C9', '#3FBF8F', '#F4ED70', '#FFFFFF'] });
      burst(r.right - 30, r.top + r.height / 2, { colors: ['#60D1BE', '#FFFFFF', '#9BE8C9'], count: 18, distance: 60 });
    }, 900);
    return () => clearTimeout(id);
  }, [t, allDone, clear, userId]);

  if (!t) return <div className="today-pill skeleton" aria-hidden />;
  const who = t.scope === 'team' ? 'the team' : t.scope === 'person' ? 'them' : 'you';
  const label = clear
    ? `Nothing due today for ${who}. All clear.`
    : allDone ? `All done for today. ${plural(total, 'task')} finished.` : `Today: ${countText(t)}. ${remainingText(t)}`;
  const firstOpen = t.items.find((i) => i.done < i.total);
  const to = t.scope === 'team' ? '/production?flag=due_today&view=table' : firstOpen?.batchId ? `/batches/${firstOpen.batchId}` : t.scope === 'me' ? '/my-work' : undefined;
  const late = t.items.some((i) => i.overdue && i.done < i.total);

  return (
    <Link
      to={to ?? '#'}
      onClick={(e) => { if (!to) e.preventDefault(); }}
      ref={(el) => { ref.current = el; pill.current = el; }}
      className={`today-pill${allDone ? ' done' : ''}${late ? ' late' : ''}`}
      data-live={on && allowed ? '' : undefined}
      aria-label={label}
      style={{ ['--p' as string]: shown }}
    >
      <div className="tp-fill" aria-hidden>
        <div className="tp-bob b1"><svg className="tp-wave" viewBox="0 0 240 60" preserveAspectRatio="none"><path d={WAVES[0]} /></svg></div>
        <div className="tp-bob b2"><svg className="tp-wave" viewBox="0 0 240 60" preserveAspectRatio="none"><path d={WAVES[1]} /></svg></div>
        <div className="tp-bob b3"><svg className="tp-wave" viewBox="0 0 240 60" preserveAspectRatio="none"><path d={WAVES[2]} /></svg></div>
        <span className="tp-glint" />
        {allDone && SPARKS.map(([l, d, s], i) => <i key={i} className="tp-spark" style={{ left: `${l}%`, ['--d' as string]: `${d}s`, ['--s' as string]: `${s}s` }} />)}
      </div>
      <div className="tp-text">
        <span className="tp-ic" aria-hidden>{allDone ? <CheckCheck /> : <Sun />}</span>
        <span className="tp-main">
          <span className="tp-k">Today{t.scope === 'team' ? ' · whole team' : ''}</span>
          <b>{clear ? 'Nothing due today' : allDone ? 'All done for today' : <><CountUp value={done} /> of {total} done{late && <span className="tp-late"> · overdue</span>}</>}</b>
        </span>
        <span className="tp-sub">
          {clear ? 'All clear · enjoy the waves' : allDone ? `${plural(total, 'script task')} finished · enjoy the waves` : remainingText(t)}
        </span>
      </div>
    </Link>
  );
}
