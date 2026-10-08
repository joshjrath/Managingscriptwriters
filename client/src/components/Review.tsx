// Review by document: writers send their scripts as one PDF or link; managers
// approve it, send it back with notes (and their marked-up version), or
// approve with their own edits. Used by the Review queue, My work and the
// batch page so all three read the same way.

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { Check, ChevronDown, ExternalLink, FileText, Link2, PenLine, RotateCcw, Send, Upload } from 'lucide-react';
import { api, ApiError, queryClient, useSave } from '../api';
import type { Attachment, ReviewGroup, ReviewRecord, Script, Submission } from '../../../shared/types';
import { compressRanges, parseRanges, parseTitleLines, scriptsLabel } from '../../../shared/workflow';
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
  // only titles changed here are sent, so this can't put back a title someone else changed meanwhile
  const [base] = useState(scripts);
  const id = useFieldId('titles');
  const changed = () => parseTitleLines(text, base.map((s) => s.number)).filter((t) => (base.find((s) => s.number === t.number)?.title ?? null) !== (t.title ?? null));
  const save = useSave(() => api<{ changed: number }>(`/api/batches/${batchId}/titles`, { body: { titles: changed() } }), {
    onSuccess: (out) => { toast(out.changed ? `Updated ${plural(out.changed, 'title')}` : 'No titles changed'); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} title="Script titles" sub={scriptsLabel(scripts.map((s) => s.number))} size="narrow"
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
export function SendDialog({ batchId, batchTitle, candidates, preselect, resend, replace, feedback, onClose }: {
  batchId: number; batchTitle: string; candidates: Script[]; preselect: number[];
  /** sending a revised version of scripts that were sent back */
  resend?: boolean;
  /** swapping the document for scripts still in review */
  replace?: boolean;
  /** the send-back being answered, shown so the writer can check it */
  feedback?: { note: string | null; byName: string } | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const { uploadLimitMb } = useBoot();
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
    if (!chosen.length) e.range = `Use your script numbers (${compressRanges(candidates.map((s) => s.number))}), like ${example}`;
    setErrs(e);
    if (!Object.keys(e).length) save.mutate(undefined);
  };
  const server = save.error as ApiError | null;
  const sorted = candidates.map((s) => s.number).sort((a, b) => a - b);
  const example = sorted.length > 1 ? `${sorted[0]}–${sorted[Math.min(sorted.length - 1, 2)]}` : `${sorted[0] ?? 1}`;
  return (
    <Dialog open onClose={onClose} title={replace ? 'Send a newer version' : resend ? 'Send your revised version' : 'Send scripts for review'}
      sub={replace ? `${batchTitle} · it takes the place of the document in review; the old one is kept in the history` : `${batchTitle} · one document for all the scripts it covers`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" icon={<Send aria-hidden />} busy={save.isPending} onClick={submit}>Send {plural(chosen.length, 'script')}</Button></div>}>
      <div className="form">
        <FormError error={server && !Object.keys(server.fields).length ? server : null} />
        {feedback?.note && <blockquote className="rc-note">“{feedback.note}” <span>— {feedback.byName}. Check it’s covered before you send.</span></blockquote>}
        <div className="field">
          <span className="lbl">{replace || resend ? 'Your new document' : 'Your document'}</span>
          <AttachInput value={att} onChange={setAtt} error={errs.document ?? server?.fields.document}
            fileHelp={`A PDF with all the scripts is ideal. Up to ${uploadLimitMb} MB.`}
            linkHelp="Google Docs or Drive: set sharing so the team can open it (and edit, if you want changes made in the doc)." />
        </div>
        <div className="field">
          <span className="lbl">Which scripts does it cover?</span>
          <label className="check"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />{pre.length === 1 ? `Script ${compressRanges(pre.map((s) => s.number))}` : `${pre.length === candidates.length ? 'All ' : ''}${pre.length} scripts: ${compressRanges(pre.map((s) => s.number))}`}</label>
          <label className="check"><input type="radio" name="scope" checked={scope === 'some'} onChange={() => setScope('some')} />Only some</label>
          {scope === 'some' && (
            <Field label="Script numbers" htmlFor={ids.r} error={errs.range} help={`Yours: ${compressRanges(candidates.map((s) => s.number))}`}>
              <input className="input" value={range} onChange={(e) => setRange(e.target.value)} placeholder={`e.g. ${example}`} {...inputProps(ids.r, errs.range)} />
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

/** The Undo button on a decision's toast: puts the scripts back in review, as if nothing happened. */
export function useUndoDecision() {
  const toast = useToast();
  return (reviewId: number | undefined, text: string) => {
    if (!reviewId) { toast(text); return; }
    toast(text, 'ok', {
      label: 'Undo',
      run: () => { void api(`/api/reviews/${reviewId}/undo`, { body: {} }).then(() => { void queryClient.invalidateQueries(); toast('Undone: back in review'); }, (err: ApiError) => toast(err.message, 'error')); },
    });
  };
}

// ── the manager's decision ───────────────────────────────────────────────

export function DecisionDialog({ batchId, scripts, submissionId, mode, groupKey, onClose }: { batchId: number; scripts: Script[]; submissionId: number | null; mode: 'revisions' | 'approve_edits'; groupKey?: string; onClose: () => void }) {
  const from = useRef<{ x: number; y: number } | null>(null);
  const undoable = useUndoDecision();
  const [note, setNote] = useState('');
  const [att, setAtt] = useState<AttachValue>(emptyAttach('none'));
  const [errs, setErrs] = useState<Record<string, string>>({});
  const nid = useFieldId('dn');
  const nums = compressRanges(scripts.map((s) => s.number));
  const save = useSave(async () => {
    const out = await postWith(`/api/batches/${batchId}/review`, {
      action: mode === 'revisions' ? 'revisions' : 'approve', scriptIds: scripts.map((s) => s.id), submissionId, note: note.trim() || null,
    }, att) as { reviewId?: number };
    if (groupKey) leaving.set(groupKey, mode === 'revisions' ? 'sent_back' : 'approved');
    return out;
  }, { onSuccess: (out) => {
    const at = from.current ?? centerOf(null);
    if (mode === 'revisions') burst(at.x, at.y, { colors: PINK, count: 14 });
    else { burst(at.x, at.y, { colors: MINT, count: 18 }); confetti({ x: at.x, y: at.y, count: 40, spread: 80, power: 10 }); }
    undoable(out?.reviewId, mode === 'revisions' ? `Sent ${plural(scripts.length, 'script')} back` : `Approved ${plural(scripts.length, 'script')}${(att.file || att.url.trim()) ? ' with your edits' : note.trim() ? ' with your note' : ''}`);
    onClose();
  } });
  const submit = () => {
    from.current = centerOf(document.activeElement);
    const e: Record<string, string> = {};
    if (mode === 'revisions' && !note.trim()) e.note = 'Say what needs to change';
    // approving: a note, your edited version, or both; neither is required
    const a = attachError(att, false);
    if (a) e.attach = a;
    setErrs(e);
    if (!Object.keys(e).length) save.mutate(undefined);
  };
  return (
    <Dialog open onClose={onClose} size="narrow"
      title={mode === 'revisions' ? `Send ${plural(scripts.length, 'script')} back` : 'Approve with a note or your edits'}
      sub={`${scripts.length === 1 ? 'Script' : 'Scripts'} ${nums}${mode === 'revisions' ? ' · the writer gets one request with your note' : ' · the writer sees your note, and is told to use your version if you attach one'}`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={mode === 'revisions' ? 'danger' : 'mint'} busy={save.isPending} onClick={submit}>{mode === 'revisions' ? 'Send back' : `Approve ${plural(scripts.length, 'script')}`}</Button></div>}>
      <div className="form">
        <FormError error={save.error} />
        <Field label={mode === 'revisions' ? 'What needs to change?' : 'Note'} optional={mode !== 'revisions'} htmlFor={nid} error={errs.note}>
          <textarea className="textarea" data-autofocus value={note} onChange={(e) => setNote(e.target.value)} placeholder={mode === 'revisions' ? 'e.g. Tighten every opening line. See my comments in the PDF.' : 'Optional'} {...inputProps(nid, errs.note)} />
        </Field>
        <div className="field">
          <span className="lbl">{mode === 'revisions' ? 'Attach your changes' : 'Your edited version'}{<span className="opt" style={{ color: 'var(--text-2)', fontWeight: 500, fontSize: 12 }}>optional</span>}</span>
          <AttachInput value={att} onChange={setAtt} allowNone error={errs.attach}
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

/** One document (or one writer's scripts) in review. */
export function WaitingCard({ group, showBatch = true, onReplace }: { group: ReviewGroup; showBatch?: boolean; onReplace?: () => void }) {
  const displayTz = useDisplayTz();
  const { me, clock } = useBoot();
  const manager = me.role !== 'writer';
  const [dialog, setDialog] = useState<null | { mode: 'revisions' | 'approve_edits'; scripts: Script[] }>(null);
  const [oneByOne, setOneByOne] = useState(false);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const sub = group.submission;
  const n = group.scripts.length;
  const nums = compressRanges(group.scripts.map((s) => s.number));
  const from = useRef<{ x: number; y: number } | null>(null);
  const undoable = useUndoDecision();
  const approve = useSave(async (scripts: Script[]) => {
    const out = await api<{ reviewId?: number }>(`/api/batches/${group.batch.id}/review`, { body: { action: 'approve', scriptIds: scripts.map((s) => s.id), submissionId: sub?.id ?? null } });
    if (scripts.length === n) leaving.set(group.key, 'approved');
    return out;
  }, {
    onSuccess: (out, scripts) => {
      const at = from.current ?? centerOf(null);
      burst(at.x, at.y, { colors: MINT, count: 20, distance: 70 });
      confetti({ x: at.x, y: at.y, count: scripts.length === n ? 50 : 24, spread: 70, power: 11 });
      undoable(out.reviewId, `Approved ${plural(scripts.length, 'script')}`);
      setPicked(new Set());
    },
  });
  // one decision at a time: a double click mustn't send the same approval twice
  const approveNow = (scripts: Script[], el: EventTarget) => { if (approve.isPending) return; from.current = centerOf(el as Element); approve.mutate(scripts); };
  const pickedScripts = group.scripts.filter((s) => picked.has(s.id));
  // with scripts ticked, the main buttons act on those, and say so
  const target = oneByOne && pickedScripts.length ? pickedScripts : group.scripts;
  const sel = target !== group.scripts;
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
      {sub && hasDoc(sub) ? <DocRow a={sub} tone="lavender" /> : <p className="muted" style={{ fontSize: 13 }}>No document attached — these were marked ready without one. {showBatch ? 'Check each script’s own link on the batch page.' : 'Check each script’s own link in the checklist below.'}</p>}
      {sub && sub.scriptNumbers.length > n && <p className="muted" style={{ fontSize: 12.5 }}>This document covers scripts {compressRanges(sub.scriptNumbers)}. Only {nums} still need{n === 1 ? 's' : ''} a decision.</p>}
      {sub?.note && <blockquote className="rc-note">“{sub.note}” <span>— {sub.submittedByName}</span></blockquote>}
      <TitlesPreview scripts={group.scripts} />
      {sub?.afterFeedback && (
        <div className="rc-feedback">
          <span className="lbl"><RotateCcw aria-hidden />Revised after this feedback</span>
          {sub.afterFeedback.note && <blockquote className="rc-note">“{sub.afterFeedback.note}” <span>— {sub.afterFeedback.byName}, {fmtStamp(sub.afterFeedback.at, displayTz)}</span></blockquote>}
          <span className="muted" style={{ fontSize: 12.5 }}>Earlier versions are kept on the <Link className="link" to={`/batches/${group.batch.id}#documents`}>batch page</Link>.</span>
        </div>
      )}
      {sub && sub.version > 1 && !sub.afterFeedback && <p className="muted" style={{ fontSize: 12.5 }}>This replaces an earlier version. Every version is kept on the <Link className="link" to={`/batches/${group.batch.id}#documents`}>batch page</Link>.</p>}
      {manager && (
        <>
          <div className="rc-actions">
            <Button variant="mint" icon={<Check aria-hidden />} busy={approve.isPending && approve.variables === target} onClick={(e) => approveNow(target, e.currentTarget)}>{sel ? `Approve ${target.length} selected` : n === 1 ? 'Approve' : `Approve all ${n}`}</Button>
            <Button variant="danger" icon={<RotateCcw aria-hidden />} onClick={() => setDialog({ mode: 'revisions', scripts: target })}>{sel ? `Send ${target.length} selected back` : 'Send back'}</Button>
            <Button variant="ghost" icon={<PenLine aria-hidden />} onClick={() => setDialog({ mode: 'approve_edits', scripts: target })}>{sel ? `Approve ${target.length} with a note…` : 'Approve with a note or edits…'}</Button>
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
              <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{pickedScripts.length ? `The buttons above now act on the ${plural(pickedScripts.length, 'ticked script')} only.` : 'Tick scripts to decide on them separately.'}</p>
            </div>
          )}
        </>
      )}
      {!manager && (
        <div className="rc-actions">
          <span className="muted" style={{ fontSize: 13 }}>In review. Nothing to do until a manager looks at it.</span>
          {onReplace && <Button variant="sm ghost" icon={<Upload aria-hidden />} onClick={onReplace}>Send a newer version</Button>}
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
    <section className="review-card edge-pink" aria-label={`Sent back: scripts ${nums}`}>
      <div className="rc-head">
        <div style={{ minWidth: 0 }}>
          {showBatch && <div className="rc-client">{group.batch.clientName} · <Link to={`/batches/${group.batch.id}`} className="rc-batch">{group.batch.title}</Link></div>}
          <div className="rc-title">{n === 1 ? `Script ${nums}` : `${n} scripts (${nums})`} sent back to {group.writerId === me.id ? 'you' : group.writerName}</div>
          <div className="rc-meta">{r && <span>by {r.reviewedByName} · {fmtStamp(r.createdAt, displayTz)}</span>}</div>
        </div>
        <Chip color="pink" icon={<RotateCcw aria-hidden />}>Sent back</Chip>
      </div>
      {r?.note && <blockquote className="rc-note pink">“{r.note}”</blockquote>}
      {r && hasDoc(r) && <DocRow a={r} label={r.reviewedByName === me.name ? 'Your changes' : `${r.reviewedByName.split(' ')[0]}’s changes`} tone="pink" />}
      {group.submission && hasDoc(group.submission) && <DocRow a={group.submission} label={`Version ${group.submission.version} that was reviewed`} />}
      {onResend && <div className="rc-actions"><Button variant="primary pill" icon={<Send aria-hidden />} onClick={onResend}>Send revised version</Button></div>}
    </section>
  );
}

/** Every version and decision for one writer's scripts, newest first. */
/**
 * Every version and decision, grouped by document: "Scripts 1–3 · Sarah Chen: v1 → v2 → v3",
 * each version with its Open link and the decisions made on it underneath.
 */
export function DocumentHistory({ submissions }: { submissions: Submission[] }) {
  const displayTz = useDisplayTz();
  if (!submissions.length) return null;
  const byId = new Map(submissions.map((s) => [s.id, s]));
  const rootOf = (s: Submission) => { let x = s; const seen = new Set<number>(); while (x.previousId && byId.has(x.previousId) && !seen.has(x.id)) { seen.add(x.id); x = byId.get(x.previousId)!; } return x.id; };
  const chains = new Map<number, Submission[]>();
  for (const s of submissions) chains.set(rootOf(s), [...(chains.get(rootOf(s)) ?? []), s]);
  // newest activity first
  const list = [...chains.values()].map((c) => c.sort((x, y) => x.createdAt.localeCompare(y.createdAt)))
    .sort((x, y) => y[y.length - 1].createdAt.localeCompare(x[x.length - 1].createdAt));
  return (
    <div className="doc-chains">
      {list.map((chain) => {
        const nums = [...new Set(chain.flatMap((s) => s.scriptNumbers))];
        const last = chain[chain.length - 1];
        return (
          <section key={chain[0].id} className="doc-chain">
            <div className="doc-chain-head">
              <b>{scriptsLabel(nums)}</b>
              <span className="muted">{last.writerName ?? last.submittedByName} · {chain.map((s) => `v${s.version}`).join(' → ')}</span>
            </div>
            <ol className="timeline">
              {chain.map((s) => (
                <li key={s.id} className="tl" style={{ ['--c' as string]: 'var(--lavender)' }}>
                  <span className="d" />
                  <div>
                    <div className="s"><b>Version {s.version}</b> sent by {s.submittedByName}{s.scriptNumbers.length !== nums.length ? ` · ${scriptsLabel(s.scriptNumbers).toLowerCase()}` : ''} {hasDoc(s) && <a className="link" href={docHref(s)} target="_blank" rel="noopener noreferrer">Open</a>}{s.note ? ` — “${s.note}”` : ''}</div>
                    <div className="w">{fmtStamp(s.createdAt, displayTz)}</div>
                    {s.reviews.length > 0 && (
                      <ul className="doc-decisions">
                        {s.reviews.map((r) => (
                          <li key={r.id} style={{ ['--c' as string]: r.action === 'approved' ? 'var(--mint)' : 'var(--pink)' }}>
                            <b>{r.action === 'approved' ? 'Approved' : 'Sent back'}</b> by {r.reviewedByName} · {scriptsLabel(r.scriptNumbers).toLowerCase()}{r.note ? ` — “${r.note}”` : ''} {hasDoc(r) && <a className="link" href={docHref(r)} target="_blank" rel="noopener noreferrer">{r.action === 'approved' ? 'edited version' : 'changes'}</a>}
                            <span className="w"> · {fmtStamp(r.createdAt, displayTz)}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

// ── which version to paste into Timeliner ────────────────────────────────

/** Approved scripts grouped by the version to use: the manager's edited one when there is one, else the writer's latest document. */
export interface Source { key: string; ids: number[]; nums: number[]; edit: ReviewRecord | null; doc: Submission | null }

export function approvedSources(scripts: Script[], submissions: Submission[]): Source[] {
  const reviews = new Map<number, ReviewRecord>();
  for (const sub of submissions) for (const r of sub.reviews) reviews.set(r.id, r);
  const edits = [...reviews.values()].filter((r) => r.action === 'approved' && hasDoc(r)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const subs = [...submissions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const out = new Map<string, Source>();
  for (const s of [...scripts].sort((a, b) => a.number - b.number)) {
    const edit = [...edits].reverse().find((r) => r.batchId === s.batchId && r.scriptNumbers.includes(s.number)) ?? null;
    const doc = edit ? null : [...subs].reverse().find((x) => x.batchId === s.batchId && x.scriptNumbers.includes(s.number) && hasDoc(x)) ?? null;
    const key = edit ? `e${edit.id}` : doc ? `d${doc.id}` : 'none';
    const g = out.get(key) ?? { key, ids: [], nums: [], edit, doc };
    g.ids.push(s.id); g.nums.push(s.number);
    out.set(key, g);
  }
  // the manager's versions first: they're the ones people miss
  return [...out.values()].sort((a, b) => Number(!!b.edit) - Number(!!a.edit) || a.nums[0] - b.nums[0]);
}

/** "Scripts 11–12 · Josh's edited version · Open", one line per version, optionally with a tick box each. */
export function SourceList({ sources, picked, onToggle }: { sources: Source[]; picked?: Set<string>; onToggle?: (key: string) => void }) {
  if (!sources.length) return null;
  return (
    <div className="sources">
      {sources.map((g) => {
        const nums = compressRanges(g.nums);
        const what = g.nums.length === 1 ? `Script ${nums}` : `Scripts ${nums}`;
        const a = g.edit ?? g.doc;
        const label = g.edit ? `${g.edit.reviewedByName.split(' ')[0]}’s edited version · use this one` : g.doc ? (g.doc.version > 1 ? `Your document (version ${g.doc.version})` : 'Your document') : 'No document attached';
        return (
          <div key={g.key} className={`source${g.edit ? ' edit' : ''}`}>
            {onToggle && <input type="checkbox" aria-label={`${what} added to Timeliner`} checked={picked?.has(g.key) ?? true} onChange={() => onToggle(g.key)} />}
            <span className="ic" aria-hidden>{g.edit ? <PenLine /> : a?.fileId ? <FileText /> : <Link2 />}</span>
            <div className="body">
              <b>{what}</b>
              <span>{label}</span>
              {g.edit?.note && <span className="q">“{g.edit.note}”</span>}
            </div>
            {a && hasDoc(a) && <a className={`btn sm${g.edit ? ' mint' : ''}`} href={docHref(a)} target="_blank" rel="noopener noreferrer">Open<ExternalLink aria-hidden /></a>}
          </div>
        );
      })}
    </div>
  );
}
