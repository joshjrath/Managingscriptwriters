// Review queue: scripts ready for review, grouped by batch, with approve and
// request-revisions actions (partial review is fine), plus every unresolved
// revision request.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, CheckCheck, ExternalLink, FileText, RotateCcw } from 'lucide-react';
import { api, useSave } from '../api';
import type { ReviewQueue } from '../../../shared/types';
import { compressRanges, STATUS_LABEL } from '../../../shared/workflow';
import { fmtDate, fmtStamp, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Chip, DueChip, Empty, ErrorState, FormError, Loading, Panel, useToast } from '../components/ui';
import { NoteDialog } from './BatchDetail';

export function ReviewPage() {
  const { me, clock, settings } = useBoot();
  const manager = me.role === 'manager';
  const toast = useToast();
  const q = useQuery({ queryKey: ['review'], queryFn: () => api<ReviewQueue>('/api/review'), refetchInterval: 60_000 });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [revise, setRevise] = useState<{ batchId: number; ids: number[]; nums: string } | null>(null);
  const act = useSave((v: { batchId: number; action: 'approve' | 'request_revisions'; ids: number[]; note?: string | null; versions: Record<number, number> }) =>
    api(`/api/batches/${v.batchId}/scripts/action`, { body: { action: v.action, scriptIds: v.ids, note: v.note ?? null, versions: v.versions } }), {
    onSuccess: (_o, v) => { toast(`${v.action === 'approve' ? 'Approved' : 'Sent back for revisions:'} ${plural(v.ids.length, 'script')}`); setSel(new Set()); setRevise(null); },
  });
  const total = q.data?.batches.reduce((n, g) => n + g.scripts.length, 0) ?? 0;
  return (
    <>
      <PageHeader title="Review queue" sub={manager ? 'Approve what’s ready — the rest of a batch can keep going.' : 'What’s waiting for a manager to review.'} />
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <FormError error={act.error} />
          <Panel title="Ready for review" count={total}>
            {!q.data.batches.length ? <Empty boxed icon={<CheckCheck />} title="Nothing waiting for review">Scripts appear here as soon as a writer submits them.</Empty> : (
              <div className="stack s6">
                {q.data.batches.map(({ batch: b, scripts }) => {
                  const chosen = scripts.filter((s) => sel.has(s.id));
                  const versions = (list: typeof scripts) => Object.fromEntries(list.map((s) => [s.id, s.version]));
                  const allWaiting = b.progress.inReview === b.progress.total - b.progress.approved;
                  return (
                    <section key={b.id} aria-label={`${b.clientName}: ${b.title}`}>
                      <div className="row-flex" style={{ marginBottom: 10, alignItems: 'flex-end' }}>
                        <div style={{ minWidth: 0 }}>
                          <div className="muted" style={{ fontSize: 12.5 }}>{b.clientName}</div>
                          <Link to={`/batches/${b.id}`} style={{ font: '700 17px/1.3 var(--font-display)', letterSpacing: '-0.02em' }}>{b.title}</Link>
                          <div className="muted num" style={{ fontSize: 12.5, marginTop: 2 }}>{b.progress.draftReady} / {b.progress.total} drafts ready · {b.progress.approved} approved · {b.progress.delivered} delivered</div>
                        </div>
                        <span className="spacer" />
                        <DueChip m={b.final} today={clock.today} />
                        {manager && (
                          <div className="row-flex s2">
                            {chosen.length > 0 && <>
                              <Button variant="sm mint" icon={<Check aria-hidden />} busy={act.isPending} onClick={() => act.mutate({ batchId: b.id, action: 'approve', ids: chosen.map((s) => s.id), versions: versions(chosen) })}>Approve {chosen.length} selected</Button>
                              <Button variant="sm danger" icon={<RotateCcw aria-hidden />} onClick={() => setRevise({ batchId: b.id, ids: chosen.map((s) => s.id), nums: compressRanges(chosen.map((s) => s.number)) })}>Request revisions</Button>
                            </>}
                            <Button variant="sm" busy={act.isPending} onClick={() => act.mutate({ batchId: b.id, action: 'approve', ids: scripts.map((s) => s.id), versions: versions(scripts) })}>
                              {allWaiting ? `Approve whole batch (${scripts.length})` : `Approve all ${scripts.length} in review`}
                            </Button>
                          </div>
                        )}
                      </div>
                      <div className="rows">
                        {scripts.map((s) => (
                          <div key={s.id} className={`item edge-lavender${sel.has(s.id) ? ' selected' : ''}`} style={sel.has(s.id) ? { background: 'color-mix(in srgb, var(--salmon) 11%, var(--row))' } : undefined}>
                            <div className="row-flex" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
                              {manager && <input type="checkbox" aria-label={`Select script ${s.number}`} style={{ width: 20, height: 20, accentColor: 'var(--salmon)' }} checked={sel.has(s.id)} onChange={() => { const n = new Set(sel); n.has(s.id) ? n.delete(s.id) : n.add(s.id); setSel(n); }} />}
                              <div className="body">
                                <div className="title">Script {s.number}{s.title ? ` · ${s.title}` : ''}</div>
                                <div className="meta"><span>{s.assigneeName ?? 'Unassigned'}</span><span>Submitted {fmtStamp(s.submittedAt, settings.timezone)}</span>{s.docUrl && <a className="link" href={s.docUrl} target="_blank" rel="noopener noreferrer"><FileText size={13} aria-hidden /> Document</a>}</div>
                              </div>
                            </div>
                            <div className="side">
                              {manager ? (
                                <div className="row-flex s2">
                                  <Button variant="sm mint" onClick={() => act.mutate({ batchId: b.id, action: 'approve', ids: [s.id], versions: { [s.id]: s.version } })}>Approve</Button>
                                  <Button variant="sm ghost" onClick={() => setRevise({ batchId: b.id, ids: [s.id], nums: String(s.number) })}>Revisions…</Button>
                                </div>
                              ) : <Chip color="lavender" dot>In review</Chip>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </div>
            )}
          </Panel>
          <Panel title="Unresolved revision requests" count={q.data.revisions.length}>
            {!q.data.revisions.length ? <Empty boxed icon={<Check />} title="No open revision requests" /> : (
              <div className="rows">
                {q.data.revisions.map((r) => (
                  <Link key={r.id} to={`/batches/${r.batchId}#scripts`} className="item clickable edge-pink">
                    <div className="body">
                      <div className="top">{r.clientName} · {r.batchTitle}</div>
                      <div className="title">Script {r.scriptNumber} · {r.assigneeName ?? 'Unassigned'}</div>
                      <div className="prose" style={{ fontSize: 13.5 }}>{r.note}</div>
                      <div className="meta">Requested by {r.requestedByName} · {fmtStamp(r.requestedAt, settings.timezone)} ({fmtDate(r.requestedAt.slice(0, 10))})</div>
                    </div>
                    <div className="side"><Chip color="pink" icon={<RotateCcw aria-hidden />}>{STATUS_LABEL[r.scriptStatus]}</Chip><span className="btn sm">Open <ExternalLink aria-hidden /></span></div>
                  </Link>
                ))}
              </div>
            )}
          </Panel>
        </div>
      )}
      {revise && <NoteDialog title={`Request revisions on ${plural(revise.ids.length, 'script')}`} label="What needs to change?" required confirm="Send back for revisions" variant="danger" scripts={revise.nums}
        busy={act.isPending} error={act.error} onClose={() => setRevise(null)}
        onSubmit={(note) => act.mutate({ batchId: revise.batchId, action: 'request_revisions', ids: revise.ids, note, versions: Object.fromEntries((q.data?.batches.flatMap((g) => g.scripts) ?? []).filter((s) => revise.ids.includes(s.id)).map((s) => [s.id, s.version])) })} />}
    </>
  );
}
