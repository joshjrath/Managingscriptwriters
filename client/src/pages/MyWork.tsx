// My work: what to do next, where each of my scripts is (not sent yet, in
// review, sent back, approved, delivered), sending scripts as one document,
// briefs and recordings, and delivery confirmation. Managers who also write
// use the same view.

import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Camera, CheckCheck, FileText, PenLine, PlayCircle, Plus, Send, Type } from 'lucide-react';
import { api, useSave } from '../api';
import type { MyWork, Script } from '../../../shared/types';
import { canSendDocument, compressRanges, isManager, type Milestone } from '../../../shared/workflow';
import { fmtDate, fmtLong, fmtRange, fmtStamp, fmtWeekday, plural } from '../../../shared/format';
import { TodayPill } from '../components/TodayPill';
import { TodoPanel } from '../components/Todos';
import { WrittenCounter } from '../components/WrittenCounter';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { BatchProgress, Button, Chip, CountUp, DueChip, Empty, ErrorState, ExtLink, Loading, Panel, Ring, ringColor, useToast } from '../components/ui';
import { CardList, SendDialog, SentBackCard, TitlesDialog, WaitingCard } from '../components/Review';
import { DeliverDialog } from './BatchDetail';
import { confetti } from '../fx';

type Entry = MyWork['batches'][number];

export function MyWorkPage() {
  const displayTz = useDisplayTz();
  const { me, users, clock } = useBoot();
  const [params, setParams] = useSearchParams();
  const viewing = isManager(me.role) && params.get('userId') ? Number(params.get('userId')) : me.id;
  const q = useQuery({ queryKey: ['my-work', viewing], queryFn: () => api<MyWork>(`/api/my-work${viewing !== me.id ? `?userId=${viewing}` : ''}`) });
  const who = users.find((u) => u.id === viewing);
  const active = q.data?.batches.filter((e) => e.myProgress.delivered < e.myProgress.total) ?? [];
  const done = q.data?.batches.filter((e) => e.myProgress.delivered === e.myProgress.total) ?? [];
  const next = active[0];
  return (
    <>
      <PageHeader title={viewing === me.id ? 'My work' : `${who?.name ?? 'Writer'}’s work`} sub={viewing === me.id ? 'Your scripts, what’s due, and everything you need to write them.' : 'Viewing as a manager. Updates are recorded under your name.'}>
        {isManager(me.role) && (
          <select className="select sm" style={{ width: 'auto' }} aria-label="Show work for" value={viewing} onChange={(e) => setParams(Number(e.target.value) === me.id ? {} : { userId: e.target.value })}>
            {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? `Me (${u.name})` : u.name}</option>)}
          </select>
        )}
      </PageHeader>
      {q.isLoading && <Loading height={420} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className="stack" style={{ gap: 'var(--gap)' }}>
          <TodayPill userId={viewing !== me.id ? viewing : undefined} />
          <TodoPanel userId={viewing} title={viewing === me.id ? 'Your to-dos' : `${who?.name.split(' ')[0] ?? 'Their'}’s to-dos`} />
          {!q.data.batches.length && <Panel><Empty icon={<CheckCheck />} title="Nothing assigned right now">New assignments show up here and in your notifications.</Empty></Panel>}
          {next && <NextUp e={next} today={clock.today} writerId={viewing} />}
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
                  <div className="body"><div className="top">{d.clientName}</div><div className="title">{d.batchTitle}</div><div className="meta">Scripts {compressRanges(d.scriptNumbers) || '—'} · {fmtStamp(d.confirmedAt, displayTz)}</div></div>
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

const nums = (list: Script[]) => compressRanges(list.map((s) => s.number));
const scriptsLabel = (list: Script[]) => (list.length === 1 ? `script ${nums(list)}` : `scripts ${nums(list)}`);

function dueText(m: Milestone, what: string, today: string) {
  if (!m.date) return `${what}: no date set`;
  if (m.complete) return `${what}: done`;
  if (m.overdue) return `${what} ${m.label.toLowerCase()} (${fmtDate(m.date, today)})`;
  if (m.dueToday) return `${what} due today`;
  return `${what} due ${fmtWeekday(m.date)}`;
}

/** Where my scripts in a batch are, in the order a writer works through them. */
function split(mine: Script[]) {
  return {
    notStarted: mine.filter((s) => s.status === 'not_started'),
    writing: mine.filter((s) => s.status === 'in_progress'),
    inReview: mine.filter((s) => s.status === 'ready_for_review'),
    sentBack: mine.filter((s) => s.status === 'revisions_needed'),
    approved: mine.filter((s) => s.status === 'approved'),
    delivered: mine.filter((s) => s.status === 'delivered'),
  };
}

const writtenOf = (e: Entry, writerId: number) => e.batch.writers.find((w) => w.userId === writerId)?.written ?? e.myProgress.draftReady;

function NextUp({ e, today, writerId }: { e: Entry; today: string; writerId: number }) {
  const b = e.batch;
  const recUrl = e.briefings.find((x) => x.recordingUrl)?.recordingUrl ?? e.resources.find((r) => r.category === 'recording' && r.url)?.url;
  const p = e.myProgress;
  const st = split(e.mine);
  const notSent = [...st.notStarted, ...st.writing];
  const doing = st.sentBack.length
    ? `Revise ${scriptsLabel(st.sentBack)} and send the new version`
    : notSent.length
      ? `Write ${scriptsLabel(notSent)} and send ${notSent.length === 1 ? 'it' : 'them'} for review`
      : st.approved.length
        ? `Add ${plural(st.approved.length, 'approved script')} to Timeliner and confirm delivery`
        : st.inReview.length ? 'Waiting for review' : 'All done';
  return (
    <section className="stat-card salmon" style={{ cursor: 'default', minHeight: 0, transform: 'none' }} aria-label="Next up">
      <span className="cap">Next up</span>
      <div className="row-flex" style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: 20 }}>
        <div style={{ minWidth: 0, flex: '1 1 320px' }}>
          <div style={{ font: '800 30px/1.1 var(--font-display)', letterSpacing: '-0.04em', overflowWrap: 'anywhere' }}>{doing}</div>
          <div className="sub" style={{ fontSize: 14, marginTop: 8 }}>{b.clientName} · {b.title}</div>
          <div className="sub" style={{ fontSize: 14, marginTop: 4 }}>{dueText(b.draft, 'Drafts', today)} · {dueText(b.final, 'Final delivery', today)}</div>
          <div className="sub num" style={{ fontSize: 14, marginTop: 4 }}>{writtenOf(e, writerId)} / {p.total} written · {p.draftReady} sent for review or approved</div>
        </div>
        <div className="row-flex s2">
          {recUrl && <ExtLink href={recUrl} className="btn"><PlayCircle aria-hidden />Recording</ExtLink>}
          <Link to={`/batches/${b.id}`} className="btn" style={{ background: 'var(--on-accent)', color: 'var(--text)' }}>Open batch <ArrowRight aria-hidden /></Link>
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
  const st = split(e.mine);
  const notSent = [...st.notStarted, ...st.writing];
  const sendable = e.mine.filter((s) => canSendDocument(s.status));
  const written = writtenOf(e, writerId);
  const [dialog, setDialog] = useState<null | { kind: 'send'; preselect: number[]; resend?: boolean } | { kind: 'titles' } | { kind: 'deliver' }>(null);
  const deliver = useSave((v: { url: string | null; note: string | null }) => api<{ changed: number[] }>(`/api/batches/${b.id}/scripts/action`, {
    body: { action: 'deliver', scriptIds: st.approved.map((s) => s.id), timelinerUrl: v.url, note: v.note, versions: Object.fromEntries(st.approved.map((s) => [s.id, s.version])) },
  }), { onSuccess: (o) => { confetti({ y: innerHeight * 0.55, count: 70, spread: 120, power: 13 }); toast(o.changed.length > st.approved.length ? `Delivery confirmed for all ${o.changed.length} approved scripts in this batch` : `Delivery confirmed for scripts ${nums(st.approved)}`); setDialog(null); } });
  const edge = b.next?.overdue || b.blocked ? 'edge-red' : b.next?.dueToday ? 'edge-yellow' : '';
  const waiting = e.groups.filter((g) => g.kind === 'waiting');
  const sentBack = e.groups.filter((g) => g.kind === 'sent_back');
  const tiles: { k: string; n: number; c: string; detail?: string }[] = [
    { k: 'Not sent', n: notSent.length, c: 'var(--neutral)', detail: notSent.length ? (written > p.draftReady ? `${written - p.draftReady} written so far` : 'none written yet') : undefined },
    { k: 'In review', n: st.inReview.length, c: 'var(--lavender)' },
    { k: 'Sent back', n: st.sentBack.length, c: 'var(--pink)' },
    { k: 'Approved', n: st.approved.length, c: 'color-mix(in srgb, var(--mint) 60%, var(--track))', detail: st.approved.length ? 'to deliver' : undefined },
    { k: 'Delivered', n: st.delivered.length, c: 'var(--mint)' },
  ];
  return (
    <Panel className={edge} title={b.title} sub={b.clientName} tools={<><DueChip m={b.next} today={clock.today} />{b.blocked && <Chip color="red">Blocked</Chip>}</>}>
      <div className="grid g-main-side" style={{ gap: 18 }}>
        <div className="stack s4">
          <div className="row-flex" style={{ gap: 18, flexWrap: 'nowrap', alignItems: 'center' }}>
            <Ring pct={p.pctDraft} color={ringColor(p)} size={64} stroke={7} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>Your scripts: {nums(e.mine)}</div>
              <BatchProgress p={p} written={written} />
            </div>
          </div>
          <div className="state-tiles" role="list" aria-label="Where your scripts are">
            {tiles.map((t) => (
              <div key={t.k} role="listitem" className={t.n ? '' : 'zero'} style={{ ['--c' as string]: t.c }}>
                <span className="k"><i />{t.k}</span>
                <span className="v num"><CountUp value={t.n} /></span>
                {t.detail && <span className="p">{t.detail}</span>}
              </div>
            ))}
          </div>
          {b.blocked && <div className="banner red"><div className="txt"><b>Blocked: {b.blockerNote}</b></div></div>}
          {notSent.length + st.sentBack.length > 0 && <WrittenCounter batchId={b.id} writerId={writerId} forOther={writerId !== me.id} total={p.total} sent={p.draftReady} written={written} />}

          <CardList groups={sentBack}>{(g) => <SentBackCard group={g} showBatch={false} onResend={() => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id), resend: true })} />}</CardList>

          {notSent.length > 0 && (
            <div className="todo-block">
              <div style={{ minWidth: 0 }}>
                <div className="t">{notSent.length === e.mine.length ? `All ${plural(notSent.length, 'script')}` : plural(notSent.length, 'script')} not sent yet <span className="muted num">({nums(notSent)})</span></div>
                <div className="s">When they’re written, send them as one PDF or Google Doc link. You can send some now and the rest later.</div>
              </div>
              <Button variant="primary pill" icon={<Send aria-hidden />} onClick={() => setDialog({ kind: 'send', preselect: notSent.map((s) => s.id) })}>Send for review</Button>
            </div>
          )}

          <CardList groups={waiting}>{(g) => <WaitingCard group={g} showBatch={false} onReplace={() => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id) })} />}</CardList>

          {st.approved.length > 0 && (
            <div className="todo-block mint">
              <div style={{ minWidth: 0 }}>
                <div className="t">{plural(st.approved.length, 'script')} approved <span className="muted num">({nums(st.approved)})</span></div>
                <div className="s">Add them to Timeliner, then confirm here.</div>
              </div>
              <Button variant="primary pill" icon={<Send aria-hidden />} onClick={() => setDialog({ kind: 'deliver' })}>Mark {plural(st.approved.length, 'script')} delivered</Button>
            </div>
          )}

          <div className="row-flex s2">
            <Button variant="sm" icon={<Type aria-hidden />} onClick={() => setDialog({ kind: 'titles' })}>{e.mine.some((s) => s.title) ? 'Edit titles' : 'Add titles'}</Button>
            <Link to={`/batches/${b.id}`} className="btn sm">Open batch</Link>
          </div>
        </div>
        <div className="stack s2">
          <div className="deadline-list">
            {b.shootStart && <div className="deadline" style={{ ['--c' as string]: 'var(--salmon)' }}><span className="ic"><Camera /></span><div><div className="k">Shoot</div><div className="v">{fmtRange(b.shootStart, b.shootEnd)}</div></div></div>}
            {b.plannedStart && <div className="deadline" style={{ ['--c' as string]: 'var(--cyan)' }}><span className="ic"><Plus /></span><div><div className="k">Start writing</div><div className="v">{fmtLong(b.plannedStart)}</div></div></div>}
            <div className="deadline" style={{ ['--c' as string]: 'var(--lavender)' }}><span className="ic"><PenLine /></span><div><div className="k">Drafts due</div><div className="v">{b.draftDue ? fmtLong(b.draftDue) : 'Not set'}</div></div><div className="right"><DueChip m={b.draft} today={clock.today} prefix={false} /></div></div>
            <div className="deadline" style={{ ['--c' as string]: 'var(--yellow)' }}><span className="ic"><Send /></span><div><div className="k">Final delivery</div><div className="v">{b.finalDue ? fmtLong(b.finalDue) : 'Not set'}</div></div><div className="right"><DueChip m={b.final} today={clock.today} prefix={false} /></div></div>
          </div>
          {e.resources.length > 0 && (
            <div className="stack s2" style={{ marginTop: 6 }}>
              <div className="section-title">Recording & files</div>
              <div className="links row-flex s2">
                {e.resources.map((r) => (
                  <a key={r.id} className={`btn sm${r.category === 'recording' ? ' salmon' : ''}`} href={r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!} target="_blank" rel="noopener noreferrer">
                    {r.category === 'recording' ? <PlayCircle aria-hidden /> : <FileText aria-hidden />}{r.title}
                  </a>
                ))}
              </div>
            </div>
          )}
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
      {dialog?.kind === 'send' && <SendDialog batchId={b.id} batchTitle={b.title} candidates={sendable} preselect={dialog.preselect} resend={dialog.resend} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'titles' && <TitlesDialog batchId={b.id} scripts={e.mine} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'deliver' && <DeliverDialog count={st.approved.length} extra={isManager(me.role) ? b.progress.awaitingDelivery - st.approved.length : 0} nums={nums(st.approved)} busy={deliver.isPending} error={deliver.error} onClose={() => setDialog(null)} onSubmit={(url, note) => deliver.mutate({ url, note })} />}
    </Panel>
  );
}

/**
 * "Written so far": a counter the writer taps to keep managers posted while
 * they work in their one master document. It never sends or changes scripts.
 */
