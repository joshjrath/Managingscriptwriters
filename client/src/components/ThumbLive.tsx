// Went live: the small Live badge on a win that went live (a link to the video in a new tab), the went-live line and
// the Test & Compare winner as a brief and a portfolio card show them, and a manager's "Went live" dialog on a picked
// brief (POST /api/thumbnails/:id/published with a ThumbnailLiveInput, checked first with liveProblems in
// shared/workflow.ts, as the route checks it; the day starts at today in the workspace's time zone). The dialog sends
// only the fields the manager changed (liveChanges), so another manager's change to another field stays; it can
// take the mark back (every field null: TAKE_BACK). Built on ui.tsx and the .wl- styles in app.css.

import { useId, useState } from 'react';
import { Check, CircleAlert, ExternalLink, FlaskConical, Radio, Undo2 } from 'lucide-react';
import { api, useSave } from '../api';
import type { ThumbnailBriefDetail, ThumbnailLive, ThumbnailLiveBadge, ThumbnailLiveInput, ThumbnailTestWinner } from '../../../shared/types';
import { clearsLive, LIVE_LIMITS, liveChanges, liveProblems, type LiveFields } from '../../../shared/workflow';
import type { ISODate } from '../../../shared/dates';
import { fmtDate, fmtLong, plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { Button, Chip, Dialog, Field, FormError, inputProps, Thumb, useFieldId, useToast } from './ui';
import { optionAlt } from './ThumbBits';

/** A link in a few words, as people read one: "youtube.com/watch?v=abc" (no https://, no www.). */
export function linkWords(url: string): string {
  try {
    const u = new URL(url);
    const rest = `${u.pathname}${u.search}`.replace(/\/$/, '');
    return `${u.hostname.replace(/^www\./, '')}${rest}`;
  } catch {
    return url;
  }
}

/**
 * "Live" on a win marked live: a link to the video (a new tab) when there is one, else the chip alone with the day it
 * went live for screen readers; nothing when it isn't marked. Never put it inside another link: it sits beside one.
 */
export function LiveBadge({ live, className = '' }: { live: ThumbnailLiveBadge | null | undefined; className?: string }) {
  const { clock } = useBoot();
  if (!live) return null;
  const when = fmtDate(live.publishedOn, clock.today);
  const chip = <Chip color="mint" icon={<Radio aria-hidden />}>Live</Chip>;
  return live.url
    ? (
      <a className={`live-badge ${className}`} href={live.url} target="_blank" rel="noopener noreferrer" title={`Went live ${when}: ${linkWords(live.url)}`}
        aria-label={`Live since ${when}: watch the video (opens in a new tab)`}>
        {chip}
      </a>
    )
    : <span className={`live-badge ${className}`} title={`Went live ${when}`}>{chip}<span className="sr-only"> since {when}</span></span>;
}

/** "Went live: youtube.com/watch?v=… · Oct 20", the link opening in a new tab. */
export function LiveLine({ live, className = '' }: { live: Pick<ThumbnailLive, 'url' | 'publishedOn'>; className?: string }) {
  const { clock } = useBoot();
  return (
    <p className={`live-line ${className}`}>
      <Radio aria-hidden />
      <span className="live-line-t">
        <span>Went live{live.url ? ': ' : ' '}</span>
        {live.url && (
          <a className="live-line-a" href={live.url} target="_blank" rel="noopener noreferrer" title={live.url}>
            {linkWords(live.url)}<ExternalLink aria-hidden /><span className="sr-only"> (opens in a new tab)</span>
          </a>
        )}
        <span className="live-line-d">{live.url ? ' · ' : ''}<time dateTime={live.publishedOn} title={fmtLong(live.publishedOn)}>{fmtDate(live.publishedOn, clock.today)}</time></span>
      </span>
    </p>
  );
}

/** "Test & Compare: B won, the pick", with its picture when the viewer may open it (only its letter otherwise), and the manager's note. */
export function TestWinnerLine({ winner, note, title, className = '' }: { winner: ThumbnailTestWinner | null; note: string | null; title: string; className?: string }) {
  if (!winner && !note) return null;
  return (
    <div className={`live-test ${className}`}>
      {winner?.url && (
        <span className="live-test-pic">
          <Thumb src={winner.url} alt={optionAlt({ letter: winner.letter }, title)}><span className="thumb-letter" aria-hidden>{winner.letter}</span></Thumb>
        </span>
      )}
      <span className="live-test-t">
        <span className="live-test-k"><FlaskConical aria-hidden />Test &amp; Compare</span>
        {winner && <b>{winner.isPick ? `${winner.letter} won: the picked one` : `Option ${winner.letter} from round ${winner.roundNumber} won`}</b>}
        {note && <q>{note}</q>}
      </span>
    </div>
  );
}

/** The went-live line and the test winner together, or nothing when it isn't marked. */
export function LiveSummary({ live, title, className = '' }: { live: ThumbnailLive | null | undefined; title: string; className?: string }) {
  if (!live) return null;
  return (
    <div className={`live-sum ${className}`}>
      <LiveLine live={live} />
      <TestWinnerLine winner={live.testWinner} note={live.testNote} title={title} />
    </div>
  );
}

const fieldsOf = (l: ThumbnailLive | null): LiveFields => ({ url: l?.url ?? null, publishedOn: l?.publishedOn ?? null, testWinnerOptionId: l?.testWinner?.optionId ?? null, testNote: l?.testNote ?? null });
/** "Not live after all": every field sent, and every one empty. */
const TAKE_BACK: ThumbnailLiveInput = { url: null, publishedOn: null, testWinnerOptionId: null, testNote: null };

/**
 * Marks a picked brief live, changes the mark or takes it back (managers): the video's link (https, optional), the day
 * it went live (today in the workspace's time zone to start with), YouTube Test & Compare's winner among the options
 * sent on the brief when they ran one, and a note on the test. The picked option's maker is told the first time.
 */
export function WentLiveDialog({ brief, onClose }: { brief: ThumbnailBriefDetail; onClose: () => void }) {
  const { clock } = useBoot();
  const toast = useToast();
  // the mark this form started from: saving compares against it, so a refetch never undoes what's typed
  const [base] = useState<ThumbnailLive | null>(brief.live);
  const [url, setUrl] = useState(base?.url ?? '');
  const [day, setDay] = useState<string>(base?.publishedOn ?? clock.today);
  const [winner, setWinner] = useState<number | null>(base?.testWinner?.optionId ?? null);
  const [note, setNote] = useState(base?.testNote ?? '');
  const [local, setLocal] = useState<Record<string, string>>({});
  const [takingBack, setTakingBack] = useState(false);
  const ids = { u: useFieldId('wl-url'), d: useFieldId('wl-day'), n: useFieldId('wl-note') };
  const group = useId();
  const maker = brief.winner?.uploadedByName ?? null;
  // every option sent on the brief, newest round first (Test & Compare runs on what was sent, never a tray)
  const rounds = brief.rounds.filter((r) => r.sentAt && r.options.length).slice().reverse();
  const count = rounds.reduce((n, r) => n + r.options.length, 0);

  const save = useSave((body: ThumbnailLiveInput) => api<ThumbnailBriefDetail>(`/api/thumbnails/${brief.id}/published`, { body: { ...body } }), {
    onSuccess: (out) => {
      if (!out.live) toast(`${out.title} isn’t marked live any more`);
      else if (!base) toast(`${out.title} is marked live.${maker ? ` ${maker} is told.` : ''}`);
      else toast(`Went-live details saved for ${out.title}`);
      onClose();
    },
  });
  const f = { ...local, ...(save.error?.fields ?? {}) };
  const input = (): ThumbnailLiveInput => ({ url: url.trim() || null, publishedOn: (day || null) as ISODate | null, testWinnerOptionId: winner, testNote: note.trim() || null });
  // only what the manager changed since it opened (a new mark: every field filled in, the day included)
  const changes = () => liveChanges(base && fieldsOf(base), input());
  const changed = !base || Object.keys(changes()).length > 0;
  const backing = save.isPending && save.variables === TAKE_BACK;
  const send = (body: ThumbnailLiveInput) => save.mutate(body, {
    // it isn't picked any more (decided again elsewhere): say so; the page refreshes to it (useSave refetches on a 409).
    // A link to a YouTube video already on another thumbnail (409 youtube_taken) stays open, said beside the link
    onError: (e) => { if (e.status === 409 && e.code !== 'youtube_taken') { toast(e.message, 'error'); onClose(); } },
  });
  const submit = () => {
    // the whole form is the mark it leaves: checked as the route checks it
    const whole = input();
    const problems: Record<string, string> = { ...liveProblems(whole) };
    // a new mark always needs its day; emptying every field of a kept mark is what "Take back" does
    if (clearsLive(whole) && !base) problems.publishedOn = 'Add the day it went live';
    setLocal(problems);
    if (Object.keys(problems).length) return;
    send(changes());
  };
  const takeBack = () => send(TAKE_BACK);

  return (
    <Dialog open onClose={onClose} title={base ? 'Went live' : 'Mark it live'} sub={brief.title}
      footer={(
        <div className="form-actions">
          {base && (takingBack
            ? <Button variant="danger left" icon={<Undo2 aria-hidden />} busy={backing} onClick={takeBack}>Take back the mark?</Button>
            : <Button variant="ghost left" icon={<Undo2 aria-hidden />} onClick={() => setTakingBack(true)}>Not live after all</Button>)}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="mint pill" icon={<Check aria-hidden />} busy={save.isPending && !backing} disabled={!changed} onClick={submit}>
            {base ? 'Save' : 'Mark live'}
          </Button>
        </div>
      )}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }} noValidate>
        <FormError error={save.error && save.error.status !== 409 && !Object.keys(save.error.fields).length ? save.error : null} />
        {takingBack && (
          <p className="wl-back" role="status">
            {maker ? `${maker}’s portfolio stops showing it as live` : 'It stops showing as live'}, and the link, day and test go. Their message about it is taken back if they haven’t read it.
          </p>
        )}
        {!base && <p className="muted wl-intro">{maker ? `${maker} is told once, and their portfolio shows where it went live.` : 'Their portfolio shows where it went live.'} Nothing is posted anywhere: this only records it.</p>}
        <div className="form-grid wl-grid">
          <Field label="The video’s link" optional htmlFor={ids.u} error={f.url} help="Where it’s live: the YouTube video’s address, starting with https://">
            <input className="input" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder="https://www.youtube.com/watch?v=…" value={url} data-autofocus
              onChange={(e) => setUrl(e.target.value)} {...inputProps(ids.u, f.url)} />
          </Field>
          <Field label="Went live on" htmlFor={ids.d} error={f.publishedOn} help={day === clock.today ? 'Today, in the workspace’s time zone.' : undefined}>
            <input className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} {...inputProps(ids.d, f.publishedOn)} />
          </Field>
        </div>
        {count > 0 && (
          <fieldset className="field wl-test" aria-describedby={f.testWinnerOptionId ? `${group}-err` : `${group}-help`}>
            <legend className="lbl">Test &amp; Compare winner<span className="opt">optional</span></legend>
            <span className="help" id={`${group}-help`}>If you ran YouTube’s Test &amp; Compare, which of the options sent on this brief won it.</span>
            <div className="wl-opts">
              <label className={`wl-opt none${winner == null ? ' on' : ''}`}>
                <input type="radio" className="sr-only" name={group} checked={winner == null} onChange={() => setWinner(null)} />
                <span className="wl-none"><FlaskConical aria-hidden />No test recorded</span>
              </label>
              {rounds.flatMap((r) => r.options.map((o) => (
                <label key={o.id} className={`wl-opt${winner === o.id ? ' on' : ''}${o.picked ? ' picked' : ''}`}>
                  <input type="radio" className="sr-only" name={group} checked={winner === o.id} onChange={() => setWinner(o.id)} />
                  <Thumb src={o.url} alt="">
                    <span className="thumb-letter" aria-hidden>{o.letter}</span>
                    {o.picked && <span className="thumb-tr"><Chip color="mint" icon={<Check aria-hidden />}>Pick</Chip></span>}
                  </Thumb>
                  <span className="wl-opt-t">Option {o.letter} · round {r.number}{o.picked ? <span className="sr-only"> (the pick)</span> : null}</span>
                </label>
              )))}
            </div>
            {f.testWinnerOptionId && <span className="err" role="alert" id={`${group}-err`}><CircleAlert aria-hidden />{f.testWinnerOptionId}</span>}
          </fieldset>
        )}
        <Field label="A note on the test" optional htmlFor={ids.n} error={f.testNote}
          help={`What it showed, in a line. ${plural(Math.max(0, LIVE_LIMITS.note - note.length), 'character')} left.`}>
          <textarea className="textarea wl-note" value={note} maxLength={LIVE_LIMITS.note} placeholder="e.g. B kept people watching longer on phones"
            onChange={(e) => setNote(e.target.value)} {...inputProps(ids.n, f.testNote)} />
        </Field>
      </form>
    </Dialog>
  );
}
