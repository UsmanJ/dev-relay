# Contributing to DevRelay

Thanks for helping! DevRelay is alpha software, so issues, docs fixes and adapters are all welcome.

## Ground rules

- **No credentials handling.** Contributions must not read, store, forward or log provider tokens or credential files. Adapters must rely on each user's own official CLI login, or on a clearly opt-in `api-metered` configuration.
- **No terms circumvention.** No scraping of vendor web apps, binary patching, rate-limit evasion, or multi-user routing of personal subscriptions. See [docs/PROVIDERS.md](docs/PROVIDERS.md).
- **Safety defaults stay on.** Read-only by default, explicit approvals, shell-free subprocesses, no automatic merge/push/deploy.
- **No personal data in the repo.** That means no real project names, paths, usernames, transcripts or databases in code, tests, fixtures or docs. Use the sample repo or `example` placeholders.

## Setup

```powershell
npm install
npm run verify        # typecheck + lint + tests + production build
npm run demo          # offline end-to-end run with mock agents
```

Tests must not make network or AI requests. Use the `mock` adapter (scenario markers are documented in `src/core/providers/mock.ts`) or `setAgentOverride()`.

## Pull requests

- Keep PRs focused, and add or adjust tests for behaviour changes (state transitions, schemas, adapters, safety guards).
- Update docs, and `CHANGELOG.md` under *Unreleased*.
- Run `npm run verify` locally. CI runs it on Windows, Linux and macOS.
- If you change the DB schema, edit `src/core/db/schema.ts`, run `npm run db:generate`, and commit the new migration.
- By contributing you agree that your contributions are licensed under the Apache License 2.0.

## Adding a provider adapter

See "Writing a new adapter" in [docs/PROVIDERS.md](docs/PROVIDERS.md). Include the vendor's authentication terms, with links, in the docs.

## Code style

TypeScript strict mode, ESLint (`npm run lint`), and small modules with comments that explain *why*. Avoid new runtime dependencies unless they clearly pay their way.
