// How writing is moving: one pip per script (delivered → approved → sent →
// sent back → written → still to write), with the ones a writer counted today lit up,
// plus the "+3 today" badge and the Overview's feed of counter updates.

import { Link } from 'react-router-dom';
import type { BatchSummary, WriterShare } from '../../../shared/types';
import { fmtAgo, plural } from '../../../shared/format';
import { Avatar } from './ui';

type PipCounts = Pick<WriterShare, 'count' | 'draftReady' | 'approved' | 'delivered' | 'revisions' | 'written' | 'writtenToday'>;

const KINDS = ['delivered', 'approved', 'sent', 'back', 'written', 'todo'] as const;
type Kind = (typeof KINDS)[number];
const KIND_LABEL: Record<Kind, string> = { delivered: 'Delivered', approved: 'Approved', sent: 'Sent for review', back: 'Sent back for revisions', written: 'Written, not sent', todo: 'Still to write' };

export function ScriptPips({ w, large }: { w: PipCounts; large?: boolean }) {
  const back = w.revisions ?? 0;
  // the counter includes scripts that were later sent back, so they don't count again as "written, not sent"
  const written = Math.max(0, Math.min(w.count - w.draftReady - back, w.written - w.draftReady - back));
  const n: Record<Kind, number> = {
    delivered: w.delivered, approved: w.approved - w.delivered, sent: w.draftReady - w.approved, back, written,
    todo: Math.max(0, w.count - w.draftReady - back - written),
  };
  // today's counter updates glow: the newest written ones first, then the newest sent
  let glow = w.writtenToday;
  const litOf: Partial<Record<Kind, number>> = {};
  for (const k of ['written', 'sent'] as const) { litOf[k] = Math.min(glow, n[k]); glow -= litOf[k]!; }
  const pips: { kind: Kind; lit: boolean }[] = [];
  for (const k of KINDS) for (let i = 0; i < n[k]; i++) pips.push({ kind: k, lit: i >= n[k] - (litOf[k] ?? 0) });
  const label = KINDS.filter((k) => n[k]).map((k) => `${n[k]} ${KIND_LABEL[k].toLowerCase()}`).join(', ') + (w.writtenToday ? `; ${w.writtenToday} counted today` : '');
  let lit = 0;
  return (
    <div className={`pips${large ? ' lg' : ''}${w.count > 40 ? ' dense' : ''}`} role="img" aria-label={label} title={label}>
      {pips.map((p, i) => <i key={i} className={`pip ${p.kind}${p.lit ? ' lit' : ''}`} style={p.lit ? { ['--d' as string]: `${lit++ * 70}ms` } : undefined} />)}
    </div>
  );
}

export function PipLegend() {
  return (
    <div className="pip-legend" aria-hidden>
      {KINDS.map((k) => <span key={k}><i className={`pip ${k}`} />{k === 'back' ? 'Sent back' : KIND_LABEL[k]}</span>)}
      <span><i className="pip written lit still" />Counted today</span>
    </div>
  );
}

/** "+3 today", with a live dot. */
export function TodayBump({ n, short }: { n: number; short?: boolean }) {
  if (n <= 0) return null;
  return <span className="bump" title={`${plural(n, 'script')} counted as written today`}><i aria-hidden />+{n}{short ? '' : ' today'}</span>;
}

/** The latest counter updates across the viewer's active batches. */
export function WritingFeed({ batches, limit = 6 }: { batches: BatchSummary[]; limit?: number }) {
  const week = Date.now() - 7 * 86400000;
  const rows = batches
    .flatMap((b) => b.writers.filter((w) => w.userId != null && w.writtenAt && Date.parse(w.writtenAt) > week).map((w) => ({ b, w })))
    .sort((x, y) => Date.parse(y.w.writtenAt!) - Date.parse(x.w.writtenAt!))
    .slice(0, limit);
  if (!rows.length) return <p className="muted" style={{ fontSize: 13.5 }}>No counter updates this week. When a writer taps + on a batch, it shows up here.</p>;
  return (
    <div className="rows">
      {rows.map(({ b, w }) => (
        <Link key={`${b.id}:${w.userId}`} to={`/batches/${b.id}`} className={`item clickable writing-row${w.writtenToday ? ' edge-cyan' : ''}`}>
          <div className="body">
            <div className="row-flex s2" style={{ rowGap: 6 }}>
              <Avatar name={w.name} id={w.userId!} small /><span className="title">{w.name}</span><TodayBump n={w.writtenToday} />
              {w.revisions > 0 && <span className="chip pink nowrap">{w.revisions} sent back</span>}
            </div>
            <div className="meta"><span className="ellipsis">{b.title.startsWith(b.clientName) ? b.title : `${b.clientName} · ${b.title}`}</span></div>
            <ScriptPips w={w} />
          </div>
          <div className="side">
            <span className="when num">{w.revisions > 0 ? `${w.draftReady} / ${w.count} ready` : `${w.written} / ${w.count}`}</span>
            <span className="muted nowrap" style={{ fontSize: 12 }}>{fmtAgo(w.writtenAt!)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
