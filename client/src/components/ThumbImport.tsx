// Past thumbnails from YouTube. A manager's "Add past thumbnails" dialog on the board (POST
// /api/thumbnails/youtube/lookup with a YoutubeLookupInput, then /import with a YoutubeImportInput), and the line an
// imported brief, win or portfolio card shows where a round story would be ("Added from YouTube", with "Watch on
// YouTube" in a new tab). Rules and wording: the past-thumbnails section of shared/workflow.ts.
//
// The dialog: paste up to YOUTUBE_IMPORT_LIMITS.links links (pastedLinks, one per line), Look up (nothing is stored),
// and each video becomes a row with YouTube's thumbnail, title, channel and day it went live, a client (prefilled with
// the server's suggestion) and, when YouTube didn't say, the day (importDayProblem, as the route checks it). Rows that
// can't be used say why and are left out; a video already on the site links to its brief. One designer for them all
// ("Who made these?"), then "Add N to <designer>'s wall". What the server skips stays in the dialog with its reason.
// Built on ui.tsx and the .yi- styles in app.css.

import { useEffect, useId, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Check, CircleAlert, ExternalLink, Import, Link2, Pencil, Search, SquarePlay, Undo2 } from 'lucide-react';
import { api, useSave, type ApiError } from '../api';
import type {
  ThumbnailDesignerLoad, ThumbnailImportBadge, ThumbnailImported, YoutubeImportInput, YoutubeImportItem, YoutubeImportResult, YoutubeLookupFound, YoutubeLookupInput,
  YoutubeLookupProblem, YoutubeLookupResult, YoutubeLookupRow,
} from '../../../shared/types';
import { importDayProblem, pastedLinks, portfolioPath, thumbBriefPath, YOUTUBE_FIRST_DAY, YOUTUBE_IMPORT_LIMITS, youtubeLookupRows } from '../../../shared/workflow';
import type { ISODate } from '../../../shared/dates';
import { fmtAgo, fmtDate, fmtLong, plural } from '../../../shared/format';
import { useMotionAllowed } from '../motion';
import { useBoot } from './Shell';
import { Button, Dialog, ExtLink, Field, FormError, inputProps, Thumb, useFieldId, useToast } from './ui';

// ── "Added from YouTube" ─────────────────────────────────────────────────

/**
 * "Added from YouTube · Watch on YouTube" on a past thumbnail (the link opens a new tab); nothing for one made on the
 * site. `compact` stacks the two on a small tile. Never put it inside another link: it sits beside one.
 */
export function AddedFromYoutube({ imported, className = '', compact }: { imported: ThumbnailImportBadge | null | undefined; className?: string; compact?: boolean }) {
  if (!imported) return null;
  return (
    <p className={`yt-from${compact ? ' compact' : ''} ${className}`}>
      <span className="yt-from-k"><Import aria-hidden />{compact ? <><span className="sr-only">Added </span>From YouTube</> : 'Added from YouTube'}</span>
      <span className="yt-from-sep" aria-hidden>·</span>
      <ExtLink href={imported.url} className="yt-from-a">
        <SquarePlay aria-hidden />Watch on YouTube<span className="sr-only"> (opens in a new tab)</span>
      </ExtLink>
    </p>
  );
}

/**
 * Where a brief's round strip would be, for a past thumbnail: it went live before it came to the site, so there are
 * no rounds to show, only where it came from, who added it and when.
 */
export function ImportedRounds({ imported, maker, now }: { imported: ThumbnailImported; maker: string | null; now: number }) {
  const hid = useId();
  return (
    <section className="panel rs yi-rounds" aria-labelledby={hid}>
      <div className="panel-head">
        <h2 id={hid}>How it came about</h2>
        <span className="sub">no rounds: it was out on YouTube first</span>
      </div>
      <p className="yi-rounds-t">
        {maker ? `${maker}’s thumbnail` : 'This thumbnail'} went live on YouTube{imported.channel ? ` (${imported.channel})` : ''} before it came to the site, so there are
        no rounds or notes to show. {imported.importedByName ?? 'A manager'} added it {fmtAgo(imported.importedAt, now)}.
      </p>
      <AddedFromYoutube imported={imported} />
    </section>
  );
}

// ── the dialog ───────────────────────────────────────────────────────────

/** What the manager has set on one usable row. */
interface RowEdit {
  include: boolean;
  /** a client's id, or '' until one is chosen */
  clientId: string;
  /** the day it went live (YYYY-MM-DD), YouTube's to start with */
  day: string;
  /** the brief's title when the manager changed YouTube's; null keeps YouTube's */
  title: string | null;
}

/** A row the server didn't add on import: the lookup's row, with the import's reason. */
type Skipped = YoutubeImportResult['skipped'][number];

/** A row that can't be added, as the list shows it: the lookup's problem, or the import's. */
interface ProblemRow { key: string; input: string; title: string | null; problem: string; existing?: { briefId: number; title: string } }

const isFound = (r: YoutubeLookupRow): r is YoutubeLookupFound => r.ok;

/** The day YouTube gave, when it's one the import would take; null when the manager must type it. */
const youtubeDay = (r: YoutubeLookupFound, today: ISODate): ISODate | null => (r.publishedOn && !importDayProblem(r.publishedOn, today) ? r.publishedOn : null);

/**
 * "Add past thumbnails": paste up to YOUTUBE_IMPORT_LIMITS.links YouTube links, look them up, pick a client per row
 * and one designer for them all, and add them to that designer's wall. Rendered while open, like BriefDialog.
 * `designerId` starts the designer select (the board's designer filter); with only one designer, they're chosen.
 */
export function YoutubeImportDialog({ designers, designerId: startDesigner, onClose }: { designers: ThumbnailDesignerLoad[]; designerId?: number | null; onClose: () => void }) {
  const { clients, clock, me } = useBoot();
  const toast = useToast();
  const nav = useNavigate();
  const allowed = useMotionAllowed();
  const [text, setText] = useState('');
  const [rows, setRows] = useState<YoutubeLookupRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, RowEdit>>({});
  const [skipped, setSkipped] = useState<Record<string, Skipped>>({});
  const [added, setAdded] = useState<{ designer: { id: number; name: string }; briefs: YoutubeImportResult['added'] } | null>(null);
  const [designerId, setDesignerId] = useState<number | ''>(() => {
    if (startDesigner != null && designers.some((x) => x.id === startDesigner)) return startDesigner;
    return designers.length === 1 ? designers[0].id : '';
  });
  const [local, setLocal] = useState<Record<string, string>>({});
  const ids = { links: useFieldId('yi-links'), designer: useFieldId('yi-who') };
  const box = useRef<HTMLDivElement>(null);
  const summary = useRef<HTMLParagraphElement>(null);
  const linksBox = useRef<HTMLTextAreaElement>(null);
  const offered = clients.filter((c) => c.status !== 'archived');

  const links = pastedLinks(text);
  const planned = youtubeLookupRows(links);
  const tooLong = links.some((l) => l.length > YOUTUBE_IMPORT_LIMITS.url);
  const tooMany = planned.length > YOUTUBE_IMPORT_LIMITS.links;

  const look = useMutation<YoutubeLookupResult, ApiError, YoutubeLookupInput>({
    mutationFn: (input) => api<YoutubeLookupResult>('/api/thumbnails/youtube/lookup', { body: { ...input } }),
    onSuccess: (out) => {
      // what was set on a video looked up again stays; a new one starts from what YouTube and the server said
      setEdits((prev) => {
        const next: Record<string, RowEdit> = {};
        for (const r of out.rows.filter(isFound)) {
          const suggested = r.suggestedClientId != null && offered.some((c) => c.id === r.suggestedClientId) ? String(r.suggestedClientId) : '';
          next[r.videoId] = prev[r.videoId] ?? { include: true, clientId: suggested, day: youtubeDay(r, clock.today) ?? '', title: null };
        }
        return next;
      });
      setRows(out.rows);
      setSkipped({});
      setLocal({});
      save.reset();
    },
  });
  const save = useSave((input: YoutubeImportInput) => api<YoutubeImportResult>('/api/thumbnails/youtube/import', { body: { ...input } }), {
    onSuccess: (out, input) => {
      const who = designers.find((x) => x.id === input.designerId);
      const name = who?.name ?? 'the designer';
      if (out.added.length) {
        toast(`${plural(out.added.length, 'past thumbnail')} added to ${name}’s wall. They’re told.`, 'ok', {
          label: 'Open portfolio', run: () => { void nav(portfolioPath({ userId: input.designerId })); },
        });
      }
      if (!out.skipped.length) { onClose(); return; }
      // the rest stay, with why: a video someone else just added, or one YouTube can't read right now
      setAdded((prev) => ({ designer: { id: input.designerId, name }, briefs: [...(prev?.designer.id === input.designerId ? prev.briefs : []), ...out.added] }));
      setSkipped((prev) => ({ ...prev, ...Object.fromEntries(out.skipped.map((s) => [s.videoId, s])) }));
      if (!out.added.length) toast(out.skipped.length === 1 ? 'That one wasn’t added: the reason is on its row.' : 'None of them were added: the reasons are on their rows.', 'error');
    },
  });

  // the results take the keyboard once they're in (and the links box once they're gone), so a keyboard user lands where the work is
  const stage = rows ? 'rows' : 'paste';
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    requestAnimationFrame(() => (stage === 'rows' ? summary.current : linksBox.current)?.focus({ preventScroll: false }));
  }, [stage, rows]);

  const addedIds = new Set(added?.briefs.map((b) => b.videoId) ?? []);
  const found = (rows ?? []).filter(isFound).filter((r) => !addedIds.has(r.videoId) && !skipped[r.videoId]);
  const problems: ProblemRow[] = [
    ...(rows ?? []).filter((r): r is YoutubeLookupProblem => !r.ok).map((r) => ({ key: `p:${r.input}`, input: r.input, title: r.title ?? null, problem: r.problem, existing: r.existing })),
    ...(rows ?? []).filter(isFound).filter((r) => skipped[r.videoId]).map((r) => ({ key: `s:${r.videoId}`, input: r.input, title: r.title, problem: skipped[r.videoId].problem, existing: skipped[r.videoId].existing })),
  ];
  const chosen = found.filter((r) => edits[r.videoId]?.include);
  const designer = designers.find((x) => x.id === designerId) ?? null;

  // the server's field problems, put back on the rows they're about (items.<i>.* is the i-th item sent)
  const sent = save.variables?.items ?? [];
  const sf = save.error?.fields ?? {};
  const rowError = (key: 'clientId' | 'publishedOn' | 'title', videoId: string) => {
    const i = sent.findIndex((x) => x.videoId === videoId);
    return i >= 0 ? sf[`items.${i}.${key}`] : undefined;
  };
  const placed = (k: string) => k === 'designerId' || /^items\.\d+\.(clientId|publishedOn|title)$/.test(k);
  const generalSave = save.error && !Object.keys(sf).some(placed) ? save.error : null;

  const edit = (videoId: string, patch: Partial<RowEdit>) => {
    setEdits((all) => ({ ...all, [videoId]: { ...all[videoId], ...patch } }));
    // a fixed field stops saying what was wrong with it
    setLocal((all) => {
      const next = { ...all };
      if ('clientId' in patch) delete next[`client:${videoId}`];
      if ('day' in patch) delete next[`day:${videoId}`];
      if ('title' in patch) delete next[`title:${videoId}`];
      if ('include' in patch) { delete next[`client:${videoId}`]; delete next[`day:${videoId}`]; delete next[`title:${videoId}`]; delete next.items; }
      return next;
    });
  };

  const lookUp = () => {
    const errs: Record<string, string> = {};
    if (!planned.length) errs.links = 'Paste at least one YouTube link';
    else if (tooMany) errs.links = `Up to ${YOUTUBE_IMPORT_LIMITS.links} videos at a time: this is ${planned.length}. Add the rest after.`;
    else if (tooLong) errs.links = `One of these is over ${YOUTUBE_IMPORT_LIMITS.url} characters, so it isn’t a video’s link.`;
    setLocal(errs);
    if (Object.keys(errs).length) { linksBox.current?.focus(); return; }
    // a link repeated (or another link to the same video) is one row: sent once
    look.mutate({ urls: planned.map((p) => p.input) });
  };

  const submit = () => {
    const errs: Record<string, string> = {};
    if (designerId === '') errs.designer = 'Choose who made these';
    const items: YoutubeImportItem[] = [];
    for (const r of chosen) {
      const e = edits[r.videoId];
      if (!e.clientId) errs[`client:${r.videoId}`] = 'Choose the client';
      const dayProblem = importDayProblem(e.day, clock.today);
      if (dayProblem) errs[`day:${r.videoId}`] = dayProblem;
      const title = e.title?.trim() ?? '';
      if (e.title != null && !title) errs[`title:${r.videoId}`] = 'Type a title, or use YouTube’s';
      items.push({ videoId: r.videoId, clientId: Number(e.clientId), publishedOn: e.day.trim() as ISODate, ...(title && title !== r.title ? { title } : {}) });
    }
    if (!items.length) errs.items = 'Tick at least one video to add';
    setLocal(errs);
    if (Object.keys(errs).length) {
      // the first thing to fix, in the order the dialog reads
      requestAnimationFrame(() => box.current?.closest('dialog')?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    save.mutate({ designerId: designerId as number, items });
  };

  const backToLinks = () => { setRows(null); setLocal({}); look.reset(); save.reset(); };
  const f: Record<string, string> = { ...local, ...(look.error?.fields.urls ? { links: look.error.fields.urls } : {}), ...(sf.designerId ? { designer: sf.designerId } : {}) };

  if (!designers.length) {
    return (
      <Dialog open onClose={onClose} size="narrow" title="Add past thumbnails" footer={<div className="form-actions"><Button variant="primary pill" onClick={onClose}>OK</Button></div>}>
        <p className="muted">
          Past thumbnails go on a thumbnail designer’s wall, and there aren’t any yet. In Settings → Team, set an Editor’s Kind to Thumbnail designer, then come back.
        </p>
      </Dialog>
    );
  }

  const done = rows && !found.length && !!added?.briefs.length;
  const footer = !rows ? (
    <div className="form-actions yi-foot">
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      <Button variant="primary pill" icon={<Search aria-hidden />} busy={look.isPending} disabled={!planned.length} onClick={lookUp}>
        {look.isPending ? `Looking up ${plural(Math.min(planned.length, YOUTUBE_IMPORT_LIMITS.links), 'video')}…` : planned.length > 1 ? `Look up ${planned.length} videos` : 'Look up'}
      </Button>
    </div>
  ) : done ? (
    <div className="form-actions yi-foot">
      <Button variant="ghost left" icon={<Undo2 aria-hidden />} onClick={backToLinks}>Add more</Button>
      <Button variant="primary pill" icon={<Check aria-hidden />} onClick={onClose}>Done</Button>
    </div>
  ) : (
    <div className="form-actions yi-foot">
      <Button variant="ghost left" icon={<Undo2 aria-hidden />} onClick={backToLinks}>Change the links</Button>
      <Button variant="ghost" onClick={onClose}>{added?.briefs.length ? 'Done' : 'Cancel'}</Button>
      <Button variant="primary pill" icon={<Import aria-hidden />} busy={save.isPending} disabled={!found.length} onClick={submit}>
        {!chosen.length ? 'Add to the wall' : `Add ${chosen.length} to ${designer ? `${designer.name}’s` : 'the'} wall`}
      </Button>
    </div>
  );

  return (
    <Dialog open onClose={onClose} size="wide" title="Add past thumbnails"
      sub="Thumbnails already out on YouTube, added to a designer’s wall as picked and live. Titles, channels, dates and pictures come from YouTube."
      footer={footer}>
      <div ref={box} className={`form yi${allowed ? ' animate' : ''}`}>
        {!rows ? (
          <>
            <FormError error={look.error && !look.error.fields.urls ? look.error : null} />
            <Field label="YouTube links" htmlFor={ids.links} error={f.links}
              help={tooMany ? undefined : `One per line, up to ${YOUTUBE_IMPORT_LIMITS.links}: watch pages, Shorts and youtu.be links all work. Nothing is saved until you add them.`}>
              <textarea ref={linksBox} className="textarea yi-links" rows={6} value={text} data-autofocus spellCheck={false} autoComplete="off" autoCapitalize="off"
                disabled={look.isPending} placeholder={'https://www.youtube.com/watch?v=…\nhttps://youtu.be/…'}
                onChange={(e) => { setText(e.target.value); if (local.links) setLocal({}); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); lookUp(); } }}
                {...inputProps(ids.links, f.links)} />
            </Field>
            {planned.length > 0 && !look.isPending && (
              <p className={`yi-count${tooMany ? ' over' : ''}`} role="status">
                <Link2 aria-hidden />
                {plural(planned.length, 'video')}{links.length > planned.length ? ` (${plural(links.length - planned.length, 'repeat')} left out)` : ''}
                {tooMany ? ` · ${YOUTUBE_IMPORT_LIMITS.links} at most` : ''}
              </p>
            )}
            {look.isPending && <LookingUp n={Math.min(planned.length, YOUTUBE_IMPORT_LIMITS.links)} />}
          </>
        ) : (
          <>
            <p ref={summary} tabIndex={-1} className="yi-sum" role="status">
              {added?.briefs.length ? <><Check aria-hidden /><b>{plural(added.briefs.length, 'past thumbnail')} added to {added.designer.name}’s wall.</b></> : null}
              <span>
                {found.length || added?.briefs.length
                  ? `${found.length ? `${plural(found.length, 'video')} ready to add` : 'Nothing else to add'}${problems.length ? ` · ${problems.length} left out` : ''}`
                  : problems.length === 1 ? 'This one can’t be added' : 'None of these can be added'}
              </span>
              {added?.briefs.length ? <Link className="link" to={portfolioPath({ userId: added.designer.id })}>Open their portfolio</Link> : null}
            </p>
            <FormError error={generalSave} />
            {found.length > 0 && (
              <ul className="yi-rows" aria-label="Ready to add">
                {found.map((r, i) => (
                  <FoundRow key={r.videoId} r={r} i={i} e={edits[r.videoId]} today={clock.today} offered={offered}
                    errors={{
                      client: f[`client:${r.videoId}`] ?? rowError('clientId', r.videoId),
                      day: f[`day:${r.videoId}`] ?? rowError('publishedOn', r.videoId),
                      title: f[`title:${r.videoId}`] ?? rowError('title', r.videoId),
                    }}
                    onEdit={(patch) => edit(r.videoId, patch)} />
                ))}
              </ul>
            )}
            {f.items && <p className="yi-err" role="alert"><CircleAlert aria-hidden />{f.items}</p>}
            {problems.length > 0 && (
              <section className="yi-bad" aria-label="Can’t be added">
                <h3 className="section-title">Left out · {problems.length}</h3>
                <ul className="yi-bad-list">
                  {problems.map((p) => (
                    <li key={p.key} className="yi-bad-row">
                      <CircleAlert aria-hidden />
                      <span className="yi-bad-t">
                        <b title={p.input}>{p.title ?? p.input}</b>
                        <span>{p.problem}</span>
                      </span>
                      {p.existing && (
                        <a className="btn sm ghost" href={thumbBriefPath(me, p.existing.briefId)} target="_blank" rel="noopener noreferrer">
                          Open it<ExternalLink aria-hidden /><span className="sr-only">: {p.existing.title} (opens in a new tab)</span>
                        </a>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {found.length > 0 && (
              <Field label="Who made these?" htmlFor={ids.designer} error={f.designer} className="yi-who"
                help={designer ? `They go on ${designer.name}’s Wall of wins and portfolio as picks, dated the day each went live. ${designer.name.split(' ')[0]} is told once.` : 'Only thumbnail designers are offered. Every video above goes to the same one.'}>
                <select className="select" value={designerId} onChange={(e) => { setDesignerId(e.target.value ? Number(e.target.value) : ''); setLocal((all) => { const next = { ...all }; delete next.designer; return next; }); }}
                  {...inputProps(ids.designer, f.designer)}>
                  <option value="">Choose a designer</option>
                  {designers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              </Field>
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}

/** While YouTube is read: a placeholder row per video. */
function LookingUp({ n }: { n: number }) {
  return (
    <ul className="yi-rows wait" role="status" aria-label={`Looking up ${plural(n, 'video')} on YouTube…`}>
      {Array.from({ length: Math.max(1, Math.min(n, 4)) }, (_, i) => (
        <li key={i} className="yi-row wait" aria-hidden>
          <span className="yi-pic"><span className="yi-skel" /></span>
          <span className="yi-body"><span className="sl-skel"><i /><i /><i /></span></span>
        </li>
      ))}
    </ul>
  );
}

/** One video that can be added: YouTube's picture and words, the client, the day when YouTube didn't give it, and whether to add it. */
function FoundRow({ r, i, e, today, offered, errors, onEdit }: {
  r: YoutubeLookupFound; i: number; e: RowEdit; today: ISODate; offered: { id: number; name: string; status: string }[];
  errors: { client?: string; day?: string; title?: string }; onEdit: (patch: Partial<RowEdit>) => void;
}) {
  const ids = { c: useFieldId('yi-c'), d: useFieldId('yi-d'), t: useFieldId('yi-t'), inc: useFieldId('yi-inc') };
  const [titling, setTitling] = useState(false);
  const titleBtn = useRef<HTMLButtonElement>(null);
  const given = youtubeDay(r, today);
  const title = e.title ?? r.title;
  const changedTitle = e.title != null && e.title.trim() !== r.title;
  const suggested = r.suggestedClientId != null && e.clientId === String(r.suggestedClientId);
  const off = !e.include;
  const doneTitling = () => { setTitling(false); requestAnimationFrame(() => titleBtn.current?.focus()); };
  return (
    <li className={`yi-row${off ? ' off' : ''}`} style={{ ['--i' as string]: Math.min(i, 10) }}>
      <span className="yi-pic">
        <Thumb src={r.picture} alt={`YouTube’s thumbnail for “${r.title}”`} title={r.title} sub={r.channel ?? 'YouTube'} tone="var(--neutral)" eager={i < 6}>
          {/* ticked to add it, as a picture is picked on a phone */}
          <label className="check yi-inc thumb-tl" htmlFor={ids.inc}>
            <input id={ids.inc} type="checkbox" checked={e.include} onChange={(ev) => onEdit({ include: ev.target.checked })} />
            <span className="yi-inc-t">Add<span className="sr-only"> “{title}”</span></span>
          </label>
        </Thumb>
      </span>
      <div className="yi-body">
        <div className="yi-head">
          {titling ? (
            <span className="yi-title-ed">
              <label className="sr-only" htmlFor={ids.t}>Title on the site</label>
              <input id={ids.t} className="input sm" value={e.title ?? r.title} maxLength={200} autoFocus disabled={off}
                aria-invalid={errors.title ? true : undefined} aria-describedby={errors.title ? `${ids.t}-err` : undefined}
                onChange={(ev) => onEdit({ title: ev.target.value })}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') { ev.preventDefault(); doneTitling(); }
                  // Esc puts YouTube's back (and keeps the dialog open)
                  if (ev.key === 'Escape') { ev.preventDefault(); onEdit({ title: null }); doneTitling(); }
                }} />
              <Button variant="sm" onClick={doneTitling}>Done</Button>
            </span>
          ) : (
            <b id={ids.t} className="yi-t">{title}</b>
          )}
        </div>
        <p className="yi-k">
          <span>{r.channel ?? 'Channel not given'}</span>
          <span aria-hidden>·</span>
          <span>{given ? <>went live <time dateTime={given} title={fmtLong(given)}>{fmtDate(given, today)}</time></> : 'YouTube didn’t give the day'}</span>
        </p>
        {errors.title && <span className="yi-err" role="alert" id={`${ids.t}-err`}><CircleAlert aria-hidden />{errors.title}</span>}
        <p className="yi-acts">
          {!titling && (
            <button ref={titleBtn} type="button" className="linkbtn" disabled={off} onClick={() => setTitling(true)} aria-label={`Change the title of “${title}”`}>
              <Pencil aria-hidden />{changedTitle ? 'Edit title' : 'Change title'}
            </button>
          )}
          {changedTitle && !titling && <button type="button" className="linkbtn" disabled={off} onClick={() => onEdit({ title: null })}>Use YouTube’s</button>}
          <ExtLink href={r.url} className="linkbtn yi-watch">Watch<ExternalLink aria-hidden /><span className="sr-only"> “{r.title}” on YouTube (opens in a new tab)</span></ExtLink>
        </p>
        {changedTitle && <p className="yi-was">On YouTube: “{r.title}”</p>}
        <div className="yi-fields">
          <Field label="Client" htmlFor={ids.c} error={errors.client} help={suggested && !errors.client ? 'Suggested from the channel' : undefined}>
            <select className="select" value={e.clientId} disabled={off} onChange={(ev) => onEdit({ clientId: ev.target.value })} {...inputProps(ids.c, errors.client)}>
              <option value="">Choose a client</option>
              {offered.map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'prospect' ? ' (potential)' : ''}</option>)}
            </select>
          </Field>
          {!given && (
            <Field label="Went live on" htmlFor={ids.d} error={errors.day}>
              <input className="input" type="date" value={e.day} min={YOUTUBE_FIRST_DAY} max={today} disabled={off} onChange={(ev) => onEdit({ day: ev.target.value })} {...inputProps(ids.d, errors.day)} />
            </Field>
          )}
        </div>
      </div>
    </li>
  );
}
