# Working on this repo

- **Every change to the platform gets a What's new entry.** Add it to the top of `CHANGELOG` in `shared/changelog.ts` (newest first, a new unique `id`, today's date, plain-language text for managers and writers). The What's new page and its "new" dot read from there, and it is meant to list every change since the first version.
- Never edit a migration that has shipped; append a new one to `MIGRATIONS` in `server/schema.ts`.
- Before pushing: `npm run typecheck`, `npm test`, `npm run build`.
