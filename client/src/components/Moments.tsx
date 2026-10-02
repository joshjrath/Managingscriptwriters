// Celebration moments: "Congrats, your scripts for … just got approved",
// finished drafts, finished batches, and a calm heads-up for send-backs.
// They play once, the next time the person has the app open (straight away
// for things they did themselves), and are marked seen as soon as they show.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { CheckCheck, PartyPopper, RotateCcw, Send, Sparkles, Trophy } from 'lucide-react';
import { api } from '../api';
import type { Moment, MomentKind } from '../../../shared/types';
import { compressRanges } from '../../../shared/workflow';
import { fmtStamp, plural } from '../../../shared/format';
import { celebrate, confetti } from '../fx';
import { SPRING } from '../motion';
import { useDisplayTz } from './Shell';
import { Button } from './ui';

const RANK: Record<MomentKind, number> = { batch_done: 0, team_batch_done: 1, drafts_done: 2, team_drafts_done: 3, approved: 4, revisions: 6 };

/** Several approvals of the same batch read as one. */
function merge(list: Moment[]): Moment[] {
  const out = new Map<string, Moment>();
  for (const x of list) {
    const key = x.kind === 'approved' || x.kind === 'revisions' ? `${x.kind}:${x.batchId}` : `${x.kind}:${x.batchId}:${x.id}`;
    const prev = out.get(key);
    if (!prev) { out.set(key, { ...x, numbers: [...x.numbers] }); continue; }
    const numbers = [...new Set([...prev.numbers, ...x.numbers])].sort((a, b) => a - b);
    out.set(key, { ...x, numbers, count: numbers.length, allMine: prev.allMine || x.allMine, withAttachment: prev.withAttachment || x.withAttachment, note: x.note ?? prev.note });
  }
  return [...out.values()].sort((a, b) => (RANK[a.kind] + (a.kind === 'approved' && a.allMine ? -0.5 : 0)) - (RANK[b.kind] + (b.kind === 'approved' && b.allMine ? -0.5 : 0)));
}

const scriptsText = (x: Moment) => (x.count === 1 ? `script ${compressRanges(x.numbers)}` : `${x.count} scripts${x.numbers.length ? ` (${compressRanges(x.numbers)})` : ''}`);

interface Told { title: string; body: string; icon: ReactNode; tone: string; cta: { label: string; to: string }; big: boolean; happy: boolean }

function tell(x: Moment): Told {
  switch (x.kind) {
    case 'approved':
      return {
        title: `Congrats! Your scripts for ${x.batchTitle} just got approved`,
        body: `${x.byName ?? 'A manager'} approved ${scriptsText(x)}${x.allMine ? ' — that’s every one of yours in this batch' : ''}.${x.withAttachment ? ' They attached their edited version, so use that one.' : ''} Next: add ${x.count === 1 ? 'it' : 'them'} to Timeliner and confirm delivery.`,
        icon: <CheckCheck />, tone: 'mint', cta: { label: 'Go to My work', to: '/my-work' }, big: x.allMine, happy: true,
      };
    case 'revisions':
      return {
        title: `Changes requested on ${x.batchTitle}`,
        body: `${x.byName ?? 'A manager'} sent back ${scriptsText(x)}${x.note ? `: “${x.note}”` : '.'}${x.withAttachment ? ' Their changes are attached.' : ''} Send the revised version when it’s ready.`,
        icon: <RotateCcw />, tone: 'pink', cta: { label: 'See the notes', to: '/my-work' }, big: false, happy: false,
      };
    case 'drafts_done':
      return {
        title: x.self ? `All ${x.count} drafts sent for ${x.batchTitle}!` : `All your drafts for ${x.batchTitle} are in`,
        body: x.self ? 'That’s every one of your scripts in this batch. You’ll hear back as soon as they’re reviewed.' : `Every one of your ${x.count} scripts has been sent for review.`,
        icon: <Send />, tone: 'lavender', cta: { label: 'Go to My work', to: '/my-work' }, big: true, happy: true,
      };
    case 'batch_done':
      return {
        title: `You finished ${x.batchTitle}!`,
        body: `All ${plural(x.count, 'script')} of yours are delivered to Timeliner. Brilliant work.`,
        icon: <Trophy />, tone: 'yellow', cta: { label: 'Go to My work', to: '/my-work' }, big: true, happy: true,
      };
    case 'team_drafts_done':
      return {
        title: `${x.byName ?? 'A writer'} finished their drafts for ${x.batchTitle}`,
        body: `${plural(x.count, 'script')} ${x.count === 1 ? 'is' : 'are'} ready for your review.`,
        icon: <Sparkles />, tone: 'lavender', cta: { label: 'Open the Review queue', to: '/review' }, big: false, happy: true,
      };
    case 'team_batch_done':
      return {
        title: `${x.batchTitle} is fully delivered`,
        body: `All ${plural(x.count, 'script')} for ${x.clientName} are in Timeliner.`,
        icon: <PartyPopper />, tone: 'yellow', cta: { label: 'Open the batch', to: x.batchId ? `/batches/${x.batchId}` : '/overview' }, big: true, happy: true,
      };
  }
}

export function MomentsHost() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['moments'], queryFn: () => api<Moment[]>('/api/moments'), refetchInterval: 60_000, staleTime: 0 });
  const shown = useRef(new Set<number>());
  const [playing, setPlaying] = useState<Moment[] | null>(null);
  useEffect(() => {
    if (playing) return;
    const fresh = (q.data ?? []).filter((x) => !shown.current.has(x.id));
    if (!fresh.length) return;
    fresh.forEach((x) => shown.current.add(x.id));
    setPlaying(merge(fresh));
    api('/api/moments/seen', { body: { ids: fresh.map((x) => x.id) } }).then(() => qc.setQueryData(['moments'], [])).catch(() => { /* shown once per visit either way */ });
  }, [q.data, playing, qc]);
  if (!playing) return null;
  return <MomentDialog moments={playing} onClose={() => setPlaying(null)} />;
}

function MomentDialog({ moments, onClose }: { moments: Moment[]; onClose: () => void }) {
  const displayTz = useDisplayTz();
  const nav = useNavigate();
  const ref = useRef<HTMLDialogElement>(null);
  const [hero, ...rest] = moments;
  const t = tell(hero);
  useEffect(() => {
    ref.current?.showModal();
    const timer = setTimeout(() => {
      if (t.big) celebrate();
      else if (t.happy) confetti({ y: innerHeight * 0.36, count: 80, spread: 110, power: 13 });
    }, 180);
    return () => clearTimeout(timer);
  }, [t.big, t.happy]);
  const words = t.title.split(' ');
  return (
    <dialog ref={ref} className={`moment tone-${t.tone}`} aria-labelledby="moment-title" onClose={onClose}
      onCancel={(e) => { e.preventDefault(); onClose(); }} onClick={(e) => { if (e.target === ref.current) onClose(); }}>
      <m.div className="moment-sheet" initial={{ opacity: 0, y: 26, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 260, damping: 22 }}>
        <m.div className="moment-badge" initial={{ scale: 0, rotate: -30 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 320, damping: 14, delay: 0.12 }} aria-hidden>
          <span className="ring1" /><span className="ring2" />
          {t.icon}
        </m.div>
        <div className="moment-kicker">{hero.clientName} · {hero.self ? 'just now' : fmtStamp(hero.createdAt, displayTz)}</div>
        <h2 id="moment-title" className="moment-title">
          {words.map((w, i) => (
            <m.span key={i} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ ...SPRING, delay: 0.22 + i * 0.035 }}>{w} </m.span>
          ))}
        </h2>
        <m.p className="moment-body" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.35 + words.length * 0.035, duration: 0.3 }}>{t.body}</m.p>
        {rest.length > 0 && (
          <m.div className="moment-more" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.5 + words.length * 0.035, duration: 0.3 }}>
            <div className="lbl">Also</div>
            <ul>
              {rest.slice(0, 5).map((x) => { const o = tell(x); return <li key={x.id} className={`tone-${o.tone}`}><span className="ic">{o.icon}</span><span>{o.title}</span></li>; })}
              {rest.length > 5 && <li className="muted">and {rest.length - 5} more — see your notifications</li>}
            </ul>
          </m.div>
        )}
        <div className="moment-actions">
          <Button variant="ghost" onClick={onClose}>{t.happy ? 'Nice!' : 'Got it'}</Button>
          <Button variant="primary pill" autoFocus onClick={() => { onClose(); nav(t.cta.to); }}>{t.cta.label}</Button>
        </div>
      </m.div>
    </dialog>
  );
}
