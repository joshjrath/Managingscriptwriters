// Production: board grouped by workflow stage and a compact table, with
// filters for client, writer, stage, date range and flags. Filters live in the
// URL so dashboard cards can link straight to filtered views.

import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowDownUp, Ban, Camera, Columns3, RotateCcw, Rows3, UserPlus } from 'lucide-react';
import { api, qs } from '../api';
import type { BatchSummary } from '../../../shared/types';
import { STAGES, STAGE_LABEL, type Stage } from '../../../shared/workflow';
import { fmtDate, fmtRange } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { BatchDrawer, writersText } from '../components/BatchBits';
import { BatchProgress, Chip, DueChip, edgeFor, Empty, ErrorState, Loading, Seg, StageChip } from '../components/ui';
import { TodayBump } from '../components/WritingPulse';

const FLAGS = [
  { id: 'overdue', label: 'Overdue', c: 'var(--red)' },
  { id: 'due_today', label: 'Due today', c: 'var(--yellow)' },
  { id: 'blocked', label: 'Blocked', c: 'var(--red)' },
  { id: 'unassigned', label: 'Unassigned scripts', c: 'var(--pink)' },
  { id: 'review', label: 'In review', c: 'var(--lavender)' },
  { id: 'revisions', label: 'Revisions', c: 'var(--pink)' },
  { id: 'date_review', label: 'Dates to check', c: 'var(--yellow)' },
] as const;

const STAGE_C: Record<Stage, string> = { not_started: 'var(--neutral)', writing: 'var(--cyan)', in_review: 'var(--lavender)', approved: 'color-mix(in srgb, var(--mint) 60%, var(--track))', delivered: 'var(--mint)' };

type SortKey = 'next' | 'client' | 'progress' | 'shoot';

export function Production() {
  const { clients, users, clock } = useBoot();
  const [params, setParams] = useSearchParams();
  const [inspect, setInspect] = useState<number | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'next', dir: 1 });
  const view = params.get('view') === 'table' ? 'table' : 'board';
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const filters = { clientId: get('clientId'), writerId: get('writerId'), stage: get('stage'), flag: get('flag'), from: get('from'), to: get('to'), q: get('q'), completed: get('completed'), archived: get('archived') };
  const q = useQuery({ queryKey: ['batches', filters], queryFn: () => api<{ batches: BatchSummary[] }>(`/api/batches${qs(filters)}`) });
  const all = useQuery({ queryKey: ['batches', {}], queryFn: () => api<{ batches: BatchSummary[] }>('/api/batches') });
  const flagCounts = useMemo(() => {
    const list = all.data?.batches ?? [];
    return {
      overdue: list.filter((b) => b.draft.overdue || b.final.overdue).length,
      due_today: list.filter((b) => b.draft.dueToday || b.final.dueToday).length,
      blocked: list.filter((b) => b.blocked).length,
      unassigned: list.filter((b) => b.progress.unassigned > 0).length,
      review: list.filter((b) => b.progress.inReview > 0).length,
      revisions: list.filter((b) => b.progress.revisions > 0).length,
      date_review: list.filter((b) => b.needsDateReview).length,
    } as Record<string, number>;
  }, [all.data]);

  const batches = q.data?.batches ?? [];
  const sorted = useMemo(() => {
    const val = (b: BatchSummary): string | number => sort.key === 'client' ? b.clientName.toLowerCase() : sort.key === 'progress' ? b.progress.pctDraft : sort.key === 'shoot' ? b.shootStart ?? '9999' : b.next?.date ?? '9999';
    return [...batches].sort((a, b) => { const x = val(a); const y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
  }, [batches, sort]);
  const sortBtn = (key: SortKey, label: string) => (
    <button onClick={() => setSort((s) => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : 1 }))} aria-label={`Sort by ${label}`}>{label}{sort.key === key && <ArrowDownUp size={12} aria-hidden />}</button>
  );
  const anyFilter = Object.entries(filters).some(([k, v]) => v && k !== 'completed');

  return (
    <>
      <PageHeader title="Production" sub="Stage comes from the script records. Blocked is tracked separately.">
        <Seg role="group" aria-label="View">
          <button aria-pressed={view === 'board'} onClick={() => set('view', '')}><Columns3 aria-hidden />Board</button>
          <button aria-pressed={view === 'table'} onClick={() => set('view', 'table')}><Rows3 aria-hidden />Table</button>
        </Seg>
      </PageHeader>

      <div className="filters" role="search">
        <input className="input search" type="search" placeholder="Search batches or clients" value={filters.q} onChange={(e) => set('q', e.target.value)} aria-label="Search batches" />
        <select className="select" value={filters.clientId} onChange={(e) => set('clientId', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {clients.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="select" value={filters.writerId} onChange={(e) => set('writerId', e.target.value)} aria-label="Writer">
          <option value="">All writers</option>
          <option value="unassigned">Has unassigned scripts</option>
          {users.filter((u) => u.active && u.role !== 'editor').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="select" value={filters.stage} onChange={(e) => set('stage', e.target.value)} aria-label="Stage">
          <option value="">All stages</option>
          {STAGES.map((s) => <option key={s} value={s}>{STAGE_LABEL[s]}</option>)}
        </select>
        <label className="date-f">From<input className="input" type="date" value={filters.from} onChange={(e) => set('from', e.target.value)} /></label>
        <label className="date-f">To<input className="input" type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set('to', e.target.value)} /></label>
        <label className="check" style={{ fontSize: 13 }}><input type="checkbox" checked={filters.completed === '1'} onChange={(e) => set('completed', e.target.checked ? '1' : '')} />Include older delivered</label>
        {anyFilter && <button className="btn sm ghost" onClick={() => setParams(view === 'table' ? { view: 'table' } : {})}>Clear filters</button>}
      </div>
      <div className="quick" role="group" aria-label="Quick filters">
        {FLAGS.map((f) => (
          <button key={f.id} aria-pressed={filters.flag === f.id} style={{ ['--c' as string]: f.c }} onClick={() => set('flag', filters.flag === f.id ? '' : f.id)}>
            <i className="d" aria-hidden />{f.label}<span className="n">{flagCounts[f.id] ?? 0}</span>
          </button>
        ))}
      </div>

      {q.isLoading && <Loading height={420} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && !batches.length && <div className="panel"><Empty title={anyFilter ? 'No batches match these filters' : 'No batches yet'}>{anyFilter ? 'Try clearing a filter.' : 'Create a shoot or batch with “+ Create”.'}</Empty></div>}

      {q.data && batches.length > 0 && view === 'board' && (
        <div className="board-scroll" tabIndex={0} aria-label="Production board — scroll sideways for more stages">
          <div className="board">
            {STAGES.map((stage) => {
              const col = sorted.filter((b) => b.stage === stage);
              return (
                <section key={stage} className="col" aria-label={`${STAGE_LABEL[stage]}: ${col.length}`}>
                  <div className="col-head" style={{ ['--c' as string]: STAGE_C[stage] }}><i aria-hidden /><h3>{STAGE_LABEL[stage]}</h3><span className="n">{col.length}</span></div>
                  {!col.length && <div className="empty-col">Nothing here</div>}
                  {col.map((b) => (
                    <button key={b.id} className={`bcard ${edgeFor(b.next, b.blocked)}`} onClick={() => setInspect(b.id)} aria-label={`${b.clientName}: ${b.title}. ${b.progress.draftReady} of ${b.progress.total} drafts sent.`}>
                      <span className="client ellipsis">{b.clientName}</span>
                      <span className="t">{b.title}</span>
                      <span className="muted ellipsis" style={{ fontSize: 12 }}>{writersText(b)}</span>
                      <BatchProgress p={b.progress} written={b.written} thin showSecondary={false} />
                      <span className="foot">
                        <DueChip m={b.next} today={clock.today} />
                        <span className="row-flex s2">
                          <TodayBump n={b.writtenToday} />
                          {b.blocked && <Chip color="red" icon={<Ban aria-hidden />}>Blocked</Chip>}
                          {b.progress.inReview > 0 && <Chip color="lavender" dot title={`${b.progress.inReview} scripts in review`}>{b.progress.inReview} in review</Chip>}
                          {b.progress.unassigned > 0 && <Chip color="pink" icon={<UserPlus aria-hidden />} title={`${b.progress.unassigned} unassigned scripts`}>{b.progress.unassigned}</Chip>}
                          {b.progress.revisions > 0 && <Chip color="pink" icon={<RotateCcw aria-hidden />}>{b.progress.revisions}</Chip>}
                        </span>
                      </span>
                      {b.shootStart && <span className="muted" style={{ fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 5 }}><Camera size={12} aria-hidden />Shoot {fmtRange(b.shootStart, b.shootEnd)}</span>}
                    </button>
                  ))}
                </section>
              );
            })}
          </div>
        </div>
      )}

      {q.data && batches.length > 0 && view === 'table' && (
        <div className="panel" style={{ padding: '14px 16px' }}>
          <div className="table-scroll" tabIndex={0} aria-label="Batches table">
            <table className="tbl" style={{ minWidth: 980 }}>
              <thead>
                <tr>
                  <th>{sortBtn('client', 'Client · batch')}</th>
                  <th>Writers</th>
                  <th style={{ minWidth: 220 }}>{sortBtn('progress', 'Progress')}</th>
                  <th>{sortBtn('next', 'Next deadline')}</th>
                  <th>{sortBtn('shoot', 'Shoot')}</th>
                  <th>Stage</th>
                  <th>Flags</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((b) => (
                  <tr key={b.id} className="clickable" onClick={() => setInspect(b.id)}>
                    <td style={{ maxWidth: 280 }}><div className="sub ellipsis">{b.clientName}</div><Link to={`/batches/${b.id}`} className="strong" onClick={(e) => e.stopPropagation()}>{b.title}</Link></td>
                    <td style={{ maxWidth: 220 }}>{b.writers.map((w) => <div key={String(w.userId)} className={`nowrap ${w.userId == null ? '' : ''}`} style={{ fontSize: 12.5, color: w.userId == null ? '#F7B8D8' : undefined }}>{w.name} <span className="sub">{w.ranges}</span></div>)}</td>
                    <td><BatchProgress p={b.progress} written={b.written} thin /></td>
                    <td className="nowrap"><DueChip m={b.next} today={clock.today} />{b.next?.date && <div className="sub" style={{ marginTop: 4 }}>{b.next.kind === 'draft' ? 'Drafts' : 'Final'} {fmtDate(b.next.date, clock.today)}</div>}</td>
                    <td className="nowrap">{b.shootStart ? fmtRange(b.shootStart, b.shootEnd) : <span className="sub">No shoot</span>}</td>
                    <td><StageChip stage={b.stage} /></td>
                    <td><div className="row-flex s2">{b.blocked && <Chip color="red">Blocked</Chip>}{b.progress.unassigned > 0 && <Chip color="pink">{b.progress.unassigned} unassigned</Chip>}{b.needsDateReview && <Chip color="yellow">Check dates</Chip>}{b.archivedAt && <Chip>Archived</Chip>}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <BatchDrawer id={inspect} onClose={() => setInspect(null)} />
    </>
  );
}
