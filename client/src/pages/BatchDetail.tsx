// Batch page: brief, assignments, the script checklist (the source of truth),
// progress, deadlines, review notes, delivery records and activity history.

import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Archive, ArchiveRestore, Ban, CalendarClock, Camera, Check, CheckCheck, ExternalLink, FileText,
  Flag, Link2, OctagonAlert, Pencil, PlayCircle, RotateCcw, Send, SlidersHorizontal, Trash2, Upload, UserPlus,
} from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import type { BatchDetail, ClientDetail, Priority, ReschedulePreview, Resource, ResourceCategory, Script } from '../../../shared/types';
import { PRIORITIES, PRIORITY_LABEL, RESOURCE_CATEGORIES, RESOURCE_LABEL } from '../../../shared/types';
import { ACTION_RULES, checkAction, compressRanges, parseRanges, STATUS_LABEL, type ScriptAction, type ScriptStatus } from '../../../shared/workflow';
import { addDays, computeDeadlines, diffDays, isISODate, suggestStart, type ISODate } from '../../../shared/dates';
import { fmtBytes, fmtCutoff, fmtDate, fmtLong, fmtRange, fmtStamp, fmtTimeZoneAbbr, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import {
  Avatar, BatchProgress, Button, Chip, Dialog, DueChip, Empty, ErrorState, ExtLink, Field, FormError, inputProps, Loading, Panel,
  Ring, ringColor, StageChip, StatusChip, useFieldId, useToast,
} from '../components/ui';

export function BatchPage() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['batch', Number(id)], queryFn: () => api<BatchDetail>(`/api/batches/${id}`) });
  if (q.isLoading) return <><div style={{ height: 90 }} /><Loading height={520} /></>;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  return <BatchView b={q.data!} />;
}

function BatchView({ b }: { b: BatchDetail }) {
  const { me, clock, settings } = useBoot();
  const manager = me.role === 'manager';
  const toast = useToast();
  const [edit, setEdit] = useState(false);
  const [target, setTarget] = useState(false);
  const [resched, setResched] = useState(false);
  const [blocker, setBlocker] = useState(false);
  const [addRes, setAddRes] = useState(false);
  const archive = useSave((archived: boolean) => api(`/api/batches/${b.id}/archive`, { body: { archived } }), { onSuccess: (_o, a) => toast(a ? 'Batch archived' : 'Batch restored') });
  const reviewed = useSave(() => api(`/api/batches/${b.id}/dates-reviewed`, { body: {} }), { onSuccess: () => toast('Deadlines confirmed') });
  const unblock = useSave(() => api(`/api/batches/${b.id}/blocker`, { body: { blocked: false, note: null } }), { onSuccess: () => toast('Blocker cleared') });
  const canBlock = manager || b.isAssigned;
  const tz = fmtTimeZoneAbbr(settings.timezone);

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
            <div className="txt"><b>Blocked: {b.blockerNote}</b><span>Flagged by {b.blockedByName ?? 'someone'} · {fmtStamp(b.blockedAt, settings.timezone)}. Workflow stage is still tracked separately.</span></div>
            {canBlock && <Button variant="sm" busy={unblock.isPending} onClick={() => unblock.mutate(undefined)}>Clear blocker</Button>}
          </div>
        )}
        {b.needsDateReview && (
          <div className="banner yellow" role="status">
            <CalendarClock aria-hidden />
            <div className="txt"><b>Deadlines need a check</b><span>{b.dateReviewNote}</span></div>
            {manager && <><Button variant="sm" onClick={() => setEdit(true)}>Change dates</Button><Button variant="sm primary" busy={reviewed.isPending} onClick={() => reviewed.mutate(undefined)}>Dates are fine</Button></>}
          </div>
        )}
        {b.progress.unassigned > 0 && (
          <div className="banner pink"><UserPlus aria-hidden /><div className="txt"><b>{plural(b.progress.unassigned, 'script')} unassigned</b><span>{manager ? 'Select them in the checklist below and use “Assign to…”.' : 'A manager needs to assign these.'}</span></div></div>
        )}

        <div className="grid g-main-side">
          <Panel title="Progress" tools={manager ? <Button variant="sm ghost" icon={<SlidersHorizontal aria-hidden />} onClick={() => setTarget(true)}>Change script count</Button> : undefined}>
            <div className="row-flex" style={{ alignItems: 'center', gap: 22, flexWrap: 'nowrap', marginBottom: 18 }}>
              <Ring pct={b.progress.pctDraft} size={104} stroke={9} color={ringColor(b.progress)} large><span>{b.progress.pctDraft}%<small>drafts</small></span></Ring>
              <div style={{ flex: 1, minWidth: 0 }}><BatchProgress p={b.progress} /></div>
            </div>
            <div className="triple">
              <div style={{ ['--c' as string]: 'var(--lavender)' }}><span className="k"><i />Draft-ready</span><span className="v">{b.progress.draftReady}<small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctDraft}% · {b.progress.inReview} waiting for review</span></div>
              <div style={{ ['--c' as string]: 'color-mix(in srgb, var(--mint) 60%, var(--track))' }}><span className="k"><i />Approved</span><span className="v">{b.progress.approved}<small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctApproved}% · {b.progress.awaitingDelivery} to deliver</span></div>
              <div style={{ ['--c' as string]: 'var(--mint)' }}><span className="k"><i />Delivered</span><span className="v">{b.progress.delivered}<small>/ {b.progress.total}</small></span><span className="p">{b.progress.pctDelivered}% · writer-confirmed</span></div>
            </div>
            {b.progress.revisions > 0 && <div className="banner pink" style={{ marginTop: 12 }}><RotateCcw aria-hidden /><div className="txt"><b>{plural(b.progress.revisions, 'script')} returned for revisions</b><span>These don’t count as draft-ready until they’re resubmitted.</span></div></div>}
            <div className="section-title" style={{ marginTop: 22 }}>Assignments</div>
            <div className="rows">
              {b.writers.map((w) => (
                <div key={String(w.userId)} className={`item ${w.userId == null ? 'edge-pink' : ''}`}>
                  <div className="body">
                    <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>{w.userId != null && <Avatar name={w.name} id={w.userId} small />}<span className="title">{w.name}</span></div>
                    <div className="meta">Scripts {w.ranges} · {plural(w.count, 'script')}</div>
                  </div>
                  <div className="side"><span className="when num">{w.draftReady} / {w.count} drafts ready</span><span className="muted num" style={{ fontSize: 12 }}>{w.delivered} delivered</span></div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Deadlines" sub={`due by ${fmtCutoff(settings.cutoff)} ${tz}`}>
            <div className="deadline-list">
              <div className="deadline" style={{ ['--c' as string]: 'var(--salmon)' }}>
                <span className="ic"><Camera /></span>
                <div><div className="k">Shoot</div><div className="v">{b.shootStart ? fmtRange(b.shootStart, b.shootEnd) : 'No shoot'}</div>{b.shootStart && <div className="rule">Deadlines count back from {fmtDate(b.shootStart)}</div>}</div>
                <div className="right">{manager && b.shootId && <Button variant="sm" onClick={() => setResched(true)}>Move shoot</Button>}</div>
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
                <div><div className="k">Final delivery to Timeliner</div><div className="v">{b.finalDue ? fmtLong(b.finalDue) : 'Not set'}</div><div className="rule">{b.finalRule ?? (b.finalDue ? (b.shootId ? 'Manual override' : 'Entered manually') : '')}</div></div>
                <div className="right"><DueChip m={b.final} today={clock.today} prefix={false} />{b.finalDueMode === 'manual' && b.shootId && <Chip color="yellow">Override</Chip>}</div>
              </div>
            </div>
            {b.nextAction && <><div className="section-title" style={{ marginTop: 20 }}>Next action</div><p className="prose">{b.nextAction}</p></>}
            {manager && (
              <div className="row-flex s2" style={{ marginTop: 18 }}>
                {b.archivedAt
                  ? <Button variant="sm" icon={<ArchiveRestore aria-hidden />} busy={archive.isPending} onClick={() => archive.mutate(false)}>Restore batch</Button>
                  : <Button variant="sm ghost" icon={<Archive aria-hidden />} busy={archive.isPending} onClick={() => { if (b.stage === 'delivered' || window.confirm(`Archive “${b.title}”? It still has ${b.progress.total - b.progress.delivered} undelivered scripts. Nothing is deleted.`)) archive.mutate(true); }}>Archive</Button>}
              </div>
            )}
          </Panel>
        </div>

        <ScriptChecklist b={b} />

        <div className="grid g-2">
          <Panel title="Brief & resources" tools={(manager || b.isAssigned) ? <Button variant="sm" icon={<Link2 aria-hidden />} onClick={() => setAddRes(true)}>Add resource</Button> : undefined}>
            <BriefSection b={b} />
          </Panel>
          <div className="stack" style={{ gap: 'var(--gap)' }}>
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
                  <div><div className="s">{a.summary}</div><div className="w">{a.actorName ?? 'System'} · {fmtStamp(a.createdAt, settings.timezone)}</div></div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {manager && <EditBatchDialog b={b} open={edit} onClose={() => setEdit(false)} />}
      {manager && target && <TargetDialog b={b} onClose={() => setTarget(false)} />}
      {manager && resched && b.shootId && <RescheduleDialog shootId={b.shootId} start={b.shootStart!} end={b.shootEnd} onClose={() => setResched(false)} />}
      <BlockerDialog b={b} open={blocker} onClose={() => setBlocker(false)} />
      <ResourceDialog open={addRes} onClose={() => setAddRes(false)} clientId={b.clientId} batchId={b.id} />
    </>
  );
}

// ── script checklist ─────────────────────────────────────────────────────

const WRITER_ACTIONS: ScriptAction[] = ['start', 'submit', 'withdraw', 'deliver', 'reset'];
const MANAGER_ACTIONS: ScriptAction[] = ['start', 'submit', 'approve', 'request_revisions', 'deliver', 'withdraw', 'reset', 'undo_delivery'];
const ACTION_STYLE: Partial<Record<ScriptAction, string>> = { submit: 'review', approve: 'mint', request_revisions: 'danger', deliver: 'primary', undo_delivery: 'ghost', reset: 'ghost', withdraw: 'ghost' };
const ACTION_SHORT: Record<ScriptAction, string> = { start: 'Mark in progress', reset: 'Mark not started', submit: 'Submit for review', withdraw: 'Withdraw', approve: 'Approve', request_revisions: 'Request revisions', deliver: 'Mark delivered to Timeliner', undo_delivery: 'Undo delivery' };

function ScriptChecklist({ b }: { b: BatchDetail }) {
  const { me, users } = useBoot();
  const manager = me.role === 'manager';
  const toast = useToast();
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [anchor, setAnchor] = useState<number | null>(null);
  const [range, setRange] = useState('');
  const [rangeErr, setRangeErr] = useState('');
  const [filter, setFilter] = useState<'all' | 'mine' | ScriptStatus | 'unassigned'>(manager ? 'all' : b.isAssigned ? 'mine' : 'all');
  const [dialog, setDialog] = useState<null | { action: ScriptAction | 'assign'; ids: number[] }>(null);
  const [open, setOpen] = useState<Script | null>(null);
  const actions = manager ? MANAGER_ACTIONS : WRITER_ACTIONS;

  useEffect(() => { if (window.location.hash === '#scripts') document.getElementById('scripts')?.scrollIntoView(); }, []);
  // drop selections that no longer exist
  useEffect(() => { setSel((s) => new Set([...s].filter((id) => b.scripts.some((x) => x.id === id)))); }, [b.scripts]);

  const visible = b.scripts.filter((s) =>
    filter === 'all' ? true : filter === 'mine' ? s.assigneeId === me.id : filter === 'unassigned' ? s.assigneeId == null : s.status === filter);
  const selected = b.scripts.filter((s) => sel.has(s.id));
  const eligible = (a: ScriptAction) => selected.filter((s) => !checkAction(a, s, me));

  const run = useSave((v: { action: ScriptAction; ids: number[]; note?: string | null; timelinerUrl?: string | null }) =>
    api<{ changed: number[] }>(`/api/batches/${b.id}/scripts/action`, {
      body: { action: v.action, scriptIds: v.ids, note: v.note ?? null, timelinerUrl: v.timelinerUrl ?? null, versions: Object.fromEntries(b.scripts.filter((s) => v.ids.includes(s.id)).map((s) => [s.id, s.version])) },
    }), {
    onSuccess: (_o, v) => {
      const nums = compressRanges(b.scripts.filter((s) => v.ids.includes(s.id)).map((s) => s.number));
      toast(`${ACTION_RULES[v.action].label}: script${v.ids.length > 1 ? 's' : ''} ${nums}`);
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
    if (a === 'request_revisions' || a === 'deliver' || a === 'undo_delivery') setDialog({ action: a, ids });
    else run.mutate({ action: a, ids });
  };
  const allVisibleSelected = visible.length > 0 && visible.every((s) => sel.has(s.id));

  return (
    <Panel title="Script checklist" count={b.scripts.length} id="scripts"
      sub={`${b.progress.draftReady} / ${b.progress.total} drafts ready · ${b.progress.pctDraft}%`}>
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
                  <th>#</th><th>Title</th><th>Writer</th><th>Status</th><th>Links</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((s) => (
                  <tr key={s.id} className={`clickable${sel.has(s.id) ? ' selected' : ''}`} onClick={(e) => { if ((e.target as HTMLElement).closest('input,a,button')) return; setOpen(s); }}>
                    <td className="chk"><input type="checkbox" aria-label={`Select script ${s.number}`} checked={sel.has(s.id)} onClick={(e) => toggle(s, e.shiftKey)} onChange={() => {}} /></td>
                    <td className="num strong">{s.number}</td>
                    <td style={{ maxWidth: 260 }}><span className={s.title ? 'strong' : 'muted'}>{s.title ?? `Script ${s.number}`}</span></td>
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
                  <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}><span className="n">{s.number}</span><span className="ellipsis" style={{ fontWeight: 600 }}>{s.title ?? `Script ${s.number}`}</span></div>
                  <div className="row-flex s2" style={{ marginTop: 6 }}><StatusChip status={s.status} /><span className="muted" style={{ fontSize: 12 }}>{s.assigneeName ?? 'Unassigned'}</span></div>
                  {s.openRevision && <div style={{ color: '#F7B8D8', fontSize: 12.5, marginTop: 6 }}>{s.openRevision.note}</div>}
                </button>
                <ScriptLinks s={s} />
              </div>
            ))}
          </div>
        </>
      )}

      {dialog?.action === 'request_revisions' && <NoteDialog title={`Request revisions on ${plural(dialog.ids.length, 'script')}`} label="What needs to change?" required busy={run.isPending} error={run.error} confirm="Send back for revisions" variant="danger"
        onClose={() => setDialog(null)} onSubmit={(note) => run.mutate({ action: 'request_revisions', ids: dialog.ids, note })}
        scripts={compressRanges(b.scripts.filter((s) => dialog.ids.includes(s.id)).map((s) => s.number))} />}
      {dialog?.action === 'deliver' && <DeliverDialog count={dialog.ids.length} nums={compressRanges(b.scripts.filter((s) => dialog.ids.includes(s.id)).map((s) => s.number))} busy={run.isPending} error={run.error}
        onClose={() => setDialog(null)} onSubmit={(url, note) => run.mutate({ action: 'deliver', ids: dialog.ids, timelinerUrl: url, note })} />}
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

export function NoteDialog({ title, label, required, busy, error, confirm, variant, onClose, onSubmit, scripts }: { title: string; label: string; required?: boolean; busy: boolean; error: ApiError | null; confirm: string; variant: string; onClose: () => void; onSubmit: (note: string | null) => void; scripts: string }) {
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const id = useFieldId('note');
  const submit = () => { if (required && !note.trim()) { setErr('Add a note so the writer knows what to change'); return; } onSubmit(note.trim() || null); };
  return (
    <Dialog open onClose={onClose} title={title} sub={`Scripts ${scripts}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant={variant} busy={busy} onClick={submit}>{confirm}</Button></div>}>
      <div className="form">
        <FormError error={error} />
        <Field label={label} optional={!required} htmlFor={id} error={err || error?.fields.note}><textarea className="textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} {...inputProps(id, err)} /></Field>
      </div>
    </Dialog>
  );
}

export function DeliverDialog({ count, nums, busy, error, onClose, onSubmit }: { count: number; nums: string; busy: boolean; error: ApiError | null; onClose: () => void; onSubmit: (url: string | null, note: string | null) => void }) {
  const { me } = useBoot();
  const [url, setUrl] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const a = useFieldId('tl');
  const c = useFieldId('dn');
  const submit = () => {
    if (url && !/^https?:\/\/\S+$/i.test(url)) { setErr('Use a full link starting with https://'); return; }
    onSubmit(url || null, note || null);
  };
  return (
    <Dialog open onClose={onClose} title={`Confirm delivery to Timeliner`} sub={`${plural(count, 'script')}: ${nums}`} size="narrow"
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={busy} onClick={submit} icon={<Send aria-hidden />}>Mark {plural(count, 'script')} delivered</Button></div>}>
      <div className="form">
        <div className="banner"><Send aria-hidden /><div className="txt"><b>Add the scripts to Timeliner first.</b><span>This records a writer-confirmed delivery by {me.name} with today’s time. It isn’t verified by Timeliner itself. Managers are notified.</span></div></div>
        <FormError error={error} />
        <Field label="Timeliner link" optional htmlFor={a} error={err || error?.fields.timelinerUrl}><input className="input" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} {...inputProps(a, err)} /></Field>
        <Field label="Delivery note" optional htmlFor={c}><textarea className="textarea" id={c} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Scheduled for next Tuesday" /></Field>
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
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}{u.role === 'manager' ? ' (manager)' : ''}</option>)}
            <option value="none">Unassigned</option>
          </select>
        </Field>
      </div>
    </Dialog>
  );
}

function ScriptDialog({ s, b, onClose }: { s: Script; b: BatchDetail; onClose: () => void }) {
  const { me, settings } = useBoot();
  const toast = useToast();
  const canEdit = me.role === 'manager' || s.assigneeId === me.id;
  const [title, setTitle] = useState(s.title ?? '');
  const [docUrl, setDocUrl] = useState(s.docUrl ?? '');
  const [tl, setTl] = useState(s.timelinerUrl ?? '');
  const [notes, setNotes] = useState(s.notes ?? '');
  const save = useSave(() => api(`/api/scripts/${s.id}`, { method: 'PATCH', body: { version: s.version, title, docUrl, timelinerUrl: tl, notes } }), { onSuccess: () => { toast(`Script ${s.number} saved`); onClose(); } });
  const history = b.revisions.filter((r) => r.scriptId === s.id);
  const ids = { t: useFieldId('t'), d: useFieldId('d'), l: useFieldId('l'), n: useFieldId('n') };
  const f = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} kind="drawer" title={`Script ${s.number}`} sub={<span className="row-flex s2"><StatusChip status={s.status} /><span>{s.assigneeName ?? 'Unassigned'}</span></span>}
      footer={canEdit ? <div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} onClick={() => save.mutate(undefined)}>Save script</Button></div> : undefined}>
      <div className="form">
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        {s.openRevision && <div className="banner pink"><RotateCcw aria-hidden /><div className="txt"><b>Revisions requested</b><span>{s.openRevision.note} — {s.openRevision.requestedByName}, {fmtStamp(s.openRevision.requestedAt, settings.timezone)}</span></div></div>}
        <Field label="Title" optional htmlFor={ids.t}><input className="input" id={ids.t} value={title} onChange={(e) => setTitle(e.target.value)} disabled={!canEdit} placeholder={`Script ${s.number}`} /></Field>
        <Field label="Writing document link" optional htmlFor={ids.d} error={f.docUrl}><input className="input" type="url" placeholder="https://docs.google.com/…" value={docUrl} onChange={(e) => setDocUrl(e.target.value)} disabled={!canEdit} {...inputProps(ids.d, f.docUrl)} /></Field>
        <Field label="Timeliner link" optional htmlFor={ids.l} error={f.timelinerUrl}><input className="input" type="url" placeholder="https://" value={tl} onChange={(e) => setTl(e.target.value)} disabled={!canEdit} {...inputProps(ids.l, f.timelinerUrl)} /></Field>
        <Field label="Notes" optional htmlFor={ids.n}><textarea className="textarea" id={ids.n} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={!canEdit} /></Field>
        {!canEdit && <p className="muted" style={{ fontSize: 13 }}>Only {s.assigneeName ?? 'the assigned writer'} or a manager can edit this script.</p>}
        <dl className="kv">
          <dt>Submitted</dt><dd>{s.submittedAt ? fmtStamp(s.submittedAt, settings.timezone) : '—'}</dd>
          <dt>Approved</dt><dd>{s.approvedAt ? `${fmtStamp(s.approvedAt, settings.timezone)} by ${s.approvedByName}` : '—'}</dd>
          <dt>Delivered</dt><dd>{s.deliveredAt ? `${fmtStamp(s.deliveredAt, settings.timezone)} by ${s.deliveredByName} (writer-confirmed)` : '—'}</dd>
        </dl>
        {history.length > 0 && (
          <div><div className="section-title">Revision history</div>
            <div className="timeline">{history.map((r) => <div key={r.id} className="tl" style={{ ['--c' as string]: r.resolvedAt ? 'var(--mint)' : 'var(--pink)' }}><span className="d" /><div><div className="s">{r.note}</div><div className="w">{r.requestedByName} · {fmtStamp(r.requestedAt, settings.timezone)}{r.resolvedAt ? ` · resolved (${r.resolution}) ${fmtStamp(r.resolvedAt, settings.timezone)}` : ' · open'}</div></div></div>)}</div>
          </div>
        )}
      </div>
    </Dialog>
  );
}

// ── brief, review notes, deliveries ──────────────────────────────────────

const RES_ICON: Record<ResourceCategory, ReactNode> = { folder: <Link2 />, example: <FileText />, asset: <Upload />, recording: <PlayCircle />, document: <FileText />, other: <Link2 /> };

export function ResourceRow({ r, onRemove }: { r: Resource; onRemove?: () => void }) {
  const href = r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!;
  return (
    <div className="res">
      <span className="ic" style={{ ['--c' as string]: r.category === 'recording' ? 'var(--salmon)' : 'var(--cyan)' }}>{RES_ICON[r.category]}</span>
      <div style={{ minWidth: 0 }}>
        <div className="t">{r.title}</div>
        <div className="s">{RESOURCE_LABEL[r.category]}{r.kind === 'file' ? ` · ${r.fileName} · ${fmtBytes(r.fileSize)}` : ''} · added by {r.createdByName}</div>
      </div>
      <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}>
        <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">{r.kind === 'file' ? 'Open file' : 'Open'}<ExternalLink aria-hidden /></a>
        {onRemove && <button type="button" className="icon-btn sm" onClick={onRemove} aria-label={`Remove ${r.title}`} title="Remove"><Trash2 size={15} /></button>}
      </div>
    </div>
  );
}

function BriefSection({ b }: { b: BatchDetail }) {
  const { me } = useBoot();
  const toast = useToast();
  const remove = useSave((id: number) => api(`/api/resources/${id}`, { method: 'DELETE' }), { onSuccess: () => toast('Resource removed') });
  const batchRes = b.resources.filter((r) => r.batchId === b.id);
  const clientRes = b.resources.filter((r) => r.batchId !== b.id);
  return (
    <div className="stack s4">
      {b.brief ? <div><div className="section-title">Batch brief</div><p className="prose">{b.brief}</p></div> : <p className="muted">No batch-specific brief.{me.role === 'manager' ? ' Add one with “Edit batch”.' : ''}</p>}
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
      {batchRes.length > 0 && <div className="stack s2"><div className="section-title">This batch</div>{batchRes.map((r) => <ResourceRow key={r.id} r={r} onRemove={me.role === 'manager' || r.createdById === me.id ? () => remove.mutate(r.id) : undefined} />)}</div>}
      {clientRes.length > 0 && <div className="stack s2"><div className="section-title">Client folders, examples & assets</div>{clientRes.map((r) => <ResourceRow key={r.id} r={r} />)}</div>}
      {!b.briefings.length && !batchRes.length && !clientRes.length && <Empty boxed title="No briefing materials yet">Attach a briefing call or add links so writers know what applies.</Empty>}
    </div>
  );
}

function ReviewNotes({ b }: { b: BatchDetail }) {
  const { settings } = useBoot();
  const open = b.revisions.filter((r) => !r.resolvedAt);
  const done = b.revisions.filter((r) => r.resolvedAt);
  return (
    <Panel title="Review notes" count={open.length || undefined} sub={open.length ? 'unresolved' : undefined}>
      {!b.revisions.length ? <Empty boxed icon={<Check />} title="No revision requests" /> : (
        <div className="rows">
          {open.map((r) => (
            <div key={r.id} className="item edge-pink">
              <div className="body"><div className="top">Script {r.scriptNumber} · requested by {r.requestedByName}</div><div className="prose">{r.note}</div></div>
              <div className="side"><Chip color="pink" icon={<RotateCcw aria-hidden />}>Open</Chip><span className="muted nowrap" style={{ fontSize: 12 }}>{fmtStamp(r.requestedAt, settings.timezone)}</span></div>
            </div>
          ))}
          {done.slice(0, 8).map((r) => (
            <div key={r.id} className="item">
              <div className="body"><div className="top">Script {r.scriptNumber} · {r.requestedByName}</div><div className="muted" style={{ fontSize: 13 }}>{r.note}</div></div>
              <div className="side"><Chip color="mint" icon={<Check aria-hidden />}>{r.resolution === 'approved' ? 'Approved' : 'Resubmitted'}</Chip></div>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

function Deliveries({ b }: { b: BatchDetail }) {
  const { settings } = useBoot();
  return (
    <Panel title="Delivery records" sub="writer-confirmed">
      {b.progress.delivered < b.progress.total && b.progress.delivered > 0 && <div className="banner yellow" style={{ marginBottom: 12 }}><AlertTriangle aria-hidden /><div className="txt"><b>Partially delivered: {b.progress.delivered} / {b.progress.total}</b><span>The batch is complete only when every script is recorded as delivered.</span></div></div>}
      {!b.deliveries.length ? <Empty boxed icon={<Send />} title="Nothing delivered yet">Writers confirm delivery here after adding scripts to Timeliner.</Empty> : (
        <div className="rows">
          {b.deliveries.map((d) => (
            <div key={d.id} className="item edge-mint">
              <div className="body">
                <div className="title">Scripts {compressRanges(d.scriptNumbers) || '—'}</div>
                <div className="meta"><span>Writer-confirmed by <b style={{ color: 'var(--text)' }}>{d.confirmedByName}</b></span><span>{fmtStamp(d.confirmedAt, settings.timezone)}</span></div>
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
  const [brief, setBrief] = useState(b.brief ?? '');
  const [nextAction, setNextAction] = useState(b.nextAction ?? '');
  const [briefingIds, setBriefingIds] = useState<number[]>(b.briefings.map((x) => x.id));
  useEffect(() => {
    if (!open) return;
    setTitle(b.title); setPriority(b.priority); setPlanned(b.plannedStart ?? ''); setShootId(b.shootId ?? ''); setDraftMode(b.draftDueMode); setDraft(b.draftDue ?? '');
    setFinalMode(b.finalDueMode); setFinal(b.finalDue ?? ''); setBrief(b.brief ?? ''); setNextAction(b.nextAction ?? ''); setBriefingIds(b.briefings.map((x) => x.id));
  }, [open, b]);
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
  const submit = () => save.mutate({
    title, priority, plannedStart: planned || null, shootId: shootId || null, brief: brief || null, nextAction: nextAction || null, briefingIds,
    draftDue: { mode: shootId ? draftMode : 'manual', date: draftMode === 'manual' || !shootId ? draft || null : null },
    finalDue: { mode: shootId ? finalMode : 'manual', date: finalMode === 'manual' || !shootId ? final || null : null },
  });
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
        <DateModeField label="Drafts due" id={ids.d} hasShoot={!!shootId} mode={draftMode} setMode={setDraftMode} date={draft} setDate={setDraft} auto={auto?.draftDue} rule={auto?.draftRule} error={f.draftDue} />
        <DateModeField label="Final delivery to Timeliner" id={ids.f} hasShoot={!!shootId} mode={finalMode} setMode={setFinalMode} date={final} setDate={setFinal} auto={auto?.finalDue} rule={auto?.finalRule} error={f.finalDue} />
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

function DateModeField({ label, id, hasShoot, mode, setMode, date, setDate, auto, rule, error }: { label: string; id: string; hasShoot: boolean; mode: 'auto' | 'manual'; setMode: (m: 'auto' | 'manual') => void; date: string; setDate: (d: string) => void; auto?: string; rule?: string; error?: string }) {
  return (
    <Field label={label} htmlFor={id} error={error} help={hasShoot && mode === 'auto' && auto ? `${fmtLong(auto)} · ${rule}` : hasShoot && mode === 'manual' ? 'Manual override — kept if the shoot moves, and flagged for review.' : undefined}>
      {hasShoot && (
        <div className="seg" role="group" aria-label={`${label} mode`} style={{ marginBottom: 6, alignSelf: 'flex-start' }}>
          <button type="button" aria-pressed={mode === 'auto'} onClick={() => setMode('auto')}>Automatic</button>
          <button type="button" aria-pressed={mode === 'manual'} onClick={() => { setMode('manual'); if (!date && auto) setDate(auto); }}>Manual date</button>
        </div>
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
            <Field label="Assign the new scripts to" optional htmlFor="tgt-a"><select id="tgt-a" className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Leave unassigned</option>{users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
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
                      <span className="row-flex s2" style={{ flexWrap: 'nowrap' }}><input type="checkbox" checked={remove.includes(s.id)} onChange={(e) => setRemove(e.target.checked ? [...remove, s.id] : remove.filter((x) => x !== s.id))} style={{ width: 18, height: 18, accentColor: 'var(--salmon)' }} /><b>Script {s.number}</b><span className="muted">{s.title ?? ''}</span></span>
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

export function RescheduleDialog({ shootId, start, end, onClose }: { shootId: number; start: string; end: string | null; onClose: () => void }) {
  const toast = useToast();
  const [s, setS] = useState(start);
  const [e, setE] = useState(end ?? '');
  const [preview, setPreview] = useState<ReschedulePreview | null>(null);
  const load = useSave(() => api<ReschedulePreview>(`/api/shoots/${shootId}/reschedule-preview`, { body: { startDate: s, endDate: e || null } }), { onSuccess: (p) => setPreview(p) });
  const apply = useSave(() => api(`/api/shoots/${shootId}/reschedule`, { body: { startDate: s, endDate: e || null } }), { onSuccess: () => { toast('Shoot moved and deadlines updated'); onClose(); } });
  const f = load.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title="Move shoot" sub={`Currently ${fmtRange(start, end)}`} size="wide"
      footer={<div className="form-actions">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        {!preview ? <Button variant="salmon pill" busy={load.isPending} onClick={() => load.mutate(undefined)}>Preview changes</Button>
          : <Button variant="primary pill" busy={apply.isPending} onClick={() => apply.mutate(undefined)}>Apply changes</Button>}
      </div>}>
      <div className="form">
        <FormError error={(load.error && !Object.keys(f).length ? load.error : null) ?? apply.error} />
        <div className="form-grid">
          <Field label="New start date" htmlFor="rs-s" error={f.startDate} help={end ? 'The end date moves with it, keeping the shoot the same length.' : undefined}>
            <input id="rs-s" className="input" type="date" value={s} onChange={(x) => {
              const v = x.target.value;
              if (v && e && s && isISODate(v)) setE(addDays(v, diffDays(e, s)));
              setS(v); setPreview(null);
            }} />
          </Field>
          <Field label="New end date" optional htmlFor="rs-e" error={f.endDate}><input id="rs-e" className="input" type="date" value={e} min={s} onChange={(x) => { setE(x.target.value); setPreview(null); }} /></Field>
        </div>
        {preview && (
          <>
            <div className="section-title">What will change</div>
            <div className="table-scroll">
              <table className="tbl">
                <thead><tr><th>Batch</th><th>Deadline</th><th>Now</th><th>After</th><th>Rule</th></tr></thead>
                <tbody>
                  {preview.changes.map((c, i) => (
                    <tr key={i}>
                      <td className="strong">{c.batchTitle}</td>
                      <td>{c.field === 'draftDue' ? 'Drafts due' : 'Final delivery'}</td>
                      <td className="nowrap">{fmtDate(c.from)}</td>
                      <td className="nowrap"><b>{fmtDate(c.to)}</b>{c.inPast && <div><Chip color="red" icon={<AlertTriangle aria-hidden />}>Already past</Chip></div>}</td>
                      <td>{c.kept ? <Chip color="yellow">Manual — kept, flagged for review</Chip> : <Chip color="cyan">Recalculated</Chip>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ fontSize: 13 }}>{preview.affectedWriters.length ? `${preview.affectedWriters.join(', ')} will be notified.` : 'No writers to notify.'} The change is recorded in each batch’s history.</p>
          </>
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
        <Field label="What’s blocking the work?" htmlFor={id} error={err || save.error?.fields.note}><textarea className="textarea" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Waiting on the client’s product claims sheet" {...inputProps(id, err)} /></Field>
      </div>
    </Dialog>
  );
}

export function ResourceDialog({ open, onClose, clientId, batchId, briefingId }: { open: boolean; onClose: () => void; clientId: number; batchId?: number; briefingId?: number }) {
  const toast = useToast();
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
        <div className="seg" role="group" aria-label="Resource type" style={{ alignSelf: 'flex-start' }}>
          <button aria-pressed={mode === 'link'} onClick={() => setMode('link')}><Link2 aria-hidden />Link</button>
          <button aria-pressed={mode === 'file'} onClick={() => setMode('file')}><Upload aria-hidden />File</button>
        </div>
        <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
        <Field label="Title" optional={mode === 'file'} htmlFor={ids.t} error={f.title}><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} {...inputProps(ids.t, f.title)} /></Field>
        {mode === 'link'
          ? <Field label="Link" htmlFor={ids.u} error={f.url}><input className="input" type="url" placeholder="https://" value={url} onChange={(e) => setUrl(e.target.value)} {...inputProps(ids.u, f.url)} /></Field>
          : <Field label="File" htmlFor={ids.f} error={f.file} help="Up to 25 MB. Only signed-in team members can open it."><input className="input" type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} {...inputProps(ids.f, f.file)} /></Field>}
        <Field label="Type" htmlFor={ids.c}><select className="select" id={ids.c} value={category} onChange={(e) => setCategory(e.target.value as ResourceCategory)}>{RESOURCE_CATEGORIES.map((c) => <option key={c} value={c}>{RESOURCE_LABEL[c]}</option>)}</select></Field>
      </div>
    </Dialog>
  );
}

