# ADR 0003: Automated Claude Code by default, manual handoff as fallback

- Status: accepted (2026-11-02), amended for public release (see "Amendment" below).

## Context
The first review of Anthropic's Legal & Compliance page found that OAuth is meant for "ordinary use of Claude Code". It was unclear whether a local orchestrator invoking `claude -p` counts as ordinary use, so the initial default was a manual handoff. Anthropic's support article "Use the Claude Agent SDK with your Claude plan" then confirmed that, when signed in with a plan, "the Claude Agent SDK and `claude -p` still draw from your subscription limits". The Legal page also explicitly allows an end user "signing in to the unmodified Claude Code binary with their own Claude subscription". What it prohibits is third parties routing *other users'* requests through plan credentials, or intermediating tokens.

## Decision
- The default developer adapter is `claude-cli`: the user's own unmodified binary, in print mode, inside an isolated worktree. It uses `--restricted`, `--permission-mode acceptEdits` and `--permission-prompts none` with an explicit tool allow-list, and never skips permissions.
- Automation is allowed only when `claude auth status` reports `claude.ai` first-party auth in the sanitised environment.
- `claude-manual` remains available. `DEVRELAY_DISABLE_CLAUDE_CLI=1` forbids automated runs.

## Consequences
- A fully automated PM → developer → reviewer loop works without API charges. It was verified on 2026-11-02 with a sample repository.
- Runs count against the user's plan limits. Usage-limit errors stop the workflow rather than being retried.
## Amendment (2026-11-02, public release)
For public users, the default developer is the **manual handoff** (`claude-manual`). Automated `claude-cli` execution requires a one-time, versioned acknowledgement (`src/core/claudeAck.ts`). With it, users confirm that they use their own officially authenticated Claude installation, comply with the applicable terms, and run DevRelay only for themselves. The acknowledgement does not override provider restrictions. The adapter checks it both in preflight and at invocation time. `DEVRELAY_DISABLE_CLAUDE_CLI=1` and `DEVRELAY_OFFLINE=1` still take precedence. Public CI runs offline only.
