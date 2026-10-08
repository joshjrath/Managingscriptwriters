// Settings (managers): deadline rules, timezone and cutoff, reminders, team;
// the admin also picks the site's colour palette.

import { useEffect, useMemo, useRef, useState } from 'react';
import { isManager, ROLE_LABEL, type Role } from '../../../shared/workflow';
import { AlertTriangle, CalendarClock, Check, Copy, KeyRound, Plus, RefreshCw, UserPlus } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { api, useSave } from '../api';
import type { Editor, Settings, UserSummary } from '../../../shared/types';
import { computeDeadlines, DEFAULT_RULES, isValidTimeZone } from '../../../shared/dates';
import { fmtCutoff, fmtLong, fmtStamp, plural } from '../../../shared/format';
import { CITIES, cityLabel, findCity, shiftLength, shiftOf, timeZoneList, zoneOffset } from '../../../shared/cities';
import { ACCENT_LABEL, ACCENTS, darkTextContrast, DEFAULT_PALETTE, HEX, PALETTES, resolveTheme, SURFACE_LABEL, SURFACES, surfaceSwatch, type Accent, type WorkspaceTheme } from '../../../shared/palettes';
import { applyTheme, restoreTheme } from '../theme';
import { CalendarFeedsPanel } from '../components/CalendarFeeds';
import { PageHeader, useBoot } from '../components/Shell';
import { Avatar, Button, Chip, Dialog, ErrorState, Field, FormError, inputProps, Loading, Panel, Seg, Term, useFieldId, useToast } from '../components/ui';

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const fmtHour = (h: number) => `${((h + 11) % 12) + 1}:00 ${h < 12 ? 'AM' : 'PM'}`;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// the common head-office zones first, then every zone there is
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Toronto', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney'];

/** Links like /settings#team land on that panel. */
function SettingsHash() {
  useEffect(() => { const id = window.location.hash.slice(1); if (id) setTimeout(() => document.getElementById(id)?.scrollIntoView({ block: 'start' }), 60); }, []);
  return null;
}

export function SettingsPage() {
  const { me } = useBoot();
  if (!isManager(me.role)) {
    return <><PageHeader title="Settings" /><Panel><p className="muted">Only managers can change organisation settings. You can change your password from the menu under your name.</p></Panel></>;
  }
  return (
    <>
      <SettingsHash />
      <PageHeader title="Settings" hideNewWork />
      {me.role === 'owner' && <div style={{ marginBottom: 'var(--gap)' }}><PalettePanel /></div>}
      <div className="grid g-2" style={{ alignItems: 'start' }}>
        <RulesPanel />
        <div className="grid" style={{ alignContent: 'start' }}>
          <TeamPanel />
          <CalendarFeedsPanel />
          {me.role === 'owner' && <EditorsPanel />}
        </div>
      </div>
    </>
  );
}

// ── colour palette (admin) ───────────────────────────────────────────────

const sameTheme = (a: WorkspaceTheme | null, b: WorkspaceTheme | null) => JSON.stringify(resolveTheme(a)) === JSON.stringify(resolveTheme(b));

function PalettePanel() {
  const { settings } = useBoot();
  const toast = useToast();
  const [draft, setDraft] = useState<WorkspaceTheme>(settings.theme ?? { preset: DEFAULT_PALETTE.id });
  const [open, setOpen] = useState(() => resolveTheme(settings.theme).custom);
  const r = resolveTheme(draft);
  const dirty = !sameTheme(draft, settings.theme);
  // preview as you choose; leaving the page without saving goes back
  useEffect(() => { applyTheme(draft, { preview: true }); }, [JSON.stringify(draft)]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => restoreTheme(), []);
  const save = useSave(() => api<{ settings: Settings }>('/api/settings/theme', { method: 'PUT', body: { ...draft } }), {
    onSuccess: (out) => { applyTheme(out.settings.theme); toast(`Colour palette saved: ${resolveTheme(out.settings.theme).palette.name}. Everyone sees it now.`); },
  });
  const weak = ACCENTS.filter((k) => darkTextContrast(r.colors[k]) < 4.5);
  const pick = (id: string) => setDraft({ preset: id });
  const setColor = (k: Accent, v: string) => setDraft({ ...draft, colors: { ...draft.colors, [k]: v.toUpperCase() } });
  return (
    <Panel title="Colour palette" sub="the whole site, for everyone · admin only"
      tools={dirty ? <div className="row-flex s2">
        <Button variant="sm ghost" onClick={() => setDraft(settings.theme ?? { preset: DEFAULT_PALETTE.id })}>Cancel</Button>
        <Button variant="sm primary" busy={save.isPending} disabled={weak.length > 0} onClick={() => save.mutate(undefined)}>Save palette</Button>
      </div> : <span className="muted" style={{ fontSize: 12.5 }}>Saved</span>}>
      <FormError error={save.error} />
      <div className="pal-grid" role="radiogroup" aria-label="Palettes">
        {PALETTES.map((p) => {
          const on = r.palette.id === p.id;
          const surf = surfaceSwatch(p.surfaces);
          return (
            <button key={p.id} type="button" role="radio" aria-checked={on} className={`pal-card${on ? ' on' : ''}`} onClick={() => pick(p.id)}
              style={{ ['--pb' as string]: surf[0], ['--pp' as string]: surf[2], ['--pr' as string]: surf[4], ['--pa' as string]: p.colors.brand, ['--py' as string]: p.colors.action }}>
              <span className="pal-top"><span className="pal-name">{p.name}</span>{on && <span className="pal-check" aria-hidden><Check /></span>}</span>
              <span className="pal-vibe">{p.vibe}</span>
              <span className="pal-mock" aria-hidden>
                <span className="pal-nav">My work</span>
                <span className="pal-btn">Mark delivered</span>
              </span>
              <span className="pal-dots" aria-hidden>{ACCENTS.map((k) => <i key={k} style={{ background: p.colors[k] }} />)}</span>
            </button>
          );
        })}
      </div>
      <div className="pal-custom">
        <button type="button" className="btn sm ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide' : 'Customise'} colours{r.custom ? ' · customised' : ''}</button>
        {r.custom && <button type="button" className="btn sm ghost" onClick={() => pick(r.palette.id)}>Reset to {r.palette.name}</button>}
      </div>
      {open && (
        <div className="stack s4" style={{ marginTop: 14 }}>
          <div className="row-flex s3" style={{ alignItems: 'center' }}>
            <span className="section-title" style={{ margin: 0 }}>Background</span>
            <Seg role="group" aria-label="Background tone">
              {SURFACES.map((t) => <button key={t} type="button" aria-pressed={r.surfaces === t} onClick={() => setDraft({ ...draft, surfaces: t })}><i className="pal-tone" style={{ background: surfaceSwatch(t)[3] }} aria-hidden />{SURFACE_LABEL[t]}</button>)}
            </Seg>
          </div>
          <div className="pal-colors">
            {ACCENTS.map((k) => {
              const v = r.colors[k];
              const low = darkTextContrast(v) < 4.5;
              return (
                <label key={k} className={`pal-color${low ? ' low' : ''}`}>
                  <input type="color" value={v.toLowerCase()} onChange={(e) => setColor(k, e.target.value)} aria-label={`${ACCENT_LABEL[k].name} colour`} />
                  <span className="pal-color-txt">
                    <b>{ACCENT_LABEL[k].name}</b>
                    <span>{low ? 'Too dark for dark text on it. Pick a lighter shade.' : ACCENT_LABEL[k].use}</span>
                  </span>
                  <input className="input num pal-hex" value={v} maxLength={7} spellCheck={false} aria-label={`${ACCENT_LABEL[k].name} hex`}
                    onChange={(e) => { const x = e.target.value.trim(); if (HEX.test(x)) setColor(k, x); }} />
                </label>
              );
            })}
          </div>
        </div>
      )}
    </Panel>
  );
}

/** Scrolls to the first field marked invalid inside `root` and focuses it. */
function revealError(root: HTMLElement | null) {
  requestAnimationFrame(() => {
    const el = root?.querySelector<HTMLElement>('[aria-invalid="true"]');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus({ preventScroll: true });
  });
}

function RulesPanel() {
  const { settings } = useBoot();
  const toast = useToast();
  const [v, setV] = useState<Settings>(settings);
  const [asking, setAsking] = useState<null | 'save' | 'existing'>(null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => setV(settings), [settings]);
  const body = (recalculate: boolean) => ({ orgName: v.orgName, timezone: v.timezone, cutoff: v.cutoff, draftOffsetDays: v.draftOffsetDays, finalOffsetDays: v.finalOffsetDays, dayMode: v.dayMode, workingDays: v.workingDays, reminderLeadDays: v.reminderLeadDays, planReminderDays: v.planReminderDays, recalculate });
  const save = useSave((recalculate: boolean) => api<{ settings: Settings; recalculated: number }>('/api/settings', { method: 'PATCH', body: body(recalculate) }), {
    onSuccess: (out, recalculate) => { toast(`Settings saved${recalculate ? ` · ${plural(out.recalculated, 'batch', 'batches')} updated to the new rules` : ''}`); setAsking(null); },
  });
  // a failed save says so where you're looking, and takes you to the field
  useEffect(() => { if (save.error) { toast(save.error.message, 'error'); revealError(form.current); } }, [save.error]); // eslint-disable-line react-hooks/exhaustive-deps
  const num = (x: string) => (x === '' ? Number.NaN : Number(x));
  const shown = (n: number) => (Number.isNaN(n) ? '' : n);
  // checked as you type, in plain words
  const live: Record<string, string> = {};
  for (const [k, max] of [['draftOffsetDays', 60], ['finalOffsetDays', 60], ['reminderLeadDays', 14], ['planReminderDays', 60]] as const) {
    const n = v[k];
    if (Number.isNaN(n)) live[k] = 'Enter a number of days';
    else if (n < (k === 'planReminderDays' ? 3 : 0) || n > max || !Number.isInteger(n)) live[k] = `Use a whole number from ${k === 'planReminderDays' ? 3 : 0} to ${max}`;
  }
  if (!live.draftOffsetDays && !live.finalOffsetDays && v.finalOffsetDays > v.draftOffsetDays) live.finalOffsetDays = `Final delivery can’t come before the drafts. Use ${v.draftOffsetDays} or fewer: drafts are due ${v.draftOffsetDays} days before the shoot.`;
  if (!v.workingDays.length) live.workingDays = 'Pick at least one working day';
  const f = { ...(save.error?.fields ?? {}), ...live };
  const ids = { tz: useFieldId('tz'), cut: useFieldId('cut'), d: useFieldId('d'), fo: useFieldId('fo'), lead: useFieldId('lead'), plan: useFieldId('plan'), org: useFieldId('org') };
  const valid = !Object.keys(live).length;
  const example = valid ? computeDeadlines('2026-10-12', { ...DEFAULT_RULES, draftOffsetDays: v.draftOffsetDays, finalOffsetDays: v.finalOffsetDays, dayMode: v.dayMode, workingDays: v.workingDays }) : null;
  const changedRules = v.draftOffsetDays !== settings.draftOffsetDays || v.finalOffsetDays !== settings.finalOffsetDays || v.dayMode !== settings.dayMode || v.workingDays.join() !== settings.workingDays.join();
  // nothing is lost by accident: the browser asks before leaving with unsaved changes
  const dirty = (['orgName', 'timezone', 'cutoff', 'draftOffsetDays', 'finalOffsetDays', 'dayMode', 'reminderLeadDays', 'planReminderDays'] as const).some((k) => v[k] !== settings[k]) || v.workingDays.join() !== settings.workingDays.join();
  useEffect(() => {
    if (!dirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const submit = () => {
    if (!valid) { toast('Some settings need fixing first', 'error'); revealError(form.current); return; }
    if (changedRules) setAsking('save'); else save.mutate(false);
  };
  return (
    <Panel title="Deadline rules & time" sub="How deadlines are worked out from each shoot, and what time they end.">
      <form ref={form} className="form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
        <div className="form-grid">
          <Field label="Drafts due" htmlFor={ids.d} error={f.draftOffsetDays} help="days before the shoot starts"><input className="input num" type="number" min={0} max={60} value={shown(v.draftOffsetDays)} onChange={(e) => setV({ ...v, draftOffsetDays: num(e.target.value) })} {...inputProps(ids.d, f.draftOffsetDays)} /></Field>
          <Field label={<>Final delivery to <Term k="Timeliner" /></>} htmlFor={ids.fo} error={f.finalOffsetDays} help="days before the shoot starts (the same as drafts, or fewer)"><input className="input num" type="number" min={0} max={60} value={shown(v.finalOffsetDays)} onChange={(e) => setV({ ...v, finalOffsetDays: num(e.target.value) })} {...inputProps(ids.fo, f.finalOffsetDays)} /></Field>
        </div>
        <div className="field">
          <span className="lbl">Count days as</span>
          <Seg role="group" aria-label="Day counting" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={v.dayMode === 'calendar'} onClick={() => setV({ ...v, dayMode: 'calendar' })}>Calendar days</button>
            <button type="button" aria-pressed={v.dayMode === 'business'} onClick={() => setV({ ...v, dayMode: 'business' })}>Working days</button>
          </Seg>
          <span className="help">{v.dayMode === 'calendar' ? 'Every day counts, weekends included. Deadlines are never shifted silently.' : 'Only the working days below count, so deadlines always land on a working day.'}</span>
        </div>
        <div className="field">
          <span className="lbl">Working week</span>
          <div className="row-flex s2">{DAYS.map((d, i) => (
            <label key={d} className="check" style={{ background: 'var(--row)', padding: '4px 12px', borderRadius: 12 }}>
              <input type="checkbox" checked={v.workingDays.includes(i)} onChange={(e) => setV({ ...v, workingDays: e.target.checked ? [...v.workingDays, i].sort() : v.workingDays.filter((x) => x !== i) })} aria-invalid={f.workingDays ? true : undefined} />{d}
            </label>
          ))}</div>
          <span className={f.workingDays ? 'err' : 'help'} style={f.workingDays ? { color: '#FF9C94', fontSize: 12.5, fontWeight: 600 } : undefined}>{f.workingDays ?? 'Used for working-day deadlines and for writer capacity estimates.'}</span>
        </div>
        {example && <div className="banner"><CalendarClock aria-hidden /><div className="txt"><b>Example: shoot on Oct 12–13, 2026</b><span>Drafts due {fmtLong(example.draftDue)} · final delivery {fmtLong(example.finalDue)}</span></div></div>}
        <div className="form-grid">
          <Field label="HQ time zone" htmlFor={ids.tz} error={f.timezone ?? (isValidTimeZone(v.timezone) ? undefined : 'Unknown timezone')} help="Decides what “today” is and when a deadline passes. Existing deadlines keep their dates. Anyone in another time zone sees HQ time under their own clock.">
            <select className="select" id={ids.tz} value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>
              <optgroup label="Common">{[...new Set([v.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</optgroup>
              <optgroup label="Every time zone">{timeZoneList().filter((z) => z !== v.timezone && !ZONES.includes(z)).map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>)}</optgroup>
            </select>
          </Field>
          <Field label="Daily cutoff" htmlFor={ids.cut} error={f.cutoff} help={`Work is due by ${fmtCutoff(v.cutoff)} HQ time on the deadline day.`}><input className="input" type="time" value={v.cutoff} onChange={(e) => setV({ ...v, cutoff: e.target.value })} {...inputProps(ids.cut, f.cutoff)} /></Field>
          <Field label="Remind writers" htmlFor={ids.lead} error={f.reminderLeadDays} help="days before a deadline (plus on the day, and when overdue)"><input className="input num" type="number" min={0} max={14} value={shown(v.reminderLeadDays)} onChange={(e) => setV({ ...v, reminderLeadDays: num(e.target.value) })} {...inputProps(ids.lead, f.reminderLeadDays)} /></Field>
          <Field label="Remind managers to plan scripts" htmlFor={ids.plan} error={f.planReminderDays} help="days before a shoot that has no scripts planned or has unassigned scripts (again at 7, 3 and 1 days)"><input className="input num" type="number" min={3} max={60} value={shown(v.planReminderDays)} onChange={(e) => setV({ ...v, planReminderDays: num(e.target.value) })} {...inputProps(ids.plan, f.planReminderDays)} /></Field>
          <Field label="Organisation name" htmlFor={ids.org} error={f.orgName}><input className="input" value={v.orgName} onChange={(e) => setV({ ...v, orgName: e.target.value })} {...inputProps(ids.org, f.orgName)} /></Field>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>{settings.remindersEnabled === false
          ? 'Reminders are turned off on this server.'
          : `Reminders appear in each person’s bell on the site (there’s no email). They run every 10 minutes${settings.remindersLastRunAt ? ` · last run ${fmtStamp(settings.remindersLastRunAt, settings.timezone)}` : ' · not run yet'}.`}</p>
        <div className={`form-actions${dirty ? ' sticky-save' : ''}`}>
          {dirty && <span className="unsaved"><i aria-hidden />Unsaved changes</span>}
          <Button variant="ghost" onClick={() => setAsking('existing')} disabled={!valid || changedRules}>Apply these rules to existing batches…</Button>
          {dirty && <Button variant="ghost" onClick={() => setV(settings)}>Discard</Button>}
          <Button type="submit" variant="primary pill" busy={save.isPending && asking === null}>Save settings</Button>
        </div>
      </form>
      {asking && <ApplyRulesDialog rules={{ draftOffsetDays: v.draftOffsetDays, finalOffsetDays: v.finalOffsetDays, dayMode: v.dayMode, workingDays: v.workingDays }} existingOnly={asking === 'existing'}
        busy={save.isPending} onClose={() => setAsking(null)} onChoose={(recalc) => save.mutate(recalc)} />}
    </Panel>
  );
}

/** Asks whether new deadline rules should also move the deadlines of batches that already exist. */
function ApplyRulesDialog({ rules, existingOnly, busy, onClose, onChoose }: { rules: Pick<Settings, 'draftOffsetDays' | 'finalOffsetDays' | 'dayMode' | 'workingDays'>; existingOnly: boolean; busy: boolean; onClose: () => void; onChoose: (recalculate: boolean) => void }) {
  const preview = useQuery({ queryKey: ['recalc-preview', rules], queryFn: () => api<{ batches: number; writers: number }>('/api/settings/recalculate-preview', { body: rules }) });
  const n = preview.data?.batches ?? 0;
  return (
    <Dialog open onClose={onClose} size="narrow" title={existingOnly ? 'Apply the rules to existing batches?' : 'Apply the new rules to existing batches too?'}
      sub="New batches always use the current rules. Deadlines someone set by hand are never changed."
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {!existingOnly && <Button busy={busy} onClick={() => onChoose(false)}>Only new batches</Button>}
        <Button variant="primary pill" busy={busy} disabled={preview.isLoading || (existingOnly && !n)} onClick={() => onChoose(true)}>{existingOnly ? `Update ${plural(n, 'batch', 'batches')}` : 'Also existing batches'}</Button>
      </div>}>
      {preview.isLoading && <Loading height={60} />}
      {preview.isError && <ErrorState error={preview.error} retry={() => preview.refetch()} />}
      {preview.data && <p className="muted" style={{ margin: 0 }}>{n
        ? `${plural(n, 'active batch', 'active batches')} would get new automatic deadlines${preview.data.writers ? `, and ${plural(preview.data.writers, 'writer')} would be told` : ''}.`
        : 'No active batches would change: they already match these rules, or their deadlines were set by hand.'}</p>}
    </Dialog>
  );
}

const ROLE_COLOR: Record<Role, string> = { owner: 'salmon', manager: 'salmon', writer: 'cyan', editor: 'lavender' };

function TeamPanel() {
  const { me, settings } = useBoot();
  const q = useQuery({ queryKey: ['team'], queryFn: () => api<{ users: UserSummary[] }>('/api/users') });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  const [sharing, setSharing] = useState<UserSummary | null>(null);
  const [removing, setRemoving] = useState<UserSummary | null>(null);
  const team = (q.data?.users ?? []).filter((u) => !u.removed);
  const order: Record<Role, number> = { owner: 0, manager: 1, writer: 2, editor: 3 };
  team.sort((a, b) => Number(b.active) - Number(a.active) || order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  // the Admin's own account is the Admin's to change
  const locked = (u: UserSummary) => u.role === 'owner' && me.role !== 'owner';
  return (
    <Panel id="team" title="Team" count={team.filter((u) => u.active).length} tools={<Button variant="sm" icon={<UserPlus aria-hidden />} onClick={() => setAdding(true)}>Add person</Button>}>
      {q.isLoading && <Loading height={200} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      <div className="rows">
        {team.map((u) => (
          <div key={u.id} className="item" style={{ opacity: u.active ? 1 : 0.6 }}>
            <button className="row-flex" disabled={locked(u)} style={{ flexWrap: 'nowrap', minWidth: 0, border: 0, background: 'none', color: 'inherit', font: 'inherit', textAlign: 'left', padding: 0, cursor: locked(u) ? 'default' : 'pointer' }} onClick={() => setEditing(u)} aria-label={`Edit ${u.name}`}>
              <Avatar name={u.name} id={u.id} />
              <div className="body">
                <div className="title">{u.name}{u.id === me.id ? ' (you)' : ''}</div>
                <div className="meta ellipsis">{u.email}</div>
                <div className="meta">{!u.active ? 'Deactivated' : u.role === 'editor' ? 'Read-only sign-in' : u.capacityPerDay ? `${u.capacityPerDay} scripts / working day` : 'Capacity not set'}{u.active && u.city ? ` · ${u.city.split(',')[0]}` : ''}</div>
              </div>
            </button>
            <div className="side">
              <Chip color={ROLE_COLOR[u.role]}>{ROLE_LABEL[u.role]}</Chip>
              {u.tempPassword
                ? <Button variant="sm" icon={<Copy aria-hidden />} onClick={() => setSharing(u)} title="They haven’t set their own password yet">Copy sign-in details</Button>
                : u.id !== me.id && u.active ? <span className="muted" style={{ fontSize: 12 }}>Set their own password</span> : null}
              {locked(u) ? <span className="muted" style={{ fontSize: 12 }}>Only the Admin can change this</span> : (
                <div className="row-flex s2">
                  <Button variant="sm ghost" onClick={() => setEditing(u)}>Edit</Button>
                  {u.id !== me.id && <Button variant="sm ghost" onClick={() => setRemoving(u)}>Remove</Button>}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Managers can do everything the Admin can, except change the Admin’s account and use the Admin-only parts (Control Center, Master log, View as and the colour palette). The temporary password stays copyable here until the person sets their own. Writers only show as over capacity when a capacity is set.</p>
      {adding && <PersonDialog onClose={() => setAdding(false)} />}
      {editing && <PersonDialog user={editing} team={team} onClose={() => setEditing(null)} />}
      {sharing && <ShareDetails name={firstName(sharing.name)} onClose={() => setSharing(null)}
        message={signInMessage({ name: sharing.name, email: sharing.email, password: sharing.tempPassword!, role: sharing.role, orgName: settings.orgName, url: window.location.origin })} />}
      {removing && <RemoveDialog user={removing} team={team} onClose={() => setRemoving(null)} />}
    </Panel>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

/** Someone's unfinished scripts, and who takes them over. */
function OpenWorkPicker({ userId, team, value, onChange }: { userId: number; team: UserSummary[]; value: string; onChange: (v: string) => void }) {
  const work = useQuery({ queryKey: ['open-work', userId], queryFn: () => api<{ scripts: number; batches: { id: number; title: string; clientName: string; scripts: number }[] }>(`/api/users/${userId}/open-work`) });
  const id = useFieldId('rm');
  const n = work.data?.scripts ?? 0;
  if (work.isLoading) return <span className="muted">Checking their work…</span>;
  if (!work.data || !n) return <p className="muted">They have no unfinished scripts.</p>;
  return (
    <>
      <div className="banner yellow"><AlertTriangle aria-hidden /><div className="txt"><b>{plural(n, 'unfinished script')}</b><span>{work.data.batches.map((b) => `${b.clientName} · ${b.title} (${b.scripts})`).join(' · ')}</span></div></div>
      <Field label="Give their unfinished scripts to" htmlFor={id} help="Delivered scripts keep their name.">
        <select className="select" id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">Nobody — leave them unassigned</option>
          {team.filter((u) => u.active && u.id !== userId && u.role !== 'editor').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
      </Field>
    </>
  );
}

function RemoveDialog({ user, team, onClose }: { user: UserSummary; team: UserSummary[]; onClose: () => void }) {
  const toast = useToast();
  const [to, setTo] = useState('');
  const remove = useSave(() => api<{ moved: number }>(`/api/users/${user.id}/remove`, { body: { reassignTo: to ? Number(to) : null } }), {
    onSuccess: (out) => { toast(`${user.name} removed${out.moved ? ` · ${plural(out.moved, 'script')} ${to ? 'reassigned' : 'unassigned'}` : ''}`); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title={`Remove ${user.name}?`} sub="They’re signed out and can’t sign in any more. Their name stays in the history, and you can add them back later with the same email. To keep them on the team but stop them signing in for now, use Edit → Deactivate instead." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" busy={remove.isPending} onClick={() => remove.mutate(undefined)}>Remove {firstName(user.name)}</Button></div>}>
      <div className="form">
        <FormError error={remove.error} />
        <OpenWorkPicker userId={user.id} team={team} value={to} onChange={setTo} />
      </div>
    </Dialog>
  );
}

// Readable temporary passwords: no 0/O, 1/l/I. 3 groups of 4 = 14 characters.
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generatePassword(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => PW_CHARS[b % PW_CHARS.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export function signInMessage(p: { name: string; email: string; password: string; role: Role; orgName: string; url: string; reset?: boolean }): string {
  const first = p.name.trim().split(/\s+/)[0] || 'there';
  return [
    p.reset
      ? `Hi ${first}, your ${p.orgName} password has been reset.`
      : `Hi ${first}, you've been added to ${p.orgName}'s script production workspace as ${p.role === 'owner' ? 'an admin' : p.role === 'editor' ? 'an editor' : `a ${p.role}`}.`,
    '',
    `Sign in: ${p.url}`,
    `Email: ${p.email}`,
    `Temporary password: ${p.password}`,
    '',
    p.reset
      ? 'Your password was reset, so you’ve been signed out. When you sign in with this one, the site asks you to choose your own.'
      : `When you sign in, the site asks you to choose your own password (you can also change it any time from the menu under your name). ${p.role === 'writer' ? 'Your scripts, deadlines and briefs are under “My work”.' : p.role === 'editor' ? 'Your home page shows upcoming shoots and the newest finished scripts; the Calendar, Script bank and client material are in the menu.' : ''}`.trim(),
  ].join('\n');
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // fallback for browsers that block the clipboard API
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

function ShareDetails({ message, name, onClose }: { message: string; name: string; onClose: () => void }) {
  const recording = !!useBoot().mode?.recording;
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => setCopied((await copyText(message)) ? 'ok' : 'fail');
  return (
    <Dialog open onClose={onClose} title={`Send ${name} their sign-in details`} sub="Copy this and paste it into WhatsApp, Slack, text or email. You can copy it again from Team until they set their own password." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary pill" icon={copied === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />} onClick={copy}>{copied === 'ok' ? 'Copied' : 'Copy message'}</Button></div>}>
      <div className="form">
        {recording && <div className="banner red"><AlertTriangle aria-hidden /><div className="txt"><b>Practice copy: don’t send this</b><span>You’re in Recording mode, so this person and password disappear when you turn it off. The sign-in won’t work for them.</span></div></div>}
        <pre className="share-block" aria-label="Sign-in message">{message}</pre>
        {copied === 'fail' && <span className="err" role="alert" style={{ color: '#FF9C94', fontSize: 12.5, fontWeight: 600 }}>Your browser blocked copying — select the text above and copy it manually.</span>}
        {copied === 'ok' && <span className="muted" style={{ fontSize: 12.5 }} role="status">Copied to your clipboard.</span>}
      </div>
    </Dialog>
  );
}

function PersonDialog({ user, team = [], preset, onCreated, onClose }: { user?: UserSummary; team?: UserSummary[]; preset?: { name: string; role: Role; city?: string; timezone?: string; hours?: [number, number] }; onCreated?: () => void; onClose: () => void }) {
  const toast = useToast();
  const { me } = useBoot();
  const [name, setName] = useState(user?.name ?? preset?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? preset?.role ?? 'writer');
  const [capacity, setCapacity] = useState(user?.capacityPerDay != null ? String(user.capacityPerDay) : '');
  const { settings } = useBoot();
  const [password, setPassword] = useState(() => (user ? '' : generatePassword()));
  const [active, setActive] = useState(user?.active ?? true);
  const [city, setCity] = useState(user?.city ?? preset?.city ?? '');
  const [tz, setTz] = useState(user?.timezone ?? preset?.timezone ?? findCity(user?.city ?? preset?.city ?? '')?.timezone ?? '');
  const [hours, setHours] = useState<[number, number]>(user?.workHours ?? preset?.hours ?? [9, 18]);
  const [share, setShare] = useState<string | null>(null);
  const [takeover, setTakeover] = useState('');
  const deactivating = !!user && user.active && !active;
  const place = { city: city.trim() || null, ...(city.trim() ? { timezone: tz || undefined, workStart: hours[0], workEnd: hours[1] % 24 || 24 } : {}) };
  const save = useSave(() => user
    ? api<{ moved: number }>(`/api/users/${user.id}`, { method: 'PATCH', body: { name, email, role, active, capacityPerDay: capacity ? Number(capacity) : null, password: password || undefined, ...place, ...(deactivating ? { reassignTo: takeover ? Number(takeover) : null } : {}) } })
    : api('/api/users', { body: { name, email, role, password, capacityPerDay: capacity ? Number(capacity) : null, ...place } }), {
    onSuccess: () => {
      if (!user) onCreated?.();
      if (!user || password) {
        // only now, right after saving, is the plain password known
        setShare(signInMessage({ name, email: user?.email ?? email.trim().toLowerCase(), password, role, orgName: settings.orgName, url: window.location.origin, reset: !!user }));
        toast(user ? `New password set for ${name}` : `${name} added`);
      } else {
        toast(deactivating ? `${name} deactivated${takeover ? ' · their scripts were handed over' : ''}` : `${name} updated`);
        onClose();
      }
    },
  });
  const f = save.error?.fields ?? {};
  const ids = { n: useFieldId('n'), e: useFieldId('e'), r: useFieldId('r'), c: useFieldId('c'), p: useFieldId('p') };
  if (share) return <ShareDetails message={share} name={firstName(name)} onClose={onClose} />;
  return (
    <Dialog open onClose={onClose} title={user ? `Edit ${user.name}` : preset ? `Give ${preset.name} site access` : 'Add a person'} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)} icon={user ? undefined : <Plus aria-hidden />}>{user ? 'Save' : 'Add person'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Name" htmlFor={ids.n} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} /></Field>
        <Field label="Email" htmlFor={ids.e} error={f.email} help="They sign in with this."><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} {...inputProps(ids.e, f.email)} /></Field>
        <Field label="Role" htmlFor={ids.r} error={f.role} help={role === 'editor'
          ? 'Editors see the calendar, finished scripts, clients and resources, and can message the team and get to-dos. Read-only, and they can’t be given scripts.'
          : role === 'owner' ? 'The Admin can do everything, including the Admin-only parts. Only an Admin can make someone an Admin.'
          : 'Managers plan, assign and review everything. Writers work on their own scripts, blockers, resources and deliveries.'}>
          <select className="select" id={ids.r} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="writer">Writer</option><option value="editor">Editor</option><option value="manager">Manager</option>
            {(me.role === 'owner' || role === 'owner') && <option value="owner">Admin</option>}
          </select>
        </Field>
        {role !== 'editor' && <Field label="Capacity" optional htmlFor={ids.c} error={f.capacityPerDay} help="Scripts per working day. Used for start-date estimates and over-capacity warnings."><input className="input num" type="number" min={0.5} step={0.5} value={capacity} onChange={(e) => setCapacity(e.target.value)} {...inputProps(ids.c, f.capacityPerDay)} /></Field>}
        <PlaceFields optional city={city} tz={tz} hours={hours} f={f}
          onChange={(v) => { if (save.error) save.reset(); if (v.city !== undefined) setCity(v.city); if (v.tz !== undefined) setTz(v.tz); if (v.hours) setHours(v.hours); }} />
        <Field label={user ? 'Reset password' : 'Temporary password'} optional={!!user} htmlFor={ids.p} error={f.password} help={user ? 'Leave empty to keep their password. Setting one signs them out everywhere, and you’ll get a message to send them.' : 'At least 10 characters. After saving you’ll get a ready-to-send message with this and the sign-in link.'}>
          <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
            <input className="input" type="text" autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} {...inputProps(ids.p, f.password)} />
            <Button variant="sm" icon={<RefreshCw aria-hidden />} onClick={() => setPassword(generatePassword())}>Generate</Button>
          </div>
        </Field>
        {user?.tempPassword && (
          <div className="banner"><KeyRound aria-hidden /><div className="txt"><b>Temporary password: <span className="tnum" style={{ userSelect: 'all' }}>{user.tempPassword}</span></b><span>They haven’t set their own password yet.</span></div></div>
        )}
        {user && user.id !== me.id && (
          <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />Deactivate (signs them out; their history is kept)</label>
        )}
        {deactivating && <OpenWorkPicker userId={user.id} team={team} value={takeover} onChange={setTakeover} />}
      </form>
    </Dialog>
  );
}

// ── editors: shown in the Control Center, not part of the platform ───────

function EditorsPanel() {
  const q = useQuery({ queryKey: ['editors'], queryFn: () => api<{ editors: Editor[] }>('/api/editors') });
  const [editing, setEditing] = useState<Editor | 'new' | null>(null);
  const toast = useToast();
  const remove = useSave((id: number) => api(`/api/editors/${id}`, { method: 'DELETE' }), { onSuccess: () => toast('Removed from the map') });
  const { users } = useBoot();
  const signedIn = users.filter((u) => u.role === 'editor' && u.active);
  // once they have a sign-in they're on the team (and in the Control Center from there), so the list entry goes
  const [inviting, setInviting] = useState<Editor | null>(null);
  const editors = q.data?.editors ?? [];
  return (
    <Panel title="Editors on the map" sub="no sign-in · shown in the Control Center" count={editors.length} tools={<Button variant="sm" icon={<UserPlus aria-hidden />} onClick={() => setEditing('new')}>Add editor</Button>}>
      {q.isLoading && <Loading height={80} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      <div className="rows">
        {editors.map((e) => (
          <div key={e.id} className="item">
            <div className="row-flex" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
              <Avatar name={e.name} id={100000 + e.id} />
              <div className="body">
                <div className="title">{e.name}</div>
                <div className="meta">{e.city} · {e.workHours[1] - e.workHours[0] >= 24 ? 'Around the clock' : `${fmtHour(e.workHours[0])} to ${fmtHour(e.workHours[1] % 24)}`}</div>
              </div>
            </div>
            <div className="side">
              <div className="row-flex s2">
                <Button variant="sm" icon={<KeyRound aria-hidden />} onClick={() => setInviting(e)}>Give site access</Button>
                <Button variant="sm ghost" onClick={() => setEditing(e)}>Edit</Button>
                <Button variant="sm ghost" busy={remove.isPending && remove.variables === e.id} onClick={() => { if (window.confirm(`Remove ${e.name} from the map? They don’t have a sign-in, so nothing else changes.`)) remove.mutate(e.id); }}>Remove</Button>
              </div>
            </div>
          </div>
        ))}
      </div>
      {signedIn.length > 0 && (
        <div className="rows" style={{ marginTop: editors.length ? 10 : 0 }}>
          {signedIn.map((u) => (
            <div key={u.id} className="item" style={{ opacity: 0.85 }}>
              <div className="row-flex" style={{ flexWrap: 'nowrap', minWidth: 0 }}><Avatar name={u.name} id={u.id} /><div className="body"><div className="title">{u.name}</div><div className="meta">{u.city ?? 'Editor'}</div></div></div>
              <div className="side"><Chip color="mint" icon={<Check aria-hidden />}>Has site access</Chip></div>
            </div>
          ))}
        </div>
      )}
      {q.data && !editors.length && !signedIn.length && <p className="muted" style={{ fontSize: 13 }}>No editors yet.</p>}
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>People here only appear in the Control Center, with their local time and working hours. To let one sign in and see the calendar and finished scripts, click Give site access: they move to the Team as an Editor. Only admins see this list.</p>
      {editing && <EditorDialog editor={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {inviting && <PersonDialog preset={{ name: inviting.name, role: 'editor', city: inviting.city, timezone: inviting.timezone, hours: inviting.workHours }}
        onCreated={() => { const id = inviting.id; api(`/api/editors/${id}?reason=access`, { method: 'DELETE' }).then(() => q.refetch(), () => {}); }} onClose={() => setInviting(null)} />}
    </Panel>
  );
}

function EditorDialog({ editor, onClose }: { editor?: Editor; onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(editor?.name ?? '');
  const [city, setCity] = useState(editor?.city ?? '');
  const [tz, setTz] = useState(editor?.timezone ?? '');
  const [hours, setHours] = useState<[number, number]>(editor?.workHours ?? [9, 18]);
  const ids = { n: useFieldId('ed-n') };
  const body = { name, city, timezone: tz || undefined, workStart: hours[0], workEnd: hours[1] % 24 || 24 };
  const save = useSave(() => (editor ? api(`/api/editors/${editor.id}`, { method: 'PATCH', body }) : api('/api/editors', { body })), {
    onSuccess: () => { toast(editor ? `${name} updated` : `${name} added`); onClose(); },
  });
  const f = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={editor ? `Edit ${editor.name}` : 'Add an editor'} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>{editor ? 'Save' : 'Add editor'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Name" htmlFor={ids.n} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} autoFocus /></Field>
        <PlaceFields city={city} tz={tz} hours={hours} f={f}
          onChange={(v) => { if (save.error) save.reset(); if (v.city !== undefined) setCity(v.city); if (v.tz !== undefined) setTz(v.tz); if (v.hours) setHours(v.hours); }} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/**
 * City, time zone and working hours. The time zone follows the city unless
 * it's changed, and a shift can be any length up to around the clock.
 */
function PlaceFields({ city, tz, hours, f, optional, onChange }: {
  city: string; tz: string; hours: [number, number]; f: Record<string, string>; optional?: boolean;
  onChange: (v: { city?: string; tz?: string; hours?: [number, number] }) => void;
}) {
  const ids = { c: useFieldId('pl-c'), z: useFieldId('pl-z'), h: useFieldId('pl-h') };
  const zones = useMemo(() => {
    const list = timeZoneList();
    return tz && !list.includes(tz) ? [tz, ...list] : list;
  }, [tz]);
  const offsets = useMemo(() => new Map(zones.map((z) => [z, zoneOffset(z)])), [zones]);
  const known = findCity(city);
  const placed = !!city.trim();
  return (
    <>
      <Field label="City" optional={optional} htmlFor={ids.c} error={f.city} help="Where they work from. Sets their local time.">
        <input className="input" list={`${ids.c}-list`} autoComplete="off" placeholder="Start typing a city" value={city}
          onChange={(e) => { const c = findCity(e.target.value); onChange({ city: e.target.value, ...(c ? { tz: c.timezone } : {}) }); }} {...inputProps(ids.c, f.city)} />
        <datalist id={`${ids.c}-list`}>{CITIES.map((c) => <option key={cityLabel(c)} value={cityLabel(c)} />)}</datalist>
      </Field>
      {placed && (
        <Field label="Time zone" htmlFor={ids.z} error={f.timezone}
          help={known && tz && tz !== known.timezone ? `Changed from ${known.name}’s (${known.timezone.replace(/_/g, ' ')}).` : 'Follows the city. Change it if theirs is different.'}>
          <select className="select" id={ids.z} value={tz} onChange={(e) => onChange({ tz: e.target.value })}>
            {!tz && <option value="">Pick a city first</option>}
            {zones.map((z) => <option key={z} value={z}>{z.replace(/_/g, ' ')}{offsets.get(z) ? ` · ${offsets.get(z)}` : ''}</option>)}
          </select>
        </Field>
      )}
      {placed && (
        <Field label="Working hours" htmlFor={ids.h} error={f.workEnd ?? f.workStart} help={`Their local time · ${shiftLength(shiftOf(hours[0], hours[1]))}. The same start and end means around the clock.`}>
          <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
            <select className="select" id={ids.h} value={hours[0]} onChange={(e) => onChange({ hours: [Number(e.target.value), hours[1]] })}>{HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}</select>
            <span className="muted">to</span>
            <select className="select" aria-label="Working hours end" value={hours[1] % 24} onChange={(e) => onChange({ hours: [hours[0], Number(e.target.value)] })}>{HOURS.map((h) => <option key={h} value={h}>{fmtHour(h)}</option>)}</select>
          </div>
        </Field>
      )}
    </>
  );
}
