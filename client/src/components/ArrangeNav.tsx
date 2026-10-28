// Arrange sidebar (the Admin's, from the account menu): drag the sidebar's items into order, or move one with its
// arrows. Saving sets the order for everyone (PUT /api/settings/nav-order): each person's menu has the items that are
// theirs, in this order (applyNavOrder in shared/workflow.ts); a video editor's Home and a designer's Studio pages keep their places.

import { useState, type DragEvent, type ReactNode } from 'react';
import { m } from 'framer-motion';
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from 'lucide-react';
import { api, useSave } from '../api';
import { Button, Dialog, FormError, useToast } from './ui';
import { SPRING } from '../motion';

export interface ArrangeItem { to: string; label: string; icon: ReactNode; who: string }

export function ArrangeNavDialog({ items, saved, onClose }: { items: ArrangeItem[]; saved: boolean; onClose: () => void }) {
  const toast = useToast();
  const [list, setList] = useState(items);
  const [dragging, setDragging] = useState<string | null>(null);
  const save = useSave((order: string[] | null) => api('/api/settings/nav-order', { method: 'PUT', body: { order } }), {
    onSuccess: (_out, order) => { toast(order ? 'Sidebar arranged for everyone' : 'Sidebar back in its usual order'); onClose(); },
  });
  const move = (from: number, to: number) => {
    if (to < 0 || to >= list.length || from === to) return;
    const next = [...list];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setList(next);
  };
  // while dragging, the list makes room as the item passes over the others
  const over = (e: DragEvent, i: number) => {
    if (!dragging) return;
    e.preventDefault();
    const from = list.findIndex((x) => x.to === dragging);
    if (from !== i) move(from, i);
  };
  const changed = list.some((x, i) => x.to !== items[i].to);
  return (
    <Dialog open onClose={onClose} size="narrow" title="Arrange sidebar"
      sub="Drag items into the order you want. Everyone’s sidebar follows it, showing only the items that are theirs. A video editor’s Home and a designer’s Studio pages stay at the top."
      footer={<div className="form-actions">
        {saved && <Button variant="ghost" icon={<RotateCcw aria-hidden />} busy={save.isPending} onClick={() => save.mutate(null)}>Usual order</Button>}
        <span className="spacer" />
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary pill" disabled={!changed} busy={save.isPending} onClick={() => save.mutate(list.map((x) => x.to))}>Save for everyone</Button>
      </div>}>
      <FormError error={save.error} />
      <ol className="arrange-list" aria-label="Sidebar items, in order">
        {list.map((it, i) => (
          // the native drag lives on the row inside: framer-motion keeps onDragStart and onDragEnd for its own gestures
          <m.li key={it.to} layout transition={SPRING} className={`arrange-item${dragging === it.to ? ' dragging' : ''}`}>
            <div className="arrange-row" draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragging(it.to); }}
              onDragEnd={() => setDragging(null)} onDragOver={(e) => over(e, i)} onDrop={(e) => e.preventDefault()}>
              <GripVertical className="grip" aria-hidden />
              <span className="ic" aria-hidden>{it.icon}</span>
              <span className="t"><b>{it.label}</b><small>{it.who}</small></span>
              <span className="arrows">
                <button type="button" className="icon-btn sm" onClick={() => move(i, i - 1)} disabled={i === 0} aria-label={`Move ${it.label} up`}><ArrowUp aria-hidden /></button>
                <button type="button" className="icon-btn sm" onClick={() => move(i, i + 1)} disabled={i === list.length - 1} aria-label={`Move ${it.label} down`}><ArrowDown aria-hidden /></button>
              </span>
            </div>
          </m.li>
        ))}
      </ol>
    </Dialog>
  );
}
