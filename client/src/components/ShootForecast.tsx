// Overview and Calendar (admins and managers): the next shoot for each client whose last shoot is over with
// nothing booked after it, estimated from its past shoots and how many scripts each had. Each says when its
// scripts are due and who to give them to (last time's writers, as many as last time). Nothing is assigned
// until the manager books it: Plan this shoot opens the New shoot form filled in, to check and save.

import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Camera, UserPlus } from 'lucide-react';
import { api } from '../api';
import type { ShootForecast } from '../../../shared/types';
import { fmtDate, fmtRange, fmtWeekday, plural, relDay } from '../../../shared/format';
import { useBoot, useNewWork } from './Shell';
import { Button, Chip, DateTile, Dialog, Panel } from './ui';

/** Opens the New shoot form with the estimate filled in: the client, the tentative date, last time's count and writers. */
export function usePlanForecast() {
  const openNew = useNewWork();
  return (f: ShootForecast) => openNew('shoot', f.estimate
    ? { clientId: f.clientId, start: f.estimate.shootDate, count: f.estimate.scripts, split: f.estimate.writers.map((w) => ({ writerId: w.writerId, count: w.count })) }
    : { clientId: f.clientId });
}

/** Where the estimate comes from, in one line. */
const paceWords = (e: NonNullable<ShootForecast['estimate']>) => `Counted from the ${fmtDate(e.from.start)} shoot’s ${plural(e.from.scripts, 'script')}, at ${e.daysPerScript} day${e.daysPerScript === 1 ? '' : 's'} a script (${e.basis === 'client' ? `this client’s last ${e.gaps === 1 ? 'gap' : `${e.gaps} gaps`} between shoots` : 'other clients’ shoots: this one has had only one'})`;

/** Who to give the scripts to: "Ana 20 (start by Nov 5) · Ben 11 · 3 need a writer". */
function AssignLine({ f }: { f: ShootForecast }) {
  const e = f.estimate!;
  const { clock } = useBoot();
  if (!e.writers.length && !e.unassigned) return null;
  return (
    <div className="meta">
      <b style={{ color: 'var(--text)' }}>Assign:</b>
      {e.writers.map((w) => <span key={w.writerId}>{w.name.split(' ')[0]} {w.count}{w.startBy ? ` (start by ${fmtDate(w.startBy, clock.today)})` : ''}</span>)}
      {e.unassigned > 0 && <span>{plural(e.unassigned, 'script')} {e.unassigned === 1 ? 'needs' : 'need'} a writer</span>}
    </div>
  );
}

export function ShootForecastPanel() {
  const { clock } = useBoot();
  const plan = usePlanForecast();
  const q = useQuery({ queryKey: ['shoot-forecast'], queryFn: () => api<{ forecasts: ShootForecast[] }>('/api/shoot-forecast'), refetchInterval: 5 * 60_000 });
  const list = q.data?.forecasts ?? [];
  if (!list.length) return null;
  return (
    <Panel className="forecast" title="Next shoots to book" count={list.length} sub="last shoot over, nothing booked yet · estimated from past shoots">
      <div className="rows">
        {list.map((f) => {
          const e = f.estimate;
          const days = e ? Math.round((Date.parse(e.finalDue) - Date.parse(clock.today)) / 86400000) : null;
          return (
            <div key={f.clientId} className={`item with-tile ${e?.late ? 'edge-red' : days != null && days <= 7 ? 'edge-yellow' : ''}`}>
              {e ? <DateTile date={e.shootDate} color="var(--tentative)" /> : <DateTile date={f.lastShoot.startDate} />}
              <div className="body">
                <div className="top"><Camera size={13} aria-hidden /> Last shoot {fmtRange(f.lastShoot.startDate, f.lastShoot.endDate)} · {plural(f.lastShoot.scripts, 'script')}</div>
                <div className="title">{f.clientName}</div>
                {e ? (
                  <>
                    <div className="meta">
                      <Chip color="tentative" icon={<CalendarClock aria-hidden />}>Tentative shoot {fmtWeekday(e.shootDate)}</Chip>
                      <span>{relDay(e.shootDate, clock.today)}</span>
                    </div>
                    <div className="meta num">
                      <span><b style={{ color: 'var(--text)' }}>{plural(e.scripts, 'script')}</b> due {fmtWeekday(e.finalDue)}</span>
                      <span>drafts {fmtWeekday(e.draftDue)}</span>
                      {e.late && <Chip color="red">Behind: these scripts would be due already</Chip>}
                    </div>
                    <AssignLine f={f} />
                    <div className="meta muted" style={{ fontSize: 12 }}>{paceWords(e)}</div>
                  </>
                ) : (
                  <div className="meta muted">Not enough history to estimate the next one yet: it needs a past shoot with scripts on the site.</div>
                )}
              </div>
              <div className="side">
                <Button variant="sm primary" icon={<UserPlus aria-hidden />} onClick={() => plan(f)}>{e ? 'Plan this shoot' : 'Schedule a shoot'}</Button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

/** A tentative shoot (or its scripts' due date) tapped on the calendar. */
export function ForecastDialog({ f, onClose }: { f: ShootForecast; onClose: () => void }) {
  const { clock } = useBoot();
  const plan = usePlanForecast();
  const e = f.estimate!;
  return (
    <Dialog open onClose={onClose} size="narrow" title={`${f.clientName} · tentative shoot`} sub={`${fmtWeekday(e.shootDate)} · ${relDay(e.shootDate, clock.today)} · an estimate, not booked`}
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose}>Close</Button>
        <Button variant="primary pill" icon={<UserPlus aria-hidden />} onClick={() => { onClose(); plan(f); }}>Plan this shoot</Button>
      </div>}>
      <div className="stack s3" style={{ fontSize: 13.5 }}>
        <p><b>{plural(e.scripts, 'script')}</b> due {fmtWeekday(e.finalDue)} (drafts {fmtWeekday(e.draftDue)}).{e.late ? ' That’s already past: book it soon.' : ''}</p>
        {(e.writers.length > 0 || e.unassigned > 0) && <div className="rows"><div className="item"><div className="body"><AssignLine f={f} /></div></div></div>}
        <p className="muted">{paceWords(e)}. Plan this shoot opens the New shoot form with this filled in; change the date to the real one when it’s booked.</p>
      </div>
    </Dialog>
  );
}
