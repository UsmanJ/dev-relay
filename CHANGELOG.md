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

### Known limitations
- Windows 11 is the only platform tested so far. The CI workflow targets Windows, Linux and macOS, but it has not run yet (the repository is not published).
- The real-provider path has been verified on one machine (codex-cli 0.166.0 with ChatGPT login, Claude Code 2.1.316 with Pro login) against the bundled sample repo only. Larger repositories, long-running tasks and usage-limit messages from real CLIs are untested. Error classification relies on message text.
- `claude-cli` in read-only roles (PM/reviewer via `--permission-mode plan`) has not been exercised end-to-end.
- The developer agent can only run allow-listed `git` commands and the configured test command. Builds, installs and other tooling are denied, which can limit what it can verify itself.
- Background jobs run inside the server or CLI process. Driving the same task from the CLI and the dashboard at the same time is not supported.
- There is no authentication on the local API beyond loopback, header and origin checks.
- Worktrees and branches are never cleaned up automatically.
- The single-user, local-only design is intentional: hosting DevRelay for others is unsupported and conflicts with subscription terms.
