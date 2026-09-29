// Script bank: every script across every client and batch, searchable in one
// place, with its latest document (the writer's newest send, or the version a
// manager approved with edits) one click away.

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, keepPreviousData } from '@tanstack/react-query';
import { ExternalLink, FileText, Library, Link2, Send } from 'lucide-react';
import { api, qs } from '../api';
import type { ScriptBankItem, ScriptBankPage } from '../../../shared/types';
import { SCRIPT_STATUSES, STATUS_LABEL } from '../../../shared/workflow';
import { fmtDate, fmtStamp } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Empty, ErrorState, Loading, Panel, StatusChip } from '../components/ui';

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
  const scripts = bank.data?.pages.flatMap((p) => p.scripts) ?? [];
  const total = bank.data?.pages[0]?.total ?? 0;
  const filtered = !!(q || clientId || writerId || status);
  const people = users.filter((u) => !u.removed).sort((a, b) => a.name.localeCompare(b.name));

  return (
    <>
      <PageHeader title="Script bank" sub="Every script for every client in one place. Search by title, number, client, batch or writer." />
      <div className="filters bank-filters" role="search">
        <input ref={search} className="input search" type="search" autoFocus placeholder="Search scripts…" title="Press / to jump here" value={text}
          onChange={(e) => setText(e.target.value)} aria-label="Search scripts by title, number, client, batch or writer" />
        <select className="select" value={clientId} onChange={(e) => set('clientId', e.target.value)} aria-label="Client">
          <option value="">All clients</option>
          {clients.filter((c) => c.status !== 'prospect').map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'archived' ? ' (archived)' : ''}</option>)}
        </select>
        <select className="select" value={writerId} onChange={(e) => set('writerId', e.target.value)} aria-label="Writer">
          <option value="">All writers</option>
          {people.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          <option value="none">Unassigned</option>
        </select>
        <select className="select" value={status} onChange={(e) => set('status', e.target.value)} aria-label="Status">
          <option value="">Any status</option>
          <option value="finished">Finished (approved or delivered)</option>
          <option value="open">Still in progress</option>
          {SCRIPT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
        </select>
        <select className="select" value={sort} onChange={(e) => set('sort', e.target.value === 'recent' ? '' : e.target.value)} aria-label="Order">
          <option value="recent">Newest documents first</option>
          <option value="client">By client and batch</option>
        </select>
        {filtered && <Button variant="ghost sm" onClick={() => { setText(''); setParams(new URLSearchParams(sort !== 'recent' ? { sort } : {}), { replace: true }); }}>Clear</Button>}
      </div>
      {bank.isLoading && <Loading />}
      {bank.isError && <ErrorState error={bank.error} retry={() => bank.refetch()} />}
      {bank.data && (
        <Panel title="Scripts" count={total} className={bank.isPlaceholderData ? 'is-refreshing' : ''}>
          {!scripts.length ? (
            <Empty boxed icon={<Library />} title={filtered ? 'No scripts match' : 'No scripts yet'}>
              {filtered ? 'Try fewer words, or clear the filters.' : 'Scripts appear here as soon as a batch is planned.'}
            </Empty>
          ) : (
            <div className="rows bank">
              {scripts.map((s) => <BankRow key={s.id} s={s} tz={settings.timezone} />)}
            </div>
          )}
          {bank.hasNextPage && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <Button onClick={() => bank.fetchNextPage()} busy={bank.isFetchingNextPage}>Show more ({total - scripts.length} left)</Button>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}

function BankRow({ s, tz }: { s: ScriptBankItem; tz: string }) {
  const doc = s.document;
  return (
    <div className="bank-row">
      <span className="bank-num" aria-label={`Script ${s.number}`}>#{s.number}</span>
      <div style={{ minWidth: 0 }}>
        <div className="t">{s.title ?? <span className="dim">Untitled script</span>}</div>
        <div className="s">
          <Link className="link" to={`/clients/${s.clientId}`}>{s.clientName}</Link>
          {' › '}<Link className="link" to={`/batches/${s.batchId}`}>{s.batchTitle}</Link>
          {s.batchArchived && ' (archived)'}
          {' · '}{s.writerName ?? 'Unassigned'}
          {s.shootDate && <> · shoot {fmtDate(s.shootDate)}</>}
        </div>
        {doc && (
          <div className="s">
            {doc.edited ? 'Approved with edits' : `Sent${doc.version && doc.version > 1 ? ` · version ${doc.version}` : ''}`} {fmtStamp(doc.at, tz)}
            {doc.name && <> · {doc.name}</>}
          </div>
        )}
      </div>
      <div className="bank-tools">
        <StatusChip status={s.status} />
        {doc ? (
          <a className="btn sm primary" href={doc.href} target="_blank" rel="noopener noreferrer">
            {doc.kind === 'file' ? <FileText aria-hidden /> : <Link2 aria-hidden />}Open script
          </a>
        ) : (
          s.status === 'not_started' || s.status === 'in_progress'
            ? <span className="bank-none" title="The writer hasn’t sent this script yet"><Send aria-hidden />Not sent yet</span>
            : <span className="bank-none" title="This script was tracked without a document attached">No document</span>
        )}
        {s.timelinerUrl && <a className="btn sm" href={s.timelinerUrl} target="_blank" rel="noopener noreferrer">Timeliner<ExternalLink aria-hidden /></a>}
      </div>
    </div>
  );
}
