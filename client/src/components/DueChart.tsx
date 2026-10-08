// "Work due by day": one glowing tile per day, like the summary cards above it.
// A tile fills against the team's daily capacity (the writers' scripts-per-day
// added up), so a full tile is a full day's work; a busier day overflows, glows
// pink and says how far over it is. With no capacities set, tiles fill against
// the busiest day on a soft scale so quiet days still show. Overdue work has its
// own tile, today is always yellow, and the batches behind the picked day are listed underneath.

import { useState, type CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowRight, Pencil } from 'lucide-react';
import type { DueCategory, DueDay } from '../../../shared/types';
import { DUE_CATEGORIES, DUE_CATEGORY_LABEL } from '../../../shared/types';
import { addDays, diffDays, startOfWeek, weekday, type ISODate } from '../../../shared/dates';
import { fmtDate, fmtDow, fmtWeekday, plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { Avatar, CountUp } from './ui';

export const CAT_COLOR: Record<DueCategory, string> = {
  not_started: 'var(--neutral)',
  writing: 'var(--cyan)',
  in_review: 'var(--lavender)',
  to_deliver: 'var(--mint)',
};

/** How much a day can hold: the scripts-per-day of everyone counted, and who has none set. */
export interface DueCapacity { perDay: number | null; missing: string[] }

const sumDays = (days: DueDay[]) => days.slice(1).reduce((n, d) => n + d.total, 0);

/** 0–3: how hot a tile's fill looks, from soft violet up to pink at a full day */
function tierOf(ratio: number): number {
  return ratio >= 1 ? 3 : ratio >= 0.7 ? 2 : ratio >= 0.35 ? 1 : 0;
}

export function DueChart({ draft, final, today, capacity, mine, canEdit }: {
  draft: DueDay[]; final: DueDay[]; today: ISODate; capacity: DueCapacity; mine: boolean; canEdit: boolean;
}) {
  const { users } = useBoot();
  const [mode, setMode] = useState<'final' | 'draft'>('final');
  const [picked, setPicked] = useState<string>(today);
  const days = mode === 'final' ? final : draft;
  const cats = mode === 'final' ? DUE_CATEGORIES : (['not_started', 'writing'] as DueCategory[]);
  const cap = capacity.perDay && capacity.perDay > 0 ? capacity.perDay : null;
  const upcoming = sumDays(days);
  const busiest = Math.max(1, ...days.slice(1).map((d) => d.total));
  const busiestDay = days.slice(1).find((d) => d.total === busiest && d.total > 0);
  const selected = days.find((d) => d.date === picked) ?? days[1];
  const noun = mode === 'final' ? 'final delivery' : 'drafts';
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const thisWeek = startOfWeek(today);

  // the week labels above the tiles: This week, Next week, Week of …
  const weeks: { label: string; col: number; span: number; wk: ISODate }[] = [];
  days.slice(1).forEach((d, i) => {
    const wk = startOfWeek(d.date as ISODate);
    const last = weeks.at(-1);
    if (last && last.wk === wk) last.span++;
    else weeks.push({ wk, col: i + 2, span: 1, label: wk === thisWeek ? 'This week' : wk === addDays(thisWeek, 7) ? 'Next week' : `Week of ${fmtDate(wk)}` });
  });

  const summary = days.filter((d) => d.total).map((d) => `${d.date === 'overdue' ? 'Overdue' : fmtWeekday(d.date)}: ${d.total}`).join('; ');
  const breakdownOf = (byCategory: Record<DueCategory, number>) => cats.filter((c) => byCategory[c]).map((c) => `${byCategory[c]} ${DUE_CATEGORY_LABEL[c].toLowerCase()}`).join(', ');

  return (
    <div className="dt">
      <div className="dt-head">
        <div>
          <h2 className="dt-title">Work due by day</h2>
          <div className="dt-total-row">
            <span className="dt-total" aria-hidden><CountUp value={upcoming} /></span>
            <span className="dt-total-sub">scripts due for {noun} in the next 14 days</span>
          </div>
        </div>
        <div className="dt-tools">
          <div className="dt-toggle" role="group" aria-label="Deadline type" data-on={mode}>
            <span className="dt-toggle-ind" aria-hidden />
            <button type="button" aria-pressed={mode === 'final'} onClick={() => setMode('final')}>Final delivery <span>{sumDays(final)}</span></button>
            <button type="button" aria-pressed={mode === 'draft'} onClick={() => setMode('draft')}>Drafts <span>{sumDays(draft)}</span></button>
          </div>
          <CapacityChip cap={cap} missing={capacity.missing} mine={mine} canEdit={canEdit} />
        </div>
      </div>

      <p className="sr-only">{upcoming} scripts due for {noun} in the next 14 days, {days[0].total} overdue{cap ? `; a full day is ${cap} scripts` : ''}. {summary || 'Nothing due.'}</p>
      <div className="dt-scroll">
        <div className="dt-grid" role="group" aria-label={`Scripts due per day for ${noun}`}>
          <span className="dt-week late" style={{ gridColumn: 1 }}>Late</span>
          {weeks.map((w) => <span key={w.wk} className="dt-week" style={{ gridColumn: `${w.col} / span ${w.span}` }}>{w.label}</span>)}
          {days.map((d, i) => {
            const isLate = d.date === 'overdue';
            const isToday = d.date === today;
            const wd = isLate ? -1 : weekday(d.date as ISODate);
            const sel = selected.date === d.date;
            // fill: against a full day when capacities are set, else a soft scale against the busiest day
            const ratio = cap ? d.total / cap : Math.log(1 + d.total) / Math.log(1 + busiest);
            const lvl = !d.total ? 0 : cap ? Math.max(30, Math.min(100, Math.round(ratio * 100))) : Math.max(34, Math.round(ratio * 100));
            const over = !!cap && !isLate && d.total > cap;
            const ring = over && d === busiestDay;
            const label = isLate ? 'Overdue' : fmtWeekday(d.date as ISODate);
            const breakdown = breakdownOf(d.byCategory);
            const cls = ['dt-tile', isLate && 'late', isToday && 'today', !isLate && !isToday && `t${tierOf(ratio)}`, (isLate || isToday || ratio >= 0.35) && 'hot', over && 'over', !d.total && 'free', (wd === 0 || wd === 6) && 'weekend'].filter(Boolean).join(' ');
            return (
              <div key={d.date} className={`dt-wrap${over ? ' over' : ''}${ring ? ' ring' : ''}`} style={{ gridColumn: i + 1, ['--i' as string]: i } as CSSProperties}>
                <button
                  type="button" className={cls} aria-pressed={sel} onClick={() => setPicked(d.date as string)}
                  aria-label={`${label}: ${plural(d.total, 'script')} ${isLate ? 'overdue' : 'due'}${over ? `, ${d.total - cap!} more than a full day` : ''}${breakdown ? ` — ${breakdown}` : ''}`}
                  title={breakdown ? `${label}: ${breakdown}` : undefined}
                >
                  <span className="dt-lvl" style={{ height: `${lvl}%` }} aria-hidden />
                  {(over || isToday || (!cap && d === busiestDay)) && <span className="dt-glint" aria-hidden />}
                  <span className="dt-in">
                    <span className="dt-dow">{isLate ? <AlertTriangle aria-hidden /> : isToday ? 'Today' : fmtDow(d.date as ISODate)}</span>
                    <span className="dt-day">{isLate ? 'Late' : Number((d.date as string).slice(8))}</span>
                    <span className="dt-n">{d.total}</span>
                    {over ? <span className="dt-over">+{d.total - cap!} over</span> : <span className="dt-word">{d.total === 1 ? 'script' : d.total ? 'scripts' : isLate ? 'all clear' : 'free'}</span>}
                    <span className="dt-strip" aria-hidden>
                      {cats.filter((c) => d.byCategory[c]).map((c) => <i key={c} className={c} style={{ flexGrow: d.byCategory[c], ['--c' as string]: CAT_COLOR[c] } as CSSProperties} />)}
                    </span>
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <div className="dt-legend">
        {cats.map((c) => <span key={c}><i className={c} style={{ ['--c' as string]: CAT_COLOR[c] } as CSSProperties} />{DUE_CATEGORY_LABEL[c]}</span>)}
        <span className="dt-legend-note">
          {cap ? 'A full tile is a full day’s work · busier days glow pink and show how far over they are' : 'Tiles fill against the busiest day · the number is the exact count'}
        </span>
      </div>

      <div className="dt-detail" aria-live="polite">
        <div className="dt-detail-head">
          <h3>{selected.date === 'overdue' ? 'Overdue' : selected.date === today ? `Due today · ${fmtWeekday(selected.date)}` : `Due ${fmtWeekday(selected.date as ISODate)}`}</h3>
          <span className="dt-count">{plural(selected.total, 'script')} · {noun}</span>
          <Link className="dt-more" to={selected.date === 'overdue' ? '/production?flag=overdue&view=table' : '/production?view=table'}>Open in Production <ArrowRight size={14} aria-hidden /></Link>
        </div>
        {!selected.items.length ? (
          <p className="dt-empty">{selected.date === 'overdue' ? 'Nothing is late. Nice.' : 'Nothing due this day.'}</p>
        ) : (
          <div className="dt-cards">
            {selected.items.map((it, k) => {
              const late = selected.date === 'overdue' ? diffDays(today, it.dueDate) : 0;
              return (
                <Link key={it.batchId} to={`/batches/${it.batchId}`} className="dt-card" style={{ ['--k' as string]: k } as CSSProperties}>
                  <span className="dt-card-top">
                    <span className="dt-card-name">
                      <b className="ellipsis">{it.clientName}</b>
                      <span className="ellipsis">{it.batchTitle}</span>
                    </span>
                    <span className="dt-avatars">{it.writerIds.slice(0, 3).map((id) => <Avatar key={id} id={id} name={nameOf.get(id) ?? '?'} small />)}</span>
                  </span>
                  <span className="dt-strip wide" aria-hidden>
                    {cats.filter((c) => it.byCategory[c]).map((c) => <i key={c} className={c} style={{ flexGrow: it.byCategory[c], ['--c' as string]: CAT_COLOR[c] } as CSSProperties} />)}
                  </span>
                  <span className="dt-card-foot">
                    <span>{breakdownOf(it.byCategory)}</span>
                    {late > 0 && <span className="dt-late">{plural(late, 'day')} late</span>}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/** "Full tile = 9 scripts, your team's day", which opens Settings → Team for managers. */
function CapacityChip({ cap, missing, mine, canEdit }: { cap: number | null; missing: string[]; mine: boolean; canEdit: boolean }) {
  const text = cap
    ? <>Full tile = <b>{plural(cap, 'script')}</b>, {mine ? 'your day' : 'your team’s day'}</>
    : mine ? <>Your daily capacity isn’t set yet</> : <>Set writers’ scripts per day to see full days</>;
  const note = cap && missing.length ? `Not counted (no daily capacity set): ${missing.join(', ')}` : undefined;
  const body = (
    <>
      <span className="dt-batt" aria-hidden><i /></span>
      <span>{text}{note && <span className="dt-missing"> · {plural(missing.length, 'writer')} not counted</span>}</span>
      {canEdit && <Pencil aria-hidden />}
    </>
  );
  return canEdit
    ? <Link className="dt-cap" to="/settings#team" title={note ?? 'Change each writer’s scripts per day in Settings → Team'}>{body}</Link>
    : <span className="dt-cap" title={note}>{body}</span>;
}
