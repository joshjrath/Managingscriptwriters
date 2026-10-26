// References (/studio/refs): a thumbnail designer's private reference boards, one per client and a General one, from
// GET /api/thumbnail-refs (ThumbnailRefBoard in shared/types.ts). Only the designer ever sees them (managers have
// none). Pictures go on by dropping them anywhere on the page, pasting them (⌘V or Ctrl+V) or choosing them (one
// upload each, read on the server like an option: PNG, JPG or WebP), or from the pickers: "Add a winner" (their own
// picks, and the client's winners they may see) and "From client material" (a client's image resources). Each sits
// in a masonry-like grid at its own shape, with a caption edited in place; a tap opens it in a lightbox (← → between
// them). Filtered by board with ?board=general or ?board=<clientId>; new pictures go to the board on screen (or the
// one chosen under All). BriefRefs is the same board, small, in a brief's Brand drawer.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, ArrowRight, Check, ChevronLeft, ChevronRight, ExternalLink, FolderInput, FolderOpen, ImagePlus, Images, Loader2, Pencil, RotateCcw, Trash2,
  Trophy, Upload,
} from 'lucide-react';
import { api, qs, useSave } from '../api';
import type { ClientDetail, Resource, StudioPayload, ThumbnailRef, ThumbnailRefBoard, ThumbnailRefInput, ThumbnailRefPatch, ThumbnailWin } from '../../../shared/types';
import { RESOURCE_LABEL } from '../../../shared/types';
import { GENERAL_BOARD, isPictureMime, REF_CAPTION_MAX, THUMB_MIMES } from '../../../shared/workflow';
import { fmtAgo, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Button, Chip, Dialog, Empty, ErrorState, Field, FormError, inputProps, Loading, Seg, Thumb, useFieldId, useToast } from '../components/ui';
import { optionAlt, pictureType, readPicture, usePageDrop } from '../components/ThumbBits';
import { useNow } from '../components/EditingBits';

/** Which board is on screen: every board, General, or a client's. */
type Board = 'all' | 'general' | number;
/** Where a new picture goes: General (null) or a client's board. */
type Target = number | null;

const ALL_KEY = ['thumbnail-refs', 'all'] as const;
const boardOf = (v: string | null): Board => (v === GENERAL_BOARD ? 'general' : v && /^\d+$/.test(v) ? Number(v) : 'all');
const targetOf = (b: Board, chosen: Target): Target => (b === 'all' ? chosen : b === 'general' ? null : b);
const onBoard = (r: ThumbnailRef, b: Board) => (b === 'all' ? true : b === 'general' ? r.clientId == null : r.clientId === b);

/** What a screen reader hears for a ref: its caption, else what it is. */
export function refAlt(r: ThumbnailRef): string {
  if (r.caption) return r.caption;
  if (r.winner) return optionAlt({ letter: r.winner.letter, uploadedByName: r.winner.madeByName }, r.winner.title);
  if (r.resource) return `${r.resource.title}, ${RESOURCE_LABEL[r.resource.category].toLowerCase()}${r.clientName ? ` from ${r.clientName}` : ''}`;
  return 'A picture you added';
}

/** A client's logo: shown on a checker, so its dark and see-through parts both read. */
const isLogo = (r: ThumbnailRef) => r.resource?.category === 'logo';

/** Where it came from, in a few words. */
function sourceWords(r: ThumbnailRef, now: number): string {
  if (r.winner) return `Picked: “${r.winner.title}” · ${r.winner.madeByName}`;
  if (r.resource) return `${RESOURCE_LABEL[r.resource.category]}: ${r.resource.title}`;
  return `Your upload · ${fmtAgo(r.createdAt, now)}`;
}

export function StudioRefsPage() {
  const q = useQuery({ queryKey: ALL_KEY, queryFn: () => api<ThumbnailRefBoard>('/api/thumbnail-refs') });
  const head = <PageHeader title="References" crumbs={<><Link to="/studio">Studio</Link><span aria-hidden>›</span><span>References</span></>}
    sub="Pictures to work from, for each client and in General. Only you see them." hideNewWork />;
  if (q.isLoading) return <div className="studio refs-page">{head}<Loading height={420} /></div>;
  if (q.isError && !q.data) return <div className="studio refs-page">{head}<ErrorState error={q.error} retry={() => q.refetch()} /></div>;
  return <Boards b={q.data!} />;
}

// ── the boards ───────────────────────────────────────────────────────────

interface Pending { key: string; file: File; src: string | null; status: 'waiting' | 'uploading' | 'error'; error: string | null; target: Target }

function Boards({ b }: { b: ThumbnailRefBoard }) {
  const { clients, uploadLimitMb } = useBoot();
  const toast = useToast();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const board = boardOf(params.get('board'));
  const setBoard = (next: Board) => {
    const p = new URLSearchParams(params);
    if (next === 'all') p.delete('board'); else p.set('board', next === 'general' ? GENERAL_BOARD : String(next));
    setParams(p, { replace: true });
  };
  const [chosen, setChosen] = useState<Target>(null);
  const target = targetOf(board, chosen);
  const live = clients.filter((c) => c.status !== 'archived');
  const nameOf = (t: Target) => (t == null ? 'General' : clients.find((c) => c.id === t)?.name ?? 'that client');
  const [picker, setPicker] = useState<null | 'winner' | 'material'>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [moving, setMoving] = useState<ThumbnailRef | null>(null);

  // the boards to switch between: General, and every client with something on theirs (or the one in the address)
  const counts = new Map<number, { id: number; name: string; n: number }>();
  for (const r of b.refs) if (r.clientId != null) { const c = counts.get(r.clientId) ?? { id: r.clientId, name: r.clientName ?? nameOf(r.clientId), n: 0 }; c.n += 1; counts.set(r.clientId, c); }
  if (typeof board === 'number' && !counts.has(board)) counts.set(board, { id: board, name: nameOf(board), n: 0 });
  const boards = [...counts.values()].sort((x, y) => y.n - x.n || x.name.localeCompare(y.name));
  const general = b.refs.filter((r) => r.clientId == null).length;
  const shown = b.refs.filter((r) => onBoard(r, board));

  // images dropped, pasted or chosen: one upload each, in order, onto the board they were added to
  const [list, setList] = useState<Pending[]>([]);
  // how many went on since the last toast, and the board the last one went to
  const added = useRef<{ n: number; board: string }>({ n: 0, board: '' });
  const upload = useSave((p: Pending) => {
    const form = new FormData();
    form.set('caption', '');
    form.set('clientId', p.target == null ? '' : String(p.target));
    form.set('file', p.file, p.file.name || 'reference.png');
    return api<ThumbnailRef>('/api/thumbnail-refs', { form });
  }, {
    onSuccess: (_out, p) => {
      added.current = { n: added.current.n + 1, board: nameOf(p.target) };
      setList((all) => all.filter((x) => x.key !== p.key));
    },
  });
  // one toast once the line is through (nothing left waiting or being added), never from inside a state update
  useEffect(() => {
    if (!added.current.n || list.some((x) => x.status !== 'error')) return;
    toast(`${plural(added.current.n, 'picture')} added to ${added.current.board}`);
    added.current = { n: 0, board: '' };
  }, [list, toast]);
  const busy = upload.isPending;
  const { mutate } = upload;
  useEffect(() => {
    if (busy) return;
    const next = list.find((x) => x.status === 'waiting');
    if (!next) return;
    const mark = (p: Partial<Pending>) => setList((all) => all.map((x) => (x.key === next.key ? { ...x, ...p } : x)));
    mark({ status: 'uploading', error: null });
    mutate(next, { onError: (err) => mark({ status: 'error', error: err.message }) });
  }, [list, busy, mutate]);

  const room = b.max - b.total - list.length;
  const full = room <= 0 ? `Your boards are full: ${b.max} pictures. Take some off to add more.` : null;
  const add = useCallback((files: File[]) => {
    const ok: File[] = [];
    for (const f of files) {
      if (!pictureType(f)) { toast(`${f.name || 'That file'} isn’t a PNG, JPG or WebP.`, 'error'); continue; }
      if (f.size > uploadLimitMb * 1024 * 1024) { toast(`${f.name} is over the site’s ${uploadLimitMb} MB upload limit.`, 'error'); continue; }
      ok.push(f);
    }
    const take = ok.slice(0, Math.max(0, room));
    if (ok.length > take.length) toast(`Your boards hold ${b.max} pictures${take.length ? `, so ${plural(ok.length - take.length, 'picture')} ${ok.length - take.length === 1 ? 'was' : 'were'} left out` : ''}.`, 'error');
    if (!take.length) return;
    const items: Pending[] = take.map((file) => ({ key: `r${Date.now()}-${Math.random().toString(36).slice(2)}`, file, src: null, status: 'waiting', error: null, target }));
    setList((all) => [...items, ...all]);
    for (const it of items) void readPicture(it.file).then((pic) => setList((all) => all.map((x) => (x.key === it.key ? { ...x, src: pic.src } : x))));
  }, [room, b.max, target, toast, uploadLimitMb]);
  // a picture pasted while a picker, the lightbox or Move is open isn't meant for the board
  const over = usePageDrop((files) => { if (!document.querySelector('dialog[open]')) add(files); });
  const input = useRef<HTMLInputElement>(null);

  const boardLabel = (x: Board) => (x === 'all' ? 'All' : x === 'general' ? 'General' : nameOf(x));
  const lightbox = open != null ? shown.findIndex((r) => r.id === open) : -1;
  return (
    <div className="studio refs-page">
      <PageHeader title="References" crumbs={<><Link to="/studio">Studio</Link><span aria-hidden>›</span><span>References</span></>}
        sub="Pictures to work from, for each client and in General. Only you see them." hideNewWork>
        <span className="refs-count tnum" title={`Your boards hold up to ${b.max} pictures`}>{b.total} of {b.max}</span>
      </PageHeader>

      <div className="refs-boards">
        {boards.length <= 5 ? (
          <Seg role="group" aria-label="Board">
            <button type="button" aria-pressed={board === 'all'} onClick={() => setBoard('all')}>All <span className="refs-n">{b.refs.length}</span></button>
            <button type="button" aria-pressed={board === 'general'} onClick={() => setBoard('general')}>General <span className="refs-n">{general}</span></button>
            {boards.map((c) => <button key={c.id} type="button" aria-pressed={board === c.id} onClick={() => setBoard(c.id)}>{c.name} <span className="refs-n">{c.n}</span></button>)}
          </Seg>
        ) : (
          <select className="select refs-board-pick" value={board === 'all' ? '' : board === 'general' ? GENERAL_BOARD : String(board)} onChange={(e) => setBoard(boardOf(e.target.value || null))} aria-label="Board">
            <option value="">All boards ({b.refs.length})</option>
            <option value={GENERAL_BOARD}>General ({general})</option>
            {boards.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.n})</option>)}
          </select>
        )}
      </div>

      <section className={`dz refs-add${full ? ' off' : ''}`} aria-label="Add pictures">
        <span className="dz-ic" aria-hidden><ImagePlus /></span>
        <div className="dz-txt">
          <b>{full ?? `Add to ${nameOf(target)}`}</b>
          <span className="dz-fine">Drop images anywhere on this page, or paste them straight from a screenshot (⌘V or Ctrl+V).</span>
          <span className="dz-coarse">Choose PNG, JPG or WebP pictures from your phone.</span>
        </div>
        {board === 'all' && (
          <label className="refs-to">
            <span>Add to</span>
            <select className="select sm" value={chosen ?? ''} onChange={(e) => setChosen(e.target.value ? Number(e.target.value) : null)}>
              <option value="">General</option>
              {live.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        )}
        <div className="refs-add-acts">
          <Button variant="primary pill" icon={<Upload aria-hidden />} disabled={!!full} onClick={() => input.current?.click()}>Choose images</Button>
          <Button variant="pill" icon={<Trophy aria-hidden />} disabled={!!full} onClick={() => setPicker('winner')}>Add a winner</Button>
          <Button variant="pill" icon={<FolderOpen aria-hidden />} disabled={!!full} onClick={() => setPicker('material')}>From client material</Button>
        </div>
        <input ref={input} className="sr-only" type="file" tabIndex={-1} aria-hidden accept={THUMB_MIMES.join(',')} multiple
          onChange={(e) => { const files = Array.from(e.target.files ?? []); e.target.value = ''; if (files.length) add(files); }} />
        {over && (
          <div className="dz-over" aria-hidden>
            <div className="dz-over-card"><ImagePlus /><b>{full ?? `Drop to add to ${nameOf(target)}`}</b></div>
          </div>
        )}
      </section>

      {!shown.length && !list.length ? (
        <Empty boxed icon={<Images />} title={board === 'all' ? 'Your boards are empty' : `Nothing on ${boardLabel(board)}${board === 'general' ? '' : '’s board'} yet`}>
          Screenshots you like, past winners and the client’s own pictures: whatever you want to work from. Only you see them.
        </Empty>
      ) : (
        <ul className="refs" aria-label={`${boardLabel(board)}: ${plural(shown.length, 'picture')}`}>
          {list.map((p) => (
            <li key={p.key} className={`ref pending ${p.status}`}>
              <span className="ref-pic ok">
                {p.src ? <img src={p.src} alt={`${p.file.name || 'Pasted image'}, being added`} draggable={false} /> : <span className="ref-blank" aria-hidden><ImagePlus /></span>}
                {p.status !== 'error' && <span className="opt-progress" role="status"><Loader2 className="spin" aria-hidden />{p.status === 'uploading' ? 'Adding…' : 'Next in line…'}</span>}
              </span>
              <div className="ref-cap">
                {p.status === 'error' ? (
                  <>
                    <p className="opt-err" role="alert"><AlertTriangle aria-hidden />{p.error}</p>
                    <span className="ref-acts">
                      <Button variant="sm" icon={<RotateCcw aria-hidden />} onClick={() => setList((all) => all.map((x) => (x.key === p.key ? { ...x, status: 'waiting', error: null } : x)))}>Try again</Button>
                      <Button variant="sm ghost" onClick={() => setList((all) => all.filter((x) => x.key !== p.key))} aria-label={`Discard ${p.file.name || 'the pasted image'}`}>Discard</Button>
                    </span>
                  </>
                ) : <span className="ref-src">{p.file.name || 'Pasted image'} · to {nameOf(p.target)}</span>}
              </div>
            </li>
          ))}
          {shown.map((r, i) => (
            <RefTile key={r.id} r={r} now={now} eager={i < 8} showBoard={board === 'all'} onOpen={() => setOpen(r.id)} onMove={() => setMoving(r)} />
          ))}
        </ul>
      )}

      {lightbox >= 0 && (
        <Lightbox list={shown} at={lightbox} onAt={(i) => setOpen(shown[i]?.id ?? null)} onClose={() => setOpen(null)} now={now}
          onMove={(r) => { setOpen(null); setMoving(r); }} />
      )}
      {moving && <MoveDialog r={moving} onClose={() => setMoving(null)} />}
      {picker === 'winner' && <WinnerPicker target={target} targetName={nameOf(target)} refs={b.refs} room={room} onClose={() => setPicker(null)} />}
      {picker === 'material' && <MaterialPicker target={target} targetName={nameOf(target)} refs={b.refs} room={room} onClose={() => setPicker(null)} />}
    </div>
  );
}

// ── one picture ──────────────────────────────────────────────────────────

/** A ref's picture at its own shape: a winner's size is known up front; an upload's or a resource's takes its shape as it loads. */
function RefPicture({ r, eager }: { r: ThumbnailRef; eager?: boolean }) {
  const [state, setState] = useState<{ url: string; status: 'loading' | 'ok' | 'failed' }>({ url: r.url, status: 'loading' });
  if (state.url !== r.url) setState({ url: r.url, status: 'loading' });
  // a picture already in the browser's cache can finish before React listens for it
  const seen = useCallback((img: HTMLImageElement | null) => {
    if (img?.complete && img.naturalWidth > 0) setState((s) => (s.status === 'ok' ? s : { ...s, status: 'ok' }));
  }, []);
  const ratio = r.width && r.height ? `${r.width} / ${r.height}` : undefined;
  return (
    <span className={`ref-pic ${state.status}${ratio ? ' sized' : ''}${isLogo(r) ? ' checker' : ''}`} style={ratio ? { aspectRatio: ratio } : undefined}>
      {state.status === 'loading' && <span className="thumb-skel" aria-hidden />}
      {state.status === 'failed'
        ? <span className="ref-blank" role="img" aria-label={`${refAlt(r)}: can’t be shown`}><AlertTriangle aria-hidden />Can’t show this picture</span>
        : <img ref={seen} src={r.url} alt={refAlt(r)} loading={eager ? 'eager' : 'lazy'} decoding="async" draggable={false}
          onLoad={() => setState((s) => ({ ...s, status: 'ok' }))} onError={() => setState((s) => ({ ...s, status: 'failed' }))} />}
    </span>
  );
}

function RefTile({ r, now, eager, showBoard, onOpen, onMove }: { r: ThumbnailRef; now: number; eager?: boolean; showBoard: boolean; onOpen: () => void; onMove: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const bin = useRef<HTMLButtonElement>(null);
  const sure = useRef<HTMLButtonElement>(null);
  // the keyboard follows the swap: onto "Take off?" when it shows, and back to the bin if it times out while there
  useEffect(() => {
    if (!confirm) return;
    sure.current?.focus();
    const t = setTimeout(() => {
      const there = document.activeElement === sure.current;
      setConfirm(false);
      if (there) requestAnimationFrame(() => bin.current?.focus());
    }, 4000);
    return () => clearTimeout(t);
  }, [confirm]);
  const remove = useSave(() => api<{ ok: true }>(`/api/thumbnail-refs/${r.id}`, { method: 'DELETE' }), { onSuccess: () => toast('Taken off your board') });
  return (
    <li className={`ref ${r.source}`} data-ref={r.id}>
      <button type="button" className="ref-open" onClick={onOpen} aria-label={`Open larger: ${refAlt(r)}`}>
        <RefPicture r={r} eager={eager} />
        {r.source === 'winner' && <span className="thumb-tl"><Chip color="mint" icon={<Trophy aria-hidden />}>Picked</Chip></span>}
      </button>
      <div className="ref-cap">
        <Caption r={r} />
        <span className="ref-src">{sourceWords(r, now)}</span>
        <span className="ref-foot">
          {showBoard && <span className="ref-board">{r.clientName ?? 'General'}</span>}
          <span className="ref-acts">
            <button type="button" className="icon-btn sm" onClick={onMove} aria-label={`Move ${refAlt(r)} to another board`} title="Move to another board"><FolderInput size={15} /></button>
            {confirm
              ? <Button ref={sure} variant="sm danger" icon={<Trash2 aria-hidden />} busy={remove.isPending} onClick={() => remove.mutate(undefined, { onError: (e) => toast(e.message, 'error') })}>Take off?</Button>
              : <button ref={bin} type="button" className="icon-btn sm" onClick={() => setConfirm(true)} aria-label={`Take ${refAlt(r)} off your board`} title="Take off your board"><Trash2 size={15} /></button>}
          </span>
        </span>
      </div>
    </li>
  );
}

/** The caption, edited where it is: Enter or leaving the box saves, Esc puts it back. */
function Caption({ r }: { r: ThumbnailRef }) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(r.caption ?? '');
  const box = useRef<HTMLInputElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (editing) box.current?.focus(); }, [editing]);
  /** Focus the keyboard had in the box (and lost when it closed or went busy) goes to `to`; focus that moved on elsewhere stays there. */
  const refocus = (to: { current: HTMLElement | null }) => requestAnimationFrame(() => {
    const at = document.activeElement;
    if (!at || at === document.body) to.current?.focus();
  });
  const stop = () => { setEditing(false); refocus(btn); };
  const save = useSave((caption: string | null) => api<ThumbnailRef>(`/api/thumbnail-refs/${r.id}`, { method: 'PATCH', body: { caption } satisfies ThumbnailRefPatch }), {
    onSuccess: (_o, caption) => { stop(); toast(caption ? 'Caption saved' : 'Caption taken off'); },
  });
  const done = () => {
    if (save.isPending) return;
    const next = text.trim() || null;
    if (next === (r.caption ?? null)) { stop(); return; }
    save.mutate(next, { onError: (e) => { toast(e.message, 'error'); refocus(box); } });
  };
  if (!editing) {
    return (
      <button ref={btn} type="button" className={`ref-caption${r.caption ? '' : ' blank'}`} onClick={() => { setText(r.caption ?? ''); setEditing(true); }}
        aria-label={r.caption ? `Caption: ${r.caption}. Edit it` : 'Add a caption'}>
        {r.caption ?? <><Pencil aria-hidden />Add a caption</>}
      </button>
    );
  }
  return (
    <input ref={box} className="input sm ref-caption-in" value={text} maxLength={REF_CAPTION_MAX} placeholder="What to take from it" aria-label="Caption" disabled={save.isPending}
      onChange={(e) => setText(e.target.value)} onBlur={done}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); done(); }
        if (e.key === 'Escape') { e.preventDefault(); setText(r.caption ?? ''); stop(); }
      }} />
  );
}

// ── the lightbox ─────────────────────────────────────────────────────────

/** Focus is somewhere keys mean text: an input, a textarea, a select, anything editable. */
const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || !!t.closest('input, textarea, select'));

/** One picture large, with ← → (and the arrow keys) between the board's pictures. */
function Lightbox({ list, at, onAt, onClose, onMove, now }: {
  list: ThumbnailRef[]; at: number; onAt: (i: number) => void; onClose: () => void; onMove?: (r: ThumbnailRef) => void; now: number;
}) {
  const n = list.length;
  const r = list[Math.min(at, n - 1)];
  const step = useRef((by: number) => onAt((at + by + n) % n));
  useEffect(() => { step.current = (by: number) => onAt((at + by + n) % n); });
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || typing(e.target)) return;
      if (e.key === 'ArrowLeft') { e.preventDefault(); step.current(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); step.current(1); }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  if (!r) return null;
  return (
    <Dialog open onClose={onClose} size="wide" title={r.caption ?? (r.winner ? r.winner.title : r.resource ? r.resource.title : 'Your upload')}
      sub={`${r.clientName ?? 'General'} · ${sourceWords(r, now)}`}
      footer={(
        <div className="ref-lb-bar">
          {n > 1 && (
            <span className="ref-lb-flick">
              <button type="button" className="icon-btn" onClick={() => step.current(-1)} aria-label="Previous picture"><ChevronLeft /></button>
              <span className="tnum" aria-live="polite">{at + 1} of {n}</span>
              <button type="button" className="icon-btn" onClick={() => step.current(1)} aria-label="Next picture"><ChevronRight /></button>
            </span>
          )}
          <span className="ref-lb-acts">
            <a className="btn sm ghost" href={r.url} target="_blank" rel="noopener noreferrer">Full size<ExternalLink aria-hidden /></a>
            {onMove && <Button variant="sm ghost" icon={<FolderInput aria-hidden />} onClick={() => onMove(r)}>Move</Button>}
          </span>
        </div>
      )}>
      <figure className="ref-lb">
        <div className={`ref-lb-frame${isLogo(r) ? ' checker' : ''}`}><img key={r.id} src={r.url} alt={refAlt(r)} draggable={false} /></div>
        {n > 1 && <figcaption className="dim ref-lb-hint">← and → move between pictures</figcaption>}
      </figure>
    </Dialog>
  );
}

// ── moving one, and the pickers ──────────────────────────────────────────

function MoveDialog({ r, onClose }: { r: ThumbnailRef; onClose: () => void }) {
  const { clients } = useBoot();
  const toast = useToast();
  const [to, setTo] = useState<string>(r.clientId == null ? '' : String(r.clientId));
  const fid = useFieldId('ref-move');
  const live = clients.filter((c) => c.status !== 'archived' || c.id === r.clientId);
  const next: Target = to ? Number(to) : null;
  const save = useSave((clientId: Target) => api<ThumbnailRef>(`/api/thumbnail-refs/${r.id}`, { method: 'PATCH', body: { clientId } satisfies ThumbnailRefPatch }), {
    onSuccess: (out) => { toast(`Moved to ${out.clientName ?? 'General'}`); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} size="narrow" title="Move to another board" sub={refAlt(r)}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} disabled={next === (r.clientId ?? null)} onClick={() => save.mutate(next)}>Move</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); if (next !== (r.clientId ?? null)) save.mutate(next); }}>
        <FormError error={save.error} />
        <Field label="Board" htmlFor={fid}>
          <select className="select" value={to} onChange={(e) => setTo(e.target.value)} {...inputProps(fid)}>
            <option value="">General</option>
            {live.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
      </form>
    </Dialog>
  );
}

/** Adds a picture already on the site (a winner or a client's image resource) to the board. */
function useAddRef(targetName: string) {
  const toast = useToast();
  return useSave((input: ThumbnailRefInput) => api<ThumbnailRef>('/api/thumbnail-refs', { body: { ...input } }), {
    onSuccess: () => toast(`Added to ${targetName}`),
  });
}

/** Their own picks (every client), or a client's winners they may see: picked options of briefs for a client they have or had a brief for. */
function WinnerPicker({ target, targetName, refs, room, onClose }: { target: Target; targetName: string; refs: ThumbnailRef[]; room: number; onClose: () => void }) {
  const { clients } = useBoot();
  const toast = useToast();
  const [from, setFrom] = useState<'mine' | number>(target ?? 'mine');
  const fid = useFieldId('ref-win');
  const studio = useQuery({ queryKey: ['studio', 'me'], queryFn: () => api<StudioPayload>('/api/studio') });
  const client = useQuery({ queryKey: ['client', from], queryFn: () => api<ClientDetail>(`/api/clients/${from}`), enabled: from !== 'mine' });
  const add = useAddRef(targetName);
  const mine = studio.data?.wins ?? [];
  // their own picks for that client and the client's winners overlap: each option once, newest pick first
  const byOption = new Map<number, ThumbnailWin>();
  for (const w of from === 'mine' ? mine : [...mine.filter((x) => x.clientId === from), ...(client.data?.recentWinners ?? [])]) if (!byOption.has(w.option.id)) byOption.set(w.option.id, w);
  const list = [...byOption.values()].sort((x, y) => y.pickedAt.localeCompare(x.pickedAt));
  const here = new Set(refs.filter((r) => r.winner && (r.clientId ?? null) === target).map((r) => r.winner!.optionId));
  const loading = from === 'mine' ? studio.isLoading : client.isLoading || studio.isLoading;
  const error = from === 'mine' ? studio.error : client.error;
  return (
    <Dialog open onClose={onClose} size="wide" title="Add a winner" sub={`To ${targetName}. Picked thumbnails: yours, and other designers’ for clients you’ve had a brief for.`}
      footer={<div className="form-actions"><Button variant="primary pill" onClick={onClose}>Done</Button></div>}>
      <div className="form">
        <Field label="Whose winners" htmlFor={fid}>
          <select className="select" value={from} onChange={(e) => setFrom(e.target.value === 'mine' ? 'mine' : Number(e.target.value))} {...inputProps(fid)}>
            <option value="mine">Your picks, every client</option>
            {clients.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {loading ? <Loading height={180} /> : error && !list.length ? <ErrorState error={error} /> : !list.length ? (
          <Empty boxed icon={<Trophy />} title={from === 'mine' ? 'Nothing of yours picked yet' : 'No winners here you can see'}>
            {from === 'mine' ? 'Every option of yours a manager picks shows up here.' : 'You see a client’s winners once you’ve had a brief for them.'}
          </Empty>
        ) : (
          <ul className="refs-pick">
            {list.map((w) => {
              const on = here.has(w.option.id);
              const adding = add.isPending && add.variables?.optionId === w.option.id;
              return (
                <li key={w.option.id}>
                  <button type="button" className={`refs-pick-b${on ? ' on' : ''}`} disabled={on || adding || room <= 0}
                    onClick={() => add.mutate({ optionId: w.option.id, clientId: target }, { onError: (e) => toast(e.message, 'error') })}
                    aria-label={on ? `${w.title}: already on ${targetName}` : `Add ${optionAlt(w.option, w.title)} to ${targetName}`}>
                    <Thumb src={w.option.url} alt="" title={w.title} sub={w.clientName}>
                      <span className="thumb-letter" aria-hidden>{w.option.letter}</span>
                      {(on || adding) && <span className="thumb-tr"><Chip color={on ? 'mint' : 'plain'} icon={on ? <Check aria-hidden /> : <Loader2 className="spin" aria-hidden />}>{on ? 'On the board' : 'Adding…'}</Chip></span>}
                    </Thumb>
                    <span className="win-cap"><b>{w.title}</b><span>{w.clientName} · {w.option.uploadedByName}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** A client's image resources (logos and references first). */
function MaterialPicker({ target, targetName, refs, room, onClose }: { target: Target; targetName: string; refs: ThumbnailRef[]; room: number; onClose: () => void }) {
  const { clients } = useBoot();
  const toast = useToast();
  const live = clients.filter((c) => c.status !== 'archived');
  const [cid, setCid] = useState<number | null>(target ?? live[0]?.id ?? null);
  const fid = useFieldId('ref-mat');
  const client = useQuery({ queryKey: ['client', cid], queryFn: () => api<ClientDetail>(`/api/clients/${cid}`), enabled: cid != null });
  const add = useAddRef(targetName);
  const rank = (r: Resource) => (r.category === 'logo' ? 0 : r.category === 'reference' ? 1 : 2);
  const pics = (client.data?.resources ?? []).filter((r) => r.kind === 'file' && r.fileId != null && isPictureMime(r.fileMime)).sort((x, y) => rank(x) - rank(y));
  const here = new Set(refs.filter((r) => r.resource && (r.clientId ?? null) === target).map((r) => r.resource!.id));
  return (
    <Dialog open onClose={onClose} size="wide" title="From client material" sub={`To ${targetName}. A client’s logos, references and other pictures.`}
      footer={<div className="form-actions"><Button variant="primary pill" onClick={onClose}>Done</Button></div>}>
      <div className="form">
        <Field label="Client" htmlFor={fid}>
          <select className="select" value={cid ?? ''} onChange={(e) => setCid(e.target.value ? Number(e.target.value) : null)} {...inputProps(fid)}>
            {!live.length && <option value="">No clients</option>}
            {live.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        {cid == null ? null : client.isLoading ? <Loading height={180} /> : client.isError ? <ErrorState error={client.error} retry={() => client.refetch()} /> : !pics.length ? (
          <Empty boxed icon={<FolderOpen />} title={`No pictures in ${client.data?.name ?? 'this client'}’s material`}>Managers add logos and references on the client’s page.</Empty>
        ) : (
          <ul className="refs-pick">
            {pics.map((r) => {
              const on = here.has(r.id);
              const adding = add.isPending && add.variables?.resourceId === r.id;
              return (
                <li key={r.id}>
                  <button type="button" className={`refs-pick-b${on ? ' on' : ''}`} disabled={on || adding || room <= 0}
                    onClick={() => add.mutate({ resourceId: r.id, clientId: target }, { onError: (e) => toast(e.message, 'error') })}
                    aria-label={on ? `${r.title}: already on ${targetName}` : `Add ${r.title} (${RESOURCE_LABEL[r.category]}) to ${targetName}`}>
                    <Thumb src={`/api/files/${r.fileId}`} alt="" fit="contain" className={r.category === 'logo' ? 'checker' : undefined}>
                      {(on || adding) && <span className="thumb-tr"><Chip color={on ? 'mint' : 'plain'} icon={on ? <Check aria-hidden /> : <Loader2 className="spin" aria-hidden />}>{on ? 'On the board' : 'Adding…'}</Chip></span>}
                    </Thumb>
                    <span className="win-cap"><b>{r.title}</b><span>{RESOURCE_LABEL[r.category]}</span></span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

// ── in a brief's Brand drawer ────────────────────────────────────────────

/** The designer's board for one client, small: a tap opens the lightbox; the whole board is a link away. */
export function BriefRefs({ clientId, clientName }: { clientId: number; clientName: string }) {
  const now = useNow();
  const q = useQuery({ queryKey: ['thumbnail-refs', clientId], queryFn: () => api<ThumbnailRefBoard>(`/api/thumbnail-refs${qs({ clientId })}`) });
  const [open, setOpen] = useState<number | null>(null);
  const refs = q.data?.refs ?? [];
  const shown = refs.slice(0, 12);
  const at = open != null ? shown.findIndex((r) => r.id === open) : -1;
  return (
    <section className="bk-sec refs-mini" aria-label={`Your references for ${clientName}`}>
      <div className="bk-sec-h">
        <div className="section-title">Your references</div>
        <Link className="btn sm ghost" to={`/studio/refs?board=${clientId}`}>{refs.length ? 'Whole board' : 'Add some'}<ArrowRight aria-hidden /></Link>
      </div>
      {q.isLoading ? <Loading height={90} label="Loading your references…" /> : q.isError ? <ErrorState error={q.error} retry={() => q.refetch()} /> : !refs.length ? (
        <p className="dim bk-none">Nothing on your {clientName} board yet. Only you see it.</p>
      ) : (
        <>
          <ul className="refs mini">
            {shown.map((r) => (
              <li key={r.id} className={`ref ${r.source}`}>
                <button type="button" className="ref-open" onClick={() => setOpen(r.id)} aria-label={`Open larger: ${refAlt(r)}`}><RefPicture r={r} /></button>
                {r.caption && <span className="ref-src">{r.caption}</span>}
              </li>
            ))}
          </ul>
          {refs.length > shown.length && <p className="dim bk-none">and {plural(refs.length - shown.length, 'more picture')} on the board</p>}
        </>
      )}
      {at >= 0 && <Lightbox list={shown} at={at} onAt={(i) => setOpen(shown[i]?.id ?? null)} onClose={() => setOpen(null)} now={now} />}
    </section>
  );
}
