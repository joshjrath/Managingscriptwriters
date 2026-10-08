// The Overview's four summary cards, each a gradient fill in its own colour
// (warm, yellow, violet, mint) whatever the numbers say, so the row looks the
// same on a quiet day as a busy one; the pills say "All clear", "Nothing due"
// or "Queue clear" when there's nothing in them. Each card ends in a small footer
// that says what's behind the number: which batches are late, how far today's
// work has got, where the scripts in review are, and deliveries day by day.
// The card itself (KpiCard) is shared with the Editors tab.

import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarCheck, CalendarDays, Check, ClipboardCheck, Send } from 'lucide-react';
import { api } from '../api';
import type { BatchSummary, Dashboard, TodayTasks } from '../../../shared/types';
import { diffDays, addDays, type ISODate } from '../../../shared/dates';
import { fmtCutoff, fmtDate, fmtTimeZoneAbbr, fmtWeekday, plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { CountUp } from './ui';

/** One gradient summary card. With `onClick` it's a button; without, a labelled group (the Editors tab). */
export function KpiCard({ tone, icon, pill, n, cap, sub, foot, onClick, label, glint }: {
  tone: 'overdue' | 'today' | 'review' | 'done' | 'live' | 'revs'; icon: ReactNode; pill?: ReactNode;
  n: number; cap: string; sub: string; foot: ReactNode; onClick?: () => void; label: string; glint?: boolean;
}) {
  const inner = (
    <>
      {glint && <span className="dt-glint" aria-hidden />}
      <span className="kpi-top">
        <span className="kpi-ic" aria-hidden>{icon}</span>
        {pill}
      </span>
      <span className="kpi-main">
        <span className="kpi-n"><CountUp value={n} /></span>
        <span className="kpi-cap">{cap}</span>
        <span className="kpi-sub">{sub}</span>
      </span>
      <span className="kpi-foot">{foot}</span>
    </>
  );
  if (!onClick) return <div className={`kpi aurora ${tone} static`} role="group" aria-label={label}>{inner}</div>;
  return <button type="button" className={`kpi aurora ${tone}`} onClick={onClick} aria-label={label}>{inner}</button>;
}

/** "Drafts 4d · Final 2d": how late, in a few characters (the card already says overdue). */
function lateText(b: BatchSummary): string {
  const parts = [b.draft.overdue && `Drafts ${Math.max(1, -(b.draft.daysUntil ?? 0))}d`, b.final.overdue && `Final ${Math.max(1, -(b.final.daysUntil ?? 0))}d`].filter(Boolean);
  return parts.join(' · ');
}

/** "Lumen" for "Lumen Skincare", "Greater" for "The Greater Riverside…": short enough for a card footer. */
const shortName = (name: string) => name.replace(/^the\s+/i, '').split(/\s+/)[0] ?? name;

/** "5 hours" / "2 days", for how long something has been waiting. */
function waited(iso: string): string {
  const h = Math.max(0, (Date.now() - Date.parse(iso)) / 3600_000);
  if (h < 1) return 'under an hour';
  if (h < 24) return plural(Math.round(h), 'hour');
  return plural(Math.round(h / 24), 'day');
}

export function StatCards({ d }: { d: Dashboard }) {
  const { clock, settings } = useBoot();
  const nav = useNavigate();
  const today = useQuery({ queryKey: ['today', null], queryFn: () => api<TodayTasks>('/api/today'), refetchInterval: 60_000 });
  const c = d.cards;
  const mine = d.scope === 'mine';
  const open = d.activeBatches.filter((b) => b.next?.date && !b.next.complete);
  const late = d.activeBatches.filter((b) => b.draft.overdue || b.final.overdue)
    .sort((a, b) => Math.min(a.draft.daysUntil ?? 0, a.final.daysUntil ?? 0) - Math.min(b.draft.daysUntil ?? 0, b.final.daysUntil ?? 0));
  const upcoming = open.filter((b) => !b.next!.overdue && b.next!.date! >= clock.today).sort((a, b) => a.next!.date!.localeCompare(b.next!.date!));
  const next = upcoming[0];
  const tomorrow = addDays(clock.today, 1);
  const kindWord = (b: BatchSummary) => (b.next?.kind === 'draft' ? 'drafts' : 'final');

  // 1 · overdue: always the warm gradient
  const overdue = (
    <KpiCard tone="overdue" icon={<AlertTriangle />} n={c.overdueBatches}
      pill={c.overdueBatches ? <span className="kpi-pill hot"><i aria-hidden />Needs you</span> : <span className="kpi-pill"><Check aria-hidden />All clear</span>}
      cap={mine ? (c.overdueBatches === 1 ? 'Your overdue batch' : 'Your overdue batches') : c.overdueBatches === 1 ? 'Overdue batch' : 'Overdue batches'}
      sub={c.overdueScripts ? `${plural(c.overdueScripts, 'script')} behind` : 'Nothing overdue'}
      label={`${plural(c.overdueBatches, 'overdue batch', 'overdue batches')}, ${plural(c.overdueScripts, 'script')} behind. Show them.`}
      onClick={() => nav('/production?flag=overdue&view=table')}
      foot={late.length ? (
        <span className="kpi-list">
          {late.slice(0, 2).map((b) => <span key={b.id} className="kpi-row" title={`${b.clientName}: ${lateText(b)} late`}><b className="ellipsis">{shortName(b.clientName)}</b><span>{lateText(b)}</span></span>)}
          {late.length > 2 && <span className="kpi-row muted"><span>and {plural(late.length - 2, 'more batch', 'more batches')}</span></span>}
        </span>
      ) : (
        <span className="kpi-row"><span>Next deadline</span><b className="ellipsis">{next ? `${shortName(next.clientName)} · ${kindWord(next)} ${fmtDate(next.next!.date!, clock.today)}` : 'None coming up'}</b></span>
      )} />
  );

  // 2 · due today: always the yellow gradient
  const t = today.data;
  const dueTomorrow = upcoming.filter((b) => b.next!.date === tomorrow);
  const dueNow = c.dueTodayBatches > 0;
  const todayCard = (
    <KpiCard tone="today" icon={dueNow ? <CalendarCheck /> : <CalendarDays />} n={c.dueTodayBatches}
      pill={dueNow ? <span className="kpi-pill hot">Due {fmtCutoff(settings.cutoff)} {fmtTimeZoneAbbr(settings.timezone)}</span> : <span className="kpi-pill"><Check aria-hidden />Nothing due</span>}
      cap={mine ? 'Yours due today' : c.dueTodayBatches === 1 ? 'Batch due today' : 'Batches due today'}
      sub={c.dueTodayScripts ? `${plural(c.dueTodayScripts, 'script')} left to finish` : 'No deadlines today'}
      label={`${plural(c.dueTodayBatches, 'batch', 'batches')} due today. Show them.`}
      onClick={() => nav('/production?flag=due_today&view=table')}
      foot={dueNow && t && t.total > 0 ? (
        <span className="kpi-meter">
          <span className="kpi-row"><span>Today’s work</span><b>{t.done} of {t.total} done</b></span>
          <span className="kpi-bar" aria-hidden><i style={{ width: `${Math.round((t.done / t.total) * 100)}%` }} /></span>
        </span>
      ) : (
        <span className="kpi-row">
          <span>{dueTomorrow.length ? 'Tomorrow' : next ? fmtWeekday(next.next!.date!) : 'Next'}</span>
          <b className="ellipsis">{dueTomorrow.length ? `${shortName(dueTomorrow[0].clientName)} · ${kindWord(dueTomorrow[0])}${dueTomorrow.length > 1 ? ` +${dueTomorrow.length - 1}` : ''}` : next ? `${shortName(next.clientName)} · ${kindWord(next)}` : 'Nothing scheduled'}</b>
        </span>
      )} />
  );

  // 3 · in review: where the scripts are waiting
  const inReview = d.activeBatches.filter((b) => b.progress.inReview > 0).sort((a, b) => b.progress.inReview - a.progress.inReview);
  const top = inReview.slice(0, 3);
  const rest = inReview.slice(3).reduce((n, b) => n + b.progress.inReview, 0);
  const reviewCard = (
    <KpiCard tone="review" icon={<ClipboardCheck />} n={c.awaitingReviewScripts}
      pill={c.awaitingReviewScripts && c.oldestInReviewAt ? <span className="kpi-pill">Oldest waiting {waited(c.oldestInReviewAt)}</span>
        : !c.awaitingReviewScripts ? <span className="kpi-pill"><Check aria-hidden />Queue clear</span> : undefined}
      cap={mine ? 'Your scripts in review' : c.awaitingReviewScripts === 1 ? 'Script in review' : 'Scripts in review'}
      sub={c.awaitingReviewBatches ? `across ${plural(c.awaitingReviewBatches, 'batch', 'batches')}` : 'Nothing waiting on you'}
      label={`${plural(c.awaitingReviewScripts, 'script')} in review. Open the review queue.`}
      onClick={() => nav(mine ? '/my-work' : '/review')}
      foot={top.length ? (
        <span className="kpi-meter">
          <span className="kpi-seg" aria-hidden>
            {top.map((b, i) => <i key={b.id} className={`s${i}`} style={{ flex: b.progress.inReview }} />)}
            {rest > 0 && <i className="s3" style={{ flex: rest }} />}
          </span>
          <span className="kpi-legend">
            {top.map((b) => <span key={b.id} title={b.clientName}><b>{b.progress.inReview}</b> {shortName(b.clientName)}</span>)}
            {rest > 0 && <span><b>{rest}</b> other</span>}
          </span>
        </span>
      ) : (
        <span className="kpi-row"><span>Last reviewed</span><b>{c.lastReviewAt ? fmtAgoShort(c.lastReviewAt) : 'Not yet'}</b></span>
      )} />
  );

  // 4 · delivered this week: day by day, Monday first
  const by = c.deliveredByDay?.length === 7 ? c.deliveredByDay : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...by);
  const todayIndex = (() => { const wd = new Date(`${clock.today}T12:00:00Z`).getUTCDay(); return wd === 0 ? 6 : wd - 1; })();
  const weekStart = addDays(clock.today, -todayIndex) as ISODate;
  const doneCard = (
    <KpiCard tone="done" icon={<Send />} n={c.deliveredThisWeekScripts}
      pill={<span className="kpi-pill">Mon – Sun</span>}
      cap="Delivered this week"
      sub={`${mine ? 'your scripts' : 'scripts in Timeliner'}${c.deliveredThisWeekBatches ? ` · ${plural(c.deliveredThisWeekBatches, 'batch', 'batches')}` : ''}`}
      label={`${plural(c.deliveredThisWeekScripts, 'script')} delivered this week.`}
      onClick={() => nav('/production?stage=delivered&view=table&completed=1')}
      foot={(
        <span className="kpi-week" aria-hidden>
          {by.map((v, i) => {
            const day = addDays(weekStart, i);
            const future = diffDays(day, clock.today) > 0;
            return (
              <span key={i} className={`d${i === todayIndex ? ' today' : ''}${future ? ' future' : ''}`} title={`${fmtWeekday(day)}: ${plural(v, 'script')}`}>
                <span className="wk"><i style={{ height: v ? `${Math.max(14, (v / max) * 100)}%` : 0 }} /></span>
                <span className="l">{'MTWTFSS'[i]}</span>
              </span>
            );
          })}
        </span>
      )} />
  );

  return <div className="kpis">{overdue}{todayCard}{reviewCard}{doneCard}</div>;
}

/** "2 hours ago" / "yesterday" without the long forms. */
function fmtAgoShort(iso: string): string {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (min < 60) return min < 1 ? 'just now' : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${plural(h, 'hour')} ago`;
  const days = Math.round(h / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}
