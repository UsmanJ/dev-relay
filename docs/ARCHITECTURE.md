# Architecture

DevRelay is a single Node.js process: a Next.js app serving the dashboard and a JSON API on `127.0.0.1`, plus a CLI that uses the same core library. State lives in one SQLite file under `data/`, which is git-ignored.

```
src/
  core/                    framework-free engine (used by the CLI, the API and the tests)
    schemas.ts             Zod protocol: TaskSpecification, AcceptanceCriterion, TechnicalQuestion,
                           TechnicalDecision, ImplementationResult, ReviewResult, AgentMessage, ApprovalRequest
    state.ts               task state machine (all legal transitions, revision-limit rule)
    orchestrator.ts        PM → developer → reviewer workflow, human decisions, pause/resume/cancel
    jobs.ts                one job per task, global concurrency cap, AbortController cancellation
    prompts.ts             compact context assembly + role prompts + developer TASK.md
    git.ts                 repo verification, worktree creation, diff capture (no destructive ops)
    process.ts             shell-free subprocess runner (timeouts, caps, tree-kill, .cmd shim resolution)
    redact.ts              secret redaction for everything persisted or displayed
    repo.ts                data access (Drizzle/SQLite), project settings, approvals, provider runs
    providers/             registry + adapters (codex, claude-cli, claude-manual, mock)
    db/                    Drizzle schema + client (migrations in /drizzle)
  app/                     Next.js App Router: pages + /api route handlers (localhost guard in api/_lib.ts)
  components/              React client components (dashboard)
  cli/index.ts             `npm run relay -- …`
tests/                     Vitest: unit + mock-provider integration (no network)
```

## Task lifecycle

```
draft ─► pm_running ─► spec_review ──(human approves)──► spec_approved
                          ▲   │ (feedback → redraft)          │ (execution authorised)
                          │   └───────────────────────────────┤
                          │                       ┌───────────┴─────────────┐
                          │                 dev_running              awaiting_dev_result
                          │                 (automated)              (manual handoff)
                          │                       └──────────┬──────────────┘
                          │                            review_pending
                          │                                  │
                          │                            review_running
                          │            ┌─────────────────────┼─────────────────────────┐
                          │       APPROVED            CHANGES_REQUESTED        HUMAN_DECISION_REQUIRED
                          │            │              round < max? ─ yes ─► changes_requested ─► (developer again)
                          │            │                   │ no                         │
                          │            ▼                   ▼                            ▼
                          │  awaiting_merge_approval   human_decision_required ◄────────┘
                          └──── respec ◄───────────────────┘   (grant revision · accept · re-review · reject)
                               awaiting_merge_approval ─► completed (human; DevRelay does NOT merge)
any non-terminal ─► paused / cancelled;  running step error ─► failed (retry returns to the step's stable state)
```

- Every status change goes through `transitionTask`. It validates the transition, guards against races (`expectedFrom`), and writes an audit row to `transitions`.
- Automatic steps chain only from a step the user started, and only while `autoAdvance` is on. The revision limit (default 2, ceiling 5) makes the developer↔reviewer loop finite. A human can grant extra rounds one at a time.
- `auth`, `usage_limit`, `malformed_output`, `timeout` and provider errors move the task to `failed`, with no automatic retry. The UI explains each kind.
- On server start, steps left "running" by a crash are marked failed, and you can retry them (`recoverInterrupted`).

## Evidence, not claims

After the developer finishes, DevRelay itself:
1. captures `git diff <baseCommit>`, commits on the branch, and untracked files, from the worktree;
2. runs the configured test command (an argv array, no shell) if the project allows it;
3. gives the reviewer the spec, the developer's report (labelled *unverified*), and DevRelay's evidence (labelled *authoritative*).

An `APPROVED` verdict that lists any criterion as `not_met` is downgraded to `HUMAN_DECISION_REQUIRED`.

## Context management

Each prompt is rebuilt from:
- project fields written by the user (goals, requirements, architecture, constraints, instructions),
- the machine-generated summary of completed work (stored separately from the instructions),
- the 15 most recent accepted technical decisions,
- imported context documents (capped at 20k characters), and
- the current task state: spec, the latest review feedback, and the previous summary.

Full conversation histories are never replayed. Developer decisions become project decisions when a task is accepted.

## Data model (SQLite)

`projects`, `context_docs`, `decisions`, `tasks`, `transitions`, `messages` (every agent and human interaction, with role, provider, round, payload and git refs), `approvals`, `provider_runs` (duration, usage, error kind, redacted excerpts), `settings`.

## Portability

- Paths use `node:path`. Windows `.cmd` npm shims are resolved to their real `.exe` or `.js` targets, because Node will not spawn `.cmd` files without a shell. POSIX uses process groups for tree-kill, and Windows uses `taskkill /T`.
- The CI workflow targets Windows, Ubuntu and macOS.
