// Overview (admins and managers): shoots on a synced Google Calendar that
// aren't planned on the site yet. Each one opens the New shoot form already
// filled in (client, dates, and last time's script count and writers), or the
// batch when only the writers are missing.

import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, UserPlus, X } from 'lucide-react';
import { api, useSave } from '../api';
import type { CalendarShoot } from '../../../shared/types';
import { fmtRange, plural } from '../../../shared/format';
import { useBoot, useNewWork } from './Shell';
import { Button, DateTile, Panel, useToast } from './ui';

const WHY: Record<CalendarShoot['status'], string> = {
  no_shoot: 'Not on the site yet',
  no_scripts: 'On the site, no scripts planned',
  unassigned: 'Scripts without a writer',
};

export function CalendarShootsPanel() {
  const { clock } = useBoot();
  const openNew = useNewWork();
  const toast = useToast();
  const q = useQuery({ queryKey: ['calendar-shoots'], queryFn: () => api<{ shoots: CalendarShoot[] }>('/api/calendar-shoots'), refetchInterval: 5 * 60_000 });
  const dismiss = useSave((s: CalendarShoot) => api('/api/calendar-shoots/dismiss', { body: { uid: s.uid } }), {
    onSuccess: (_o, s) => toast(`Hidden: ${s.title}`),
  });
  const list = q.data?.shoots ?? [];
  if (!list.length) return null;
  const feed = list[0].feedName;
  const plan = (s: CalendarShoot) => {
    if (s.status === 'no_shoot') {
      openNew('shoot', {
        clientId: s.client?.id, start: s.start, end: s.end !== s.start ? s.end : null,
        count: s.suggested?.count, split: s.suggested?.split.map((x) => ({ writerId: x.writerId, count: x.count })),
      });
    } else if (s.status === 'no_scripts') {
      openNew('batch', { clientId: s.client?.id, shootId: s.shootId ?? undefined, count: s.suggested?.count, split: s.suggested?.split.map((x) => ({ writerId: x.writerId, count: x.count })) });
    }
  };
  return (
    <Panel className="cal-shoots" title="Shoots that need writers" count={list.length} sub={`from ${new Set(list.map((s) => s.feedName)).size > 1 ? 'your synced calendars' : feed}`}>
      <div className="rows">
        {list.map((s) => {
          const days = Math.round((Date.parse(s.start) - Date.parse(clock.today)) / 86400000);
          return (
            <div key={s.uid} className={`item with-tile ${days <= 7 ? 'edge-red' : days <= 14 ? 'edge-yellow' : ''}`}>
              <DateTile date={s.start} color={s.color} />
              <div className="body">
                <div className="top"><CalendarDays size={13} aria-hidden style={{ color: s.color }} /> {s.title}</div>
                <div className="title">{s.client ? s.client.name : <span className="muted">Which client? Pick it when you plan</span>}</div>
                <div className="meta">
                  <span>{fmtRange(s.start, s.end !== s.start ? s.end : null)}</span>
                  <span>{days <= 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}</span>
                  <span className="chip pink">{s.status === 'unassigned' ? `${plural(s.unassigned, 'script')} without a writer` : WHY[s.status]}</span>
                </div>
                {s.suggested && s.status !== 'unassigned' && (
                  <div className="meta">Last time: {plural(s.suggested.count, 'script')}{s.suggested.split.length ? ` · ${s.suggested.split.map((x) => `${x.name.split(' ')[0]} ${x.count}`).join(', ')}` : ''}</div>
                )}
              </div>
              <div className="side row-flex s2" style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
                {s.status === 'unassigned' && s.batchId
                  ? <Link to={`/batches/${s.batchId}#scripts`} className="btn sm primary"><UserPlus aria-hidden />Assign writers</Link>
                  : <Button variant="sm primary" icon={<UserPlus aria-hidden />} onClick={() => plan(s)}>Plan scripts</Button>}
                <button type="button" className="icon-btn sm" title="Not a shoot we write for: hide it" aria-label={`Hide ${s.title}`} onClick={() => dismiss.mutate(s)}><X /></button>
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
