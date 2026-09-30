// People: where everyone on the globe works from, set from inside the Control
// Center. The admin places team members (city, time zone, working hours) and
// adds editors, who appear here with their local time but never use the
// platform. Only the admin can open the Control Center, so only they see this.

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api';
import type { Editor, UserSummary } from '../../../shared/types';
import { CITIES, cityLabel, findCity, shiftLength, shiftOf, timeZoneList, zoneOffset, type City } from '../../../shared/cities';
import { localClock, presenceOf } from '../../../shared/control';
import { ROLE_LABEL } from '../../../shared/workflow';

type Editing =
  | { kind: 'user'; user: UserSummary }
  | { kind: 'editor'; editor: Editor | null };

const p2 = (n: number) => String(n).padStart(2, '0');
const HOURS = Array.from({ length: 24 }, (_, h) => h);

export function People({ now, onClose, onPlaced }: { now: Date; onClose: () => void; onPlaced: (nodeId: string) => void }) {
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<{ users: UserSummary[] }>('/api/users') });
  const editors = useQuery({ queryKey: ['editors'], queryFn: () => api<{ editors: Editor[] }>('/api/editors') });
  const [editing, setEditing] = useState<Editing | null>(null);
  const team = (users.data?.users ?? []).filter((u) => u.active);
  const unplaced = team.filter((u) => !u.city).length;
  const root = useRef<HTMLElement>(null);
  // keyboard focus stays in the panel (so Esc works) when a form closes
  useEffect(() => { if (!editing) root.current?.focus({ preventScroll: true }); }, [editing]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    if (editing) setEditing(null);
    else onClose();
  };

  return (
    <section className="cc-people" role="dialog" aria-label="People" ref={root} tabIndex={-1} onKeyDown={onKey}>
      <header>
        <h2 className="cc-serif">{editing ? <>{editing.kind === 'user' ? editing.user.name : editing.editor?.name ?? 'New editor'}</> : <>People <em>on the map</em></>}</h2>
        <button onClick={() => (editing ? setEditing(null) : onClose())}>{editing ? '← PEOPLE' : 'CLOSE'} <kbd>ESC</kbd></button>
      </header>
      {editing
        ? <PlaceForm key={editing.kind === 'user' ? `u${editing.user.id}` : `e${editing.editor?.id ?? 'new'}`} editing={editing} now={now}
            onDone={(nodeId) => { setEditing(null); if (nodeId) onPlaced(nodeId); }} />
        : (
          <div className="list">
            <div className="group">
              <h3>TEAM <span>{p2(team.length)} ON THE PLATFORM{unplaced ? ` · ${p2(unplaced)} NOT ON THE MAP` : ''}</span></h3>
              {users.isError && <p className="err">COULDN’T LOAD THE TEAM</p>}
              <ul>
                {team.map((u) => (
                  <li key={u.id}>
                    <PersonRow name={u.name} kind={ROLE_LABEL[u.role].toUpperCase()} city={u.city} timezone={u.timezone} hours={u.workHours} now={now}
                      onClick={() => setEditing({ kind: 'user', user: u })} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="group">
              <h3>EDITORS <span>ONLY SHOWN HERE · NO SIGN-IN</span></h3>
              {editors.isError && <p className="err">COULDN’T LOAD THE EDITORS</p>}
              <ul>
                {(editors.data?.editors ?? []).map((e) => (
                  <li key={e.id}>
                    <PersonRow name={e.name} kind="EDITOR" city={e.city} timezone={e.timezone} hours={e.workHours} now={now}
                      onClick={() => setEditing({ kind: 'editor', editor: e })} />
                  </li>
                ))}
              </ul>
              <button className="add" onClick={() => setEditing({ kind: 'editor', editor: null })}>+ ADD AN EDITOR</button>
            </div>
            <p className="note">THE TIME ZONE FOLLOWS THE CITY UNLESS YOU CHANGE IT. IF SOMEONE’S CITY ISN’T LISTED, PICK THE NEAREST ONE AND SET THEIR TIME ZONE.</p>
          </div>
        )}
    </section>
  );
}

function PersonRow({ name, kind, city, timezone, hours, now, onClick }: {
  name: string; kind: string; city: string | null; timezone: string | null; hours: [number, number] | null; now: Date; onClick: () => void;
}) {
  const clock = timezone ? localClock(timezone, now) : null;
  return (
    <button className="row" onClick={onClick}>
      <span className="nm">{name.toUpperCase()}</span>
      <span className="tm">{clock ? clock.short : '——:——'}</span>
      <span className="where">
        {city
          ? <>{city.toUpperCase()}{timezone ? ` · ${clock?.offsetLabel}` : ''}{hours ? ` · ${fmtShift(hours)}` : ''}</>
          : <em>NOT ON THE MAP · SET A CITY</em>}
      </span>
      <span className="kind">{kind}</span>
    </button>
  );
}

const fmtShift = ([s, e]: [number, number]) => (e - s >= 24 ? 'AROUND THE CLOCK' : `${p2(s)}:00–${p2(e % 24)}:00`);

function PlaceForm({ editing, now, onDone }: { editing: Editing; now: Date; onDone: (nodeId: string | null) => void }) {
  const qc = useQueryClient();
  const start = editing.kind === 'user'
    ? { name: editing.user.name, city: editing.user.city ?? '', tz: editing.user.timezone ?? '', hours: editing.user.workHours ?? [9, 18] as [number, number] }
    : { name: editing.editor?.name ?? '', city: editing.editor?.city ?? '', tz: editing.editor?.timezone ?? '', hours: editing.editor?.workHours ?? [9, 18] as [number, number] };
  const [name, setName] = useState(start.name);
  const [city, setCity] = useState(start.city);
  const [tz, setTz] = useState(start.tz || findCity(start.city)?.timezone || '');
  const [hours, setHours] = useState<[number, number]>(start.hours);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; field?: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const known = findCity(city);
  const shift = shiftOf(hours[0], hours[1]);
  const zones = useMemo(() => { const l = timeZoneList(); return tz && !l.includes(tz) ? [tz, ...l] : l; }, [tz]);
  const offsets = useMemo(() => new Map(zones.map((z) => [z, zoneOffset(z)])), [zones]);
  const isEditor = editing.kind === 'editor';
  const placed = editing.kind === 'user' ? !!editing.user.city : !!editing.editor;

  const preview = known && tz
    ? presenceOf({ timezone: tz, workHours: shift, status: 'active', lastActivity: null, lat: known.lat, lon: known.lon }, now)
    : null;

  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['users'] }),
      qc.invalidateQueries({ queryKey: ['editors'] }),
      qc.refetchQueries({ queryKey: ['control-world'] }),
    ]);
  };

  const fail = (e: unknown) => {
    const err = e as ApiError;
    const field = Object.keys(err.fields ?? {})[0] as string | undefined;
    setMsg({ text: (field ? err.fields[field] : err.message || 'COULDN’T SAVE').toUpperCase(), field });
    setBusy(false);
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    if (isEditor && !name.trim()) { setMsg({ text: 'NAME REQUIRED', field: 'name' }); return; }
    if (!known) { setMsg({ text: 'PICK A CITY FROM THE LIST', field: 'city' }); return; }
    setBusy(true);
    setMsg({ text: 'TRANSMITTING' });
    const place = { city: cityLabel(known), timezone: tz || undefined, workStart: hours[0], workEnd: hours[1] % 24 || 24 };
    try {
      let nodeId: string;
      if (editing.kind === 'user') {
        await api(`/api/users/${editing.user.id}`, { method: 'PATCH', body: place });
        nodeId = `u${editing.user.id}`;
      } else if (editing.editor) {
        await api(`/api/editors/${editing.editor.id}`, { method: 'PATCH', body: { name: name.trim(), ...place } });
        nodeId = `e${editing.editor.id}`;
      } else {
        const out = await api<{ editors: Editor[] }>('/api/editors', { body: { name: name.trim(), ...place } });
        const added = out.editors.filter((x) => x.name === name.trim()).sort((a, b) => b.id - a.id)[0];
        nodeId = added ? `e${added.id}` : '';
      }
      await refresh();
      onDone(nodeId || null);
    } catch (err) { fail(err); }
  };

  const remove = async () => {
    if (!confirmRemove) { setConfirmRemove(true); return; }
    setBusy(true);
    try {
      if (editing.kind === 'user') await api(`/api/users/${editing.user.id}`, { method: 'PATCH', body: { city: null } });
      else if (editing.editor) await api(`/api/editors/${editing.editor.id}`, { method: 'DELETE' });
      await refresh();
      onDone(null);
    } catch (err) { fail(err); }
  };

  return (
    <form className="form" onSubmit={save}>
      {isEditor
        ? (
          <div className="cc-field">
            <label htmlFor="pp-name">NAME</label>
            <input id="pp-name" value={name} maxLength={120} autoComplete="off" spellCheck={false} autoFocus={!editing.editor}
              onChange={(e) => { setName(e.target.value); setMsg(null); }} aria-invalid={msg?.field === 'name'} />
          </div>
        )
        : <div className="fixed"><span>{ROLE_LABEL[editing.user.role].toUpperCase()}</span>{editing.user.email}</div>}

      <CityField value={city} autoFocus={!isEditor || !!editing.editor} invalid={msg?.field === 'city'}
        onChange={(v, c) => { setCity(v); setMsg(null); setConfirmRemove(false); if (c) setTz(c.timezone); }} />

      <div className="cc-field">
        <label htmlFor="pp-tz">TIME ZONE {known && tz && tz !== known.timezone ? <em>· CHANGED FROM {known.name.toUpperCase()}’S</em> : known ? '· FOLLOWS THE CITY' : ''}</label>
        <select id="pp-tz" value={tz} onChange={(e) => { setTz(e.target.value); setMsg(null); }} aria-invalid={msg?.field === 'timezone'}>
          {!tz && <option value="">PICK A CITY FIRST</option>}
          {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}{offsets.get(z) ? ` · ${offsets.get(z)}` : ''}</option>)}
        </select>
      </div>

      <div className="cc-field">
        <label htmlFor="pp-start">WORKING HOURS · THEIR LOCAL TIME · {shiftLength(shift).toUpperCase()}</label>
        <div className="hours">
          <select id="pp-start" value={hours[0]} onChange={(e) => { setHours([Number(e.target.value), hours[1]]); setMsg(null); }}>
            {HOURS.map((h) => <option key={h} value={h}>{p2(h)}:00</option>)}
          </select>
          <span>TO</span>
          <select aria-label="Working hours end" value={hours[1] % 24} onChange={(e) => { setHours([hours[0], Number(e.target.value)]); setMsg(null); }}>
            {HOURS.map((h) => <option key={h} value={h}>{p2(h)}:00</option>)}
          </select>
        </div>
        <small>THE SAME START AND END MEANS AROUND THE CLOCK.</small>
      </div>

      <div className="preview" aria-live="polite">
        {preview
          ? <><b>{preview.clock.short}</b><span>{known!.name.toUpperCase()} · {preview.clock.offsetLabel}</span><span className={preview.phase === 'on' ? 'on' : ''}>{preview.phase === 'on' ? 'ON SHIFT NOW' : 'OFF SHIFT NOW'}</span></>
          : <span>PICK A CITY TO SEE THEIR LOCAL TIME</span>}
      </div>

      <div className={`msg${msg && msg.text !== 'TRANSMITTING' ? ' err' : ''}`} role="status" aria-live="assertive">{msg?.text ?? ''}</div>

      <div className="actions">
        {placed
          ? <button type="button" className="remove" onClick={remove} disabled={busy}>{confirmRemove ? (isEditor ? 'CONFIRM · REMOVE EDITOR' : 'CONFIRM · TAKE OFF THE MAP') : isEditor ? 'REMOVE EDITOR' : 'TAKE OFF THE MAP'}</button>
          : <span />}
        <button type="submit" disabled={busy}>{isEditor && !editing.editor ? 'ADD TO THE MAP' : 'SAVE'}</button>
      </div>
    </form>
  );
}

/** A city from the list, searched as you type; the nearest listed city stands in for one that isn't. */
function CityField({ value, invalid, autoFocus, onChange }: { value: string; invalid: boolean; autoFocus: boolean; onChange: (v: string, c: City | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const q = value.trim().toLowerCase();
  const matches = useMemo(() => {
    if (!q) return [];
    const starts = CITIES.filter((c) => c.name.toLowerCase().startsWith(q) || c.country.toLowerCase().startsWith(q));
    const rest = CITIES.filter((c) => !starts.includes(c) && cityLabel(c).toLowerCase().includes(q));
    return [...starts, ...rest].slice(0, 7);
  }, [q]);
  const exact = findCity(value);
  const pick = (c: City) => { onChange(cityLabel(c), c); setOpen(false); };
  return (
    <div className="cc-field city">
      <label htmlFor="pp-city">CITY</label>
      <input id="pp-city" value={value} autoComplete="off" spellCheck={false} autoFocus={autoFocus} placeholder="START TYPING"
        role="combobox" aria-expanded={open && matches.length > 0} aria-controls="pp-city-list" aria-invalid={invalid}
        onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { onChange(e.target.value, findCity(e.target.value)); setOpen(true); setActive(0); }}
        onKeyDown={(e) => {
          // Enter picks the city and moves on to the time zone; it never sends the form from here
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!exact && matches.length) pick(matches[active]);
            if (exact || matches.length) document.getElementById('pp-tz')?.focus();
            return;
          }
          if (!open || !matches.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(matches.length - 1, a + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
        }} />
      {open && !exact && q && (
        <ul id="pp-city-list" role="listbox">
          {matches.map((c, i) => (
            <li key={cityLabel(c)} role="option" aria-selected={i === active}>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)} onMouseEnter={() => setActive(i)}>
                <b>{c.name.toUpperCase()}</b><span>{c.country.toUpperCase()} · {c.code}</span>
              </button>
            </li>
          ))}
          {!matches.length && <li className="none">NOT LISTED · PICK THE NEAREST CITY, THEN SET THEIR TIME ZONE</li>}
        </ul>
      )}
    </div>
  );
}
