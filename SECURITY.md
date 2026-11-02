# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private vulnerability reporting (*Security → Report a vulnerability*) on this repository. We aim to acknowledge reports within 7 days. DevRelay is an alpha, volunteer-run project with no bug bounty.

## Threat model

DevRelay runs AI agents against your source code on your own machine. Its main risks are agents (or text injected into a repository) causing harmful actions, credentials leaking, and other local or remote web pages driving the local API. The design assumes **repository content, imported documents, diffs and agent output are untrusted**.

## Controls

**Writes and git**
- PM and reviewer roles are read-only (`codex --sandbox read-only`; `claude --permission-mode plan` with read-only tools).
- Code changes require an explicit per-task *execution authorisation*.
- The developer works in a new git worktree under `data/worktrees/`, on a new `devrelay/*` branch created from `baseRef`. Existing branches are never reused.
- A dirty main working tree needs extra approval, and is never modified.
- The git wrapper blocks `push`, `merge`, `rebase`, `reset`, `checkout`, `clean`, `stash`, `rm`, `commit`, `config`, `remote`, `fetch`, `pull` and `--force`/`-D`/`--hard`. DevRelay itself only runs read commands and `worktree add -b`. (The developer agent may `git add`/`git commit` on its own task branch.)
- There is no automatic merge, push, release, deploy, or branch/worktree deletion.

**Process execution**
- Subprocesses run with `shell: false` and argv arrays only. User input is never a command line, and test commands are validated argv arrays with no shell metacharacters in the program name.
- Working directories are checked: registered repo roots (verified with git) and hub-created worktrees only.
- Timeouts (≤ 60 min), stdout/stderr byte caps, a global concurrency cap (2), and process-tree termination on cancel or timeout.
- Claude runs with `--restricted`, which ignores repository, user and local settings files and confines file tools to the worktree, plus `--permission-prompts none` and an explicit tool allow-list. **Never** `--dangerously-skip-permissions`.

**Credentials and privacy**
- DevRelay never reads, stores, proxies or logs provider credentials. CLIs authenticate themselves.
- API-key environment variables are stripped from child processes. CLIs reporting API-key auth are blocked from automation.
- Secrets matching common patterns are redacted from persisted messages, run logs, errors and previews.
- The database, transcripts, handoff files, worktrees and `.env*` are git-ignored.
- There is no telemetry, and the Next.js server runs with `poweredByHeader: false`.

**Local web server**
- The server binds to `127.0.0.1` only.
- Requests with a non-loopback `Host` header are rejected, which protects against DNS rebinding.
- Mutations require the `x-devrelay: 1` header (cross-site pages can't send it without a CORS preflight, which is never granted) and a loopback `Origin` when one is present.

## Known limitations

- Redaction is pattern-based and best-effort. Don't put secrets in task descriptions.
- With `claude-cli`, the developer agent can run the allowed `git` subcommands and your configured test command. Your test suite itself runs with your user's permissions.
- Prompt injection from repository content can't be fully prevented. It is mitigated by tool restrictions, read-only roles, worktree isolation and human gates.
- There is no authentication between local processes: any program running as your OS user can call the local API.
