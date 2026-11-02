# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0-alpha.1] - unreleased (prepared 2026-11-02)

First public alpha.

### Added
- Provider-neutral orchestration engine for PM → developer → reviewer workflows, with a task state machine, audited transitions, bounded revision loop (default 2, max 5), pause/resume/retry/cancel, and crash recovery.
- Zod-validated protocol: `TaskSpecification`, `AcceptanceCriterion`, `TechnicalQuestion`, `TechnicalDecision`, `ImplementationResult`, `ReviewResult`, `AgentMessage`, `ApprovalRequest`.
- Adapters: `codex` (OpenAI Codex CLI, read-only PM/reviewer), `claude-cli` (automated `claude -p`, restricted tool policy), `claude-manual` (human-in-the-loop handoff) and `mock` (offline, scenario-driven).
- Evidence capture: git diff, commits and untracked files from an isolated worktree, plus an optional DevRelay-run test command. The reviewer is told developer claims are unverified.
- Human gates: spec approval, per-task execution authorisation, dirty-tree approval, final merge decision (DevRelay never merges).
- Multi-project support with context fields, Markdown/text context import, captured technical decisions and a completed-work summary.
- SQLite persistence (Drizzle) for projects, tasks, messages, transitions, approvals and provider runs.
- Next.js dashboard on 127.0.0.1: projects, provider status, backlog, spec editor/approval, agent timeline, diff/test/review view, controls, settings.
- CLI (`npm run relay`), `npm run doctor`, `npm run demo [-- --real]`.
- Safety: shell-free subprocesses, timeouts, output caps, concurrency limit, process-tree kill, secret redaction, API-key env stripping, localhost/DNS-rebinding/CSRF guards.
- Docs, ADRs, Apache-2.0 licence, CI (Windows/Linux/macOS).

### Verified before release (2026-11-02, Windows 11, Node 24)
- `npm run verify` (typecheck, lint, offline tests, production build) passes, both in the working copy and in a fresh `git clone` + `npm ci`.
- The real dashboard workflow was driven through browser interactions: project registration, Codex spec, approval with execution authorisation, Claude Code implementation, DevRelay test run and diff, Codex review (APPROVED), and the human accept decision.
- Pause/resume of a running real PM step, and recovery after the server was killed mid-run (the step was marked interrupted, and Retry completed the cycle). No orphaned agent processes were left behind.
- Isolation across two sample repositories: separate branches, worktrees, tasks and decisions, with each repo's main branch untouched.
- A Claude-only configuration (Claude Code as PM, developer and reviewer) completed a real cycle.

### Known limitations
- Windows 11 is the only platform tested so far. The CI workflow targets Windows, Linux and macOS, but it has not run yet (the repository is not published).
- Real-provider runs were verified on one machine (codex-cli 0.166.0 with a ChatGPT login, Claude Code 2.1.316 with a Pro login) against small sample repositories only. Large repositories, long tasks and real usage-limit responses are untested. Error classification relies on message text.
- Vendor terms leave open questions for automated use of personal subscriptions by third-party tools. See "Unresolved questions" in docs/PROVIDERS.md.
- The developer agent can only run allow-listed `git` commands and the configured test command. Builds, installs and other tooling are denied, and `git commit` is sometimes denied, in which case DevRelay reviews the uncommitted changes.
- Background jobs run inside the server or CLI process. Driving the same task from the CLI and the dashboard at the same time is not supported. If the process is killed, the running step must be retried, and partial edits remain in the worktree.
- There is no authentication on the local API beyond loopback, header and origin checks.
- Worktrees and branches are never cleaned up automatically.
- The single-user, local-only design is intentional: hosting DevRelay for others is unsupported and conflicts with subscription terms.

### Changed for public release
- The default developer provider is now the manual Claude Code handoff (`claude-manual`). Automated `claude-cli` execution requires a one-time, versioned acknowledgement (Providers page or `npm run relay -- claude-automation enable --i-acknowledge`). It is checked in preflight and in the adapter, and it never overrides provider restrictions, `DEVRELAY_DISABLE_CLAUDE_CLI=1` or offline mode.
- `DEVRELAY_OFFLINE=1` blocks all non-mock providers and skips provider status checks. Set it in CI and in the test suite.
- Public CI runs offline mock tests only, with no secrets and no provider CLIs.
- Next.js telemetry is disabled for `npm run dev`, `npm run build` and `npm start` (via `scripts/next.mjs`).
- Repository metadata points to https://github.com/UsmanJ/dev-relay.

### Fixed during pre-release validation
- Task page: a long git-command block caused horizontal page overflow on narrow windows.
- Task page: a Pause button was shown on failed tasks (pause is not a valid transition from `failed`).
- `engines.node` raised to `>=20.12` (the CLI uses `process.loadEnvFile`).
- Pinned `better-sqlite3` to 12.11.1, which has prebuilt binaries for Node 22 and 24 on Windows, Linux and macOS. 13.x made npm 10 (bundled with Node 22) try to compile from source, which fails on machines without C++ build tools. Found by the first CI run.
- The provider preflight now reports `DEVRELAY_DISABLE_CLAUDE_CLI=1` explicitly, instead of falling through to a status check. Automation was already blocked; only the reason shown was wrong.
- The Windows `.cmd` shim parser normalises path separators, so it behaves the same on every OS.
- Repository-root verification now compares canonical paths (symlinks, junctions, Windows 8.3 short names, macOS `/var` → `/private/var`). Previously, valid repos reached through such paths were rejected. Found by the first CI run.