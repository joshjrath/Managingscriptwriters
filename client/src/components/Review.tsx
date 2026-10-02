// Review by document: writers send their scripts as one PDF or link; managers
// approve it, send it back with notes (and their marked-up version), or
// approve with their own edits. Used by the Review queue, My work and the
// batch page so all three read the same way.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Check, ChevronDown, ExternalLink, FileText, Link2, PenLine, RotateCcw, Send, Upload } from 'lucide-react';
import { api, ApiError, useSave } from '../api';
import type { Attachment, ReviewGroup, Script, Submission } from '../../../shared/types';
import { compressRanges, parseRanges, parseTitleLines } from '../../../shared/workflow';
import { fmtBytes, fmtStamp, plural } from '../../../shared/format';
import { useBoot, useDisplayTz } from './Shell';
import { burst, centerOf, confetti, plane } from '../fx';
import { SPRING } from '../motion';
import { Button, Chip, Dialog, DueChip, Field, FormError, inputProps, Seg, useFieldId, useToast } from './ui';

export const docHref = (a: Attachment) => (a.fileId ? `/api/files/${a.fileId}` : a.url ?? '#');
export const hasDoc = (a: Attachment | null | undefined): a is Attachment => !!a && !!(a.fileId || a.url);

function docName(a: Attachment): string {
  if (a.fileName) return a.fileName;
  try {
    const u = new URL(a.url!);
    if (/docs\.google\.com/.test(u.host)) return 'Google Doc';
    if (/drive\.google\.com/.test(u.host)) return 'Google Drive file';
    return u.host.replace(/^www\./, '');
  } catch { return 'Open link'; }
}

/** A document row: icon, name, size and an Open button. */
export function DocRow({ a, label, tone }: { a: Attachment; label?: string; tone?: 'salmon' | 'lavender' | 'pink' }) {
  return (
    <div className="res doc-row" style={tone ? { ['--c' as string]: `var(--${tone})` } : undefined}>
      <span className="ic">{a.fileId ? <FileText /> : <Link2 />}</span>
      <div style={{ minWidth: 0 }}>
        <div className="t">{label ? `${label}: ` : ''}{docName(a)}</div>
        <div className="s">{a.fileId ? `PDF / file · ${fmtBytes(a.fileSize)}` : a.url}</div>
      </div>
      <a className="btn sm" href={docHref(a)} target="_blank" rel="noopener noreferrer">Open<ExternalLink aria-hidden /></a>
    </div>
  );
}

// ── cards that glide in, and out the way they were decided ───────────────

/** How a card left the list: approved cards glide right, sent-back cards glide left. */
const leaving = new Map<string, 'approved' | 'sent_back'>();
const MINT = ['#60D1BE', '#A6F0E2', '#F4ED70', '#FFFFFF'];
const PINK = ['#E77AB5', '#F7B8D8', '#F2A599'];

const exitFor = (key: string) => (map: Map<string, string>) => {
  const why = map.get(key);
  const ease = [0.32, 0, 0.67, 0] as const;
  if (why === 'approved') return { opacity: 0, x: 80, scale: 0.96, transition: { duration: 0.32, ease } };
  if (why === 'sent_back') return { opacity: 0, x: -80, scale: 0.96, transition: { duration: 0.32, ease } };
  return { opacity: 0, scale: 0.97, transition: { duration: 0.18, ease } };
};

export function CardList({ groups, children }: { groups: ReviewGroup[]; children: (g: ReviewGroup) => ReactNode }) {
  return (
    <AnimatePresence initial={false} mode="popLayout" custom={leaving}>
      {groups.map((g) => (
        <m.div key={g.key} layout="position" custom={leaving}
          variants={{ enter: { opacity: 0, y: 18, scale: 0.98 }, shown: { opacity: 1, y: 0, scale: 1, transition: SPRING }, exit: exitFor(g.key) }}
          initial="enter" animate="shown" exit="exit">
          {children(g)}
        </m.div>
      ))}
    </AnimatePresence>
  );
}

// ── attachment input (upload or link) ────────────────────────────────────

export interface AttachValue { mode: 'none' | 'file' | 'link'; file: File | null; url: string }
export const emptyAttach = (mode: AttachValue['mode'] = 'none'): AttachValue => ({ mode, file: null, url: '' });

function AttachInput({ value, onChange, allowNone, error, fileHelp, linkHelp }: { value: AttachValue; onChange: (v: AttachValue) => void; allowNone?: boolean; error?: string; fileHelp: string; linkHelp: string }) {
  const f = useFieldId('att-f');
  const l = useFieldId('att-l');
  return (
    <div className="stack s2">
      <Seg role="group" aria-label="Attachment type" style={{ alignSelf: 'flex-start' }}>
        {allowNone && <button type="button" aria-pressed={value.mode === 'none'} onClick={() => onChange({ ...value, mode: 'none' })}>Nothing</button>}
        <button type="button" aria-pressed={value.mode === 'file'} onClick={() => onChange({ ...value, mode: 'file' })}><Upload aria-hidden />Upload PDF</button>
        <button type="button" aria-pressed={value.mode === 'link'} onClick={() => onChange({ ...value, mode: 'link' })}><Link2 aria-hidden />Paste link</button>
      </Seg>
      {value.mode === 'file' && (
        <Field label="File" htmlFor={f} error={error} help={fileHelp}>
          <input className="input" type="file" accept=".pdf,.doc,.docx,.txt,.rtf,.pages,.png,.jpg,.jpeg" onChange={(e) => onChange({ ...value, file: e.target.files?.[0] ?? null })} {...inputProps(f, error)} />
        </Field>
      )}
      {value.mode === 'link' && (
        <Field label="Link" htmlFor={l} error={error} help={linkHelp}>
          <input className="input" type="url" placeholder="https://docs.google.com/…" value={value.url} onChange={(e) => onChange({ ...value, url: e.target.value })} {...inputProps(l, error)} />
        </Field>
      )}
    </div>
  );
}

function attachError(v: AttachValue, required: boolean): string | undefined {
  if (v.mode === 'file' && !v.file) return required ? 'Choose the PDF to upload' : 'Choose a file, or pick “Nothing”';
  if (v.mode === 'link' && !/^https?:\/\/\S+$/i.test(v.url.trim())) return 'Paste a full link starting with https://';
  if (v.mode === 'none' && required) return 'Upload the PDF or paste the link';
  return undefined;
}

/** Sends JSON, or a multipart form when a file is attached. */
function postWith<T>(path: string, fields: Record<string, unknown>, att: AttachValue) {
  if (att.mode === 'file' && att.file) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) form.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    form.set('file', att.file);
    return api<T>(path, { form });
  }
  return api<T>(path, { body: { ...fields, url: att.mode === 'link' ? att.url.trim() : null } });
}

// ── titles ───────────────────────────────────────────────────────────────

export const titleLines = (scripts: Pick<Script, 'number' | 'title'>[]) => scripts.map((s) => `${s.number}. ${s.title ?? ''}`).join('\n');

function TitlesField({ id, scripts, value, onChange }: { id: string; scripts: Script[]; value: string; onChange: (v: string) => void }) {
  return (
    <Field label="Titles" optional htmlFor={id} help="One per line. Keep the number, or paste a plain list and it’s applied in order.">
      <textarea className="textarea tnum" id={id} rows={Math.min(12, Math.max(4, scripts.length + 1))} value={value} onChange={(e) => onChange(e.target.value)} spellCheck />
    </Field>
  );
}

export function TitlesDialog({ batchId, scripts, onClose }: { batchId: number; scripts: Script[]; onClose: () => void }) {
  const toast = useToast();
  const [text, setText] = useState(titleLines(scripts));
  const id = useFieldId('titles');
  const save = useSave(() => api<{ changed: number }>(`/api/batches/${batchId}/titles`, { body: { titles: parseTitleLines(text, scripts.map((s) => s.number)) } }), {
    onSuccess: (out) => { toast(out.changed ? `Updated ${plural(out.changed, 'title')}` : 'No titles changed'); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title="Script titles" sub={`Scripts ${compressRanges(scripts.map((s) => s.number))}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>Save titles</Button></div>}>
      <div className="form"><FormError error={save.error} /><TitlesField id={id} scripts={scripts} value={text} onChange={setText} /></div>
    </Dialog>
  );
}

// ── sending scripts for review ───────────────────────────────────────────

/**
 * Send a set of scripts as one document. `candidates` are the scripts that
 * can be sent (the writer's own, not yet approved); `preselect` is the default.
 */
export function SendDialog({ batchId, batchTitle, candidates, preselect, resend, onClose }: { batchId: number; batchTitle: string; candidates: Script[]; preselect: number[]; resend?: boolean; onClose: () => void }) {
  const toast = useToast();
  const pre = candidates.filter((s) => preselect.includes(s.id));
  const [scope, setScope] = useState<'all' | 'some'>('all');
  const [range, setRange] = useState(compressRanges(pre.map((s) => s.number)));
  const [att, setAtt] = useState<AttachValue>(emptyAttach('file'));
  const [note, setNote] = useState('');
  const [showTitles, setShowTitles] = useState(false);
  const [titles, setTitles] = useState(titleLines(pre));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const ids = { r: useFieldId('rng'), n: useFieldId('note'), t: useFieldId('ttl') };
  const chosen = useMemo(() => {
    if (scope === 'all') return pre;
    const nums = parseRanges(range, Math.max(0, ...candidates.map((s) => s.number)));
    return nums ? candidates.filter((s) => nums.includes(s.number)) : [];
  }, [scope, range, pre, candidates]);
  const from = useRef<{ x: number; y: number } | null>(null);
  const save = useSave(() => postWith(`/api/batches/${batchId}/submissions`, {
    scriptIds: chosen.map((s) => s.id), note: note.trim() || null,
    titles: showTitles ? parseTitleLines(titles, chosen.map((s) => s.number)) : [],
  }, att), { onSuccess: () => { plane(from.current ?? centerOf(null)); toast(`Sent ${plural(chosen.length, 'script')} for review as one document`); onClose(); } });
  const submit = () => {
    from.current = centerOf(document.activeElement);
    const e: Record<string, string> = {};
    const a = attachError(att, true);
    if (a) e.document = a;
    if (!chosen.length) e.range = `Use script numbers from ${compressRanges(candidates.map((s) => s.number))}, like 1–5`;
    setErrs(e);
    if (!Object.keys(e).length) save.mutate(undefined);
  };
  const server = save.error as ApiError | null;
  return (
    <Dialog open onClose={onClose} title={resend ? 'Send your revised version' : 'Send scripts for review'} sub={`${batchTitle} · one document for all the scripts it covers`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" icon={<Send aria-hidden />} busy={save.isPending} onClick={submit}>Send {plural(chosen.length, 'script')}</Button></div>}>
      <div className="form">
        <FormError error={server && !Object.keys(server.fields).length ? server : null} />
        <div className="field">
          <span className="lbl">Your document</span>
          <AttachInput value={att} onChange={setAtt} error={errs.document ?? server?.fields.document}
            fileHelp="A PDF with all the scripts is ideal. Up to 25 MB."
            linkHelp="Google Docs or Drive: set sharing so the team can open it (and edit, if you want changes made in the doc)." />
        </div>
        <div className="field">
          <span className="lbl">Which scripts does it cover?</span>
          <label className="check"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />{pre.length === 1 ? `Script ${compressRanges(pre.map((s) => s.number))}` : `${pre.length === candidates.length ? 'All ' : ''}${pre.length} scripts: ${compressRanges(pre.map((s) => s.number))}`}</label>
          <label className="check"><input type="radio" name="scope" checked={scope === 'some'} onChange={() => setScope('some')} />Only some</label>
          {scope === 'some' && (
            <Field label="Script numbers" htmlFor={ids.r} error={errs.range} help={`Yours: ${compressRanges(candidates.map((s) => s.number))}`}>
              <input className="input" value={range} onChange={(e) => setRange(e.target.value)} placeholder="e.g. 1–5" {...inputProps(ids.r, errs.range)} />
            </Field>
          )}
        </div>
        <details className="details" open={showTitles} onToggle={(e) => { const open = (e.target as HTMLDetailsElement).open; setShowTitles(open); if (open) setTitles(titleLines(chosen)); }}>
          <summary><ChevronDown aria-hidden />Add titles (optional)</summary>
          <div className="inner"><TitlesField id={ids.t} scripts={chosen} value={titles} onChange={setTitles} /></div>
        </details>
        <Field label="Note for the reviewer" optional htmlFor={ids.n}><textarea className="textarea" id={ids.n} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything they should know" /></Field>
      </div>
    </Dialog>
  );
}

// ── the manager's decision ───────────────────────────────────────────────

export function DecisionDialog({ batchId, scripts, submissionId, mode, groupKey, onClose }: { batchId: number; scripts: Script[]; submissionId: number | null; mode: 'revisions' | 'approve_edits'; groupKey?: string; onClose: () => void }) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const toast = useToast();
  const [note, setNote] = useState('');
  const [att, setAtt] = useState<AttachValue>(emptyAttach(mode === 'approve_edits' ? 'file' : 'none'));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const nid = useFieldId('dn');
  const nums = compressRanges(scripts.map((s) => s.number));
  const save = useSave(async () => {
    const out = await postWith(`/api/batches/${batchId}/review`, {
      action: mode === 'revisions' ? 'revisions' : 'approve', scriptIds: scripts.map((s) => s.id), submissionId, note: note.trim() || null,
    }, att);
    if (groupKey) leaving.set(groupKey, mode === 'revisions' ? 'sent_back' : 'approved');
    return out;
  }, { onSuccess: () => {
    const at = from.current ?? centerOf(null);
    if (mode === 'revisions') burst(at.x, at.y, { colors: PINK, count: 14 });
    else { burst(at.x, at.y, { colors: MINT, count: 18 }); confetti({ x: at.x, y: at.y, count: 40, spread: 80, power: 10 }); }
    toast(mode === 'revisions' ? `Sent ${plural(scripts.length, 'script')} back for revisions` : `Approved ${plural(scripts.length, 'script')} with your edits`);
    onClose();
  } });
  const submit = () => {
    from.current = centerOf(document.activeElement);
    const e: Record<string, string> = {};
    if (mode === 'revisions' && !note.trim()) e.note = 'Say what needs to change';
    const a = attachError(att, mode === 'approve_edits');
    if (a) e.attach = a;
    setErrs(e);
    if (!Object.keys(e).length) save.mutate(undefined);
  };
  return (
    <Dialog open onClose={onClose} size="narrow"
      title={mode === 'revisions' ? `Send ${plural(scripts.length, 'script')} back` : 'Approve with your edits'}
      sub={`Scripts ${nums}${mode === 'revisions' ? ' · the writer gets one request with your note' : ' · the writer is told to use your version'}`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={mode === 'revisions' ? 'danger' : 'mint'} busy={save.isPending} onClick={submit}>{mode === 'revisions' ? 'Send back for revisions' : `Approve ${plural(scripts.length, 'script')}`}</Button></div>}>
      <div className="form">
        <FormError error={save.error} />
        <Field label={mode === 'revisions' ? 'What needs to change?' : 'Note'} optional={mode !== 'revisions'} htmlFor={nid} error={errs.note}>
          <textarea className="textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'revisions' ? 'e.g. Tighten every opening line. See my comments in the PDF.' : 'Optional'} {...inputProps(nid, errs.note)} />
        </Field>
        <div className="field">
          <span className="lbl">{mode === 'revisions' ? 'Attach your changes' : 'Your edited version'}{mode === 'revisions' && <span className="opt" style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>optional</span>}</span>
          <AttachInput value={att} onChange={setAtt} allowNone={mode === 'revisions'} error={errs.attach}
            fileHelp={mode === 'revisions' ? 'Your marked-up PDF.' : 'The final version with your changes.'}
            linkHelp="Your edited Google Doc, or a link to the marked-up file." />
        </div>
      </div>
    </Dialog>
  );
}

// ── cards ────────────────────────────────────────────────────────────────

function TitlesPreview({ scripts }: { scripts: Script[] }) {
  const titled = scripts.filter((s) => s.title);
  const [all, setAll] = useState(false);
  if (!titled.length) return null;
  const shown = all ? titled : titled.slice(0, 4);
  return (
    <div className="titles-preview">
      {shown.map((s) => <span key={s.id}><b className="tnum">{s.number}.</b> {s.title}</span>)}
      {titled.length > 4 && <button type="button" className="linkbtn" onClick={() => setAll(!all)}>{all ? 'Show fewer' : `+${titled.length - 4} more`}</button>}
    </div>
  );
}

/** One document (or one writer's scripts) waiting for review. */
export function WaitingCard({ group, showBatch = true, onReplace }: { group: ReviewGroup; showBatch?: boolean; onReplace?: () => void }) {
  const displayTz = useDisplayTz();
  const { me, clock } = useBoot();
  const toast = useToast();
  const manager = me.role !== 'writer';
  const [dialog, setDialog] = useState<null | { mode: 'revisions' | 'approve_edits'; scripts: Script[] }>(null);
  const [oneByOne, setOneByOne] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const sub = group.submission;
  const n = group.scripts.length;
  const nums = compressRanges(group.scripts.map((s) => s.number));
  const from = useRef<{ x: number; y: number } | null>(null);
  const approve = useSave(async (scripts: Script[]) => {
    const out = await api(`/api/batches/${group.batch.id}/review`, { body: { action: 'approve', scriptIds: scripts.map((s) => s.id), submissionId: sub?.id ?? null } });
    if (scripts.length === n) leaving.set(group.key, 'approved');
    return out;
  }, {
    onSuccess: (_o, scripts) => {
      const at = from.current ?? centerOf(null);
      burst(at.x, at.y, { colors: MINT, count: 20, distance: 70 });
      confetti({ x: at.x, y: at.y, count: scripts.length === n ? 50 : 24, spread: 70, power: 11 });
      toast(`Approved ${plural(scripts.length, 'script')}`);
      setPicked(new Set());
    },
  });
  const approveNow = (scripts: Script[], el: EventTarget) => { from.current = centerOf(el as Element); approve.mutate(scripts); };
  const pickedScripts = group.scripts.filter((s) => picked.has(s.id));
  return (
    <section className="review-card edge-lavender" aria-label={`${group.writerName}: scripts ${nums}`}>
      <div className="rc-head">
        <div style={{ minWidth: 0 }}>
          {showBatch && <div className="rc-client">{group.batch.clientName} · <Link to={`/batches/${group.batch.id}`} className="rc-batch">{group.batch.title}</Link></div>}
          <div className="rc-title">{group.writerId === me.id ? 'You' : group.writerName} sent {n === 1 ? `script ${nums}` : `${n} scripts (${nums})`}{sub ? ' as one document' : ''}</div>
          <div className="rc-meta">
            {sub && sub.version > 1 && <Chip color="lavender">Version {sub.version}</Chip>}
            {group.since && <span>{fmtStamp(group.since, displayTz)}</span>}
          </div>
        </div>
        <DueChip m={group.batch.final} today={clock.today} />
      </div>
      {sub && hasDoc(sub) ? <DocRow a={sub} tone="lavender" /> : <p className="muted" style={{ fontSize: 13 }}>No document attached — these were marked ready without one. Check each script’s own link on the batch page.</p>}
      {sub && sub.scriptNumbers.length > n && <p className="muted" style={{ fontSize: 12.5 }}>This document covers scripts {compressRanges(sub.scriptNumbers)}. Only {nums} still need{n === 1 ? 's' : ''} a decision.</p>}
      {sub?.note && <blockquote className="rc-note">“{sub.note}” <span>— {sub.submittedByName}</span></blockquote>}
      <TitlesPreview scripts={group.scripts} />
      {sub && sub.version > 1 && <p className="muted" style={{ fontSize: 12.5 }}>Revised after earlier feedback. Every version is kept on the <Link className="link" to={`/batches/${group.batch.id}#documents`}>batch page</Link>.</p>}
      {manager && (
        <>
          <div className="rc-actions">
            <Button variant="mint" icon={<Check aria-hidden />} busy={approve.isPending && approve.variables?.length === n} onClick={(e) => approveNow(group.scripts, e.currentTarget)}>{n === 1 ? 'Approve' : `Approve all ${n}`}</Button>
            <Button variant="danger" icon={<RotateCcw aria-hidden />} onClick={() => setDialog({ mode: 'revisions', scripts: group.scripts })}>Send back for revisions</Button>
            <Button variant="ghost" icon={<PenLine aria-hidden />} onClick={() => setDialog({ mode: 'approve_edits', scripts: group.scripts })}>Approve with my edits</Button>
            {n > 1 && <button type="button" className="linkbtn rc-more" aria-expanded={oneByOne} onClick={() => setOneByOne(!oneByOne)}>{oneByOne ? 'Hide script list' : 'Review scripts one by one'}</button>}
          </div>
          <FormError error={approve.error} />
          {oneByOne && (
            <div className="rc-list">
              {group.scripts.map((s) => (
                <label key={s.id} className="check rc-script">
                  <input type="checkbox" checked={picked.has(s.id)} onChange={() => { const x = new Set(picked); x.has(s.id) ? x.delete(s.id) : x.add(s.id); setPicked(x); }} />
                  <span className="tnum"><b>{s.number}</b></span><span className="ellipsis">{s.title ?? `Script ${s.number}`}</span>
                  {s.docUrl && <a className="link" href={s.docUrl} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>own link</a>}
                </label>
              ))}
              <div className="row-flex s2">
                <Button variant="sm mint" disabled={!pickedScripts.length} onClick={(e) => approveNow(pickedScripts, e.currentTarget)}>Approve {pickedScripts.length || ''} selected</Button>
                <Button variant="sm danger" disabled={!pickedScripts.length} onClick={() => setDialog({ mode: 'revisions', scripts: pickedScripts })}>Send selected back</Button>
              </div>
            </div>
          )}
        </>
      )}
      {!manager && (
        <div className="rc-actions">
          <span className="muted" style={{ fontSize: 13 }}>Waiting for a manager to review.</span>
          {onReplace && <Button variant="sm ghost" icon={<Upload aria-hidden />} onClick={onReplace}>Replace document</Button>}
        </div>
      )}
      {manager && onReplace && <button type="button" className="linkbtn" style={{ alignSelf: 'flex-start' }} onClick={onReplace}>Replace the document</button>}
      {dialog && <DecisionDialog batchId={group.batch.id} scripts={dialog.scripts} submissionId={sub?.id ?? null} mode={dialog.mode} groupKey={dialog.scripts.length === n ? group.key : undefined} onClose={() => setDialog(null)} />}
    </section>
  );
}

/** Scripts sent back in one decision: the note, the reviewer's changes, and what to do next. */
export function SentBackCard({ group, onResend, showBatch = true }: { group: ReviewGroup; onResend?: () => void; showBatch?: boolean }) {
  const displayTz = useDisplayTz();
  const { me } = useBoot();
  const r = group.review;
  const n = group.scripts.length;
  const nums = compressRanges(group.scripts.map((s) => s.number));
  return (
    <section className="review-card edge-pink" aria-label={`Revisions requested on scripts ${nums}`}>
      <div className="rc-head">
        <div style={{ minWidth: 0 }}>
          {showBatch && <div className="rc-client">{group.batch.clientName} · <Link to={`/batches/${group.batch.id}`} className="rc-batch">{group.batch.title}</Link></div>}
          <div className="rc-title">{n === 1 ? `Script ${nums}` : `${n} scripts (${nums})`} sent back to {group.writerId === me.id ? 'you' : group.writerName}</div>
          <div className="rc-meta">{r && <span>by {r.reviewedByName} · {fmtStamp(r.createdAt, displayTz)}</span>}</div>
        </div>
        <Chip color="pink" icon={<RotateCcw aria-hidden />}>Revisions needed</Chip>
      </div>
      {r?.note && <blockquote className="rc-note pink">“{r.note}”</blockquote>}
      {r && hasDoc(r) && <DocRow a={r} label="Their changes" tone="pink" />}
      {group.submission && hasDoc(group.submission) && <DocRow a={group.submission} label={`Version ${group.submission.version} that was reviewed`} />}
      {onResend && <div className="rc-actions"><Button variant="primary pill" icon={<Send aria-hidden />} onClick={onResend}>Send revised version</Button></div>}
    </section>
  );
}

/** Every version and decision for one writer's scripts, newest first. */
export function DocumentHistory({ submissions }: { submissions: Submission[] }) {
  const displayTz = useDisplayTz();
  if (!submissions.length) return null;
  const items = submissions.flatMap((s) => [
    { at: s.createdAt, key: `s${s.id}`, node: <><b>Version {s.version}</b> sent by {s.submittedByName} · scripts {compressRanges(s.scriptNumbers)} {hasDoc(s) && <a className="link" href={docHref(s)} target="_blank" rel="noopener noreferrer">open</a>}{s.note ? ` — “${s.note}”` : ''}</> , c: 'var(--lavender)' },
    ...s.reviews.map((r) => ({ at: r.createdAt, key: `r${r.id}`, c: r.action === 'approved' ? 'var(--mint)' : 'var(--pink)', node: <><b>{r.action === 'approved' ? 'Approved' : 'Sent back'}</b> by {r.reviewedByName} · scripts {compressRanges(r.scriptNumbers)}{r.note ? ` — “${r.note}”` : ''} {hasDoc(r) && <a className="link" href={docHref(r)} target="_blank" rel="noopener noreferrer">{r.action === 'approved' ? 'edited version' : 'their changes'}</a>}</> })),
  ]).sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="timeline">
      {items.map((i) => <div key={i.key} className="tl" style={{ ['--c' as string]: i.c }}><span className="d" /><div><div className="s">{i.node}</div><div className="w">{fmtStamp(i.at, displayTz)}</div></div></div>)}
    </div>
  );
}
