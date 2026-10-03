// Where the pointer touches the planet, for the LAT/LON readout. Kept outside
// React state so a move redraws only the readout, not the whole overlay.

export type Geo = { lat: number; lon: number } | null;
export type GeoStore = ReturnType<typeof geoStore>;

/** the readout shows four decimals: a change below that is nothing to redraw */
const shown = (g: Geo) => (g ? `${g.lat.toFixed(4)} ${g.lon.toFixed(4)}` : '');

export function geoStore() {
  let value: Geo = null;
  const subs = new Set<() => void>();
  return {
    get: (): Geo => value,
    set: (g: Geo) => {
      if (shown(g) === shown(value)) return;
      value = g;
      subs.forEach((f) => f());
    },
    subscribe: (f: () => void) => {
      subs.add(f);
      return () => { subs.delete(f); };
    },
  };
}
