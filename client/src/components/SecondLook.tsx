// The AI second look on a designer's own option (in their tray and in the rounds they sent): a "Second look" button,
// hidden when the server has no AI key (boot.secondLook), a shimmer while Claude looks, then a compact panel with the
// one-liner, the six checks as chips (SECOND_LOOK_STATUS_COLOR: strong mint, ok neutral, watch yellow, each with its
// own icon so it never rests on colour alone) and, opened, their notes and up to three suggestions. It's advice,
// private to the option's maker, and never stops a round being sent. POST /api/thumbnail-options/:id/second-look
// asks once; after that the one kept rides on the option. One at a time: the other buttons wait while one runs.

import { useEffect, useId, useRef, useState } from 'react';
import { useIsMutating } from '@tanstack/react-query';
import { AlertTriangle, Check, ChevronDown, Minus, Sparkles } from 'lucide-react';
import { api, useSave } from '../api';
import type { ThumbnailOption, ThumbnailSecondLook } from '../../../shared/types';
import {
  SECOND_LOOK_CHECK_LABEL, SECOND_LOOK_STATUS_COLOR, SECOND_LOOK_STATUS_LABEL, secondLookRefusal, type SecondLookStatus,
} from '../../../shared/workflow';
import { plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { Button, Chip, useToast } from './ui';

const SAVE_KEY = ['second-look'] as const;
const ICON: Record<SecondLookStatus, typeof Check> = { strong: Check, ok: Minus, watch: AlertTriangle };

/**
 * Takes keyboard focus when it's on nothing: the button pressed (then the shimmer) has just gone, so focus stays here
 * rather than dropping to the top of the page. Focus someone has since moved elsewhere is left alone.
 */
const takeFocus = (el: HTMLElement | null) => {
  if (el && (!document.activeElement || document.activeElement === document.body)) el.focus({ preventScroll: true });
};

/** The button and, once asked, the panel, for one of the designer's own options. Nothing for anyone else's. */
export function SecondLook({ option }: { option: ThumbnailOption }) {
  const { me, secondLook: available } = useBoot();
  const toast = useToast();
  // the answer as it came back, in case the page hasn't refreshed with it yet; asked here, it opens with its notes
  const [got, setGot] = useState<ThumbnailSecondLook | null>(null);
  const [asked, setAsked] = useState(false);
  const running = useIsMutating({ mutationKey: SAVE_KEY });
  const ask = useSave((o: ThumbnailOption) => api<ThumbnailSecondLook>(`/api/thumbnail-options/${o.id}/second-look`, { method: 'POST' }), {
    key: SAVE_KEY,
    onSuccess: (out) => setGot(out),
  });
  const look = option.secondLook ?? (got?.optionId === option.id ? got : null);
  if (look) return <SecondLookPanel look={look} startOpen={asked} />;
  if (!available || option.uploadedById !== me.id) return null;
  if (ask.isPending) {
    return (
      <div ref={takeFocus} tabIndex={-1} className="sl sl-wait" role="status">
        <span className="sl-k"><Sparkles aria-hidden />Taking a second look at option {option.letter}…</span>
        <span className="sl-skel" aria-hidden><i /><i /><i /></span>
      </div>
    );
  }
  const go = () => {
    const no = secondLookRefusal(option);
    if (no) { toast(no, 'error'); return; }
    setAsked(true);
    ask.mutate(option, { onError: (e) => { setAsked(false); toast(e.message, 'error'); } });
  };
  return (
    <div className="sl-ask">
      <Button variant="sm ghost" icon={<Sparkles aria-hidden />} disabled={running > 0} onClick={go} aria-label={`Second look at option ${option.letter}: a quick private critique`}>
        Second look
      </Button>
      <span className="sl-ask-t">{running > 0 ? 'One at a time: another is running' : 'A quick critique, just for you'}</span>
    </div>
  );
}

/**
 * What a second look said: the headline and the six checks, then (opened) their notes and the suggestions.
 * `startOpen`: it was just asked for here, so it opens with its notes and takes the focus the shimmer had.
 */
export function SecondLookPanel({ look, startOpen = false }: { look: ThumbnailSecondLook; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const bid = `sl-${useId().replace(/:/g, '')}`;
  const n = look.suggestions.length;
  const box = useRef<HTMLElement>(null);
  useEffect(() => { if (startOpen) takeFocus(box.current); }, [startOpen]);
  return (
    <section ref={box} tabIndex={-1} className="sl" aria-label="Second look">
      <div className="sl-head">
        <span className="sl-k"><Sparkles aria-hidden />Second look</span>
        <span className="sl-private">just for you</span>
      </div>
      <p className="sl-one">{look.oneLiner}</p>
      <ul className="sl-chips" aria-label="The checks">
        {look.checks.map((c) => {
          const Icon = ICON[c.status];
          return (
            <li key={c.key}>
              <Chip color={SECOND_LOOK_STATUS_COLOR[c.status]} icon={<Icon aria-hidden />} title={`${SECOND_LOOK_STATUS_LABEL[c.status]}: ${c.note}`}>
                {SECOND_LOOK_CHECK_LABEL[c.key]}<span className="sr-only">: {SECOND_LOOK_STATUS_LABEL[c.status]}</span>
              </Chip>
            </li>
          );
        })}
      </ul>
      <button type="button" className="sl-more" aria-expanded={open} aria-controls={bid} onClick={() => setOpen((v) => !v)}>
        {open ? 'Hide the notes' : n ? `The notes, and ${plural(n, 'thing')} to try` : 'The notes'}
        <ChevronDown className={`chev${open ? ' up' : ''}`} aria-hidden />
      </button>
      {open && (
        <div id={bid} className="sl-body">
          <dl className="sl-notes">
            {look.checks.map((c) => (
              <div key={c.key} className={c.status}>
                <dt>{SECOND_LOOK_CHECK_LABEL[c.key]} <span>· {SECOND_LOOK_STATUS_LABEL[c.status]}</span></dt>
                <dd>{c.note}</dd>
              </div>
            ))}
          </dl>
          {n > 0 && (
            <>
              <div className="sl-try">To try</div>
              <ol className="sl-sugs">{look.suggestions.map((s, i) => <li key={i}>{s}</li>)}</ol>
            </>
          )}
          <p className="sl-foot">Advice, not a rule: nobody else sees it, and sending is up to you.</p>
        </div>
      )}
    </section>
  );
}
