// Master log (admins only): every change, page view, sign-in and blocked
// attempt, newest first, filterable by person and kind.

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Ban, Eye, KeyRound, Lock, Pencil, ScrollText } from 'lucide-react';
import { api, qs } from '../api';
import type { AuditEntry } from '../../../shared/types';
import { fmtWeekday } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Chip, Empty, ErrorState, Loading, Panel, Seg } from '../components/ui';

type Kind = 'all' | AuditEntry['kind'];
const KINDS: { k: Kind; label: string }[] = [
  { k: 'all', label: 'Everything' }, { k: 'change', label: 'Changes' }, { k: 'view', label: 'Views' }, { k: 'auth', label: 'Sign-ins' }, { k: 'denied', label: 'Blocked' },
];
const KIND_CHIP: Record<AuditEntry['kind'], { label: string; color: string; icon: React.ReactNode }> = {
  change: { label: 'Changed', color: 'cyan', icon: <Pencil aria-hidden /> },
  view: { label: 'Viewed', color: 'neutral', icon: <Eye aria-hidden /> },
  auth: { label: 'Sign-in', color: 'lavender', icon: <KeyRound aria-hidden /> },
  denied: { label: 'Blocked', color: 'red', icon: <Ban aria-hidden /> },
};

function localParts(iso: string, timeZone: string) {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(d);
  return { day, time };
}

export function MasterLogPage() {
  const { me, users, settings, clock } = useBoot();
  const [kind, setKind] = useState<Kind>('all');
  const [userId, setUserId] = useState('');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 250); return () => clearTimeout(t); }, [text]);
  const owner = me.role === 'owner';
  const log = useInfiniteQuery({
    queryKey: ['audit', kind, userId, q],
    enabled: owner,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ entries: AuditEntry[]; nextBefore: string | null }>(`/api/audit${qs({ kind, userId: userId || null, q: q || null, before: pageParam })}`),
    getNextPageParam: (last) => last.nextBefore,
    refetchInterval: 60_000,
  });
  if (!owner) {
    return <><PageHeader title="Master log" /><Panel><Empty icon={<Lock />} title="Only admins can see the master log" /></Panel></>;
  }
  const entries = log.data?.pages.flatMap((p) => p.entries) ?? [];
  const seen = new Set<string>();
  const unique = entries.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  let lastDay = '';
  return (
    <>
      <PageHeader title="Master log" sub="Every change, view and sign-in by everyone on the team. Only admins can see this page." hideNewWork />
      <Panel>
        <div className="filters row-flex s2" style={{ marginBottom: 16 }}>
          <Seg role="group" aria-label="Show">
            {KINDS.map((x) => <button key={x.k} type="button" aria-pressed={kind === x.k} onClick={() => setKind(x.k)}>{x.label}</button>)}
          </Seg>
          <select className="select sm" style={{ width: 'auto' }} aria-label="Person" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Everyone</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.name}{u.removed ? ' (removed)' : !u.active ? ' (deactivated)' : ''}</option>)}
          </select>
          <input className="input sm" type="search" style={{ width: 220 }} placeholder="Search the log…" aria-label="Search the log" value={text} onChange={(e) => setText(e.target.value)} />
        </div>
        {log.isLoading && <Loading height={360} />}
        {log.isError && <ErrorState error={log.error} retry={() => log.refetch()} />}
        {log.data && !unique.length && <Empty boxed icon={<ScrollText />} title="Nothing matches">Try another filter.</Empty>}
        {unique.length > 0 && (
          <div className="stack s2">
            {unique.map((e) => {
              const { day, time } = localParts(e.at, settings.timezone);
              const header = day !== lastDay ? (day === clock.today ? 'Today' : fmtWeekday(day)) : null;
              lastDay = day;
              const chip = KIND_CHIP[e.kind];
              return (
                <div key={e.id}>
                  {header && <div className="log-day">{header}</div>}
                  <div className="log-row">
                    <span className="w">{time}</span>
                    <span className="who">{e.userName ?? 'Someone'}</span>
                    <span className="what">{e.link ? <Link className="link" to={e.link}>{e.summary}</Link> : e.summary}{e.ip && e.kind !== 'view' ? <span className="muted" style={{ fontSize: 12 }}> · {e.ip}</span> : null}</span>
                    <Chip color={chip.color} icon={chip.icon}>{chip.label}</Chip>
                  </div>
                </div>
              );
            })}
            {log.hasNextPage && <Button style={{ alignSelf: 'center', marginTop: 10 }} busy={log.isFetchingNextPage} onClick={() => log.fetchNextPage()}>Load older</Button>}
          </div>
        )}
      </Panel>
    </>
  );
}
