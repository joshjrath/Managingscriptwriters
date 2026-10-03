// To-dos: a manager gives someone a to-do (optionally for a batch, optionally
// with a date) and it shows on that person's My work and Overview. Anyone can
// add their own. The person it's for ticks it off; finished ones stay for a week.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Check, ListTodo, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, qs, useSave } from '../api';
import type { Todo } from '../../../shared/types';
import { isManager } from '../../../shared/workflow';
import { fmtDate, plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { Avatar, Button, Dialog, Field, FormError, inputProps, Panel, useFieldId, useToast } from './ui';

type Scope = { userId?: number; all?: boolean; batchId?: number };

export function useTodos(scope: Scope) {
  const params = { userId: scope.userId, all: scope.all ? '1' : undefined, batchId: scope.batchId };
  return useQuery({ queryKey: ['todos', params], queryFn: () => api<{ todos: Todo[] }>(`/api/todos${qs(params)}`) });
}

function DueTag({ due }: { due: string }) {
  const { clock } = useBoot();
  const cls = due < clock.today ? 'red' : due === clock.today ? 'yellow' : 'plain';
  return <span className={`chip ${cls}`}>{due < clock.today ? 'Overdue · ' : ''}{fmtDate(due, clock.today)}</span>;
}

function TodoRow({ t, showWho }: { t: Todo; showWho?: boolean }) {
  const { me } = useBoot();
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const canTick = t.userId === me.id || isManager(me.role);
  const tick = useSave((done: boolean) => api(`/api/todos/${t.id}`, { method: 'PATCH', body: { done } }), { onSuccess: (_o, done) => { if (done) toast('To-do done'); } });
  const remove = useSave(() => api(`/api/todos/${t.id}`, { method: 'DELETE' }), { onSuccess: () => toast('To-do removed') });
  const done = !!t.doneAt;
  return (
    <div className={`todo${done ? ' done' : ''}`}>
      <button type="button" className="todo-box" role="checkbox" aria-checked={done} disabled={!canTick || tick.isPending} onClick={() => tick.mutate(!done)} aria-label={done ? `Mark “${t.text}” not done` : `Mark “${t.text}” done`}>
        {done && <Check aria-hidden />}
      </button>
      <div className="todo-body">
        <div className="todo-text">{t.text}</div>
        <div className="todo-meta">
          {showWho && <span className="row-flex s1" style={{ gap: 6 }}><Avatar name={t.userName} id={t.userId} small />{t.userName}</span>}
          {t.due && !done && <DueTag due={t.due} />}
          {t.batchId && <Link to={`/batches/${t.batchId}`} className="todo-link">{t.batchTitle}</Link>}
          {t.createdById !== t.userId && <span>from {t.createdById === me.id ? 'you' : t.createdByName}</span>}
        </div>
      </div>
      {t.canEdit && (
        <div className="todo-tools">
          <button type="button" className="icon-btn sm" aria-label="Edit to-do" onClick={() => setEditing(true)}><Pencil /></button>
          <button type="button" className="icon-btn sm" aria-label="Remove to-do" disabled={remove.isPending} onClick={() => remove.mutate(undefined)}><Trash2 /></button>
        </div>
      )}
      {editing && <TodoDialog todo={t} onClose={() => setEditing(false)} />}
    </div>
  );
}

/** A to-do list panel: one person's (default: you), a batch's, or everyone's (managers). */
export function TodoPanel({ userId, all, batchId, title, sub, hideWhenEmpty }: Scope & { title?: string; sub?: string; hideWhenEmpty?: boolean }) {
  const { me, users } = useBoot();
  const q = useTodos({ userId, all, batchId });
  const [adding, setAdding] = useState(false);
  const list = q.data?.todos ?? [];
  const open = list.filter((t) => !t.doneAt);
  const finished = list.filter((t) => t.doneAt);
  const [showDone, setShowDone] = useState(false);
  if (hideWhenEmpty && q.data && !list.length && !isManager(me.role)) return null;
  const forName = userId && userId !== me.id ? users.find((u) => u.id === userId)?.name : undefined;
  return (
    <Panel title={title ?? 'To-do'} count={open.length || undefined} sub={sub}
      tools={<Button variant="sm" icon={<Plus aria-hidden />} onClick={() => setAdding(true)}>{forName ? `Add for ${forName.split(' ')[0]}` : 'Add'}</Button>}>
      {q.data && !list.length && <p className="muted" style={{ fontSize: 13.5, display: 'flex', gap: 8, alignItems: 'center' }}><ListTodo size={16} aria-hidden />{all ? 'No open to-dos for anyone.' : 'Nothing on the list.'}</p>}
      <div className="todos">
        {open.map((t) => <TodoRow key={t.id} t={t} showWho={all || !!batchId} />)}
      </div>
      {finished.length > 0 && (
        <>
          <button type="button" className="btn sm ghost" style={{ marginTop: 8 }} aria-expanded={showDone} onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} {plural(finished.length, 'done this week', 'done this week')}</button>
          {showDone && <div className="todos">{finished.map((t) => <TodoRow key={t.id} t={t} showWho={all || !!batchId} />)}</div>}
        </>
      )}
      {adding && <TodoDialog userId={userId} batchId={batchId} pickPerson={all || !!batchId} onClose={() => setAdding(false)} />}
    </Panel>
  );
}

/** Add (or edit) a to-do. Managers can pick who it's for. */
export function TodoDialog({ todo, userId, batchId, pickPerson, onClose }: { todo?: Todo; userId?: number; batchId?: number; pickPerson?: boolean; onClose: () => void }) {
  const { me, users } = useBoot();
  const toast = useToast();
  const manager = isManager(me.role);
  const [text, setText] = useState(todo?.text ?? '');
  const [due, setDue] = useState(todo?.due ?? '');
  const [who, setWho] = useState<number>(todo?.userId ?? userId ?? me.id);
  const ids = { t: useFieldId('todo'), d: useFieldId('due'), w: useFieldId('who') };
  const save = useSave(() => todo
    ? api(`/api/todos/${todo.id}`, { method: 'PATCH', body: { text, due: due || null } })
    : api('/api/todos', { body: { userId: who, text, due: due || null, batchId: batchId ?? null } }), {
    onSuccess: () => { toast(todo ? 'To-do updated' : who === me.id ? 'To-do added' : `To-do sent to ${users.find((u) => u.id === who)?.name ?? 'them'}`); onClose(); },
  });
  const f = save.error?.fields ?? {};
  return (
    <Dialog open onClose={onClose} title={todo ? 'Edit to-do' : 'Add a to-do'} size="narrow"
      sub={!todo && who !== me.id ? 'They’ll get a notification, and it shows on their My work and Overview.' : undefined}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} disabled={!text.trim()} onClick={() => save.mutate(undefined)}>{todo ? 'Save' : 'Add to-do'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (text.trim()) save.mutate(undefined); }}>
        <FormError error={save.error && !Object.keys(f).length ? save.error : null} />
        {!todo && manager && (pickPerson || userId === undefined) && (
          <Field label="For" htmlFor={ids.w} error={f.userId}>
            <select className="select" id={ids.w} value={who} onChange={(e) => setWho(Number(e.target.value))}>
              {users.filter((u) => u.active).map((u) => <option key={u.id} value={u.id}>{u.id === me.id ? `Me (${u.name})` : u.name}</option>)}
            </select>
          </Field>
        )}
        <Field label="To-do" htmlFor={ids.t} error={f.text}><input className="input" data-autofocus value={text} maxLength={500} onChange={(e) => setText(e.target.value)} placeholder="e.g. Rewrite the hooks on scripts 3 and 7" {...inputProps(ids.t, f.text)} /></Field>
        <Field label="Due" optional htmlFor={ids.d} error={f.due}><input className="input" type="date" value={due} onChange={(e) => setDue(e.target.value)} {...inputProps(ids.d, f.due)} /></Field>
      </form>
    </Dialog>
  );
}
