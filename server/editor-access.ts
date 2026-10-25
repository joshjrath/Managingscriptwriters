// What an editor's sign-in may do, by kind (shared/workflow.ts: one job per person).
// Every editor reads the calendar, finished scripts, clients and resources, and
// uses to-dos (BASE). Video editors also see their own videos from Timeliner
// (opening the shoot's scripts PDF for a video of theirs), saying which one
// they're on; thumbnail designers get their Studio: their briefs, uploading
// options to their tray, sending a round, and an AI second look on an option
// of theirs. Everything else is refused here,
// before any route runs, so a new route is closed to editors until it's added
// to this list on purpose. (An admin viewing the site as an editor gets exactly
// the same: the kind is the viewed person's.)

import type { FastifyInstance } from 'fastify';
import { HttpError, isApiRequest } from './http';
import { EDITOR_KINDS, EDITOR_REFUSAL, editorKindOf, isAdmin, type EditorKind } from '../shared/workflow';

type Routes = Record<string, readonly string[]>;

/** What every editor may call, whatever their kind. */
const BASE: Routes = {
  GET: [
    '/api/auth/status', '/api/bootstrap', '/api/counts', '/api/moments', '/api/notifications',
    '/api/calendar', '/api/script-bank', '/api/files/:id', '/api/shoot-readiness', '/api/search',
    '/api/clients', '/api/clients/:id', '/api/resources',
    '/api/todos',
  ],
  POST: [
    '/api/auth/login', '/api/auth/logout', '/api/me/password', '/api/me/timezone', '/api/me/whats-new',
    '/api/moments/seen', '/api/notifications/read',
    '/api/todos',
  ],
  PATCH: ['/api/todos/:id'],
  DELETE: ['/api/todos/:id'],
};

/** What each kind adds to BASE. */
const BY_KIND: Record<EditorKind, Routes> = {
  short_form: {
    GET: ['/api/editing/me', '/api/editing/script-pdf/:batchId'],
    POST: ['/api/editing/focus'],
  },
  thumbnail: {
    GET: ['/api/studio', '/api/thumbnails/:id'],
    POST: ['/api/thumbnails/:id/options', '/api/thumbnails/:id/send', '/api/thumbnail-options/:id/second-look'],
    DELETE: ['/api/thumbnail-options/:id'],
  },
};

const merge = (...sets: Routes[]): Record<string, ReadonlySet<string>> => {
  const out: Record<string, Set<string>> = {};
  for (const set of sets) for (const [method, routes] of Object.entries(set)) for (const r of routes) (out[method] ??= new Set()).add(r);
  return out;
};

const ALLOW = Object.fromEntries(EDITOR_KINDS.map((k) => [k, merge(BASE, BY_KIND[k])])) as Record<EditorKind, Record<string, ReadonlySet<string>>>;

/** The routes an editor of this kind may call, by method. */
export const editorRoutesFor = (kind: EditorKind): Record<string, ReadonlySet<string>> => ALLOW[kind];

// leaving View as / Recording mode is the admin's own control, not the editor's
const ADMIN_CONTROLS = /^\/api\/admin\//;

export function registerEditorAccess(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    // judged on the decoded path the router matched: "/%61pi/…" reaches the same routes as "/api/…"
    const kind = req.user ? editorKindOf(req.user) : null;
    if (!kind || !isApiRequest(req)) return;
    const route = req.routeOptions?.url ?? '';
    if (ALLOW[kind][req.method]?.has(route)) return;
    if (req.realUser && isAdmin(req.realUser.role) && ADMIN_CONTROLS.test(route)) return;
    throw new HttpError(403, EDITOR_REFUSAL[kind], undefined, 'editor');
  });
}
