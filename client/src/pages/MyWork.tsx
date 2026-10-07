// My work: a writer's scripts, newest work first. Work just given to them sits
// at the top under "New work"; then the batches that need something from them
// (sent back, to write, to deliver), soonest deadline first; then work that's
// only waiting on a review; and what they've finished at the bottom. Managers
// who also write use the same view, and can look at any writer's.

import { useId, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, Camera, CheckCheck, ChevronDown, ClipboardCheck, FileText, PenLine, PlayCircle, Plus, Send, Sparkles, Type } from 'lucide-react';
import { api, useSave } from '../api';
import type { MyWork, Script } from '../../../shared/types';
import { compressRanges, isApproved, isManager, isNewWork, NEW_WORK_DAYS, type Milestone } from '../../../shared/workflow';
import { diffDays, type ISODate } from '../../../shared/dates';
import { fmtAgo, fmtDate, fmtStamp, fmtWeekday, plural } from '../../../shared/format';
import { TodayPill } from '../components/TodayPill';
import { TodoPanel } from '../components/Todos';
import { WrittenCounter } from '../components/WrittenCounter';
import { PageHeader, useBoot, useDisplayTz } from '../components/Shell';
import { Button, Chip, Empty, ErrorState, ExtLink, LiquidBar, Loading, Panel, useToast } from '../components/ui';
import { CardList, SendDialog, SentBackCard, TitlesDialog, WaitingCard } from '../components/Review';
import { DeliverDialog } from './BatchDetail';
import { confetti } from '../fx';

type Entry = MyWork['batches'][number];
type Kind = 'new' | 'todo' | 'waiting' | 'done';

const nums = (list: Script[]) => compressRanges(list.map((s) => s.number));
const scriptsLabel = (list: Script[]) => (list.length === 1 ? `script ${nums(list)}` : `scripts ${nums(list)}`);
const writtenOf = (e: Entry, writerId: number) => e.batch.writers.find((w) => w.userId === writerId)?.written ?? e.myProgress.draftReady;
const lastAssigned = (list: Script[]) => list.reduce<string | null>((a, s) => (s.assignedAt && (!a || s.assignedAt > a) ? s.assignedAt : a), null);

/** Where my scripts in a batch are, in the order a writer works through them. */
function split(mine: Script[]) {
  return {
    notSent: mine.filter((s) => s.status === 'not_started' || s.status === 'in_progress'),
    inReview: mine.filter((s) => s.status === 'ready_for_review'),
    sentBack: mine.filter((s) => s.status === 'revisions_needed'),
    approved: mine.filter((s) => s.status === 'approved'),
    delivered: mine.filter((s) => s.status === 'delivered'),
  };
}

function kindOf(e: Entry, writerId: number, now: Date): Kind {
  const st = split(e.mine);
  if (!e.mine.length || st.delivered.length === e.mine.length) return 'done';
  if (isNewWork(e.mine, writtenOf(e, writerId), now)) return 'new';
  return st.notSent.length + st.sentBack.length + st.approved.length > 0 ? 'todo' : 'waiting';
}

export function MyWorkPage() {
  const displayTz = useDisplayTz();
  const { me, users } = useBoot();
  const [params, setParams] = useSearchParams();
  const viewing = isManager(me.role) && params.get('userId') ? Number(params.get('userId')) : me.id;
  const self = viewing === me.id;
  const q = useQuery({ queryKey: ['my-work', viewing], queryFn: () => api<MyWork>(`/api/my-work${!self ? `?userId=${viewing}` : ''}`) });
  const who = users.find((u) => u.id === viewing);
  const now = new Date();
  const by: Record<Kind, Entry[]> = { new: [], todo: [], waiting: [], done: [] };
  for (const e of q.data?.batches ?? []) by[kindOf(e, viewing, now)].push(e);
  const summary = [
    by.new.length && `${plural(by.new.length, 'new batch', 'new batches')}`,
    by.todo.length && `${by.todo.length} to work on`,
    by.waiting.length && `${by.waiting.length} waiting on review`,
  ].filter(Boolean).join(' · ');
  const first = who?.name.split(' ')[0] ?? 'Their';

  return (
    <>
      <PageHeader title={self ? 'My work' : `${who?.name ?? 'Writer'}’s work`}
        sub={!self ? `Viewing as a manager. Updates are recorded under your name.${summary ? ` ${summary}.` : ''}` : summary || 'Your scripts, what’s due, and everything you need to write them.'}>
        {isManager(me.role) && (
          <select className="select sm" style={{ width: 'auto' }} aria-label="Show work for" value={viewing} onChange={(e) => setParams(Number(e.target.value) === me.id ? {} : { userId: e.target.value })}>
            {users.filter((u) => u.active && u.role !== 'editor').map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? `Me (${u.name})` : u.name}</option>)}
          </select>
        )}
      </PageHeader>
      {q.isLoading && <Loading height={420} />}
      {q.isError && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {q.data && (
        <div className={`mw${by.new.length ? ' has-new' : ''}`}>
          {by.new.length > 0 && (
            <Section className="mw-new" tone="new" icon={<Sparkles aria-hidden />} title="New work" count={by.new.length}
              sub={self ? 'Just assigned to you. Start here.' : `Just assigned to ${first}.`}>
              {by.new.map((e) => <WorkCard key={e.batch.id} e={e} writerId={viewing} fresh />)}
            </Section>
          )}

          <aside className="mw-side" aria-label="Today and to-dos">
            <TodayPill userId={!self ? viewing : undefined} />
            <TodoPanel userId={viewing} hideWhenEmpty title={self ? 'Your to-dos' : `${first}’s to-dos`} />
          </aside>

          <div className="mw-main">
            {!q.data.batches.length && <Panel><Empty icon={<CheckCheck />} title="Nothing assigned right now">New assignments show up at the top of this page and in your notifications.</Empty></Panel>}
            {q.data.batches.length > 0 && !by.new.length && !by.todo.length && (
              <div className="mw-clear"><CheckCheck aria-hidden /><div><b>You’re all caught up.</b><span>{by.waiting.length ? 'Everything you’ve sent is with a manager. Anything sent back shows up here.' : 'Nothing left to write or deliver.'}</span></div></div>
            )}
            {by.todo.length > 0 && (
              <Section tone="todo" icon={<PenLine aria-hidden />} title="To do" count={by.todo.length} sub="Soonest deadline first">
                {by.todo.map((e) => <WorkCard key={e.batch.id} e={e} writerId={viewing} />)}
              </Section>
            )}
            {by.waiting.length > 0 && (
              <Section tone="waiting" icon={<ClipboardCheck aria-hidden />} title="Waiting on review" count={by.waiting.length} sub="Nothing to do until a manager reviews them">
                {by.waiting.map((e) => <WorkCard key={e.batch.id} e={e} writerId={viewing} collapsible />)}
              </Section>
            )}
            {(by.done.length > 0 || q.data.recentDeliveries.length > 0) && (
              <Section tone="done" icon={<CheckCheck aria-hidden />} title="Finished" sub="Delivered in the last week">
                <div className="rows">
                  {by.done.map((e) => (
                    <Link key={e.batch.id} to={`/batches/${e.batch.id}`} className="item clickable edge-mint">
                      <div className="body"><div className="top">{e.batch.clientName}</div><div className="title">{e.batch.title}</div><div className="meta">{plural(e.myProgress.total, 'script')} delivered{e.batch.stage !== 'delivered' ? ' · others still working on this batch' : ''}</div></div>
                      <div className="side"><Chip color="mint" icon={<CheckCheck aria-hidden />}>Done</Chip></div>
                    </Link>
                  ))}
                </div>
                {q.data.recentDeliveries.length > 0 && (
                  <>
                    <div className="section-title" style={{ marginTop: by.done.length ? 18 : 0 }}>{self ? 'Your delivery confirmations' : 'Delivery confirmations'}</div>
                    <div className="rows">{q.data.recentDeliveries.map((d) => (
                      <div key={d.id} className="item edge-mint">
                        <div className="body"><div className="top">{d.clientName}</div><div className="title">{d.batchTitle}</div><div className="meta">Scripts {compressRanges(d.scriptNumbers) || '—'} · {fmtStamp(d.confirmedAt, displayTz)}</div></div>
                        <div className="side"><Chip color="mint">Writer-confirmed</Chip></div>
                      </div>
                    ))}</div>
                  </>
                )}
              </Section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function Section({ title, sub, count, icon, tone, className = '', children }: { title: string; sub?: string; count?: number; icon: ReactNode; tone: Kind; className?: string; children: ReactNode }) {
  const id = useId();
  return (
    <section className={`mw-sec tone-${tone} ${className}`} aria-labelledby={id}>
      <div className="mw-sec-head">
        <span className="ic">{icon}</span>
        <h2 id={id}>{title}</h2>
        {count != null && <span className="count num">{count}</span>}
        {sub && <span className="sub">{sub}</span>}
      </div>
      <div className="mw-sec-body">{children}</div>
    </section>
  );
}

/** The next deadline, big enough to read at a glance. */
function NextDue({ m, today }: { m: Milestone | null; today: ISODate }) {
  if (!m) return <div className="wc-due done"><span className="k">All delivered</span><span className="v"><CheckCheck aria-hidden /></span></div>;
  const what = m.kind === 'draft' ? 'Drafts due' : 'Final delivery';
  if (!m.date) return <div className="wc-due"><span className="k">{what}</span><span className="v muted">No date yet</span></div>;
  const n = diffDays(m.date, today);
  const tone = m.complete ? 'done' : m.overdue ? 'late' : m.dueToday || n <= 2 ? 'soon' : '';
  const rel = m.complete ? 'Done' : m.overdue ? `${plural(-n || 1, 'day')} overdue` : n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;
  return (
    <div className={`wc-due ${tone}`}>
      <span className="k">{what}</span>
      <span className="v">{fmtWeekday(m.date)}</span>
      <span className="r">{m.overdue && <AlertTriangle aria-hidden />}{rel}</span>
    </div>
  );
}

function WorkCard({ e, writerId, fresh, collapsible }: { e: Entry; writerId: number; fresh?: boolean; collapsible?: boolean }) {
  const { clock, me } = useBoot();
  const toast = useToast();
  const b = e.batch;
  const st = split(e.mine);
  const total = e.mine.length;
  const written = writtenOf(e, writerId);
  const sendable = e.mine.filter((s) => !isApproved(s.status));
  const [open, setOpen] = useState(!collapsible);
  const [showReview, setShowReview] = useState(false);
  const bodyId = useId();
  const [dialog, setDialog] = useState<null | { kind: 'send'; preselect: number[]; resend?: boolean } | { kind: 'titles' } | { kind: 'deliver' }>(null);
  const deliver = useSave((v: { url: string | null; note: string | null }) => api<{ changed: number[] }>(`/api/batches/${b.id}/scripts/action`, {
    body: { action: 'deliver', scriptIds: st.approved.map((s) => s.id), timelinerUrl: v.url, note: v.note, versions: Object.fromEntries(st.approved.map((s) => [s.id, s.version])) },
  }), { onSuccess: (o) => { confetti({ y: innerHeight * 0.55, count: 70, spread: 120, power: 13 }); toast(o.changed.length > st.approved.length ? `Delivery confirmed for all ${o.changed.length} approved scripts in this batch` : `Delivery confirmed for scripts ${nums(st.approved)}`); setDialog(null); } });
  const waiting = e.groups.filter((g) => g.kind === 'waiting');
  const sentBack = e.groups.filter((g) => g.kind === 'sent_back');
  const assigned = lastAssigned(e.mine);
  const cut = Date.now() - NEW_WORK_DAYS * 86400_000;
  const newlyAdded = fresh ? 0 : st.notSent.filter((s) => s.assignedAt && Date.parse(s.assignedAt) >= cut).length;
  const tone = b.blocked || b.next?.overdue ? 'late' : b.next?.dueToday ? 'today' : '';
  const status = st.inReview.length ? `${st.inReview.length === total ? `All ${plural(total, 'script')}` : plural(st.inReview.length, 'script')} (${nums(st.inReview)}) with a manager for review` : '';

  return (
    <article className={`wc${fresh ? ' fresh' : ''}${tone ? ` ${tone}` : ''}${open ? '' : ' closed'}`} aria-label={`${b.clientName}: ${b.title}`}>
      <header className="wc-head">
        <div className="wc-id">
          {(fresh || newlyAdded > 0 || b.blocked) && (
            <div className="wc-tags">
              {fresh && <span className="new-tag">New</span>}
              {fresh && assigned && <span className="wc-when">Assigned {fmtAgo(assigned)}</span>}
              {newlyAdded > 0 && <span className="new-tag soft">{plural(newlyAdded, 'new script')}</span>}
              {b.blocked && <Chip color="red">Blocked</Chip>}
            </div>
          )}
          <h3 className="wc-client">{b.clientName}</h3>
          <div className="wc-batch"><Link to={`/batches/${b.id}`}>{b.title}</Link><span aria-hidden> · </span><span className="num">{total === 1 ? 'your script' : `your ${total} scripts`} ({nums(e.mine)})</span></div>
        </div>
        <NextDue m={b.next} today={clock.today} />
      </header>

      {collapsible && (
        <button type="button" className="wc-toggle" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
          <span>{status || 'Waiting on a review'}</span>
          <span className="wc-toggle-cta">{open ? 'Hide details' : 'Details'}<ChevronDown aria-hidden /></span>
        </button>
      )}

      {open && (
        <div className="wc-body" id={bodyId}>
          {b.blocked && <div className="banner red"><AlertTriangle aria-hidden /><div className="txt"><b>Blocked{b.blockerNote ? `: ${b.blockerNote}` : ''}</b><span>Your manager is sorting this out.</span></div></div>}
          {!fresh && <ScriptStates st={st} total={total} written={written} />}

          <CardList groups={sentBack}>{(g) => <SentBackCard group={g} showBatch={false} onResend={() => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id), resend: true })} />}</CardList>

          {st.notSent.length > 0 && (
            <div className="wc-task write">
              <div className="wc-task-head">
                <span className="wc-task-ic"><PenLine aria-hidden /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{fresh ? `Write ${scriptsLabel(st.notSent)}` : `Write and send ${scriptsLabel(st.notSent)}`}</div>
                  <div className="s">Send them as one PDF or Google Doc link when they’re written. You can send some now and the rest later.</div>
                </div>
              </div>
              <div className="wc-task-actions">
                <WrittenCounter batchId={b.id} writerId={writerId} forOther={writerId !== me.id} total={total} sent={e.myProgress.draftReady} written={written} inline />
                <Button variant="primary pill" icon={<Send aria-hidden />} onClick={() => setDialog({ kind: 'send', preselect: st.notSent.map((s) => s.id) })}>Send for review</Button>
              </div>
            </div>
          )}

          {st.approved.length > 0 && (
            <div className="wc-task deliver">
              <div className="wc-task-head">
                <span className="wc-task-ic"><CheckCheck aria-hidden /></span>
                <div style={{ minWidth: 0 }}>
                  <div className="t">{plural(st.approved.length, 'script')} approved ({nums(st.approved)})</div>
                  <div className="s">Add {st.approved.length === 1 ? 'it' : 'them'} to Timeliner, then confirm here.</div>
                </div>
              </div>
              <div className="wc-task-actions end">
                <Button variant="primary pill" icon={<Send aria-hidden />} onClick={() => setDialog({ kind: 'deliver' })}>Mark {plural(st.approved.length, 'script')} delivered</Button>
              </div>
            </div>
          )}

          {waiting.length > 0 && (collapsible ? (
            <CardList groups={waiting}>{(g) => <WaitingCard group={g} showBatch={false} onReplace={() => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id) })} />}</CardList>
          ) : (
            <div className="wc-review">
              <button type="button" className="wc-review-line" aria-expanded={showReview} onClick={() => setShowReview(!showReview)}>
                <span className="d" aria-hidden /><span className="ellipsis">{status}</span>
                <span className="wc-toggle-cta">{showReview ? 'Hide' : 'Show'}<ChevronDown aria-hidden /></span>
              </button>
              {showReview && <CardList groups={waiting}>{(g) => <WaitingCard group={g} showBatch={false} onReplace={() => setDialog({ kind: 'send', preselect: g.scripts.map((s) => s.id) })} />}</CardList>}
            </div>
          ))}

          <Dates e={e} today={clock.today} />
          <Materials e={e} />

          <footer className="wc-foot">
            <Button variant="sm" icon={<Type aria-hidden />} onClick={() => setDialog({ kind: 'titles' })}>{e.mine.some((s) => s.title) ? 'Edit titles' : 'Add titles'}</Button>
            <Link to={`/batches/${b.id}`} className="btn sm ghost">Open batch <ArrowRight aria-hidden /></Link>
          </footer>
        </div>
      )}
      {dialog?.kind === 'send' && <SendDialog batchId={b.id} batchTitle={b.title} candidates={sendable} preselect={dialog.preselect} resend={dialog.resend} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'titles' && <TitlesDialog batchId={b.id} scripts={e.mine} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'deliver' && <DeliverDialog count={st.approved.length} extra={isManager(me.role) ? b.progress.awaitingDelivery - st.approved.length : 0} nums={nums(st.approved)} busy={deliver.isPending} error={deliver.error} onClose={() => setDialog(null)} onSubmit={(url, note) => deliver.mutate({ url, note })} />}
    </article>
  );
}

/** One bar for where my scripts are, with a plain-words key for the parts that have any. */
function ScriptStates({ st, total, written }: { st: ReturnType<typeof split>; total: number; written: number }) {
  const elsewhere = st.delivered.length + st.approved.length + st.inReview.length + st.sentBack.length;
  const writtenNotSent = Math.max(0, Math.min(st.notSent.length, written - elsewhere));
  const parts = [
    { k: 'Delivered', n: st.delivered.length, c: 'var(--mint)' },
    { k: 'Approved', n: st.approved.length, c: 'color-mix(in srgb, var(--mint) 55%, var(--track))' },
    { k: 'In review', n: st.inReview.length, c: 'var(--lavender)' },
    { k: 'Sent back', n: st.sentBack.length, c: 'var(--pink)' },
    { k: 'Written, not sent', n: writtenNotSent, c: 'color-mix(in srgb, var(--cyan) 70%, var(--track))' },
  ];
  const left = st.notSent.length - writtenNotSent;
  return (
    <div className="wc-states prog" role="group" aria-label={`Your ${total} scripts: ${[...parts, { k: 'not written yet', n: left }].filter((x) => x.n).map((x) => `${x.n} ${x.k.toLowerCase()}`).join(', ')}`}>
      <div className="wc-states-top">
        <span><b className="num">{Math.min(total, Math.max(written, elsewhere))}</b> of <b className="num">{total}</b> written</span>
      </div>
      <LiquidBar total={total} segs={parts.map((x) => ({ n: x.n, c: x.c }))} />
      <ul className="wc-key">
        {parts.filter((x) => x.n).map((x) => <li key={x.k} style={{ ['--c' as string]: x.c }}><i aria-hidden /><b className="num">{x.n}</b> {x.k.toLowerCase()}</li>)}
        {left > 0 && <li style={{ ['--c' as string]: 'var(--track)' }}><i aria-hidden className="hollow" /><b className="num">{left}</b> not written yet</li>}
      </ul>
    </div>
  );
}

/** The batch's dates in the order they happen. */
function Dates({ e, today }: { e: Entry; today: ISODate }) {
  const b = e.batch;
  const rel = (d: ISODate, m?: Milestone) => {
    if (m?.complete) return { t: 'Done', c: 'done' };
    const n = diffDays(d, today);
    if (n < 0) return { t: m ? `${plural(-n, 'day')} overdue` : `${plural(-n, 'day')} ago`, c: m ? 'late' : '' };
    return { t: n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`, c: m && n <= 2 ? 'soon' : '' };
  };
  type Item = { k: string; d: ISODate | null; c: string; icon: ReactNode; m?: Milestone };
  const items: Item[] = [];
  if (b.plannedStart) items.push({ k: 'Start writing', d: b.plannedStart, c: 'var(--cyan)', icon: <Plus /> });
  items.push({ k: 'Drafts due', d: b.draftDue, c: 'var(--lavender)', icon: <PenLine />, m: b.draft });
  items.push({ k: 'Final delivery', d: b.finalDue, c: 'var(--yellow)', icon: <Send />, m: b.final });
  if (b.shootStart) items.push({ k: b.shootEnd && b.shootEnd !== b.shootStart ? 'Shoot starts' : 'Shoot', d: b.shootStart, c: 'var(--salmon)', icon: <Camera /> });
  items.sort((x, y) => (x.d ?? '9999').localeCompare(y.d ?? '9999'));
  return (
    <ol className="wc-dates" aria-label="Dates">
      {items.map((x) => {
        const r = x.d ? rel(x.d, x.m) : null;
        return (
          <li key={x.k} style={{ ['--c' as string]: x.c }}>
            <span className="k"><span className="ic" aria-hidden>{x.icon}</span>{x.k}</span>
            <span className="v">{x.d ? fmtWeekday(x.d) : 'Not set'}{x.d && x.d.slice(0, 4) !== today.slice(0, 4) ? `, ${x.d.slice(0, 4)}` : ''}</span>
            {r && <span className={`r ${r.c}`}>{r.t}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The brief, the recording and the files, all in one place. */
function Materials({ e }: { e: Entry }) {
  const links = [
    ...e.briefings.flatMap((br) => [
      br.recordingUrl ? { key: `br${br.id}r`, href: br.recordingUrl, title: e.briefings.length > 1 ? `Recording · ${br.title}` : 'Call recording', rec: true, ext: true } : null,
      br.documentUrl ? { key: `br${br.id}d`, href: br.documentUrl, title: e.briefings.length > 1 ? `Brief · ${br.title}` : 'Brief document', rec: false, ext: true } : null,
      ...br.resources.map((r) => ({ key: `brr${r.id}`, href: r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!, title: r.title, rec: false, ext: false })),
    ]),
    ...e.resources.map((r) => ({ key: `r${r.id}`, href: r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!, title: r.title, rec: r.category === 'recording', ext: false })),
  ].filter((x): x is NonNullable<typeof x> => !!x);
  const notes = e.briefings.filter((br) => br.instructions);
  if (!links.length && !notes.length) return null;
  return (
    <div className="wc-materials">
      <div className="section-title">Brief &amp; files</div>
      {links.length > 0 && (
        <div className="wc-links">
          {links.map((l) => l.ext
            ? <ExtLink key={l.key} href={l.href} className={`btn sm${l.rec ? ' salmon' : ''}`}>{l.rec ? <PlayCircle aria-hidden /> : <FileText aria-hidden />}<span className="ellipsis">{l.title}</span></ExtLink>
            : <a key={l.key} className={`btn sm${l.rec ? ' salmon' : ''}`} href={l.href} target="_blank" rel="noopener noreferrer">{l.rec ? <PlayCircle aria-hidden /> : <FileText aria-hidden />}<span className="ellipsis">{l.title}</span></a>)}
        </div>
      )}
      {notes.map((br) => (
        <div key={br.id} className="wc-note">
          <div className="h">{br.title}{br.callDate && <span className="muted"> · call {fmtDate(br.callDate)}</span>}</div>
          <p className="prose">{br.instructions}</p>
        </div>
      ))}
    </div>
  );
}
