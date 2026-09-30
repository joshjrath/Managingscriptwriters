// ⌘K / Ctrl+K: talk to the system. Type a person, a city, a client, a
// project, a script, or a command; choosing a result moves the world.

import { useEffect, useMemo, useRef, useState } from 'react';
import { presenceOf, STATE_LABEL, type ControlWorld } from '../../../shared/control';
import { CITIES } from '../../../shared/cities';
import type { Filter, Mode } from './engine/Engine';

export type Command =
  | { kind: 'writer'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'client'; id: string }
  | { kind: 'city'; lat: number; lon: number; name: string }
  | { kind: 'script'; id: string }
  | { kind: 'mode'; mode: Mode; filter?: Filter; play?: boolean }
  | { kind: 'filter'; filter: Filter }
  | { kind: 'action'; action: 'exit' | 'lock' | 'sound' | 'now' };

interface Entry { kind: string; label: string; hint: string; terms: string; command: Command }

const MODE_WORDS: [string, string, Command, string][] = [
  ['WORLD', 'world globe earth home', { kind: 'mode', mode: 'world' }, 'THE GLOBE'],
  ['MISSIONS', 'missions operations projects ops', { kind: 'mode', mode: 'missions' }, 'ACTIVE OPERATIONS'],
  ['DEADLINES', 'deadlines due orbits urgent late overdue', { kind: 'mode', mode: 'deadlines' }, 'ORBITS OF TIME'],
  ['TIMEZONES', 'timezones time zones coverage hours clock', { kind: 'mode', mode: 'timezones' }, '24-HOUR COVERAGE'],
  ['FOLLOW THE SUN', 'follow the sun day night play', { kind: 'mode', mode: 'timezones', play: true }, 'WORK MOVING WITH THE DAY'],
  ['SIGNALS', 'signals handoffs transfers feed activity', { kind: 'mode', mode: 'signals' }, 'HANDOFFS IN TRANSIT'],
  ['CONSTELLATION', 'constellation network graph relationships', { kind: 'mode', mode: 'constellation' }, 'THE COMPANY AS A NETWORK'],
  ['SCRIPT GALAXY', 'galaxy scripts stars', { kind: 'mode', mode: 'galaxy' }, 'EVERY SCRIPT A STAR'],
  ['ARCHIVE', 'archive history delivered past completed', { kind: 'mode', mode: 'archive' }, 'WHAT WE HAVE WRITTEN'],
  ['SYSTEM', 'system diagnostics status health', { kind: 'mode', mode: 'system' }, 'DIAGNOSTICS'],
  ['WRITERS ONLINE', 'writers online on shift active who is working', { kind: 'filter', filter: 'online' }, 'SHOW WHO IS ON SHIFT'],
  ['REVIEWS', 'reviews review queue pending approvals', { kind: 'filter', filter: 'reviews' }, 'WHAT IS WAITING FOR REVIEW'],
  ['PRESSURE', 'pressure anomalies problems risks alerts overloaded', { kind: 'filter', filter: 'pressure' }, 'WHERE THE SYSTEM IS STRAINED'],
  ['RETURN TO NOW', 'now live reset time', { kind: 'action', action: 'now' }, 'LIVE CLOCK'],
  ['SOUND', 'sound audio mute unmute', { kind: 'action', action: 'sound' }, 'TOGGLE SOUND'],
  ['LOCK', 'lock clearance sign out', { kind: 'action', action: 'lock' }, 'END CLEARANCE'],
  ['EXIT', 'exit leave back quit', { kind: 'action', action: 'exit' }, 'BACK TO THE SITE'],
];

function buildIndex(world: ControlWorld, now: Date): Entry[] {
  const out: Entry[] = [];
  for (const w of world.writers) {
    const p = presenceOf(w, now);
    out.push({ kind: 'WRITER', label: w.name.toUpperCase(), hint: `${w.city.toUpperCase()} · ${p.clock.short} · ${p.phase === 'off' ? 'OFFLINE' : w.status.replace('_', ' ').toUpperCase()}`, terms: `${w.name} ${w.city} ${w.country} ${w.cityCode} ${w.role}`, command: { kind: 'writer', id: w.id } });
  }
  const cities = new Map<string, { lat: number; lon: number; country: string; n: number }>();
  for (const w of world.writers) {
    const c = cities.get(w.city) ?? { lat: w.lat, lon: w.lon, country: w.country, n: 0 };
    c.n++;
    cities.set(w.city, c);
  }
  for (const [name, c] of cities) out.push({ kind: 'CITY', label: name.toUpperCase(), hint: `${c.country.toUpperCase()} · ${c.n} NODE${c.n > 1 ? 'S' : ''}`, terms: `${name} ${c.country}`, command: { kind: 'city', lat: c.lat, lon: c.lon, name } });
  for (const c of world.clients) {
    const live = world.projects.filter((p) => p.clientId === c.id && !p.archived).length;
    out.push({ kind: 'CLIENT', label: c.name.toUpperCase(), hint: `${live} ACTIVE OPERATION${live === 1 ? '' : 'S'}`, terms: c.name, command: { kind: 'client', id: c.id } });
  }
  for (const p of world.projects) {
    out.push({ kind: p.archived ? 'ARCHIVE' : 'PROJECT', label: p.title.toUpperCase(), hint: `${p.client.toUpperCase()} · ${p.progress.done}/${p.progress.total}`, terms: `${p.title} ${p.client}`, command: { kind: 'project', id: p.id } });
  }
  for (const s of world.scripts) {
    out.push({ kind: 'SCRIPT', label: `${s.code} · ${s.title.toUpperCase()}`, hint: STATE_LABEL[s.state], terms: `${s.code} ${s.title}`, command: { kind: 'script', id: s.id } });
  }
  // countries and catalog cities where someone works resolve too
  for (const [label, terms, command, hint] of MODE_WORDS) out.push({ kind: 'SYSTEM', label, hint, terms, command });
  return out;
}

function score(e: Entry, q: string): number {
  const hay = `${e.label} ${e.terms}`.toLowerCase();
  if (!q) return e.kind === 'SYSTEM' ? 1 : e.kind === 'WRITER' ? 2 : 0;
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  let s = 0;
  for (const w of words) {
    const i = hay.indexOf(w);
    if (i < 0) return 0;
    s += i === 0 ? 6 : /\s/.test(hay[i - 1] ?? ' ') ? 4 : 1;
  }
  const rank: Record<string, number> = { WRITER: 3, CITY: 2.5, CLIENT: 2.5, PROJECT: 2, SYSTEM: 2, ARCHIVE: 1, SCRIPT: 0.5 };
  return s + (rank[e.kind] ?? 0);
}

export function Palette({ world, now, onClose, onRun }: { world: ControlWorld; now: Date; onClose: () => void; onRun: (c: Command) => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const index = useMemo(() => buildIndex(world, now), [world]); // eslint-disable-line react-hooks/exhaustive-deps
  const results = useMemo(() => {
    const scored = index.map((e) => ({ e, s: score(e, q.trim()) })).filter((x) => x.s > 0);
    scored.sort((a, b) => b.s - a.s);
    // a city from the catalog nobody works in still turns the globe
    if (q.trim().length > 2 && !scored.some((x) => x.e.kind === 'CITY')) {
      const c = CITIES.find((x) => x.name.toLowerCase().startsWith(q.trim().toLowerCase()));
      if (c) scored.push({ e: { kind: 'CITY', label: c.name.toUpperCase(), hint: `${c.country.toUpperCase()} · NO NODES`, terms: '', command: { kind: 'city', lat: c.lat, lon: c.lon, name: c.name } }, s: 0.1 });
    }
    return scored.slice(0, 9).map((x) => x.e);
  }, [index, q]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setSel(0); }, [q]);
  const run = (e: Entry | undefined) => { if (e) { onRun(e.command); onClose(); } };
  return (
    <div className="cc-palette" role="dialog" aria-label="Command">
      <div className="prompt">
        <span aria-hidden>›</span>
        <input
          ref={input} value={q} placeholder="Ask the network" aria-label="Search people, cities, clients, projects or commands"
          role="combobox" aria-expanded="true" aria-controls="cc-results" aria-activedescendant={results[sel] ? `cc-r-${sel}` : undefined}
          onChange={(e) => setQ(e.target.value)} spellCheck={false} autoComplete="off"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(results.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); run(results[sel]); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }}
        />
      </div>
      <ul id="cc-results" role="listbox">
        {results.map((r, i) => (
          <li key={`${r.kind}-${r.label}-${i}`}>
            <button id={`cc-r-${i}`} role="option" aria-selected={i === sel} onMouseEnter={() => setSel(i)} onClick={() => run(r)}>
              <span className="kind">{r.kind}</span>
              <span>{r.label}</span>
              <span className="hint">{r.hint}</span>
            </button>
          </li>
        ))}
      </ul>
      {!results.length && <div className="none">NO SIGNAL MATCHES “{q.toUpperCase()}”</div>}
      <div className="foot"><span>↑↓ SELECT</span><span>↵ EXECUTE</span><span>ESC CLOSE</span></div>
    </div>
  );
}
