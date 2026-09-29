// Resources: search every client and batch resource, plus briefing
// recordings and documents. Each result links back to the record it belongs
// to — nothing is duplicated.

import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, FileText, FolderOpen, Image, Link2, PlayCircle } from 'lucide-react';
import { api, qs } from '../api';
import type { Resource, ResourceCategory } from '../../../shared/types';
import { RESOURCE_CATEGORIES, RESOURCE_LABEL } from '../../../shared/types';
import { fmtBytes, fmtDate, fmtStamp } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Empty, ErrorState, Loading, Panel } from '../components/ui';

type BriefingLink = { briefingId: number; briefingTitle: string; clientId: number; clientName: string; kind: 'recording' | 'document'; url: string; callDate: string | null };

const ICON: Record<ResourceCategory, typeof Link2> = { folder: FolderOpen, example: FileText, asset: Image, recording: PlayCircle, document: FileText, other: Link2 };

export function ResourcesPage() {
  const { clients, settings } = useBoot();
  const [params, setParams] = useSearchParams();
  const [text, setText] = useState(params.get('q') ?? '');
  const q = params.get('q') ?? '';
  const clientId = params.get('clientId') ?? '';
  const category = params.get('category') ?? '';
  useEffect(() => { const t = setTimeout(() => { const p = new URLSearchParams(params); if (text) p.set('q', text); else p.delete('q'); setParams(p, { replace: true }); }, 250); return () => clearTimeout(t); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const res = useQuery({ queryKey: ['resources', q, clientId, category], queryFn: () => api<{ resources: Resource[]; briefingLinks: BriefingLink[] }>(`/api/resources${qs({ q, clientId, category })}`) });
  const count = (res.data?.resources.length ?? 0) + (res.data?.briefingLinks.length ?? 0);
  return (
    <>
      <PageHeader title="Resources" sub="Folders, examples, assets, recordings and documents — each linked to the client, briefing or batch it belongs to." />
      <div className="filters" role="search">
        <input className="input search" type="search" placeholder="Search titles, clients, batches, file names" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search resources" />
        <select className="select" value={clientId} onChange={(e) => set('clientId', e.target.value)} aria-label="Client"><option value="">All clients</option>{clients.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select className="select" value={category} onChange={(e) => set('category', e.target.value)} aria-label="Type"><option value="">All types</option>{RESOURCE_CATEGORIES.map((c) => <option key={c} value={c}>{RESOURCE_LABEL[c]}</option>)}</select>
      </div>
      {res.isLoading && <Loading />}
      {res.isError && <ErrorState error={res.error} retry={() => res.refetch()} />}
      {res.data && (
        <Panel title="Results" count={count}>
          {!count ? <Empty boxed icon={<FolderOpen />} title={q ? `Nothing matches “${q}”` : 'No resources yet'}>Add links and files from a client, briefing or batch page.</Empty> : (
            <div className="rows">
              {res.data.briefingLinks.map((b) => {
                const Icon = ICON[b.kind];
                return (
                  <div key={`${b.briefingId}-${b.kind}`} className="res">
                    <span className="ic" style={{ ['--c' as string]: b.kind === 'recording' ? 'var(--salmon)' : 'var(--cyan)' }}><Icon /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{b.briefingTitle} · {b.kind === 'recording' ? 'Recording' : 'Document'}</div>
                      <div className="s"><Link className="link" to={`/clients/${b.clientId}`}>{b.clientName}</Link> › briefing{b.callDate ? ` · call ${fmtDate(b.callDate)}` : ''}</div>
                    </div>
                    <a className="btn sm" href={b.url} target="_blank" rel="noopener noreferrer">Open<ExternalLink aria-hidden /></a>
                  </div>
                );
              })}
              {res.data.resources.map((r) => {
                const Icon = ICON[r.category];
                const href = r.kind === 'file' ? `/api/files/${r.fileId}` : r.url!;
                return (
                  <div key={r.id} className="res">
                    <span className="ic"><Icon /></span>
                    <div style={{ minWidth: 0 }}>
                      <div className="t">{r.title}</div>
                      <div className="s">
                        <Link className="link" to={`/clients/${r.clientId}`}>{r.clientName}</Link>
                        {r.batchId && <> › <Link className="link" to={`/batches/${r.batchId}`}>{r.batchTitle}</Link></>}
                        {r.briefingTitle && <> › {r.briefingTitle}</>}
                        {' · '}{RESOURCE_LABEL[r.category]}{r.kind === 'file' ? ` · ${fmtBytes(r.fileSize)}` : ''} · {r.createdByName}, {fmtStamp(r.createdAt, settings.timezone)}
                      </div>
                    </div>
                    <a className="btn sm" href={href} target="_blank" rel="noopener noreferrer">{r.kind === 'file' ? 'Open file' : 'Open'}<ExternalLink aria-hidden /></a>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
