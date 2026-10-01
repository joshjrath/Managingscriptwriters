// Writers (managers) / Messages (writers): everyone on the team in one place,
// with the latest message and a button that opens the chat window. Managers
// also see each person's workload, open to-dos and local time, with shortcuts
// to their work and to give them a to-do.

import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ListTodo, MessageCircle, PenLine, Search } from 'lucide-react';
import { api } from '../api';
import type { Dashboard, UserSummary } from '../../../shared/types';
import { isManager, ROLE_LABEL } from '../../../shared/workflow';
import { fmtAgo, fmtDate, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Avatar, Button, Chip, Empty, Panel } from '../components/ui';
import { useChat, useInbox } from '../components/Chat';
import { TodoDialog, useTodos } from '../components/Todos';

function localTime(tz: string | null) {
  if (!tz) return null;
  try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date()); } catch { return null; }
}

export function WritersPage() {
  const { me, users, clock } = useBoot();
  const manager = isManager(me.role);
  const chat = useChat();
  const inbox = useInbox();
  const dash = useQuery({ queryKey: ['dashboard'], queryFn: () => api<Dashboard>('/api/dashboard'), enabled: manager });
  const todos = useTodos({ all: true });
  const [q, setQ] = useState('');
  const [todoFor, setTodoFor] = useState<number | null>(null);

  const people = useMemo(() => {
    const thread = new Map((inbox.data?.threads ?? []).map((t) => [t.userId, t]));
    const list = users.filter((u) => u.active && u.id !== me.id && (!q || u.name.toLowerCase().includes(q.toLowerCase())));
    // writers first for managers; then whoever you talked to most recently
    return list.sort((a, b) => (manager ? Number(a.role !== 'writer') - Number(b.role !== 'writer') : 0)
      || (thread.get(b.id)?.last.id ?? 0) - (thread.get(a.id)?.last.id ?? 0) || a.name.localeCompare(b.name));
  }, [users, me.id, q, inbox.data, manager]);

  return (
    <>
      <PageHeader title={manager ? 'Writers' : 'Messages'} sub={manager ? 'Your team: what they’re working on, and a message away.' : 'Message anyone on the team. Chats open in the bottom-right corner.'} hideNewWork>
        <label className="search-inline"><Search aria-hidden /><input className="input" placeholder="Find someone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find someone" /></label>
      </PageHeader>
      {!people.length ? (
        <Panel><Empty icon={<MessageCircle />} title={q ? 'Nobody matches' : 'No one else on the team yet'}>{manager && !q ? 'Add people in Settings → Team.' : undefined}</Empty></Panel>
      ) : (
        <div className="writer-grid">
          {people.map((u) => (
            <WriterCard key={u.id} u={u} manager={manager}
              load={dash.data?.workload.find((w) => w.userId === u.id)}
              thread={inbox.data?.threads.find((t) => t.userId === u.id)}
              openTodos={(todos.data?.todos ?? []).filter((t) => t.userId === u.id && !t.doneAt).length}
              today={clock.today} onMessage={() => chat.open(u.id)} onTodo={() => setTodoFor(u.id)} />
          ))}
        </div>
      )}
      {todoFor != null && <TodoDialog userId={todoFor} onClose={() => setTodoFor(null)} />}
    </>
  );
}

function WriterCard({ u, manager, load, thread, openTodos, today, onMessage, onTodo }: {
  u: UserSummary; manager: boolean; load?: Dashboard['workload'][number]; thread?: NonNullable<ReturnType<typeof useInbox>['data']>['threads'][number];
  openTodos: number; today: string; onMessage: () => void; onTodo: () => void;
}) {
  const { me } = useBoot();
  const time = localTime(u.timezone);
  return (
    <section className={`panel writer-card${thread?.unread ? ' has-unread' : ''}`} aria-label={u.name}>
      <div className="writer-top">
        <Avatar name={u.name} id={u.id} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="writer-name ellipsis">{u.name}</div>
          <div className="muted" style={{ fontSize: 12.5 }}>{ROLE_LABEL[u.role]}{u.city ? ` · ${u.city.split(',')[0]}` : ''}{time ? ` · ${time} there` : ''}</div>
        </div>
        {thread?.unread ? <span className="chat-badge inline">{thread.unread}</span> : null}
      </div>

      {manager && load && (
        <div className="writer-stats">
          <div><b className="num">{load.activeBatches}</b><span>{load.activeBatches === 1 ? 'batch' : 'batches'}</span></div>
          <div><b className="num">{load.remaining}</b><span>to write</span></div>
          <div><b className="num">{load.toDeliver}</b><span>to deliver</span></div>
          <div><b className="num">{openTodos}</b><span>{openTodos === 1 ? 'to-do' : 'to-dos'}</span></div>
        </div>
      )}
      {manager && load && (load.overdueScripts > 0 || load.nextDeadline) && (
        <div className="row-flex s2" style={{ marginTop: 10 }}>
          {load.overdueScripts > 0 && <Chip color="red" icon={<AlertTriangle aria-hidden />}>{plural(load.overdueScripts, 'script')} overdue</Chip>}
          {load.nextDeadline && <span className="muted" style={{ fontSize: 12.5 }}>Next: {load.nextDeadline.kind === 'draft' ? 'drafts' : 'final'} {fmtDate(load.nextDeadline.date, today)} · {load.nextDeadline.clientName}</span>}
        </div>
      )}

      <button type="button" className={`writer-last${thread?.unread ? ' unread' : ''}`} onClick={onMessage}>
        {thread ? <><span className="ellipsis">{thread.last.fromId === me.id ? 'You: ' : ''}{thread.last.body}</span><span className="muted nowrap">{fmtAgo(thread.last.createdAt)}</span></> : <span className="muted">No messages yet</span>}
      </button>

      <div className="row-flex s2 writer-actions">
        <Button variant="sm primary pill" icon={<MessageCircle aria-hidden />} onClick={onMessage}>Message</Button>
        {manager && <Link to={`/my-work?userId=${u.id}`} className="btn sm"><PenLine aria-hidden />Their work</Link>}
        {manager && <Button variant="sm ghost" icon={<ListTodo aria-hidden />} onClick={onTodo}>Add to-do</Button>}
      </div>
    </section>
  );
}
