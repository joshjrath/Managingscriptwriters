// "Written so far": a writer's own count of scripts they've finished writing,
// so their manager can follow along. It's only an update: nothing is sent.

import { useEffect, useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { api, queryClient, useSave } from '../api';

export function WrittenCounter({ batchId, writerId, forOther, total, sent, written, compact }: { batchId: number; writerId: number; forOther: boolean; total: number; sent: number; written: number; compact?: boolean }) {
  const [value, setValue] = useState(written);
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef(false);
  /** a count tapped in but not sent yet (taps are sent together, a moment after the last one) */
  const pending = useRef<number | null>(null);
  useEffect(() => { if (!dirty.current) setValue(written); }, [written]);
  const send = (n: number) => api<{ written: number }>(`/api/batches/${batchId}/written`, { body: { written: n, writerId: forOther ? writerId : undefined } });
  // leaving the page right after tapping still sends it (nothing is left on screen to report a failure;
  // the next visit shows the count the server has)
  useEffect(() => () => {
    window.clearTimeout(timer.current);
    // taken, so it's sent once and only to the batch it was tapped on
    const n = pending.current;
    pending.current = null;
    if (n != null) send(n).then(() => queryClient.invalidateQueries(), () => {});
  }, [batchId, writerId, forOther]); // eslint-disable-line react-hooks/exhaustive-deps -- send reads only these
  const save = useSave(send, {
    onSuccess: (out) => { dirty.current = false; setValue(out.written); setState('saved'); },
  });
  const change = (n: number) => {
    const v = Math.max(sent, Math.min(total, n));
    if (v === value) return;
    setValue(v);
    dirty.current = true;
    setState('saving');
    pending.current = v;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { pending.current = null; save.mutate(v); }, 650);
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
