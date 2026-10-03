// What the overlay needs from a world view: the WebGL engine, or the 2D
// fallback when WebGL isn't available.

import type { Anomaly, CcHandoff, ControlWorld } from '../../../../shared/control';
import type { EngineStats, Filter, Focus, Mode } from './Engine';

export interface WorldView {
  readonly mode: Mode;
  readonly focus: Focus;
  readonly stats: EngineStats;
  readonly currentAnomalies: Anomaly[];
  readonly timeOffset: number;
  readonly flat: boolean;
  setWorld(world: ControlWorld): void;
  setMode(mode: Mode): void;
  setFocus(focus: Focus): void;
  setFilter(filter: Filter): void;
  focusGeo(lat: number, lon: number): void;
  /** Pin an element to something in space; returns the way to let go of it. */
  bind(key: string, el: HTMLElement): () => void;
  playHandoff(h: CcHandoff): boolean;
  reveal(fast?: boolean): void;
  /** `running`: the clock is being played forward (Follow the sun), so slow-changing readings can lag a moment */
  setTimeOffset(ms: number, running?: boolean): void;
  zoomBy(factor: number): void;
  nudge(yaw: number, pitch: number): void;
  now(): Date;
  start(): void;
  stop(): void;
  dispose(): void;
}
