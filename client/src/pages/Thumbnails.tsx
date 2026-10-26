// Thumbnails (/thumbnails, managers): handing out briefs and reviewing rounds, built from GET /api/thumbnails
// (ThumbnailBoard in shared/types.ts). On top, four cards counted from rows (to review, changes asked, with
// designers, picked this week); then the rounds waiting on you, each a strip of its options; then the board by
// designer (their open load and due this week, with a link to their Studio), a "Needs a designer" group for briefs
// whose designer has left, and what was picked or cancelled lately. Filters by client and designer.
// New thumbnail (BriefDialog) asks for the client, the shoot if there is one, the video's title (typed), what it
// should show, words for the image, how many options, a due date and a thumbnail designer; editing sends only the
// fields that changed, compared with a snapshot taken when the dialog opened (as Edit batch does). Once a client and
// a title are in, "Suggest ideas" (only when the server has the AI: boot.briefIdeas) asks Claude for three directions
// (POST /api/thumbnails/suggest; nothing is saved), and "Use this" fills what it should show and the words on the
// image, which the manager can still change (and which then count as changed for Edit). Edit, Reassign and Cancel
// are on each brief, and on its review page.

import { useId, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowRight, Ban, Check, ClipboardCheck, Image as ImageIcon, Inbox, Lightbulb, Palette, Pencil, Plus, RotateCcw, Sparkles, Trophy, Undo2, UserPlus, Users } from 'lucide-react';
import { api, qs, useSave, type ApiError } from '../api';
import type {
  ClientDetail, ThumbnailBoard, ThumbnailBrief, ThumbnailBriefDetail, ThumbnailBriefInput, ThumbnailBriefPatch, ThumbnailDesignerLoad, ThumbnailSuggestInput, ThumbnailSuggestions,
} from '../../../shared/types';
import { briefOrder, DEFAULT_OPTIONS, isOpenThumb, isThumbnailDesigner, MAX_OPTIONS, THUMB_IDEA_COUNT, type ThumbIdea } from '../../../shared/workflow';
import { addDays, type ISODate } from '../../../shared/dates';
import { fmtAgo, fmtRange, plural } from '../../../shared/format';
import { PageHeader, useBoot } from '../components/Shell';
import { Avatar, Button, Dialog, Empty, ErrorState, Field, FormError, inputProps, Loading, Panel, Seg, Thumb, useFieldId, useToast } from '../components/ui';
import { KpiCard } from '../components/StatCards';
import { BriefTile, DueTag, optionAlt } from '../components/ThumbBits';
import { useNow } from '../components/EditingBits';

const boardPath = (clientId: string, designerId: string) => `/api/thumbnails${qs({ clientId, designerId })}`;

export function ThumbnailsPage() {
  const { clock } = useBoot();
  const now = useNow();
  const [params, setParams] = useSearchParams();
  const clientId = params.get('clientId') ?? '';
  const designerId = params.get('designerId') ?? '';
  const q = useQuery({ queryKey: ['thumbnails', clientId, designerId], queryFn: () => api<ThumbnailBoard>(boardPath(clientId, designerId)), refetchInterval: 60_000 });
  const [dialog, setDialog] = useState<null | { brief: ThumbnailBrief | null; focus?: 'designer' }>(null);
  const [cancelling, setCancelling] = useState<ThumbnailBrief | null>(null);
  const reopen = useReopenBrief();
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p, { replace: true }); };
  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ block: 'start' });

  const b = q.data;
  const open = (b?.briefs ?? []).filter((x) => isOpenThumb(x.state));
  const needs = open.filter((x) => x.needsDesigner).sort(briefOrder);
  const groups = (b?.designers ?? [])
    .filter((dz) => !designerId || String(dz.id) === designerId)
    .map((dz) => ({ dz, briefs: open.filter((x) => !x.needsDesigner && x.designerId === dz.id).sort(briefOrder) }));
  // newest first by when each was picked or cancelled (a pick doesn't touch updatedAt)
  const closedAt = (x: ThumbnailBrief) => x.cancelledAt ?? x.decision?.createdAt ?? x.updatedAt;
  const lately = (b?.briefs ?? []).filter((x) => !isOpenThumb(x.state)).sort((x, y) => closedAt(y).localeCompare(closedAt(x)));
  const actions = (x: ThumbnailBrief) => (
    <div className="bt-acts">
      <Button variant="sm ghost" icon={<Pencil aria-hidden />} onClick={() => setDialog({ brief: x })} aria-label={`Edit ${x.title}`}>Edit</Button>
      {isOpenThumb(x.state) && (
        <Button variant="sm ghost" icon={<UserPlus aria-hidden />} onClick={() => setDialog({ brief: x, focus: 'designer' })} aria-label={`${x.needsDesigner ? 'Choose a designer for' : 'Reassign'} ${x.title}`}>
          {x.needsDesigner ? 'Assign' : 'Reassign'}
        </Button>
      )}
      {isOpenThumb(x.state)
        ? <Button variant="sm ghost" icon={<Ban aria-hidden />} onClick={() => setCancelling(x)} aria-label={`Cancel ${x.title}`}>Cancel</Button>
        : x.state === 'cancelled' && <Button variant="sm ghost" icon={<Undo2 aria-hidden />} busy={reopen.isPending && reopen.variables === x.id} onClick={() => reopen.mutate(x.id)} aria-label={`Reopen ${x.title}`}>Reopen</Button>}
    </div>
  );
  const tile = (x: ThumbnailBrief, i: number, designer = false) => <BriefTile key={x.id} brief={x} to={`/thumbnails/${x.id}`} today={clock.today} eager={i < 4} designer={designer} foot={actions(x)} />;

  return (
    <div className="studio tn">
      <PageHeader title="Thumbnails" sub="Hand out thumbnail briefs, review the rounds designers send, and download the winners." hideNewWork>
        <Button variant="primary pill lg" icon={<Plus aria-hidden />} onClick={() => setDialog({ brief: null })}>New thumbnail</Button>
      </PageHeader>
      {q.isLoading && <Loading height={420} />}
      {q.isError && !b && <ErrorState error={q.error} retry={() => q.refetch()} />}
      {b && (
        <>
          <Cards b={b} now={now} onReview={() => jump('tn-review')} />
          <div className="filters tn-filters" role="search">
            <ClientSelect value={clientId} onChange={(v) => set('clientId', v)} />
            <select className="select" value={designerId} onChange={(e) => set('designerId', e.target.value)} aria-label="Designer">
              <option value="">All designers</option>
              {b.designers.map((dz) => <option key={dz.id} value={dz.id}>{dz.name}</option>)}
            </select>
            {(clientId || designerId) && <Button variant="sm ghost" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear filters</Button>}
          </div>

          <Panel id="tn-review" title="To review" count={b.toReview.length} sub="rounds waiting on you, oldest first" className="tn-review">
            {!b.toReview.length
              ? <Empty boxed icon={<Inbox />} title="Nothing waiting on you">A round shows up here the moment a designer sends it. Their drafts stay private until then.</Empty>
              : (
                <div className="tn-rv-list">
                  {b.toReview.map(({ brief, round }) => (
                    <article key={round.id} className="tn-rv">
                      <Link to={`/thumbnails/${brief.id}`} className={`tn-rv-opts n${Math.min(4, round.options.length)}`} aria-label={`Review round ${round.number} of ${brief.title}: ${plural(round.options.length, 'option')}`}>
                        {round.options.slice(0, 6).map((o) => <span key={o.id} className="tn-rv-opt"><Thumb src={o.url} alt={optionAlt(o, brief.title)}><span className="thumb-letter" aria-hidden>{o.letter}</span></Thumb></span>)}
                      </Link>
                      <div className="tn-rv-body">
                        <div className="tn-rv-k">{brief.clientName} · round {round.number} from {round.createdByName}</div>
                        <b className="tn-rv-t">{brief.title}</b>
                        <div className="tn-rv-meta">
                          <span>{plural(round.options.length, 'option')} · sent {round.sentAt ? fmtAgo(round.sentAt, now) : ''}</span>
                          <DueTag dueOn={brief.dueOn} today={clock.today} state={brief.state} />
                        </div>
                        {round.note && <p className="tn-rv-note">“{round.note}”</p>}
                        <Link className="btn review pill" to={`/thumbnails/${brief.id}`}>Review round {round.number}<ArrowRight aria-hidden /></Link>
                      </div>
                    </article>
                  ))}
                </div>
              )}
          </Panel>

          {!b.designers.length && !open.length && (
            <Panel className="tn-first">
              <Empty icon={<Palette />} title="No thumbnail designers yet">
                In Settings → Team, set an Editor’s Kind to Thumbnail designer. You can already write briefs: they wait under Needs a designer.
              </Empty>
            </Panel>
          )}

          {needs.length > 0 && (
            <Panel title="Needs a designer" count={needs.length} sub="no designer, or theirs has left" className="tn-group needs">
              <div className="st-grid">{needs.map((x, i) => tile(x, i, true))}</div>
            </Panel>
          )}

          {groups.map(({ dz, briefs }) => (
            <section key={dz.id} className="panel tn-group" aria-labelledby={`tn-d-${dz.id}`}>
              <div className="tn-group-head">
                <Avatar name={dz.name} id={dz.id} />
                <div className="tn-group-who">
                  <h2 id={`tn-d-${dz.id}`}>{dz.name}</h2>
                  <span className="muted">{plural(dz.open, 'open brief')} · {dz.dueThisWeek} due this week · {dz.inReview} in review</span>
                </div>
                <Link className="btn sm ghost" to={`/studio?userId=${dz.id}`}>Open their Studio<ArrowRight aria-hidden /></Link>
              </div>
              {briefs.length
                ? <div className="st-grid">{briefs.map((x, i) => tile(x, i))}</div>
                : <p className="muted tn-none">Nothing on their board{clientId ? ' for this client' : ''}.</p>}
            </section>
          ))}

          {lately.length > 0 && (
            <Panel title="Picked or cancelled lately" count={lately.length} sub="the last 14 days" className="tn-group lately">
              <div className="st-grid sm">{lately.map((x, i) => tile(x, i, true))}</div>
            </Panel>
          )}
        </>
      )}
      {dialog && <BriefDialog brief={dialog.brief} focus={dialog.focus} designers={b?.designers} onClose={() => setDialog(null)} />}
      {cancelling && <CancelBriefDialog brief={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}

/** The four cards, each counted from rows on the server. */
function Cards({ b, now, onReview }: { b: ThumbnailBoard; now: number; onReview: () => void }) {
  const c = b.counts;
  const oldest = b.toReview[0]?.round.sentAt ?? null;
  const changes = b.briefs.filter((x) => x.state === 'changes');
  const dueWeek = b.designers.reduce((n, dz) => n + dz.dueThisWeek, 0);
  const picked = b.briefs.filter((x) => x.state === 'picked').sort((x, y) => (y.decision?.createdAt ?? '').localeCompare(x.decision?.createdAt ?? ''));
  return (
    <div className="kpis tn-kpis">
      <KpiCard tone="review" icon={<ClipboardCheck />} n={c.toReview} cap={c.toReview === 1 ? 'Round to review' : 'Rounds to review'}
        sub={oldest ? `oldest sent ${fmtAgo(oldest, now)}` : 'Nothing waiting on you'}
        pill={c.toReview ? undefined : <span className="kpi-pill">Queue clear</span>}
        label={`${plural(c.toReview, 'round')} to review. Show them.`} onClick={onReview}
        foot={<span className="kpi-list">{b.toReview.slice(0, 2).map(({ brief, round }) => <span key={round.id} className="kpi-row"><b className="ellipsis">{brief.title}</b><span>R{round.number}</span></span>)}{!b.toReview.length && <span className="kpi-row"><span>Designers send rounds when they’re ready</span></span>}</span>} />
      <KpiCard tone="revs" icon={<RotateCcw />} n={c.changes} cap="Changes asked" sub={c.changes ? 'designers are on the next round' : 'none open'}
        label={`${plural(c.changes, 'brief')} with changes asked.`}
        foot={<span className="kpi-row"><span>Next round from</span><b className="ellipsis">{changes[0]?.designerName ?? 'nobody yet'}</b></span>} />
      <KpiCard tone="live" icon={<Users />} n={c.withDesigners} cap="With designers" sub={`${plural(b.designers.length, 'thumbnail designer')}${c.needsDesigner ? ` · ${c.needsDesigner} ${c.needsDesigner === 1 ? 'needs' : 'need'} one` : ''}`}
        label={`${plural(c.withDesigners, 'brief')} with designers.`}
        foot={<span className="kpi-row"><span>Due this week</span><b>{dueWeek}</b></span>} />
      <KpiCard tone="done" icon={<Trophy />} n={c.pickedThisWeek} cap="Picked this week" sub="ready to download and post"
        label={`${plural(c.pickedThisWeek, 'thumbnail')} picked this week.`}
        foot={<span className="kpi-row"><span>Latest</span><b className="ellipsis">{picked[0]?.title ?? 'none yet'}</b></span>} />
    </div>
  );
}

function ClientSelect({ value, onChange, id, invalid, disabled, autoFocus }: { value: string; onChange: (v: string) => void; id?: string; invalid?: string; disabled?: boolean; autoFocus?: boolean }) {
  const { clients } = useBoot();
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} data-autofocus={autoFocus ? true : undefined}
      {...(id ? inputProps(id, invalid) : { 'aria-label': 'Client' })}>
      <option value="">{id ? 'Choose a client' : 'All clients'}</option>
      {clients.filter((c) => c.status !== 'archived').map((c) => <option key={c.id} value={c.id}>{c.name}{c.status === 'prospect' ? ' (potential)' : ''}</option>)}
    </select>
  );
}

// ── New thumbnail / Edit ─────────────────────────────────────────────────

/** Reopens a cancelled brief. */
export function useReopenBrief() {
  const toast = useToast();
  return useSave((id: number) => api<ThumbnailBriefDetail>(`/api/thumbnails/${id}`, { method: 'PATCH', body: { cancelled: false } satisfies ThumbnailBriefPatch }), {
    onSuccess: (out) => toast(`${out.title} is open again`),
  });
}

/**
 * A new brief, or an existing one edited (`brief`). Only thumbnail designers are offered, each with what they
 * already have. Editing sends only what changed since the dialog opened; the client and shoot stay as they are.
 */
export function BriefDialog({ brief, focus, designers, onClose }: { brief: ThumbnailBrief | null; focus?: 'designer'; designers?: ThumbnailDesignerLoad[]; onClose: () => void }) {
  const { users, clock, briefIdeas } = useBoot();
  const toast = useToast();
  const nav = useNavigate();
  // the snapshot this form started from: saving compares against it, so a refetch never undoes what's typed
  const [base] = useState(brief);
  const editing = !!base;
  const startDesigner: number | '' = base && !base.needsDesigner && base.designerId != null ? base.designerId : '';
  const [clientId, setClientId] = useState(base ? String(base.clientId) : '');
  const [shootId, setShootId] = useState(base?.shootId != null ? String(base.shootId) : '');
  const [title, setTitle] = useState(base?.title ?? '');
  const [text, setText] = useState(base?.brief ?? '');
  const [onImage, setOnImage] = useState(base?.onImage ?? '');
  const [wanted, setWanted] = useState(base?.optionsWanted ?? DEFAULT_OPTIONS);
  const [dueOn, setDueOn] = useState<string>(base?.dueOn ?? '');
  const [designerId, setDesignerId] = useState<number | ''>(startDesigner);
  const [local, setLocal] = useState<Record<string, string>>({});
  const ids = { c: useFieldId('tb-c'), s: useFieldId('tb-s'), t: useFieldId('tb-t'), b: useFieldId('tb-b'), w: useFieldId('tb-w'), d: useFieldId('tb-d'), z: useFieldId('tb-z') };

  const client = useQuery({ queryKey: ['client', Number(clientId)], queryFn: () => api<ClientDetail>(`/api/clients/${clientId}`), enabled: !editing && !!clientId });
  // who can be given it, with their load: from the board when it's open, else asked for here
  const board = useQuery({ queryKey: ['thumbnails', '', ''], queryFn: () => api<ThumbnailBoard>(boardPath('', '')), enabled: !designers });
  const loads = designers ?? board.data?.designers;
  const people: { id: number; name: string; load: ThumbnailDesignerLoad | null }[] = loads
    ? loads.map((x) => ({ id: x.id, name: x.name, load: x }))
    : users.filter((u) => u.active && !u.removed && isThumbnailDesigner(u)).map((u) => ({ id: u.id, name: u.name, load: null }));
  const shoots = (client.data?.shoots ?? [])
    .filter((s) => !s.cancelledAt && (s.endDate ?? s.startDate) >= addDays(clock.today, -60))
    .sort((a, b) => {
      const up = (s: { startDate: ISODate; endDate: ISODate | null }) => (s.endDate ?? s.startDate) >= clock.today;
      return up(a) !== up(b) ? (up(a) ? -1 : 1) : up(a) ? a.startDate.localeCompare(b.startDate) : b.startDate.localeCompare(a.startDate);
    });

  const save = useSave((body: Record<string, unknown>) => (base
    ? api<ThumbnailBriefDetail>(`/api/thumbnails/${base.id}`, { method: 'PATCH', body })
    : api<ThumbnailBriefDetail>('/api/thumbnails', { body })), {
    onSuccess: (out, body) => {
      const moved = 'designerId' in body;
      if (!base) toast(out.designerName ? `Brief sent to ${out.designerName}` : 'Brief saved. It waits under Needs a designer.', 'ok', { label: 'Open', run: () => { void nav(`/thumbnails/${out.id}`); } });
      else toast(moved && out.designerName ? `${out.title} is now with ${out.designerName}. They’re told.` : `${out.title} updated`);
      onClose();
    },
  });
  const f = { ...local, ...(save.error?.fields ?? {}) };

  const patchBody = (): ThumbnailBriefPatch => {
    const body: ThumbnailBriefPatch = {};
    if (!base) return body;
    if (title.trim() !== base.title) body.title = title.trim();
    if ((text.trim() || null) !== (base.brief ?? null)) body.brief = text.trim() || null;
    if ((onImage.trim() || null) !== (base.onImage ?? null)) body.onImage = onImage.trim() || null;
    if (wanted !== base.optionsWanted) body.optionsWanted = wanted;
    if ((dueOn || null) !== (base.dueOn ?? null)) body.dueOn = (dueOn || null) as ISODate | null;
    if (designerId !== startDesigner) body.designerId = designerId === '' ? null : designerId;
    return body;
  };
  const changed = editing ? Object.keys(patchBody()).length > 0 : true;
  const submit = () => {
    const errs: Record<string, string> = {};
    if (!editing && !clientId) errs.clientId = 'Choose the client';
    if (!title.trim()) errs.title = 'Type the video’s title';
    setLocal(errs);
    if (Object.keys(errs).length) return;
    if (base) { save.mutate({ ...patchBody() }); return; }
    const input: ThumbnailBriefInput = {
      clientId: Number(clientId), shootId: shootId ? Number(shootId) : null, title: title.trim(), brief: text.trim() || null, onImage: onImage.trim() || null,
      optionsWanted: wanted, dueOn: (dueOn || null) as ISODate | null, designerId: designerId === '' ? null : designerId,
    };
    save.mutate({ ...input });
  };
  const loadWords = (l: ThumbnailDesignerLoad | null) => (l ? ` · ${l.open} open${l.dueThisWeek ? `, ${l.dueThisWeek} due this week` : ''}` : '');
  const reassigning = editing && designerId !== startDesigner && startDesigner !== '';
  const fromName = base?.designerName ?? 'the designer';
  return (
    <Dialog open onClose={onClose} title={editing ? 'Edit thumbnail brief' : 'New thumbnail'} sub={editing ? `${base!.clientName}${base!.shootDate ? ` · shoot ${fmtRange(base!.shootDate)}` : ''}` : 'The designer is told straight away. Long videos: widescreen 1280×720.'}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary pill" busy={save.isPending} disabled={!changed} onClick={submit}>{editing ? 'Save changes' : designerId !== '' ? 'Send the brief' : 'Save the brief'}</Button></div>}>
      <form className="form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <FormError error={save.error && !Object.keys(save.error.fields).length ? save.error : null} />
        {!editing && (
          <div className="form-grid">
            <Field label="Client" htmlFor={ids.c} error={f.clientId}>
              {/* a new brief starts at its first field; Edit at the title, Reassign at the designer */}
              <ClientSelect id={ids.c} value={clientId} invalid={f.clientId} autoFocus onChange={(v) => { setClientId(v); setShootId(''); }} />
            </Field>
            <Field label="Shoot" optional htmlFor={ids.s} error={f.shootId} help={clientId && client.isLoading ? 'Loading the client’s shoots…' : undefined}>
              <select className="select" value={shootId} onChange={(e) => setShootId(e.target.value)} disabled={!clientId} {...inputProps(ids.s, f.shootId)}>
                <option value="">No shoot</option>
                {shoots.map((s) => <option key={s.id} value={s.id}>{fmtRange(s.startDate, s.endDate)}{s.title ? ` · ${s.title}` : ''}</option>)}
              </select>
            </Field>
          </div>
        )}
        <Field label="Video title" htmlFor={ids.t} error={f.title} help="The video’s working title, as the designer should read it. Scripts don’t have titles, so type it here.">
          <input className="input" value={title} maxLength={200} data-autofocus={editing && !focus ? true : undefined} onChange={(e) => setTitle(e.target.value)} {...inputProps(ids.t, f.title)} />
        </Field>
        {briefIdeas && (!base || isOpenThumb(base.state)) && (
          <SuggestIdeas clientId={editing ? base!.clientId : clientId ? Number(clientId) : null} shootId={editing ? base!.shootId ?? null : shootId ? Number(shootId) : null}
            title={title} brief={text} onImage={onImage} onUse={(i) => { setText(i.show); setOnImage(i.words); }} />
        )}
        <Field label="What it should show" optional htmlFor={ids.b} error={f.brief} help="The idea: who’s in it, the feeling, what to avoid.">
          <textarea className="textarea" value={text} maxLength={4000} onChange={(e) => setText(e.target.value)} {...inputProps(ids.b, f.brief)} />
        </Field>
        <Field label="Words on the image" optional htmlFor={ids.w} error={f.onImage} help="A few words at most. They read at a glance or not at all.">
          <input className="input" value={onImage} maxLength={300} onChange={(e) => setOnImage(e.target.value)} {...inputProps(ids.w, f.onImage)} />
        </Field>
        <div className="form-grid">
          <div className="field">
            <span className="lbl">Options wanted</span>
            <Seg role="group" aria-label="Options wanted" className="tn-wanted">
              {Array.from({ length: MAX_OPTIONS }, (_, i) => i + 1).map((n) => <button key={n} type="button" aria-pressed={wanted === n} onClick={() => setWanted(n)}>{n}</button>)}
            </Seg>
            {f.optionsWanted ? <span className="err" role="alert">{f.optionsWanted}</span> : <span className="help">Lettered A to {String.fromCharCode(64 + wanted)}. They can send fewer or more.</span>}
          </div>
          <Field label="Due" optional htmlFor={ids.d} error={f.dueOn}>
            <input className="input" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} {...inputProps(ids.d, f.dueOn)} />
          </Field>
        </div>
        <Field label="Designer" optional htmlFor={ids.z} error={f.designerId}
          help={!people.length ? 'No thumbnail designers yet: in Settings → Team, set an Editor’s Kind to Thumbnail designer. The brief waits under Needs a designer.'
            : reassigning ? `${fromName}’s unsent options come out of their tray. Rounds they already sent stay on the brief, and the new designer is told.`
            : base?.needsDesigner && base.designerName ? `${base.designerName} can’t take it any more. Choose someone else.` : 'Only thumbnail designers are offered.'}>
          <select className="select" value={designerId} data-autofocus={focus === 'designer' ? true : undefined} onChange={(e) => setDesignerId(e.target.value ? Number(e.target.value) : '')} {...inputProps(ids.z, f.designerId)}>
            <option value="">No designer yet (Needs a designer)</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{loadWords(p.load)}</option>)}
          </select>
        </Field>
      </form>
    </Dialog>
  );
}

/**
 * "Suggest ideas": three directions for this video from Claude, from the client's look and what was picked for them
 * before. Nothing is saved; "Use this" fills what it should show and the words on the image (Undo puts back what was
 * there). Offered once a client and a title are in.
 */
function SuggestIdeas({ clientId, shootId, title, brief, onImage, onUse }: {
  clientId: number | null; shootId: number | null; title: string; brief: string; onImage: string; onUse: (idea: ThumbIdea) => void;
}) {
  const hid = useId();
  const [undo, setUndo] = useState<{ show: string; words: string } | null>(null);
  // the last ideas that came back (and the title they were for): an ask that fails leaves them showing under its error
  const [last, setLast] = useState<(ThumbnailSuggestions & { title: string }) | null>(null);
  const ask = useMutation<ThumbnailSuggestions & { title: string }, ApiError, ThumbnailSuggestInput>({
    mutationFn: async (input) => ({ ...(await api<ThumbnailSuggestions>('/api/thumbnails/suggest', { body: { ...input } })), title: input.title }),
    onSuccess: (out) => setLast(out),
  });
  const list = useRef<HTMLUListElement>(null);
  const undoBtn = useRef<HTMLButtonElement>(null);
  const ready = clientId != null && !!title.trim();
  const ideas = last?.ideas ?? [];
  const stale = !!last && last.title !== title.trim();
  const go = () => { if (ready) { setUndo(null); ask.mutate({ clientId: clientId!, shootId, title: title.trim() }); } };
  const using = (i: ThumbIdea) => brief.trim() === i.show && onImage.trim() === i.words;
  // the button pressed is swapped for its other half (Use this ⇄ Undo): the keyboard goes there, not out of the dialog
  const refocus = (to: () => Element | null | undefined) => requestAnimationFrame(() => { const el = to(); if (el instanceof HTMLElement) el.focus(); });
  return (
    <section className="tn-ideas" aria-labelledby={hid}>
      <div className="tn-ideas-head">
        <span id={hid} className="tn-ideas-t"><Sparkles aria-hidden /><b>Ideas for the brief</b></span>
        <Button variant="sm" icon={<Lightbulb aria-hidden />} busy={ask.isPending} disabled={!ready} onClick={go}>
          {last ? 'Suggest again' : 'Suggest ideas'}
        </Button>
        <span className="help">{!ready ? 'Choose the client and type the title first.' : stale ? `These were for “${last?.title}”. Ask again for the new title.` : 'Three directions from the client’s look and what was picked before. Nothing is saved.'}</span>
      </div>
      <FormError error={ask.error} />
      {ask.isPending && (
        <ul className="tn-idea-list" aria-label="Thinking of ideas…" role="status">
          {Array.from({ length: THUMB_IDEA_COUNT }, (_, i) => <li key={i} className="tn-idea wait"><span className="sl-skel" aria-hidden><i /><i /><i /></span></li>)}
        </ul>
      )}
      {!ask.isPending && ideas.length > 0 && (
        <ul ref={list} className="tn-idea-list">
          {ideas.map((idea, i) => {
            const on = using(idea);
            return (
              <li key={i} className={`tn-idea${on ? ' on' : ''}`}>
                <span className="tn-idea-n" aria-hidden>{i + 1}</span>
                <p className="tn-idea-show"><span className="sr-only">Idea {i + 1}: </span>{idea.show}</p>
                {idea.words ? <span className="tb-words">{idea.words}</span> : <span className="dim tn-idea-none">No words on the image</span>}
                {idea.why && <p className="tn-idea-why">{idea.why}</p>}
                {on ? (
                  <span className="tn-idea-used" role="status">
                    <Check aria-hidden />In the brief
                    {undo && (
                      <button ref={undoBtn} type="button" className="linkbtn"
                        onClick={() => { onUse({ show: undo.show, words: undo.words, why: '' }); setUndo(null); refocus(() => list.current?.children[i]?.querySelector('button')); }}>Undo</button>
                    )}
                  </span>
                ) : (
                  <Button variant="sm" onClick={() => { setUndo({ show: brief, words: onImage }); onUse(idea); refocus(() => undoBtn.current); }}
                    aria-label={`Use idea ${i + 1}: fill in what it should show and the words on the image`}>Use this</Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Cancelling keeps every round and option as history; it can be reopened. */
export function CancelBriefDialog({ brief, onClose }: { brief: Pick<ThumbnailBrief, 'id' | 'title' | 'designerName' | 'needsDesigner'>; onClose: () => void }) {
  const toast = useToast();
  const save = useSave(() => api<ThumbnailBriefDetail>(`/api/thumbnails/${brief.id}`, { method: 'PATCH', body: { cancelled: true } satisfies ThumbnailBriefPatch }), {
    onSuccess: () => { toast(`${brief.title} cancelled`); onClose(); },
  });
  return (
    <Dialog open onClose={onClose} size="narrow" title="Cancel this brief?" sub={brief.title}
      footer={<div className="form-actions"><Button variant="ghost" onClick={onClose}>Keep it</Button><Button variant="danger" icon={<Ban aria-hidden />} busy={save.isPending} onClick={() => save.mutate(undefined)}>Cancel brief</Button></div>}>
      <div className="form">
        <FormError error={save.error as ApiError | null} />
        <p>{brief.designerName && !brief.needsDesigner ? `${brief.designerName} can’t send rounds on it any more. ` : ''}Its rounds and options stay on it as history, and you can reopen it later.</p>
      </div>
    </Dialog>
  );
}

/** Empty board state shared with the Studio's manager view. */
export function NoDesigners({ children }: { children?: ReactNode }) {
  return <Empty boxed icon={<ImageIcon />} title="No thumbnail designers yet">{children ?? 'In Settings → Team, set an Editor’s Kind to Thumbnail designer.'}</Empty>;
}
