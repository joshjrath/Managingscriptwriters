// Shared by every world source: fills in what can be worked out from the
// scripts (each person's current signal, each project's stage and progress),
// so a source only has to say what exists.

import {
  CONTROL_VERSION, isOpen, stageOf,
  type CcProject, type CcScript, type CcWriter, type ControlWorld, type ScriptState,
} from '../../shared/control';

/** internal work is finished: waiting on the client, approved or delivered */
export const isComplete = (s: ScriptState) => s === 'client_review' || s === 'approved' || s === 'delivered';

export function finishWorld(world: Omit<ControlWorld, 'version'>, at: Date): ControlWorld {
  const scriptsByProject = new Map<string, CcScript[]>();
  for (const s of world.scripts) scriptsByProject.set(s.projectId, [...(scriptsByProject.get(s.projectId) ?? []), s]);

  const projects: CcProject[] = world.projects.map((p) => {
    const list = scriptsByProject.get(p.id) ?? [];
    const writers = new Set(p.writers);
    for (const s of list) {
      if (s.writerId) writers.add(s.writerId);
      if (s.reviewerId && !p.archived) writers.add(s.reviewerId);
    }
    return {
      ...p,
      scripts: list.map((s) => s.id),
      writers: [...writers].filter((id) => world.writers.some((w) => w.id === id)),
      stage: p.archived ? 'delivered' : stageOf(list.map((s) => s.state)),
      progress: { done: list.filter((s) => isComplete(s.state)).length, total: list.length },
    };
  });
  const byProject = new Map(projects.map((p) => [p.id, p]));
  const now = at.getTime();

  const writers: CcWriter[] = world.writers.map((w) => {
    if (w.currentAssignment) return w;
    const live = (s: CcScript) => !byProject.get(s.projectId)?.archived;
    const soonest = (list: CcScript[]) => {
      const due = (s: CcScript) => (s.deadline ? new Date(s.deadline).getTime() : Infinity);
      const upcoming = list.filter((s) => due(s) >= now);
      return (upcoming.length ? upcoming : list).sort((a, b) => due(a) - due(b))[0];
    };
    const own = world.scripts.filter((s) => s.writerId === w.id && isOpen(s.state) && live(s));
    // what's in their orbit as reviewer: waiting on them, sent back by them, or with the client
    const reviewing = world.scripts.filter((s) => s.reviewerId === w.id && s.writerId !== w.id && (s.state === 'internal_review' || s.state === 'revision' || s.state === 'client_review') && live(s));
    const lead = w.role === 'lead' || w.role === 'reviewer' || w.role === 'editor';
    // leads and reviewers carry the most urgent project in their review queue; writers their next deadline
    let pick: CcScript | undefined;
    if (lead && reviewing.length) pick = soonest(reviewing);
    else pick = own.length ? soonest(own) : reviewing.length ? soonest(reviewing) : undefined;
    if (!pick) return w;
    const project = byProject.get(pick.projectId)!;
    const share = lead && reviewing.some((s) => s.projectId === project.id)
      ? world.scripts.filter((s) => s.projectId === project.id)
      : world.scripts.filter((s) => s.projectId === project.id && s.writerId === w.id);
    const openShare = share.filter((s) => isOpen(s.state) && s.deadline && new Date(s.deadline).getTime() >= now);
    const next = openShare.sort((a, b) => new Date(a.deadline!).getTime() - new Date(b.deadline!).getTime())[0];
    return {
      ...w,
      currentAssignment: project.title,
      projectId: project.id,
      clientId: project.clientId,
      progress: { done: share.filter((s) => isComplete(s.state)).length, total: share.length },
      deadline: next?.deadline ?? project.deadline,
      stage: stageOf(share.filter((s) => isOpen(s.state)).map((s) => s.state)),
    };
  });

  return { ...world, version: CONTROL_VERSION, writers, projects };
}
