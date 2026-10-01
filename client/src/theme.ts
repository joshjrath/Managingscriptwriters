// Applies the workspace colour palette by setting the design tokens on :root.
// The last palette is remembered on this device so pages open in the right
// colours before the server has answered.

import { themeVars, type WorkspaceTheme } from '../../shared/palettes';

const KEY = 'sm.theme';
let saved: WorkspaceTheme | null = null;

export function applyTheme(theme: WorkspaceTheme | null | undefined, opts: { preview?: boolean } = {}) {
  const vars = themeVars(theme);
  const root = document.documentElement.style;
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', vars['--bg']);
  if (opts.preview) return;
  saved = theme ?? null;
  try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch { /* private mode */ }
}

/** Go back to the saved palette after a preview. */
export const restoreTheme = () => applyTheme(saved);

export function applyRememberedTheme() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) applyTheme(JSON.parse(raw));
  } catch { /* ignore */ }
}

/** The palette's accents, for confetti and other one-off effects. */
export function themeColors(): string[] {
  const css = getComputedStyle(document.documentElement);
  return ['--salmon', '--yellow', '--mint', '--lavender', '--cyan', '--pink'].map((v) => css.getPropertyValue(v).trim()).filter(Boolean);
}
