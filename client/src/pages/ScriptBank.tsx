// Script bank: every document ever sent, across every client and batch.
// One row per document (a writer's PDF or link covering, say, scripts 1–45),
// each script under the newest document it was sent in. When a manager
// approved with edits, their version is the one to open.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ExternalLink, FileText, Library, Link2, PenLine, Trash2, Upload, X } from 'lucide-react';
import { api, qs, useSave, type ApiError } from '../api';
import type { Deliverable, DeliverableState, ScriptBankPage, ShootReadiness } from '../../../shared/types';
import { fmtDate, fmtStamp, plural } from '../../../shared/format';
import { STATUS_SHORT, compressRanges, isManager, type ScriptStatus } from '../../../shared/workflow';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Button, Chip, Dialog, Empty, ErrorState, Field, FormError, Loading, Panel, Seg, inputProps, useFieldId, useToast } from '../components/ui';

const STATE: Record<DeliverableState, { label: string; color: string }> = {
  in_progress: { label: 'Writing', color: 'cyan' },
  in_review: { label: 'In review', color: 'lavender' },
  revisions: { label: 'Sent back', color: 'pink' },
  approved: { label: 'Approved', color: 'mint' },
  delivered: { label: 'Delivered', color: 'mint' },
};

const scriptNumber = (q: string) => (/^#?\d{1,4}$/.test(q) ? Number(q.replace('#', '')) : null);

export function ScriptBankPage() {
  const displayTz = useDisplayTz();
  const { clients, users, me } = useBoot();
  const manager = isManager(me.role);
  const editor = me.role === 'editor';
  const [adding, setAdding] = useState(false);
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const search = useRef<HTMLInputElement>(null);
  const q = params.get('q') ?? '';
  const clientId = params.get('clientId') ?? '';
  const writerId = params.get('writerId') ?? '';
  const status = params.get('status') ?? '';
  const shootId = params.get('shootId') ?? '';
  const sort = params.get('sort') ?? 'recent';
  // the search box writes to the address a moment after typing stops (on top of whatever filters
  // it has by then); when the address changes from elsewhere, the box follows
  const wrote = useRef(q);
  useEffect(() => {
    // from the address as it is now (setParams' own "current" value is from when this timer started)
    const t = setTimeout(() => { wrote.current = text.trim(); const p = new URLSearchParams(window.location.search); if (text.trim()) p.set('q', text.trim()); else p.delete('q'); setParams(p, { replace: true }); }, 220);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps -- setParams changes with the address, which this effect itself changes
  useEffect(() => { if (q !== wrote.current) { wrote.current = q; setText(q); } }, [q]);
  // "/" jumps to the search box from anywhere on the page
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); search.current?.focus(); }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  const bank = useInfiniteQuery({
    queryKey: ['script-bank', q, clientId, writerId, status, shootId, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<ScriptBankPage>(`/api/script-bank${qs({ q, clientId, writerId, status, shootId, sort: sort === 'recent' ? null : sort, offset: pageParam || null })}`),
    getNextPageParam: (last) => last.nextOffset,
    placeholderData: keepPreviousData,
  });
  const items = bank.data?.pages.flatMap((p) => p.deliverables) ?? [];
  const first = bank.data?.pages[0];
  const filtered = !!(q || clientId || writerId || status || shootId);
  // for editors, say where the client's (or shoot's) scripts are instead of a generic empty page
  const readiness = useQuery({ queryKey: ['shoot-readiness'], queryFn: () => api<{ shoots: ShootReadiness[] }>('/api/shoot-readiness'), enabled: editor && !!(clientId || shootId) });
  const editorWhy = (() => {
    const rs = (readiness.data?.shoots ?? []).filter((r) => (shootId ? String(r.shoot.id) === shootId : String(r.shoot.clientId) === clientId) && r.total > 0);
    if (!rs.length) return null;
    const total = rs.reduce((n, r) => n + r.total, 0);
    const done = rs.reduce((n, r) => n + r.finished, 0);
    const due = rs.map((r) => r.finalDue).filter((d): d is string => !!d).sort()[0];
    return `${done} of ${total} scripts for the upcoming ${rs.length === 1 ? 'shoot' : 'shoots'} approved so far${due ? ` · final delivery due ${fmtDate(due)}` : ''}. They appear here once approved.`;
  })();
  const clientName = clients.find((c) => String(c.id) === clientId)?.name;
  const people = users.filter((u) => !u.removed && u.role !== 'editor').sort((a, b) => a.name.localeCompare(b.name));
  const num = scriptNumber(q);

  return (
    <>
      <PageHeader title="Script bank" sub={editor
        ? 'Every finished script (approved or delivered), for every client, plus past scripts. Search a client, writer, document name or script number.'
        : manager ? 'Every script document your writers have sent, for every client, plus past scripts from before. Search a client, batch, writer, document name or script number.'
          : 'Every script document the team has sent, for every client, plus past scripts. Use it for examples and to find your own. Search a client, batch, writer, document name or script number.'}>
        {manager && <Button icon={<Upload aria-hidden />} onClick={() => setAdding(true)}>Add past scripts</Button>}
      </PageHeader>
      {manager && <PastDialog open={adding} onClose={() => setAdding(false)} />}
      <div className="filters bank-filters" role="search">
        <input ref={search} className="input search" type="search" autoFocus={matchMedia('(pointer: fine)').matches} placeholder="Search, or #12 for script 12…" title="Press / to jump here" value={text}
          onChange={(e) => setText(e.target.value)} aria-label="Search by client, batch, writer, document name or script number" />
        <select className="select" value={clientId} onChange={(e) => set('clientId', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'archived' ? ' (archived)' : ''}</option>)}
        </select>
        <select className="select" value={writerId} onChange={(e) => set('writerId', e.target.value)} aria-label="Writer">
          <option value="">All writers</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        {!editor && <select className="select" value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="finished">Finished (approved or delivered)</option>
          <option value="in_review">In review</option>
          <option value="revisions">Sent back</option>
          <option value="open">Not finished yet</option>
        </select>}
        <select className="select" value={sort} onChange={(e) => set('sort', e.target.value === 'recent' ? '' : e.target.value)} aria-label="Order">
          <option value="recent">Newest first</option>
          <option value="shoot">Soonest shoot first</option>
          <option value="client">By client</option>
        </select>
        {shootId && <Chip color="salmon">One shoot only <button type="button" className="chip-x" aria-label="Show every shoot" onClick={() => set('shootId', '')}><X aria-hidden /></button></Chip>}
        {filtered && <Button variant="ghost sm" onClick={() => { setText(''); setParams(new URLSearchParams(sort !== 'recent' ? { sort } : {}), { replace: true }); }}>Clear</Button>}
      </div>
      {bank.isLoading && <Loading />}
      {bank.isError && <ErrorState error={bank.error} retry={() => bank.refetch()} />}
      {first && (
        <Panel title="Documents" count={first.total} sub={first.scriptCount ? plural(first.scriptCount, 'script') : undefined} className={bank.isPlaceholderData ? 'is-refreshing' : ''}>
          {!items.length ? (
            <Empty boxed icon={<Library />} title={editor
              ? (clientName ? `No finished scripts for ${clientName} yet` : filtered ? 'No finished scripts match' : 'No finished scripts yet')
              : filtered ? 'Nothing matches' : 'Nothing sent yet'}>
              {editor
                ? (q ? 'Try fewer words, or clear the filters.' : editorWhy ?? 'Scripts show up here as soon as a manager approves them. The Calendar shows when each shoot’s scripts are due.')
                : q ? 'Try fewer words, or clear the filters.' : filtered ? 'Nothing here with these filters. Clear them to see everything.' : 'Documents appear here as soon as a writer sends their scripts for review.'}
            </Empty>
          ) : (
            <div className="rows bank">
              {items.map((d) => (d.past ? <PastRow key={d.key} d={d} manager={manager} /> : <DeliverableRow key={d.key} d={d} tz={displayTz} num={num} linkBatch={!editor} finishedView={editor} />))}
            </div>
          )}
          {bank.hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <Button onClick={() => bank.fetchNextPage()} busy={bank.isFetchingNextPage}>Show more ({first.total - items.length} left)</Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

/** "4 approved · 2 revisions" when the scripts in a document aren't all at the same step. */
function breakdown(scripts: Deliverable['scripts']): string {
  const counts = new Map<ScriptStatus, number>();
  for (const s of scripts) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  if (counts.size < 2) return '';
  return [...counts.entries()].map(([s, n]) => `${n} ${STATUS_SHORT[s].toLowerCase()}`).join(' · ');
}

export function DeliverableRow({ d, tz, num, linkBatch = true, finishedView = false }: { d: Deliverable; tz: string; num: number | null; linkBatch?: boolean; finishedView?: boolean }) {
  const partly = d.finished > 0 && d.finished < d.scripts.length;
  const st = partly ? { label: `${d.finished} of ${d.scripts.length} finished`, color: 'mint' } : STATE[d.state];
  const hit = num != null ? d.scripts.find((s) => s.number === num) : null;
  const mix = breakdown(d.scripts);
  const done = d.scripts.filter((s) => s.status === 'approved' || s.status === 'delivered');
  const notDone = d.scripts.filter((s) => s.status !== 'approved' && s.status !== 'delivered');
  const icon = d.kind === 'file' ? <FileText aria-hidden /> : <Link2 aria-hidden />;
  return (
    <div className="bank-row">
      <span className="bank-num" aria-label={plural(d.scripts.length, 'script')}>
        <b>{d.scripts.length}</b><small>{d.scripts.length === 1 ? 'script' : 'scripts'}</small>
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="t">
          <Link className="link" to={`/clients/${d.clientId}`}>{d.clientName}</Link> <span className="dim">›</span> {linkBatch ? <Link className="link" to={`/batches/${d.batchId}`}>{d.batchTitle}</Link> : <span>{d.batchTitle}</span>}
          {d.batchArchived && <span className="dim"> (archived)</span>}
        </div>
        <div className="s">
          {d.scripts.length === 1 ? 'Script' : 'Scripts'} {d.ranges} · {d.writerName ?? 'Unassigned'}{d.shootDate && <> · shoot {fmtDate(d.shootDate)}</>}
          {d.kind === 'none' ? ' · no document attached' : <>{' · '}{d.version > 1 ? `version ${d.version}, ` : ''}sent {fmtStamp(d.sentAt, tz)}{d.name && <> · {d.name}</>}</>}
        </div>
        {finishedView && partly && (
          <div className="s"><b className="bank-hit">Scripts {compressRanges(done.map((s) => s.number))} final</b> · {compressRanges(notDone.map((s) => s.number))} still being worked on</div>
        )}
        {d.edited && (
          <div className="s"><b className="bank-edit">Use {d.edited.by.split(' ')[0]}’s edited version for {d.edited.ranges.includes('–') || d.edited.ranges.includes(',') ? 'scripts' : 'script'} {d.edited.ranges}</b>{d.edited.note ? ` · “${d.edited.note}”` : ''}</div>
        )}
        {(hit || (mix && !(finishedView && partly))) && (
          <div className="s">
            {hit && <b className="bank-hit">Script {hit.number} is in here{mix ? ' · ' : ''}</b>}
            {mix}
          </div>
        )}
      </div>
      <div className="bank-tools">
        <Chip color={st.color} dot>{st.label}</Chip>
        {d.edited && (
          <a className="btn sm primary" href={d.edited.href} target="_blank" rel="noopener noreferrer" title={`Approved with ${d.edited.by}’s edits ${fmtStamp(d.edited.at, tz)}`}>
            <PenLine aria-hidden />Final version
          </a>
        )}
        {d.href && (
          <a className={`btn sm${d.edited ? '' : ' primary'}`} href={d.href} target="_blank" rel="noopener noreferrer">
            {icon}{d.edited ? 'Writer’s draft' : 'Open'}
          </a>
        )}
        {!d.href && !d.edited && linkBatch && <Link className="btn sm" to={`/batches/${d.batchId}`}>Open batch</Link>}
        {d.timelinerUrl && <a className="btn sm" href={d.timelinerUrl} target="_blank" rel="noopener noreferrer">Open in Timeliner<ExternalLink aria-hidden /></a>}
      </div>
    </div>
  );
}

/** A past document: scripts written before the platform, uploaded straight to the bank. */
function PastRow({ d, manager }: { d: Deliverable; manager: boolean }) {
  const toast = useToast();
  const remove = useSave(() => api(`/api/script-bank/past/${d.past!.id}`, { method: 'DELETE' }), { onSuccess: () => toast(`Removed “${d.batchTitle}”`) });
  const count = d.past!.scriptCount;
  return (
    <div className="bank-row past">
      <span className="bank-num" aria-label={count ? plural(count, 'script') : 'Past document'}>
        {count ? <><b>{count}</b><small>{count === 1 ? 'script' : 'scripts'}</small></> : <><Archive aria-hidden /><small>past</small></>}
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="t">
          <Link className="link" to={`/clients/${d.clientId}`}>{d.clientName}</Link> <span className="dim">›</span> {d.batchTitle}
        </div>
        <div className="s">
          Past scripts{d.writerName ? ` · ${d.writerName}` : ''}{d.past!.writtenOn ? ` · written ${fmtDate(d.past!.writtenOn)}` : ''}{d.name ? ` · ${d.name}` : ''}
        </div>
        {d.note && <div className="s">{d.note}</div>}
      </div>
      <div className="bank-tools">
        <Chip color="neutral" icon={<Archive aria-hidden />}>Past script</Chip>
        <a className="btn sm primary" href={d.href ?? undefined} target="_blank" rel="noopener noreferrer">
          {d.kind === 'file' ? <FileText aria-hidden /> : <Link2 aria-hidden />}Open
        </a>
        {manager && (
          <Button variant="sm ghost" icon={<Trash2 aria-hidden />} busy={remove.isPending} aria-label={`Remove ${d.batchTitle}`}
            onClick={() => { if (window.confirm(`Remove “${d.batchTitle}” from the Script bank?`)) remove.mutate(undefined); }} />
        )}
      </div>
    </div>
  );
}

const baseName = (name: string) => name.replace(/\.[a-z0-9]{2,5}$/i, '');

/** Upload scripts from before the platform (one or many PDFs, or a link) and file them under a client. */
function PastDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { clients, users } = useBoot();
  const qc = useQueryClient();
  const toast = useToast();
  const [mode, setMode] = useState<'file' | 'link'>('file');
  const [files, setFiles] = useState<{ file: File; title: string }[]>([]);
  const [url, setUrl] = useState('');
  const [linkTitle, setLinkTitle] = useState('');
  const [clientId, setClientId] = useState('');
  const [writerName, setWriterName] = useState('');
  const [writtenOn, setWrittenOn] = useState('');
  const [scriptCount, setScriptCount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const ids = { c: useFieldId('pc'), f: useFieldId('pf'), u: useFieldId('pu'), lt: useFieldId('plt'), w: useFieldId('pw'), d: useFieldId('pd'), n: useFieldId('pn'), no: useFieldId('pno') };
  const people = users.filter((u) => !u.removed && u.role !== 'editor').map((u) => u.name).sort();
  const sorted = [...clients].sort((a, b) => a.name.localeCompare(b.name));

  const reset = () => { setFiles([]); setUrl(''); setLinkTitle(''); setWriterName(''); setWrittenOn(''); setScriptCount(''); setNote(''); setError(null); setFieldErr({}); };
  const close = () => { if (!busy) { reset(); onClose(); } };
  const common = { clientId, writerName: writerName.trim(), writtenOn, scriptCount, note: note.trim() };

  const submit = async () => {
    const errs: Record<string, string> = {};
    if (!clientId) errs.clientId = 'Choose a client';
    if (mode === 'file' && !files.length) errs.file = 'Choose at least one file';
    if (mode === 'link' && !url.trim()) errs.url = 'Paste a link';
    setFieldErr(errs);
    if (Object.keys(errs).length) return;
    setError(null);
    let done = 0;
    try {
      if (mode === 'link') {
        setBusy('Saving…');
        await api('/api/script-bank/past', { body: { ...common, url: url.trim(), title: linkTitle.trim() } });
        done = 1;
      } else {
        for (const [i, f] of files.entries()) {
          setBusy(files.length > 1 ? `Uploading ${i + 1} of ${files.length}…` : 'Uploading…');
          const form = new FormData();
          for (const [k, v] of Object.entries({ ...common, title: f.title.trim() })) if (v) form.append(k, v);
          form.append('file', f.file);
          await api('/api/script-bank/past', { form });
          done++;
        }
      }
      await qc.invalidateQueries();
      toast(done === 1 ? 'Added to the Script bank' : `${done} documents added to the Script bank`);
      reset();
      onClose();
    } catch (err) {
      setError(err as ApiError);
      if (done) { setFiles((fs) => fs.slice(done)); await qc.invalidateQueries(); }
    } finally {
      setBusy(null);
    }
  };

  const count = mode === 'file' ? files.length : 1;
  return (
    <Dialog open={open} onClose={close} title="Add past scripts"
      sub="Scripts written before the platform. They’re filed in the Script bank under the client you pick."
      footer={<div className="form-actions"><Button variant="ghost" onClick={close} disabled={!!busy}>Cancel</Button><Button variant="primary" busy={!!busy} onClick={submit}>{busy ?? (count > 1 ? `Add ${count} documents` : 'Add to Script bank')}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <FormError error={error} />
        <Field label="Client" htmlFor={ids.c} error={fieldErr.clientId}>
          <select className="select" value={clientId} onChange={(e) => setClientId(e.target.value)} {...inputProps(ids.c, fieldErr.clientId)}>
            <option value="">Choose a client…</option>
            {sorted.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'prospect' ? ' (potential)' : c.status === 'archived' ? ' (archived)' : ''}</option>)}
          </select>
        </Field>
        <Seg role="group" aria-label="File or link">
          <button type="button" aria-pressed={mode === 'file'} onClick={() => setMode('file')}><Upload aria-hidden />Upload files</button>
          <button type="button" aria-pressed={mode === 'link'} onClick={() => setMode('link')}><Link2 aria-hidden />Paste link</button>
        </Seg>
        {mode === 'file' ? (
          <Field label="Files" htmlFor={ids.f} error={fieldErr.file} help="PDFs are best. Pick several at once, and each one is added separately.">
            <input id={ids.f} className="input" type="file" multiple accept=".pdf,.doc,.docx,.txt,.rtf,.pages,application/pdf"
              onChange={(e) => { const picked = [...(e.target.files ?? [])].map((file) => ({ file, title: baseName(file.name) })); setFiles((fs) => [...fs, ...picked]); e.target.value = ''; }} />
          </Field>
        ) : (
          <>
            <Field label="Link" htmlFor={ids.u} error={fieldErr.url}><input className="input" type="url" placeholder="https://docs.google.com/…" value={url} onChange={(e) => setUrl(e.target.value)} {...inputProps(ids.u, fieldErr.url)} /></Field>
            <Field label="Name" optional htmlFor={ids.lt}><input className="input" placeholder="e.g. Spring 2025 scripts" value={linkTitle} onChange={(e) => setLinkTitle(e.target.value)} {...inputProps(ids.lt)} /></Field>
          </>
        )}
        {mode === 'file' && files.length > 0 && (
          <div className="past-files">
            {files.map((f, i) => (
              <div key={`${f.file.name}-${i}`} className="past-file">
                <FileText aria-hidden />
                <input className="input" aria-label={`Name for ${f.file.name}`} value={f.title} onChange={(e) => setFiles((fs) => fs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} />
                <button type="button" className="icon-btn sm" aria-label={`Remove ${f.file.name}`} onClick={() => setFiles((fs) => fs.filter((_, j) => j !== i))}><X /></button>
              </div>
            ))}
          </div>
        )}
        <div className="past-pair">
          <Field label="Written by" optional htmlFor={ids.w} help="Someone on the team, or any name.">
            <input className="input" list={`${ids.w}-list`} value={writerName} onChange={(e) => setWriterName(e.target.value)} {...inputProps(ids.w)} />
            <datalist id={`${ids.w}-list`}>{people.map((n) => <option key={n} value={n} />)}</datalist>
          </Field>
          <Field label="When it was written" optional htmlFor={ids.d}><input className="input" type="date" value={writtenOn} onChange={(e) => setWrittenOn(e.target.value)} {...inputProps(ids.d)} /></Field>
        </div>
        <Field label={count > 1 ? 'Scripts in each document' : 'How many scripts are in it'} optional htmlFor={ids.n}>
          <input className="input" type="number" min={1} max={1000} inputMode="numeric" value={scriptCount} onChange={(e) => setScriptCount(e.target.value)} style={{ maxWidth: 160 }} {...inputProps(ids.n)} />
        </Field>
        <Field label="Note" optional htmlFor={ids.no}><textarea className="input" rows={2} placeholder="Anything worth knowing, e.g. what performed well" value={note} onChange={(e) => setNote(e.target.value)} {...inputProps(ids.no)} /></Field>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
