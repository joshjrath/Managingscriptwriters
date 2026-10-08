// What an editor's sign-in may do. Editors cut the videos: they read the
// calendar, finished scripts, clients and resources, and use
// to-dos. Everything else is refused here, before any route runs, so a new
// route is closed to editors until it's added to this list on purpose.
// (An admin viewing the site as an editor gets exactly the same.)

import type { FastifyInstance } from 'fastify';
import { HttpError } from './http';

const ALLOW: Record<string, ReadonlySet<string>> = {
  GET: new Set([
    '/api/auth/status', '/api/bootstrap', '/api/counts', '/api/moments', '/api/notifications',
    '/api/calendar', '/api/script-bank', '/api/files/:id', '/api/shoot-readiness', '/api/search',
    '/api/clients', '/api/clients/:id', '/api/resources',
    '/api/todos',
  ]),
  POST: new Set([
    '/api/auth/login', '/api/auth/logout', '/api/me/password', '/api/me/timezone', '/api/me/whats-new',
    '/api/moments/seen', '/api/notifications/read',
    '/api/todos',
  ]),
  PATCH: new Set(['/api/todos/:id']),
  DELETE: new Set(['/api/todos/:id']),
};
// leaving View as / Recording mode is the admin's own control, not the editor's
const ADMIN_CONTROLS = /^\/api\/admin\//;

export function registerEditorAccess(app: FastifyInstance) {
  app.addHook('preHandler', async (req) => {
    if (req.user?.role !== 'editor' || !req.url.startsWith('/api/')) return;
    const route = req.routeOptions?.url ?? '';
    if (ALLOW[req.method]?.has(route)) return;
    if (req.realUser && req.realUser.role === 'owner' && ADMIN_CONTROLS.test(route)) return;
    throw new HttpError(403, 'Editors can see the calendar, finished scripts, clients and resources. Ask an admin for anything else.', undefined, 'editor');
  });
}

export const editorRoutes = ALLOW;
