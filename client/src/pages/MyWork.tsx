// My work: what to write next, my scripts and deadlines, briefs and
// recordings, quick progress, revision requests and delivery confirmation.
// Managers who also write use the same view.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Camera, CheckCheck, FileText, Minus, PlayCircle, Plus, RotateCcw, Send } from 'lucide-react';
import { api, useSave } from '../api';
import type { MyWork } from '../../../shared/types';
import { compressRanges, type Progress } from '../../../shared/workflow';
import { fmtDate, fmtLong, fmtRange, fmtStamp, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { BatchProgress, Button, Chip, DueChip, Empty, ErrorState, ExtLink, FormError, Loading, Panel, Ring, ringColor, useToast } from '../components/ui';
import { DeliverDialog } from './BatchDetail';

type Entry = MyWork['batches'][number];

export function MyWorkPage() {
  const { me, users, clock } = useBoot();
  const [params, setParams] = useSearchParams();
  const viewing = me.role === 'manager' && params.get('userId') ? Number(params.get('userId')) : me.id;
  const q = useQuery({ queryKey: ['my-work', viewing], queryFn: () => api<MyWork>(`/api/my-work${viewing !== me.id ? `?userId=${viewing}` : ''}`) });
  const who = users.find((u) => u.id === viewing);
  const active = q.data?.batches.filter((e) => e.myProgress.delivered < e.myProgress.total) ?? [];
  const done = q.data?.batches.filter((e) => e.myProgress.delivered === e.myProgress.total) ?? [];
  const next = active[0];
  return (
    <>
      <PageHeader title={viewing === me.id ? 'My work' : `${who?.name ?? 'Writer'}’s work`} sub={viewing === me.id ? 'Your scripts, what’s due, and everything you need to write them.' : 'Viewing as a manager. Updates are recorded under your name.'}>
        {me.role === 'manager' && (
          <select className="select sm" style={{ width: 'auto' }} aria-label="Show work for" value={viewing} onChange={(e) => setParams(Number(e.target.value) === me.id ? {} : { userId: e.target.value })}>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? `Me (${u.name})` : u.name}</option>)}
          </select>
        )}
      </PageHeader>
      {q.isLoading && <Loading height={420} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          {!q.data.batches.length && <Panel><Empty icon={<CheckCheck />} title="Nothing assigned right now">New assignments show up here and in your notifications.</Empty></Panel>}
          {next && <NextUp e={next} today={clock.today} />}
          {q.data.revisions.length > 0 && (
            <Panel title="Revision requests" count={q.data.revisions.length}>
              <div className="rows">
                {q.data.revisions.map((r) => (
                  <Link key={r.id} to={`/batches/${r.batchId}#scripts`} className="item clickable edge-pink">
                    <div className="body"><div className="top">{r.clientName} · {r.batchTitle}</div><div className="title">Script {r.scriptNumber}</div><div className="prose" style={{ fontSize: 13.5 }}>{r.note}</div><div className="meta">From {r.requestedByName} · {fmtStamp(r.requestedAt, clock.timezone)}</div></div>
                    <div className="side"><Chip color="pink" icon={<RotateCcw aria-hidden />}>Needs changes</Chip><span className="btn sm">Open script</span></div>
                  </Link>
                ))}
              </div>
            </Panel>
          )}
          {active.map((e) => <MyBatch key={e.batch.id} e={e} writerId={viewing} />)}
          {done.length > 0 && (
            <Panel title="Recently finished" sub="all your scripts delivered">
              <div className="rows">{done.map((e) => (
                <Link key={e.batch.id} to={`/batches/${e.batch.id}`} className="item clickable edge-mint">
                  <div className="body"><div className="top">{e.batch.clientName}</div><div className="title">{e.batch.title}</div><div className="meta">{plural(e.myProgress.total, 'script')} delivered{e.batch.stage !== 'delivered' ? ' · others still working on this batch' : ''}</div></div>
                  <div className="side"><Chip color="mint" icon={<CheckCheck aria-hidden />}>Done</Chip></div>
                </Link>
              ))}</div>
            </Panel>
          )}
          {q.data.recentDeliveries.length > 0 && (
            <Panel title="Your delivery confirmations">
              <div className="rows">{q.data.recentDeliveries.map((d) => (
                <div key={d.id} className="item edge-mint">
                  <div className="body"><div className="top">{d.clientName}</div><div className="title">{d.batchTitle}</div><div className="meta">Scripts {compressRanges(d.scriptNumbers) || '—'} · {fmtStamp(d.confirmedAt, clock.timezone)}</div></div>
                  <div className="side"><Chip color="mint">Writer-confirmed</Chip></div>
                </div>
              ))}</div>
            </Panel>
          )}
        </div>
      )}
    </>
  );
}

function NextUp({ e, today }: { e: Entry; today: string }) {
  const b = e.batch;
  const rec = e.briefings.find((x) => x.recordingUrl);
  const p = e.myProgress;
  const nextScript = e.mine.find((s) => s.status === 'revisions_needed') ?? e.mine.find((s) => s.status === 'in_progress') ?? e.mine.find((s) => s.status === 'not_started');
  const toDeliver = e.mine.filter((s) => s.status === 'approved').length;
  const doing = toDeliver && !nextScript ? `Add ${plural(toDeliver, 'approved script')} to Timeliner and confirm delivery` : nextScript ? `${nextScript.status === 'revisions_needed' ? 'Revise' : 'Write'} script ${nextScript.number}${nextScript.title ? ` · ${nextScript.title}` : ''}` : 'Waiting for review';
  return (
    <section className="stat-card salmon" style={{ cursor: 'default', minHeight: 0, transform: 'none' }} aria-label="Next up">
      <span className="cap">Next up</span>
      <div className="row-flex" style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ font: '800 30px/1.1 var(--font-display)', letterSpacing: '-0.04em', overflowWrap: 'anywhere' }}>{doing}</div>
          <div className="sub" style={{ fontSize: 14, marginTop: 8 }}>{b.clientName} · {b.title}</div>
          <div className="sub" style={{ fontSize: 14, marginTop: 4 }}>
            {b.next ? `${b.next.kind === 'draft' ? 'Drafts' : 'Final delivery'} ${b.next.overdue ? `${b.next.label.toLowerCase()} (${fmtDate(b.next.date!, today)})` : b.next.dueToday ? 'due today' : `due ${fmtLong(b.next.date!)}`}` : ''}
            {' · '}{p.draftReady} / {p.total} of yours draft-ready
          </div>
        </div>
        <div className="row-flex s2">
          {rec && <ExtLink href={rec.recordingUrl!} className="btn" ><PlayCircle aria-hidden />Recording</ExtLink>}
          <Link to={`/batches/${b.id}#scripts`} className="btn" style={{ background: 'var(--on-accent)', color: 'var(--text)' }}>Open batch <ArrowRight aria-hidden /></Link>
        </div>
      </div>
    </section>
  );
}

function MyBatch({ e, writerId }: { e: Entry; writerId: number }) {
  const { clock, me } = useBoot();
  const toast = useToast();
  const b = e.batch;
  const p = e.myProgress;
  const [delivering, setDelivering] = useState(false);
  const approved = e.mine.filter((s) => s.status === 'approved');
  const deliver = useSave((v: { url: string | null; note: string | null }) => api(`/api/batches/${b.id}/scripts/action`, {
    body: { action: 'deliver', scriptIds: approved.map((s) => s.id), timelinerUrl: v.url, note: v.note, versions: Object.fromEntries(approved.map((s) => [s.id, s.version])) },
  }), { onSuccess: () => { toast(`Delivery confirmed for scripts ${compressRanges(approved.map((s) => s.number))}`); setDelivering(false); } });
  const edge = b.next?.overdue || b.blocked ? 'edge-red' : b.next?.dueToday ? 'edge-yellow' : '';
  return (
    <Panel className={edge} title={b.title} sub={b.clientName} tools={<><DueChip m={b.next} today={clock.today} />{b.blocked && <Chip color="red">Blocked</Chip>}</>}>
      <div className="grid g-main-side" style={{ gap: 18 }}>
        <div className="stack s4">
          <div className="row-flex" style={{ gap: 18, flexWrap: 'nowrap', alignItems: 'center' }}>
            <Ring pct={p.pctDraft} color={ringColor(p)} size={64} stroke={7} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Your scripts: {compressRanges(e.mine.map((s) => s.number))}</div>
              <BatchProgress p={p} />
            </div>
          </div>
          <QuickProgress batchId={b.id} p={p} writerId={writerId} actingForOther={writerId !== me.id} />
          {p.revisions > 0 && <div className="banner pink"><RotateCcw aria-hidden /><div className="txt"><b>{plural(p.revisions, 'script')} need revisions</b><span>Resubmit them from the batch page once they’re fixed.</span></div></div>}
          {b.blocked && <div className="banner red"><div className="txt"><b>Blocked: {b.blockerNote}</b></div></div>}
          <div className="row-flex s2">
            <Button variant="primary pill" icon={<Send aria-hidden />} disabled={!approved.length} onClick={() => setDelivering(true)} title={approved.length ? undefined : 'Scripts can be delivered once they’re approved'}>
              {approved.length ? `Mark ${plural(approved.length, 'approved script')} delivered` : 'Nothing approved to deliver yet'}
            </Button>
            <Link to={`/batches/${b.id}#scripts`} className="btn">Open checklist</Link>
          </div>
        </div>
        <div className="stack s2">
          <div className="deadline-list">
            {b.shootStart && <div className="deadline" style={{ ['--c' as string]: 'var(--salmon)' }}><span className="ic"><Camera /></span><div><div className="k">Shoot</div><div className="v">{fmtRange(b.shootStart, b.shootEnd)}</div></div></div>}
            {b.plannedStart && <div className="deadline" style={{ ['--c' as string]: 'var(--cyan)' }}><span className="ic"><Plus /></span><div><div className="k">Start writing</div><div className="v">{fmtLong(b.plannedStart)}</div></div></div>}
            <div className="deadline" style={{ ['--c' as string]: 'var(--lavender)' }}><span className="ic"><FileText /></span><div><div className="k">Drafts due</div><div className="v">{b.draftDue ? fmtLong(b.draftDue) : 'Not set'}</div></div><div className="right"><DueChip m={b.draft} today={clock.today} prefix={false} /></div></div>
            <div className="deadline" style={{ ['--c' as string]: 'var(--yellow)' }}><span className="ic"><Send /></span><div><div className="k">Final delivery</div><div className="v">{b.finalDue ? fmtLong(b.finalDue) : 'Not set'}</div></div><div className="right"><DueChip m={b.final} today={clock.today} prefix={false} /></div></div>
          </div>
          {e.briefings.length > 0 && (
            <div className="stack s2" style={{ marginTop: 6 }}>
              <div className="section-title">Brief</div>
              {e.briefings.map((br) => (
                <div key={br.id} className="brief">
                  <h4>{br.title}{br.callDate && <span className="muted" style={{ fontWeight: 500, fontSize: 13 }}> · {fmtDate(br.callDate)}</span>}</h4>
                  <div className="links">
                    {br.recordingUrl && <ExtLink href={br.recordingUrl} className="btn sm salmon"><PlayCircle aria-hidden />Recording</ExtLink>}
                    {br.documentUrl && <ExtLink href={br.documentUrl} className="btn sm"><FileText aria-hidden />Document</ExtLink>}
                    {br.resources.map((r) => <a key={r.id} className="btn sm" href={r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!} target="_blank" rel="noopener noreferrer"><FileText aria-hidden />{r.title}</a>)}
                  </div>
                  {br.instructions && <p className="prose" style={{ fontSize: 13 }}>{br.instructions}</p>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {delivering && <DeliverDialog count={approved.length} nums={compressRanges(approved.map((s) => s.number))} busy={deliver.isPending} error={deliver.error} onClose={() => setDelivering(false)} onSubmit={(url, note) => deliver.mutate({ url, note })} />}
    </Panel>
  );
}

/**
 * The quick count control. Each step changes real script records:
 * + submits your next script for review, − withdraws your last submitted one.
 * It can never approve or deliver anything.
 */
function QuickProgress({ batchId, p, writerId, actingForOther }: { batchId: number; p: Progress; writerId: number; actingForOther: boolean }) {
  const toast = useToast();
  const [value, setValue] = useState(String(p.draftReady));
  useEffect(() => { setValue(String(p.draftReady)); }, [p.draftReady]);
  const min = p.approved;
  const max = p.total - p.revisions;
  const save = useSave((target: number) => api<{ changed: number[] }>(`/api/batches/${batchId}/quick-progress`, { body: { draftReady: target, expected: p.draftReady, writerId } }), {
    onSuccess: (out, target) => { if (out.changed.length) toast(`${target > p.draftReady ? 'Submitted' : 'Withdrew'} ${plural(out.changed.length, 'script')} — now ${target} / ${p.total} draft-ready`); },
  });
  const commit = (n: number) => {
    if (Number.isNaN(n)) { setValue(String(p.draftReady)); return; }
    const clamped = Math.min(max, Math.max(min, n));
    setValue(String(clamped));
    if (clamped !== p.draftReady) save.mutate(clamped);
  };
  return (
    <div className="stack s2">
      <div className="row-flex" style={{ gap: 10, flexWrap: 'nowrap' }}>
        <button className="icon-btn" style={{ background: 'var(--row)', width: 48, height: 48 }} aria-label="One fewer draft ready" disabled={save.isPending || p.draftReady <= min} onClick={() => commit(p.draftReady - 1)}><Minus /></button>
        <input className="input num" inputMode="numeric" aria-label="Drafts ready" style={{ width: 84, textAlign: 'center', fontSize: 22, fontWeight: 800, fontFamily: 'var(--font-display)', minHeight: 48 }}
          value={value} onChange={(ev) => setValue(ev.target.value.replace(/\D/g, ''))} onBlur={() => commit(Number(value))} onKeyDown={(ev) => { if (ev.key === 'Enter') commit(Number(value)); }} />
        <button className="icon-btn" style={{ background: 'var(--row)', width: 48, height: 48 }} aria-label="One more draft ready" disabled={save.isPending || p.draftReady >= max} onClick={() => commit(p.draftReady + 1)}><Plus /></button>
        <span className="muted" style={{ fontSize: 13 }}>of {p.total} draft-ready{actingForOther ? ' (on the writer’s behalf)' : ''}</span>
      </div>
      <span className="muted" style={{ fontSize: 12 }}>+ submits your next script for review; − withdraws the last one you submitted. Approval and delivery are separate steps.</span>
      <FormError error={save.error} />
    </div>
  );
}
