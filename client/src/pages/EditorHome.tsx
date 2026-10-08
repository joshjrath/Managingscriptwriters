// Editors' home: what's coming up (shoots, and when each batch's scripts are
// final), the newest finished scripts to cut from, and their to-dos. Everything
// here is read-only; the scripts open straight from the Script bank.

import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Camera, CalendarDays, Library, Send } from 'lucide-react';
import { api, qs } from '../api';
import type { CalendarEvent, ScriptBankPage } from '../../../shared/types';
import { addDays } from '../../../shared/dates';
import { fmtRange, plural } from '../../../shared/format';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { DateTile, Empty, ErrorState, Loading, Panel } from '../components/ui';
import { TodoPanel } from '../components/Todos';
import { DeliverableRow } from './ScriptBank';

const LOOKS_LIKE_SHOOT = /\b(shoots?|shooting|filming|film day|photo ?shoot|video ?shoot|content day|production day)\b/i;

export function EditorHome() {
  const { me, clock, clients } = useBoot();
  const tz = useDisplayTz();
  const nav = useNavigate();
  const to = addDays(clock.today, 27);
  const cal = useQuery({
    queryKey: ['calendar', clock.today, to, 'editor-home'],
    queryFn: () => api<{ events: CalendarEvent[] }>(`/api/calendar${qs({ from: clock.today, to })}`),
  });
  const ready = useQuery({ queryKey: ['script-bank', 'editor-home'], queryFn: () => api<ScriptBankPage>(`/api/script-bank${qs({ status: 'finished', limit: 10 })}`) });
  const upcoming = (cal.data?.events ?? [])
    .filter((e) => e.type === 'shoot' || e.type === 'final' || (e.type === 'external' && LOOKS_LIKE_SHOOT.test(e.title)))
    .filter((e) => e.end >= clock.today)
    .sort((a, b) => a.start.localeCompare(b.start) || (a.type === 'shoot' ? -1 : 1));
  const clientOf = (name: string) => clients.find((c) => c.name === name)?.id;
  const open = (e: CalendarEvent) => {
    const id = e.external ? undefined : clientOf(e.clientName);
    if (id) nav(`/scripts?clientId=${id}`);
  };

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
          <Panel title="Coming up" sub="next 4 weeks" tools={<Link to="/calendar" className="btn sm ghost">Calendar <ArrowRight size={14} aria-hidden /></Link>}>
            {cal.isLoading && <Loading height={200} />}
            {cal.isError && <ErrorState error={cal.error} retry={() => cal.refetch()} />}
            {cal.data && !upcoming.length && <Empty boxed icon={<Camera />} title="No shoots in the next 4 weeks" />}
            <div className="rows">
              {upcoming.slice(0, 12).map((e) => {
                const kind = e.type === 'shoot' ? { label: 'Shoot', icon: <Camera size={13} aria-hidden />, c: 'var(--salmon)' }
                  : e.type === 'final' ? { label: 'Final delivery', icon: <Send size={13} aria-hidden />, c: 'var(--yellow)' }
                  : { label: e.external!.feedName, icon: <CalendarDays size={13} aria-hidden />, c: e.external!.color };
                const clickable = !e.external && !!clientOf(e.clientName);
                return (
                  <div key={e.id} className={`item with-tile${clickable ? ' clickable' : ''}`} onClick={clickable ? () => open(e) : undefined}
                    role={clickable ? 'link' : undefined} tabIndex={clickable ? 0 : undefined} onKeyDown={clickable ? (k) => { if (k.key === 'Enter') open(e); } : undefined}>
                    <DateTile date={e.start} color={kind.c} />
                    <div className="body">
                      <div className="top" style={{ color: kind.c, fontWeight: 700, display: 'flex', gap: 5, alignItems: 'center' }}>{kind.icon}{kind.label}</div>
                      <div className="title">{e.external ? e.title : e.clientName}</div>
                      <div className="meta">
                        <span>{fmtRange(e.start, e.end !== e.start ? e.end : null)}</span>
                        {!e.external && <span className="ellipsis">{e.title}</span>}
                        {e.external?.location && <span className="ellipsis">{e.external.location}</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {upcoming.length > 12 && <p className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>{plural(upcoming.length - 12, 'more')} on the Calendar.</p>}
          </Panel>
          <TodoPanel title="Your to-dos" />
        </div>
      </div>
    </>
  );
}
