// "Work due by day": the Specular rounded-bar chart, adapted to script
// deadlines. Counts are scripts still short of the chosen milestone, stacked
// by where they are in the workflow. Overdue work sits in its own bucket.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import type { DueCategory, DueDay } from '../../../shared/types';
import { DUE_CATEGORIES, DUE_CATEGORY_LABEL } from '../../../shared/types';
import { fmtDow, fmtWeekday, plural } from '../../../shared/format';
import { weekday } from '../../../shared/dates';
import { CountUp, Seg } from './ui';

export const CAT_COLOR: Record<DueCategory, string> = {
  not_started: 'var(--neutral)',
  writing: 'var(--cyan)',
  in_review: 'var(--lavender)',
  to_deliver: 'var(--mint)',
};

export function DueChart({ draft, final, today }: { draft: DueDay[]; final: DueDay[]; today: string }) {
  const [mode, setMode] = useState<'final' | 'draft'>('final');
  const [picked, setPicked] = useState<string | null>(null);
  const days = mode === 'final' ? final : draft;
  const cats = mode === 'final' ? DUE_CATEGORIES : (['not_started', 'writing'] as DueCategory[]);
  const overdue = days[0];
  const upcoming = days.slice(1).reduce((n, d) => n + d.total, 0);
  const max = Math.max(4, ...days.map((d) => d.total));
  const selected = days.find((d) => d.date === picked) ?? null;
  const noun = mode === 'final' ? 'final delivery' : 'drafts';
  const summary = days
    .filter((d) => d.total)
    .map((d) => `${d.date === 'overdue' ? 'Overdue' : fmtWeekday(d.date)}: ${d.total}`)
    .join('; ');

  return (
    <div>
      <div className="due-head">
        <div>
          <h2 style={{ fontSize: 'var(--fs-h2)', fontWeight: 700 }}>Work due by day</h2>
          <div className="due-total" aria-hidden><CountUp value={upcoming} /></div>
          <div className="due-total-sub">
            scripts due for {noun} in the next 14 days
            {overdue.total > 0 && <> · <b>{overdue.total} overdue</b></>}
          </div>
        </div>
        <Seg role="group" aria-label="Deadline type">
          <button aria-pressed={mode === 'final'} onClick={() => { setMode('final'); setPicked(null); }}>Final delivery</button>
          <button aria-pressed={mode === 'draft'} onClick={() => { setMode('draft'); setPicked(null); }}>Drafts</button>
        </Seg>
      </div>
      <div className="due-legend-row">
        <div className="legend" aria-label="Legend">
          {cats.map((c) => <span key={c} style={{ ['--c' as string]: CAT_COLOR[c] }}><i />{DUE_CATEGORY_LABEL[c]}</span>)}
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>Counting {mode === 'final' ? 'final delivery to Timeliner' : 'draft'} deadlines · click a day for details</span>
      </div>
      <p className="sr-only">{upcoming} scripts due for {noun} in the next 14 days, {overdue.total} overdue. {summary || 'Nothing due.'}</p>
      <div className="bars-scroll">
        <div className="bars" key={mode} role="group" aria-label={`Scripts due per day for ${noun}`}>
          {days.map((d, i) => {
            const isLate = d.date === 'overdue';
            const isToday = d.date === today;
            const wd = isLate ? -1 : weekday(d.date as string);
            const pct = d.total ? Math.max(12, (d.total / max) * 100) : 0;
            const label = isLate ? 'Overdue' : fmtWeekday(d.date as string);
            const breakdown = cats.filter((c) => d.byCategory[c]).map((c) => `${d.byCategory[c]} ${DUE_CATEGORY_LABEL[c].toLowerCase()}`).join(', ');
            return (
              <button
                key={d.date}
                className={`bar${isLate ? ' late' : ''}${isToday ? ' today' : ''}${wd === 0 || wd === 6 ? ' weekend' : ''}`}
                aria-pressed={picked === d.date}
                aria-label={`${label}: ${plural(d.total, 'script')} ${isLate ? 'overdue' : 'due'}${breakdown ? ` — ${breakdown}` : ''}`}
                onClick={() => setPicked(picked === d.date ? null : (d.date as string))}
              >
                <span className="col-wrap" style={{ ['--bar-h' as string]: '190px', ['--pct' as string]: `${pct}%` }}>
                  <span className="track">
                    {d.total > 0 && (
                      <span className="stackfill" style={{ height: `${pct}%`, ['--i' as string]: i }}>
                        {cats.filter((c) => d.byCategory[c]).map((c, k, list) => (
                          // each layer fades into the one above it, like water settling, instead of a hard line
                          <span key={c} className="seg-fill" style={{ flex: d.byCategory[c], ['--c' as string]: CAT_COLOR[c], ['--next' as string]: CAT_COLOR[list[k + 1] ?? c] }} />
                        ))}
                        {/* water: a rolling surface in the top layer's colour, a glint, and rising bubbles */}
                        <svg className="bar-wave" viewBox="0 0 120 10" preserveAspectRatio="none" aria-hidden style={{ ['--c' as string]: CAT_COLOR[cats.filter((c) => d.byCategory[c]).at(-1)!] }}>
                          <path d="M0 5Q10 1 20 5T40 5T60 5T80 5T100 5T120 5V10H0Z" />
                        </svg>
                        <span className="bar-water" aria-hidden><i className="bar-bub" /><i className="bar-bub" /><i className="bar-bub" /></span>
                      </span>
                    )}
                  </span>
                  <span className={`val${d.total ? '' : ' zero'}`}>{d.total}</span>
                </span>
                {isLate ? <span className="dow">Late</span> : <span className="dow">{isToday ? 'Today' : fmtDow(d.date as string)}</span>}
                <span className="day">{isLate ? '·' : Number((d.date as string).slice(8))}</span>
                {d.total > 0 && (
                  <span className="tip" role="presentation">
                    <b>{label} · {plural(d.total, 'script')}</b>
                    <em>{isLate ? `past their ${noun} deadline` : mode === 'final' ? 'due for final delivery to Timeliner' : 'with drafts due'}</em>
                    {cats.filter((c) => d.byCategory[c]).map((c) => (
                      <div key={c} style={{ ['--c' as string]: CAT_COLOR[c] }}><i />{DUE_CATEGORY_LABEL[c]}<span>{d.byCategory[c]}</span></div>
                    ))}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
      {selected && (
        <div className="due-detail">
          <h3>{selected.date === 'overdue' ? 'Overdue' : fmtWeekday(selected.date)} <span className="chip plain">{plural(selected.total, 'script')} · {mode === 'final' ? 'final delivery' : 'drafts'}</span></h3>
          {!selected.items.length && <p className="muted">Nothing due {selected.date === 'overdue' ? 'late' : 'this day'}.</p>}
          <div className="rows">
            {selected.items.map((it) => (
              <Link key={it.batchId} to={`/batches/${it.batchId}`} className={`item clickable ${selected.date === 'overdue' ? 'edge-red' : ''}`}>
                <div className="body">
                  <div className="top">{it.clientName}</div>
                  <div className="title">{it.batchTitle}</div>
                  <div className="meta">{cats.filter((c) => it.byCategory[c]).map((c) => <span key={c} className="chip" style={{ ['--c' as string]: CAT_COLOR[c] }}><i className="d" />{it.byCategory[c]} {DUE_CATEGORY_LABEL[c].toLowerCase()}</span>)}</div>
                </div>
                <div className="side"><span className="when">{plural(it.count, 'script')}</span><span className="muted" style={{ fontSize: 12.5, display: 'inline-flex', gap: 4, alignItems: 'center' }}>Open batch <ArrowRight size={14} /></span></div>
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
