// Batch page: brief, assignments, the script checklist (the source of truth),
// progress, deadlines, review notes, delivery records and activity history.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle, Archive, ArchiveRestore, Ban, CalendarClock, Camera, Check, CheckCheck, ChevronDown, ExternalLink, FileText,
  Flag, Link2, ListTodo, OctagonAlert, Plus, Pencil, PenLine, PlayCircle, RotateCcw, Send, SlidersHorizontal, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import type { BatchDetail, ClientDetail, MyWork, Priority, ReschedulePreview, Resource, ResourceCategory, Script, Submission } from '../../../shared/types';
import { PRIORITIES, PRIORITY_LABEL, RESOURCE_CATEGORIES, RESOURCE_LABEL } from '../../../shared/types';
import { allowedFrom, canWrite, checkAction, compressRanges, parseRanges, ROLE_LABEL, scriptsLabel, STATUS_LABEL, type ScriptAction, type ScriptStatus, isManager } from '../../../shared/workflow';
import { addDays, computeDeadlines, diffDays, draftFromFinal, isISODate, suggestStart, type ISODate } from '../../../shared/dates';
import { cutoffIn, fmtBytes, fmtCutoff, fmtDate, fmtLong, fmtRange, fmtStamp, fmtTimeZoneAbbr, plural } from '../../../shared/format';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import {
  Avatar, BatchProgress, Button, Chip, CountUp, Dialog, DueChip, Empty, ErrorState, ExtLink, Field, FormError, inputProps, Loading, Panel,
  NotFound, Ring, ringColor, StageChip, StatusChip, Term, useFieldId, useToast, Seg,
} from '../components/ui';
import { WrittenCounter } from '../components/WrittenCounter';
import { PipLegend, ScriptPips, TodayBump } from '../components/WritingPulse';
import { TodoDialog, TodoPanel } from '../components/Todos';
import { WorkCard } from './MyWork';
import { approvedSources, CardList, DecisionDialog, DocumentHistory, SendDialog, SentBackCard, SourceList, useUndoDecision, WaitingCard } from '../components/Review';

export function BatchPage() {
  const { id } = useParams();
  const bad = !/^\d+$/.test(id ?? '');
  const q = useQuery({ queryKey: ['batch', Number(id)], queryFn: () => api<BatchDetail>(`/api/batches/${id}`), enabled: !bad });
  if (bad || (q.error as ApiError | null)?.status === 404) return <NotFound what="batch" />;
  if (q.isLoading) return <><div style={{ height: 90 }} /><Loading height={520} /></>;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return <BatchView b={q.data!} />;
}

function BatchView({ b }: { b: BatchDetail }) {
  const displayTz = useDisplayTz();
  const { me, clock, settings } = useBoot();
  const manager = isManager(me.role);
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [target, setTarget] = useState(false);
  const [resched, setResched] = useState(false);
  const [blocker, setBlocker] = useState(false);
  const [addRes, setAddRes] = useState(false);
  const archive = useSave((archived: boolean) => api(`/api/batches/${b.id}/archive`, { body: { archived } }), { onSuccess: (_o, a) => toast(a ? 'Batch archived' : 'Batch restored') });
  const reviewed = useSave(() => api(`/api/batches/${b.id}/dates-reviewed`, { body: {} }), { onSuccess: () => toast('Deadlines confirmed') });
  const datesOutOfOrder = !!(b.draftDue && b.finalDue && b.draftDue > b.finalDue);
  const unblock = useSave(() => api(`/api/batches/${b.id}/blocker`, { body: { blocked: false, note: null } }), { onSuccess: () => toast('Blocker cleared') });
  const canBlock = manager || b.isAssigned;
  // your own share of this batch, if you're writing some of it
  const mine = b.writers.find((w) => w.userId === me.id);
  const [todoFor, setTodoFor] = useState<number | null>(null);
  const [sendBack, setSendBack] = useState<number | null>(null);
  const [moveFrom, setMoveFrom] = useState<number | null>(null);
  const tz = fmtTimeZoneAbbr(settings.timezone); // deadlines are the workspace's
  // a writer opening a batch has seen what's new in it; their own scripts come first
  const qc = useQueryClient();
  const myWork = useQuery({ queryKey: ['my-work', me.id], queryFn: () => api<MyWork>('/api/my-work'), enabled: !!mine });
  const myEntry = myWork.data?.batches.find((x) => x.batch.id === b.id);
  const isMine = !!mine;
  useEffect(() => {
    if (!isMine) return;
    api(`/api/batches/${b.id}/seen`, { body: {} }).then(() => qc.invalidateQueries({ queryKey: ['bootstrap'] })).catch(() => {});
  }, [b.id, isMine, qc]);

  return (
    <>
      <PageHeader
        title={b.title}
        crumbs={<><Link to="/clients">Clients</Link><span aria-hidden>›</span><Link to={`/clients/${b.clientId}`}>{b.clientName}</Link></>}
        sub={<span className="row-flex s2"><StageChip stage={b.stage} />{b.priority !== 'normal' && <Chip color={b.priority === 'urgent' ? 'red' : b.priority === 'high' ? 'salmon' : 'neutral'}>{PRIORITY_LABEL[b.priority]} priority</Chip>}{b.blocked && <Chip color="red" icon={<Ban aria-hidden />}>Blocked</Chip>}{b.archivedAt && <Chip color="neutral" icon={<Archive aria-hidden />}>Archived</Chip>}</span>}
        hideNewWork
      >
        {canBlock && !b.blocked && <Button icon={<Flag aria-hidden />} onClick={() => setBlocker(true)}>Flag blocker</Button>}
        {manager && <Button icon={<Pencil aria-hidden />} onClick={() => setEdit(true)}>Edit batch</Button>}
      </PageHeader>

      <div className="stack" style={{ gap: 'var(--gap)' }}>
        {b.blocked && (
          <div className="banner red" role="status">
            <OctagonAlert aria-hidden />
            <div className="txt"><b>Blocked: {b.blockerNote}</b><span>{b.blockedBy === me.id ? 'You flagged this' : `Flagged by ${b.blockedByName ?? 'someone'}`} · {fmtStamp(b.blockedAt, displayTz)}.{manager ? ' Writers can keep working; clear it once it’s sorted.' : b.blockedBy === me.id ? ' A manager has been told.' : ' A manager is sorting this out.'}</span></div>
            {canBlock && <Button variant="sm" busy={unblock.isPending} onClick={() => unblock.mutate(undefined)}>Clear blocker</Button>}
          </div>
        )}
        {manager && datesOutOfOrder && !b.needsDateReview && (
          <div className="banner red" role="status"><CalendarClock aria-hidden /><div className="txt"><b>Drafts are due after final delivery</b><span>Drafts {fmtDate(b.draftDue)}, final delivery {fmtDate(b.finalDue)}.</span></div>
            {manager && <Button variant="sm" onClick={() => setEdit(true)}>Edit deadlines</Button>}</div>
        )}
        {manager && b.needsDateReview && (
          <div className="banner yellow" role="status">
            <CalendarClock aria-hidden />
            <div className="txt"><b>Deadlines need a check</b><span>{b.dateReviewNote}</span></div>
            {manager && <><Button variant="sm" onClick={() => setEdit(true)}>Edit deadlines</Button>{datesOutOfOrder
              ? <span className="muted" style={{ fontSize: 12.5 }}>Drafts are due after final delivery, so fix them first.</span>
              : <Button variant="sm primary" busy={reviewed.isPending} onClick={() => reviewed.mutate(undefined)}>Dates are fine</Button>}</>}
          </div>
        )}
        {b.progress.unassigned > 0 && (
          <div className="banner pink"><UserPlus aria-hidden /><div className="txt"><b>{plural(b.progress.unassigned, 'script')} unassigned</b><span>{manager ? 'Select them in the checklist below and use “Assign to…”.' : 'A manager needs to assign these.'}</span></div></div>
        )}

        {myEntry && (
          <section className="mw-sec tone-todo batch-mine" aria-label="Your scripts">
            <div className="mw-sec-head"><span className="ic"><PenLine aria-hidden /></span><h2>Your scripts</h2><span className="sub">What you need to do in this batch</span></div>
            <WorkCard e={myEntry} writerId={me.id} standalone />
          </section>
        )}
        {!myEntry && <ReadyToDeliver b={b} />}

        <div className="grid g-main-side">
          <Panel title="Progress" tools={manager ? <Button variant="sm ghost" icon={<SlidersHorizontal aria-hidden />} onClick={() => setTarget(true)}>Change script count</Button> : undefined}>
            <div className="row-flex" style={{ alignItems: 'center', gap: 22, flexWrap: 'nowrap', marginBottom: 18 }}>
              <Ring pct={b.progress.pctDraft} size={104} stroke={9} color={ringColor(b.progress)} large><span><CountUp value={b.progress.pctDraft} />%<small>drafts</small></span></Ring>
              <div style={{ flex: 1, minWidth: 0 }}><BatchProgress p={b.progress} written={b.written} /></div>
            </div>
            <div className="triple">
              <div style={{ ['--c' as string]: 'var(--lavender)' }}><span className="k"><i />Drafts sent</span><span className="v"><CountUp value={b.progress.draftReady} /><small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctDraft}% · {b.progress.inReview} waiting for review</span></div>
              <div style={{ ['--c' as string]: 'color-mix(in srgb, var(--mint) 60%, var(--track))' }}><span className="k"><i />Approved</span><span className="v"><CountUp value={b.progress.approved} /><small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctApproved}% · {b.progress.awaitingDelivery} to deliver</span></div>
              <div style={{ ['--c' as string]: 'var(--mint)' }}><span className="k"><i />Delivered</span><span className="v"><CountUp value={b.progress.delivered} /><small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctDelivered}% · in Timeliner</span></div>
            </div>
            {b.progress.revisions > 0 && <div className="banner pink" style={{ marginTop: 12 }}><RotateCcw aria-hidden /><div className="txt"><b>{plural(b.progress.revisions, 'script')} sent back</b><span>The writer is fixing these. They count as written and come back to review when resent.</span></div></div>}
            {mine && (
              <div style={{ marginTop: 18 }}>
                <WrittenCounter key={b.id} batchId={b.id} writerId={me.id} forOther={false} total={mine.count} sent={mine.draftReady} written={Math.max(mine.written, mine.draftReady)} />
              </div>
            )}
            <div className="section-title" style={{ marginTop: 22 }}>Assignments</div>
            <div className="rows">
              {b.writers.map((w) => (
                <div key={String(w.userId)} className={`item ${w.userId == null ? 'edge-pink' : ''}`}>
                  <div className="body">
                    <div className="row-flex s2" style={{ rowGap: 6 }}>{w.userId != null && <Avatar name={w.name} id={w.userId} small />}<span className="title" style={{ whiteSpace: 'nowrap' }}>{w.name}</span><TodayBump n={w.writtenToday} />{w.revisions > 0 && <Chip color="pink" icon={<RotateCcw aria-hidden />}>{w.revisions} sent back</Chip>}</div>
                    <div className="meta">Scripts {w.ranges} · {plural(w.count, 'script')}</div>
                    {w.userId != null && <ScriptPips w={w} large />}
                    {manager && w.userId != null && (
                      <div className="row-flex s2" style={{ marginTop: 10 }}>
                        <Button variant="sm ghost" icon={<ListTodo aria-hidden />} onClick={() => setTodoFor(w.userId)}>Add to-do</Button>
                        {b.scripts.some((s) => s.assigneeId === w.userId && allowedFrom('request_revisions', s.status)) && (
                          <Button variant="sm ghost" icon={<RotateCcw aria-hidden />} onClick={() => setSendBack(w.userId)}>Send back…</Button>
                        )}
                        {b.scripts.some((s) => s.assigneeId === w.userId && (s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed')) && (
                          <Button variant="sm ghost" icon={<UserPlus aria-hidden />} onClick={() => setMoveFrom(w.userId)}>Move scripts…</Button>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="side">
                    <span className="when num">{w.userId != null && w.written > w.draftReady + w.revisions ? `${w.written} / ${w.count} written` : `${w.draftReady} / ${w.count} drafts sent`}</span>
                    <span className="muted num" style={{ fontSize: 12 }}>{w.revisions > 0 ? `${w.revisions} sent back · ` : ''}{w.written > w.draftReady + w.revisions ? `${w.draftReady} sent · ` : ''}{w.delivered} delivered{w.writtenAt ? ` · updated ${fmtStamp(w.writtenAt, displayTz)}` : ''}</span>
                    {manager && w.userId != null && w.userId !== me.id && w.draftReady < w.count && (
                      <WrittenCounter key={b.id} compact batchId={b.id} writerId={w.userId} forOther total={w.count} sent={w.draftReady} written={Math.max(w.written, w.draftReady)} />
                    )}
                  </div>
                </div>
              ))}
            </div>
            <PipLegend />
          </Panel>

          <Panel title="Deadlines" sub={`due by ${fmtCutoff(settings.cutoff)} ${tz}${(() => { const mine = cutoffIn(settings.cutoff, settings.timezone, displayTz, clock.today); return mine ? ` · ${mine} your time` : ''; })()}`}>
            <div className="deadline-list">
              <div className="deadline" style={{ ['--c' as string]: 'var(--salmon)' }}>
                <span className="ic"><Camera /></span>
                <div><div className="k">Shoot</div><div className="v">{b.shootStart ? fmtRange(b.shootStart, b.shootEnd) : 'No shoot'}</div>{b.shootStart && <div className="rule">Deadlines count back from {fmtDate(b.shootStart)}</div>}</div>
                <div className="right">{manager && b.shootId && <Button variant="sm" icon={<Camera aria-hidden />} onClick={() => setResched(true)} title="Moves the shoot and every batch on it; writers are told">Move shoot…</Button>}</div>
              </div>
              <div className="deadline" style={{ ['--c' as string]: 'var(--cyan)' }}>
                <span className="ic"><Pencil /></span>
                <div><div className="k">Planned writing start</div><div className="v">{b.plannedStart ? fmtLong(b.plannedStart) : 'Not planned'}</div></div>
              </div>
              <div className="deadline" style={{ ['--c' as string]: 'var(--lavender)' }}>
                <span className="ic"><CalendarClock /></span>
                <div><div className="k">Drafts due</div><div className="v">{b.draftDue ? fmtLong(b.draftDue) : 'Not set'}</div><div className="rule">{b.draftRule ?? (b.draftDue ? (b.shootId ? 'Manual override' : 'Entered manually') : '')}</div></div>
                <div className="right"><DueChip m={b.draft} today={clock.today} prefix={false} />{b.draftDueMode === 'manual' && b.shootId && <Chip color="yellow">Override</Chip>}</div>
              </div>
              <div className="deadline" style={{ ['--c' as string]: 'var(--yellow)' }}>
                <span className="ic"><Send /></span>
                <div><div className="k">Final delivery to <Term k="Timeliner" /></div><div className="v">{b.finalDue ? fmtLong(b.finalDue) : 'Not set'}</div><div className="rule">{b.finalRule ?? (b.finalDue ? (b.shootId ? 'Manual override' : 'Entered manually') : '')}</div></div>
                <div className="right"><DueChip m={b.final} today={clock.today} prefix={false} />{b.finalDueMode === 'manual' && b.shootId && <Chip color="yellow">Override</Chip>}</div>
              </div>
            </div>
            {manager && b.nextAction && <><div className="section-title" style={{ marginTop: 20 }}>Next action</div><p className="prose">{b.nextAction}</p></>}
            {manager && (
              <div className="row-flex s2" style={{ marginTop: 18 }}>
                {b.archivedAt
                  ? <Button variant="sm" icon={<ArchiveRestore aria-hidden />} busy={archive.isPending} onClick={() => archive.mutate(false)}>Restore batch</Button>
                  : <Button variant="sm ghost" icon={<Archive aria-hidden />} busy={archive.isPending} onClick={() => { if (b.stage === 'delivered' || window.confirm(`Archive “${b.title}”? It still has ${b.progress.total - b.progress.delivered} undelivered scripts. Nothing is deleted.`)) archive.mutate(true); }}>Archive</Button>}
              </div>
            )}
          </Panel>
        </div>

        <DocumentsPanel b={b} />

        <ScriptChecklist b={b} />

        <div className="grid g-2">
          <Panel title="Brief & resources" tools={(manager || b.isAssigned) ? <Button variant="sm" icon={<Link2 aria-hidden />} onClick={() => setAddRes(true)}>Add resource</Button> : undefined}>
            <BriefSection b={b} />
          </Panel>
          <div className="stack" style={{ gap: 'var(--gap)' }}>
            <TodoPanel batchId={b.id} title="To-dos for this batch" hideWhenEmpty />
            <ReviewNotes b={b} />
            <Deliveries b={b} />
          </div>
        </div>

        <Panel title="Activity history" count={b.activity.length}>
          {!b.activity.length ? <Empty title="No activity yet" /> : (
            <div className="timeline" style={{ maxHeight: 520, overflowY: 'auto' }}>
              {b.activity.map((a) => (
                <div key={a.id} className="tl" style={{ ['--c' as string]: a.action.includes('deliver') ? 'var(--mint)' : a.action.includes('revision') ? 'var(--pink)' : a.action.includes('approve') ? 'var(--mint)' : a.action.includes('submit') ? 'var(--lavender)' : a.action.includes('block') ? 'var(--red)' : a.action.includes('deadline') ? 'var(--yellow)' : 'var(--line)' }}>
                  <span className="d" />
                  <div><div className="s">{a.summary}</div><div className="w">{a.actorName ?? 'System'} · {fmtStamp(a.createdAt, displayTz)}</div></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {todoFor != null && <TodoDialog userId={todoFor} batchId={b.id} onClose={() => setTodoFor(null)} />}
      {sendBack != null && <SendBackDialog b={b} writerId={sendBack} onClose={() => setSendBack(null)} />}
      {moveFrom != null && <MoveScriptsDialog b={b} fromId={moveFrom} onClose={() => setMoveFrom(null)} />}
      {manager && edit && <EditBatchDialog b={b} open onClose={() => setEdit(false)} />}
      {manager && target && <TargetDialog b={b} onClose={() => setTarget(false)} />}
      {manager && resched && b.shootId && <RescheduleDialog shootId={b.shootId} start={b.shootStart!} end={b.shootEnd} onClose={() => setResched(false)} />}
      <BlockerDialog b={b} open={blocker} onClose={() => setBlocker(false)} />
      <ResourceDialog open={addRes} onClose={() => setAddRes(false)} clientId={b.clientId} batchId={b.id} />
    </>
  );
}

// ── drafts & documents ───────────────────────────────────────────────────
// Scripts go back and forth as documents: one PDF or link per writer, reviewed in one go.

/** Approved scripts waiting for Timeliner. Writers confirm their own; a
 *  manager's confirmation delivers every approved script in the batch. */
function ReadyToDeliver({ b }: { b: BatchDetail }) {
  const { me } = useBoot();
  const manager = isManager(me.role);
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const ready = b.scripts.filter((s) => !checkAction('deliver', s, me));
  const run = useSave((v: { url: string | null; note: string | null; ids: number[] }) => api<{ changed: number[] }>(`/api/batches/${b.id}/scripts/action`, {
    body: { action: 'deliver', scriptIds: v.ids, timelinerUrl: v.url, note: v.note, versions: Object.fromEntries(ready.filter((s) => v.ids.includes(s.id)).map((s) => [s.id, s.version])) },
  }), { onSuccess: (o) => { toast(`Marked ${plural(o.changed.length, 'script')} delivered`); setOpen(false); } });
  if (!ready.length) return null;
  const nums = compressRanges(ready.map((s) => s.number));
  // who the scripts belong to, for the manager's summary
  const byWriter = new Map<string, number[]>();
  for (const s of ready) {
    const who = s.assigneeId === me.id ? 'You' : s.assigneeName ?? 'Unassigned';
    byWriter.set(who, [...(byWriter.get(who) ?? []), s.number]);
  }
  const others = [...byWriter.keys()].filter((k) => k !== 'You' && k !== 'Unassigned');
  const breakdown = [...byWriter.entries()].map(([who, n]) => `${who} ${compressRanges(n)}`).join(' · ');
  const notYet = b.progress.total - b.progress.delivered - b.progress.awaitingDelivery;
  return (
    <>
      <div className="todo-block mint">
        <div style={{ minWidth: 0 }}>
          <div className="t">{plural(ready.length, 'script')} approved <span className="muted num">({manager ? breakdown : nums})</span></div>
          <div className="s">{manager
            ? `Add them to Timeliner, then confirm here.${others.length ? ` You confirm for ${others.join(', ')}.` : ''}${notYet > 0 ? ` The other ${plural(notYet, 'script')} in this batch aren’t approved yet and aren’t affected.` : ''}`
            : 'Add them to Timeliner, then confirm here.'}</div>
        </div>
        <Button variant="mint pill" icon={<CheckCheck aria-hidden />} onClick={() => setOpen(true)}>
          {`Mark ${plural(ready.length, 'approved script')} delivered`}
        </Button>
      </div>
      {open && <DeliverDialog scripts={ready} submissions={b.submissions} forName={manager && others.length ? others.join(', ') : null} pick={!manager} busy={run.isPending} error={run.error}
        onClose={() => setOpen(false)} onSubmit={(url, note, ids) => run.mutate({ url, note, ids })} />}
    </>
  );
}

function DocumentsPanel({ b }: { b: BatchDetail }) {
  const { me } = useBoot();
  const manager = isManager(me.role);
  const [dialog, setDialog] = useState<null | { kind: 'send'; preselect: number[]; resend?: boolean; replace?: boolean; feedback?: { note: string | null; byName: string } | null }>(null);
  useEffect(() => { if (window.location.hash === '#documents') document.getElementById('documents')?.scrollIntoView(); }, []);
  const mine = b.scripts.filter((s) => s.assigneeId === me.id);
  // writers send their own scripts; managers can send any on a writer's behalf
  const sendable = (manager ? b.scripts : mine).filter((s) => s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed');
  const notSent = (manager && !mine.length ? b.scripts : mine).filter((s) => s.status === 'not_started' || s.status === 'in_progress');
  const waiting = b.groups.filter((g) => g.kind === 'waiting');
  const sentBack = b.groups.filter((g) => g.kind === 'sent_back');
  // replacing or resending a document is the writer's job; managers can do it from the writer's My work
  const canResend = (writerId: number | null) => writerId === me.id;
  return (
    <Panel title="Drafts & documents" id="documents" count={waiting.length + sentBack.length || undefined}
      sub={waiting.length || sentBack.length ? `${waiting.length} in review · ${sentBack.length} sent back` : 'one PDF or link per writer, reviewed together'}
      tools={<>
        {sendable.length > 0 && <Button variant="sm primary" icon={<Upload aria-hidden />} onClick={() => setDialog({ kind: 'send', preselect: (notSent.length ? notSent : sendable).map((s) => s.id) })}>Send scripts for review</Button>}
      </>}>
      <div className="stack s4">
        {!waiting.length && !sentBack.length && (
          <Empty boxed icon={<FileText />} title="Nothing in review right now">
            {b.isAssigned ? 'When your scripts are written, send them as one PDF or Google Doc link — the reviewer sees one card, not one per script.' : 'Writers send their scripts here as one PDF or Google Doc link.'}
          </Empty>
        )}
        <CardList groups={[...waiting, ...sentBack]}>{(g) => g.kind === 'waiting'
          ? <WaitingCard group={g} showBatch={false} onReplace={canResend(g.writerId) ? () => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id), replace: true }) : undefined} />
          : <SentBackCard group={g} showBatch={false} onResend={canResend(g.writerId) ? () => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id), resend: true, feedback: g.review ? { note: g.review.note, byName: g.review.reviewedByName } : null }) : undefined} />}
        </CardList>
        {b.submissions.length > 0 && (
          <details className="details">
            <summary><ChevronDown aria-hidden />Every version and decision ({b.submissions.length} {b.submissions.length === 1 ? 'document' : 'documents'})</summary>
            <div className="inner"><DocumentHistory submissions={b.submissions} /></div>
          </details>
        )}
      </div>
      {dialog?.kind === 'send' && <SendDialog batchId={b.id} batchTitle={b.title} candidates={dialog.replace ? b.scripts.filter((s) => dialog.preselect.includes(s.id)) : sendable} preselect={dialog.preselect}
        resend={dialog.resend} replace={dialog.replace} feedback={dialog.feedback} onClose={() => setDialog(null)} />}
    </Panel>
  );
}

// ── script checklist ─────────────────────────────────────────────────────

const WRITER_ACTIONS: ScriptAction[] = ['start', 'submit', 'withdraw', 'deliver', 'reset', 'undo_delivery'];
const MANAGER_ACTIONS: ScriptAction[] = ['start', 'submit', 'approve', 'request_revisions', 'deliver', 'withdraw', 'reset', 'undo_delivery'];
const ACTION_STYLE: Partial<Record<ScriptAction, string>> = { submit: 'review', approve: 'mint', request_revisions: 'danger', deliver: 'primary', undo_delivery: 'ghost', reset: 'ghost', withdraw: 'ghost' };
const ACTION_SHORT: Record<ScriptAction, string> = { start: 'Start writing', reset: 'Mark not started', submit: 'Send for review…', withdraw: 'Withdraw', approve: 'Approve', request_revisions: 'Send back…', deliver: 'Mark delivered to Timeliner', undo_delivery: 'Undo delivery' };

function ScriptChecklist({ b }: { b: BatchDetail }) {
  const { me, users } = useBoot();
  const manager = isManager(me.role);
  const toast = useToast();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [range, setRange] = useState('');
  const [rangeErr, setRangeErr] = useState('');
  const [filter, setFilter] = useState<'all' | 'mine' | ScriptStatus | 'unassigned'>(manager ? 'all' : b.isAssigned ? 'mine' : 'all');
  const [dialog, setDialog] = useState<null | { action: ScriptAction | 'assign'; ids: number[] }>(null);
  const sendable = b.scripts.filter((s) => (manager || s.assigneeId === me.id) && (s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed'));
  const [open, setOpen] = useState<Script | null>(null);
  const actions = manager ? MANAGER_ACTIONS : WRITER_ACTIONS;
  // long checklists start folded; documents are the main way work moves now
  const [expanded, setExpanded] = useState(() => b.scripts.length <= 12 || window.location.hash === '#scripts' || (manager && b.progress.unassigned > 0));

  useEffect(() => { if (window.location.hash === '#scripts') document.getElementById('scripts')?.scrollIntoView(); }, []);
  // drop selections that no longer exist
  useEffect(() => { setSel((s) => new Set([...s].filter((id) => b.scripts.some((x) => x.id === id)))); }, [b.scripts]);

  const visible = b.scripts.filter((s) =>
    filter === 'all' ? true : filter === 'mine' ? s.assigneeId === me.id : filter === 'unassigned' ? s.assigneeId == null : s.status === filter);
  const selected = b.scripts.filter((s) => sel.has(s.id));
  const eligible = (a: ScriptAction) => selected.filter((s) => !checkAction(a, s, me));

  const undoable = useUndoDecision();
  const run = useSave((v: { action: ScriptAction; ids: number[]; note?: string | null; timelinerUrl?: string | null }) =>
    api<{ changed: number[]; reviewId?: number }>(`/api/batches/${b.id}/scripts/action`, {
      body: { action: v.action, scriptIds: v.ids, note: v.note ?? null, timelinerUrl: v.timelinerUrl ?? null, versions: Object.fromEntries(b.scripts.filter((s) => v.ids.includes(s.id)).map((s) => [s.id, s.version])) },
    }), {
    onSuccess: (o, v) => {
      const nums = compressRanges(b.scripts.filter((s) => o.changed.includes(s.id)).map((s) => s.number));
      const text = `${DONE[v.action]} ${o.changed.length > 1 ? 'scripts' : 'script'} ${nums}`;
      if (v.action === 'approve' || v.action === 'request_revisions') undoable(o.reviewId, text); else toast(text);
      setSel(new Set()); setDialog(null);
    },
  });
  const assign = useSave((v: { ids: number[]; assigneeId: number | null }) => api(`/api/batches/${b.id}/scripts/assign`, { body: { scriptIds: v.ids, assigneeId: v.assigneeId } }), {
    onSuccess: (_o, v) => { toast(`Assigned ${plural(v.ids.length, 'script')} to ${v.assigneeId ? users.find((u) => u.id === v.assigneeId)?.name : 'nobody (unassigned)'}`); setSel(new Set()); setDialog(null); },
  });

  const toggle = (s: Script, shift: boolean) => {
    const next = new Set(sel);
    if (shift && anchor != null) {
      const a = visible.findIndex((x) => x.id === anchor);
      const z = visible.findIndex((x) => x.id === s.id);
      if (a >= 0 && z >= 0) {
        const on = !sel.has(s.id);
        for (const x of visible.slice(Math.min(a, z), Math.max(a, z) + 1)) on ? next.add(x.id) : next.delete(x.id);
        setSel(next); setAnchor(s.id); return;
      }
    }
    next.has(s.id) ? next.delete(s.id) : next.add(s.id);
    setSel(next); setAnchor(s.id);
  };
  const selectRange = () => {
    const max = Math.max(...b.scripts.map((s) => s.number), 0);
    const nums = parseRanges(range, max);
    if (!nums) { setRangeErr(`Use numbers between 1 and ${max}, like 1–20 or 3, 5, 8–10`); return; }
    setRangeErr('');
    setSel(new Set(b.scripts.filter((s) => nums.includes(s.number)).map((s) => s.id)));
  };
  const startAction = (a: ScriptAction) => {
    const ids = eligible(a).map((s) => s.id);
    if (!ids.length) return;
    if (a === 'submit' || a === 'request_revisions' || a === 'deliver' || a === 'undo_delivery') setDialog({ action: a, ids });
    else run.mutate({ action: a, ids });
  };
  const allVisibleSelected = visible.length > 0 && visible.every((s) => sel.has(s.id));
  const counts = (Object.keys(STATUS_LABEL) as ScriptStatus[]).map((st) => [st, b.scripts.filter((s) => s.status === st).length] as const).filter(([, n]) => n);

  if (!expanded) {
    return (
      <Panel title="Script checklist" count={b.scripts.length} id="scripts" sub="every script, one row each"
        tools={<Button variant="sm" onClick={() => setExpanded(true)}>Show all {plural(b.scripts.length, 'script')}</Button>}>
        <div className="row-flex s2">
          {counts.map(([st, n]) => <span key={st} className="row-flex" style={{ gap: 6 }}><StatusChip status={st} /><b className="num">{n}</b></span>)}
          {b.progress.unassigned > 0 && <Chip color="pink" icon={<UserPlus aria-hidden />}>{b.progress.unassigned} unassigned</Chip>}
        </div>
        <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>Open the checklist to assign scripts, edit one script’s links or notes, or update a few at a time.</p>
      </Panel>
    );
  }

  return (
    <Panel title="Script checklist" count={b.scripts.length} id="scripts"
      sub={`${b.progress.draftReady} / ${b.progress.total} drafts sent · ${b.progress.pctDraft}%`}
      tools={b.scripts.length > 12 ? <Button variant="sm ghost" onClick={() => { setExpanded(false); setSel(new Set()); }}>Hide</Button> : undefined}>
      <div className="script-toolbar">
        <select className="select sm" style={{ width: 'auto' }} aria-label="Show scripts" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
          <option value="all">All scripts</option>
          {b.isAssigned && <option value="mine">Assigned to me</option>}
          <option value="unassigned">Unassigned</option>
          {(Object.keys(STATUS_LABEL) as ScriptStatus[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
          <input className="input sm" style={{ width: 150 }} placeholder="e.g. 1–20" value={range} onChange={(e) => setRange(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') selectRange(); }} aria-label="Select scripts by number range" aria-invalid={rangeErr ? true : undefined} />
          <Button variant="sm" onClick={selectRange} disabled={!range.trim()}>Select range</Button>
        </div>
        <Button variant="sm ghost" onClick={() => setSel(allVisibleSelected ? new Set() : new Set(visible.map((s) => s.id)))}>{allVisibleSelected ? 'Clear selection' : `Select ${visible.length} shown`}</Button>
        <span className="muted" style={{ fontSize: 12.5 }}>Tip: shift-click to select a run of rows.</span>
      </div>
      {rangeErr && <div className="field" style={{ marginBottom: 10 }}><span className="err" role="alert">{rangeErr}</span></div>}

      {selected.length > 0 && (
        <div className="bulkbar" role="toolbar" aria-label="Actions for selected scripts">
          <span className="count">{selected.length} selected <span className="muted" style={{ fontWeight: 500 }}>({compressRanges(selected.map((s) => s.number))})</span></span>
          {actions.map((a) => {
            const n = eligible(a).length;
            if (!n) return null;
            return (
              <Button key={a} variant={`sm ${ACTION_STYLE[a] ?? ''}`} busy={run.isPending && run.variables?.action === a} onClick={() => startAction(a)}
                title={n < selected.length ? `${n} of the ${selected.length} selected scripts can be changed this way` : undefined}>
                {ACTION_SHORT[a]}{n < selected.length ? ` (${n})` : ''}
              </Button>
            );
          })}
          {manager && <Button variant="sm" icon={<UserPlus aria-hidden />} onClick={() => setDialog({ action: 'assign', ids: selected.map((s) => s.id) })}>Assign to…</Button>}
          {!actions.some((a) => eligible(a).length) && !manager && <span className="muted" style={{ fontSize: 12.5 }}>You can only update scripts assigned to you.</span>}
          <span className="spacer" />
          <Button variant="sm ghost" onClick={() => setSel(new Set())}>Clear</Button>
        </div>
      )}
      <FormError error={run.error ?? assign.error} />

      {!visible.length ? <Empty boxed title="No scripts match this filter" /> : (
        <>
          <div className="table-scroll script-table">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="chk"><input type="checkbox" aria-label="Select all shown" checked={allVisibleSelected} onChange={() => setSel(allVisibleSelected ? new Set() : new Set(visible.map((s) => s.id)))} /></th>
                  <th>#</th><th>Writer</th><th>Status</th><th>Links</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={`clickable${sel.has(s.id) ? ' selected' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('input,a,button')) return; setOpen(s); }}>
                    <td className="chk"><input type="checkbox" aria-label={`Select script ${s.number}`} checked={sel.has(s.id)} onClick={(e) => toggle(s, e.shiftKey)} onChange={() => {}} /></td>
                    <td className="num strong"><button type="button" className="bare-btn" onClick={() => setOpen(s)} aria-label={`Open script ${s.number}`}>{s.number}</button></td>
                    <td className="nowrap">{s.assigneeName ?? <Chip color="pink" icon={<UserPlus aria-hidden />}>Unassigned</Chip>}</td>
                    <td><StatusChip status={s.status} />{s.status === 'delivered' && s.deliveredByName && <div className="sub" style={{ marginTop: 4 }}>by {s.deliveredByName}</div>}</td>
                    <td><ScriptLinks s={s} /></td>
                    <td style={{ maxWidth: 280 }}>{s.openRevision ? <span style={{ color: '#F7B8D8', fontSize: 12.5 }}><RotateCcw size={12} aria-hidden /> {s.openRevision.note}</span> : s.notes ? <span className="sub ellipsis" style={{ display: 'block' }}>{s.notes}</span> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="script-cards">
            {visible.map((s) => (
              <div key={s.id} className={`scard${sel.has(s.id) ? ' selected' : ''}`}>
                <input type="checkbox" style={{ width: 22, height: 22, accentColor: 'var(--salmon)' }} aria-label={`Select script ${s.number}`} checked={sel.has(s.id)} onClick={(e) => toggle(s, e.shiftKey)} onChange={() => {}} />
                <button style={{ border: 0, background: 'none', textAlign: 'left', padding: 0, cursor: 'pointer', minWidth: 0 }} onClick={() => setOpen(s)}>
                  <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}><span className="n">{s.number}</span><span className="ellipsis" style={{ fontWeight: 600 }}>Script {s.number}</span></div>
                  <div className="row-flex s2" style={{ marginTop: 6 }}><StatusChip status={s.status} /><span className="muted" style={{ fontSize: 12 }}>{s.assigneeName ?? 'Unassigned'}</span></div>
                  {s.openRevision && <div style={{ color: '#F7B8D8', fontSize: 12.5, marginTop: 6 }}>{s.openRevision.note}</div>}
                </button>
                <ScriptLinks s={s} />
              </div>
            ))}
          </div>
        </>
      )}

      {dialog?.action === 'submit' && <SendDialog batchId={b.id} batchTitle={b.title} candidates={sendable} preselect={dialog.ids} onClose={() => { setDialog(null); setSel(new Set()); }} />}
      {dialog?.action === 'request_revisions' && <DecisionDialog batchId={b.id} scripts={b.scripts.filter((s) => dialog.ids.includes(s.id))} submissionId={null} mode="revisions" onClose={() => { setDialog(null); setSel(new Set()); }} />}
      {dialog?.action === 'deliver' && <DeliverDialog scripts={b.scripts.filter((s) => dialog.ids.includes(s.id))} submissions={b.submissions} busy={run.isPending} error={run.error}
        also={manager ? alsoDelivered(b.scripts.filter((s) => s.status === 'approved' && !dialog.ids.includes(s.id)), me.id) : null}
        forName={manager ? othersOf(b.scripts.filter((s) => s.status === 'approved'), me.id) : null}
        onClose={() => setDialog(null)} onSubmit={(url, note, ids) => run.mutate({ action: 'deliver', ids, timelinerUrl: url, note })} />}
      {dialog?.action === 'undo_delivery' && <NoteDialog title="Undo delivery?" label="Reason" busy={run.isPending} error={run.error} confirm="Move back to approved" variant="danger"
        scripts={compressRanges(b.scripts.filter((s) => dialog.ids.includes(s.id)).map((s) => s.number))}
        onClose={() => setDialog(null)} onSubmit={(note) => run.mutate({ action: 'undo_delivery', ids: dialog.ids, note })} />}
      {dialog?.action === 'assign' && <AssignDialog count={dialog.ids.length} busy={assign.isPending} error={assign.error} onClose={() => setDialog(null)} onSubmit={(uid) => assign.mutate({ ids: dialog.ids, assigneeId: uid })} />}
      {open && <ScriptDialog s={b.scripts.find((x) => x.id === open.id) ?? open} b={b} onClose={() => setOpen(null)} />}
    </Panel>
  );
}

function ScriptLinks({ s }: { s: Script }) {
  return (
    <span className="linkicons">
      {s.docUrl && <a href={s.docUrl} target="_blank" rel="noopener noreferrer" aria-label={`Script ${s.number} document`} title="Writing document"><FileText /></a>}
      {s.timelinerUrl && <a href={s.timelinerUrl} target="_blank" rel="noopener noreferrer" aria-label={`Script ${s.number} in Timeliner`} title="Timeliner"><Send /></a>}
    </span>
  );
}

/** Send a writer's approved (or in-review) scripts back for revisions: nothing is picked until you pick it. */
function SendBackDialog({ b, writerId, onClose }: { b: BatchDetail; writerId: number; onClose: () => void }) {
  const mine = b.scripts.filter((s) => s.assigneeId === writerId);
  const approved = mine.filter((s) => s.status === 'approved');
  const inReview = mine.filter((s) => s.status === 'ready_for_review');
  const eligible = [...approved, ...inReview].sort((x, y) => x.number - y.number);
  const name = b.writers.find((w) => w.userId === writerId)?.name ?? 'the writer';
  const [range, setRange] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<{ range?: string; note?: string }>({});
  const ids = { r: useFieldId('sb-range'), n: useFieldId('sb-note') };
  const undoable = useUndoDecision();
  const run = useSave((v: { ids: number[]; note: string }) => api<{ reviewId?: number }>(`/api/batches/${b.id}/scripts/action`, {
    body: { action: 'request_revisions', scriptIds: v.ids, note: v.note, timelinerUrl: null, versions: Object.fromEntries(b.scripts.filter((s) => v.ids.includes(s.id)).map((s) => [s.id, s.version])) },
  }), { onSuccess: (o, v) => { undoable(o.reviewId, `Sent ${plural(v.ids.length, 'script')} back to ${name}`); onClose(); } });
  const max = Math.max(...b.scripts.map((s) => s.number), 0);
  const nums = range.trim() ? parseRanges(range, max) : [];
  const picked = nums ? eligible.filter((s) => nums.includes(s.number)) : [];
  const unApproves = picked.filter((s) => s.status === 'approved');
  const submit = () => {
    const e: typeof err = {};
    if (!nums || !picked.length) e.range = `Type the script numbers to send back, from ${compressRanges(eligible.map((s) => s.number))}`;
    if (!note.trim()) e.note = 'Add a note so they know what to change';
    setErr(e);
    if (Object.keys(e).length) return;
    run.mutate({ ids: picked.map((s) => s.id), note: note.trim() });
  };
  const quick = (list: Script[]) => { setRange(compressRanges(list.map((s) => s.number))); setErr((x) => ({ ...x, range: undefined })); };
  return (
    <Dialog open onClose={onClose} title={`Send scripts back to ${name}`} sub="Pick the scripts that need changes. They’ll see your note on My work and get a notification." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" busy={run.isPending} disabled={!picked.length} onClick={submit} icon={<RotateCcw aria-hidden />}>{picked.length ? `Send ${plural(picked.length, 'script')} back` : 'Send back'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={run.error} />
        <div className="field">
          <span className="lbl">Their scripts</span>
          <div className="row-flex s2">
            {inReview.length > 0 && <Button variant="sm" onClick={() => quick(inReview)}>In review: {compressRanges(inReview.map((s) => s.number))}</Button>}
            {approved.length > 0 && <Button variant="sm" onClick={() => quick(approved)}>Approved: {compressRanges(approved.map((s) => s.number))}</Button>}
          </div>
        </div>
        <Field label="Scripts to send back" htmlFor={ids.r} error={err.range} help="Type numbers like 3 or 3–5, or use the buttons above.">
          <input className="input num" value={range} placeholder="e.g. 3" onChange={(e) => { setRange(e.target.value); setErr((x) => ({ ...x, range: undefined })); }} {...inputProps(ids.r, err.range)} />
        </Field>
        {unApproves.length > 0 && <div className="banner yellow"><AlertTriangle aria-hidden /><div className="txt"><b>This un-approves {plural(unApproves.length, 'script')} ({compressRanges(unApproves.map((s) => s.number))})</b><span>They’ll need to be reviewed and approved again before delivery.</span></div></div>}
        <Field label="What to change" htmlFor={ids.n} error={err.note}><textarea className="textarea" data-autofocus value={note} onChange={(e) => setNote(e.target.value)} {...inputProps(ids.n, err.note)} /></Field>
      </form>
    </Dialog>
  );
}

export function NoteDialog({ title, label, required, busy, error, confirm, variant, onClose, onSubmit, scripts }: { title: string; label: string; required?: boolean; busy: boolean; error: ApiError | null; confirm: string; variant: string; onClose: () => void; onSubmit: (note: string | null) => void; scripts: string }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const id = useFieldId('note');
  const submit = () => { if (required && !note.trim()) { setErr('Add a note so the writer knows what to change'); return; } onSubmit(note.trim() || null); };
  return (
    <Dialog open onClose={onClose} title={title} sub={`${/[,–]/.test(scripts) ? 'Scripts' : 'Script'} ${scripts}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={variant} busy={busy} onClick={submit}>{confirm}</Button></div>}>
      <div className="form">
        <FormError error={error} />
        <Field label={label} optional={!required} htmlFor={id} error={err || error?.fields.note}><textarea className="textarea" data-autofocus value={note} onChange={(e) => setNote(e.target.value)} {...inputProps(id, err)} /></Field>
      </div>
    </Dialog>
  );
}

/** What a toast says after an action on scripts: "Approved scripts 1–6". */
const DONE: Record<ScriptAction, string> = {
  start: 'Started writing:', reset: 'Marked not started:', submit: 'Sent for review:', withdraw: 'Took back from review:',
  approve: 'Approved', request_revisions: 'Sent back', deliver: 'Delivered', undo_delivery: 'Moved back to approved:',
};

/** "script 4 (Marcus Webb)": approved scripts a manager's delivery takes along. */
function alsoDelivered(rest: Script[], meId: number): { count: number; detail: string } | null {
  if (!rest.length) return null;
  const by = new Map<string, number[]>();
  for (const s of rest) { const who = s.assigneeId === meId ? 'yours' : s.assigneeName ?? 'unassigned'; by.set(who, [...(by.get(who) ?? []), s.number]); }
  return { count: rest.length, detail: [...by.entries()].map(([who, n]) => `${n.length === 1 ? 'script' : 'scripts'} ${compressRanges(n)} (${who})`).join(', ') };
}
const othersOf = (approved: Script[], meId: number) => [...new Set(approved.filter((s) => s.assigneeId != null && s.assigneeId !== meId).map((s) => s.assigneeName!))].join(', ') || null;

/**
 * Confirming that approved scripts are in Timeliner. Shows which version to paste (the manager's
 * edited one when there is one), lets a writer tick off only the documents they've added, and says
 * plainly when a manager's confirmation takes the rest of the batch's approved scripts along.
 */
export function DeliverDialog({ scripts, submissions = [], also = null, forName, pick = false, busy, error, onClose, onSubmit }: {
  scripts: Script[]; submissions?: Submission[];
  /** approved scripts a manager's confirmation also delivers (the whole batch goes) */
  also?: { count: number; detail: string } | null;
  /** set when a manager confirms for writers: their names */
  forName?: string | null;
  /** let the person untick documents they haven't added yet */
  pick?: boolean;
  busy: boolean; error: ApiError | null; onClose: () => void; onSubmit: (url: string | null, note: string | null, ids: number[]) => void;
}) {
  const { me } = useBoot();
  const sources = useMemo(() => approvedSources(scripts, submissions), [scripts, submissions]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(sources.map((g) => g.key)));
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const a = useFieldId('tl');
  const c = useFieldId('dn');
  const ids = sources.filter((g) => picked.has(g.key)).flatMap((g) => g.ids);
  const nums = compressRanges(scripts.filter((x) => ids.includes(x.id)).map((x) => x.number));
  const total = ids.length + (also?.count ?? 0);
  const submit = () => {
    const link = url.trim() && !/^https?:\/\//i.test(url.trim()) ? `https://${url.trim()}` : url.trim();
    if (link && !/^https?:\/\/\S+\.\S+$/i.test(link)) { setErr('That doesn’t look like a link. Paste the Timeliner address, or leave it empty.'); return; }
    onSubmit(link || null, note || null, ids);
  };
  const toggle = (k: string) => { const x = new Set(picked); x.has(k) ? x.delete(k) : x.add(k); setPicked(x); };
  return (
    <Dialog open onClose={onClose} title="Confirm delivery to Timeliner" sub={`${plural(ids.length, 'script')}${nums ? `: ${nums}` : ''}${also?.count ? ` · plus ${also.count} more` : ''}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="mint pill" busy={busy} disabled={!total} onClick={submit} icon={<CheckCheck aria-hidden />}>Mark {plural(total, 'script')} delivered</Button></div>}>
      <div className="form">
        {sources.length > 0 && (
          <div className="field">
            <span className="lbl">{pick && sources.length > 1 ? 'Tick what’s already in Timeliner' : 'Paste these into Timeliner'}</span>
            <SourceList sources={sources} picked={picked} onToggle={pick && sources.length > 1 ? toggle : undefined} />
          </div>
        )}
        <div className="banner"><Send aria-hidden /><div className="txt"><b>Add the scripts to <Term k="Timeliner" /> first.</b><span>{forName
          ? `This records that ${me.name} confirmed delivery for ${forName}, with today’s time. ${forName} ${forName.includes(',') ? 'are' : 'is'} told.`
          : 'This records that you added them to Timeliner, with today’s time. Managers are told.'}</span></div></div>
        {also && also.count > 0 && <div className="banner yellow"><Send aria-hidden /><div className="txt"><b>Also delivers {also.detail}</b><span>When a manager confirms, every approved script in this batch is marked delivered, whoever wrote it. Scripts that aren’t approved yet stay as they are.</span></div></div>}
        <FormError error={error} />
        <Field label="Timeliner link" optional htmlFor={a} error={err || error?.fields.timelinerUrl}><input className="input" type="url" placeholder="https://" value={url} onChange={(e) => { setUrl(e.target.value); setErr(''); }} {...inputProps(a, err)} /></Field>
        <Field label="Delivery note" optional htmlFor={c}><textarea className="textarea" id={c} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Scheduled for next Tuesday" /></Field>
      </div>
    </Dialog>
  );
}

/**
 * Hand some of a writer's unfinished scripts to someone else, saying what's being handed over
 * (how far along they are, and whether their deadline has already passed).
 */
function MoveScriptsDialog({ b, fromId, onClose }: { b: BatchDetail; fromId: number; onClose: () => void }) {
  const { users, clock } = useBoot();
  const toast = useToast();
  const from = b.writers.find((w) => w.userId === fromId);
  const open = b.scripts.filter((s) => s.assigneeId === fromId && (s.status === 'not_started' || s.status === 'in_progress' || s.status === 'revisions_needed'));
  // the last scripts first: they're the least likely to be under way
  const [range, setRange] = useState(compressRanges(open.filter((s) => s.status === 'not_started').map((s) => s.number)) || compressRanges(open.map((s) => s.number)));
  const [to, setTo] = useState('');
  const [reset, setReset] = useState(false);
  const [err, setErr] = useState('');
  const ids = { r: useFieldId('mvr'), t: useFieldId('mvt') };
  const nums = parseRanges(range, Math.max(0, ...open.map((s) => s.number)));
  const picked = nums ? open.filter((s) => nums.includes(s.number)) : [];
  const writing = picked.filter((s) => s.status === 'in_progress');
  const back = picked.filter((s) => s.status === 'revisions_needed');
  const late = b.draft.overdue && picked.length > 0;
  const target = users.find((u) => u.id === Number(to));
  const move = useSave(async () => {
    await api(`/api/batches/${b.id}/scripts/assign`, { body: { scriptIds: picked.map((s) => s.id), assigneeId: Number(to) } });
    if (reset && writing.length) await api(`/api/batches/${b.id}/scripts/action`, { body: { action: 'reset', scriptIds: writing.map((s) => s.id), note: null } });
  }, { onSuccess: () => { toast(`Moved ${plural(picked.length, 'script')} (${compressRanges(picked.map((s) => s.number))}) to ${target?.name ?? 'them'}`); onClose(); } });
  const submit = () => {
    if (!picked.length) { setErr(`Use ${from?.name.split(' ')[0] ?? 'their'} unfinished scripts: ${compressRanges(open.map((s) => s.number))}`); return; }
    if (!to) { setErr('Choose who gets them'); return; }
    setErr('');
    move.mutate(undefined);
  };
  return (
    <Dialog open onClose={onClose} title={`Move scripts from ${from?.name ?? 'this writer'}`} sub={`${b.title} · ${plural(open.length, 'unfinished script')}: ${compressRanges(open.map((s) => s.number))}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={move.isPending} onClick={submit}>Move {plural(picked.length, 'script')}</Button></div>}>
      <div className="form">
        <FormError error={move.error} />
        <Field label="Which scripts" htmlFor={ids.r} error={err && !picked.length ? err : undefined} help="Unstarted ones are picked first. Approved and delivered scripts stay with who wrote them.">
          <input className="input" id={ids.r} value={range} onChange={(e) => setRange(e.target.value)} />
        </Field>
        <Field label="Give them to" htmlFor={ids.t} error={err && picked.length && !to ? err : undefined}>
          <select className="select" id={ids.t} value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose…</option>
            {users.filter((u) => u.active && canWrite(u.role) && u.id !== fromId).map((u) => <option key={u.id} value={u.id}>{u.name}{u.role !== 'writer' ? ` (${ROLE_LABEL[u.role]})` : ''}</option>)}
          </select>
        </Field>
        {picked.length > 0 && (writing.length > 0 || back.length > 0 || late) && (
          <div className="banner yellow"><AlertTriangle aria-hidden /><div className="txt">
            <b>You’re handing over {[writing.length && `${writing.length} already being written`, back.length && `${back.length} sent back with notes`].filter(Boolean).join(' and ') || plural(picked.length, 'script')}</b>
            <span>{late ? `Drafts were due ${fmtDate(b.draftDue, clock.today)}, so ${target?.name.split(' ')[0] ?? 'they'} will start overdue. Consider new deadlines after moving them.` : 'Their notes and any documents stay on the batch.'}</span>
          </div></div>
        )}
        {writing.length > 0 && <label className="check"><input type="checkbox" checked={reset} onChange={(e) => setReset(e.target.checked)} />Mark the {plural(writing.length, 'script')} being written as not started</label>}
      </div>
    </Dialog>
  );
}

function AssignDialog({ count, busy, error, onClose, onSubmit }: { count: number; busy: boolean; error: ApiError | null; onClose: () => void; onSubmit: (uid: number | null) => void }) {
  const { users } = useBoot();
  const [uid, setUid] = useState<string>('');
  const id = useFieldId('as');
  return (
    <Dialog open onClose={onClose} title={`Assign ${plural(count, 'script')}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={busy} disabled={uid === ''} onClick={() => onSubmit(uid === 'none' ? null : Number(uid))}>Assign</Button></div>}>
      <div className="form">
        <FormError error={error} />
        <Field label="Writer" htmlFor={id} help="Each script has exactly one writer, so moving scripts never double-counts them.">
          <select className="select" id={id} value={uid} onChange={(e) => setUid(e.target.value)}>
            <option value="">Choose…</option>
            {users.filter((u) => u.active && canWrite(u.role)).map((u) => <option key={u.id} value={u.id}>{u.name}{u.role !== 'writer' ? ` (${ROLE_LABEL[u.role]})` : ''}</option>)}
            <option value="none">Unassigned</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function ScriptDialog({ s, b, onClose }: { s: Script; b: BatchDetail; onClose: () => void }) {
  const displayTz = useDisplayTz();
  const { me } = useBoot();
  const toast = useToast();
  const canEdit = isManager(me.role) || s.assigneeId === me.id;
  const [docUrl, setDocUrl] = useState(s.docUrl ?? '');
  const [tl, setTl] = useState(s.timelinerUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  // The version the fields came from: the server refuses the save if the script has changed since.
  // After such a refusal the script refreshes, and the fields show what it is now.
  const [base, setBase] = useState(s);
  const save = useSave(() => api(`/api/scripts/${s.id}`, { method: 'PATCH', body: { version: base.version, docUrl, timelinerUrl: tl, notes } }), { onSuccess: () => { toast(`Script ${s.number} saved`); onClose(); } });
  // Each refusal refreshes the fields once; later updates to the script leave what's being typed alone.
  const applied = useRef<ApiError | null>(null);
  useEffect(() => {
    if (save.error?.code !== 'stale' || applied.current === save.error || s.version === base.version) return;
    applied.current = save.error;
    setBase(s); setDocUrl(s.docUrl ?? ''); setTl(s.timelinerUrl ?? ''); setNotes(s.notes ?? '');
  }, [s, base, save.error]);
  const history = b.revisions.filter((r) => r.scriptId === s.id);
  const ids = { d: useFieldId('d'), l: useFieldId('l'), n: useFieldId('n') };
  const f = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} kind="drawer" title={`Script ${s.number}`} sub={<span className="row-flex s2"><StatusChip status={s.status} /><span>{s.assigneeName ?? 'Unassigned'}</span></span>}
      footer={canEdit ? <div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>Save script</Button></div> : undefined}>
      <div className="form">
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        {s.openRevision && <div className="banner pink"><RotateCcw aria-hidden /><div className="txt"><b>Sent back</b><span>{s.openRevision.note} — {s.openRevision.requestedByName}, {fmtStamp(s.openRevision.requestedAt, displayTz)}</span></div></div>}
        <Field label="Writing document link" optional htmlFor={ids.d} error={f.docUrl}><input className="input" type="url" placeholder="https://docs.google.com/…" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} disabled={!canEdit} {...inputProps(ids.d, f.docUrl)} /></Field>
        <Field label="Timeliner link" optional htmlFor={ids.l} error={f.timelinerUrl}><input className="input" type="url" placeholder="https://" value={tl} onChange={(e) => setTl(e.target.value)} disabled={!canEdit} {...inputProps(ids.l, f.timelinerUrl)} /></Field>
        <Field label="Notes" optional htmlFor={ids.n}><textarea className="textarea" id={ids.n} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit} /></Field>
        {!canEdit && <p className="muted" style={{ fontSize: 13 }}>Only {s.assigneeName ?? 'the assigned writer'} or a manager can edit this script.</p>}
        <dl className="kv">
          <dt>Submitted</dt><dd>{s.submittedAt ? fmtStamp(s.submittedAt, displayTz) : '—'}</dd>
          <dt>Approved</dt><dd>{s.approvedAt ? `${fmtStamp(s.approvedAt, displayTz)} by ${s.approvedByName}` : '—'}</dd>
          <dt>Delivered</dt><dd>{s.deliveredAt ? `${fmtStamp(s.deliveredAt, displayTz)} · confirmed by ${s.deliveredByName}${s.deliveredByName !== s.assigneeName && s.assigneeName ? ` for ${s.assigneeName}` : ''}` : '—'}</dd>
        </dl>
        {history.length > 0 && (
          <div><div className="section-title">Revision history</div>
            <div className="timeline">{history.map((r) => <div key={r.id} className="tl" style={{ ['--c' as string]: r.resolvedAt ? 'var(--mint)' : 'var(--pink)' }}><span className="d" /><div><div className="s">{r.note}</div><div className="w">{r.requestedByName} · {fmtStamp(r.requestedAt, displayTz)}{r.resolvedAt ? ` · resolved (${r.resolution}) ${fmtStamp(r.resolvedAt, displayTz)}` : ' · open'}</div></div></div>)}</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── brief, review notes, deliveries ──────────────────────────────────────

const RES_ICON: Record<ResourceCategory, ReactNode> = { folder: <Link2 />, example: <FileText />, asset: <Upload />, recording: <PlayCircle />, document: <FileText />, other: <Link2 /> };

export function ResourceRow({ r, onRemove, extra }: { r: Resource; onRemove?: () => void; extra?: ReactNode }) {
  const href = r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!;
  return (
    <div className="res">
      <span className="ic" style={{ ['--c' as string]: r.category === 'recording' ? 'var(--salmon)' : 'var(--cyan)' }}>{RES_ICON[r.category]}</span>
      <div style={{ minWidth: 0 }}>
        <div className="t">{r.title}</div>
        <div className="s">{r.attached ? 'From the client’s resources · ' : ''}{RESOURCE_LABEL[r.category]}{r.kind === 'file' ? ` · ${r.fileName} · ${fmtBytes(r.fileSize)}` : ''} · added by {r.createdByName}</div>
      </div>
      <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
        <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">{r.kind === 'file' ? 'Open file' : 'Open'}<ExternalLink aria-hidden /></a>
        {extra}
        {onRemove && <button type="button" className="icon-btn sm" onClick={onRemove} aria-label={`Remove ${r.title}`} title="Remove"><Trash2 size={15} /></button>}
      </div>
    </div>
  );
}

function BriefSection({ b }: { b: BatchDetail }) {
  const { me } = useBoot();
  const toast = useToast();
  const manager = isManager(me.role);
  const remove = useSave((id: number) => api(`/api/resources/${id}`, { method: 'DELETE' }), { onSuccess: () => toast('Resource removed') });
  const batchRes = b.resources.filter((r) => r.batchId === b.id || r.attached);
  const clientRes = b.resources.filter((r) => r.batchId !== b.id && !r.attached);
  const attachedIds = b.resources.filter((r) => r.attached).map((r) => r.id);
  // picking a client resource gives it to this batch's writers (on their My work too)
  const pick = useSave((v: { ids: number[]; on: boolean }) => api(`/api/batches/${b.id}`, { method: 'PATCH', body: { resourceIds: v.on ? [...new Set([...attachedIds, ...v.ids])] : attachedIds.filter((x) => !v.ids.includes(x)) } }),
    { onSuccess: (_o, v) => toast(v.on ? `Added ${plural(v.ids.length, 'resource')} to this batch` : 'Taken off this batch (still in the client’s resources)') });
  return (
    <div className="stack s4">
      {b.brief ? <div><div className="section-title">Batch brief</div><p className="prose">{b.brief}</p></div> : <p className="muted">No batch-specific brief.{isManager(me.role) ? ' Add one with “Edit batch”.' : ''}</p>}
      {b.briefings.map((br) => (
        <div key={br.id} className="brief">
          <div className="row-flex s2"><h4>{br.title}</h4>{br.callDate && <Chip color="plain">Call {fmtDate(br.callDate)}</Chip>}</div>
          <div className="links">
            {br.recordingUrl && <ExtLink href={br.recordingUrl} className="btn sm salmon"><PlayCircle aria-hidden />Recording</ExtLink>}
            {br.documentUrl && <ExtLink href={br.documentUrl} className="btn sm"><FileText aria-hidden />Document</ExtLink>}
            {br.resources.map((r) => <a key={r.id} className="btn sm" href={r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!} target="_blank" rel="noopener noreferrer"><FileText aria-hidden />{r.title}</a>)}
          </div>
          {br.summary && <div><div className="section-title">Summary</div><p className="prose">{br.summary}</p></div>}
          {br.instructions && <div><div className="section-title">Writing instructions</div><p className="prose">{br.instructions}</p></div>}
        </div>
      ))}
      {(b.clientBrandVoice || b.clientGuidance) && (
        <details className="details" open={!b.briefings.length}>
          <summary>Client brand voice & guidance</summary>
          <div className="inner">
            {b.clientBrandVoice && <div><div className="section-title">Brand voice</div><p className="prose">{b.clientBrandVoice}</p></div>}
            {b.clientGuidance && <div><div className="section-title">Writing guidance</div><p className="prose">{b.clientGuidance}</p></div>}
          </div>
        </details>
      )}
      {batchRes.some((r) => r.category === 'recording' && r.url) && (
        <div className="links row-flex s2">{batchRes.filter((r) => r.category === 'recording' && r.url).map((r) => <ExtLink key={r.id} href={r.url!} className="btn sm salmon"><PlayCircle aria-hidden />{r.title}</ExtLink>)}</div>
      )}
      {batchRes.length > 0 && <div className="stack s2"><div className="section-title">This batch</div>{batchRes.map((r) => r.attached
        ? <ResourceRow key={r.id} r={r} extra={manager ? <Button variant="sm ghost" busy={pick.isPending} onClick={() => pick.mutate({ ids: [r.id], on: false })}>Take off batch</Button> : undefined} />
        : <ResourceRow key={r.id} r={r} onRemove={manager || r.createdById === me.id ? () => remove.mutate(r.id) : undefined} />)}</div>}
      {clientRes.length > 0 && (
        <div className="stack s2">
          <div className="row-flex s2" style={{ justifyContent: 'space-between' }}>
            <div className="section-title" style={{ margin: 0 }}>More from {b.clientName}</div>
            {manager && clientRes.length > 1 && <Button variant="sm ghost" busy={pick.isPending} onClick={() => pick.mutate({ ids: clientRes.map((r) => r.id), on: true })}>Add all to batch</Button>}
          </div>
          {manager && <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>Add the ones the writers need, so they get them on My work with this batch.</p>}
          {clientRes.map((r) => <ResourceRow key={r.id} r={r} extra={manager ? <Button variant="sm" icon={<Plus aria-hidden />} busy={pick.isPending} onClick={() => pick.mutate({ ids: [r.id], on: true })}>Add to batch</Button> : undefined} />)}
        </div>
      )}
      {!b.briefings.length && !batchRes.length && !clientRes.length && <Empty boxed title="No briefing materials yet">Attach a briefing call or add links so writers know what applies.</Empty>}
    </div>
  );
}

function ReviewNotes({ b }: { b: BatchDetail }) {
  const displayTz = useDisplayTz();
  // one entry per decision: sending ten scripts back with one note is one note
  const groups = new Map<string, { key: string; note: string; by: string; at: string; open: number[]; done: number[]; resolution: string | null }>();
  for (const r of b.revisions) {
    const key = r.reviewId ? `r${r.reviewId}` : `${r.requestedAt}|${r.note}`;
    const g = groups.get(key) ?? { key, note: r.note, by: r.requestedByName, at: r.requestedAt, open: [], done: [], resolution: r.resolution };
    (r.resolvedAt ? g.done : g.open).push(r.scriptNumber);
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((x, y) => Number(y.open.length > 0) - Number(x.open.length > 0) || y.at.localeCompare(x.at));
  const openCount = list.filter((g) => g.open.length).length;
  return (
    <Panel title="Review notes" count={openCount || undefined} sub={openCount ? 'waiting on the writer' : undefined}>
      {!list.length ? <Empty boxed icon={<Check />} title="No revision requests" /> : (
        <div className="rows">
          {list.slice(0, 12).map((g) => (
            <div key={g.key} className={`item${g.open.length ? ' edge-pink' : ''}`}>
              <div className="body">
                <div className="top">Script{g.open.length + g.done.length > 1 ? 's' : ''} {compressRanges([...g.open, ...g.done])} · {g.by}</div>
                <div className={g.open.length ? 'prose' : 'muted'} style={{ fontSize: 13.5 }}>{g.note}</div>
              </div>
              <div className="side">
                {g.open.length ? <Chip color="pink" icon={<RotateCcw aria-hidden />}>{g.done.length ? `${g.open.length} still open` : 'Open'}</Chip> : <Chip color="mint" icon={<Check aria-hidden />}>{g.resolution === 'approved' ? 'Approved' : 'Resubmitted'}</Chip>}
                <span className="muted nowrap" style={{ fontSize: 12 }}>{fmtStamp(g.at, displayTz)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Deliveries({ b }: { b: BatchDetail }) {
  const displayTz = useDisplayTz();
  return (
    <Panel title="Delivery records" sub="who confirmed each delivery to Timeliner">
      {b.progress.delivered < b.progress.total && b.progress.delivered > 0 && <div className="banner yellow" style={{ marginBottom: 12 }}><AlertTriangle aria-hidden /><div className="txt"><b>Partially delivered: {b.progress.delivered} / {b.progress.total}</b><span>The batch is complete only when every script is recorded as delivered.</span></div></div>}
      {!b.deliveries.length ? <Empty boxed icon={<Send />} title="Nothing delivered yet">Writers confirm delivery here after adding scripts to Timeliner.</Empty> : (
        <div className="rows">
          {b.deliveries.map((d) => (
            <div key={d.id} className="item edge-mint">
              <div className="body">
                <div className="title">{d.scriptNumbers.length ? scriptsLabel(d.scriptNumbers) : 'Scripts —'}</div>
                <div className="meta"><span>{d.forNames.length ? <>Confirmed by <b style={{ color: 'var(--text)' }}>{d.confirmedByName}</b> for {d.forNames.join(', ')}</> : <>Confirmed by the writer, <b style={{ color: 'var(--text)' }}>{d.confirmedByName}</b></>}</span><span>{fmtStamp(d.confirmedAt, displayTz)}</span></div>
                {d.note && <div className="muted" style={{ fontSize: 13 }}>{d.note}</div>}
                {d.scriptNumbers.length === 0 && <div className="muted" style={{ fontSize: 12.5 }}>These scripts were later moved back to approved.</div>}
              </div>
              <div className="side"><Chip color="mint" icon={<CheckCheck aria-hidden />}>{plural(d.scriptNumbers.length, 'script')}</Chip>{d.timelinerUrl && <ExtLink href={d.timelinerUrl} className="btn sm">Timeliner<ExternalLink aria-hidden /></ExtLink>}</div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ── manager dialogs ──────────────────────────────────────────────────────

function EditBatchDialog({ b, open, onClose }: { b: BatchDetail; open: boolean; onClose: () => void }) {
  const { settings, users } = useBoot();
  const toast = useToast();
  const client = useQuery({ queryKey: ['client', b.clientId], queryFn: () => api<ClientDetail>(`/api/clients/${b.clientId}`), enabled: open });
  const [title, setTitle] = useState(b.title);
  const [priority, setPriority] = useState<Priority>(b.priority);
  const [planned, setPlanned] = useState(b.plannedStart ?? '');
  const [shootId, setShootId] = useState<number | ''>(b.shootId ?? '');
  const [draftMode, setDraftMode] = useState(b.draftDueMode);
  const [draft, setDraft] = useState(b.draftDue ?? '');
  const [finalMode, setFinalMode] = useState(b.finalDueMode);
  const [final, setFinal] = useState(b.finalDue ?? '');
  // a new final delivery date moves drafts by the shoot rules' gap, unless you've changed drafts here yourself
  const [draftTouched, setDraftTouched] = useState(false);
  const changeFinal = (v: string) => {
    setFinal(v);
    if (!draftTouched && v) { setDraftMode('manual'); setDraft(draftFromFinal(v as ISODate, settings).date); }
  };
  const [brief, setBrief] = useState(b.brief ?? '');
  const [nextAction, setNextAction] = useState(b.nextAction ?? '');
  const [briefingIds, setBriefingIds] = useState<number[]>(b.briefings.map((x) => x.id));
  // Mounted only while open, so the form starts from the batch as it was then and a refetch never
  // wipes what's being typed; saving compares against that same snapshot.
  const [base] = useState(b);
  const shoot = client.data?.shoots.find((s) => s.id === shootId);
  const auto = shoot ? computeDeadlines(shoot.startDate, settings) : null;
  const save = useSave((body: Record<string, unknown>) => api(`/api/batches/${b.id}`, { method: 'PATCH', body }), { onSuccess: () => { toast('Batch updated'); onClose(); } });
  const f = save.error?.fields ?? {};
  const effDraft = draftMode === 'auto' && auto ? auto.draftDue : draft;
  // capacity-based estimate for the first writer
  const w = b.writers.find((x) => x.userId != null);
  const wu = w ? users.find((u) => u.id === w.userId) : undefined;
  const remaining = w ? w.count - w.draftReady : 0;
  const est = effDraft && wu?.capacityPerDay && remaining > 0 ? suggestStart(effDraft as ISODate, remaining, wu.capacityPerDay, settings.workingDays) : null;
  const ids = { t: useFieldId('et'), p: useFieldId('ep'), ps: useFieldId('eps'), s: useFieldId('es'), d: useFieldId('ed'), f: useFieldId('ef'), br: useFieldId('ebr'), na: useFieldId('ena') };
  // Only what was changed here is sent, so saving can't put back something another manager changed
  // meanwhile. Dates go too when the shoot changes (automatic dates follow it) and while the batch's
  // deadlines need a check (saving the form is then confirming the dates on screen).
  const submit = () => {
    const draftDue = { mode: shootId ? draftMode : 'manual', date: draftMode === 'manual' || !shootId ? draft || null : null };
    const finalDue = { mode: shootId ? finalMode : 'manual', date: finalMode === 'manual' || !shootId ? final || null : null };
    const dateChanged = (d: { mode: string; date: string | null }, mode: string, date: string | null) => d.mode !== mode || (d.mode === 'manual' && d.date !== date);
    const shootChanged = (shootId || null) !== base.shootId;
    const body: Record<string, unknown> = {};
    if (title !== base.title) body.title = title;
    if (priority !== base.priority) body.priority = priority;
    if ((planned || null) !== base.plannedStart) body.plannedStart = planned || null;
    if (shootChanged) body.shootId = shootId || null;
    if ((brief || null) !== (base.brief ?? null)) body.brief = brief || null;
    if ((nextAction || null) !== base.nextAction) body.nextAction = nextAction || null;
    if (briefingIds.join() !== base.briefings.map((x) => x.id).join()) body.briefingIds = briefingIds;
    if (shootChanged || base.needsDateReview || dateChanged(draftDue, base.draftDueMode, base.draftDue)) body.draftDue = draftDue;
    if (shootChanged || base.needsDateReview || dateChanged(finalDue, base.finalDueMode, base.finalDue)) body.finalDue = finalDue;
    save.mutate(body);
  };
  return (
    <Dialog open={open} onClose={onClose} kind="drawer" title="Edit batch" sub={b.clientName}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={submit}>Save changes</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        <Field label="Title" htmlFor={ids.t} error={f.title}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} {...inputProps(ids.t, f.title)} /></Field>
        <div className="form-grid">
          <Field label="Priority" htmlFor={ids.p}><select className="select" id={ids.p} value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}</select></Field>
          <Field label="Linked shoot" htmlFor={ids.s} error={f.shootId}>
            <select className="select" id={ids.s} value={shootId} onChange={(e) => { const v = e.target.value ? Number(e.target.value) : ''; setShootId(v); if (!v) { setDraftMode('manual'); setFinalMode('manual'); } }}>
              <option value="">No shoot</option>
              {client.data?.shoots.map((s) => <option key={s.id} value={s.id}>{s.title ? `${s.title} · ` : ''}{fmtRange(s.startDate, s.endDate)}</option>)}
            </select>
          </Field>
        </div>
        <DateModeField label="Drafts due" id={ids.d} hasShoot={!!shootId} mode={draftMode} setMode={(m) => { setDraftTouched(true); setDraftMode(m); }} date={draft} setDate={(v) => { setDraftTouched(true); setDraft(v); }} auto={auto?.draftDue} rule={auto?.draftRule} error={f.draftDue}
          note={!draftTouched && final && final !== (b.finalDue ?? '') ? `Moved with final delivery: ${draftFromFinal(final as ISODate, settings).rule}.` : undefined} />
        <DateModeField label="Final delivery to Timeliner" id={ids.f} hasShoot={!!shootId} mode={finalMode} setMode={setFinalMode} date={final} setDate={changeFinal} auto={auto?.finalDue} rule={auto?.finalRule} error={f.finalDue} />
        <Field label="Planned writing start" optional htmlFor={ids.ps} error={f.plannedStart}
          help={est ? `Estimate: ${fmtDate(est)} for ${wu!.name}’s ${remaining} remaining scripts at ${wu!.capacityPerDay}/working day. Only an estimate.` : 'Set writer capacity in Settings → Team to get an estimate.'}>
          <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}><input className="input" type="date" value={planned} onChange={(e) => setPlanned(e.target.value)} {...inputProps(ids.ps, f.plannedStart)} />{est && <Button variant="sm" onClick={() => setPlanned(est)}>Use estimate</Button>}</div>
        </Field>
        <Field label="Next action" optional htmlFor={ids.na}><input className="input" id={ids.na} value={nextAction} onChange={(e) => setNextAction(e.target.value)} /></Field>
        <Field label="Batch brief" optional htmlFor={ids.br}><textarea className="textarea" id={ids.br} value={brief} onChange={(e) => setBrief(e.target.value)} /></Field>
        <div className="field"><span className="lbl">Briefings that apply</span>
          {!client.data ? <span className="muted">Loading…</span> : !client.data.briefings.length ? <span className="muted" style={{ fontSize: 13 }}>No briefings for this client yet.</span> : client.data.briefings.map((x) => (
            <label key={x.id} className="check"><input type="checkbox" checked={briefingIds.includes(x.id)} onChange={(e) => setBriefingIds(e.target.checked ? [...briefingIds, x.id] : briefingIds.filter((y) => y !== x.id))} />{x.title}{x.callDate && <span className="muted"> · {fmtDate(x.callDate)}</span>}</label>
          ))}
        </div>
      </form>
    </Dialog>
  );
}

function DateModeField({ label, id, hasShoot, mode, setMode, date, setDate, auto, rule, error, note }: { label: string; id: string; hasShoot: boolean; mode: 'auto' | 'manual'; setMode: (m: 'auto' | 'manual') => void; date: string; setDate: (d: string) => void; auto?: string; rule?: string; error?: string; note?: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} help={note ?? (hasShoot && mode === 'auto' && auto ? `${fmtLong(auto)} · ${rule}` : hasShoot && mode === 'manual' ? 'Manual override — kept if the shoot moves, and flagged for review.' : undefined)}>
      {hasShoot && (
        <Seg role="group" aria-label={`${label} mode`} style={{ marginBottom: 6, alignSelf: 'flex-start' }}>
          <button type="button" aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>Automatic</button>
          <button type="button" aria-pressed={mode === 'manual'} onClick={() => { setMode('manual'); if (!date && auto) setDate(auto); }}>Manual date</button>
        </Seg>
      )}
      {(!hasShoot || mode === 'manual') && <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} {...inputProps(id, error)} />}
    </Field>
  );
}

function TargetDialog({ b, onClose }: { b: BatchDetail; onClose: () => void }) {
  const { users } = useBoot();
  const toast = useToast();
  const [count, setCount] = useState<number | ''>(b.progress.total);
  const [debounced, setDebounced] = useState<number>(b.progress.total);
  const [remove, setRemove] = useState<number[]>([]);
  const [assignee, setAssignee] = useState<string>('');
  useEffect(() => { const t = setTimeout(() => { if (count && count > 0) setDebounced(Number(count)); }, 250); return () => clearTimeout(t); }, [count]);
  type Preview = { current: number; target: number; add: number; restore: number[]; removable: Script[]; defaultRemove: number[]; protectedCount: number; needed?: number; possible?: boolean };
  const pv = useQuery({ queryKey: ['target', b.id, debounced], queryFn: () => api<Preview>(`/api/batches/${b.id}/target-preview?count=${debounced}`) });
  useEffect(() => { if (pv.data) setRemove(pv.data.defaultRemove); }, [pv.data]);
  const save = useSave(() => api(`/api/batches/${b.id}/target`, { body: { targetCount: debounced, removeScriptIds: remove, assigneeId: assignee ? Number(assignee) : null } }), { onSuccess: () => { toast(`Script count is now ${debounced}`); onClose(); } });
  const p = pv.data;
  const shrinking = p && p.target < p.current;
  const ok = p && p.target !== p.current && (!shrinking || (p.possible && remove.length === p.needed));
  return (
    <Dialog open onClose={onClose} title="Change script count" sub={`Currently ${plural(b.progress.total, 'script')}. Completed work and history are always kept.`}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" disabled={!ok} busy={save.isPending} onClick={() => save.mutate(undefined)}>Apply</Button></div>}>
      <div className="form">
        <FormError error={save.error} />
        <Field label="Scripts in this batch" htmlFor="tgt"><input id="tgt" className="input num" type="number" min={1} max={500} style={{ maxWidth: 160 }} value={count} onChange={(e) => setCount(e.target.value === '' ? '' : Number(e.target.value))} /></Field>
        {pv.isFetching && <span className="muted">Checking…</span>}
        {p && p.target > p.current && (
          <>
            <p>Adds {plural(p.add, 'script')}{p.restore.length ? ` (restoring removed scripts ${compressRanges(p.restore)} first)` : ''}.</p>
            <Field label="Assign the new scripts to" optional htmlFor="tgt-a"><select id="tgt-a" className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Leave unassigned</option>{users.filter((u) => u.active && canWrite(u.role)).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
          </>
        )}
        {p && shrinking && (
          <>
            {!p.possible ? (
              <div className="banner red"><AlertTriangle aria-hidden /><div className="txt"><b>Can’t go down to {p.target}</b><span>{plural(p.protectedCount, 'script has', 'scripts have')} been submitted, approved or delivered and will be kept. The lowest possible count is {p.current - p.removable.length}.</span></div></div>
            ) : (
              <>
                <p>Choose exactly <b>{p.needed}</b> to remove ({remove.length} chosen). Only not-started or in-progress scripts can be removed; they stay in the history and come back first if you raise the count again.</p>
                <div className="rows" style={{ maxHeight: 300, overflowY: 'auto' }}>
                  {p.removable.map((s) => (
                    <label key={s.id} className="item" style={{ cursor: 'pointer' }}>
                      <span className="row-flex s2" style={{ flexWrap: 'nowrap' }}><input type="checkbox" checked={remove.includes(s.id)} onChange={(e) => setRemove(e.target.checked ? [...remove, s.id] : remove.filter((x) => x !== s.id))} style={{ width: 18, height: 18, accentColor: 'var(--salmon)' }} /><b>Script {s.number}</b></span>
                      <span className="side"><StatusChip status={s.status} /><span className="muted" style={{ fontSize: 12 }}>{s.assigneeName ?? 'Unassigned'}</span></span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/**
 * Change a shoot's dates. Shows exactly what moves with it (deadlines, the
 * planned writing start, batch names) before anything changes. Opened from
 * the batch page, the client page, or by dragging a shoot on the calendar.
 */
export function RescheduleDialog({ shootId, start, end, initialStart, initialEnd, onClose }: { shootId: number; start: string; end: string | null; initialStart?: string; initialEnd?: string | null; onClose: () => void }) {
  const toast = useToast();
  const [s, setS] = useState(initialStart ?? start);
  const [e, setE] = useState((initialStart ? initialEnd : end) ?? '');
  const [shiftManual, setShiftManual] = useState(false);
  const [autoShifted, setAutoShifted] = useState(false);
  const [preview, setPreview] = useState<ReschedulePreview | null>(null);
  // A preview changes nothing, so it doesn't refresh the rest of the page (useSave would). Its result
  // is taken in mutate's own onSuccess, which only runs for the latest request: an older preview
  // arriving late can't replace a newer one.
  type Dates = { s: string; e: string; shiftManual: boolean };
  const load = useMutation<ReschedulePreview, ApiError, Dates>({
    mutationFn: (v) => api<ReschedulePreview>(`/api/shoots/${shootId}/reschedule-preview`, { body: { startDate: v.s, endDate: v.e || null, shiftManual: v.shiftManual } }),
  });
  const loadPreview = (v: Dates): void => load.mutate(v, {
    onSuccess: (p) => {
      setPreview(p);
      // keeping a manual date would put drafts after final delivery: move it too, unless they untick it
      if (p.outOfOrder.length && p.manualCount > 0 && !v.shiftManual && !autoShifted) { setAutoShifted(true); setShiftManual(true); loadPreview({ ...v, shiftManual: true }); }
    },
  });
  const apply = useSave(() => api(`/api/shoots/${shootId}/reschedule`, { body: { startDate: s, endDate: e || null, shiftManual } }), { onSuccess: () => { toast(`Shoot moved to ${fmtRange(s, e || null)} — everything updated`); onClose(); } });
  // dragged on the calendar: show what will change straight away
  useEffect(() => { if (initialStart) loadPreview({ s, e, shiftManual }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const reload = (next: Partial<{ s: string; e: string; shiftManual: boolean }>) => {
    const v = { s, e, shiftManual, ...next };
    if (preview && v.s && isISODate(v.s)) loadPreview(v);
  };
  const f = load.error?.fields ?? {};
  const unchanged = s === start && (e || null) === (end ?? null);
  const moved = preview?.days ? `${Math.abs(preview.days)} day${Math.abs(preview.days) === 1 ? '' : 's'} ${preview.days > 0 ? 'later' : 'earlier'}` : null;
  return (
    <Dialog open onClose={onClose} title="Change shoot dates" sub={`Currently ${fmtRange(start, end)}${preview && !unchanged ? ` → ${fmtRange(preview.newStart, preview.newEnd)}${moved ? ` (${moved})` : ''}` : ''}`} size="wide"
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {!preview ? <Button variant="salmon pill" busy={load.isPending} disabled={!s} onClick={() => loadPreview({ s, e, shiftManual })}>Preview changes</Button>
          : <Button variant="primary pill" busy={apply.isPending} disabled={unchanged || load.isPending} onClick={() => apply.mutate(undefined)}>Move shoot & update everything</Button>}
      </div>}>
      <div className="form">
        <FormError error={(load.error && !Object.keys(f).length ? load.error : null) ?? apply.error} />
        <div className="form-grid">
          <Field label="New start date" htmlFor="rs-s" error={f.startDate} help={end ? 'The end date moves with it, keeping the shoot the same length.' : undefined}>
            <input id="rs-s" className="input" type="date" value={s} onChange={(x) => {
              const v = x.target.value;
              const nextE = v && e && s && isISODate(v) ? addDays(v, diffDays(e, s)) : e;
              setS(v); setE(nextE); reload({ s: v, e: nextE });
            }} />
          </Field>
          <Field label="New end date" optional htmlFor="rs-e" error={f.endDate}><input id="rs-e" className="input" type="date" value={e} min={s} onChange={(x) => { setE(x.target.value); reload({ e: x.target.value }); }} /></Field>
        </div>
        {preview && preview.manualCount > 0 && (
          <label className="check" style={{ alignSelf: 'flex-start' }}>
            <input type="checkbox" checked={shiftManual} onChange={(x) => { setShiftManual(x.target.checked); reload({ shiftManual: x.target.checked }); }} />
            Move {preview.manualCount === 1 ? 'the manually set deadline' : `the ${preview.manualCount} manually set deadlines`} by the same number of days too
          </label>
        )}
        {preview && autoShifted && shiftManual && !preview.outOfOrder.length && (
          <p className="muted" style={{ fontSize: 13 }}>Ticked for you: keeping the manual date would have put drafts after final delivery.</p>
        )}
        {preview && preview.outOfOrder.length > 0 && (
          <div className="banner red" role="alert"><AlertTriangle aria-hidden /><div className="txt">
            <b>Drafts would be due after final delivery</b>
            <span>{preview.outOfOrder.map((o) => `${o.batchTitle}: drafts ${fmtDate(o.draftDue)}, final ${fmtDate(o.finalDue)}`).join(' · ')}. {preview.manualCount ? 'Tick “Move the manually set deadline” above, or fix the dates on the batch after moving.' : 'Fix the dates on the batch after moving.'}</span>
          </div></div>
        )}
        {preview && (
          <div style={{ opacity: load.isPending ? 0.55 : 1, transition: 'opacity 200ms ease' }}>
            <div className="section-title">What will change</div>
            {unchanged ? <p className="muted">Those are the current dates, so nothing changes.</p> : (
              <div className="table-scroll">
                <table className="tbl">
                  <thead><tr><th>Batch</th><th>What</th><th>Now</th><th>After</th><th>How</th></tr></thead>
                  <tbody>
                    {preview.changes.map((c, i) => (
                      <tr key={i}>
                        <td className="strong">{c.batchTitle}</td>
                        <td>{c.field === 'draftDue' ? 'Drafts due' : 'Final delivery'}</td>
                        <td className="nowrap">{fmtDate(c.from)}</td>
                        <td className="nowrap"><b>{fmtDate(c.to)}</b>{c.inPast && <div><Chip color="red" icon={<AlertTriangle aria-hidden />}>Already past</Chip></div>}</td>
                        <td>{c.kept ? <Chip color="yellow">Manual — kept, flagged for review</Chip> : c.mode === 'manual' ? <Chip color="salmon">Manual — moved too</Chip> : <Chip color="cyan">Recalculated</Chip>}</td>
                      </tr>
                    ))}
                    {preview.plannedStarts.map((x) => (
                      <tr key={`p${x.batchId}`}><td className="strong">{x.batchTitle}</td><td>Writing start</td><td className="nowrap">{fmtDate(x.from)}</td><td className="nowrap"><b>{fmtDate(x.to)}</b></td><td><Chip color="cyan">Moves with the shoot</Chip></td></tr>
                    ))}
                    {preview.renames.map((x) => (
                      <tr key={`r${x.batchId}`}><td className="strong">{x.from}</td><td>Batch name</td><td>{x.from}</td><td><b>{x.to}</b></td><td><Chip color="cyan">Named after the shoot</Chip></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="muted" style={{ fontSize: 13, marginTop: 10 }}>{preview.affectedWriters.length ? `${preview.affectedWriters.join(', ')} will be notified.` : 'No writers to notify.'} The calendar, My work and every batch update straight away, and the change is recorded in each batch’s history.</p>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function BlockerDialog({ b, open, onClose }: { b: BatchDetail; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const save = useSave(() => api(`/api/batches/${b.id}/blocker`, { body: { blocked: true, note } }), { onSuccess: () => { toast('Blocker flagged. Managers have been notified.'); setNote(''); onClose(); } });
  const id = useFieldId('blk');
  return (
    <Dialog open={open} onClose={onClose} title="Flag a blocker" sub="Blocked is tracked separately from the workflow stage." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="danger" busy={save.isPending} onClick={() => { if (!note.trim()) { setErr('Say what is blocking the work'); return; } setErr(''); save.mutate(undefined); }}>Flag blocker</Button></div>}>
      <div className="form">
        <FormError error={save.error} />
        <Field label="What’s blocking the work?" htmlFor={id} error={err || save.error?.fields.note}><textarea className="textarea" data-autofocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Waiting on the client’s product claims sheet" {...inputProps(id, err)} /></Field>
      </div>
    </Dialog>
  );
}

export function ResourceDialog({ open, onClose, clientId, batchId, briefingId }: { open: boolean; onClose: () => void; clientId: number; batchId?: number; briefingId?: number }) {
  const toast = useToast();
  const { uploadLimitMb } = useBoot();
  const [mode, setMode] = useState<'link' | 'file'>('link');
  const [title, setTitle] = useState('');
  const [url, setUrl] = useState('');
  const [category, setCategory] = useState<ResourceCategory>('folder');
  const [file, setFile] = useState<File | null>(null);
  const [local, setLocal] = useState<Record<string, string>>({});
  const reset = () => { setTitle(''); setUrl(''); setFile(null); setLocal({}); };
  const save = useSave(async () => {
    if (mode === 'link') return api('/api/resources', { body: { clientId, batchId: batchId ?? null, briefingId: briefingId ?? null, category, title, url } });
    const form = new FormData();
    form.set('clientId', String(clientId));
    if (batchId) form.set('batchId', String(batchId));
    if (briefingId) form.set('briefingId', String(briefingId));
    form.set('category', category);
    form.set('title', title || file!.name);
    form.set('file', file!);
    return api('/api/resources/upload', { form });
  }, { onSuccess: () => { toast(mode === 'link' ? 'Link added' : 'File uploaded'); reset(); onClose(); } });
  const f = { ...local, ...(save.error?.fields ?? {}) };
  const ids = { t: useFieldId('rt'), u: useFieldId('ru'), c: useFieldId('rc'), f: useFieldId('rf') };
  const submit = () => {
    const errs: Record<string, string> = {};
    if (mode === 'link' && !/^https?:\/\/\S+$/i.test(url)) errs.url = 'Use a full link starting with https://';
    if (mode === 'link' && !title.trim()) errs.title = 'Give it a title';
    if (mode === 'file' && !file) errs.file = 'Choose a file to upload';
    setLocal(errs);
    if (!Object.keys(errs).length) save.mutate(undefined);
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add a resource" sub="Resources stay linked to this record and show up in Resources search." size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={submit}>{mode === 'link' ? 'Add link' : 'Upload'}</Button></div>}>
      <div className="form">
        <Seg role="group" aria-label="Resource type" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={mode === 'link'} onClick={() => setMode('link')}><Link2 aria-hidden />Link</button>
          <button aria-pressed={mode === 'file'} onClick={() => setMode('file')}><Upload aria-hidden />File</button>
        </Seg>
        <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
        <Field label="Title" optional={mode === 'file'} htmlFor={ids.t} error={f.title}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} {...inputProps(ids.t, f.title)} /></Field>
        {mode === 'link'
          ? <Field label="Link" htmlFor={ids.u} error={f.url}><input className="input" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} {...inputProps(ids.u, f.url)} /></Field>
          : <Field label="File" htmlFor={ids.f} error={f.file} help={`Up to ${uploadLimitMb} MB. Only signed-in team members can open it.`}><input className="input" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} {...inputProps(ids.f, f.file)} /></Field>}
        <Field label="Type" htmlFor={ids.c}><select className="select" id={ids.c} value={category} onChange={(e) => setCategory(e.target.value as ResourceCategory)}>{RESOURCE_CATEGORIES.map((c) => <option key={c} value={c}>{RESOURCE_LABEL[c]}</option>)}</select></Field>
      </div>
    </Dialog>
  );
}

