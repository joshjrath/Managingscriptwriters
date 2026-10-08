// Editors' home: each shoot coming up with how many of its scripts are final
// (Ready, On track or Late, opening just that shoot's scripts), the newest
// finished scripts to cut from, and their to-dos. Everything
// here is read-only; the scripts open straight from the Script bank.

import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Camera, CalendarDays, Library } from 'lucide-react';
import { api, qs } from '../api';
import type { CalendarEvent, ScriptBankPage, ShootReadiness } from '../../../shared/types';
import { addDays, diffDays } from '../../../shared/dates';
import { fmtDate, fmtRange } from '../../../shared/format';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Chip, DateTile, Empty, ErrorState, Loading, Panel } from '../components/ui';
import { TodoPanel } from '../components/Todos';
import { DeliverableRow } from './ScriptBank';

const STATE: Record<ShootReadiness['state'], { label: string; color: string; edge: string }> = {
  ready: { label: 'Ready', color: 'mint', edge: 'edge-mint' },
  on_track: { label: 'On track', color: 'plain', edge: '' },
  late: { label: 'Late', color: 'red', edge: 'edge-red' },
  no_scripts: { label: 'Not planned', color: 'plain', edge: '' },
};
const daysText = (d: string, today: string) => { const n = diffDays(d, today); return n < 0 ? 'started' : n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`; };

const LOOKS_LIKE_SHOOT = /\b(shoots?|shooting|filming|film day|photo ?shoot|video ?shoot|content day|production day)\b/i;

export function EditorHome() {
  const { me, clock } = useBoot();
  const tz = useDisplayTz();
  const to = addDays(clock.today, 27);
  const cal = useQuery({
    queryKey: ['calendar', clock.today, to, 'editor-home'],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: clock.today, to })}`),
  });
  const ready = useQuery({ queryKey: ['script-bank', 'editor-home'], queryFn: () => api<ScriptBankPage>(`/api/script-bank${qs({ status: 'finished', limit: 10 })}`) });
  const ready2 = useQuery({ queryKey: ['shoot-readiness'], queryFn: () => api<{ shoots: ShootReadiness[] }>('/api/shoot-readiness') });
  // shoot-looking events on synced calendars that aren't planned on the site
  const external = (cal.data?.events ?? [])
    .filter((e) => e.type === 'external' && !e.external?.linkedShootId && LOOKS_LIKE_SHOOT.test(e.title) && e.end >= clock.today)
    .sort((a, b) => a.start.localeCompare(b.start));

  return (
    <>
      <PageHeader title={`Hi ${me.name.split(' ')[0]}`} sub="Shoots coming up, and the finished scripts to cut from." hideNewWork />
      <div className="grid g-main-side" style={{ alignItems: 'start' }}>
        <Panel title="Ready to edit" sub="newest finished scripts" tools={<Link to="/scripts" className="btn sm ghost">Script bank <ArrowRight size={14} aria-hidden /></Link>}>
          {ready.isLoading && <Loading height={220} />}
          {ready.isError && <ErrorState error={ready.error} retry={() => ready.refetch()} />}
          {ready.data && !ready.data.deliverables.length && <Empty boxed icon={<Library />} title="No finished scripts yet">Scripts show up here once they’re approved.</Empty>}
          {ready.data && ready.data.deliverables.length > 0 && (
            <div className="rows bank">
              {ready.data.deliverables.filter((d) => !d.past).map((d) => <DeliverableRow key={d.key} d={d} tz={tz} num={null} linkBatch={false} />)}
            </div>
          )}
        </Panel>
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel title="Shoots coming up" sub="are the scripts ready?" tools={<Link to="/calendar" className="btn sm ghost">Calendar <ArrowRight size={14} aria-hidden /></Link>}>
            {ready2.isLoading && <Loading height={200} />}
            {ready2.isError && <ErrorState error={ready2.error} retry={() => ready2.refetch()} />}
            {ready2.data && !ready2.data.shoots.length && !external.length && <Empty boxed icon={<Camera />} title="No shoots in the next 6 weeks" />}
            <div className="rows">
              {(ready2.data?.shoots ?? []).slice(0, 12).map((r) => {
                const st = STATE[r.state];
                return (
                  <Link key={r.shoot.id} to={`/scripts?shootId=${r.shoot.id}`} className={`item with-tile clickable ${st.edge}`}>
                    <DateTile date={r.shoot.startDate} color="var(--salmon)" />
                    <div className="body">
                      <div className="top">{fmtRange(r.shoot.startDate, r.shoot.endDate)} · {daysText(r.shoot.startDate, clock.today)}</div>
                      <div className="title">{r.shoot.clientName}</div>
                      <div className="meta">
                        {r.total ? <span className="num"><b style={{ color: 'var(--text)' }}>{r.finished} of {r.total}</b> scripts final</span> : <span>Scripts not planned yet</span>}
                        {r.finalDue && r.state !== 'ready' && <span>final due {fmtDate(r.finalDue, clock.today)}</span>}
                      </div>
                    </div>
                    <div className="side"><Chip color={st.color}>{st.label}</Chip></div>
                  </Link>
                );
              })}
            </div>
            {external.length > 0 && (
              <>
                <div className="section-title" style={{ marginTop: 14 }}>Also on the calendar</div>
                <div className="rows">
                  {external.slice(0, 6).map((e) => (
                    <div key={e.id} className="item with-tile">
                      <DateTile date={e.start} color={e.external!.color} />
                      <div className="body">
                        <div className="top" style={{ color: e.external!.color, fontWeight: 700, display: 'flex', gap: 5, alignItems: 'center' }}><CalendarDays size={13} aria-hidden />{e.external!.feedName}</div>
                        <div className="title">{e.title}</div>
                        <div className="meta"><span>{fmtRange(e.start, e.end !== e.start ? e.end : null)}</span>{e.external?.location && <span className="ellipsis">{e.external.location}</span>}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </Panel>
          <TodoPanel title="Your to-dos" />
        </div>
      </div>
    </>
  );
}
