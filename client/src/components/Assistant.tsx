// Ask AI: the site's assistant (managers). A panel on the right that stays open while you move around the site, so you
// can watch a change land. It sends the page you're on with the conversation (POST /api/assistant); the answer comes
// with proposed changes in plain words, which the browser sends to the site's own routes only when you press Apply,
// one after another, stopping at the first that's refused. The conversation is kept for this browser tab.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'framer-motion';
import { ArrowRight, Check, CircleAlert, Loader2, Plus, Send, Sparkles, X } from 'lucide-react';
import { api, ApiError, queryClient } from '../api';
import type { AssistantProposal, AssistantReply } from '../../../shared/types';
import { SOFT } from '../motion';
import { burst } from '../fx';

interface Msg {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  proposals?: AssistantProposal[];
  skipped?: string[];
  /** what happened to each proposal with a request, once applied */
  outcome?: ('done' | 'failed' | 'not run')[];
  errors?: (string | null)[];
  state?: 'proposed' | 'applying' | 'applied' | 'dismissed';
  failed?: boolean;
}

const keyOf = (userId: number) => `sm.assistant.${userId}`;
const load = (userId: number): Msg[] => {
  try { return JSON.parse(sessionStorage.getItem(keyOf(userId)) ?? '[]') as Msg[]; } catch { return []; }
};
const newId = () => Math.random().toString(36).slice(2);

/** What the assistant is told about an earlier answer: its words, what it proposed, and whether that was applied. */
function asHistory(x: Msg): { role: 'user' | 'assistant'; content: string } {
  if (x.role === 'user') return { role: 'user', content: x.text };
  const lines = (x.proposals ?? []).flatMap((p) => p.lines);
  const what = x.state === 'applied' ? (x.outcome?.includes('failed') ? 'partly applied' : 'applied') : x.state === 'dismissed' ? 'not applied' : 'not applied yet';
  return { role: 'assistant', content: `${x.text}${lines.length ? `\n[Proposed: ${lines.join('; ')} — ${what}]` : ''}` };
}

/** Ideas to start from, for the page you're on. They fill the box; nothing is sent until you press Send. */
function suggestionsFor(path: string): string[] {
  if (path.startsWith('/content')) return [
    'Change the 3rd video this month to my idea: … Write the brief and give the scripting to …',
    'Push Week 2 back two days, with all its deliverables',
    'Swap Weeks 2 and 4',
  ];
  if (path.startsWith('/batches/')) return ['Move this batch’s final delivery to Friday', 'Give scripts 5–8 to …', 'Flag this as blocked: waiting on the client’s claims sheet'];
  if (path.startsWith('/clients/')) return ['Add to this client’s guidance: …', 'Move their next shoot a week later'];
  if (path.startsWith('/calendar')) return ['What’s due this week, and who’s behind?', 'Move next week’s shoots back a day'];
  return ['What’s overdue right now?', 'Who has the most on this week?', 'Open the content roadmap'];
}

/** Paragraphs and "- " lists, as the assistant writes them. */
function Prose({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, i) => {
        const lines = b.split('\n');
        if (lines.every((l) => /^\s*[-•*]\s+/.test(l))) return <ul key={i}>{lines.map((l, k) => <li key={k}>{l.replace(/^\s*[-•*]\s+/, '')}</li>)}</ul>;
        return <p key={i}>{lines.map((l, k) => <span key={k}>{k > 0 && <br />}{l}</span>)}</p>;
      })}
    </>
  );
}

export function AssistantPanel({ open, onClose, userId }: { open: boolean; onClose: () => void; userId: number }) {
  const loc = useLocation();
  const nav = useNavigate();
  const [msgs, setMsgs] = useState<Msg[]>(() => load(userId));
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  const path = loc.pathname + loc.search;

  useEffect(() => { try { sessionStorage.setItem(keyOf(userId), JSON.stringify(msgs.slice(-40))); } catch { /* private mode */ } }, [msgs, userId]);
  useEffect(() => { list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' }); }, [msgs, busy]);
  useEffect(() => { if (open) requestAnimationFrame(() => box.current?.focus()); }, [open]);

  const update = (msgId: string, f: (x: Msg) => Msg) => setMsgs((all) => all.map((x) => (x.id === msgId ? f(x) : x)));

  const send = async (text: string) => {
    const t = text.trim();
    if (!t || busy) return;
    setError(null);
    const mine: Msg = { id: newId(), role: 'user', text: t };
    // an answer still waiting is set aside: a new message moves on from it
    const before = msgs.map((x) => (x.state === 'proposed' ? { ...x, state: 'dismissed' as const } : x));
    const next = [...before, mine];
    setMsgs(next);
    setDraft('');
    setBusy(true);
    try {
      const res = await api<AssistantReply>('/api/assistant', { body: { path, messages: next.slice(-24).map(asHistory) } });
      const hasRequests = res.proposals.some((p) => p.request);
      setMsgs((all) => [...all, { id: newId(), role: 'assistant', text: res.reply, proposals: res.proposals, skipped: res.skipped, state: hasRequests ? 'proposed' : undefined }]);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Couldn’t reach the assistant. Try again.');
      setMsgs((all) => all.filter((x) => x.id !== mine.id));
      setDraft(t);
    } finally {
      setBusy(false);
    }
  };

  const apply = async (x: Msg, at: { x: number; y: number }) => {
    const props = (x.proposals ?? []).filter((p) => p.request);
    update(x.id, (y) => ({ ...y, state: 'applying' }));
    const outcome: ('done' | 'failed' | 'not run')[] = props.map(() => 'not run');
    const errors: (string | null)[] = props.map(() => null);
    for (const [i, p] of props.entries()) {
      try {
        await api(p.request!.path, { method: p.request!.method, body: p.request!.body as Record<string, unknown> });
        outcome[i] = 'done';
      } catch (e) {
        outcome[i] = 'failed';
        errors[i] = e instanceof Error ? e.message : 'It was refused';
        break; // later changes may rely on this one
      }
    }
    update(x.id, (y) => ({ ...y, state: 'applied', outcome, errors }));
    await queryClient.invalidateQueries();
    if (!outcome.includes('failed')) burst(at.x, at.y);
  };

  const fresh = () => { setMsgs([]); setError(null); setDraft(''); box.current?.focus(); };

  return (
    <AnimatePresence>
      {open && (
        <m.aside className="ai-panel" aria-label="Ask AI" initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 40, opacity: 0 }} transition={SOFT}
          onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
          <header className="ai-head">
            <span className="ai-mark" aria-hidden><Sparkles /></span>
            <div>
              <h2>Ask AI</h2>
              <span>Knows the page you’re on. Changes wait for your Apply.</span>
            </div>
            <span className="spacer" />
            {msgs.length > 0 && <button type="button" className="icon-btn" onClick={fresh} aria-label="New conversation" title="New conversation"><Plus /></button>}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="Close Ask AI"><X /></button>
          </header>

          <div className="ai-list" ref={list} aria-live="polite">
            {!msgs.length && (
              <m.div className="ai-hello" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}>
                <b>What should change?</b>
                <p>Say it the way you’d tell someone on the team: move a date, rewrite a video’s brief from your idea, give work to someone. You’ll see every change before it happens.</p>
                <div className="ai-chips">
                  {suggestionsFor(loc.pathname).map((s) => <button key={s} type="button" onClick={() => { setDraft(s); box.current?.focus(); }}>{s}</button>)}
                </div>
              </m.div>
            )}
            {msgs.map((x) => (
              <m.div key={x.id} className={`ai-msg ${x.role}`} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={SOFT}>
                {x.role === 'user' ? <div className="ai-bubble">{x.text}</div> : (
                  <div className="ai-answer">
                    {x.text && <div className="ai-prose"><Prose text={x.text} /></div>}
                    {x.proposals?.filter((p) => p.navigate).map((p) => (
                      <button key={p.navigate} type="button" className="ai-go" onClick={() => nav(p.navigate!)}><ArrowRight aria-hidden />{p.lines[0].replace(/^Open /, 'Go to ')}</button>
                    ))}
                    {!!x.proposals?.some((p) => p.request) && <Proposal x={x} onApply={(at) => { void apply(x, at); }} onDismiss={() => update(x.id, (y) => ({ ...y, state: 'dismissed' }))} />}
                    {!!x.skipped?.length && <p className="ai-skipped">Left out: {x.skipped.join('; ')}.</p>}
                  </div>
                )}
              </m.div>
            ))}
            {busy && (
              <m.div className="ai-msg assistant" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                <div className="ai-thinking" role="status"><i /><i /><i /><span>Reading the workspace…</span></div>
              </m.div>
            )}
          </div>

          {error && <div className="ai-error" role="alert"><CircleAlert aria-hidden />{error}</div>}
          <form className="ai-compose" onSubmit={(e) => { e.preventDefault(); void send(draft); }}>
            <textarea ref={box} value={draft} rows={1} placeholder="Change, add, move, write a brief…" aria-label="Message"
              onChange={(e) => { setDraft(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`; }}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(draft); } }} />
            <button type="submit" className="ai-send" disabled={!draft.trim() || busy} aria-label="Send">{busy ? <Loader2 className="spin" aria-hidden /> : <Send aria-hidden />}</button>
          </form>
        </m.aside>
      )}
    </AnimatePresence>
  );
}

function Proposal({ x, onApply, onDismiss }: { x: Msg; onApply: (at: { x: number; y: number }) => void; onDismiss: () => void }) {
  const props = (x.proposals ?? []).filter((p) => p.request);
  const n = props.reduce((k, p) => k + p.lines.length, 0);
  const mark = (i: number): ReactNode => {
    const o = x.outcome?.[i];
    if (o === 'done') return <Check className="ok" aria-label="Done" />;
    if (o === 'failed') return <CircleAlert className="bad" aria-label="Refused" />;
    return <i className="dot" aria-hidden />;
  };
  return (
    <div className={`ai-changes ${x.state ?? ''}`}>
      <div className="ai-changes-h">{x.state === 'applied' ? (x.outcome?.includes('failed') ? 'Some of this couldn’t be done' : 'Done') : x.state === 'dismissed' ? 'Not applied' : `${n === 1 ? 'One change' : `${n} changes`} to apply`}</div>
      <ol>
        {props.map((p, i) => (
          <li key={i} className={x.outcome?.[i] === 'not run' ? 'skip' : x.outcome?.[i] ?? ''}>
            {mark(i)}
            <div>
              {p.lines.map((l, k) => <span key={k} className="line">{l}</span>)}
              {x.errors?.[i] && <span className="err">{x.errors[i]}</span>}
            </div>
          </li>
        ))}
      </ol>
      {x.state === 'proposed' && (
        <div className="ai-changes-act">
          <button type="button" className="btn ghost sm" onClick={onDismiss}>Not now</button>
          <button type="button" className="btn primary pill sm" onClick={(e) => { const b = e.currentTarget.getBoundingClientRect(); onApply({ x: b.left + b.width / 2, y: b.top + b.height / 2 }); }}>
            <Check aria-hidden />Apply {n === 1 ? 'it' : `all ${n}`}
          </button>
        </div>
      )}
      {x.state === 'applying' && <div className="ai-changes-act"><span className="muted"><Loader2 className="spin" aria-hidden /> Applying…</span></div>}
    </div>
  );
}

/** The button at the top of each page (and in the phone bar). */
export function AskAIButton({ onClick, compact }: { onClick: () => void; compact?: boolean }) {
  return (
    <button type="button" className={`ai-btn${compact ? ' compact' : ''}`} onClick={onClick} aria-label="Ask AI" title="Ask AI (Ctrl J)">
      <Sparkles aria-hidden />{!compact && <span>Ask AI</span>}
    </button>
  );
}
