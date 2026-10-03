# Working on this repo

- **Every change to the platform gets a What's new entry.** Add it to the top of `CHANGELOG` in `shared/changelog.ts` (newest first, a new unique `id`, today's date, plain-language text for managers and writers). The What's new page and its "new" dot read from there, and it is meant to list every change since the first version.
- Never edit a migration that has shipped; append a new one to `MIGRATIONS` in `server/schema.ts`.
- Before pushing: `npm run verify` (typecheck, lint with zero warnings, tests, build). It's what CI runs.

`ARCHITECTURE.md` maps the code: where things live, how a request is handled, how access works, and the invariants. Read the parts you're about to touch.

## Before you change anything

1. Read the code you're changing, its callers, and its tests. Search for an existing helper before you write one.
2. Find the one place the rule lives and change it there:
   - dates and deadlines: `shared/dates.ts`
   - statuses, roles, actions and progress: `shared/workflow.ts`
   - environment variables: `server/config.ts`
   - validation: `zs` and `parse` in `server/http.ts`
   - row loaders: `server/records.ts`
   - UI: `client/src/components/ui.tsx` and `client/src/styles/tokens.css`
3. Keep the change to what was asked. Don't redesign screens, rename things, or reformat files you aren't otherwise changing. If you think existing behaviour is wrong, say so separately before changing it.

## Rules that keep it safe

- **Every API route** starts with `requireUser`, `requireManager` or `requireAdmin` (`server/auth.ts`), unless it is deliberately public. Check ownership in the route as well; hiding a button in the UI protects nothing. Add each new route to `ACCESS` in `test/access.test.ts`.
- **Roles:** use `isManager` and `isAdmin` from `shared/workflow.ts`, never role strings. Only an Admin may grant the Admin role or touch an Admin's account.
- **Script status** changes only through `applyScriptAction` in `server/routes/batches.ts`. Progress and counts are always computed from script rows; never store a total.
- **Databases:** route code uses `ctx.db`, never `ctx.realDb`, so that Recording mode can't write to the real workspace. Multi-row changes run in `db.tx` and lock the batch row first.
- **Validate input** with zod through `parse()`, and throw `HttpError` (or `notFound`, `forbidden`, `conflict`) for anything the person should see.
- **Configuration:** server code gets settings from `loadConfig` in `server/config.ts`, never straight from `process.env` (dev tooling and tests aside). Add every new variable there, with its default, and to `.env.example`. Never put real secrets in docs, tests or the client bundle.
- **Schema changes:** add a new migration. Make it additive (new tables, nullable columns, indexes), never drop data, and do backfills as function migrations. Never assume a database is empty.
- **Client:** call the server through `api()` and `useSave()` in `client/src/api.ts`, and handle promises (lint enforces this). An edit form sends only the fields the person changed.

## Tests

- Add a test for every bug fix and every new rule. Each must fail without the fix.
- `test/api.test.ts` is one ordered scenario, so don't run it with `-t`. Put a self-contained case in `test/workspace.test.ts` with `freshDb()`, or in a new file.
- `TEST_DATABASE_URL=postgres://… npm test` runs the suites on a real PostgreSQL. It wipes that database's schema first.

## When you finish

1. Run `npm run verify`, and fix anything it reports rather than suppressing it. Don't add `eslint-disable`, `@ts-ignore` or `as any` to make a check pass.
2. Add the What's new entry.
3. Update `ARCHITECTURE.md` or the README if you moved something or changed how something works.
4. Re-read your diff for unrelated changes, debug output and secrets before committing.
