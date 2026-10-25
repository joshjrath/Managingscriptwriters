// Overview and Calendar (admins and managers): the next shoot for each client whose last shoot is over with nothing
// booked after it. Claude estimates it from the client's past shoots on the site and on the synced calendars, their
// scripts and documents, and Timeliner (the site's own rule stands in until it has). Each says when its scripts are
// due and who to give them to (last time's writers, each with their share). Documents not counted yet and clients
// whose history changed are sent to Claude by themselves when the panel opens.
//
// Confirm books it (the New shoot form, filled in, to check and save), Change sets your own date and count, Deny
// hides it until the client shoots again. A client filmed without scripts gets a date and nothing to write.

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarClock, Camera, Check, EyeOff, PenLine, RotateCcw, Sparkles, X } from 'lucide-react';
import { api, useSave } from '../api';
import type { ShootForecast, ShootForecasts } from '../../../shared/types';
import { fmtDate, fmtRange, fmtWeekday, plural, relDay } from '../../../shared/format';
import { weekendName } from '../../../shared/dates';
import { useBoot, useNewWork } from './Shell';
import { Button, Chip, DateTile, Dialog, Field, FormError, inputProps, Panel, useFieldId, useToast } from './ui';

/** Confirm: the New shoot form with the estimate filled in (the client, the date, the count and last time's writers), to check and save. */
export function usePlanForecast() {
  const openNew = useNewWork();
  return (f: ShootForecast) => {
    const e = f.estimate;
    openNew('shoot', {
      clientId: f.clientId, start: e?.shootDate, noScripts: !f.scriptsRequired,
      count: e?.scripts ?? undefined, split: e?.writers.map((w) => ({ writerId: w.writerId, count: w.count })),
    });
  };
}

const SOURCE: Record<NonNullable<ShootForecast['estimate']>['source'], string> = { ai: 'AI estimate', manager: 'Changed by you', rule: 'Site estimate' };

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

/** What the scripts need, in one line: "45 scripts due Fri, Nov 13 · drafts Wed, Nov 11", or "No scripts needed". */
function ScriptsLine({ f }: { f: ShootForecast }) {
  const e = f.estimate!;
  if (!f.scriptsRequired || !e.finalDue || !e.draftDue) return <div className="meta"><span>No scripts needed: just the shoot</span></div>;
  return (
    <div className="meta num">
      <span><b style={{ color: 'var(--text)' }}>{e.scripts ? plural(e.scripts, 'script') : 'Scripts'}</b> due {fmtWeekday(e.finalDue)}{e.scripts ? '' : ' (how many isn’t known yet)'}</span>
      <span>drafts {fmtWeekday(e.draftDue)}</span>
      {e.late && <Chip color="red">Behind: these scripts would be due already</Chip>}
    </div>
  );
}

/** Where the estimate comes from: "AI estimate · medium confidence". */
function SourceChip({ e }: { e: NonNullable<ShootForecast['estimate']> }) {
  return <Chip color={e.source === 'manager' ? 'mint' : 'plain'} icon={e.source === 'ai' ? <Sparkles aria-hidden /> : e.source === 'manager' ? <Check aria-hidden /> : undefined}>{SOURCE[e.source]}{e.confidence ? ` · ${e.confidence} confidence` : ''}</Chip>;
}

/** Confirm, Change and Deny for one estimate. */
function Decisions({ f, onChange, onDone }: { f: ShootForecast; onChange: () => void; onDone?: () => void }) {
  const plan = usePlanForecast();
  const toast = useToast();
  const deny = useSave((undo: boolean) => api<ShootForecasts>(`/api/shoot-forecast/${f.clientId}/deny`, { body: { undo } }), {
    onSuccess: (_o, undo) => {
      if (undo) toast(`Back on the list: ${f.clientName}`);
      else toast(`Denied: ${f.clientName}’s next shoot estimate`, 'ok', { label: 'Undo', run: () => deny.mutate(true) });
      onDone?.();
    },
  });
  return (
    <div className="row-flex s2" style={{ flexWrap: 'wrap', justifyContent: 'flex-end' }}>
      <Button variant="sm primary" icon={<Check aria-hidden />} onClick={() => { onDone?.(); plan(f); }} title="Book this shoot: the New shoot form opens with this filled in">{f.estimate ? 'Confirm' : 'Schedule a shoot'}</Button>
      <Button variant="sm" icon={<PenLine aria-hidden />} onClick={onChange}>{f.estimate ? 'Change' : 'Set a date'}</Button>
      {f.estimate && <Button variant="sm ghost" icon={<X aria-hidden />} busy={deny.isPending} onClick={() => deny.mutate(false)} title="Wrong, or not shooting again soon: hide it until this client’s next shoot">Deny</Button>}
    </div>
  );
}

/** Change: your own date and script count (kept until the client's next shoot), and whether the client needs scripts at all. */
function ChangeDialog({ f, onClose }: { f: ShootForecast; onClose: () => void }) {
  const toast = useToast();
  const e = f.estimate;
  const [date, setDate] = useState<string>(e?.shootDate ?? '');
  const [count, setCount] = useState<number | ''>(e?.scripts ?? '');
  const [needs, setNeeds] = useState(f.scriptsRequired);
  const ids = { d: useFieldId('d'), c: useFieldId('c') };
  const save = useSave(async () => {
    // the client's setting first, so the estimate is saved the way it will show
    if (needs !== f.scriptsRequired) await api(`/api/clients/${f.clientId}`, { method: 'PATCH', body: { scriptsRequired: needs } });
    return api<ShootForecasts>(`/api/shoot-forecast/${f.clientId}/change`, { body: { shootDate: date, scripts: needs && count ? Number(count) : null } });
  }, { onSuccess: () => { toast(`${f.clientName}: next shoot ${fmtDate(date)}`); onClose(); } });
  const err = save.error?.fields ?? {};
  const weekend = weekendName(date);
  return (
    <Dialog open onClose={onClose} size="narrow" title={`${f.clientName} · next shoot`} sub="Your date stays until this client’s next shoot is over. It isn’t booked until you confirm it."
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" disabled={!date} busy={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></div>}>
      <div className="form">
        <FormError error={save.error && !Object.keys(err).length ? save.error : null} />
        <Field label="Shoot date" htmlFor={ids.d} error={err.shootDate} help={weekend ? `That’s a ${weekend}.` : undefined}>
          <input className="input" type="date" value={date} onChange={(x) => setDate(x.target.value)} {...inputProps(ids.d, err.shootDate)} />
        </Field>
        <label className="check"><input type="checkbox" checked={!needs} onChange={(x) => setNeeds(!x.target.checked)} />No scripts needed: we film {f.clientName} without scripts</label>
        {needs && (
          <Field label="Scripts needed" optional htmlFor={ids.c} error={err.scripts} help={e?.scripts ? `The estimate was ${e.scripts}.` : undefined}>
            <input className="input num" type="number" min={1} max={500} style={{ maxWidth: 160 }} value={count} onChange={(x) => setCount(x.target.value === '' ? '' : Number(x.target.value))} {...inputProps(ids.c, err.scripts)} />
          </Field>
        )}
      </div>
    </Dialog>
  );
}

export function ShootForecastPanel() {
  const { clock } = useBoot();
  const toast = useToast();
  const q = useQuery({ queryKey: ['shoot-forecast'], queryFn: () => api<ShootForecasts>('/api/shoot-forecast'), refetchInterval: 5 * 60_000 });
  const [changing, setChanging] = useState<ShootForecast | null>(null);
  const [showDenied, setShowDenied] = useState(false);
  // first the documents not counted yet, then Claude's estimates for the clients whose history changed; each stops
  // when a round does nothing (so a document or an answer that never comes can't loop)
  const [stopped, setStopped] = useState({ read: false, estimate: false });
  const read = useSave(() => api<ShootForecasts & { read: number; busy: boolean }>('/api/shoot-forecast/read-documents', { method: 'POST' }), {
    onSuccess: (out) => { if (!out.read && !out.busy) setStopped((s) => ({ ...s, read: true })); },
  });
  const estimate = useSave(() => api<ShootForecasts & { estimated: number; busy: boolean }>('/api/shoot-forecast/estimate', { method: 'POST' }), {
    onSuccess: (out) => { if (!out.estimated && !out.busy) setStopped((s) => ({ ...s, estimate: true })); },
  });
  const unread = q.data?.documents.canRead && !stopped.read && !read.isError ? q.data.documents.unread : 0;
  const stale = q.data?.estimates.canEstimate && !stopped.estimate && !estimate.isError ? q.data.estimates.stale : 0;
  const busy = read.isPending || estimate.isPending;
  useEffect(() => {
    if (busy) return;
    if (unread > 0) read.mutate(undefined);
    else if (stale > 0) estimate.mutate(undefined);
  }, [unread, stale, busy, read, estimate]);
  const undo = useSave((f: ShootForecast) => api<ShootForecasts>(`/api/shoot-forecast/${f.clientId}/deny`, { body: { undo: true } }), {
    onSuccess: (_o, f) => toast(`Back on the list: ${f.clientName}`),
  });
  const list = q.data?.forecasts ?? [];
  const denied = q.data?.denied ?? [];
  if (!list.length && !denied.length) return null;
  const working = unread > 0 ? `Counting scripts in ${plural(unread, 'document')}…` : stale > 0 ? `AI is estimating ${plural(stale, 'client')}…` : null;
  return (
    <Panel className="forecast" title="Next shoots to book" count={list.length} sub="last shoot over, nothing booked yet · estimated from past shoots, calendars and Timeliner"
      tools={<>
        {working && <Chip color="tentative" icon={<Sparkles aria-hidden />}>{working}</Chip>}
        {denied.length > 0 && <button type="button" className="btn sm ghost" aria-expanded={showDenied} onClick={() => setShowDenied(!showDenied)}><EyeOff aria-hidden />{showDenied ? 'Hide denied' : `Denied (${denied.length})`}</button>}
      </>}>
      {!list.length && <p className="muted" style={{ fontSize: 13.5 }}>Every estimate here was denied.</p>}
      <div className="rows">
        {list.map((f) => {
          const e = f.estimate;
          const days = e?.finalDue ? Math.round((Date.parse(e.finalDue) - Date.parse(clock.today)) / 86400000) : null;
          return (
            <div key={f.clientId} className={`item with-tile ${e?.late ? 'edge-red' : days != null && days <= 7 ? 'edge-yellow' : ''}`}>
              {e ? <DateTile date={e.shootDate} color="var(--tentative)" /> : <DateTile date={f.lastShoot.startDate} />}
              <div className="body">
                <div className="top">
                  <Camera size={13} aria-hidden /> Last shoot {fmtRange(f.lastShoot.startDate, f.lastShoot.endDate)}
                  {!f.lastShoot.onSite ? ' · on the calendar' : f.scriptsRequired ? ` · ${plural(f.lastShoot.scripts, 'script')}${f.lastShoot.fromDocument ? ` in its document${f.lastShoot.siteScripts !== f.lastShoot.scripts ? ` (${f.lastShoot.siteScripts} on the site)` : ''}` : ''}` : ''}
                  {f.pastShoots > 1 ? ` · ${f.pastShoots} past shoots` : ''}
                </div>
                <div className="title">{f.clientName}{!f.scriptsRequired && <> <Chip color="neutral">No scripts</Chip></>}</div>
                {e ? (
                  <>
                    <div className="meta">
                      <Chip color="tentative" icon={<CalendarClock aria-hidden />}>Tentative shoot {fmtWeekday(e.shootDate)}</Chip>
                      <span>{relDay(e.shootDate, clock.today)}</span>
                      <SourceChip e={e} />
                      {e.updating && e.source !== 'manager' && <span className="muted">updating…</span>}
                    </div>
                    <ScriptsLine f={f} />
                    <AssignLine f={f} />
                    {e.why && <div className="meta muted" style={{ fontSize: 12 }}>{e.why}</div>}
                  </>
                ) : (
                  <div className="meta muted">{stale > 0 ? 'The AI is looking at this client’s history…' : 'Not enough history to estimate the next one yet. Set a date if you know it.'}</div>
                )}
              </div>
              <div className="side"><Decisions f={f} onChange={() => setChanging(f)} /></div>
            </div>
          );
        })}
      </div>
      {showDenied && denied.length > 0 && (
        <div className="rows" style={{ marginTop: 12 }}>
          <div className="section-title">Denied: hidden until the client’s next shoot</div>
          {denied.map((f) => (
            <div key={f.clientId} className="item" style={{ opacity: 0.8 }}>
              <div className="body"><div className="title">{f.clientName}</div><div className="meta"><span>Last shoot {fmtRange(f.lastShoot.startDate, f.lastShoot.endDate)}</span>{f.estimate && <span>estimate was {fmtWeekday(f.estimate.shootDate)}</span>}</div></div>
              <div className="side"><Button variant="sm" icon={<RotateCcw aria-hidden />} busy={undo.isPending} onClick={() => undo.mutate(f)}>Bring back</Button></div>
            </div>
          ))}
        </div>
      )}
      {changing && <ChangeDialog f={changing} onClose={() => setChanging(null)} />}
    </Panel>
  );
}

/** A tentative shoot (or its scripts' due date) tapped on the calendar. */
export function ForecastDialog({ f, onClose }: { f: ShootForecast; onClose: () => void }) {
  const { clock } = useBoot();
  const [changing, setChanging] = useState(false);
  const e = f.estimate!;
  if (changing) return <ChangeDialog f={f} onClose={onClose} />;
  return (
    <Dialog open onClose={onClose} size="narrow" title={`${f.clientName} · tentative shoot`} sub={`${fmtWeekday(e.shootDate)} · ${relDay(e.shootDate, clock.today)} · an estimate, not booked`}
      footer={<div className="form-actions"><Decisions f={f} onChange={() => setChanging(true)} onDone={onClose} /></div>}>
      <div className="stack s3" style={{ fontSize: 13.5 }}>
        <div><SourceChip e={e} /></div>
        <div className="rows"><div className="item"><div className="body"><ScriptsLine f={f} /><AssignLine f={f} /></div></div></div>
        {e.why && <p className="muted">{e.why}</p>}
        <p className="muted">Confirm opens the New shoot form with this filled in, to check and save. Change sets your own date; Deny hides it until {f.clientName}’s next shoot.</p>
      </div>
    </Dialog>
  );
}
