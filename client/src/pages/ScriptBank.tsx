// Script bank: every deliverable ever sent, across every client and batch.
// One row per document (a writer's PDF or link covering, say, scripts 1–45),
// newest version only, with the manager's approved edit beside it.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { ExternalLink, FileText, Library, Link2, PenLine } from 'lucide-react';
import { api, qs } from '../api';
import type { Deliverable, DeliverableState, ScriptBankPage } from '../../../shared/types';
import { fmtDate, fmtStamp, plural } from '../../../shared/format';
import { STATUS_SHORT, type ScriptStatus } from '../../../shared/workflow';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Chip, Empty, ErrorState, Loading, Panel } from '../components/ui';

const STATE: Record<DeliverableState, { label: string; color: string }> = {
  in_progress: { label: 'In progress', color: 'cyan' },
  in_review: { label: 'In review', color: 'lavender' },
  revisions: { label: 'Revisions', color: 'pink' },
  approved: { label: 'Approved', color: 'mint' },
  delivered: { label: 'Delivered', color: 'mint' },
};

const scriptNumber = (q: string) => (/^#?\d{1,4}$/.test(q) ? Number(q.replace('#', '')) : null);

export function ScriptBankPage() {
  const { clients, users, settings } = useBoot();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const search = useRef<HTMLInputElement>(null);
  const q = params.get('q') ?? '';
  const clientId = params.get('clientId') ?? '';
  const writerId = params.get('writerId') ?? '';
  const status = params.get('status') ?? '';
  const sort = params.get('sort') ?? 'recent';
  useEffect(() => {
    const t = setTimeout(() => { const p = new URLSearchParams(params); if (text.trim()) p.set('q', text.trim()); else p.delete('q'); setParams(p, { replace: true }); }, 220);
    return () => clearTimeout(t);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  // "/" jumps to the search box from anywhere on the page
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '/' && !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) && !t.isContentEditable) { e.preventDefault(); search.current?.focus(); }
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };

  const bank = useInfiniteQuery({
    queryKey: ['script-bank', q, clientId, writerId, status, sort],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => api<ScriptBankPage>(`/api/script-bank${qs({ q, clientId, writerId, status, sort: sort === 'recent' ? null : sort, offset: pageParam || null })}`),
    getNextPageParam: (last) => last.nextOffset,
    placeholderData: keepPreviousData,
  });
  const items = bank.data?.pages.flatMap((p) => p.deliverables) ?? [];
  const first = bank.data?.pages[0];
  const filtered = !!(q || clientId || writerId || status);
  const people = users.filter((u) => !u.removed).sort((a, b) => a.name.localeCompare(b.name));
  const num = scriptNumber(q);

  return (
    <>
      <PageHeader title="Script bank" sub="Every document your writers have sent, for every client. Search a client, batch, writer, title or script number." />
      <div className="filters bank-filters" role="search">
        <input ref={search} className="input search" type="search" autoFocus placeholder="Search, or #12 for script 12…" title="Press / to jump here" value={text}
          onChange={(e) => setText(e.target.value)} aria-label="Search by client, batch, writer, title or script number" />
        <select className="select" value={clientId} onChange={(e) => set('clientId', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'archived' ? ' (archived)' : ''}</option>)}
        </select>
        <select className="select" value={writerId} onChange={(e) => set('writerId', e.target.value)} aria-label="Writer">
          <option value="">All writers</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select className="select" value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="finished">Finished (approved or delivered)</option>
          <option value="in_review">In review</option>
          <option value="revisions">Sent back for revisions</option>
          <option value="open">Not finished yet</option>
        </select>
        <select className="select" value={sort} onChange={(e) => set('sort', e.target.value === 'recent' ? '' : e.target.value)} aria-label="Order">
          <option value="recent">Newest first</option>
          <option value="client">By client</option>
        </select>
        {filtered && <Button variant="ghost sm" onClick={() => { setText(''); setParams(new URLSearchParams(sort !== 'recent' ? { sort } : {}), { replace: true }); }}>Clear</Button>}
      </div>
      {bank.isLoading && <Loading />}
      {bank.isError && <ErrorState error={bank.error} retry={() => bank.refetch()} />}
      {first && (
        <Panel title="Deliverables" count={first.total} sub={first.scriptCount ? plural(first.scriptCount, 'script') : undefined} className={bank.isPlaceholderData ? 'is-refreshing' : ''}>
          {!items.length ? (
            <Empty boxed icon={<Library />} title={filtered ? 'Nothing matches' : 'Nothing sent yet'}>
              {filtered ? 'Try fewer words, or clear the filters.' : 'Documents appear here as soon as a writer sends their scripts for review.'}
            </Empty>
          ) : (
            <div className="rows bank">
              {items.map((d) => <DeliverableRow key={d.key} d={d} tz={settings.timezone} num={num} />)}
            </div>
          )}
          {bank.hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <Button onClick={() => bank.fetchNextPage()} busy={bank.isFetchingNextPage}>Show more ({first.total - items.length} left)</Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

/** "4 approved · 2 revisions" when the scripts in a document aren't all at the same step. */
function breakdown(scripts: Deliverable['scripts']): string {
  const counts = new Map<ScriptStatus, number>();
  for (const s of scripts) counts.set(s.status, (counts.get(s.status) ?? 0) + 1);
  if (counts.size < 2) return '';
  return [...counts.entries()].map(([s, n]) => `${n} ${STATUS_SHORT[s].toLowerCase()}`).join(' · ');
}

function DeliverableRow({ d, tz, num }: { d: Deliverable; tz: string; num: number | null }) {
  const st = STATE[d.state];
  const hit = num != null ? d.scripts.find((s) => s.number === num) : null;
  const mix = breakdown(d.scripts);
  return (
    <div className="bank-row">
      <span className="bank-num" aria-label={plural(d.scripts.length, 'script')}>
        <b>{d.scripts.length}</b><small>{d.scripts.length === 1 ? 'script' : 'scripts'}</small>
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="t">
          <Link className="link" to={`/clients/${d.clientId}`}>{d.clientName}</Link> <span className="dim">›</span> <Link className="link" to={`/batches/${d.batchId}`}>{d.batchTitle}</Link>
          {d.batchArchived && <span className="dim"> (archived)</span>}
        </div>
        <div className="s">
          Scripts {d.ranges} · {d.writerName ?? 'Unassigned'}{d.shootDate && <> · shoot {fmtDate(d.shootDate)}</>}
          {' · '}{d.version > 1 ? `version ${d.version}, ` : ''}sent {fmtStamp(d.sentAt, tz)}
          {d.name && <> · {d.name}</>}
        </div>
        {(hit || mix) && (
          <div className="s">
            {hit && <b className="bank-hit">Script {hit.number}{hit.title ? ` “${hit.title}”` : ''} is in here{mix ? ' · ' : ''}</b>}
            {mix}
          </div>
        )}
      </div>
      <div className="bank-tools">
        <Chip color={st.color} dot>{st.label}</Chip>
        <a className="btn sm primary" href={d.href} target="_blank" rel="noopener noreferrer">
          {d.kind === 'file' ? <FileText aria-hidden /> : <Link2 aria-hidden />}Open
        </a>
        {d.edited && (
          <a className="btn sm mint" href={d.edited.href} target="_blank" rel="noopener noreferrer" title={`Approved with edits ${fmtStamp(d.edited.at, tz)}`}>
            <PenLine aria-hidden />Approved edit
          </a>
        )}
        {d.timelinerUrl && <a className="btn sm" href={d.timelinerUrl} target="_blank" rel="noopener noreferrer">Timeliner<ExternalLink aria-hidden /></a>}
      </div>
    </div>
  );
}
