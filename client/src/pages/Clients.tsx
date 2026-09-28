// Clients list and client detail: guidance, briefings, resources, shoots,
// batches and history in one place.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArchiveRestore, Building2, Camera, FileText, Link2, Pencil, PlayCircle, Plus } from 'lucide-react';
import { api, useSave } from '../api';
import type { Briefing, ClientDetail, ClientSummary } from '../../../shared/types';
import { fmtDate, fmtRange, fmtStamp, plural } from '../../../shared/format';
import { PageHeader, useBoot, useNewWork } from '../components/Shell';
import { BatchItem } from '../components/BatchBits';
import { Button, Chip, Dialog, Empty, ErrorState, ExtLink, Field, FormError, inputProps, Loading, Panel, useFieldId, useToast, DateTile } from '../components/ui';
import { RescheduleDialog, ResourceDialog, ResourceRow } from './BatchDetail';

export function ClientsPage() {
  const { me } = useBoot();
  const openNew = useNewWork();
  const [status, setStatus] = useState<'active' | 'archived'>('active');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['clients', status], queryFn: () => api<{ clients: ClientSummary[] }>(`/api/clients?status=${status}`) });
  const list = (q.data?.clients ?? []).filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <PageHeader title="Clients" hideNewWork>
        {me.role === 'manager' && <Button variant="primary pill lg" icon={<Plus aria-hidden />} onClick={() => openNew('client')}>New client</Button>}
      </PageHeader>
      <div className="filters">
        <input className="input search" type="search" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
        <div className="seg" role="group" aria-label="Status">
          <button aria-pressed={status === 'active'} onClick={() => setStatus('active')}>Active</button>
          <button aria-pressed={status === 'archived'} onClick={() => setStatus('archived')}>Archived</button>
        </div>
      </div>
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !list.length && <div className="panel"><Empty icon={<Building2 />} title={search ? 'No clients match' : status === 'active' ? 'No active clients yet' : 'No archived clients'} action={me.role === 'manager' && status === 'active' && !search ? <Button onClick={() => openNew('client')}>Add a client</Button> : undefined} /></div>}
      <div className="client-grid">
        {list.map((c) => (
          <Link key={c.id} to={`/clients/${c.id}`} className="client-card">
            <div className="row-flex s2" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <h3>{c.name}</h3>
              {c.overdueBatches > 0 && <Chip color="red" icon={<AlertTriangle aria-hidden />}>{c.overdueBatches} overdue</Chip>}
            </div>
            {c.description ? <p className="desc">{c.description}</p> : <p className="desc">No description yet.</p>}
            <span className="muted" style={{ fontSize: 12.5 }}>Owner: {c.ownerName ?? '—'}</span>
            <div className="stats">
              <div><b>{c.activeBatches}</b><span>active batches</span></div>
              <div><b className="num">{c.scriptsDelivered}/{c.scriptsTotal}</b><span>delivered</span></div>
              <div><b>{c.nextShoot ? fmtDate(c.nextShoot) : '—'}</b><span>next shoot</span></div>
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}

export function ClientPage() {
  const { id } = useParams();
  const { me, settings, users, clock } = useBoot();
  const manager = me.role === 'manager';
  const openNew = useNewWork();
  const toast = useToast();
  const q = useQuery({ queryKey: ['client', Number(id)], queryFn: () => api<ClientDetail>(`/api/clients/${id}`) });
  const [edit, setEdit] = useState(false);
  const [brief, setBrief] = useState<Briefing | 'new' | null>(null);
  const [res, setRes] = useState<{ briefingId?: number } | null>(null);
  const [resched, setResched] = useState<{ id: number; start: string; end: string | null } | null>(null);
  const [tab, setTab] = useState<'active' | 'done'>('active');
  const archive = useSave((archived: boolean) => api(`/api/clients/${id}/archive`, { body: { archived } }), { onSuccess: (_o, a) => toast(a ? 'Client archived' : 'Client restored') });
  const remove = useSave((rid: number) => api(`/api/resources/${rid}`, { method: 'DELETE' }), { onSuccess: () => toast('Resource removed') });
  if (q.isLoading) return <><div style={{ height: 90 }} /><Loading height={480} /></>;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const c = q.data!;
  const active = c.batches.filter((b) => b.stage !== 'delivered' && !b.archivedAt);
  const done = c.batches.filter((b) => b.stage === 'delivered' || b.archivedAt);
  const today = clock.today;
  const upcoming = c.shoots.filter((s) => (s.endDate ?? s.startDate) >= today && !s.cancelledAt);
  const past = c.shoots.filter((s) => (s.endDate ?? s.startDate) < today);
  const byCat = (cat: string) => c.resources.filter((r) => r.category === cat);
  return (
    <>
      <PageHeader title={c.name} crumbs={<Link to="/clients">Clients</Link>}
        sub={<span className="row-flex s2">{c.status === 'archived' ? <Chip icon={<Archive aria-hidden />}>Archived</Chip> : <Chip color="mint" dot>Active</Chip>}<span>Owner: {c.ownerName ?? '—'}</span></span>} hideNewWork>
        {manager && c.status === 'active' && <><Button icon={<Camera aria-hidden />} onClick={() => openNew('shoot', { clientId: c.id })}>New shoot</Button><Button icon={<Plus aria-hidden />} onClick={() => openNew('batch', { clientId: c.id })}>New batch</Button></>}
        {manager && <Button icon={<Pencil aria-hidden />} onClick={() => setEdit(true)}>Edit</Button>}
      </PageHeader>
      <div className="grid g-side-main">
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel title="About & guidance">
            <div className="stack s4">
              <div><div className="section-title">Description</div><p className={`prose${c.description ? '' : ' muted'}`}>{c.description ?? 'No description yet.'}</p></div>
              <div><div className="section-title">Brand voice</div><p className={`prose${c.brandVoice ? '' : ' muted'}`}>{c.brandVoice ?? 'Not written yet.'}</p></div>
              <div><div className="section-title">Writing guidance</div><p className={`prose${c.guidance ? '' : ' muted'}`}>{c.guidance ?? 'Not written yet.'}</p></div>
            </div>
          </Panel>
          <Panel title="Shoots" count={upcoming.length || undefined} sub={upcoming.length ? 'upcoming' : undefined}>
            {!c.shoots.length ? <Empty boxed icon={<Camera />} title="No shoots" action={manager && c.status === 'active' ? <Button variant="sm" onClick={() => openNew('shoot', { clientId: c.id })}>Schedule a shoot</Button> : undefined} /> : (
              <div className="rows">
                {[...upcoming, ...past.slice(-3).reverse()].map((s) => (
                  <div key={s.id} className="item with-tile">
                    <DateTile date={s.startDate} color={(s.endDate ?? s.startDate) < today ? 'var(--text-3)' : undefined} />
                    <div className="body"><div className="title">{s.title ?? 'Shoot'}</div><div className="meta"><span>{fmtRange(s.startDate, s.endDate)}</span>{s.location && <span>{s.location}</span>}<span>{plural(s.batchIds.length, 'batch', 'batches')}</span></div></div>
                    <div className="side">{(s.endDate ?? s.startDate) < today ? <Chip>Past</Chip> : manager ? <Button variant="sm" onClick={() => setResched({ id: s.id, start: s.startDate, end: s.endDate })}>Move shoot</Button> : null}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="History">
            {!c.activity.length ? <Empty title="No history yet" /> : (
              <div className="timeline" style={{ maxHeight: 460, overflowY: 'auto' }}>
                {c.activity.map((a) => <div key={a.id} className="tl"><span className="d" /><div><div className="s">{a.summary}{a.batchTitle && <span className="muted"> · {a.batchTitle}</span>}</div><div className="w">{a.actorName ?? 'System'} · {fmtStamp(a.createdAt, settings.timezone)}</div></div></div>)}
              </div>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <Panel title="Briefings & ideation calls" count={c.briefings.length} tools={manager ? <Button variant="sm" icon={<Plus aria-hidden />} onClick={() => setBrief('new')}>Add briefing</Button> : undefined}>
            {!c.briefings.length ? <Empty boxed icon={<PlayCircle />} title="No briefing records yet">Add the call date, Phantom recording link, document and writing instructions.</Empty> : (
              <div className="stack s2">
                {c.briefings.map((b) => (
                  <div key={b.id} className="brief">
                    <div className="row-flex s2"><h4>{b.title}</h4>{b.callDate && <Chip color="plain">Call {fmtDate(b.callDate)}</Chip>}<span className="spacer" />{manager && <Button variant="sm ghost" onClick={() => setBrief(b)}>Edit</Button>}{manager && <Button variant="sm ghost" onClick={() => setRes({ briefingId: b.id })}>Attach file</Button>}</div>
                    <div className="links">
                      {b.recordingUrl && <ExtLink href={b.recordingUrl} className="btn sm salmon"><PlayCircle aria-hidden />Recording</ExtLink>}
                      {b.documentUrl && <ExtLink href={b.documentUrl} className="btn sm"><FileText aria-hidden />Document</ExtLink>}
                      {b.resources.map((r) => <a key={r.id} className="btn sm" href={r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!} target="_blank" rel="noopener noreferrer"><FileText aria-hidden />{r.title}</a>)}
                    </div>
                    {b.summary && <p className="prose" style={{ fontSize: 13.5 }}>{b.summary}</p>}
                    {b.instructions && <div><div className="section-title">Writing instructions</div><p className="prose" style={{ fontSize: 13.5 }}>{b.instructions}</p></div>}
                    <div className="muted" style={{ fontSize: 12 }}>{b.batchIds.length ? `Applies to ${plural(b.batchIds.length, 'batch', 'batches')}: ${c.batches.filter((x) => b.batchIds.includes(x.id)).map((x) => x.title).join(', ')}` : 'Not attached to a batch yet'}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="Batches" tools={<div className="seg" role="group" aria-label="Batches"><button aria-pressed={tab === 'active'} onClick={() => setTab('active')}>Active {active.length}</button><button aria-pressed={tab === 'done'} onClick={() => setTab('done')}>Completed {done.length}</button></div>}>
            {(tab === 'active' ? active : done).length === 0 ? <Empty boxed title={tab === 'active' ? 'No active batches' : 'Nothing completed yet'} /> : (
              <div className="rows">{(tab === 'active' ? active : done).map((b) => <BatchItem key={b.id} b={b} ring />)}</div>
            )}
          </Panel>
          <Panel title="Resources" tools={manager ? <Button variant="sm" icon={<Link2 aria-hidden />} onClick={() => setRes({})}>Add</Button> : undefined}>
            {!c.resources.length ? <Empty boxed title="No folders, examples or assets yet" /> : (
              <div className="stack s4">
                {(['folder', 'example', 'asset', 'document', 'recording', 'other'] as const).filter((k) => byCat(k).length).map((k) => (
                  <div key={k} className="stack s2">
                    <div className="section-title">{{ folder: 'Folders', example: 'Examples', asset: 'Assets', document: 'Documents', recording: 'Recordings', other: 'Other' }[k]}</div>
                    {byCat(k).map((r) => <ResourceRow key={r.id} r={r} onRemove={manager || r.createdById === me.id ? () => remove.mutate(r.id) : undefined} />)}
                  </div>
                ))}
              </div>
            )}
          </Panel>
          {manager && (
            <div className="row-flex s2">
              {c.status === 'active'
                ? <Button variant="ghost" icon={<Archive aria-hidden />} busy={archive.isPending} onClick={() => { if (window.confirm(`Archive ${c.name}? Their batches and history are kept; the client just leaves the active lists.`)) archive.mutate(true); }}>Archive client</Button>
                : <Button icon={<ArchiveRestore aria-hidden />} busy={archive.isPending} onClick={() => archive.mutate(false)}>Restore client</Button>}
            </div>
          )}
        </div>
      </div>
      {manager && <EditClientDialog c={c} open={edit} onClose={() => setEdit(false)} managers={users.filter((u) => u.role === 'manager' && u.active)} />}
      {manager && brief && <BriefingDialog clientId={c.id} briefing={brief === 'new' ? null : brief} batches={c.batches.filter((b) => !b.archivedAt)} onClose={() => setBrief(null)} />}
      <ResourceDialog open={!!res} onClose={() => setRes(null)} clientId={c.id} briefingId={res?.briefingId} />
      {resched && <RescheduleDialog shootId={resched.id} start={resched.start} end={resched.end} onClose={() => setResched(null)} />}
    </>
  );
}

function EditClientDialog({ c, open, onClose, managers }: { c: ClientDetail; open: boolean; onClose: () => void; managers: { id: number; name: string }[] }) {
  const toast = useToast();
  const [name, setName] = useState(c.name);
  const [ownerId, setOwnerId] = useState<number | ''>(c.ownerId ?? '');
  const [description, setDescription] = useState(c.description ?? '');
  const [brandVoice, setBrandVoice] = useState(c.brandVoice ?? '');
  const [guidance, setGuidance] = useState(c.guidance ?? '');
  useEffect(() => { if (open) { setName(c.name); setOwnerId(c.ownerId ?? ''); setDescription(c.description ?? ''); setBrandVoice(c.brandVoice ?? ''); setGuidance(c.guidance ?? ''); } }, [open, c]);
  const save = useSave(() => api(`/api/clients/${c.id}`, { method: 'PATCH', body: { name, ownerId: ownerId || null, description, brandVoice, guidance } }), { onSuccess: () => { toast('Client updated'); onClose(); } });
  const f = save.error?.fields ?? {};
  const ids = { n: useFieldId('n'), o: useFieldId('o'), d: useFieldId('d'), v: useFieldId('v'), g: useFieldId('g') };
  return (
    <Dialog open={open} onClose={onClose} kind="drawer" title="Edit client"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>Save</Button></div>}>
      <div className="form">
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Name" htmlFor={ids.n} error={f.name}><input className="input" value={name} onChange={(e) => setName(e.target.value)} {...inputProps(ids.n, f.name)} /></Field>
        <Field label="Internal owner" htmlFor={ids.o}><select className="select" id={ids.o} value={ownerId} onChange={(e) => setOwnerId(e.target.value ? Number(e.target.value) : '')}><option value="">No owner</option>{managers.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
        <Field label="Description" optional htmlFor={ids.d}><textarea className="textarea" id={ids.d} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Brand voice" optional htmlFor={ids.v}><textarea className="textarea" id={ids.v} value={brandVoice} onChange={(e) => setBrandVoice(e.target.value)} /></Field>
        <Field label="Writing guidance" optional htmlFor={ids.g}><textarea className="textarea" id={ids.g} value={guidance} onChange={(e) => setGuidance(e.target.value)} style={{ minHeight: 160 }} /></Field>
      </div>
    </Dialog>
  );
}

function BriefingDialog({ clientId, briefing, batches, onClose }: { clientId: number; briefing: Briefing | null; batches: { id: number; title: string }[]; onClose: () => void }) {
  const toast = useToast();
  const [v, setV] = useState({
    title: briefing?.title ?? 'Ideation call', callDate: briefing?.callDate ?? '', recordingUrl: briefing?.recordingUrl ?? '', documentUrl: briefing?.documentUrl ?? '',
    summary: briefing?.summary ?? '', instructions: briefing?.instructions ?? '',
  });
  const [batchIds, setBatchIds] = useState<number[]>(briefing?.batchIds ?? []);
  const save = useSave(() => briefing
    ? api(`/api/briefings/${briefing.id}`, { method: 'PATCH', body: { ...v, callDate: v.callDate || null, batchIds } })
    : api(`/api/clients/${clientId}/briefings`, { body: { ...v, callDate: v.callDate || null, batchIds } }), { onSuccess: () => { toast(briefing ? 'Briefing updated' : 'Briefing added'); onClose(); } });
  const f = save.error?.fields ?? {};
  const ids = { t: useFieldId('t'), d: useFieldId('d'), r: useFieldId('r'), doc: useFieldId('doc'), s: useFieldId('s'), i: useFieldId('i') };
  return (
    <Dialog open onClose={onClose} kind="drawer" title={briefing ? 'Edit briefing' : 'Add briefing'} sub="Recording and document links are enough — no transcription needed."
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>Save briefing</Button></div>}>
      <div className="form">
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Title" htmlFor={ids.t} error={f.title}><input className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} {...inputProps(ids.t, f.title)} /></Field>
        <Field label="Call date" optional htmlFor={ids.d}><input className="input" type="date" id={ids.d} value={v.callDate} onChange={(e) => setV({ ...v, callDate: e.target.value })} /></Field>
        <Field label="Recording link" optional htmlFor={ids.r} error={f.recordingUrl} help="e.g. the Phantom recording URL"><input className="input" type="url" placeholder="https://" value={v.recordingUrl} onChange={(e) => setV({ ...v, recordingUrl: e.target.value })} {...inputProps(ids.r, f.recordingUrl)} /></Field>
        <Field label="Document link" optional htmlFor={ids.doc} error={f.documentUrl} help="To upload a file instead, save this and use “Attach file”."><input className="input" type="url" placeholder="https://" value={v.documentUrl} onChange={(e) => setV({ ...v, documentUrl: e.target.value })} {...inputProps(ids.doc, f.documentUrl)} /></Field>
        <Field label="Summary" optional htmlFor={ids.s}><textarea className="textarea" id={ids.s} value={v.summary} onChange={(e) => setV({ ...v, summary: e.target.value })} /></Field>
        <Field label="Writing instructions" optional htmlFor={ids.i}><textarea className="textarea" id={ids.i} value={v.instructions} onChange={(e) => setV({ ...v, instructions: e.target.value })} /></Field>
        <div className="field"><span className="lbl">Applies to batches</span>
          {!batches.length ? <span className="muted" style={{ fontSize: 13 }}>No batches yet — attach it when you create one.</span> : batches.map((b) => (
            <label key={b.id} className="check"><input type="checkbox" checked={batchIds.includes(b.id)} onChange={(e) => setBatchIds(e.target.checked ? [...batchIds, b.id] : batchIds.filter((x) => x !== b.id))} />{b.title}</label>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
