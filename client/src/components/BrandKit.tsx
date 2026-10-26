// A client's brand kit (ClientBrand in shared/types.ts): its colours as swatches that copy their code on a tap, the
// contrast between the darkest and lightest (brandContrast), fonts as names, links or files to download (no live
// specimen), do's and don'ts, the client's logos and references (resources in BRAND_CATEGORIES, as pictures when
// they're images), font files, and for managers and designers the client's recent winners. Shown on the client's
// page, where managers edit it in place (PATCH /api/clients/:id/brand with only the fields changed, brandChanges), and
// in a brief's Brand drawer (`variant="drawer"`, read-only). "Pick colours from logo" reads a logo resource of this
// client in the browser with a canvas (same-origin /api/files/:id, dominantColours): the server never decodes images.

import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle, ArrowDown, ArrowUp, Check, CircleAlert, Copy, Download, ExternalLink, FileType, Palette, Pencil, Pipette, Plus, Trash2, Trophy, Type, X,
} from 'lucide-react';
import { api, useSave } from '../api';
import { fileUrl, RESOURCE_LABEL, type ClientBrand, type ClientBrandPatch, type Resource, type ResourceCategory, type ThumbnailWin } from '../../../shared/types';
import {
  BRAND_LIMITS, brandChanges, brandColourProblems, brandContrast, brandFontProblems, isManager, isPictureMime, thumbBriefPath, type BrandColour, type BrandKitFields,
} from '../../../shared/workflow';
import { dominantColours, LOGO_COLOURS_MAX, normalizeHex } from '../../../shared/palettes';
import { fmtAgo, fmtBytes, plural } from '../../../shared/format';
import { useBoot } from './Shell';
import { Button, Chip, copyText, Empty, ExtLink, FormError, Panel, Thumb, useFieldId, useToast } from './ui';
import { optionAlt } from './ThumbBits';
import { useNow } from './EditingBits';

interface Props {
  clientId: number;
  /** null: the client has no kit yet */
  brand: ClientBrand | null;
  /** the client's resources; the kit shows its logos, references and font files */
  resources: Resource[];
  /** managers and designers: the client's recent winners */
  winners?: ThumbnailWin[];
  /** a manager on the client's page (the client isn't archived): edit in place */
  editable?: boolean;
  /** the client's name, for what screen readers hear */
  clientName?: string;
  /** add a logo, a reference or a font file (the client page's Add a resource, opened on that type) */
  onAddResource?: (category: ResourceCategory) => void;
  /** 'panel' on the client's page; 'drawer' beside a brief: read-only, one column */
  variant?: 'panel' | 'drawer';
}

/** The kit's editable fields as kept: fonts without their files. */
const fieldsOf = (b: ClientBrand): BrandKitFields => ({
  colours: b.colours.map((c) => ({ name: c.name, hex: c.hex })),
  fonts: b.fonts.map((f) => ({ name: f.name, url: f.url, resourceId: f.resourceId })),
  dos: b.dos,
  donts: b.donts,
});

const isFile = (r: Resource) => r.kind === 'file' && r.fileId != null;
const isPicture = (r: Resource) => isFile(r) && isPictureMime(r.fileMime);

export function BrandKit({ clientId, brand, resources, winners = [], editable = false, clientName = 'this client', onAddResource, variant = 'panel' }: Props) {
  const now = useNow();
  const [editing, setEditing] = useState(false);
  const editBtn = useRef<HTMLButtonElement>(null);
  // the editor closes (saved or cancelled): the keyboard goes back to Edit kit
  const stopEditing = () => { setEditing(false); requestAnimationFrame(() => editBtn.current?.focus()); };
  const drawer = variant === 'drawer';
  const view = <BrandView brand={brand} resources={resources} winners={drawer ? [] : winners} clientName={clientName} compact={drawer}
    onAddResource={editable ? onAddResource : undefined} onSetUp={editable ? () => setEditing(true) : undefined} />;
  if (drawer) return <div className="bk drawer">{view}</div>;
  const sub = brand ? `updated ${fmtAgo(brand.updatedAt, now)}${brand.updatedByName ? ` by ${brand.updatedByName}` : ''}` : 'colours, fonts, do’s and don’ts';
  return (
    <Panel title="Brand kit" sub={sub} className="bk-panel"
      tools={editable && !editing ? <Button ref={editBtn} variant="sm" icon={<Pencil aria-hidden />} onClick={() => setEditing(true)}>{brand ? 'Edit kit' : 'Set up the kit'}</Button> : undefined}>
      {editing && editable
        ? <BrandEditor clientId={clientId} brand={brand} resources={resources} onDone={stopEditing} onAddResource={onAddResource} />
        : <div className="bk">{view}</div>}
    </Panel>
  );
}

// ── reading the kit ──────────────────────────────────────────────────────

function BrandView({ brand, resources, winners, clientName, compact, onAddResource, onSetUp }: {
  brand: ClientBrand | null; resources: Resource[]; winners: ThumbnailWin[]; clientName: string; compact: boolean;
  onAddResource?: (category: ResourceCategory) => void; onSetUp?: () => void;
}) {
  const colours = brand?.colours ?? [];
  const fonts = brand?.fonts ?? [];
  const looks = resources.filter((r) => r.category === 'logo' || r.category === 'reference');
  const pictures = looks.filter(isPicture);
  const otherLooks = looks.filter((r) => !isPicture(r));
  // font files kept as resources that no font in the kit names
  const named = new Set(fonts.map((f) => f.resourceId).filter((id): id is number => id != null));
  const fontFiles = resources.filter((r) => r.category === 'font' && !named.has(r.id));
  const nothing = !colours.length && !fonts.length && !brand?.dos && !brand?.donts && !looks.length && !fontFiles.length && !winners.length;
  if (nothing) {
    return (
      <Empty boxed={!compact} icon={<Palette />} title="No brand kit yet"
        action={onSetUp ? <Button variant="sm primary" icon={<Plus aria-hidden />} onClick={onSetUp}>Set up the kit</Button> : undefined}>
        {onSetUp ? `Add ${clientName}’s colours, fonts, do’s and don’ts, and their logos, so designers and writers work from the same look.` : `Managers add ${clientName}’s colours, fonts, do’s and don’ts on the client’s page.`}
      </Empty>
    );
  }
  return (
    <>
      <section className="bk-sec" aria-label="Colours">
        <div className="section-title">Colours</div>
        {colours.length ? <Swatches colours={colours} /> : <p className="dim bk-none">No colours yet.</p>}
        <ContrastLine colours={colours} />
      </section>
      {(fonts.length > 0 || fontFiles.length > 0 || !compact) && (
        <section className="bk-sec" aria-label="Fonts">
          <div className="section-title">Fonts</div>
          {fonts.length > 0 && (
            <ul className="bk-fonts">
              {fonts.map((f, i) => (
                <li key={`${f.name}-${i}`} className="bk-font">
                  <span className="bk-font-ic" aria-hidden><Type /></span>
                  <b className="bk-font-n">{f.name}</b>
                  <span className="bk-font-get">
                    {f.url && <ExtLink href={f.url} className="btn sm ghost">Get it<ExternalLink aria-hidden /></ExtLink>}
                    {f.file && (
                      <a className="btn sm ghost" href={`${fileUrl(f.file.id)}?download=1`} download={f.file.name} aria-label={`Download ${f.name}: ${f.file.name}, ${fmtBytes(f.file.size)}`}>
                        <Download aria-hidden />Download · {fmtBytes(f.file.size)}
                      </a>
                    )}
                    {!f.url && !f.file && <span className="dim">{f.resourceId != null ? 'Its file was removed' : 'No link or file'}</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {fontFiles.length > 0 && (
            <ul className="bk-files" aria-label="Font files">
              {fontFiles.map((r) => <li key={r.id}><ResourceLink r={r} /></li>)}
            </ul>
          )}
          {!fonts.length && !fontFiles.length && <p className="dim bk-none">No fonts yet.</p>}
        </section>
      )}
      {(brand?.dos || brand?.donts || !compact) && (
        <section className="bk-sec bk-dd" aria-label="Do’s and don’ts">
          <div className="bk-do">
            <div className="section-title"><Check aria-hidden />Do</div>
            {brand?.dos ? <p className="pre">{brand.dos}</p> : <p className="dim bk-none">Nothing written yet.</p>}
          </div>
          <div className="bk-dont">
            <div className="section-title"><X aria-hidden />Don’t</div>
            {brand?.donts ? <p className="pre">{brand.donts}</p> : <p className="dim bk-none">Nothing written yet.</p>}
          </div>
        </section>
      )}
      {(looks.length > 0 || onAddResource) && (
        <section className="bk-sec" aria-label="Logos and references">
          <div className="bk-sec-h">
            <div className="section-title">Logos and references</div>
            {onAddResource && (
              <span className="bk-sec-tools">
                <Button variant="sm ghost" icon={<Plus aria-hidden />} onClick={() => onAddResource('logo')}>Logo</Button>
                <Button variant="sm ghost" icon={<Plus aria-hidden />} onClick={() => onAddResource('reference')}>Reference</Button>
              </span>
            )}
          </div>
          {pictures.length > 0 && (
            <ul className="bk-pics">
              {pictures.map((r) => (
                <li key={r.id}>
                  <a className={`bk-pic${r.category === 'logo' ? ' logo' : ''}`} href={fileUrl(r.fileId!)} target="_blank" rel="noopener noreferrer"
                    aria-label={`${RESOURCE_LABEL[r.category]}: ${r.title} (opens full size in a new tab)`}>
                    <Thumb src={fileUrl(r.fileId!)} alt={r.title} fit="contain" />
                    <span className="bk-pic-t"><b>{r.title}</b><span>{RESOURCE_LABEL[r.category]}</span></span>
                  </a>
                </li>
              ))}
            </ul>
          )}
          {otherLooks.length > 0 && <ul className="bk-files">{otherLooks.map((r) => <li key={r.id}><ResourceLink r={r} /></li>)}</ul>}
          {!looks.length && <p className="dim bk-none">No logos or references yet. Add them as resources with the type Logo or Reference.</p>}
        </section>
      )}
      {winners.length > 0 && <Winners winners={winners} clientName={clientName} />}
    </>
  );
}

/** A resource that isn't a picture: a link to open, or a file to download. */
function ResourceLink({ r }: { r: Resource }) {
  if (isFile(r)) {
    return (
      <a className="bk-file" href={`${fileUrl(r.fileId!)}?download=1`} download={r.fileName ?? undefined}>
        <FileType aria-hidden /><span className="bk-file-t"><b>{r.title}</b><span>{RESOURCE_LABEL[r.category]}{r.fileSize != null ? ` · ${fmtBytes(r.fileSize)}` : ''} · download</span></span>
      </a>
    );
  }
  if (!r.url) return null;
  return (
    <ExtLink href={r.url} className="bk-file">
      <ExternalLink aria-hidden /><span className="bk-file-t"><b>{r.title}</b><span>{RESOURCE_LABEL[r.category]} · opens in a new tab</span></span>
    </ExtLink>
  );
}

/** The colours, each a button that copies its code (with a toast), in the order the kit keeps them. */
function Swatches({ colours }: { colours: readonly BrandColour[] }) {
  const toast = useToast();
  const [copied, setCopied] = useState<number | null>(null);
  useEffect(() => { if (copied == null) return; const t = setTimeout(() => setCopied(null), 1600); return () => clearTimeout(t); }, [copied]);
  const copy = async (c: BrandColour, i: number) => {
    if (await copyText(c.hex)) { setCopied(i); toast(`Copied ${c.hex} · ${c.name}`); } else toast(`Couldn’t reach the clipboard. ${c.name} is ${c.hex}.`, 'error');
  };
  return (
    <ul className="bk-swatches">
      {colours.map((c, i) => (
        <li key={`${c.hex}-${i}`}>
          <button type="button" className="bk-sw" onClick={() => { void copy(c, i); }} aria-label={`${c.name}, ${c.hex}. Copy the code`}>
            <span className="bk-sw-chip" style={{ background: c.hex }} aria-hidden />
            <span className="bk-sw-t">
              <b>{c.name}</b>
              <span className="tnum">{c.hex}{copied === i ? <Check className="bk-sw-ok" aria-hidden /> : <Copy className="bk-sw-cp" aria-hidden />}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

/** "4.4:1 · Navy on Cream", with a sample of the darkest on the lightest, and whether text would read (in words, never colour alone). */
function ContrastLine({ colours }: { colours: readonly BrandColour[] }) {
  const c = brandContrast(colours);
  if (!c) return null;
  const name = (hex: string) => colours.find((x) => normalizeHex(x.hex) === hex)?.name ?? hex;
  return (
    <div className="bk-contrast">
      <span className="bk-contrast-s" style={{ background: c.light, color: c.dark }} aria-hidden>Aa</span>
      <span className="bk-contrast-t">
        <b className="tnum">{c.label}</b>
        <span>{name(c.dark)} on {name(c.light)}: the darkest and lightest</span>
      </span>
      {c.readable
        ? <Chip color="mint" icon={<Check aria-hidden />}>Reads as text</Chip>
        : <Chip color="yellow" icon={<AlertTriangle aria-hidden />} title="Under 4.5:1: fine for shapes and big type, hard to read as small text">Low for small text</Chip>}
    </div>
  );
}

/** The client's recent winners: a manager opens the brief; a designer opens their own, and anyone else's picture full size. */
function Winners({ winners, clientName }: { winners: ThumbnailWin[]; clientName: string }) {
  const { me } = useBoot();
  const now = useNow();
  return (
    <section className="bk-sec" aria-label={`${clientName}’s recent winners`}>
      <div className="section-title">Recent winners</div>
      <ul className="bk-wins">
        {winners.map((w) => {
          const mine = isManager(me.role) || w.option.uploadedById === me.id;
          const label = `${w.title}: option ${w.option.letter} by ${w.option.uploadedByName}, picked ${fmtAgo(w.pickedAt, now)}${w.standout ? ', a standout' : ''}`;
          const inner = (
            <>
              <Thumb src={w.option.url} alt={optionAlt(w.option, w.title)}>
                {w.standout && <span className="thumb-tl"><Chip color="yellow" icon={<Trophy aria-hidden />}>Standout</Chip></span>}
              </Thumb>
              <span className="win-cap"><b>{w.title}</b><span>{w.option.uploadedByName} · {fmtAgo(w.pickedAt, now)}</span></span>
            </>
          );
          return (
            <li key={w.option.id} className="win">
              {mine
                ? <Link to={thumbBriefPath(me, w.briefId)} className="win-link" aria-label={label}>{inner}</Link>
                : <a href={w.option.url} target="_blank" rel="noopener noreferrer" className="win-link" aria-label={`${label} (opens full size in a new tab)`}>{inner}</a>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── editing the kit (managers) ───────────────────────────────────────────

interface DraftColour { key: string; name: string; hex: string }
interface DraftFont { key: string; name: string; url: string; resourceId: number | null }

let seq = 0;
const nextKey = () => `bk${++seq}`;

const hasProblem = (p: Record<string, string | undefined>) => Object.values(p).some(Boolean);

/** A row's problems under it, each field's on its own line, and the id its field points at (aria-describedby). */
function RowProblems({ problems, idOf }: { problems: Record<string, string | undefined>; idOf: (field: string) => string }) {
  return (
    <>
      {Object.entries(problems).map(([field, text]) => text && <span key={field} id={idOf(field)} className="err" role="alert"><CircleAlert aria-hidden />{text}</span>)}
    </>
  );
}

/** After a row is taken out: the keyboard goes to the Remove of the row now in its place (or the last), or to Add when none are left. */
const focusAfterRemove = (list: RefObject<HTMLUListElement | null>, add: RefObject<HTMLButtonElement | null>, i: number) => requestAnimationFrame(() => {
  const rows = list.current?.querySelectorAll<HTMLElement>('.bk-ed-row') ?? [];
  const row = rows.length ? rows[Math.min(i, rows.length - 1)] : null;
  (row?.querySelector<HTMLElement>('.bk-ed-remove') ?? add.current)?.focus();
});

function BrandEditor({ clientId, brand, resources, onDone, onAddResource }: {
  clientId: number; brand: ClientBrand | null; resources: Resource[]; onDone: () => void; onAddResource?: (category: ResourceCategory) => void;
}) {
  const toast = useToast();
  // the kit as it was when editing began: saving compares against it, so a refetch never undoes what's typed
  const [base] = useState<BrandKitFields | null>(() => (brand ? fieldsOf(brand) : null));
  const [colours, setColours] = useState<DraftColour[]>(() => (brand?.colours ?? []).map((c) => ({ key: nextKey(), name: c.name, hex: c.hex })));
  const [fonts, setFonts] = useState<DraftFont[]>(() => (brand?.fonts ?? []).map((f) => ({ key: nextKey(), name: f.name, url: f.url ?? '', resourceId: f.resourceId })));
  const [dos, setDos] = useState(brand?.dos ?? '');
  const [donts, setDonts] = useState(brand?.donts ?? '');
  const [tried, setTried] = useState(false);
  const ids = { dos: useFieldId('bk-do'), donts: useFieldId('bk-dont'), err: useFieldId('bk-err') };
  const heading = useRef<HTMLDivElement>(null);
  const colourList = useRef<HTMLUListElement>(null);
  const fontList = useRef<HTMLUListElement>(null);
  const addColour = useRef<HTMLButtonElement>(null);
  const addFont = useRef<HTMLButtonElement>(null);
  // opened from Edit kit (or Set up the kit): the keyboard starts at the top of the editor
  useEffect(() => { heading.current?.focus(); }, []);
  const save = useSave((body: ClientBrandPatch) => api<ClientBrand>(`/api/clients/${clientId}/brand`, { method: 'PATCH', body: { ...body } }), {
    onSuccess: () => { toast('Brand kit saved'); onDone(); },
  });
  const f = save.error?.fields ?? {};

  const next: BrandKitFields = {
    colours: colours.map((c) => ({ name: c.name, hex: normalizeHex(c.hex) ?? c.hex })),
    fonts: fonts.map((x) => ({ name: x.name, url: x.url.trim() || null, resourceId: x.resourceId })),
    dos, donts,
  };
  const changes = brandChanges(base, next);
  const changed = Object.keys(changes).length > 0;
  const bad = colours.some((c) => hasProblem(brandColourProblems(c))) || fonts.some((x) => hasProblem(brandFontProblems(x)));
  const room = BRAND_LIMITS.colours - colours.length;

  const patchColour = (key: string, p: Partial<DraftColour>) => { if (save.error) save.reset(); setColours((all) => all.map((c) => (c.key === key ? { ...c, ...p } : c))); };
  const patchFont = (key: string, p: Partial<DraftFont>) => { if (save.error) save.reset(); setFonts((all) => all.map((x) => (x.key === key ? { ...x, ...p } : x))); };
  const move = <T,>(list: T[], i: number, by: number) => { const out = [...list]; const [it] = out.splice(i, 1); out.splice(i + by, 0, it); return out; };
  const addColours = (found: BrandColour[]) => setColours((all) => [...all, ...found.map((c) => ({ key: nextKey(), ...c }))].slice(0, BRAND_LIMITS.colours));

  const submit = () => {
    setTried(true);
    if (bad || !changed) return;
    save.mutate(changes);
  };
  const fontFiles = resources.filter((r) => r.category === 'font' && isFile(r));
  const logos = resources.filter((r) => r.category === 'logo' && isPicture(r));
  return (
    <form className="form bk-ed" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <FormError error={save.error && !Object.keys(f).length ? save.error : null} />

      <section className="bk-sec" aria-label="Colours">
        <div className="bk-sec-h">
          <div ref={heading} tabIndex={-1} className="section-title bk-ed-start">Colours</div>
          <span className="dim bk-count">{colours.length} of {BRAND_LIMITS.colours}</span>
        </div>
        {colours.length > 0 && (
          <ul ref={colourList} className="bk-ed-list">
            {colours.map((c, i) => {
              const problem = tried ? brandColourProblems(c) : {};
              const hex = normalizeHex(c.hex);
              const label = c.name.trim() || `Colour ${i + 1}`;
              const errId = (field: string) => `${ids.err}-${c.key}-${field}`;
              return (
                <li key={c.key} className={`bk-ed-row colour${hasProblem(problem) ? ' bad' : ''}`}>
                  <input type="color" className="bk-picker" value={(hex ?? '#000000').toLowerCase()} onChange={(e) => patchColour(c.key, { hex: e.target.value.toUpperCase() })} aria-label={`${label}: pick the colour`} />
                  <input className="input sm bk-ed-name" value={c.name} maxLength={BRAND_LIMITS.name} placeholder="Name, e.g. Signal red" onChange={(e) => patchColour(c.key, { name: e.target.value })}
                    aria-label={`Colour ${i + 1} name`} aria-invalid={!!problem.name || undefined} aria-describedby={problem.name ? errId('name') : undefined} />
                  <input className="input sm num pal-hex" value={c.hex} maxLength={7} spellCheck={false} placeholder="#RRGGBB" onChange={(e) => patchColour(c.key, { hex: e.target.value.trim() })}
                    onBlur={() => { if (hex && hex !== c.hex) patchColour(c.key, { hex }); }} aria-label={`${label}: colour code`}
                    aria-invalid={!!problem.hex || undefined} aria-describedby={problem.hex ? errId('hex') : undefined} />
                  <RowTools i={i} n={colours.length} what={label} onMove={(by) => setColours((all) => move(all, i, by))}
                    onRemove={() => { setColours((all) => all.filter((x) => x.key !== c.key)); focusAfterRemove(colourList, addColour, i); }} />
                  <RowProblems problems={problem} idOf={errId} />
                </li>
              );
            })}
          </ul>
        )}
        {f.colours && <span className="err" role="alert"><CircleAlert aria-hidden />{f.colours}</span>}
        <div className="bk-ed-add">
          <Button ref={addColour} variant="sm" icon={<Plus aria-hidden />} disabled={room <= 0} onClick={() => setColours((all) => [...all, { key: nextKey(), name: '', hex: '#' }])}>Add colour</Button>
          <LogoColours logos={logos} have={colours.map((c) => normalizeHex(c.hex)).filter((h): h is string => !!h)} room={room} names={colours.map((c) => c.name)}
            onAdd={addColours} onAddLogo={onAddResource ? () => onAddResource('logo') : undefined} />
        </div>
        <ContrastLine colours={next.colours.filter((c) => normalizeHex(c.hex))} />
      </section>

      <section className="bk-sec" aria-label="Fonts">
        <div className="bk-sec-h">
          <div className="section-title">Fonts</div>
          <span className="dim bk-count">{fonts.length} of {BRAND_LIMITS.fonts}</span>
        </div>
        {fonts.length > 0 && (
          <ul ref={fontList} className="bk-ed-list">
            {fonts.map((x, i) => {
              const problem = tried ? brandFontProblems(x) : {};
              const label = x.name.trim() || `Font ${i + 1}`;
              const gone = x.resourceId != null && !fontFiles.some((r) => r.id === x.resourceId);
              const errId = (field: string) => `${ids.err}-${x.key}-${field}`;
              return (
                <li key={x.key} className={`bk-ed-row font${hasProblem(problem) ? ' bad' : ''}`}>
                  <input className="input sm bk-ed-name" value={x.name} maxLength={BRAND_LIMITS.name} placeholder="Name, e.g. Montserrat ExtraBold" onChange={(e) => patchFont(x.key, { name: e.target.value })}
                    aria-label={`Font ${i + 1} name`} aria-invalid={!!problem.name || undefined} aria-describedby={problem.name ? errId('name') : undefined} />
                  <input className="input sm bk-ed-url" type="url" value={x.url} placeholder="https:// link to get it (optional)" spellCheck={false} onChange={(e) => patchFont(x.key, { url: e.target.value })}
                    aria-label={`${label}: link`} aria-invalid={!!problem.url || undefined} aria-describedby={problem.url ? errId('url') : undefined} />
                  <select className="select sm bk-ed-file" value={x.resourceId ?? ''} onChange={(e) => patchFont(x.key, { resourceId: e.target.value ? Number(e.target.value) : null })} aria-label={`${label}: font file`}>
                    <option value="">No file</option>
                    {gone && <option value={x.resourceId!}>A file since removed</option>}
                    {fontFiles.map((r) => <option key={r.id} value={r.id}>{r.title}{r.fileSize != null ? ` · ${fmtBytes(r.fileSize)}` : ''}</option>)}
                  </select>
                  <RowTools i={i} n={fonts.length} what={label} onMove={(by) => setFonts((all) => move(all, i, by))}
                    onRemove={() => { setFonts((all) => all.filter((y) => y.key !== x.key)); focusAfterRemove(fontList, addFont, i); }} />
                  <RowProblems problems={problem} idOf={errId} />
                </li>
              );
            })}
          </ul>
        )}
        {f.fonts && <span className="err" role="alert"><CircleAlert aria-hidden />{f.fonts}</span>}
        <div className="bk-ed-add">
          <Button ref={addFont} variant="sm" icon={<Plus aria-hidden />} disabled={fonts.length >= BRAND_LIMITS.fonts} onClick={() => setFonts((all) => [...all, { key: nextKey(), name: '', url: '', resourceId: null }])}>Add font</Button>
          {onAddResource && <Button variant="sm ghost" icon={<Plus aria-hidden />} onClick={() => onAddResource('font')}>Upload a font file</Button>}
          <span className="help">A link to where the team gets it, a font file kept with the client’s resources, or both. Files download; there’s no preview.</span>
        </div>
      </section>

      <section className="bk-sec bk-dd" aria-label="Do’s and don’ts">
        <div className="field bk-do">
          <label htmlFor={ids.dos}><Check aria-hidden />Do</label>
          <textarea className="textarea" id={ids.dos} value={dos} maxLength={BRAND_LIMITS.notes} placeholder="e.g. Faces big and close. Logo bottom right, small." onChange={(e) => setDos(e.target.value)}
            aria-invalid={f.dos ? true : undefined} />
          {f.dos ? <span className="err" role="alert"><CircleAlert aria-hidden />{f.dos}</span> : <span className="help tnum">{dos.length} / {BRAND_LIMITS.notes}</span>}
        </div>
        <div className="field bk-dont">
          <label htmlFor={ids.donts}><X aria-hidden />Don’t</label>
          <textarea className="textarea" id={ids.donts} value={donts} maxLength={BRAND_LIMITS.notes} placeholder="e.g. No red arrows. Never the old logo." onChange={(e) => setDonts(e.target.value)}
            aria-invalid={f.donts ? true : undefined} />
          {f.donts ? <span className="err" role="alert"><CircleAlert aria-hidden />{f.donts}</span> : <span className="help tnum">{donts.length} / {BRAND_LIMITS.notes}</span>}
        </div>
      </section>

      <div className="form-actions">
        <span className="muted left bk-ed-state" role="status">{tried && bad ? 'Fix the rows marked above first.' : changed ? `Changed: ${Object.keys(changes).map((k) => KEY_WORDS[k as keyof BrandKitFields]).join(', ')}` : 'Nothing changed yet'}</span>
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary pill" busy={save.isPending} disabled={!changed}>Save kit</Button>
      </div>
    </form>
  );
}

const KEY_WORDS: Record<keyof BrandKitFields, string> = { colours: 'colours', fonts: 'fonts', dos: 'do’s', donts: 'don’ts' };

/** Move up, move down and remove, for one row of the editor. */
function RowTools({ i, n, what, onMove, onRemove }: { i: number; n: number; what: string; onMove: (by: number) => void; onRemove: () => void }) {
  return (
    <span className="bk-ed-tools">
      <button type="button" className="icon-btn sm" disabled={i === 0} onClick={() => onMove(-1)} aria-label={`Move ${what} up`} title="Move up"><ArrowUp size={15} /></button>
      <button type="button" className="icon-btn sm" disabled={i === n - 1} onClick={() => onMove(1)} aria-label={`Move ${what} down`} title="Move down"><ArrowDown size={15} /></button>
      <button type="button" className="icon-btn sm bk-ed-remove" onClick={onRemove} aria-label={`Remove ${what}`} title="Remove"><Trash2 size={15} /></button>
    </span>
  );
}

// ── pick colours from the logo ───────────────────────────────────────────

/** The longest side the logo is read at: plenty to find its colours, and quick. */
const READ_SIDE = 200;

/** A logo's main colours, read in the browser: drawn on a canvas from the same-origin file, then dominantColours. */
async function readLogoColours(fileId: number): Promise<string[]> {
  const img = new Image();
  img.decoding = 'async';
  img.src = fileUrl(fileId);
  await img.decode();
  const w0 = img.naturalWidth || 1;
  const h0 = img.naturalHeight || 1;
  const scale = Math.min(1, READ_SIDE / Math.max(w0, h0));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w0 * scale));
  canvas.height = Math.max(1, Math.round(h0 * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return dominantColours(ctx.getImageData(0, 0, canvas.width, canvas.height).data, LOGO_COLOURS_MAX);
}

/** A plain starting name for a colour picked from a logo ("Dark blue"); the manager renames it. */
function hueName(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  const tone = l < 0.3 ? 'Dark ' : l > 0.75 ? 'Light ' : '';
  if (s < 0.15) return `${tone}grey`.replace(/^grey/, 'Grey');
  const h = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const hue = (h + 360) % 360;
  const name = hue < 15 || hue >= 345 ? 'red' : hue < 40 ? 'orange' : hue < 66 ? 'yellow' : hue < 160 ? 'green' : hue < 195 ? 'teal' : hue < 255 ? 'blue' : hue < 290 ? 'purple' : 'pink';
  return tone ? `${tone}${name}` : name[0].toUpperCase() + name.slice(1);
}

/** Names not already in the kit: "Blue", then "Blue 2". */
function freshNames(hexes: string[], taken: string[]): BrandColour[] {
  const used = new Set(taken.map((n) => n.trim().toLowerCase()));
  return hexes.map((hex) => {
    const base = hueName(hex);
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} ${n}`;
    used.add(name.toLowerCase());
    return { name, hex };
  });
}

function LogoColours({ logos, have, room, names, onAdd, onAddLogo }: {
  logos: Resource[]; have: string[]; room: number; names: string[]; onAdd: (c: BrandColour[]) => void; onAddLogo?: () => void;
}) {
  const toast = useToast();
  const [logoId, setLogoId] = useState<number | null>(logos[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState<{ hex: string; keep: boolean }[] | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const hid = useId();
  const logo = logos.find((r) => r.id === logoId) ?? logos[0] ?? null;
  if (!logo) {
    return onAddLogo
      ? <Button variant="sm ghost" icon={<Pipette aria-hidden />} onClick={onAddLogo} title="Add the client’s logo as a PNG, JPG or WebP file with the type Logo, then pick its colours">Add a logo to pick its colours</Button>
      : null;
  }
  const read = async () => {
    setBusy(true);
    try {
      const hexes = await readLogoColours(logo.fileId!);
      const fresh = hexes.filter((h) => !have.includes(h));
      if (!hexes.length) { setFound(null); toast('No clear colours in that logo: it may be mostly white, black or see-through.', 'error'); return; }
      // nothing new to keep or drop: say so, rather than open a list of colours that can't be chosen
      if (!fresh.length) { setFound(null); toast(`All of ${logo.title}’s colours are already in the kit.`); return; }
      setFound(hexes.map((hex) => ({ hex, keep: fresh.includes(hex) && fresh.indexOf(hex) < room })));
      requestAnimationFrame(() => box.current?.focus({ preventScroll: true }));
    } catch {
      toast('Couldn’t read that logo’s colours. Is it a PNG, JPG or WebP?', 'error');
    } finally {
      setBusy(false);
    }
  };
  const kept = (found ?? []).filter((x) => x.keep && !have.includes(x.hex));
  return (
    <>
      {logos.length > 1 && (
        <select className="select sm bk-logo-pick" value={logo.id} onChange={(e) => { setLogoId(Number(e.target.value)); setFound(null); }} aria-label="Which logo">
          {logos.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
        </select>
      )}
      <Button variant="sm ghost" icon={<Pipette aria-hidden />} busy={busy} onClick={() => { void read(); }}>Pick colours from logo</Button>
      {found && found.length > 0 && (
        <div ref={box} tabIndex={-1} className="bk-found" role="group" aria-labelledby={hid}>
          <div className="bk-found-h">
            <span className="bk-found-pic"><Thumb src={fileUrl(logo.fileId!)} alt={logo.title} fit="contain" /></span>
            <span id={hid} className="bk-found-t"><b>From {logo.title}</b><span>Tap a colour to keep or drop it.</span></span>
          </div>
          <ul className="bk-found-list">
            {found.map((x, i) => {
              const inKit = have.includes(x.hex);
              return (
                <li key={x.hex}>
                  <button type="button" className="bk-found-c" aria-pressed={x.keep && !inKit} disabled={inKit}
                    onClick={() => setFound((all) => all && all.map((y, j) => (j === i ? { ...y, keep: !y.keep } : y)))}
                    aria-label={`${x.hex}${inKit ? ', already in the kit' : x.keep ? ', kept' : ', dropped'}`}>
                    <span className="bk-sw-chip" style={{ background: x.hex }} aria-hidden />
                    <span className="tnum">{x.hex}</span>
                    {inKit ? <span className="dim">in the kit</span> : x.keep ? <Check aria-hidden /> : <X aria-hidden />}
                  </button>
                </li>
              );
            })}
          </ul>
          <div className="bk-found-acts">
            <Button variant="sm primary" icon={<Plus aria-hidden />} disabled={!kept.length || kept.length > room}
              onClick={() => { onAdd(freshNames(kept.map((x) => x.hex), names)); toast(`${plural(kept.length, 'colour')} added from ${logo.title}. Name them, then save.`); setFound(null); }}>
              {kept.length ? `Add ${plural(kept.length, 'colour')}` : 'Add colours'}
            </Button>
            <Button variant="sm ghost" onClick={() => setFound(null)}>Cancel</Button>
            {kept.length > room && <span className="help">The kit holds {BRAND_LIMITS.colours}: drop {kept.length - room} or remove some first.</span>}
          </div>
        </div>
      )}
    </>
  );
}

/** For pages that show the kit only when there's something in it: true once it has a colour, font, note, logo, reference or font file. */
export function hasBrandKit(brand: ClientBrand | null | undefined, resources: Resource[]): boolean {
  const kept = !!brand && (brand.colours.length > 0 || brand.fonts.length > 0 || !!brand.dos || !!brand.donts);
  return kept || resources.some((r) => r.category === 'logo' || r.category === 'reference' || r.category === 'font');
}
