// Builds the Fastify app: session loading, CSRF guard, security headers,
// error handling, API routes and (in production) the built client.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { AsyncLocalStorage } from 'node:async_hooks';
import { HttpError, isApiRequest } from './http';
import type { Ctx } from './core';
import { registerAccountRoutes } from './routes/account';
import { registerTodoRoutes } from './todos';
import { registerCalendarFeedRoutes } from './calendar-feeds';
import { registerCalendarShootRoutes } from './calendar-shoots';
import { registerEditorAccess } from './editor-access';
import { registerBatchRoutes } from './routes/batches';
import { registerClientRoutes } from './routes/clients';
import { registerShootRoutes } from './routes/shoots';
import { registerViewRoutes } from './routes/views';
import { registerAudit } from './audit';
import { registerSubmissionRoutes } from './submissions';
import { registerMomentRoutes } from './moments';
import { registerNotesImportRoutes } from './notes-import';
import { registerRecording, routedDb } from './recording';
import { registerScriptBankRoutes } from './script-bank';
import { registerTodayRoutes } from './today';
import { registerEditorRoutes } from './control/editors';
import { registerTimelinerRoutes } from './timeliner';
import { registerUploadCleanup } from './files';
import type { Db } from './db';
import { CSRF_HEADER } from '../shared/types';

export async function buildApp(ctx: Ctx, opts: { staticDir?: string; logger?: boolean; trustProxy?: boolean | number } = {}): Promise<FastifyInstance> {
  const hops = opts.trustProxy ?? true;
  // a hop count trusts that many proxies nearest the server (what proxy-addr does with a number)
  const trustProxy = typeof hops === 'number' ? (_addr: string, i: number) => i < hops : hops;
  const app = Fastify({ logger: opts.logger ?? false, trustProxy, bodyLimit: 1024 * 1024 });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: ctx.uploadLimitBytes, files: 1, fields: 20 } });

  app.decorateRequest('user', null);

  app.addHook('onRequest', async (req) => {
    if (!isApiRequest(req)) return;
    // Mutations must come from our own page: a custom header can't be sent
    // cross-site without a CORS preflight, which this server never grants.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers[CSRF_HEADER] !== '1') throw new HttpError(403, 'Request blocked. Reload the page and try again.');
      const origin = req.headers.origin;
      // an opaque origin ("null", from a sandboxed frame or a file) is never ours
      if (origin && req.headers.host && originHost(origin) !== req.headers.host) throw new HttpError(403, 'Cross-site request blocked');
    }
  });

  // Sessions, View as and Recording mode (which sends a sign-in's requests to a practice copy).
  const realDb = ctx.realDb ?? ctx.db;
  const als = new AsyncLocalStorage<Db>();
  ctx.realDb = realDb;
  ctx.db = routedDb(realDb, als);
  ctx.dbNow = () => als.getStore() ?? realDb;
  registerRecording(app, ctx, realDb, als);
  registerEditorAccess(app);
  registerUploadCleanup(app);

  app.addHook('onSend', async (req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    // production is always served over HTTPS (and its cookies are Secure): browsers should never try plain HTTP
    if (ctx.secureCookies) reply.header('Strict-Transport-Security', 'max-age=31536000');
    if (isApiRequest(req)) {
      if (!reply.hasHeader('Cache-Control')) reply.header('Cache-Control', 'no-store');
    } else if (!reply.hasHeader('Content-Security-Policy')) {
      reply.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    return payload;
  });

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { message: err.message, fields: err.fields, code: err.code } });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { message: `Files can be up to ${Math.round(ctx.uploadLimitBytes / 1024 / 1024)} MB` } });
    }
    if (err.code === 'FST_FILES_LIMIT') return reply.status(413).send({ error: { message: 'That’s more files than can be sent at once.' } });
    if (err.statusCode === 413) return reply.status(413).send({ error: { message: 'That’s too much to send at once.' } });
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { message: err.message } });
    }
    // unique violations that slipped past explicit checks
    if ((err as { code?: string }).code === '23505') {
      return reply.status(409).send({ error: { message: 'That already exists.', code: 'duplicate' } });
    }
    req.log.error(err);
    if (!opts.logger) console.error(err);
    return reply.status(500).send({ error: { message: 'Something went wrong on the server, so nothing was saved. Try again.' } });
  });

  app.get('/healthz', async (_req, reply) => {
    await ctx.db.query('select 1');
    return reply.type('text/plain').send('ok');
  });

  registerAudit(app, ctx);
  registerAccountRoutes(app, ctx);
  registerViewRoutes(app, ctx);
  registerClientRoutes(app, ctx);
  registerShootRoutes(app, ctx);
  registerBatchRoutes(app, ctx);
  registerSubmissionRoutes(app, ctx);
  registerMomentRoutes(app, ctx);
  registerNotesImportRoutes(app, ctx);
  registerScriptBankRoutes(app, ctx);
  registerTodayRoutes(app, ctx);
  registerTodoRoutes(app, ctx);
  registerCalendarFeedRoutes(app, ctx);
  registerCalendarShootRoutes(app, ctx);
  registerEditorRoutes(app, ctx);
  registerTimelinerRoutes(app, ctx);

  app.all('/api/*', async () => { throw new HttpError(404, 'Not found'); });

  if (opts.staticDir && existsSync(opts.staticDir)) {
    const indexHtml = await readFile(path.join(opts.staticDir, 'index.html'), 'utf8');
    await app.register(fastifyStatic, {
      root: opts.staticDir,
      wildcard: false,
      index: false,
      setHeaders(res, file) {
        if (file.includes(`${path.sep}assets${path.sep}`)) res.header('Cache-Control', 'public, max-age=31536000, immutable');
      },
    });
    // the client is a single-page app: unknown paths get index.html
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || isApiRequest(req)) return reply.status(404).send({ error: { message: 'Not found' } });
      return reply.type('text/html').header('Cache-Control', 'no-cache').send(indexHtml);
    });
  }

  return app;
}

function originHost(origin: string): string | null {
  try { return new URL(origin).host; } catch { return null; }
}
