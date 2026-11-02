# ADR 0004: Isolated worktrees, evidence-based review, human merge

- Status: accepted (2026-11-02)

## Decision
- Every writable task gets a new branch (`devrelay/<slug>-<id>`) in a new worktree under the data directory, created from `baseRef`. Existing branches are never reused, and the main working tree is never modified.
- After implementation, DevRelay captures the diff and runs the test command itself. The reviewer is told that developer claims are unverified.
- `APPROVED` only moves a task to `awaiting_merge_approval`. A human records the final decision and merges manually. DevRelay never merges, pushes, or deletes branches or worktrees.

## Consequences
- It is safe to run against real repositories, even with uncommitted work (which needs approval).
- Users clean up worktrees and branches themselves. The commands are documented.