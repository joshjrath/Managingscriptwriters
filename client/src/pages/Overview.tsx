// Overview: the operations dashboard. The four summary cards, work due by day
// and upcoming shoots come first; then what needs attention (with today and
// the team's to-dos beside it) and shoots to plan; then writer workload and
// recent deliveries; active batches and writing progress fold away under
// More. Every number is derived from script records.

import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Camera, CheckCheck, ChevronDown, Send, Sparkles } from 'lucide-react';
import { api } from '../api';
import type { Dashboard } from '../../../shared/types';
import { fmtDate, fmtRange, fmtStamp, plural } from '../../../shared/format';
import { isManager, ROLE_LABEL, scriptsLabel } from '../../../shared/workflow';
import { PipLegend, TodayBump, WritingFeed } from '../components/WritingPulse';
import { TodoPanel } from '../components/Todos';
import { CalendarShootsPanel } from '../components/CalendarShoots';
import { TodayPill } from '../components/TodayPill';
import { StatCards } from '../components/StatCards';
import { PageHeader, useBoot, useNewWork, useDisplayTz } from '../components/Shell';
import { DueChart } from '../components/DueChart';
import { AttentionRow, BatchItem } from '../components/BatchBits';
import { Avatar, Chip, DateTile, Empty, ErrorState, Loading, Panel } from '../components/ui';

export function Overview() {
  const displayTz = useDisplayTz();
  const { me, clock, counts, users, clients } = useBoot();
  const nav = useNavigate();
  const openNew = useNewWork();
  const q = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/api/dashboard'), refetchInterval: 60_000 });
  const d = q.data;
  return (
    <>
      <PageHeader title="Overview" sub={d?.scope === 'mine' ? 'Your scripts only: every number here counts just the work assigned to you.' : undefined} />
      {q.isLoading && (
        <div className="stack s6">
          <div className="cards4">{[0, 1, 2, 3].map((i) => <Loading key={i} height={164} />)}</div>
          <Loading height={420} />
        </div>
      )}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {d && (
        <>
          {counts.myNewWork > 0 && (
            <Link to="/my-work" className="mw-alert">
              <Sparkles aria-hidden />
              <div><b>You have new work</b><span>{plural(counts.myNewWork, 'batch', 'batches')} just assigned to you. Open My work to see the scripts, dates and brief.</span></div>
              <ArrowRight aria-hidden className="go" />
            </Link>
          )}
          {(() => {
            // a brand-new workspace: three steps instead of a page of zeros
            const team = users.filter((u) => u.active && u.id !== me.id).length > 0;
            const client = clients.some((c) => c.status !== 'archived');
            const work = d.activeBatches.length > 0 || d.upcomingShoots.length > 0;
            if (team && client && work) return null;
            const steps = [
              { done: team, t: 'Add your team', s: 'Writers, managers and editors, with a temporary password each.', go: <Link className="btn sm" to="/settings#team">Open Team settings</Link> },
              { done: client, t: 'Add a client', s: 'Their brand voice and writing guidance go to every writer.', go: <button type="button" className="btn sm" onClick={() => openNew('client')}>Add a client</button> },
              { done: work, t: 'Schedule a shoot', s: 'Deadlines are worked out from the shoot date, and writers are told.', go: <button type="button" className="btn sm primary" disabled={!client} title={client ? undefined : 'Add a client first'} onClick={() => openNew('shoot')}>Schedule a shoot</button> },
            ];
            return (
              <section className="panel get-started" aria-label="Get started">
                <h2>Get started</h2>
                <ol>
                  {steps.map((x, i) => (
                    <li key={x.t} className={x.done ? 'done' : ''}>
                      <span className="n" aria-hidden>{x.done ? <CheckCheck /> : i + 1}</span>
                      <div><b>{x.t}</b><span>{x.s}</span></div>
                      {x.done ? <span className="muted">Done</span> : x.go}
                    </li>
                  ))}
                </ol>
              </section>
            );
          })()}
          <StatCards d={d} />

          <div className="dash ov-dash ov-first">
            <Panel className="a-chart"><DueChart draft={d.due.draft} final={d.due.final} today={clock.today} /></Panel>
            <Panel className="a-shoots" title="Upcoming shoots" sub="next 45 days">
              {!d.upcomingShoots.length ? (
                <Empty boxed icon={<Camera />} title="No shoots scheduled" action={isManager(me.role) ? <button className="btn sm" onClick={() => openNew('shoot')}>Schedule a shoot</button> : undefined} />
              ) : (
                <div className="rows">
                  {d.upcomingShoots.map((s) => {
                    const total = s.batches.reduce((n, b) => n + b.progress.total, 0);
                    const ready = s.batches.reduce((n, b) => n + b.progress.draftReady, 0);
                    const delivered = s.batches.reduce((n, b) => n + b.progress.delivered, 0);
                    const target = s.batchIds[0];
                    return (
                      <div key={s.id} className="item with-tile clickable" onClick={() => target && nav(`/batches/${target}`)} role="link" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter' && target) nav(`/batches/${target}`); }}>
                        <DateTile date={s.startDate} />
                        <div className="body">
                          <div className="title">{s.clientName}</div>
                          <div className="meta"><span>{fmtRange(s.startDate, s.endDate)}</span></div>
                          <div className="meta num">{total ? `${ready} / ${total} drafts · ${delivered} delivered` : 'No scripts planned yet'}{s.batches.some((b) => b.progress.unassigned) ? ` · ${s.batches.reduce((n, b) => n + b.progress.unassigned, 0)} unassigned` : ''}</div>
                        </div>
                        <div className="side">
                          <Chip color={s.daysUntil <= 3 ? 'yellow' : 'plain'}>{s.daysUntil === 0 ? 'Today' : s.daysUntil === 1 ? 'Tomorrow' : `In ${s.daysUntil} days`}</Chip>
                          {!s.batches.length && isManager(me.role) && <button type="button" className="btn sm salmon" onClick={(e) => { e.stopPropagation(); openNew('batch', { clientId: s.clientId, shootId: s.id }); }}>Add scripts</button>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </Panel>
          </div>
          <div className="ov-top">
            <Panel className="ov-attn" title="Needs attention" sub={d.attention.length ? 'most urgent first' : undefined} count={d.attention.length} tools={d.unassignedScripts ? <Chip color="pink">{plural(d.unassignedScripts, 'unassigned script')}</Chip> : undefined}>
              {!d.attention.length ? (
                <Empty boxed icon={<CheckCheck />} title="Nothing needs you right now">No overdue, blocked or unassigned work.</Empty>
              ) : (
                <div className="rows">
                  {d.attention.map((a) => <AttentionRow key={a.batch.id} a={a} />)}
                </div>
              )}
            </Panel>
            <div className="ov-today">
              <TodayPill />
                {d.scope === 'mine' ? <TodoPanel title="Your to-dos" /> : <TodoPanel all title="Team to-dos" sub="open, for everyone" />}
            </div>
          </div>
          {isManager(me.role) && <CalendarShootsPanel siteShoots={d.upcomingShoots.filter((s) => !s.batches.length)} batches={d.activeBatches} />}
          <div className="dash ov-dash">
              <Panel title={d.scope === 'mine' ? 'Your workload' : 'Writer workload'}>
                {!d.workload.length ? <Empty boxed title="No writers yet"><Link className="link" to="/settings#team">Add your team in Settings → Team</Link>.</Empty> : (
                  <div className="rows">
                    {d.workload.map((w) => (
                      <Link key={w.userId} to={`/production?writerId=${w.userId}&view=table`} className={`item clickable ${w.overdueScripts ? 'edge-red' : w.overCapacity ? 'edge-yellow' : ''}`}>
                        <div className="body">
                          <div className="row-flex s2" style={{ flexWrap: 'nowrap' }}><Avatar name={w.name} id={w.userId} small /><span className="title">{w.name}</span>{w.role !== 'writer' && <span className="muted" style={{ fontSize: 12 }}>{ROLE_LABEL[w.role]}</span>}</div>
                          <div className="meta num">
                            <span>{plural(w.activeBatches, 'batch', 'batches')}</span>
                            <span>{w.assigned} assigned</span>
                            <span><b style={{ color: 'var(--text)' }}>{w.remaining}</b> left to write</span>
                            {w.toDeliver > 0 && <span>{w.toDeliver} to deliver</span>}
                          </div>
                          <div className="meta">
                            {w.overdueScripts > 0 && <Chip color="red" icon={<AlertTriangle aria-hidden />}>{w.overdueScripts} overdue</Chip>}
                            {w.blockedBatches > 0 && <Chip color="red">{w.blockedBatches} blocked</Chip>}
                            {w.overCapacity && <Chip color="yellow">Over capacity: {w.dueNext7} due in 7 days vs {w.capacityNext7}</Chip>}
                            {!w.overCapacity && w.capacityNext7 != null && <span className="num">{w.dueNext7} due in 7 days · capacity {w.capacityNext7}</span>}
                          </div>
                        </div>
                        <div className="side">
                          {w.nextDeadline ? <><span className="when">{w.nextDeadline.kind === 'draft' ? 'Drafts' : 'Final'} {fmtDate(w.nextDeadline.date, clock.today)}</span><span className="muted ellipsis" style={{ fontSize: 12, maxWidth: 160 }}>{w.nextDeadline.clientName}</span></> : <span className="muted" style={{ fontSize: 12.5 }}>No deadlines</span>}
                        </div>
                      </Link>
                    ))}
                  </div>
                )}
              </Panel>
              <Panel title={d.scope === 'mine' ? 'Your recent deliveries' : 'Recent deliveries'} sub="confirmed in Timeliner">
                {!d.recentDeliveries.length ? <Empty boxed icon={<Send />} title="No deliveries yet" /> : (
                  <div className="rows">
                    {d.recentDeliveries.slice(0, 6).map((x) => (
                      <Link key={x.id} to={`/batches/${x.batchId}`} className="item clickable edge-mint">
                        <div className="body">
                          <div className="top">{x.clientName}</div>
                          <div className="title">{x.batchTitle}</div>
                          <div className="meta"><span>{scriptsLabel(x.scriptNumbers)}</span><span>by {x.confirmedByName}</span></div>
                        </div>
                        <div className="side"><Chip color="mint" icon={<CheckCheck aria-hidden />}>{plural(x.scriptNumbers.length, 'script')}</Chip><span className="muted nowrap" style={{ fontSize: 12 }}>{fmtStamp(x.confirmedAt, displayTz)}</span></div>
                      </Link>
                    ))}
                  </div>
                )}
              </Panel>
          </div>
          <details className="ov-more">
            <summary><ChevronDown aria-hidden />More: active batches and writing progress</summary>
            <div className="ov-more-body">
            <Panel className="a-batches" title={d.scope === 'mine' ? 'Your active batches' : 'Active batches'} count={d.activeBatches.length} tools={<Link to="/production" className="btn sm ghost">Production board <ArrowRight size={14} /></Link>}>
              {!d.activeBatches.length ? (
                <Empty boxed icon={<Sparkles />} title="No active batches" action={isManager(me.role) ? <button className="btn sm" onClick={() => openNew('shoot')}>Create work</button> : undefined} />
              ) : (
                <div className="rows">{d.activeBatches.slice(0, 10).map((b) => <BatchItem key={b.id} b={b} ring />)}</div>
              )}
              {d.activeBatches.length > 10 && <div className="panel-foot"><Link className="btn sm ghost" to="/production?view=table">All {d.activeBatches.length} batches <ArrowRight size={14} /></Link></div>}
            </Panel>
              <Panel title={d.scope === 'mine' ? 'Your writing progress' : 'Writing progress'} sub="from the + / − counters"
                tools={d.activeBatches.some((b) => b.writtenToday) ? <TodayBump n={d.activeBatches.reduce((n, b) => n + b.writtenToday, 0)} /> : undefined}>
                <WritingFeed batches={d.activeBatches} />
                <PipLegend />
              </Panel>
            </div>
          </details>
        </>
      )}
    </>
  );
}
