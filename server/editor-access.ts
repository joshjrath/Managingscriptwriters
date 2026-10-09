// What an editor's sign-in may do. Editors cut the videos: they read the
// calendar, finished scripts, clients and resources, use to-dos, and see
// their own videos from Timeliner (opening the shoot's scripts PDF for a video
// of theirs), saying which one they're on. Everything
// else is refused here, before any route runs, so a new route is closed to
// editors until it's added to this list on purpose.
// (An admin viewing the site as an editor gets exactly the same.)

import type { FastifyInstance } from 'fastify';
import { HttpError, isApiRequest } from './http';
import { isAdmin, isEditor } from '../shared/workflow';

const ALLOW: Record<string, ReadonlySet<string>> = {
  GET: new Set([
    '/api/auth/status', '/api/bootstrap', '/api/counts', '/api/moments', '/api/notifications',
    '/api/calendar', '/api/script-bank', '/api/files/:id', '/api/shoot-readiness', '/api/search',
    '/api/clients', '/api/clients/:id', '/api/resources',
    '/api/todos', '/api/editing/me', '/api/editing/script-pdf/:batchId',
  ]),
  POST: new Set([
    '/api/auth/login', '/api/auth/logout', '/api/me/password', '/api/me/timezone', '/api/me/whats-new',
    '/api/moments/seen', '/api/notifications/read',
    '/api/todos', '/api/editing/focus',
  ]),
  PATCH: new Set(['/api/todos/:id']),
  DELETE: new Set(['/api/todos/:id']),
};
// leaving View as / Recording mode is the admin's own control, not the editor's
const ADMIN_CONTROLS = /^\/api\/admin\//;

export function registerEditorAccess(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    // judged on the decoded path the router matched: "/%61pi/…" reaches the same routes as "/api/…"
    if (!req.user || !isEditor(req.user.role) || !isApiRequest(req)) return;
    const route = req.routeOptions?.url ?? '';
    if (ALLOW[req.method]?.has(route)) return;
    if (req.realUser && isAdmin(req.realUser.role) && ADMIN_CONTROLS.test(route)) return;
    throw new HttpError(403, 'Editors can see the calendar, finished scripts, clients and resources. Ask an admin for anything else.', undefined, 'editor');
  });
}

export const editorRoutes = ALLOW;
