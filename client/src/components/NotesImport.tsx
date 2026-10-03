// Paste notes: write (or paste, or attach) notes the way you'd text them,
// Claude reads them into clients, briefings, shoots and batches, you check
// and edit the preview, then save it all in one go.

import { useState } from 'react';
import { m } from 'framer-motion';
import { AlertTriangle, Camera, CheckCheck, FileText, HelpCircle, KeyRound, Paperclip, RotateCcw, Sparkles, Trash2, Wand2 } from 'lucide-react';
import { api, queryClient, type ApiError } from '../api';
import type { ImportClient, ImportPlan, ImportResult } from '../../../shared/types';
import { computeDeadlines, type ISODate } from '../../../shared/dates';
import { fmtDate, fmtRange, plural } from '../../../shared/format';
import { celebrate } from '../fx';
import { SPRING } from '../motion';
import { useBoot } from './Shell';
import { Button, Chip, Field, FormError, Seg, useFieldId } from './ui';

type Batch = ImportClient['batches'][number];

export function NotesImport({ onDone }: { onDone: (r: ImportResult) => void }) {
  const { notesImport, settings } = useBoot();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [keep, setKeep] = useState<boolean[]>([]);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<'read' | 'save' | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const tid = useFieldId('notes');

  if (!notesImport) return <SetupHelp />;

  const read = async (withAnswers: boolean) => {
    setBusy('read');
    setError(null);
    const answered = withAnswers && plan ? plan.questions.map((q, i) => (answers[i]?.trim() ? `Q: ${q.question}\nA: ${answers[i].trim()}` : null)).filter(Boolean).join('\n\n') : '';
    try {
      let out: { plan: ImportPlan };
      if (files.length) {
        const form = new FormData();
        form.set('text', text);
        if (answered) form.set('answers', answered);
        for (const f of files) form.append('file', f);
        out = await api('/api/import/read', { form });
      } else {
        out = await api('/api/import/read', { body: { text, answers: answered || null } });
      }
      setPlan(out.plan);
      setKeep(out.plan.clients.map(() => true));
      setAnswers({});
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!plan) return;
    setBusy('save');
    setError(null);
    try {
      const chosen = { ...plan, clients: plan.clients.filter((_, i) => keep[i]) };
      const out = await api<ImportResult>('/api/import/apply', { body: { plan: chosen } });
      await queryClient.invalidateQueries();
      celebrate();
      onDone(out);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const setClient = (i: number, next: Partial<ImportClient>) => setPlan((p) => p && { ...p, clients: p.clients.map((c, j) => (j === i ? { ...c, ...next } : c)) });

  if (!plan) {
    return (
      <div className="form notes-import">
        <div className="banner"><Wand2 aria-hidden /><div className="txt"><b>Write it the way you’d text it.</b><span>Client names, script counts, filming dates, styles, posting instructions: any order. Claude turns it into clients, briefs, shoots and batches, and you check everything before it’s saved.</span></div></div>
        <FormError error={error} />
        <Field label="Your notes" htmlFor={tid}>
          <textarea id={tid} className="textarea notes-box" rows={12} value={text} onChange={(e) => setText(e.target.value)} disabled={busy === 'read'}
            placeholder={'e.g. For Elegant Jeweler it’s 8 scripts, writing starts next Wednesday and we film Friday.\nFor Elon we’re doing 45 scripts: education, myth vs fact, rankings…'} />
        </Field>
        <div className="row-flex s2">
          <label className="btn sm ghost file-pick"><Paperclip aria-hidden />Attach PDF or text<input type="file" multiple accept=".pdf,.txt,.md,.csv,application/pdf,text/*" onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])].slice(0, 5))} hidden /></label>
          {files.map((f, i) => <Chip key={i} icon={<FileText aria-hidden />}>{f.name}<button type="button" className="chip-x" aria-label={`Remove ${f.name}`} onClick={() => setFiles(files.filter((_, j) => j !== i))}>×</button></Chip>)}
        </div>
        {busy === 'read' && <ReadingNotes />}
        <p className="muted" style={{ fontSize: 12.5 }}>Your notes are sent to Claude (Anthropic) to be read. Nothing is saved until you press Save.</p>
        <div className="form-actions">
          <Button variant="primary pill lg" icon={<Sparkles aria-hidden />} busy={busy === 'read'} disabled={!text.trim() && !files.length} onClick={() => read(false)}>{busy === 'read' ? 'Reading your notes…' : 'Read my notes'}</Button>
        </div>
      </div>
    );
  }

  const kept = plan.clients.filter((_, i) => keep[i]).length;
  return (
    <div className="form notes-import">
      <div className="banner mint"><Sparkles aria-hidden /><div className="txt"><b>Here’s what I understood.</b><span>{plan.summary} Change anything below, untick what you don’t want, then save.</span></div></div>
      <FormError error={error} />
      {plan.questions.length > 0 && (
        <section className="import-questions" aria-label="Questions">
          <div className="section-title"><HelpCircle size={14} aria-hidden /> A few things I assumed</div>
          {plan.questions.map((q, i) => (
            <div key={i} className="iq">
              <div><b>{q.clientName ? `${q.clientName}: ` : ''}{q.question}</b><span className="muted"> For now: {q.assumed}</span></div>
              <input className="input sm" placeholder="Your answer (optional)" value={answers[i] ?? ''} onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })} aria-label={`Answer: ${q.question}`} />
            </div>
          ))}
          {Object.values(answers).some((a) => a.trim()) && <Button variant="sm" icon={<RotateCcw aria-hidden />} busy={busy === 'read'} onClick={() => read(true)}>Read again with my answers</Button>}
        </section>
      )}
      {busy === 'read' && <ReadingNotes />}
      <div className="stack s4">
        {plan.clients.map((c, i) => (
          <m.section key={i} className={`import-client${keep[i] ? '' : ' off'}`} initial={{ opacity: 0, y: 14 }} animate={{ opacity: keep[i] ? 1 : 0.55, y: 0 }} transition={{ ...SPRING, delay: Math.min(i, 6) * 0.05 }}>
            <ClientEditor c={c} include={keep[i]} onInclude={(v) => setKeep(keep.map((k, j) => (j === i ? v : k)))} onChange={(next) => setClient(i, next)} settings={settings} />
          </m.section>
        ))}
      </div>
      <div className="form-actions">
        <Button variant="ghost" onClick={() => { setPlan(null); setError(null); }}>Back to my notes</Button>
        <Button variant="primary pill lg" icon={<CheckCheck aria-hidden />} busy={busy === 'save'} disabled={!kept} onClick={save}>Save {plural(kept, 'client')}</Button>
      </div>
    </div>
  );
}

function ReadingNotes() {
  return (
    <div className="reading-notes" role="status" aria-label="Reading your notes">
      <Sparkles aria-hidden />
      <div><b>Reading your notes…</b><span>This usually takes 10–30 seconds.</span></div>
      <span className="bar" aria-hidden><i /></span>
    </div>
  );
}

function ClientEditor({ c, include, onInclude, onChange, settings }: { c: ImportClient; include: boolean; onInclude: (v: boolean) => void; onChange: (c: Partial<ImportClient>) => void; settings: Parameters<typeof computeDeadlines>[1] }) {
  const ids = { n: useFieldId('in'), d: useFieldId('id'), v: useFieldId('iv'), g: useFieldId('ig') };
  const setBatch = (j: number, next: Partial<Batch>) => onChange({ batches: c.batches.map((b, k) => (k === j ? { ...b, ...next } : b)) });
  return (
    <>
      <div className="ic-head">
        <label className="check"><input type="checkbox" checked={include} onChange={(e) => onInclude(e.target.checked)} aria-label={`Include ${c.name}`} /></label>
        <input id={ids.n} className="input ic-name" value={c.name} onChange={(e) => onChange({ name: e.target.value })} aria-label="Client name" disabled={!include} />
        <Chip color={c.existingClientId ? 'cyan' : 'mint'}>{c.existingClientId ? 'Existing client — notes are added' : 'New client'}</Chip>
        <Seg role="group" aria-label="Client or potential client">
          <button type="button" aria-pressed={c.status === 'active'} onClick={() => onChange({ status: 'active' })}>Client</button>
          <button type="button" aria-pressed={c.status === 'prospect'} onClick={() => onChange({ status: 'prospect' })}>Potential</button>
        </Seg>
      </div>
      {include && (
        <div className="ic-body">
          {c.notes.map((n, k) => <div key={k} className="ic-note"><AlertTriangle aria-hidden />{n}</div>)}
          <div className="form-grid">
            <Field label="About them" optional htmlFor={ids.d}><textarea id={ids.d} className="textarea" rows={2} value={c.description ?? ''} onChange={(e) => onChange({ description: e.target.value || null })} /></Field>
            <Field label="Brand voice & style" optional htmlFor={ids.v}><textarea id={ids.v} className="textarea" rows={2} value={c.brandVoice ?? ''} onChange={(e) => onChange({ brandVoice: e.target.value || null })} /></Field>
            <Field label="Guidance for the team" optional htmlFor={ids.g} className="full" help="Formats, posting and scheduling instructions: anything writers should always know."><textarea id={ids.g} className="textarea" rows={Math.min(8, Math.max(2, (c.guidance ?? '').split('\n').length))} value={c.guidance ?? ''} onChange={(e) => onChange({ guidance: e.target.value || null })} /></Field>
          </div>
          {c.briefings.map((b, k) => (
            <div key={`b${k}`} className="ic-item">
              <div className="ic-item-head"><FileText aria-hidden /><b>Brief</b><input className="input sm" value={b.title} onChange={(e) => onChange({ briefings: c.briefings.map((x, y) => (y === k ? { ...x, title: e.target.value } : x)) })} aria-label="Brief title" />
                <button type="button" className="icon-btn sm" aria-label="Remove brief" onClick={() => onChange({ briefings: c.briefings.filter((_, y) => y !== k) })}><Trash2 size={15} /></button></div>
              <BriefText summary={b.summary} instructions={b.instructions} onChange={(v) => onChange({ briefings: c.briefings.map((x, y) => (y === k ? { ...x, ...v } : x)) })} />
            </div>
          ))}
          {c.shoots.map((s, k) => (
            <div key={`s${k}`} className="ic-item">
              <div className="ic-item-head"><Camera aria-hidden /><b>Shoot</b>
                <input className="input sm" type="date" value={s.startDate} onChange={(e) => onChange({ shoots: c.shoots.map((x, y) => (y === k ? { ...x, startDate: e.target.value as ISODate } : x)) })} aria-label="Shoot starts" />
                <input className="input sm" type="date" value={s.endDate ?? ''} min={s.startDate} onChange={(e) => onChange({ shoots: c.shoots.map((x, y) => (y === k ? { ...x, endDate: (e.target.value || null) as ISODate | null } : x)) })} aria-label="Shoot ends (optional)" />
                <span className="muted" style={{ fontSize: 12.5 }}>{fmtRange(s.startDate, s.endDate)}</span>
                <button type="button" className="icon-btn sm" aria-label="Remove shoot" onClick={() => onChange({ shoots: c.shoots.filter((_, y) => y !== k), batches: c.batches.map((b) => (b.shootKey === s.key ? { ...b, shootKey: null } : b)) })}><Trash2 size={15} /></button></div>
            </div>
          ))}
          {c.batches.map((b, k) => {
            const shoot = c.shoots.find((s) => s.key === b.shootKey);
            const auto = shoot ? computeDeadlines(shoot.startDate, settings) : null;
            return (
              <div key={`t${k}`} className="ic-item">
                <div className="ic-item-head"><Sparkles aria-hidden /><b>Scripts</b><input className="input sm" value={b.title} onChange={(e) => setBatch(k, { title: e.target.value })} aria-label="Batch name" />
                  <button type="button" className="icon-btn sm" aria-label="Remove batch" onClick={() => onChange({ batches: c.batches.filter((_, y) => y !== k) })}><Trash2 size={15} /></button></div>
                <div className="ic-grid">
                  <label><span>How many</span><input className="input sm num" type="number" min={1} max={500} value={b.targetCount ?? ''} placeholder="Not sure yet" onChange={(e) => setBatch(k, { targetCount: e.target.value ? Number(e.target.value) : null })} /></label>
                  <label><span>For shoot</span><select className="select sm" value={b.shootKey ?? ''} onChange={(e) => setBatch(k, { shootKey: e.target.value || null })}><option value="">No shoot</option>{c.shoots.map((s) => <option key={s.key} value={s.key}>{fmtRange(s.startDate, s.endDate)}</option>)}</select></label>
                  <label><span>Writing starts</span><input className="input sm" type="date" value={b.plannedStart ?? ''} onChange={(e) => setBatch(k, { plannedStart: (e.target.value || null) as ISODate | null })} /></label>
                  <label><span>Drafts due</span><input className="input sm" type="date" value={b.draftDue ?? ''} onChange={(e) => setBatch(k, { draftDue: (e.target.value || null) as ISODate | null })} />{!b.draftDue && <small>{auto?.draftDue ? `Automatic: ${fmtDate(auto.draftDue)}` : 'Not set'}</small>}</label>
                  <label><span>Final delivery</span><input className="input sm" type="date" value={b.finalDue ?? ''} onChange={(e) => setBatch(k, { finalDue: (e.target.value || null) as ISODate | null })} />{!b.finalDue && <small>{auto?.finalDue ? `Automatic: ${fmtDate(auto.finalDue)}` : 'Not set'}</small>}</label>
                  <label><span>Writers</span><input className="input sm" value={b.writerNames.join(', ')} placeholder="Assign later" onChange={(e) => setBatch(k, { writerNames: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></label>
                </div>
                {b.brief && <textarea className="textarea" rows={2} value={b.brief} onChange={(e) => setBatch(k, { brief: e.target.value || null })} aria-label="Brief for writers" />}
                {!b.targetCount && <p className="muted" style={{ fontSize: 12.5 }}>No count yet, so this batch won’t be created. Add a number, or add it later.</p>}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

function SetupHelp() {
  return (
    <div className="stack s4">
      <div className="banner yellow"><KeyRound aria-hidden /><div className="txt"><b>Turn on Paste notes</b><span>This uses Claude to read your notes, so the server needs an Anthropic API key. It’s a one-time setup.</span></div></div>
      <ol className="setup-steps">
        <li>Go to <a className="link" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer">console.anthropic.com → API keys</a>, sign in, and create a key. Add a little credit under Billing.</li>
        <li>In Render, open your web service → <b>Environment</b> → <b>Add environment variable</b>. Name: <code>ANTHROPIC_API_KEY</code>, value: the key.</li>
        <li>Save. Render redeploys; after a minute or two, reload this page.</li>
      </ol>
      <p className="muted" style={{ fontSize: 13 }}>Each import costs roughly 5–10 cents. Only the notes you paste are sent to Claude.</p>
    </div>
  );
}

type BriefParts = { summary: string | null; instructions: string | null };
const joinBrief = (b: BriefParts) => [b.summary, b.instructions].filter(Boolean).join('\n\n');

/**
 * A brief's text in one box: the first paragraph is its summary, the rest its instructions. The box
 * keeps what's typed as typed (a new paragraph can be started at the end), and takes the brief's text
 * again only when it changes from outside (a brief above it removed).
 */
function BriefText({ summary, instructions, onChange }: BriefParts & { onChange: (v: BriefParts) => void }) {
  const joined = joinBrief({ summary, instructions });
  const [text, setText] = useState(joined);
  const [known, setKnown] = useState(joined);
  if (joined !== known) { setKnown(joined); setText(joined); }
  return (
    <textarea className="textarea" rows={2} value={text} aria-label="Brief details" onChange={(e) => {
      const [first, ...rest] = e.target.value.split('\n\n');
      const next = { summary: first || null, instructions: rest.join('\n\n') || null };
      setText(e.target.value);
      setKnown(joinBrief(next));
      onChange(next);
    }} />
  );
}
