// Compact nested rows for batches, and the quick-inspect drawer.

import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Ban, CalendarClock, Camera, ClipboardCheck, OctagonAlert, RotateCcw, UserPlus } from 'lucide-react';
import { api } from '../api';
import type { AttentionItem, AttentionKind, BatchDetail, BatchSummary } from '../../../shared/types';
import { PRIORITY_LABEL } from '../../../shared/types';
import { fmtDate, fmtLong, fmtRange, fmtStamp } from '../../../shared/format';
import { BatchProgress, Button, Chip, Dialog, DueChip, ErrorState, Loading, Ring, ringColor, StageChip, edgeFor } from './ui';
import { useBoot } from './Shell';

export function writersText(b: BatchSummary): string {
  return b.writers.map((w) => `${w.name} ${w.ranges}`).join(' · ') || 'No scripts';
}

export function BatchItem({ b, action, extra, onOpen, ring }: { b: BatchSummary; action?: ReactNode; extra?: ReactNode; onOpen?: () => void; ring?: boolean }) {
  const { clock } = useBoot();
  const nav = useNavigate();
  const open = onOpen ?? (() => nav(`/batches/${b.id}`));
  return (
    <div className={`item clickable ${edgeFor(b.next, b.blocked)}${ring ? ' with-tile' : ''}`} onClick={open} role="link" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) open(); }} aria-label={`${b.clientName}: ${b.title}`}>
      {ring && <Ring pct={b.progress.pctDraft} color={ringColor(b.progress)} size={46} />}
      <div className="body">
        <div className="top">
          <span className="ellipsis">{b.clientName}</span>
          {b.shootStart && <span className="nowrap" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}><Camera size={12} aria-hidden />{fmtRange(b.shootStart, b.shootEnd)}</span>}
        </div>
        <div className="title">{b.title}</div>
        <div className="meta">
          <span className="ellipsis" title={writersText(b)}>{writersText(b)}</span>
          {b.blocked && <Chip color="red" icon={<Ban aria-hidden />}>Blocked</Chip>}
          {b.progress.unassigned > 0 && <Chip color="pink" icon={<UserPlus aria-hidden />}>{b.progress.unassigned} unassigned</Chip>}
          {b.progress.inReview > 0 && <Chip color="lavender" dot>{b.progress.inReview} in review</Chip>}
          {b.progress.revisions > 0 && <Chip color="pink" icon={<RotateCcw aria-hidden />}>{b.progress.revisions} revisions</Chip>}
          {b.priority === 'urgent' || b.priority === 'high' ? <Chip color={b.priority === 'urgent' ? 'red' : 'salmon'}>{PRIORITY_LABEL[b.priority]}</Chip> : null}
        </div>
        {extra}
        <BatchProgress p={b.progress} thin />
      </div>
      <div className="side">
        <DueChip m={b.next} today={clock.today} />
        {b.next?.date && (b.next.overdue || b.next.dueToday) && <span className="muted nowrap" style={{ fontSize: 12 }}>{b.next.kind === 'draft' ? 'Drafts' : 'Final'} {fmtDate(b.next.date, clock.today)}</span>}
        <span onClick={(e) => e.stopPropagation()}>{action ?? <Link to={`/batches/${b.id}`} className="btn sm">Open batch</Link>}</span>
      </div>
    </div>
  );
}

const ISSUE_ICON: Record<AttentionKind, ReactNode> = {
  overdue: <AlertTriangle aria-hidden color="var(--red)" />,
  blocked: <OctagonAlert aria-hidden color="var(--red)" />,
  due_today: <CalendarClock aria-hidden color="var(--yellow)" />,
  date_review: <CalendarClock aria-hidden color="var(--yellow)" />,
  unassigned: <UserPlus aria-hidden color="var(--pink)" />,
  revisions: <RotateCcw aria-hidden color="var(--pink)" />,
};

export function AttentionRow({ a }: { a: AttentionItem }) {
  const { me } = useBoot();
  const nav = useNavigate();
  const b = a.batch;
  const edge = a.kind === 'overdue' || a.kind === 'blocked' ? 'edge-red' : a.kind === 'due_today' || a.kind === 'date_review' ? 'edge-yellow' : 'edge-pink';
  const action = b.progress.inReview > 0 && me.role === 'manager'
    ? <Link to="/review" className="btn sm review"><ClipboardCheck aria-hidden />Review</Link>
    : a.kind === 'unassigned' && me.role === 'manager'
      ? <Link to={`/batches/${b.id}#scripts`} className="btn sm">Assign</Link>
      : <Link to={`/batches/${b.id}`} className="btn sm">Open batch</Link>;
  return (
    <div className={`item clickable ${edge}`} onClick={() => nav(`/batches/${b.id}`)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && e.target === e.currentTarget) nav(`/batches/${b.id}`); }}>
      <div className="body">
        <div className="top"><span className="ellipsis">{b.clientName}</span></div>
        <div className="title">{b.title}</div>
        <ul className="issues">
          {a.issues.map((i, k) => <li key={k}>{ISSUE_ICON[i.kind]}<span><b>{i.text}</b></span></li>)}
        </ul>
        <div className="meta"><span className="ellipsis">{writersText(b)}</span><span className="num">{b.progress.draftReady} / {b.progress.total} drafts ready · {b.progress.pctDraft}%</span></div>
      </div>
      <div className="side">
        {b.next?.date && <span className="when">{b.next.kind === 'draft' ? 'Drafts' : 'Final'} {fmtDate(b.next.date)}</span>}
        <span onClick={(e) => e.stopPropagation()}>{action}</span>
      </div>
    </div>
  );
}

// ── quick inspect drawer ─────────────────────────────────────────────────

export function BatchDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { clock, settings } = useBoot();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['batch', id], queryFn: () => api<BatchDetail>(`/api/batches/${id}`), enabled: id != null });
  const b = q.data;
  return (
    <Dialog open={id != null} onClose={onClose} kind="drawer" title={b ? b.title : 'Batch'} sub={b ? b.clientName : undefined}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Close</Button><Button variant="primary pill" onClick={() => { onClose(); nav(`/batches/${id}`); }} icon={<ArrowRight aria-hidden />}>Open batch</Button></div>}>
      {q.isLoading && <Loading height={260} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {b && (
        <div className="stack s4">
          <div className="row-flex s2"><StageChip stage={b.stage} /><DueChip m={b.next} today={clock.today} />{b.blocked && <Chip color="red" icon={<Ban aria-hidden />}>Blocked</Chip>}</div>
          {b.blocked && <div className="banner red"><OctagonAlert aria-hidden /><div className="txt"><b>{b.blockerNote}</b><span>Flagged by {b.blockedByName ?? 'someone'} · {fmtStamp(b.blockedAt, settings.timezone)}</span></div></div>}
          <BatchProgress p={b.progress} />
          <div className="deadline-list">
            {b.shootStart && <div className="deadline" style={{ ['--c' as string]: 'var(--salmon)' }}><span className="ic"><Camera /></span><div><div className="k">Shoot</div><div className="v">{fmtRange(b.shootStart, b.shootEnd)}</div></div></div>}
            <div className="deadline" style={{ ['--c' as string]: 'var(--lavender)' }}><span className="ic"><CalendarClock /></span><div><div className="k">Drafts due</div><div className="v">{b.draftDue ? fmtLong(b.draftDue) : 'Not set'}</div>{b.draftRule && <div className="rule">{b.draftRule}</div>}</div><div className="right"><DueChip m={b.draft} today={clock.today} prefix={false} /></div></div>
            <div className="deadline" style={{ ['--c' as string]: 'var(--yellow)' }}><span className="ic"><CalendarClock /></span><div><div className="k">Final delivery to Timeliner</div><div className="v">{b.finalDue ? fmtLong(b.finalDue) : 'Not set'}</div>{b.finalRule && <div className="rule">{b.finalRule}</div>}</div><div className="right"><DueChip m={b.final} today={clock.today} prefix={false} /></div></div>
          </div>
          <div>
            <div className="section-title">Assignments</div>
            <div className="rows">
              {b.writers.map((w) => (
                <div key={String(w.userId)} className={`item ${w.userId == null ? 'edge-pink' : ''}`}>
                  <div className="body"><div className="title">{w.name}</div><div className="meta">Scripts {w.ranges}</div></div>
                  <div className="side"><span className="when num">{w.draftReady} / {w.count} drafts</span><span className="muted num" style={{ fontSize: 12 }}>{w.delivered} delivered</span></div>
                </div>
              ))}
            </div>
          </div>
          {b.nextAction && <div><div className="section-title">Next action</div><p className="prose">{b.nextAction}</p></div>}
          <div>
            <div className="section-title">Recent activity</div>
            <div className="timeline">
              {b.activity.slice(0, 6).map((a) => <div key={a.id} className="tl"><span className="d" /><div><div className="s">{a.summary}</div><div className="w">{a.actorName ?? 'System'} · {fmtStamp(a.createdAt, settings.timezone)}</div></div></div>)}
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
