// Messages, Messenger-style: a round button in the bottom-right corner opens
// your conversations, and each conversation is a small window docked along the
// bottom of the screen. A new message to you pops its window open. Polling is
// light: the inbox every 8 seconds, and an open window asks only for messages
// newer than the last one it has. Nothing polls while the tab is hidden.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AnimatePresence, m } from 'framer-motion';
import { MessageCircle, Minus, PenSquare, Send, X } from 'lucide-react';
import { api, queryClient } from '../api';
import type { ChatInbox, ChatMessage } from '../../../shared/types';
import { ROLE_LABEL } from '../../../shared/workflow';
import { fmtAgo } from '../../../shared/format';
import { useBoot, useDisplayTz } from './Shell';
import { Avatar } from './ui';
import { SPRING } from '../motion';

interface Win { userId: number; min: boolean }
interface ChatApi { open: (userId: number) => void }
const ChatCtx = createContext<ChatApi>({ open: () => {} });
export const useChat = () => useContext(ChatCtx);

const STORE = 'sm.chats';
const maxWindows = () => (window.matchMedia('(max-width: 760px)').matches ? 1 : window.matchMedia('(max-width: 1180px)').matches ? 2 : 3);

/** Polls only while the tab is visible. */
function useVisible() {
  const [v, setV] = useState(() => !document.hidden);
  useEffect(() => {
    const on = () => setV(!document.hidden);
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return v;
}

export function useInbox() {
  const visible = useVisible();
  return useQuery({ queryKey: ['inbox'], queryFn: () => api<ChatInbox>('/api/messages'), refetchInterval: visible ? 8000 : false, staleTime: 4000 });
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { me, mode } = useBoot();
  const [wins, setWins] = useState<Win[]>(() => {
    try { return (JSON.parse(sessionStorage.getItem(STORE) ?? '[]') as Win[]).slice(0, maxWindows()); } catch { return []; }
  });
  const [listOpen, setListOpen] = useState(false);
  const inbox = useInbox();
  const seen = useRef<Map<number, number> | null>(null);

  useEffect(() => { try { sessionStorage.setItem(STORE, JSON.stringify(wins)); } catch { /* ignore */ } }, [wins]);
  // viewing as someone else starts with a clean dock
  useEffect(() => { if (mode?.viewingAs) setWins([]); }, [mode?.viewingAs?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = useCallback((userId: number) => {
    if (userId === me.id) return;
    setListOpen(false);
    setWins((w) => [{ userId, min: false }, ...w.filter((x) => x.userId !== userId)].slice(0, maxWindows()));
  }, [me.id]);

  // a new message to you pops its window open (unread ones too, on first load)
  useEffect(() => {
    const threads = inbox.data?.threads;
    if (!threads) return;
    const first = !seen.current;
    const prev = seen.current ?? new Map<number, number>();
    const pop: number[] = [];
    for (const t of threads) {
      const fresh = t.last.fromId === t.userId && t.unread > 0 && (first || t.last.id > (prev.get(t.userId) ?? 0));
      if (fresh) pop.push(t.userId);
    }
    seen.current = new Map(threads.map((t) => [t.userId, t.last.id]));
    if (!pop.length) return;
    setWins((w) => {
      let next = [...w];
      for (const uid of pop.slice(0, maxWindows()).reverse()) {
        const had = next.find((x) => x.userId === uid);
        next = had ? next.map((x) => (x.userId === uid ? { ...x, min: false } : x)) : [{ userId: uid, min: false }, ...next];
      }
      return next.slice(0, maxWindows());
    });
  }, [inbox.data]);

  const close = (uid: number) => setWins((w) => w.filter((x) => x.userId !== uid));
  const toggleMin = (uid: number) => setWins((w) => w.map((x) => (x.userId === uid ? { ...x, min: !x.min } : x)));
  const unread = inbox.data?.unread ?? 0;

  return (
    <ChatCtx.Provider value={{ open }}>
      {children}
      <div className="chat-dock" aria-label="Messages">
        <div className="chat-launch-wrap">
          <AnimatePresence>{listOpen && <ChatList onPick={open} onClose={() => setListOpen(false)} />}</AnimatePresence>
          <button type="button" className={`chat-launch${listOpen ? ' on' : ''}`} onClick={() => setListOpen((o) => !o)} aria-expanded={listOpen}
            aria-label={unread ? `Messages, ${unread} unread` : 'Messages'}>
            {listOpen ? <X aria-hidden /> : <MessageCircle aria-hidden />}
            {unread > 0 && !listOpen && <span className="chat-badge">{unread > 99 ? '99+' : unread}</span>}
          </button>
        </div>
        <AnimatePresence initial={false}>
          {wins.map((w) => (
            <m.div key={w.userId} layout className={`chat-win${w.min ? ' min' : ''}`}
              initial={{ opacity: 0, y: 30, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 30, scale: 0.96 }} transition={SPRING}>
              <ChatWindow userId={w.userId} min={w.min} onMin={() => toggleMin(w.userId)} onClose={() => close(w.userId)} />
            </m.div>
          ))}
        </AnimatePresence>
      </div>
    </ChatCtx.Provider>
  );
}

function ChatList({ onPick, onClose }: { onPick: (id: number) => void; onClose: () => void }) {
  const { me, users } = useBoot();
  const inbox = useInbox();
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const away = (e: MouseEvent) => { if (ref.current && !ref.current.parentElement!.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [onClose]);
  const threads = inbox.data?.threads ?? [];
  const others = users.filter((u) => u.active && u.id !== me.id);
  const people = picking ? others : others.filter((u) => !threads.some((t) => t.userId === u.id));
  return (
    <m.div ref={ref} className="chat-list" role="dialog" aria-label="Conversations"
      initial={{ opacity: 0, y: 12, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 12, scale: 0.97 }} transition={SPRING}>
      <div className="chat-list-head">
        <b>Messages</b>
        <button type="button" className="icon-btn sm" onClick={() => setPicking((p) => !p)} aria-label="New message" title="New message"><PenSquare /></button>
      </div>
      <div className="chat-list-body">
        {!picking && threads.map((t) => (
          <button key={t.userId} type="button" className={`chat-row${t.unread ? ' unread' : ''}`} onClick={() => onPick(t.userId)}>
            <Avatar name={t.name} id={t.userId} small />
            <span className="chat-row-txt">
              <span className="chat-row-top"><b className="ellipsis">{t.name}</b><span className="muted">{fmtAgo(t.last.createdAt)}</span></span>
              <span className="chat-row-last ellipsis">{t.last.fromId === me.id ? 'You: ' : ''}{t.last.body}</span>
            </span>
            {t.unread > 0 && <span className="chat-dot" aria-label={`${t.unread} unread`} />}
          </button>
        ))}
        {people.length > 0 && <div className="chat-list-label">{picking ? 'Start a conversation' : threads.length ? 'Everyone else' : 'Message someone'}</div>}
        {people.map((u) => (
          <button key={u.id} type="button" className="chat-row" onClick={() => onPick(u.id)}>
            <Avatar name={u.name} id={u.id} small />
            <span className="chat-row-txt"><b className="ellipsis">{u.name}</b><span className="chat-row-last">{ROLE_LABEL[u.role]}</span></span>
          </button>
        ))}
        {!others.length && <p className="muted" style={{ padding: 14, fontSize: 13 }}>Add people in Settings → Team to message them.</p>}
      </div>
    </m.div>
  );
}

// times follow the workspace time zone, like everywhere else on the site
const dayKey = (ts: string | number, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
const sameDay = (a: string, b: string, tz: string) => dayKey(a, tz) === dayKey(b, tz);
function dayLabel(ts: string, tz: string) {
  const k = dayKey(ts, tz);
  if (k === dayKey(Date.now(), tz)) return 'Today';
  if (k === dayKey(Date.now() - 86400000, tz)) return 'Yesterday';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(ts));
}
const timeOf = (ts: string, tz: string) => new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(ts));

function ChatWindow({ userId, min, onMin, onClose }: { userId: number; min: boolean; onMin: () => void; onClose: () => void }) {
  const displayTz = useDisplayTz();
  const { me, users, mode } = useBoot();
  const tz = displayTz;
  const who = users.find((u) => u.id === userId);
  const name = who?.name ?? 'Team member';
  const [msgs, setMsgs] = useState<ChatMessage[] | null>(null);
  const [more, setMore] = useState(false);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [sending, setSending] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const visible = useVisible();
  const inbox = useInbox();
  const unread = inbox.data?.threads.find((t) => t.userId === userId)?.unread ?? 0;
  const readOnly = !!mode?.viewingAs && !mode.recording;

  // first load, then only what's newer
  useEffect(() => {
    let dead = false;
    api<{ messages: ChatMessage[]; more: boolean }>(`/api/messages/${userId}`).then((r) => { if (!dead) { setMsgs(r.messages); setMore(r.more); } }, () => { if (!dead) setMsgs([]); });
    return () => { dead = true; };
  }, [userId]);
  const lastId = msgs?.length ? msgs[msgs.length - 1].id : 0;
  useEffect(() => {
    if (!msgs || min || !visible) return;
    const t = setInterval(() => {
      api<{ messages: ChatMessage[] }>(`/api/messages/${userId}?after=${lastId}`).then((r) => {
        if (r.messages.length) setMsgs((cur) => [...(cur ?? []), ...r.messages.filter((x) => !(cur ?? []).some((c) => c.id === x.id))]);
      }, () => {});
    }, 3000);
    return () => clearInterval(t);
  }, [userId, lastId, !!msgs, min, visible]); // eslint-disable-line react-hooks/exhaustive-deps

  // seeing their messages marks them read (the inbox picks up new ones every few seconds)
  useEffect(() => {
    if (min || !visible || !msgs || !(unread > 0 || msgs.some((x) => x.fromId === userId && !x.readAt))) return;
    api(`/api/messages/${userId}/read`, { body: {} }).then(() => queryClient.invalidateQueries({ queryKey: ['inbox'] }), () => {});
    setMsgs((cur) => cur && cur.map((x) => (x.fromId === userId && !x.readAt ? { ...x, readAt: new Date().toISOString() } : x)));
  }, [min, visible, unread, msgs?.length, userId]); // eslint-disable-line react-hooks/exhaustive-deps

  // keep to the newest message unless you've scrolled up to read
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [msgs?.length, min]);

  const loadOlder = async () => {
    if (!msgs?.length) return;
    const el = list.current;
    const h = el?.scrollHeight ?? 0;
    const r = await api<{ messages: ChatMessage[]; more: boolean }>(`/api/messages/${userId}?before=${msgs[0].id}`);
    setMsgs((cur) => [...r.messages, ...(cur ?? [])]);
    setMore(r.more);
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - h; });
  };

  const send = async () => {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true); setErr('');
    try {
      const r = await api<{ message: ChatMessage }>(`/api/messages/${userId}`, { body: { body } });
      atBottom.current = true;
      setMsgs((cur) => [...(cur ?? []).filter((x) => x.id !== r.message.id), r.message]);
      setText('');
      queryClient.invalidateQueries({ queryKey: ['inbox'] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Not sent. Try again.');
    } finally { setSending(false); }
  };

  const lastMine = msgs ? [...msgs].reverse().find((x) => x.fromId === me.id) : undefined;
  const theirLast = msgs ? [...msgs].reverse().find((x) => x.fromId === userId) : undefined;
  const seenLast = lastMine?.readAt && (!theirLast || theirLast.id < lastMine.id);

  return (
    <>
      <div className="chat-head" onClick={onMin} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onMin(); }} aria-label={`${name}: ${min ? 'open' : 'minimise'}`}>
        <Avatar name={name} id={userId} small />
        <span className="chat-head-txt"><b className="ellipsis">{name}</b>{!min && who && <span>{ROLE_LABEL[who.role]}</span>}</span>
        {min && unread > 0 && <span className="chat-badge inline">{unread}</span>}
        <button type="button" className="icon-btn sm" onClick={(e) => { e.stopPropagation(); onMin(); }} aria-label={min ? 'Open' : 'Minimise'}><Minus /></button>
        <button type="button" className="icon-btn sm" onClick={(e) => { e.stopPropagation(); onClose(); }} aria-label="Close"><X /></button>
      </div>
      {!min && (
        <>
          <div className="chat-msgs" ref={list} onScroll={(e) => { const el = e.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }} aria-live="polite">
            {more && <button type="button" className="btn sm ghost chat-older" onClick={loadOlder}>Earlier messages</button>}
            {msgs && !msgs.length && <div className="chat-empty"><Avatar name={name} id={userId} /><b>{name}</b><span>Say hello. Messages stay here for both of you.</span></div>}
            {msgs?.map((x, i) => {
              const prev = msgs[i - 1];
              const next = msgs[i + 1];
              const mine = x.fromId === me.id;
              const newDay = !prev || !sameDay(prev.createdAt, x.createdAt, tz);
              const gap = !prev || newDay || prev.fromId !== x.fromId || Date.parse(x.createdAt) - Date.parse(prev.createdAt) > 5 * 60000;
              const endGroup = !next || next.fromId !== x.fromId || Date.parse(next.createdAt) - Date.parse(x.createdAt) > 5 * 60000 || !sameDay(x.createdAt, next.createdAt, tz);
              return (
                <div key={x.id} className="chat-item">
                  {newDay && <div className="chat-day">{dayLabel(x.createdAt, tz)}</div>}
                  <div className={`bubble-row${mine ? ' mine' : ''}${gap ? ' gap' : ''}`}>
                    {!mine && (endGroup ? <Avatar name={name} id={userId} small /> : <span className="bubble-spacer" />)}
                    <div className={`bubble${endGroup ? ' end' : ''}`} title={`${dayLabel(x.createdAt, tz)}, ${timeOf(x.createdAt, tz)}`}>{x.body}</div>
                  </div>
                  {endGroup && <div className={`bubble-time${mine ? ' mine' : ''}`}>{timeOf(x.createdAt, tz)}{mine && x.id === lastMine?.id && seenLast ? ' · Seen' : ''}</div>}
                </div>
              );
            })}
          </div>
          <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); send(); }}>
            {err && <div className="chat-err" role="alert">{err}</div>}
            <div className="chat-compose-row">
              <textarea className="chat-input" rows={1} value={text} disabled={readOnly} maxLength={4000}
                placeholder={readOnly ? 'Viewing only. Messages are off.' : `Message ${name.split(' ')[0]}…`}
                aria-label={`Message ${name}`}
                onChange={(e) => { setText(e.target.value); const t = e.target; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 120)}px`; }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }} />
              <button type="submit" className="chat-send" disabled={!text.trim() || sending || readOnly} aria-label="Send"><Send aria-hidden /></button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
