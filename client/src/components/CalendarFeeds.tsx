// Settings → Synced calendars: add a Google Calendar by its secret iCal
// address so its events (shoots, calls…) show on the Calendar. Read-only:
// changes made in Google show up here within 15 minutes.

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { api, useSave } from '../api';
import type { CalendarFeed } from '../../../shared/types';
import { fmtAgo, plural } from '../../../shared/format';
import { Button, Dialog, Field, FormError, inputProps, Panel, Seg, useFieldId, useToast } from './ui';

const COLORS = ['#9CC7F7', '#60D1BE', '#F4ED70', '#F2A599', '#B8A6FF', '#E77AB5', '#FFB38A', '#A2A2AD'];

export function CalendarFeedsPanel() {
  const toast = useToast();
  const q = useQuery({ queryKey: ['calendar-feeds'], queryFn: () => api<{ feeds: CalendarFeed[] }>('/api/calendar-feeds') });
  const [edit, setEdit] = useState<CalendarFeed | 'new' | null>(null);
  const sync = useSave((id: number) => api<{ result: { ok: boolean; count: number; error: string | null } }>(`/api/calendar-feeds/${id}/sync`, { body: {} }), {
    onSuccess: (o) => toast(o.result.ok ? `Synced · ${plural(o.result.count, 'event')}` : `Couldn’t sync: ${o.result.error}`),
  });
  const remove = useSave((f: CalendarFeed) => api(`/api/calendar-feeds/${f.id}`, { method: 'DELETE' }), { onSuccess: (_o, f) => toast(`Stopped syncing ${f.name}`) });
  const feeds = q.data?.feeds ?? [];
  return (
    <Panel title="Synced calendars" sub="Google Calendar on the Calendar page" tools={<Button variant="sm" icon={<Plus aria-hidden />} onClick={() => setEdit('new')}>Add calendar</Button>}>
      {q.data && !feeds.length && <p className="muted" style={{ fontSize: 13.5 }}>Show a Google Calendar’s shoots and calls on the Calendar. It stays in sync on its own.</p>}
      <div className="rows">
        {feeds.map((f) => (
          <div key={f.id} className={`item${f.lastError ? ' edge-red' : ''}`} style={{ boxShadow: f.lastError ? undefined : `inset 3px 0 0 ${f.color}` }}>
            <div className="body">
              <div className="row-flex s2"><CalendarDays size={15} aria-hidden color={f.color} /><span className="title">{f.name}</span></div>
              <div className="meta"><span className="ellipsis">{f.urlHint}</span></div>
              <div className="meta">
                <span>{f.visibility === 'everyone' ? 'Everyone sees it' : 'Admins and managers only'}</span>
                <span>{plural(f.eventCount, 'event')}</span>
                <span>{f.lastSyncedAt ? `synced ${fmtAgo(f.lastSyncedAt)}` : 'not synced yet'}</span>
              </div>
              {f.lastError && <div className="meta" style={{ color: 'var(--red)' }}>{f.lastError}</div>}
            </div>
            <div className="side" style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Button variant="sm" icon={<RefreshCw aria-hidden />} busy={sync.isPending && sync.variables === f.id} onClick={() => sync.mutate(f.id)}>Sync now</Button>
              <button type="button" className="icon-btn sm" aria-label={`Edit ${f.name}`} onClick={() => setEdit(f)}><Pencil /></button>
              <button type="button" className="icon-btn sm" aria-label={`Remove ${f.name}`} onClick={() => { if (window.confirm(`Stop syncing “${f.name}”? Its events disappear from the Calendar. Google Calendar isn’t changed.`)) remove.mutate(f); }}><Trash2 /></button>
            </div>
          </div>
        ))}
      </div>
      {edit && <FeedDialog feed={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </Panel>
  );
}

function FeedDialog({ feed, onClose }: { feed: CalendarFeed | null; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(feed?.name ?? '');
  const [url, setUrl] = useState('');
  const [color, setColor] = useState(feed?.color ?? COLORS[0]);
  const [visibility, setVisibility] = useState<CalendarFeed['visibility']>(feed?.visibility ?? 'managers');
  const ids = { n: useFieldId('cal-name'), u: useFieldId('cal-url') };
  const save = useSave(() => feed
    ? api<{ feed: CalendarFeed }>(`/api/calendar-feeds/${feed.id}`, { method: 'PATCH', body: { name, color, visibility, ...(url.trim() ? { url } : {}) } })
    : api<{ feed: CalendarFeed; result: { count: number } }>('/api/calendar-feeds', { body: { name, url, color, visibility } }), {
    onSuccess: (o) => { toast(feed ? 'Calendar updated' : `Synced ${name} · ${plural((o as { result?: { count: number } }).result?.count ?? 0, 'event')}`); onClose(); },
  });
  const f = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={feed ? `Edit ${feed.name}` : 'Add a Google Calendar'} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} disabled={!name.trim() || (!feed && !url.trim())} onClick={() => save.mutate(undefined)}>{feed ? 'Save' : 'Add and sync'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        {!feed && (
          <ol className="howto">
            <li>Open <a href="https://calendar.google.com/calendar/r/settings" target="_blank" rel="noopener noreferrer">Google Calendar settings</a> on a computer, signed in to the account that owns the calendar (or has it shared with full access).</li>
            <li>On the left, under <b>Settings for my calendars</b>, click the calendar (e.g. Joshua Shalamov).</li>
            <li>Scroll to <b>Integrate calendar</b> and copy the <b>Secret address in iCal format</b> (it ends in <code>.ics</code>).</li>
            <li>Paste it below. Keep it private: anyone with the link can see the calendar.</li>
          </ol>
        )}
        <Field label="Name" htmlFor={ids.n} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Joshua’s calendar" {...inputProps(ids.n, f.name)} /></Field>
        <Field label={feed ? 'New secret address' : 'Secret address in iCal format'} optional={!!feed} htmlFor={ids.u} error={f.url}
          help={feed ? `Now: ${feed.urlHint}. Paste a new one only if you reset it in Google.` : undefined}>
          <input className="input" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autoComplete="off" spellCheck={false} {...inputProps(ids.u, f.url)} />
        </Field>
        <div className="field"><span className="lbl">Colour on the Calendar</span>
          <div className="swatches" role="radiogroup" aria-label="Colour">
            {COLORS.map((c) => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={c} className={`swatch${color === c ? ' on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
          </div>
        </div>
        <div className="field"><span className="lbl">Who sees it</span>
          <Seg role="group" aria-label="Who sees it" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={visibility === 'managers'} onClick={() => setVisibility('managers')}>Admins & managers</button>
            <button type="button" aria-pressed={visibility === 'everyone'} onClick={() => setVisibility('everyone')}>Everyone</button>
          </Seg>
          <span className="help">Writers only see it if you pick Everyone. They see event titles, times, places and notes.</span>
        </div>
      </form>
    </Dialog>
  );
}
