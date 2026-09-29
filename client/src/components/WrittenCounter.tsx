// "Written so far": a writer's own count of scripts they've finished writing,
// so their manager can follow along. It's only an update: nothing is sent.

import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { api, useSave } from '../api';

export function WrittenCounter({ batchId, writerId, forOther, total, sent, written, compact }: { batchId: number; writerId: number; forOther: boolean; total: number; sent: number; written: number; compact?: boolean }) {
  const [value, setValue] = useState(written);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  useEffect(() => { if (!dirty.current) setValue(written); }, [written]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const save = useSave((n: number) => api<{ written: number }>(`/api/batches/${batchId}/written`, { body: { written: n, writerId: forOther ? writerId : undefined } }), {
    onSuccess: (out) => { dirty.current = false; setValue(out.written); setState('saved'); },
  });
  const change = (n: number) => {
    const v = Math.max(sent, Math.min(total, n));
    if (v === value) return;
    setValue(v);
    dirty.current = true;
    setState('saving');
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => save.mutate(v), 650);
  };
  const stepper = (
    <div className="stepper">
      <button type="button" className="icon-btn" aria-label="One fewer written" disabled={value <= sent} onClick={() => change(value - 1)}><Minus /></button>
      <div className="val"><b key={value} className="num pop">{value}</b><small>/ {total}</small></div>
      <button type="button" className="icon-btn" aria-label="One more written" disabled={value >= total} onClick={() => change(value + 1)}><Plus /></button>
    </div>
  );
  const status = <span className="save-state" role="status">{save.isError ? 'Not saved. Try again.' : state === 'saving' ? 'Saving…' : state === 'saved' ? <><Check aria-hidden /> Saved</> : ''}</span>;
  if (compact) return <div className="counter-compact" role="group" aria-label="Written so far">{stepper}{status}</div>;
  return (
    <div className="counter-block" role="group" aria-label="Written so far">
      <div style={{ minWidth: 0, flex: '1 1 220px' }}>
        <div className="t">Written so far</div>
        <div className="s">{forOther ? 'Updates the writer’s progress for managers.' : 'Keeps your manager posted.'} It doesn’t send or change any scripts.{sent ? ` Includes the ${sent} already sent.` : ''}</div>
      </div>
      {stepper}
      {status}
    </div>
  );
}
