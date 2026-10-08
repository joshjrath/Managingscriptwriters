// Overview (admins and managers): every shoot that still needs planning, in
// one list. Shoots on a synced Google Calendar that aren't on the site yet
// open the New shoot form already filled in (client, dates, and last time's
// script count and writers), or the batch when only the writers are missing;
// shoots made on the site with no scripts yet open a new batch for them.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { CalendarDays, Camera, EyeOff, RotateCcw, UserPlus } from 'lucide-react';
import { api, useSave } from '../api';
import type { BatchSummary, CalendarShoot, Shoot } from '../../../shared/types';
import { fmtRange, plural } from '../../../shared/format';
import { useBoot, useNewWork } from './Shell';
import { Button, DateTile, Panel, useToast } from './ui';

const WHY: Record<CalendarShoot['status'], string> = {
  no_shoot: 'Not on the site yet',
  no_scripts: 'On the site, no scripts planned',
  unassigned: 'Scripts without a writer',
};

/** "Shoot – Elegant Jeweler" → "Elegant Jeweler": a starting point for a client that isn't on the site yet. */
const nameFromTitle = (t: string) => t.replace(/\b(photo ?shoot|video ?shoot|shoots?|shooting|filming|film day|content day|production day|session)\b/gi, '').replace(/\([^)]*\)/g, '').replace(/\s+and\s+.*$/i, '').replace(/^[\s–—:·-]+|[\s–—:·-]+$/g, '').replace(/\s{2,}/g, ' ').trim();

export function CalendarShootsPanel({ siteShoots = [], batches = [] }: { siteShoots?: (Shoot & { daysUntil: number })[]; batches?: BatchSummary[] }) {
  const { clock } = useBoot();
  const openNew = useNewWork();
  const toast = useToast();
  const q = useQuery({ queryKey: ['calendar-shoots'], queryFn: () => api<{ shoots: CalendarShoot[]; hidden: CalendarShoot[] }>('/api/calendar-shoots'), refetchInterval: 5 * 60_000 });
  const [showHidden, setShowHidden] = useState(false);
  const mark = useSave((v: { s: CalendarShoot; undo: boolean }) => api('/api/calendar-shoots/dismiss', { body: { uid: v.s.uid, undo: v.undo } }), {
    onSuccess: (_o, v) => {
      if (v.undo) toast(`Back on the list: ${v.s.title}`);
      else toast(`Hidden: ${v.s.title}`, 'ok', { label: 'Undo', run: () => mark.mutate({ s: v.s, undo: true }) });
    },
  });
  // a batch for the same client with no shoot is probably meant for it
  const link = useSave((v: { batch: BatchSummary; shoot: Shoot }) => api(`/api/batches/${v.batch.id}`, { method: 'PATCH', body: { shootId: v.shoot.id } }), {
    onSuccess: (_o, v) => toast(`Linked “${v.batch.title}” to the ${fmtRange(v.shoot.startDate, v.shoot.endDate)} shoot`),
  });
  const list = q.data?.shoots ?? [];
  const hidden = q.data?.hidden ?? [];
  // site shoots with no scripts, unless the calendar list already has them
  const site = siteShoots.filter((s) => !list.some((c) => c.shootId === s.id));
  if (!list.length && !hidden.length && !site.length) return null;
  const feed = (list[0] ?? hidden[0])?.feedName;
  const from = [feed ? (new Set(list.map((s) => s.feedName)).size > 1 ? 'your synced calendars' : feed) : null, site.length ? 'shoots on the site' : null].filter(Boolean).join(' and ');
  const plan = (s: CalendarShoot) => {
    if (s.status === 'no_shoot') {
      openNew('shoot', {
        clientId: s.client?.id, newClientName: s.client ? undefined : nameFromTitle(s.title) || undefined, calendarUid: s.uid, title: s.title,
        start: s.start, end: s.end !== s.start ? s.end : null,
        count: s.suggested?.count, split: s.suggested?.split.map((x) => ({ writerId: x.writerId, count: x.count })),
      });
    } else if (s.status === 'no_scripts') {
      openNew('batch', { clientId: s.client?.id, shootId: s.shootId ?? undefined, count: s.suggested?.count, split: s.suggested?.split.map((x) => ({ writerId: x.writerId, count: x.count })) });
    }
  };
  return (
    <Panel className="cal-shoots" title="Shoots to plan" count={list.length + site.length} sub={`from ${from}`}
      tools={hidden.length ? <button type="button" className="btn sm ghost" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}><EyeOff aria-hidden />{showHidden ? 'Hide the hidden ones' : `Hidden (${hidden.length})`}</button> : undefined}>
      {!list.length && !site.length && <p className="muted" style={{ fontSize: 13.5 }}>Every shoot on the calendar is planned.</p>}
      <div className="rows">
        {site.map((s) => (
          <div key={`site${s.id}`} className={`item with-tile ${s.daysUntil <= 7 ? 'edge-red' : s.daysUntil <= 14 ? 'edge-yellow' : ''}`}>
            <DateTile date={s.startDate} />
            <div className="body">
              <div className="top"><Camera size={13} aria-hidden /> {s.title || 'Shoot'}</div>
              <div className="title">{s.clientName}</div>
              <div className="meta">
                <span>{fmtRange(s.startDate, s.endDate)}</span>
                <span>{s.daysUntil <= 0 ? 'today' : s.daysUntil === 1 ? 'tomorrow' : `in ${s.daysUntil} days`}</span>
                <span className="chip pink">{WHY.no_scripts}</span>
              </div>
              {batches.filter((b) => b.clientId === s.clientId && b.shootId == null).slice(0, 2).map((b) => (
                <div key={b.id} className="meta">
                  <span>“{b.title}” has no shoot.</span>
                  <button type="button" className="linkbtn" disabled={link.isPending} onClick={() => link.mutate({ batch: b, shoot: s })}>Link it to this shoot</button>
                </div>
              ))}
            </div>
            <div className="side row-flex s2" style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'nowrap' }}>
              <Button variant="sm primary" icon={<UserPlus aria-hidden />} onClick={() => openNew('batch', { clientId: s.clientId, shootId: s.id })}>Plan scripts</Button>
            </div>
          </div>
        ))}
        {list.map((s) => {
          const days = Math.round((Date.parse(s.start) - Date.parse(clock.today)) / 86400000);
          return (
            <div key={s.uid} className={`item with-tile ${days <= 7 ? 'edge-red' : days <= 14 ? 'edge-yellow' : ''}`}>
              <DateTile date={s.start} color={s.color} />
              <div className="body">
                <div className="top"><CalendarDays size={13} aria-hidden style={{ color: s.color }} /> {s.title}</div>
                <div className="title">{s.client ? s.client.name : <span className="muted">{nameFromTitle(s.title) ? `New client? Plan scripts adds “${nameFromTitle(s.title)}”` : 'Which client? Pick it when you plan'}</span>}</div>
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
                <button type="button" className="btn sm ghost cal-hide" title="Not a shoot we write for: hide it (you can bring it back)" aria-label={`Hide ${s.title}`} onClick={() => mark.mutate({ s, undo: false })}><EyeOff aria-hidden />Not ours</button>
              </div>
            </div>
          );
        })}
      </div>
      {showHidden && hidden.length > 0 && (
        <div className="rows" style={{ marginTop: 12 }}>
          <div className="section-title">Hidden: not shoots we write for</div>
          {hidden.map((s) => (
            <div key={s.uid} className="item" style={{ opacity: 0.8 }}>
              <div className="body"><div className="title">{s.title}</div><div className="meta"><span>{fmtRange(s.start, s.end !== s.start ? s.end : null)}</span></div></div>
              <div className="side"><Button variant="sm" icon={<RotateCcw aria-hidden />} onClick={() => mark.mutate({ s, undo: true })}>Show again</Button></div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}
