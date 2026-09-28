// "New work": quick entry, new shoot, new batch and new client.
// Required fields are minimal; everything else sits behind "More options".
// After saving, the dialog shows exactly what was created and which dates apply.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarDays, Camera, CheckCheck, ChevronDown, FileText, Plus, Sparkles, Trash2, Type, Users } from 'lucide-react';
import { api, ApiError, queryClient, useSave } from '../api';
import { useBoot } from './Shell';
import { Button, Dialog, Field, FormError, inputProps, Seg, useFieldId, useToast } from './ui';
import { addDays, computeDeadlines, dueState, suggestStart, type ISODate } from '../../../shared/dates';
import { evenSplit, isManager } from '../../../shared/workflow';
import { fmtBytes, fmtDate, fmtLong, fmtRange, plural } from '../../../shared/format';
import { parseEntry, type ParsedEntry } from '../../../shared/parse';
import type { BatchSummary, ClientDetail, Priority, ResourceCategory } from '../../../shared/types';
import { PRIORITIES, PRIORITY_LABEL, RESOURCE_CATEGORIES, RESOURCE_LABEL } from '../../../shared/types';

export type NewWorkTab = 'quick' | 'shoot' | 'batch' | 'client';
export interface NewWorkPreset { prospect?: boolean; clientId?: number; shootId?: number; text?: string; start?: ISODate; end?: ISODate | null; count?: number; split?: SplitPart[] }

interface Created {
  kind: 'shoot' | 'batch' | 'client';
  title: string;
  lines: { k: string; v: ReactNode; rule?: string }[];
  warnings: string[];
  batchId?: number | null;
  clientId?: number;
}

const TABS: { id: NewWorkTab; label: string; icon: ReactNode }[] = [
  { id: 'shoot', label: 'New shoot', icon: <Camera aria-hidden /> },
  { id: 'batch', label: 'New batch', icon: <CalendarDays aria-hidden /> },
  { id: 'client', label: 'New client', icon: <Users aria-hidden /> },
  { id: 'quick', label: 'Quick entry', icon: <Type aria-hidden /> },
];

export function NewWorkDialog({ state, onClose }: { state: { tab: NewWorkTab; preset?: NewWorkPreset } | null; onClose: () => void }) {
  const [tab, setTab] = useState<NewWorkTab>('shoot');
  const [created, setCreated] = useState<Created | null>(null);
  const [preset, setPreset] = useState<NewWorkPreset | undefined>();
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    if (state) { setTab(state.tab); setPreset(state.preset); setCreated(null); setFormKey((k) => k + 1); }
  }, [state]);
  const again = () => { setCreated(null); setFormKey((k) => k + 1); };
  return (
    <Dialog open={!!state} onClose={onClose} title={created ? 'Created' : 'New work'} sub={created ? undefined : 'Only the essentials are required. More options are tucked away below.'} size="wide">
      {created ? (
        <CreatedView created={created} onClose={onClose} onAgain={again} />
      ) : (
        <>
          <Seg role="tablist" aria-label="What to create" style={{ marginBottom: 20 }}>
            {TABS.map((t) => (
              <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>{t.icon}{t.label}</button>
            ))}
          </Seg>
          {tab === 'shoot' && <ShootForm key={`s${formKey}`} preset={preset} onCreated={setCreated} />}
          {tab === 'batch' && <BatchForm key={`b${formKey}`} preset={preset} onCreated={setCreated} />}
          {tab === 'client' && <ClientForm key={`c${formKey}`} preset={preset} onCreated={setCreated} />}
          {tab === 'quick' && <QuickEntry key={`q${formKey}`} preset={preset} onCreated={setCreated} onOpenForm={(p) => { setPreset(p); setTab('shoot'); setFormKey((k) => k + 1); }} />}
        </>
      )}
    </Dialog>
  );
}

function CreatedView({ created, onClose, onAgain }: { created: Created; onClose: () => void; onAgain: () => void }) {
  const nav = useNavigate();
  return (
    <div className="stack s4">
      <div className="banner mint"><CheckCheck aria-hidden /><div className="txt"><b>{created.title}</b><span>Saved. Everyone on the team can see it now.</span></div></div>
      <dl className="kv">
        {created.lines.map((l, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <dt>{l.k}</dt>
            <dd><b>{l.v}</b>{l.rule && <div className="muted" style={{ fontSize: 12.5 }}>{l.rule}</div>}</dd>
          </div>
        ))}
      </dl>
      {created.warnings.map((w) => <div key={w} className="banner yellow"><AlertTriangle aria-hidden /><div className="txt"><b>{w}</b></div></div>)}
      <div className="form-actions">
        <Button variant="ghost" onClick={onAgain} icon={<Plus aria-hidden />} className="left">Create another</Button>
        {created.clientId && <Button onClick={() => { onClose(); nav(`/clients/${created.clientId}`); }}>Open client</Button>}
        {created.batchId && <Button variant="primary pill" onClick={() => { onClose(); nav(`/batches/${created.batchId}`); }}>Open batch</Button>}
        {!created.batchId && !created.clientId && <Button variant="primary pill" onClick={onClose}>Done</Button>}
      </div>
    </div>
  );
}

// ── shared pieces ────────────────────────────────────────────────────────

export interface SplitPart { writerId: number | ''; count: number | '' }

export function SplitEditor({ total, parts, onChange, error }: { total: number; parts: SplitPart[]; onChange: (p: SplitPart[]) => void; error?: string }) {
  const { users } = useBoot();
  const team = users.filter((u) => u.active);
  const assigned = parts.reduce((n, p) => n + (Number(p.count) || 0), 0);
  const over = total > 0 && assigned > total;
  const set = (i: number, patch: Partial<SplitPart>) => onChange(parts.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const even = () => {
    const chosen = parts.filter((p) => p.writerId !== '');
    const counts = evenSplit(total, chosen.length);
    onChange(chosen.map((p, i) => ({ ...p, count: counts[i] })));
  };
  let start = 1;
  return (
    <div className="split-editor">
      {parts.map((p, i) => {
        const n = Number(p.count) || 0;
        const range = n > 0 ? (n === 1 ? `Script ${start}` : `Scripts ${start}–${start + n - 1}`) : '';
        start += n;
        return (
          <div key={i}>
            <div className="split-row">
              <select className="select" aria-label={`Writer ${i + 1}`} value={p.writerId} onChange={(e) => set(i, { writerId: e.target.value ? Number(e.target.value) : '' })}>
                <option value="">Choose a writer…</option>
                {team.map((u) => (
                  <option key={u.id} value={u.id} disabled={parts.some((q, j) => j !== i && q.writerId === u.id)}>{u.name}{u.role !== 'writer' ? ` (${u.role})` : ''}</option>
                ))}
              </select>
              <input className="input num" type="number" min={0} max={500} inputMode="numeric" aria-label={`Scripts for writer ${i + 1}`} value={p.count} onChange={(e) => set(i, { count: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) })} />
              <button type="button" className="icon-btn sm" aria-label={`Remove writer ${i + 1}`} onClick={() => onChange(parts.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
            </div>
            {range && <div className="muted" style={{ fontSize: 12, margin: '4px 2px 0' }}>{range}</div>}
          </div>
        );
      })}
      <div className="row-flex s2">
        <Button variant="sm" icon={<Plus aria-hidden />} onClick={() => onChange([...parts, { writerId: '', count: '' }])}>Add writer</Button>
        {parts.length > 1 && total > 0 && <Button variant="ghost sm" onClick={even}>Split {total} evenly</Button>}
      </div>
      <div className="split-sum" aria-live="polite">
        <span className={over ? 'red' : ''}>{assigned} of {total || 0} assigned</span>
        {!over && total > assigned && <span>{plural(total - assigned, 'script')} will be unassigned — you can assign them later</span>}
        {over && <span className="red">Assigned more scripts than the batch has</span>}
      </div>
      {error && <span className="err" role="alert" style={{ color: '#FF9C94', fontSize: 12.5, fontWeight: 600 }}>{error}</span>}
    </div>
  );
}

function DeadlinePreview({ start, draftOverride, finalOverride }: { start: ISODate | ''; draftOverride?: ISODate | ''; finalOverride?: ISODate | '' }) {
  const { settings, clock } = useBoot();
  if (!start) return <div className="muted" style={{ fontSize: 13 }}>Enter the shoot start date to see the draft and final delivery deadlines.</div>;
  const d = computeDeadlines(start, settings);
  const draft = draftOverride || d.draftDue;
  const final = finalOverride || d.finalDue;
  const past = [dueState(draft, clock).overdue && `Drafts would be due ${fmtDate(draft)}, which has already passed.`, dueState(final, clock).overdue && `Final delivery would be due ${fmtDate(final)}, which has already passed.`].filter(Boolean) as string[];
  return (
    <div className="stack s2">
      <div className="preview-dates" aria-live="polite">
        <div><span className="k">Drafts due</span><span className="v">{fmtLong(draft)}</span><span className="r">{draftOverride ? 'Manual override' : d.draftRule}</span></div>
        <div><span className="k">Final delivery to Timeliner</span><span className="v">{fmtLong(final)}</span><span className="r">{finalOverride ? 'Manual override' : d.finalRule}</span></div>
      </div>
      {past.map((p) => <div key={p} className="banner red"><AlertTriangle aria-hidden /><div className="txt"><b>{p}</b><span>You can still save; the batch will show as overdue straight away.</span></div></div>)}
    </div>
  );
}

function useClient(clientId: number | '') {
  return useQuery({ queryKey: ['client', clientId], queryFn: () => api<ClientDetail>(`/api/clients/${clientId}`), enabled: !!clientId });
}

function ClientSelect({ id, value, onChange, error }: { id: string; value: number | ''; onChange: (v: number | '') => void; error?: string }) {
  const { clients } = useBoot();
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : '')} {...inputProps(id, error)}>
      <option value="">Choose a client…</option>
      {clients.filter((c) => c.status === 'active').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

function BriefingPicker({ client, value, onChange }: { client: ClientDetail | undefined; value: number[]; onChange: (v: number[]) => void }) {
  if (!client) return <span className="muted" style={{ fontSize: 13 }}>Choose a client to attach its briefings.</span>;
  if (!client.briefings.length) return <span className="muted" style={{ fontSize: 13 }}>This client has no briefing records yet. Add them from the client page.</span>;
  return (
    <div className="stack s2">
      {client.briefings.map((b) => (
        <label key={b.id} className="check">
          <input type="checkbox" checked={value.includes(b.id)} onChange={(e) => onChange(e.target.checked ? [...value, b.id] : value.filter((x) => x !== b.id))} />
          <span>{b.title}{b.callDate && <span className="muted"> · call {fmtDate(b.callDate)}</span>}{b.recordingUrl && <span className="muted"> · recording</span>}</span>
        </label>
      ))}
    </div>
  );
}

function PlannedStart({ id, value, onChange, draftDue, parts, error }: { id: string; value: string; onChange: (v: string) => void; draftDue: ISODate | ''; parts: SplitPart[]; error?: string }) {
  const { users, settings } = useBoot();
  const first = parts.find((p) => p.writerId !== '' && Number(p.count) > 0);
  const writer = first ? users.find((u) => u.id === first.writerId) : undefined;
  const est = draftDue && writer?.capacityPerDay ? suggestStart(draftDue, Number(first!.count), writer.capacityPerDay, settings.workingDays) : null;
  return (
    <Field label="Planned writing start" optional htmlFor={id} error={error}
      help={est ? `Estimate: ${fmtDate(est)} — ${writer!.name} writes about ${writer!.capacityPerDay} a day, so ${first!.count} scripts need ${Math.ceil(Number(first!.count) / writer!.capacityPerDay!)} working days before drafts are due.` : writer ? `No capacity set for ${writer.name}, so there’s no estimate. Capacity lives in Settings → Team.` : 'When writing should begin. Shown on the calendar.'}>
      <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
        <input className="input" type="date" value={value} onChange={(e) => onChange(e.target.value)} {...inputProps(id, error)} />
        {est && <Button variant="sm" onClick={() => onChange(est)}>Use estimate</Button>}
      </div>
    </Field>
  );
}

function Advanced({ children, label = 'More options' }: { children: ReactNode; label?: string }) {
  return (
    <details className="details">
      <summary><ChevronDown aria-hidden />{label}</summary>
      <div className="inner">{children}</div>
    </details>
  );
}

const cleanSplit = (parts: SplitPart[]) => parts.filter((p) => p.writerId !== '' && Number(p.count) > 0).map((p) => ({ writerId: Number(p.writerId), count: Number(p.count) }));

function splitLines(parts: { writerId: number; count: number }[], total: number, name: (id: number) => string) {
  let n = 1;
  const lines = parts.map((p) => { const r = p.count === 1 ? `${n}` : `${n}–${n + p.count - 1}`; n += p.count; return `${name(p.writerId)}: scripts ${r}`; });
  if (n <= total) lines.push(`Unassigned: scripts ${n === total ? n : `${n}–${total}`}`);
  return lines.join(' · ');
}

function useNames() {
  const { users } = useBoot();
  return (id: number) => users.find((u) => u.id === id)?.name ?? 'Unknown';
}

// ── recording & files for a new batch ────────────────────────────────────

interface Attach { recordingUrl: string; documentUrl: string; files: File[] }
const emptyAttach = (): Attach => ({ recordingUrl: '', documentUrl: '', files: [] });
const isUrl = (v: string) => /^https?:\/\/\S+$/i.test(v.trim());

function attachErrors(a: Attach): Record<string, string> {
  const e: Record<string, string> = {};
  if (a.recordingUrl.trim() && !isUrl(a.recordingUrl)) e.recordingUrl = 'Use a full link starting with https://';
  if (a.documentUrl.trim() && !isUrl(a.documentUrl)) e.documentUrl = 'Use a full link starting with https://';
  return e;
}

/** Saves the links and files onto the new batch. Returns warnings for anything that failed. */
async function saveAttachments(clientId: number, batchId: number | null, a: Attach): Promise<{ saved: string[]; warnings: string[] }> {
  const saved: string[] = [];
  const warnings: string[] = [];
  const links = [
    a.recordingUrl.trim() && { category: 'recording', title: 'Recording', url: a.recordingUrl.trim() },
    a.documentUrl.trim() && { category: 'document', title: 'Brief document', url: a.documentUrl.trim() },
  ].filter(Boolean) as { category: ResourceCategory; title: string; url: string }[];
  for (const l of links) {
    try { await api('/api/resources', { body: { clientId, batchId, ...l } }); saved.push(l.title.toLowerCase()); }
    catch (err) { warnings.push(`The batch was saved, but the ${l.title.toLowerCase()} link wasn’t (${(err as ApiError).message}). Add it from the batch page.`); }
  }
  for (const file of a.files) {
    const form = new FormData();
    form.set('clientId', String(clientId));
    if (batchId) form.set('batchId', String(batchId));
    form.set('category', /pdf|word|document|text/i.test(file.type) || /\.(pdf|docx?|txt)$/i.test(file.name) ? 'document' : 'asset');
    form.set('title', file.name);
    form.set('file', file);
    try { await api('/api/resources/upload', { form }); saved.push(file.name); }
    catch (err) { warnings.push(`The batch was saved, but “${file.name}” didn’t upload (${(err as ApiError).message}). Upload it from the batch page.`); }
  }
  return { saved, warnings };
}

function AttachmentsSection({ value, onChange, errors: shown }: { value: Attach; onChange: (a: Attach) => void; errors: Record<string, string> }) {
  const ids = { r: useFieldId('ar'), d: useFieldId('ad'), f: useFieldId('af') };
  // an error disappears as soon as the link is fixed
  const live = attachErrors(value);
  const errors = { recordingUrl: live.recordingUrl && shown.recordingUrl, documentUrl: live.documentUrl && shown.documentUrl };
  return (
    <div className="form-grid">
      <Field label="Recording link" optional htmlFor={ids.r} error={errors.recordingUrl} help="e.g. the Phantom recording of the ideation call">
        <input className="input" type="url" placeholder="https://" value={value.recordingUrl} onChange={(e) => onChange({ ...value, recordingUrl: e.target.value })} {...inputProps(ids.r, errors.recordingUrl)} />
      </Field>
      <Field label="Document link" optional htmlFor={ids.d} error={errors.documentUrl} help="Google Doc, Notion page, Drive folder…">
        <input className="input" type="url" placeholder="https://" value={value.documentUrl} onChange={(e) => onChange({ ...value, documentUrl: e.target.value })} {...inputProps(ids.d, errors.documentUrl)} />
      </Field>
      <Field label="Upload PDFs or files" optional htmlFor={ids.f} className="full" help="Choose one or several, up to 25 MB each. Only signed-in team members can open them.">
        <input className="input" type="file" multiple id={ids.f} accept=".pdf,.doc,.docx,.txt,.rtf,.png,.jpg,.jpeg,.webp,.key,.ppt,.pptx,.xls,.xlsx,.csv"
          onChange={(e) => { onChange({ ...value, files: [...value.files, ...Array.from(e.target.files ?? [])] }); e.target.value = ''; }} />
      </Field>
      {value.files.length > 0 && (
        <div className="full stack s2">
          {value.files.map((f, i) => (
            <div key={`${f.name}-${i}`} className="res">
              <span className="ic"><FileText /></span>
              <div style={{ minWidth: 0 }}><div className="t">{f.name}</div><div className="s">{fmtBytes(f.size)}</div></div>
              <button type="button" className="icon-btn sm" aria-label={`Remove ${f.name}`} onClick={() => onChange({ ...value, files: value.files.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const attachedLine = (saved: string[]) => (saved.length ? [{ k: 'Attached', v: saved.join(', ') }] : []);

// ── new shoot ────────────────────────────────────────────────────────────

function ShootForm({ preset, onCreated }: { preset?: NewWorkPreset; onCreated: (c: Created) => void }) {
  const { me, settings } = useBoot();
  const names = useNames();
  const p = preset;
  const [clientId, setClientId] = useState<number | ''>(p?.clientId ?? '');
  const [start, setStart] = useState<string>(p?.start ?? '');
  const [end, setEnd] = useState<string>(p?.end ?? '');
  const [count, setCount] = useState<number | ''>(p?.count ?? '');
  // scripts can be planned later, when the count and writers are known
  const [later, setLater] = useState(false);
  const [parts, setParts] = useState<SplitPart[]>(p?.split ?? [{ writerId: me.role === 'writer' ? me.id : '', count: '' }]);
  const [title, setTitle] = useState('');
  const [batchTitle, setBatchTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [planned, setPlanned] = useState('');
  const [draftOverride, setDraftOverride] = useState('');
  const [finalOverride, setFinalOverride] = useState('');
  const [briefingIds, setBriefingIds] = useState<number[]>([]);
  const [brief, setBrief] = useState('');
  const [location, setLocation] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Attach>(emptyAttach);
  const [uploading, setUploading] = useState(false);
  const client = useClient(clientId);
  const ids = { client: useFieldId('client'), start: useFieldId('start'), end: useFieldId('end'), count: useFieldId('count'), title: useFieldId('st'), bt: useFieldId('bt'), pr: useFieldId('pr'), ps: useFieldId('ps'), dd: useFieldId('dd'), fd: useFieldId('fd'), loc: useFieldId('loc'), brief: useFieldId('brief') };

  // single writer: default their count to the whole batch
  useEffect(() => {
    if (parts.length === 1 && parts[0].writerId !== '' && (parts[0].count === '' || parts[0].count === 0) && count) setParts([{ ...parts[0], count }]);
  }, [count, parts]);

  const save = useSave((body: Record<string, unknown>) => api<{ shootId: number; batchId: number | null; warnings: string[]; batch: BatchSummary | null }>('/api/shoots', { body }), {
    onSuccess: async (out) => {
      const d = computeDeadlines(start, settings);
      const split = cleanSplit(parts);
      setUploading(true);
      const att = await saveAttachments(Number(clientId), out.batchId, attach).finally(() => setUploading(false));
      await queryClient.invalidateQueries();
      if (!out.batch) {
        onCreated({
          kind: 'shoot', title: 'Shoot scheduled', clientId: Number(clientId), batchId: null, warnings: [...out.warnings, ...att.warnings],
          lines: [
            { k: 'Shoot', v: fmtRange(start, end || null) },
            { k: 'Scripts', v: 'Not planned yet — add them from the shoot on the calendar, the client page or Overview' },
            { k: 'Drafts would be due', v: d.draftDue ? fmtLong(d.draftDue) : '—', rule: d.draftRule },
            { k: 'Reminder', v: `${settings.planReminderDays} days before the shoot if scripts still aren’t planned` },
            ...attachedLine(att.saved),
          ],
        });
        return;
      }
      const batch = out.batch;
      onCreated({
        kind: 'shoot', title: `Shoot scheduled for ${batch.clientName}`, batchId: out.batchId, clientId: undefined,
        warnings: [...out.warnings, ...att.warnings],
        lines: [
          { k: 'Shoot', v: fmtRange(start, end || null) },
          { k: 'Batch', v: `${batch.title} · ${plural(Number(count), 'script')}` },
          { k: 'Writers', v: split.length ? splitLines(split, Number(count), names) : `None yet — all scripts unassigned. You’ll be reminded ${settings.planReminderDays} days before the shoot.` },
          { k: 'Drafts due', v: fmtLong(batch.draftDue!), rule: batch.draftDueMode === 'auto' ? d.draftRule : 'Manual override' },
          { k: 'Final delivery', v: fmtLong(batch.finalDue!), rule: batch.finalDueMode === 'auto' ? d.finalRule : 'Manual override' },
          ...(planned ? [{ k: 'Writing starts', v: fmtLong(planned) }] : []),
          ...attachedLine(att.saved),
        ],
      });
    },
  });
  const f = { ...local, ...(save.error?.fields ?? {}) };
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!clientId) errs.clientId = 'Choose a client';
    if (!start) errs.startDate = 'Enter the first shoot day';
    if (end && start && end < start) errs.endDate = 'The shoot can’t end before it starts';
    if (!later && (!count || Number(count) < 1)) errs['batch.targetCount'] = 'How many scripts are needed? Or choose “Plan scripts later”.';
    Object.assign(errs, attachErrors(attach));
    setLocal(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      clientId, title: title || null, startDate: start, endDate: end || null, location: location || null, notes: null,
      batch: later ? undefined : {
        title: batchTitle || null, targetCount: Number(count), priority, plannedStart: planned || null,
        draftDue: draftOverride || null, finalDue: finalOverride || null, brief: brief || null, nextAction: null,
        briefingIds, split: cleanSplit(parts),
      },
    });
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
      <div className="form-grid">
        <Field label="Client" htmlFor={ids.client} error={f.clientId} className="full"><ClientSelect id={ids.client} value={clientId} onChange={setClientId} error={f.clientId} /></Field>
        <Field label="Shoot starts" htmlFor={ids.start} error={f.startDate}><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} {...inputProps(ids.start, f.startDate)} /></Field>
        <Field label="Shoot ends" optional htmlFor={ids.end} error={f.endDate} help="Leave empty for a one-day shoot. Deadlines count back from the first day."><input className="input" type="date" value={end} min={start || undefined} onChange={(e) => setEnd(e.target.value)} {...inputProps(ids.end, f.endDate)} /></Field>
        <div className="field full">
          <span className="lbl">Scripts</span>
          <Seg role="group" aria-label="When to plan the scripts" style={{ alignSelf: 'flex-start' }}>
            <button type="button" aria-pressed={!later} onClick={() => setLater(false)}>Plan them now</button>
            <button type="button" aria-pressed={later} onClick={() => { setLater(true); setLocal((l) => { const { ['batch.targetCount']: _x, ...rest } = l; return rest; }); }}>Plan scripts later</button>
          </Seg>
          {later && <span className="help">Just book the shoot. Add the script count and writers when you know them — you’ll get a reminder {settings.planReminderDays} days before the shoot if they’re still not planned (change this in Settings).</span>}
        </div>
        {!later && <Field label="Scripts needed" htmlFor={ids.count} error={f['batch.targetCount']} help="Writers can be assigned now or later."><input className="input num" type="number" min={1} max={500} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value === '' ? '' : Number(e.target.value))} {...inputProps(ids.count, f['batch.targetCount'])} /></Field>}
        <div className="field full"><span className="lbl">{later ? 'Deadlines, once scripts are added' : 'Deadlines'}</span><DeadlinePreview start={start as ISODate} draftOverride={draftOverride as ISODate} finalOverride={finalOverride as ISODate} /></div>
        {!later && <div className="field full"><span className="lbl">Writers <span className="opt" style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>optional — assign later if you’re not sure</span></span><SplitEditor total={Number(count) || 0} parts={parts} onChange={setParts} error={f['batch.split']} /></div>}
      </div>
      <div className="field"><span className="lbl">Recording & files <span className="opt" style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>optional</span></span><AttachmentsSection value={attach} onChange={setAttach} errors={f} /></div>
      <Advanced>
        <div className="form-grid">
          <Field label="Shoot name" optional htmlFor={ids.title}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Autumn range shoot" id={ids.title} /></Field>
          <Field label="Batch name" optional htmlFor={ids.bt} help="Defaults to the shoot name and dates."><input className="input" value={batchTitle} onChange={(e) => setBatchTitle(e.target.value)} id={ids.bt} /></Field>
          <Field label="Priority" htmlFor={ids.pr}><select className="select" id={ids.pr} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}</select></Field>
          <PlannedStart id={ids.ps} value={planned} onChange={setPlanned} draftDue={(draftOverride || (start ? computeDeadlines(start, settings).draftDue : '')) as ISODate} parts={parts} error={f['batch.plannedStart']} />
          <Field label="Override drafts due" optional htmlFor={ids.dd} error={f['batch.draftDue'] ?? f.draftDue} help="Only if this batch needs a different date than the rule."><input className="input" type="date" value={draftOverride} onChange={(e) => setDraftOverride(e.target.value)} {...inputProps(ids.dd, f.draftDue)} /></Field>
          <Field label="Override final delivery" optional htmlFor={ids.fd} error={f['batch.finalDue']}><input className="input" type="date" value={finalOverride} onChange={(e) => setFinalOverride(e.target.value)} id={ids.fd} /></Field>
          <Field label="Location" optional htmlFor={ids.loc}><input className="input" value={location} onChange={(e) => setLocation(e.target.value)} id={ids.loc} /></Field>
          <div className="field full"><span className="lbl">Attach briefings</span><BriefingPicker client={client.data} value={briefingIds} onChange={setBriefingIds} /></div>
          <Field label="Brief for writers" optional htmlFor={ids.brief} className="full"><textarea className="textarea" value={brief} onChange={(e) => setBrief(e.target.value)} id={ids.brief} placeholder="What these scripts need to do, tone notes, anything batch-specific." /></Field>
        </div>
      </Advanced>
      <div className="form-actions">
        <Button type="submit" variant="primary pill lg" busy={save.isPending || uploading} onClick={submit}>{uploading ? 'Uploading files…' : later ? 'Schedule shoot' : 'Create shoot & batch'}</Button>
      </div>
    </form>
  );
}

// ── new batch ────────────────────────────────────────────────────────────

function BatchForm({ preset, onCreated }: { preset?: NewWorkPreset; onCreated: (c: Created) => void }) {
  const { settings, clock } = useBoot();
  const names = useNames();
  const [clientId, setClientId] = useState<number | ''>(preset?.clientId ?? '');
  const [title, setTitle] = useState('');
  const [count, setCount] = useState<number | ''>('');
  const [shootId, setShootId] = useState<number | ''>(preset?.shootId ?? '');
  const [draft, setDraft] = useState('');
  const [final, setFinal] = useState('');
  const [parts, setParts] = useState<SplitPart[]>([{ writerId: '', count: '' }]);
  const [priority, setPriority] = useState<Priority>('normal');
  const [planned, setPlanned] = useState('');
  const [briefingIds, setBriefingIds] = useState<number[]>([]);
  const [brief, setBrief] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [local, setLocal] = useState<Record<string, string>>({});
  const [attach, setAttach] = useState<Attach>(emptyAttach);
  const [uploading, setUploading] = useState(false);
  const client = useClient(clientId);
  const shoots = (client.data?.shoots ?? []).filter((s) => !s.cancelledAt && (s.endDate ?? s.startDate) >= addDays(clock.today, -1));
  const shoot = shoots.find((s) => s.id === shootId);
  const auto = shoot ? computeDeadlines(shoot.startDate, settings) : null;
  // adding scripts to a shoot: name the batch after it unless a name has been typed
  const [named, setNamed] = useState(false);
  useEffect(() => { if (shoot && !named) setTitle(`${shoot.title || 'Shoot'} · ${fmtRange(shoot.startDate, shoot.endDate)}`); }, [shoot, named]);
  const ids = { client: useFieldId('bc'), title: useFieldId('btl'), count: useFieldId('bn'), shoot: useFieldId('bs'), draft: useFieldId('bd'), final: useFieldId('bf'), pr: useFieldId('bp'), ps: useFieldId('bps'), brief: useFieldId('bb'), na: useFieldId('bna') };
  useEffect(() => {
    if (parts.length === 1 && parts[0].writerId !== '' && (parts[0].count === '' || parts[0].count === 0) && count) setParts([{ ...parts[0], count }]);
  }, [count, parts]);

  const save = useSave((body: Record<string, unknown>) => api<{ batchId: number; warnings: string[]; batch: BatchSummary }>('/api/batches', { body }), {
    onSuccess: async (out) => {
      const split = cleanSplit(parts);
      setUploading(true);
      const att = await saveAttachments(out.batch.clientId, out.batchId, attach).finally(() => setUploading(false));
      await queryClient.invalidateQueries();
      onCreated({
        kind: 'batch', title: `Batch created for ${out.batch.clientName}`, batchId: out.batchId, warnings: [...out.warnings, ...att.warnings],
        lines: [
          { k: 'Batch', v: `${out.batch.title} · ${plural(out.batch.targetCount, 'script')}` },
          { k: 'Shoot', v: out.batch.shootStart ? fmtRange(out.batch.shootStart, out.batch.shootEnd) : 'No shoot — standalone batch' },
          { k: 'Writers', v: split.length ? splitLines(split, out.batch.targetCount, names) : 'None yet — all scripts unassigned' },
          { k: 'Drafts due', v: out.batch.draftDue ? fmtLong(out.batch.draftDue) : 'Not set', rule: out.batch.draftDueMode === 'auto' ? auto?.draftRule : out.batch.draftDue ? 'Entered manually' : undefined },
          { k: 'Final delivery', v: out.batch.finalDue ? fmtLong(out.batch.finalDue) : 'Not set', rule: out.batch.finalDueMode === 'auto' ? auto?.finalRule : out.batch.finalDue ? 'Entered manually' : undefined },
          ...attachedLine(att.saved),
        ],
      });
    },
  });
  const f = { ...local, ...(save.error?.fields ?? {}) };
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!clientId) errs.clientId = 'Choose a client';
    if (!title.trim()) errs.title = 'Give the batch a name';
    if (!count || Number(count) < 1) errs.targetCount = 'How many scripts are needed?';
    if (draft && final && draft > final) errs.draftDue = 'Drafts must be due on or before final delivery';
    Object.assign(errs, attachErrors(attach));
    setLocal(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      clientId, title, targetCount: Number(count), shootId: shootId || null, draftDue: draft || null, finalDue: final || null,
      priority, plannedStart: planned || null, briefingIds, brief: brief || null, nextAction: nextAction || null, split: cleanSplit(parts),
    });
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
      <div className="form-grid">
        <Field label="Client" htmlFor={ids.client} error={f.clientId}><ClientSelect id={ids.client} value={clientId} onChange={(v) => { setClientId(v); setShootId(''); }} error={f.clientId} /></Field>
        <Field label="Batch name" htmlFor={ids.title} error={f.title}><input className="input" value={title} onChange={(e) => { setNamed(true); setTitle(e.target.value); }} placeholder="e.g. Initial 5 scripts" {...inputProps(ids.title, f.title)} /></Field>
        <Field label="Scripts needed" htmlFor={ids.count} error={f.targetCount}><input className="input num" type="number" min={1} max={500} inputMode="numeric" value={count} onChange={(e) => setCount(e.target.value === '' ? '' : Number(e.target.value))} {...inputProps(ids.count, f.targetCount)} /></Field>
        <Field label="Linked shoot" optional htmlFor={ids.shoot} help={shoot ? 'Deadlines are calculated from the shoot. Enter a date below only to override.' : 'Leave empty for work without a shoot.'}>
          <select className="select" id={ids.shoot} value={shootId} onChange={(e) => setShootId(e.target.value ? Number(e.target.value) : '')} disabled={!clientId}>
            <option value="">No shoot</option>
            {shoots.map((s) => <option key={s.id} value={s.id}>{s.title ? `${s.title} · ` : ''}{fmtRange(s.startDate, s.endDate)}</option>)}
          </select>
        </Field>
        <Field label={shoot ? 'Drafts due (override)' : 'Drafts due'} optional={!!shoot} htmlFor={ids.draft} error={f.draftDue} help={auto && !draft ? `${fmtDate(auto.draftDue)} · ${auto.draftRule}` : undefined}>
          <input className="input" type="date" value={draft} onChange={(e) => setDraft(e.target.value)} {...inputProps(ids.draft, f.draftDue)} />
        </Field>
        <Field label={shoot ? 'Final delivery (override)' : 'Final delivery to Timeliner'} optional={!!shoot} htmlFor={ids.final} error={f.finalDue} help={auto && !final ? `${fmtDate(auto.finalDue)} · ${auto.finalRule}` : undefined}>
          <input className="input" type="date" value={final} onChange={(e) => setFinal(e.target.value)} {...inputProps(ids.final, f.finalDue)} />
        </Field>
        <div className="field full"><span className="lbl">Writers</span><SplitEditor total={Number(count) || 0} parts={parts} onChange={setParts} error={f.split} /></div>
      </div>
      <div className="field"><span className="lbl">Recording & files <span className="opt" style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>optional</span></span><AttachmentsSection value={attach} onChange={setAttach} errors={f} /></div>
      <Advanced>
        <div className="form-grid">
          <Field label="Priority" htmlFor={ids.pr}><select className="select" id={ids.pr} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((x) => <option key={x} value={x}>{PRIORITY_LABEL[x]}</option>)}</select></Field>
          <PlannedStart id={ids.ps} value={planned} onChange={setPlanned} draftDue={(draft || auto?.draftDue || '') as ISODate} parts={parts} error={f.plannedStart} />
          <div className="field full"><span className="lbl">Attach briefings</span><BriefingPicker client={client.data} value={briefingIds} onChange={setBriefingIds} /></div>
          <Field label="Brief for writers" optional htmlFor={ids.brief} className="full"><textarea className="textarea" id={ids.brief} value={brief} onChange={(e) => setBrief(e.target.value)} /></Field>
          <Field label="Next action" optional htmlFor={ids.na} className="full"><input className="input" id={ids.na} value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="e.g. Confirm tone with the client" /></Field>
        </div>
      </Advanced>
      <div className="form-actions"><Button type="submit" variant="primary pill lg" busy={save.isPending || uploading} onClick={submit}>{uploading ? 'Uploading files…' : 'Create batch'}</Button></div>
    </form>
  );
}

// ── new client ───────────────────────────────────────────────────────────

function ClientForm({ preset, onCreated }: { preset?: NewWorkPreset; onCreated: (c: Created) => void }) {
  const { me, users } = useBoot();
  const [prospect, setProspect] = useState(!!preset?.prospect);
  const toast = useToast();
  const managers = users.filter((u) => u.active && isManager(u.role));
  const [name, setName] = useState('');
  const [ownerId, setOwnerId] = useState<number>(me.id);
  const [description, setDescription] = useState('');
  const [brandVoice, setBrandVoice] = useState('');
  const [guidance, setGuidance] = useState('');
  const [call, setCall] = useState({ title: 'Ideation call', callDate: '', recordingUrl: '', documentUrl: '', summary: '', instructions: '' });
  const [withCall, setWithCall] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [links, setLinks] = useState<{ title: string; url: string; category: ResourceCategory }[]>([]);
  const [withBatch, setWithBatch] = useState(false);
  const [batch, setBatch] = useState({ title: 'Initial scripts', targetCount: 5 as number | '', draftDue: '', finalDue: '' });
  const [parts, setParts] = useState<SplitPart[]>([{ writerId: '', count: '' }]);
  const [local, setLocal] = useState<Record<string, string>>({});
  const [uploading, setUploading] = useState(false);
  const ids = { name: useFieldId('cn'), owner: useFieldId('co'), desc: useFieldId('cd'), voice: useFieldId('cv'), guide: useFieldId('cg'), ct: useFieldId('ct'), cdate: useFieldId('cdt'), rec: useFieldId('crec'), doc: useFieldId('cdoc'), file: useFieldId('cf'), sum: useFieldId('cs'), ins: useFieldId('ci'), bt: useFieldId('cbt'), bn: useFieldId('cbn'), bd: useFieldId('cbd'), bf: useFieldId('cbf') };

  const save = useSave((body: Record<string, unknown>) => api<{ clientId: number; briefingId: number | null; batch: { batchId: number; warnings: string[] } | null }>('/api/clients', { body }), {
    onSuccess: async (out) => {
      const warnings = [...(out.batch?.warnings ?? [])];
      if (file && out.briefingId) {
        setUploading(true);
        const form = new FormData();
        form.set('clientId', String(out.clientId));
        form.set('briefingId', String(out.briefingId));
        form.set('category', 'document');
        form.set('title', file.name);
        form.set('file', file);
        try { await api('/api/resources/upload', { form }); }
        catch (err) { warnings.push(`The client was saved, but “${file.name}” didn’t upload (${(err as ApiError).message}). Upload it again from the client page.`); toast('File upload failed', 'error'); }
        finally { setUploading(false); }
      }
      onCreated({
        kind: 'client', title: prospect ? `${name} added to Potential clients` : `${name} added`, clientId: out.clientId, batchId: out.batch?.batchId ?? null, warnings,
        lines: [
          { k: prospect ? 'Potential client' : 'Client', v: name },
          ...(prospect ? [{ k: 'Next', v: 'When they sign, drag them into Clients (or open them and press Mark as client).' }] : []),
          ...(out.briefingId ? [{ k: 'Briefing', v: `${call.title}${call.callDate ? ` · ${fmtDate(call.callDate)}` : ''}${call.recordingUrl ? ' · recording linked' : ''}${file ? ` · ${file.name}` : ''}` }] : []),
          ...(links.length ? [{ k: 'Resources', v: plural(links.length, 'link') }] : []),
          ...(out.batch ? [{ k: 'Initial batch', v: `${batch.title} · ${plural(Number(batch.targetCount), 'script')}` }, { k: 'Drafts due', v: batch.draftDue ? fmtLong(batch.draftDue) : 'Not set' }, { k: 'Final delivery', v: batch.finalDue ? fmtLong(batch.finalDue) : 'Not set' }] : []),
        ],
      });
    },
  });
  const f = { ...local, ...(save.error?.fields ?? {}) };
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!name.trim()) errs.name = 'Client name is required';
    if (withBatch && !prospect && (!batch.targetCount || Number(batch.targetCount) < 1)) errs['initialBatch.targetCount'] = 'How many scripts?';
    if (withBatch && !prospect && !batch.title.trim()) errs['initialBatch.title'] = 'Name the batch';
    for (const [k, v] of [['briefing.recordingUrl', call.recordingUrl], ['briefing.documentUrl', call.documentUrl]] as const) {
      if (withCall && v && !/^https?:\/\/\S+$/i.test(v)) errs[k] = 'Use a full link starting with https://';
    }
    setLocal(errs);
    if (Object.keys(errs).length) return;
    save.mutate({
      name, prospect, ownerId, description: description || null, brandVoice: brandVoice || null, guidance: guidance || null,
      briefing: withCall ? { ...call, callDate: call.callDate || null, recordingUrl: call.recordingUrl || null, documentUrl: call.documentUrl || null, summary: call.summary || null, instructions: call.instructions || null } : undefined,
      links: links.filter((l) => l.url.trim()).map((l) => ({ ...l, title: l.title || l.url })),
      initialBatch: withBatch && !prospect ? { title: batch.title, targetCount: Number(batch.targetCount), draftDue: batch.draftDue || null, finalDue: batch.finalDue || null, split: cleanSplit(parts), priority: 'normal' } : undefined,
    });
  };
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
      <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
      <Seg role="group" aria-label="Client or potential client" style={{ alignSelf: 'flex-start' }}>
        <button type="button" aria-pressed={!prospect} onClick={() => setProspect(false)}>Client</button>
        <button type="button" aria-pressed={prospect} onClick={() => setProspect(true)}>Potential client</button>
      </Seg>
      {prospect && <span className="help" style={{ marginTop: -8 }}>Not signed yet. They sit in Potential clients until you drag them into Clients. Shoots and batches can be added once they’re a client.</span>}
      <div className="form-grid">
        <Field label={prospect ? 'Name' : 'Client name'} htmlFor={ids.name} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.name, f.name)} /></Field>
        <Field label="Internal owner" htmlFor={ids.owner}><select className="select" id={ids.owner} value={ownerId} onChange={(e) => setOwnerId(Number(e.target.value))}>{managers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
      </div>
      <label className="check"><input type="checkbox" checked={withCall} onChange={(e) => setWithCall(e.target.checked)} />Attach an ideation / briefing call</label>
      {withCall && (
        <div className="form-grid">
          <Field label="Call title" htmlFor={ids.ct}><input className="input" id={ids.ct} value={call.title} onChange={(e) => setCall({ ...call, title: e.target.value })} /></Field>
          <Field label="Call date" optional htmlFor={ids.cdate}><input className="input" type="date" id={ids.cdate} value={call.callDate} onChange={(e) => setCall({ ...call, callDate: e.target.value })} /></Field>
          <Field label="Recording link" optional htmlFor={ids.rec} error={f['briefing.recordingUrl']} help="e.g. the Phantom recording URL"><input className="input" type="url" placeholder="https://" value={call.recordingUrl} onChange={(e) => setCall({ ...call, recordingUrl: e.target.value })} {...inputProps(ids.rec, f['briefing.recordingUrl'])} /></Field>
          <Field label="Document link" optional htmlFor={ids.doc} error={f['briefing.documentUrl']}><input className="input" type="url" placeholder="https://" value={call.documentUrl} onChange={(e) => setCall({ ...call, documentUrl: e.target.value })} {...inputProps(ids.doc, f['briefing.documentUrl'])} /></Field>
          <Field label="Or upload the document" optional htmlFor={ids.file} className="full" help="PDF, Word, text or images, up to 25 MB. Stored privately; only signed-in team members can open it."><input className="input" type="file" id={ids.file} onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
          <Field label="Summary" optional htmlFor={ids.sum} className="full"><textarea className="textarea" id={ids.sum} value={call.summary} onChange={(e) => setCall({ ...call, summary: e.target.value })} /></Field>
          <Field label="Writing instructions" optional htmlFor={ids.ins} className="full"><textarea className="textarea" id={ids.ins} value={call.instructions} onChange={(e) => setCall({ ...call, instructions: e.target.value })} /></Field>
        </div>
      )}
      <Advanced label="Brand voice, guidance and links">
        <Field label="Description" optional htmlFor={ids.desc}><textarea className="textarea" id={ids.desc} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Brand voice" optional htmlFor={ids.voice}><textarea className="textarea" id={ids.voice} value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} /></Field>
        <Field label="Writing guidance" optional htmlFor={ids.guide}><textarea className="textarea" id={ids.guide} value={guidance} onChange={(e) => setGuidance(e.target.value)} /></Field>
        <div className="field"><span className="lbl">Folders, examples and assets</span>
          <div className="stack s2">
            {links.map((l, i) => (
              <div key={i} className="split-row" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1.3fr) 130px 40px' }}>
                <input className="input" placeholder="Title" aria-label={`Link ${i + 1} title`} value={l.title} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <input className="input" placeholder="https://" aria-label={`Link ${i + 1} URL`} value={l.url} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} aria-invalid={f[`links.${i}.url`] ? true : undefined} />
                <select className="select" aria-label={`Link ${i + 1} type`} value={l.category} onChange={(e) => setLinks(links.map((x, j) => (j === i ? { ...x, category: e.target.value as ResourceCategory } : x)))}>{RESOURCE_CATEGORIES.map((c) => <option key={c} value={c}>{RESOURCE_LABEL[c]}</option>)}</select>
                <button type="button" className="icon-btn sm" aria-label={`Remove link ${i + 1}`} onClick={() => setLinks(links.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
              </div>
            ))}
            <div><Button variant="sm" icon={<Plus aria-hidden />} onClick={() => setLinks([...links, { title: '', url: '', category: 'folder' }])}>Add link</Button></div>
          </div>
        </div>
      </Advanced>
      {!prospect && <label className="check"><input type="checkbox" checked={withBatch} onChange={(e) => setWithBatch(e.target.checked)} />Create an initial batch (no shoot needed)</label>}
      {withBatch && !prospect && (
        <div className="form-grid">
          <Field label="Batch name" htmlFor={ids.bt} error={f['initialBatch.title']}><input className="input" value={batch.title} onChange={(e) => setBatch({ ...batch, title: e.target.value })} {...inputProps(ids.bt, f['initialBatch.title'])} /></Field>
          <Field label="Scripts" htmlFor={ids.bn} error={f['initialBatch.targetCount']}><input className="input num" type="number" min={1} value={batch.targetCount} onChange={(e) => setBatch({ ...batch, targetCount: e.target.value === '' ? '' : Number(e.target.value) })} {...inputProps(ids.bn, f['initialBatch.targetCount'])} /></Field>
          <Field label="Drafts due" optional htmlFor={ids.bd}><input className="input" type="date" id={ids.bd} value={batch.draftDue} onChange={(e) => setBatch({ ...batch, draftDue: e.target.value })} /></Field>
          <Field label="Final delivery" optional htmlFor={ids.bf} error={f['initialBatch.draftDue'] ?? f.draftDue}><input className="input" type="date" id={ids.bf} value={batch.finalDue} onChange={(e) => setBatch({ ...batch, finalDue: e.target.value })} /></Field>
          <div className="field full"><span className="lbl">Writers</span><SplitEditor total={Number(batch.targetCount) || 0} parts={parts} onChange={setParts} /></div>
        </div>
      )}
      <div className="form-actions"><Button type="submit" variant="primary pill lg" busy={save.isPending || uploading} onClick={submit}>{prospect ? 'Add potential client' : 'Create client'}</Button></div>
    </form>
  );
}

// ── quick entry ──────────────────────────────────────────────────────────

function QuickEntry({ preset, onCreated, onOpenForm }: { preset?: NewWorkPreset; onCreated: (c: Created) => void; onOpenForm: (p: NewWorkPreset) => void }) {
  const boot = useBoot();
  const names = useNames();
  const [text, setText] = useState(preset?.text ?? '');
  const [parsed, setParsed] = useState<ParsedEntry | null>(null);
  // resolutions for whatever the parser couldn't decide
  const [clientChoice, setClientChoice] = useState<number | 'new' | ''>('');
  const [dateChoice, setDateChoice] = useState<number>(-1);
  const [manualStart, setManualStart] = useState('');
  const [count, setCount] = useState<number | ''>('');
  const [writerChoice, setWriterChoice] = useState<Record<number, number | ''>>({});
  const [confirmNew, setConfirmNew] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const tid = useFieldId('qe');

  const run = () => {
    const p = parseEntry(text, { clients: boot.clients, users: boot.users, today: boot.clock.today });
    setParsed(p);
    setClientChoice(p.client.kind === 'matched' && !p.client.archived ? p.client.id : p.client.kind === 'new' ? 'new' : '');
    setDateChoice(p.dates.kind === 'ok' ? 0 : -1);
    setManualStart('');
    setCount(p.count ?? '');
    setWriterChoice(Object.fromEntries(p.writers.map((w, i) => [i, w.kind === 'matched' ? w.id : ''])));
    setConfirmNew(false);
    setErr(null);
  };

  const resolved = useMemo(() => {
    if (!parsed) return null;
    let start: ISODate | '' = '';
    let end: ISODate | null = null;
    const d = parsed.dates;
    if (d.kind === 'ok') { start = d.start; end = d.end; }
    else if (d.kind === 'needs_year' && dateChoice >= 0) { start = d.options[dateChoice].start; end = d.options[dateChoice].end; }
    else if (d.kind === 'ambiguous' && dateChoice >= 0) { start = d.options[dateChoice].start; end = d.options[dateChoice].end; }
    if (manualStart) { start = manualStart as ISODate; end = null; }
    const writers = [...new Set(Object.values(writerChoice).filter((x): x is number => typeof x === 'number'))];
    return { start, end, writers };
  }, [parsed, dateChoice, manualStart, writerChoice]);

  const newName = parsed?.client.kind === 'new' ? parsed.client.name : '';
  const ready = !!parsed && !!resolved?.start && !!count && Number(count) > 0 && (typeof clientChoice === 'number' || (clientChoice === 'new' && confirmNew));
  const counts = resolved ? evenSplit(Number(count) || 0, resolved.writers.length) : [];
  const split = resolved ? resolved.writers.map((w, i) => ({ writerId: w, count: counts[i] })) : [];

  const create = async () => {
    if (!ready || !resolved) return;
    setBusy(true);
    setErr(null);
    try {
      let clientId = clientChoice as number;
      if (clientChoice === 'new') {
        const c = await api<{ clientId: number }>('/api/clients', { body: { name: newName, links: [] } });
        clientId = c.clientId;
      }
      const out = await api<{ batchId: number; warnings: string[]; batch: BatchSummary }>('/api/shoots', {
        body: { clientId, startDate: resolved.start, endDate: resolved.end, batch: { targetCount: Number(count), split, briefingIds: [], priority: 'normal' } },
      });
      const d = computeDeadlines(resolved.start as ISODate, boot.settings);
      await queryClient.invalidateQueries();
      onCreated({
        kind: 'shoot', title: `Shoot scheduled for ${out.batch.clientName}`, batchId: out.batchId, warnings: out.warnings,
        lines: [
          ...(clientChoice === 'new' ? [{ k: 'New client', v: newName }] : []),
          { k: 'Shoot', v: fmtRange(resolved.start as ISODate, resolved.end) },
          { k: 'Batch', v: `${out.batch.title} · ${plural(Number(count), 'script')}` },
          { k: 'Writers', v: split.length ? splitLines(split, Number(count), names) : 'None yet — all scripts unassigned' },
          { k: 'Drafts due', v: fmtLong(d.draftDue), rule: d.draftRule },
          { k: 'Final delivery', v: fmtLong(d.finalDue), rule: d.finalRule },
        ],
      });
    } catch (e) {
      setErr(e as ApiError);
      await queryClient.invalidateQueries();
    } finally {
      setBusy(false);
    }
  };

  const deadlines = resolved?.start ? computeDeadlines(resolved.start as ISODate, boot.settings) : null;
  return (
    <div className="form">
      <div className="banner"><Sparkles aria-hidden /><div className="txt"><b>Type it the way you’d say it.</b><span>A pattern-based reader (no AI service) pulls out the client, shoot dates, script count and writers. You’ll see a preview and confirm before anything is saved. Anything unclear is asked, never guessed.</span></div></div>
      <Field label="Describe the work" htmlFor={tid}>
        <textarea className="textarea" id={tid} value={text} onChange={(e) => setText(e.target.value)} placeholder="Acme has a shoot October 12–13, 2026, needs 45 scripts, and Sarah is writing them."
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) run(); }} />
      </Field>
      <div className="form-actions"><Button variant="salmon pill" onClick={run} disabled={!text.trim()}>Preview</Button></div>
      {parsed && resolved && (
        <div className="panel elev stack s4" aria-live="polite">
          <h3 style={{ fontSize: 17 }}>Preview</h3>
          <dl className="kv">
            <dt>Client</dt>
            <dd>
              {parsed.client.kind === 'matched' && !parsed.client.archived && <b>{parsed.client.name}</b>}
              {parsed.client.kind === 'matched' && parsed.client.archived && <span className="red">{parsed.client.name} is archived — restore it first or choose another.</span>}
              {(parsed.client.kind !== 'matched' || parsed.client.archived) && (
                <div className="stack s2" style={{ marginTop: parsed.client.kind === 'matched' ? 8 : 0 }}>
                  {parsed.client.kind === 'new' && <span className="muted">No existing client is called “{newName}”.</span>}
                  <select className="select" aria-label="Choose the client" value={clientChoice} onChange={(e) => setClientChoice(e.target.value === 'new' ? 'new' : e.target.value ? Number(e.target.value) : '')}>
                    <option value="">Choose a client…</option>
                    {newName && <option value="new">Create new client “{newName}”</option>}
                    {(parsed.client.kind === 'ambiguous' ? parsed.client.options : boot.clients.filter((c) => c.status === 'active')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  {clientChoice === 'new' && <label className="check"><input type="checkbox" checked={confirmNew} onChange={(e) => setConfirmNew(e.target.checked)} />Yes, create “{newName}” as a new client</label>}
                </div>
              )}
            </dd>
            <dt>Shoot dates</dt>
            <dd>
              {parsed.dates.kind === 'ok' && !manualStart && <b>{fmtRange(parsed.dates.start, parsed.dates.end)}</b>}
              {parsed.dates.kind === 'needs_year' && (
                <div className="stack s2"><span className="muted">“{parsed.dates.text}” has no year. Which one?</span>
                  <div className="row-flex s2">{parsed.dates.options.map((o, i) => <label key={o.year} className="check"><input type="radio" name="qe-year" checked={dateChoice === i} onChange={() => setDateChoice(i)} />{fmtRange(o.start, o.end)}</label>)}</div>
                </div>
              )}
              {parsed.dates.kind === 'ambiguous' && (
                <div className="stack s2"><span className="muted">“{parsed.dates.text}” could be read two ways:</span>
                  <div className="row-flex s2">{parsed.dates.options.map((o, i) => <label key={o.label} className="check"><input type="radio" name="qe-amb" checked={dateChoice === i} onChange={() => setDateChoice(i)} />{fmtRange(o.start, o.end)} ({o.label})</label>)}</div>
                </div>
              )}
              {(parsed.dates.kind === 'missing' || parsed.dates.kind === 'invalid') && (
                <div className="stack s2">{parsed.dates.kind === 'invalid' && <span className="red">“{parsed.dates.text}”: {parsed.dates.reason}.</span>}<input className="input" type="date" aria-label="Shoot start date" value={manualStart} onChange={(e) => setManualStart(e.target.value)} /></div>
              )}
            </dd>
            <dt>Scripts</dt>
            <dd><input className="input num" type="number" min={1} aria-label="Script count" style={{ maxWidth: 140 }} value={count} onChange={(e) => setCount(e.target.value === '' ? '' : Number(e.target.value))} />{!parsed.count && <div className="muted" style={{ fontSize: 12.5, marginTop: 4 }}>No script count found — enter it here.</div>}</dd>
            <dt>Writers</dt>
            <dd>
              {!parsed.writers.length && <span className="muted">No writer found — scripts will be unassigned. You can assign them after saving.</span>}
              <div className="stack s2">
                {parsed.writers.map((w, i) => (
                  <div key={i} className="row-flex s2">
                    {w.kind === 'matched' && <b>{w.name}</b>}
                    {w.kind !== 'matched' && (
                      <>
                        <span className={w.kind === 'unknown' ? 'red' : 'muted'}>{w.kind === 'unknown' ? `No team member called “${w.text}”.` : `Which ${w.text}?`}</span>
                        <select className="select sm" style={{ width: 'auto' }} aria-label={`Writer for “${w.text}”`} value={writerChoice[i] ?? ''} onChange={(e) => setWriterChoice({ ...writerChoice, [i]: e.target.value ? Number(e.target.value) : '' })}>
                          <option value="">{w.kind === 'unknown' ? 'Skip' : 'Choose…'}</option>
                          {(w.kind === 'ambiguous' ? w.options : boot.users.filter((u) => u.active)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </>
                    )}
                  </div>
                ))}
                {split.length > 1 && <span className="muted" style={{ fontSize: 12.5 }}>Split evenly: {splitLines(split, Number(count) || 0, names)}</span>}
              </div>
            </dd>
            <dt>Drafts due</dt>
            <dd>{deadlines ? <><b>{fmtLong(deadlines.draftDue)}</b><div className="muted" style={{ fontSize: 12.5 }}>{deadlines.draftRule}</div></> : <span className="muted">Needs a shoot date</span>}</dd>
            <dt>Final delivery</dt>
            <dd>{deadlines ? <><b>{fmtLong(deadlines.finalDue)}</b><div className="muted" style={{ fontSize: 12.5 }}>{deadlines.finalRule}</div></> : <span className="muted">Needs a shoot date</span>}</dd>
          </dl>
          {deadlines && dueState(deadlines.draftDue, boot.clock).overdue && <div className="banner red"><AlertTriangle aria-hidden /><div className="txt"><b>The draft deadline ({fmtDate(deadlines.draftDue)}) has already passed.</b></div></div>}
          <FormError error={err} />
          <div className="form-actions">
            <Button variant="ghost" className="left" onClick={() => onOpenForm({ clientId: typeof clientChoice === 'number' ? clientChoice : undefined, start: (resolved.start || undefined) as ISODate | undefined, end: resolved.end, count: Number(count) || undefined, split: split.length ? split : undefined })}>Edit in full form</Button>
            <Button variant="primary pill lg" disabled={!ready} busy={busy} onClick={create}>Confirm & create</Button>
          </div>
          {!ready && <span className="muted" style={{ fontSize: 12.5, textAlign: 'right' }}>Answer the questions above to continue.</span>}
        </div>
      )}
    </div>
  );
}

