// Workspace colour palettes. Each one keeps the house vibe: a near-black
// shell, charcoal panels and bright pastel accents dark text sits on. A
// palette only swaps the colours; what each colour means stays the same
// (brand = active navigation and featured cards, action = due today and
// primary buttons, info = in progress, review, done = approved/delivered,
// revisions, alert = overdue and errors).

export const ACCENTS = ['brand', 'action', 'info', 'review', 'done', 'revisions', 'alert'] as const;
export type Accent = (typeof ACCENTS)[number];
export type AccentColors = Record<Accent, string>;

export const ACCENT_LABEL: Record<Accent, { name: string; use: string }> = {
  brand: { name: 'Brand', use: 'Active page, featured cards, focus' },
  action: { name: 'Action', use: 'Primary buttons, due today' },
  info: { name: 'Writing', use: 'Writing, information' },
  review: { name: 'In review', use: 'Scripts in review' },
  done: { name: 'Done', use: 'Approved and delivered' },
  revisions: { name: 'Revisions', use: 'Sent back for changes' },
  alert: { name: 'Alert', use: 'Overdue, blockers, errors' },
};

/** the CSS variable each accent drives */
export const ACCENT_VAR: Record<Accent, string> = {
  brand: '--salmon', action: '--yellow', info: '--cyan', review: '--lavender', done: '--mint', revisions: '--pink', alert: '--red',
};

export const SURFACES = ['neutral', 'warm', 'cool', 'plum'] as const;
export type SurfaceTone = (typeof SURFACES)[number];
export const SURFACE_LABEL: Record<SurfaceTone, string> = { neutral: 'Charcoal', warm: 'Warm', cool: 'Cool', plum: 'Plum' };

const SURFACE_VARS = ['--bg', '--sidebar', '--panel', '--panel-2', '--row', '--row-hover', '--btn', '--btn-hover', '--track', '--line', '--line-soft'] as const;
const SURFACE_SETS: Record<SurfaceTone, string[]> = {
  neutral: ['#0B0B0D', '#141416', '#19191D', '#222228', '#2B2B32', '#33333B', '#38383F', '#44444C', '#26262C', '#36363E', '#2A2A31'],
  warm: ['#0D0B0A', '#171413', '#1C1817', '#25201E', '#2F2927', '#38312E', '#3D3532', '#4A413D', '#2A2422', '#3B3431', '#2D2725'],
  cool: ['#0A0B0E', '#121418', '#171A1F', '#1F2329', '#282D34', '#30353D', '#353B44', '#414852', '#23272E', '#333941', '#272B32'],
  plum: ['#0C0A0E', '#151218', '#1B171F', '#241F29', '#2D2733', '#352E3C', '#3A3342', '#463E4F', '#27212C', '#372F3F', '#2A2430'],
};

export interface Palette {
  id: string;
  name: string;
  vibe: string;
  surfaces: SurfaceTone;
  colors: AccentColors;
}

export const PALETTES: Palette[] = [
  { id: 'scale', name: 'Scale Media', vibe: 'The original: salmon and lemon on charcoal', surfaces: 'neutral',
    colors: { brand: '#F2A599', action: '#F4ED70', info: '#55C7E8', review: '#9D89EF', done: '#60D1BE', revisions: '#E77AB5', alert: '#F16C63' } },
  { id: 'sunset', name: 'Sunset', vibe: 'Tangerine and marigold, a little warmer', surfaces: 'warm',
    colors: { brand: '#FF9F7A', action: '#FFD166', info: '#5BC0EB', review: '#A18CF2', done: '#5DD6B0', revisions: '#F081B3', alert: '#F4665C' } },
  { id: 'rose', name: 'Rose gold', vibe: 'Dusty rose and gold on plum', surfaces: 'plum',
    colors: { brand: '#F0A6B8', action: '#F5D77A', info: '#6CC4E8', review: '#B29CF4', done: '#72D5B8', revisions: '#DE8AD0', alert: '#F06E6E' } },
  { id: 'glacier', name: 'Glacier', vibe: 'Ice blue and pale lemon, cool and calm', surfaces: 'cool',
    colors: { brand: '#9CC7F7', action: '#EFEA86', info: '#67D8DC', review: '#A996F3', done: '#7BDDB2', revisions: '#EC8DC1', alert: '#F07167' } },
  { id: 'citrus', name: 'Citrus', vibe: 'Peach and lime, extra fresh', surfaces: 'neutral',
    colors: { brand: '#FFB38A', action: '#D8F36A', info: '#5CC9F2', review: '#A494F6', done: '#67D9A9', revisions: '#EF86B9', alert: '#F26B5E' } },
  { id: 'iris', name: 'Iris', vibe: 'Lilac and butter yellow on plum', surfaces: 'plum',
    colors: { brand: '#B8A6FF', action: '#F6E66B', info: '#5AC8E6', review: '#86A8F7', done: '#66D4BF', revisions: '#EE88BD', alert: '#F26D66' } },
];
export const DEFAULT_PALETTE = PALETTES[0];

/** What the workspace stores: a preset, optionally with your own tweaks on top. */
export interface WorkspaceTheme {
  preset: string;
  surfaces?: SurfaceTone;
  colors?: Partial<AccentColors>;
}

export interface ResolvedTheme {
  palette: Palette;
  surfaces: SurfaceTone;
  colors: AccentColors;
  custom: boolean;
}

export const HEX = /^#[0-9a-fA-F]{6}$/;

export function resolveTheme(t: WorkspaceTheme | null | undefined): ResolvedTheme {
  const palette = PALETTES.find((p) => p.id === t?.preset) ?? DEFAULT_PALETTE;
  const colors = { ...palette.colors };
  let custom = false;
  for (const k of ACCENTS) {
    const v = t?.colors?.[k];
    if (v && HEX.test(v) && v.toUpperCase() !== colors[k].toUpperCase()) { colors[k] = v.toUpperCase(); custom = true; }
  }
  const surfaces = t?.surfaces && SURFACES.includes(t.surfaces) ? t.surfaces : palette.surfaces;
  if (surfaces !== palette.surfaces) custom = true;
  return { palette, surfaces, colors, custom };
}

/** CSS variables for a theme, ready to set on :root. */
export function themeVars(t: WorkspaceTheme | null | undefined): Record<string, string> {
  const r = resolveTheme(t);
  const vars: Record<string, string> = {};
  for (const k of ACCENTS) vars[ACCENT_VAR[k]] = r.colors[k];
  SURFACE_SETS[r.surfaces].forEach((c, i) => { vars[SURFACE_VARS[i]] = c; });
  return vars;
}

export const surfaceSwatch = (tone: SurfaceTone) => SURFACE_SETS[tone];

/** Contrast of dark text (#111113) on a colour: accents need about 7:1 to read well. */
export function darkTextContrast(hex: string): number {
  const ch = (i: number) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const l = 0.2126 * ch(1) + 0.7152 * ch(3) + 0.0722 * ch(5);
  const dark = 0.0059; // #111113
  return (l + 0.05) / (dark + 0.05);
}
