// Where everything sits in each view, worked out once per world snapshot:
// the constellation (a force-directed graph of people, projects and clients),
// the script galaxy (writers as gravity wells, finished work drifting deep),
// the mission orbit, and the deadline orbits.

import { Vector3 } from 'three';
import { bandOf, type ControlWorld } from '../../../../shared/control';
import { geoToVec3, hashString, mulberry } from './math';

export interface GraphNode {
  kind: 'writer' | 'project' | 'client';
  id: string;
  pos: Vector3;
}

export interface GraphEdge {
  a: number;
  b: number;
  kind: 'works' | 'client' | 'review' | 'collab';
}

export interface Layouts {
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; index: Map<string, number> };
  /** galaxy: gravity wells for writers, cluster centres for projects, a star per script */
  space: { writers: Map<string, Vector3>; projects: Map<string, Vector3>; scripts: Map<string, Vector3> };
  /** order of live projects around the mission orbit */
  missionOrder: string[];
}

const key = (kind: GraphNode['kind'], id: string) => `${kind[0]}:${id}`;

export function computeLayouts(world: ControlWorld): Layouts {
  const live = world.projects.filter((p) => !p.archived);

  // ── constellation ──────────────────────────────────────────────────────
  const nodes: GraphNode[] = [];
  const index = new Map<string, number>();
  const add = (kind: GraphNode['kind'], id: string, pos: Vector3) => {
    index.set(key(kind, id), nodes.length);
    nodes.push({ kind, id, pos });
  };
  for (const w of world.writers) add('writer', w.id, geoToVec3(w.lat, w.lon, 2.1));
  const usedClients = new Set(live.map((p) => p.clientId));
  for (const p of live) {
    const mine = p.writers.map((id) => nodes[index.get(key('writer', id)) ?? -1]?.pos).filter(Boolean) as Vector3[];
    const c = mine.reduce((acc, v) => acc.add(v), new Vector3()).multiplyScalar(1 / Math.max(1, mine.length));
    const h = hashString(p.id);
    add('project', p.id, c.lengthSq() > 0.01 ? c.clone().multiplyScalar(0.7).add(new Vector3(h - 0.5, hashString(p.id + 'y') - 0.5, hashString(p.id + 'z') - 0.5)) : new Vector3(Math.cos(h * 6.28), 0, Math.sin(h * 6.28)));
  }
  for (const c of world.clients) {
    if (!usedClients.has(c.id)) continue;
    const ps = live.filter((p) => p.clientId === c.id).map((p) => nodes[index.get(key('project', p.id))!].pos);
    const center = ps.reduce((acc, v) => acc.add(v), new Vector3()).multiplyScalar(1 / Math.max(1, ps.length));
    add('client', c.id, center.clone().multiplyScalar(1.35).add(new Vector3(0, hashString(c.id) - 0.5, 0)));
  }
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const edge = (a: string, b: string, kind: GraphEdge['kind']) => {
    const ia = index.get(a), ib = index.get(b);
    if (ia == null || ib == null || ia === ib) return;
    const k = ia < ib ? `${ia}-${ib}` : `${ib}-${ia}`;
    if (seen.has(k)) return;
    seen.add(k);
    edges.push({ a: ia, b: ib, kind });
  };
  for (const p of live) {
    for (const w of p.writers) edge(key('writer', w), key('project', p.id), 'works');
    edge(key('project', p.id), key('client', p.clientId), 'client');
  }
  for (const l of world.links) edge(key('writer', l.from), key('writer', l.to), l.kind === 'collab' ? 'collab' : 'review');

  // a few hundred steps of a gentle force simulation; deterministic, so the graph doesn't jump on refresh
  const vel = nodes.map(() => new Vector3());
  const rest: Record<GraphEdge['kind'], number> = { works: 0.95, client: 0.55, review: 1.25, collab: 1.1 };
  const tmp = new Vector3();
  for (let step = 0; step < 320; step++) {
    const cool = 1 - step / 320;
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        tmp.subVectors(nodes[i].pos, nodes[j].pos);
        const d2 = Math.max(0.04, tmp.lengthSq());
        const f = 0.02 / d2;
        tmp.normalize().multiplyScalar(f);
        vel[i].add(tmp);
        vel[j].sub(tmp);
      }
    }
    for (const e of edges) {
      tmp.subVectors(nodes[e.b].pos, nodes[e.a].pos);
      const d = tmp.length() || 0.001;
      const f = (d - rest[e.kind]) * 0.02;
      tmp.multiplyScalar(f / d);
      vel[e.a].add(tmp);
      vel[e.b].sub(tmp);
    }
    for (let i = 0; i < nodes.length; i++) {
      vel[i].addScaledVector(nodes[i].pos, -0.004);
      nodes[i].pos.addScaledVector(vel[i], 0.9 * cool + 0.1);
      vel[i].multiplyScalar(0.72);
    }
  }
  // fit into a sphere of radius ~1.65 so the whole network is on screen
  const centre = nodes.reduce((acc, n) => acc.add(n.pos), new Vector3()).multiplyScalar(1 / Math.max(1, nodes.length));
  let far = 0.01;
  for (const n of nodes) far = Math.max(far, n.pos.sub(centre).length());
  for (const n of nodes) n.pos.multiplyScalar(1.65 / far);

  // ── galaxy ─────────────────────────────────────────────────────────────
  const rand = mulberry(99);
  const gauss = () => { const u = rand() || 1e-6, v = rand(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const writers = new Map<string, Vector3>();
  world.writers.forEach((w, i) => {
    const a = (i / Math.max(1, world.writers.length)) * Math.PI * 2 + 0.4;
    const r = 1.1 + (hashString(w.id) - 0.5) * 0.4;
    writers.set(w.id, new Vector3(Math.cos(a) * r * 1.45, Math.sin(a) * r * 0.7 + (hashString(w.id + 'y') - 0.5) * 0.3, (hashString(w.id + 'z') - 0.5) * 0.8));
  });
  const projects = new Map<string, Vector3>();
  const now = Date.now();
  for (const p of world.projects) {
    const wells = p.writers.map((id) => writers.get(id)).filter(Boolean) as Vector3[];
    const h = hashString(p.id);
    if (p.archived) {
      // finished work drifts back into the field; older light is deeper and further out
      const age = p.completedAt ? (now - new Date(p.completedAt).getTime()) / 86_400_000 : 60;
      const depth = 3.4 + Math.min(7, Math.sqrt(age) * 0.6);
      const a = h * Math.PI * 2 + age * 0.07;
      const r = 0.6 + Math.min(2.2, Math.sqrt(age) * 0.18) + hashString(p.id + 'r') * 0.4;
      projects.set(p.id, new Vector3(Math.cos(a) * r * 1.05, Math.sin(a) * r * 0.62, -depth));
    } else {
      // a project's cluster circles its lead writer's well
      const lead = wells[0] ?? new Vector3();
      const a = h * Math.PI * 2;
      projects.set(p.id, lead.clone().add(new Vector3(Math.cos(a) * 0.42, Math.sin(a) * 0.3, (hashString(p.id + 'z') - 0.5) * 0.5)));
    }
  }
  const scripts = new Map<string, Vector3>();
  for (const s of world.scripts) {
    const p = projects.get(s.projectId);
    if (!p) continue;
    const project = world.projects.find((x) => x.id === s.projectId)!;
    const well = s.writerId ? writers.get(s.writerId) : undefined;
    const spread = project.archived ? 0.34 : s.state === 'delivered' ? 0.3 : s.state === 'approved' ? 0.2 : 0.13;
    const base = well && !project.archived ? p.clone().lerp(well, 0.3) : p.clone();
    const pos = base.add(new Vector3(gauss() * spread, gauss() * spread * 0.7, gauss() * spread));
    // within live work, finished scripts sit further back
    if (!project.archived && (s.state === 'delivered' || s.state === 'approved')) pos.z -= 0.35 + rand() * 0.5;
    scripts.set(s.id, pos);
  }

  const missionOrder = live
    .slice()
    .sort((a, b) => (a.deadline ?? '9').localeCompare(b.deadline ?? '9'))
    .map((p) => p.id);

  return { graph: { nodes, edges, index }, space: { writers, projects, scripts }, missionOrder };
}

// ── deadline orbits ──────────────────────────────────────────────────────

/** radius range of each orbit around Earth (Earth = now) */
export const BAND_RADII: Record<string, [number, number]> = {
  OVERDUE: [1.12, 1.16], '24H': [1.26, 1.44], '48H': [1.52, 1.7], '7D': [1.82, 2.16], '30D': [2.3, 2.85], LATER: [3.0, 3.2],
};

export function deadlineOrbit(deadline: string | null, at: Date): { radius: number; band: string; hours: number } {
  const b = bandOf(deadline, at);
  const [lo, hi] = BAND_RADII[b.band];
  return { radius: lo + (hi - lo) * Math.min(1, Math.max(0, b.t)), band: b.band, hours: b.hours };
}
