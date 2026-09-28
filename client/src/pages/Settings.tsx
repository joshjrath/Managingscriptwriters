// Settings (managers): deadline rules, timezone and cutoff, reminders, team.

import { useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, Check, Copy, Plus, RefreshCw, UserPlus } from 'lucide-react';
import { api, useSave } from '../api';
import type { Settings, UserSummary } from '../../../shared/types';
import { computeDeadlines, DEFAULT_RULES, isValidTimeZone } from '../../../shared/dates';
import { fmtCutoff, fmtLong, fmtStamp, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Avatar, Button, Chip, Dialog, Field, FormError, inputProps, Panel, useFieldId, useToast } from '../components/ui';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Phoenix', 'America/Toronto', 'Europe/London', 'Europe/Dublin', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Australia/Sydney', 'Pacific/Auckland', 'UTC'];

export function SettingsPage() {
  const { me } = useBoot();
  if (me.role !== 'manager') {
    return <><PageHeader title="Settings" /><Panel><p className="muted">Only managers can change organisation settings. You can change your password from the menu under your name.</p></Panel></>;
  }
  return (
    <>
      <PageHeader title="Settings" hideNewWork />
      <div className="grid g-2" style={{ alignItems: 'start' }}>
        <RulesPanel />
        <TeamPanel />
      </div>
    </>
  );
}

function RulesPanel() {
  const { settings } = useBoot();
  const toast = useToast();
  const [v, setV] = useState<Settings>(settings);
  const [recalc, setRecalc] = useState(false);
  useEffect(() => setV(settings), [settings]);
  const save = useSave(() => api<{ settings: Settings; recalculated: number }>('/api/settings', {
    method: 'PATCH',
    body: { orgName: v.orgName, timezone: v.timezone, cutoff: v.cutoff, draftOffsetDays: v.draftOffsetDays, finalOffsetDays: v.finalOffsetDays, dayMode: v.dayMode, workingDays: v.workingDays, reminderLeadDays: v.reminderLeadDays, recalculate: recalc },
  }), { onSuccess: (out) => { toast(`Settings saved${recalc ? ` · ${plural(out.recalculated, 'batch', 'batches')} recalculated` : ''}`); setRecalc(false); } });
  const f = save.error?.fields ?? {};
  const ids = { tz: useFieldId('tz'), cut: useFieldId('cut'), d: useFieldId('d'), fo: useFieldId('fo'), lead: useFieldId('lead'), org: useFieldId('org') };
  const example = computeDeadlines('2026-10-12', { ...DEFAULT_RULES, draftOffsetDays: v.draftOffsetDays, finalOffsetDays: v.finalOffsetDays, dayMode: v.dayMode, workingDays: v.workingDays.length ? v.workingDays : [1] });
  const changedRules = v.draftOffsetDays !== settings.draftOffsetDays || v.finalOffsetDays !== settings.finalOffsetDays || v.dayMode !== settings.dayMode || v.workingDays.join() !== settings.workingDays.join();
  return (
    <Panel title="Deadline rules & time">
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <div className="form-grid">
          <Field label="Drafts due" htmlFor={ids.d} error={f.draftOffsetDays} help="days before the shoot starts"><input className="input num" type="number" min={0} max={60} value={v.draftOffsetDays} onChange={(e) => setV({ ...v, draftOffsetDays: Number(e.target.value) })} {...inputProps(ids.d, f.draftOffsetDays)} /></Field>
          <Field label="Final delivery to Timeliner" htmlFor={ids.fo} error={f.finalOffsetDays} help="days before the shoot starts"><input className="input num" type="number" min={0} max={60} value={v.finalOffsetDays} onChange={(e) => setV({ ...v, finalOffsetDays: Number(e.target.value) })} {...inputProps(ids.fo, f.finalOffsetDays)} /></Field>
        </div>
        <div className="field">
          <span className="lbl">Count days as</span>
          <div className="seg" role="group" aria-label="Day counting" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={v.dayMode === 'calendar'} onClick={() => setV({ ...v, dayMode: 'calendar' })}>Calendar days</button>
            <button type="button" aria-pressed={v.dayMode === 'business'} onClick={() => setV({ ...v, dayMode: 'business' })}>Working days</button>
          </div>
          <span className="help">{v.dayMode === 'calendar' ? 'Every day counts, weekends included. Deadlines are never shifted silently.' : 'Only the working days below count, so deadlines always land on a working day.'}</span>
        </div>
        <div className="field">
          <span className="lbl">Working week</span>
          <div className="row-flex s2">{DAYS.map((d, i) => (
            <label key={d} className="check" style={{ background: 'var(--row)', padding: '4px 12px', borderRadius: 12 }}>
              <input type="checkbox" checked={v.workingDays.includes(i)} onChange={(e) => setV({ ...v, workingDays: e.target.checked ? [...v.workingDays, i].sort() : v.workingDays.filter((x) => x !== i) })} />{d}
            </label>
          ))}</div>
          <span className="help">{f.workingDays ?? 'Used for working-day deadlines and for writer capacity estimates.'}</span>
        </div>
        <div className="banner"><CalendarClock aria-hidden /><div className="txt"><b>Example: shoot on Oct 12–13, 2026</b><span>Drafts due {fmtLong(example.draftDue)} · final delivery {fmtLong(example.finalDue)}</span></div></div>
        {changedRules && <label className="check"><input type="checkbox" checked={recalc} onChange={(e) => setRecalc(e.target.checked)} />Also recalculate automatic deadlines on active batches (manual overrides are kept; writers are notified)</label>}
        <div className="form-grid">
          <Field label="Organisation timezone" htmlFor={ids.tz} error={f.timezone ?? (isValidTimeZone(v.timezone) ? undefined : 'Unknown timezone')} help="Decides what “today” is and when a deadline passes.">
            <select className="select" id={ids.tz} value={v.timezone} onChange={(e) => setV({ ...v, timezone: e.target.value })}>{[...new Set([v.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z.replace('_', ' ')}</option>)}</select>
          </Field>
          <Field label="Daily cutoff" htmlFor={ids.cut} error={f.cutoff} help={`Work is due by ${fmtCutoff(v.cutoff)} on the deadline day.`}><input className="input" type="time" value={v.cutoff} onChange={(e) => setV({ ...v, cutoff: e.target.value })} {...inputProps(ids.cut, f.cutoff)} /></Field>
          <Field label="Remind writers" htmlFor={ids.lead} error={f.reminderLeadDays} help="days before a deadline (plus on the day, and when overdue)"><input className="input num" type="number" min={0} max={14} value={v.reminderLeadDays} onChange={(e) => setV({ ...v, reminderLeadDays: Number(e.target.value) })} {...inputProps(ids.lead, f.reminderLeadDays)} /></Field>
          <Field label="Organisation name" htmlFor={ids.org} error={f.orgName}><input className="input" value={v.orgName} onChange={(e) => setV({ ...v, orgName: e.target.value })} {...inputProps(ids.org, f.orgName)} /></Field>
        </div>
        <p className="muted" style={{ fontSize: 12.5 }}>Reminders run on the server every 10 minutes while it’s running{settings.remindersLastRunAt ? ` · last run ${fmtStamp(settings.remindersLastRunAt, settings.timezone)}` : ' · not run yet'}.</p>
        <div className="form-actions"><Button type="submit" variant="primary pill" busy={save.isPending}>Save settings</Button></div>
      </form>
    </Panel>
  );
}

function TeamPanel() {
  const { users, me } = useBoot();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<UserSummary | null>(null);
  return (
    <Panel title="Team" count={users.filter((u) => u.active).length} tools={<Button variant="sm" icon={<UserPlus aria-hidden />} onClick={() => setAdding(true)}>Add person</Button>}>
      <div className="rows">
        {users.map((u) => (
          <button key={u.id} className="item clickable" style={{ border: 0, textAlign: 'left', color: 'inherit', font: 'inherit', opacity: u.active ? 1 : 0.55 }} onClick={() => setEditing(u)}>
            <div className="row-flex" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
              <Avatar name={u.name} id={u.id} />
              <div className="body"><div className="title">{u.name}{u.id === me.id ? ' (you)' : ''}</div><div className="meta ellipsis">{u.email}</div></div>
            </div>
            <div className="side">
              <Chip color={u.role === 'manager' ? 'salmon' : 'cyan'}>{u.role === 'manager' ? 'Manager' : 'Writer'}</Chip>
              <span className="muted" style={{ fontSize: 12 }}>{u.active ? (u.capacityPerDay ? `${u.capacityPerDay} scripts / working day` : 'Capacity not set') : 'Deactivated'}</span>
            </div>
          </button>
        ))}
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12 }}>Writers only show as over capacity when a capacity is set. Managers can be assigned scripts too.</p>
      {adding && <PersonDialog onClose={() => setAdding(false)} />}
      {editing && <PersonDialog user={editing} onClose={() => setEditing(null)} />}
    </Panel>
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

export function signInMessage(p: { name: string; email: string; password: string; role: 'manager' | 'writer'; orgName: string; url: string; reset?: boolean }): string {
  const first = p.name.trim().split(/\s+/)[0] || 'there';
  return [
    p.reset
      ? `Hi ${first}, your ${p.orgName} password has been reset.`
      : `Hi ${first}, you've been added to ${p.orgName}'s script production workspace as a ${p.role}.`,
    '',
    `Sign in: ${p.url}`,
    `Email: ${p.email}`,
    `Temporary password: ${p.password}`,
    '',
    p.reset
      ? 'Once you’re in, set your own password: click your name at the bottom left → Change password.'
      : `Once you’re in, set your own password: click your name at the bottom left → Change password. ${p.role === 'writer' ? 'Your scripts, deadlines and briefs are under “My work”.' : ''}`.trim(),
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
  const [copied, setCopied] = useState<'idle' | 'ok' | 'fail'>('idle');
  const copy = async () => setCopied((await copyText(message)) ? 'ok' : 'fail');
  return (
    <Dialog open onClose={onClose} title={`Send ${name} their sign-in details`} sub="Copy this and paste it into WhatsApp, Slack, text or email. The password is only shown now — it isn’t stored anywhere readable." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Done</Button><Button variant="primary pill" icon={copied === 'ok' ? <Check aria-hidden /> : <Copy aria-hidden />} onClick={copy}>{copied === 'ok' ? 'Copied' : 'Copy message'}</Button></div>}>
      <div className="form">
        <pre className="share-block" aria-label="Sign-in message">{message}</pre>
        {copied === 'fail' && <span className="err" role="alert" style={{ color: '#FF9C94', fontSize: 12.5, fontWeight: 600 }}>Your browser blocked copying — select the text above and copy it manually.</span>}
        {copied === 'ok' && <span className="muted" style={{ fontSize: 12.5 }} role="status">Copied to your clipboard.</span>}
      </div>
    </Dialog>
  );
}

function PersonDialog({ user, onClose }: { user?: UserSummary; onClose: () => void }) {
  const toast = useToast();
  const { me } = useBoot();
  const [name, setName] = useState(user?.name ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [role, setRole] = useState<'manager' | 'writer'>(user?.role ?? 'writer');
  const [capacity, setCapacity] = useState(user?.capacityPerDay != null ? String(user.capacityPerDay) : '');
  const { settings } = useBoot();
  const [password, setPassword] = useState(() => (user ? '' : generatePassword()));
  const [active, setActive] = useState(user?.active ?? true);
  const [share, setShare] = useState<string | null>(null);
  const save = useSave(() => user
    ? api(`/api/users/${user.id}`, { method: 'PATCH', body: { name, role, active, capacityPerDay: capacity ? Number(capacity) : null, password: password || undefined } })
    : api('/api/users', { body: { name, email, role, password, capacityPerDay: capacity ? Number(capacity) : null } }), {
    onSuccess: () => {
      if (!user || password) {
        // only now, right after saving, is the plain password known
        setShare(signInMessage({ name, email: user?.email ?? email.trim().toLowerCase(), password, role, orgName: settings.orgName, url: window.location.origin, reset: !!user }));
        toast(user ? `New password set for ${name}` : `${name} added`);
      } else {
        toast(`${name} updated`);
        onClose();
      }
    },
  });
  const f = save.error?.fields ?? {};
  const ids = { n: useFieldId('n'), e: useFieldId('e'), r: useFieldId('r'), c: useFieldId('c'), p: useFieldId('p') };
  if (share) return <ShareDetails message={share} name={name.split(/\s+/)[0] || name} onClose={onClose} />;
  return (
    <Dialog open onClose={onClose} title={user ? `Edit ${user.name}` : 'Add a person'} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)} icon={user ? undefined : <Plus aria-hidden />}>{user ? 'Save' : 'Add person'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Name" htmlFor={ids.n} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} /></Field>
        <Field label="Email" htmlFor={ids.e} error={f.email} help={user ? 'Email can’t be changed here.' : 'They sign in with this.'}><input className="input" type="email" value={email} disabled={!!user} onChange={(e) => setEmail(e.target.value)} {...inputProps(ids.e, f.email)} /></Field>
        <Field label="Role" htmlFor={ids.r} help="Writers see everything but can only update their own scripts, blockers, resources and deliveries.">
          <select className="select" id={ids.r} value={role} onChange={(e) => setRole(e.target.value as 'manager' | 'writer')}><option value="writer">Writer</option><option value="manager">Manager</option></select>
        </Field>
        <Field label="Capacity" optional htmlFor={ids.c} error={f.capacityPerDay} help="Scripts per working day. Used for start-date estimates and over-capacity warnings."><input className="input num" type="number" min={0.5} step={0.5} value={capacity} onChange={(e) => setCapacity(e.target.value)} {...inputProps(ids.c, f.capacityPerDay)} /></Field>
        <Field label={user ? 'Reset password' : 'Temporary password'} optional={!!user} htmlFor={ids.p} error={f.password} help={user ? 'Leave empty to keep their password. Set one and you’ll get a message to send them.' : 'At least 10 characters. After saving you’ll get a ready-to-send message with this and the sign-in link.'}>
          <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
            <input className="input" type="text" autoComplete="new-password" spellCheck={false} value={password} onChange={(e) => setPassword(e.target.value)} {...inputProps(ids.p, f.password)} />
            <Button variant="sm" icon={<RefreshCw aria-hidden />} onClick={() => setPassword(generatePassword())}>Generate</Button>
          </div>
        </Field>
        {user && user.id !== me.id && (
          <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} />Deactivate (signs them out; their history is kept)</label>
        )}
        {user && !active && user.active && <div className="banner yellow"><AlertTriangle aria-hidden /><div className="txt"><b>Reassign their open scripts after deactivating.</b></div></div>}
      </form>
    </Dialog>
  );
}
