// Clients list and client detail: guidance, briefings, resources, shoots,
// batches and history in one place.

import { useEffect, useRef, useState, type DragEvent } from 'react';
import { LayoutGroup, m } from 'framer-motion';
import { isManager } from '../../../shared/workflow';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Archive, ArchiveRestore, Building2, Camera, FileText, GripVertical, Link2, Pencil, PlayCircle, Plus, Sparkles, UserPlus, Wand2 } from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import { confetti } from '../fx';
import { SOFT } from '../motion';
import type { Briefing, ClientDetail, ClientSummary } from '../../../shared/types';
import { fmtDate, fmtRange, fmtStamp, plural } from '../../../shared/format';
import { PageHeader, useBoot, useNewWork, useDisplayTz } from '../components/Shell';
import { BatchItem } from '../components/BatchBits';
import { Button, Chip, DateTile, Dialog, Empty, ErrorState, ExtLink, Field, FormError, inputProps, Loading, Panel, Seg, useFieldId, useToast } from '../components/ui';
import { RescheduleDialog, ResourceDialog, ResourceRow } from './BatchDetail';

export function ClientsPage() {
  const { me } = useBoot();
  const manager = isManager(me.role);
  const openNew = useNewWork();
  const toast = useToast();
  const qc = useQueryClient();
  const [status, setStatus] = useState<'current' | 'archived'>('current');
  const [search, setSearch] = useState('');
  const [drag, setDrag] = useState<{ id: number; from: 'prospect' | 'active' } | null>(null);
  const [over, setOver] = useState<'prospect' | 'active' | null>(null);
  const key = ['clients', status];
  const q = useQuery({ queryKey: key, queryFn: () => api<{ clients: ClientSummary[] }>(`/api/clients?status=${status}`) });
  const all = (q.data?.clients ?? []).filter((c) => !search || c.name.toLowerCase().includes(search.toLowerCase()));
  const clients = all.filter((c) => c.status !== 'prospect');
  const prospects = all.filter((c) => c.status === 'prospect');

  // moving a card: it flies across straight away, then the server confirms
  const move = useMutation({
    mutationFn: (v: { id: number; to: 'prospect' | 'active'; at?: { x: number; y: number } }) => api(`/api/clients/${v.id}/stage`, { body: { stage: v.to === 'active' ? 'client' : 'prospect' } }),
    onMutate: (v) => {
      qc.setQueryData<{ clients: ClientSummary[] }>(key, (d) => d && { clients: d.clients.map((c) => (c.id === v.id ? { ...c, status: v.to, becameClientAt: v.to === 'active' ? new Date().toISOString() : null } : c)) });
    },
    onSuccess: (_o, v) => {
      const name = q.data?.clients.find((c) => c.id === v.id)?.name ?? 'They';
      if (v.to === 'active') { confetti({ x: v.at?.x, y: v.at?.y, count: 90, spread: 100, power: 13 }); toast(`${name} is now a client`); }
      else toast(`${name} moved to Potential clients`);
    },
    onError: (err: ApiError) => toast(err.message, 'error'),
    onSettled: () => qc.invalidateQueries(),
  });
  const dropOn = (to: 'prospect' | 'active') => ({
    onDragOver: (x: DragEvent) => { if (!drag || drag.from === to) return; x.preventDefault(); x.dataTransfer.dropEffect = 'move'; if (over !== to) setOver(to); },
    onDragLeave: (x: DragEvent) => { if (!(x.currentTarget as HTMLElement).contains(x.relatedTarget as Node)) setOver(null); },
    onDrop: (x: DragEvent) => { if (!drag || drag.from === to) return; x.preventDefault(); move.mutate({ id: drag.id, to, at: { x: x.clientX, y: x.clientY } }); setDrag(null); setOver(null); },
  });
  const dragProps = (c: ClientSummary) => manager && status === 'current' ? {
    draggable: true,
    onDragStart: (x: DragEvent) => { x.dataTransfer.effectAllowed = 'move'; x.dataTransfer.setData('text/plain', `client:${c.id}`); setDrag({ id: c.id, from: c.status === 'prospect' ? 'prospect' : 'active' }); },
    onDragEnd: () => { setDrag(null); setOver(null); },
  } : {};

  return (
    <>
      <PageHeader title="Clients" hideNewWork>
        {manager && <Button icon={<Wand2 aria-hidden />} onClick={() => openNew('notes')}>Paste notes</Button>}
        {manager && <Button icon={<UserPlus aria-hidden />} onClick={() => openNew('client', { prospect: true })}>Potential client</Button>}
        {manager && <Button variant="primary pill lg" icon={<Plus aria-hidden />} onClick={() => openNew('client')}>New client</Button>}
      </PageHeader>
      <div className="filters">
        <input className="input search" type="search" placeholder="Search clients" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search clients" />
        <Seg role="group" aria-label="Status">
          <button aria-pressed={status === 'current'} onClick={() => setStatus('current')}>Current</button>
          <button aria-pressed={status === 'archived'} onClick={() => setStatus('archived')}>Archived</button>
        </Seg>
      </div>
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <LayoutGroup>
          <div className={`clients-board${status === 'archived' ? ' single' : ''}`}>
            <section className={`clients-zone${over === 'active' ? ' over' : ''}${drag?.from === 'prospect' ? ' ready' : ''}`} aria-label="Clients" {...dropOn('active')}>
              {status === 'current' && <div className="zone-head"><h2>Clients</h2><span className="count">{clients.length}</span>{drag?.from === 'prospect' && <span className="drop-hint"><Sparkles aria-hidden />Drop here — they’ve signed</span>}</div>}
              {!clients.length ? <div className="panel"><Empty icon={<Building2 />} title={search ? 'No clients match' : status === 'current' ? 'No clients yet' : 'No archived clients'} action={manager && status === 'current' && !search ? <Button onClick={() => openNew('client')}>Add a client</Button> : undefined} /></div> : (
                <div className="client-grid">
                  {clients.map((c) => (
                    <m.div key={c.id} layoutId={`client-${c.id}`} layout transition={SOFT} className={drag?.id === c.id ? 'lifting' : ''}>
                      <div className="drag-handle-area" {...dragProps(c)}>
                      <Link to={`/clients/${c.id}`} className="client-card" draggable={false}>
                        <div className="row-flex s2" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                          <h3>{c.name}</h3>
                          {c.overdueBatches > 0 && <Chip color="red" icon={<AlertTriangle aria-hidden />}>{c.overdueBatches} overdue</Chip>}
                          {c.becameClientAt && Date.now() - Date.parse(c.becameClientAt) < 7 * 86400_000 && !c.overdueBatches && <Chip color="mint" icon={<Sparkles aria-hidden />}>New client</Chip>}
                        </div>
                        {c.description ? <p className="desc">{c.description}</p> : <p className="desc">No description yet.</p>}
                        <span className="muted" style={{ fontSize: 12.5 }}>Owner: {c.ownerName ?? '—'}</span>
                        <div className="stats">
                          <div><b>{c.activeBatches}</b><span>active batches</span></div>
                          <div><b className="num">{c.scriptsDelivered}/{c.scriptsTotal}</b><span>delivered</span></div>
                          <div><b>{c.nextShoot ? fmtDate(c.nextShoot) : '—'}</b><span>next shoot</span></div>
                        </div>
                      </Link>
                      </div>
                    </m.div>
                  ))}
                </div>
              )}
            </section>
            {status === 'current' && (
              <section className={`prospects-zone${over === 'prospect' ? ' over' : ''}`} aria-label="Potential clients" {...dropOn('prospect')}>
                <div className="zone-head">
                  <h2>Potential clients</h2><span className="count">{prospects.length}</span>
                  {manager && <Button variant="sm ghost" icon={<Plus aria-hidden />} onClick={() => openNew('client', { prospect: true })} aria-label="Add a potential client" />}
                </div>
                {manager && <p className="zone-help">{drag?.from === 'active' ? 'Drop to label them a potential client. Their shoots and scripts stay exactly as they are.' : 'Drag a card into Clients when they sign, or a client in here to label them potential.'}</p>}
                {!prospects.length ? <div className="prospect-empty"><UserPlus aria-hidden /><span>{search ? 'None match' : 'People you’re talking to go here.'}</span></div> : (
                  <div className="prospect-list">
                    {prospects.map((c) => (
                      <m.div key={c.id} layoutId={`client-${c.id}`} layout transition={SOFT} className={drag?.id === c.id ? 'lifting' : ''}>
                      <div className="prospect-card" {...dragProps(c)}>
                        {manager && <GripVertical className="grip" aria-hidden />}
                        <div className="pbody">
                          <Link to={`/clients/${c.id}`} className="pname" draggable={false}>{c.name}</Link>
                          {c.description && <p className="desc">{c.description}</p>}
                          <span className="meta">{c.ownerName ?? 'No owner'} · added {fmtDate(c.createdAt.slice(0, 10))}</span>
                        </div>
                        {manager && <Button variant="sm mint" onClick={(x) => { const r = (x.currentTarget as HTMLElement).getBoundingClientRect(); move.mutate({ id: c.id, to: 'active', at: { x: r.left + r.width / 2, y: r.top } }); }}>Mark as client</Button>}
                      </div>
                      </m.div>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        </LayoutGroup>
      )}
    </>
  );
}

export function ClientPage() {
  const displayTz = useDisplayTz();
  const { id } = useParams();
  const { me, users, clock } = useBoot();
  const manager = isManager(me.role);
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
  const convertAt = useRef<{ x: number; y: number } | null>(null);
  const convert = useSave(() => api(`/api/clients/${id}/stage`, { body: { stage: 'client' } }), {
    onSuccess: () => { confetti({ ...(convertAt.current ?? {}), count: 90, spread: 100, power: 13 }); toast(`${q.data?.name ?? 'They'} ${q.data?.name ? 'is' : 'are'} now a client`); },
  });
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
        sub={<span className="row-flex s2">{c.status === 'archived' ? <Chip icon={<Archive aria-hidden />}>Archived</Chip> : c.status === 'prospect' ? <Chip color="yellow" icon={<UserPlus aria-hidden />}>Potential client</Chip> : <Chip color="mint" dot>Active</Chip>}<span>Owner: {c.ownerName ?? '—'}</span></span>} hideNewWork>
        {manager && c.status === 'prospect' && <Button variant="mint" icon={<Sparkles aria-hidden />} busy={convert.isPending} onClick={(x) => { const r = (x.currentTarget as HTMLElement).getBoundingClientRect(); convertAt.current = { x: r.left + r.width / 2, y: r.top }; convert.mutate(undefined); }}>Mark as client</Button>}
        {manager && c.status !== 'archived' && <><Button icon={<Camera aria-hidden />} onClick={() => openNew('shoot', { clientId: c.id })}>New shoot</Button><Button icon={<Plus aria-hidden />} onClick={() => openNew('batch', { clientId: c.id })}>New batch</Button></>}
        {manager && <Button icon={<Pencil aria-hidden />} onClick={() => setEdit(true)}>Edit</Button>}
      </PageHeader>
      {c.status === 'prospect' && (
        <div className="banner yellow" style={{ marginBottom: 'var(--gap)' }}>
          <UserPlus aria-hidden />
          <div className="txt"><b>{c.name} is a potential client.</b><span>This is only a label: shoots, batches and deadlines work just like any client’s. When they sign, mark them as a client (or drag their card into Clients).</span></div>
        </div>
      )}
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
            {!c.shoots.length ? <Empty boxed icon={<Camera />} title="No shoots" action={manager && c.status !== 'archived' ? <Button variant="sm" onClick={() => openNew('shoot', { clientId: c.id })}>Schedule a shoot</Button> : undefined} /> : (
              <div className="rows">
                {[...upcoming, ...past.slice(-3).reverse()].map((s) => (
                  <div key={s.id} className="item with-tile">
                    <DateTile date={s.startDate} color={(s.endDate ?? s.startDate) < today ? 'var(--text-3)' : undefined} />
                    <div className="body"><div className="title">{s.title ?? 'Shoot'}</div><div className="meta"><span>{fmtRange(s.startDate, s.endDate)}</span>{s.location && <span>{s.location}</span>}<span>{s.batchIds.length ? plural(s.batchIds.length, 'batch', 'batches') : 'No scripts planned yet'}</span></div></div>
                    <div className="side">{(s.endDate ?? s.startDate) < today ? <Chip>Past</Chip> : manager ? <div className="row-flex s2">
                      {!s.batchIds.length && <Button variant="sm salmon" onClick={() => openNew('batch', { clientId: c.id, shootId: s.id })}>Add scripts</Button>}
                      <Button variant="sm" onClick={() => setResched({ id: s.id, start: s.startDate, end: s.endDate })}>Change dates</Button>
                    </div> : null}</div>
                  </div>
                ))}
              </div>
            )}
          </Panel>
          <Panel title="History">
            {!c.activity.length ? <Empty title="No history yet" /> : (
              <div className="timeline" style={{ maxHeight: 460, overflowY: 'auto' }}>
                {c.activity.map((a) => <div key={a.id} className="tl"><span className="d" /><div><div className="s">{a.summary}{a.batchTitle && <span className="muted"> · {a.batchTitle}</span>}</div><div className="w">{a.actorName ?? 'System'} · {fmtStamp(a.createdAt, displayTz)}</div></div></div>)}
              </div>
            )}
          </Panel>
        </div>
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          {/* recordings and documents live in Resources now; older briefing records still show here */}
          {c.briefings.length > 0 && <Panel title="Briefing calls" count={c.briefings.length}>
            {(
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
          </Panel>}
          <Panel title="Batches" tools={<Seg role="group" aria-label="Batches"><button aria-pressed={tab === 'active'} onClick={() => setTab('active')}>Active {active.length}</button><button aria-pressed={tab === 'done'} onClick={() => setTab('done')}>Completed {done.length}</button></Seg>}>
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
              {c.status !== 'archived'
                ? <Button variant="ghost" icon={<Archive aria-hidden />} busy={archive.isPending} onClick={() => { if (window.confirm(`Archive ${c.name}? Their batches and history are kept; the client just leaves the active lists.`)) archive.mutate(true); }}>Archive client</Button>
                : <Button icon={<ArchiveRestore aria-hidden />} busy={archive.isPending} onClick={() => archive.mutate(false)}>Restore client</Button>}
            </div>
          )}
        </div>
      </div>
      {manager && <EditClientDialog c={c} open={edit} onClose={() => setEdit(false)} managers={users.filter((u) => isManager(u.role) && u.active)} />}
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
