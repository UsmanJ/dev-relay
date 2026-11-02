# DevRelay

**A local-first, multi-agent software development orchestrator.** DevRelay coordinates a *product manager*, a *developer* and a *code reviewer*. Each role is filled by an AI coding tool you already have installed and signed in to. DevRelay keeps project context, stops for your approval at every important step, and never merges, pushes or deploys.

> **Status: alpha (v0.1.0-alpha.1).** Windows 11 is the tested platform. macOS and Linux are supported by design, and a CI workflow for all three is included, but it has not run yet.
> DevRelay is an independent open-source project. It is **not** an official OpenAI or Anthropic product, and it is not affiliated with or endorsed by either company.

```
 you ──► PM agent ──► spec ──► you approve ──► developer agent ──► diff + tests ──► reviewer agent
  ▲      (e.g. Codex)                          (e.g. Claude Code,      (captured by       (e.g. Codex,
  │                                             isolated worktree)      DevRelay itself)    read-only)
  └──────────── APPROVED → you decide · CHANGES_REQUESTED → developer (bounded rounds) · HUMAN_DECISION → you
```

## Why

If you use one AI tool as your PM and another as your developer, you end up copying requirements, questions, diffs and reviews between them by hand. DevRelay automates that relay locally:

- **Structured hand-offs.** Specs, implementation reports and reviews are Zod-validated JSON. Malformed agent output is rejected.
- **Evidence over claims.** The reviewer sees the git diff and test results that *DevRelay* captured, not just the developer's say-so.
- **Bounded automation.** There is a maximum number of revision rounds (default 2), and DevRelay stops immediately on auth errors, usage limits or validation failures. Nothing loops forever.
- **Human gates.** You approve the spec, authorise code changes, and make the final merge decision.
- **Project memory.** Per-project goals, constraints and instructions are kept, plus decisions captured from completed tasks. Agents get compact context, not whole chat histories.
- **Bring your own provider.** DevRelay runs the official CLIs you installed, with your own login. It never sees, stores or forwards credentials.

## Requirements

- Node.js **20.9+** (22 or 24 recommended) and npm
- Git (Git for Windows on Windows)
- At least one supported agent CLI, *or* nothing at all for the offline mock demo:
  - [OpenAI Codex CLI](https://developers.openai.com/codex) signed in with your ChatGPT account (PM / reviewer roles)
  - [Claude Code](https://code.claude.com/docs) signed in with your Claude account (developer role; can also do PM / reviewer)

No API keys, Docker or cloud services are required.

## Quickstart (Windows PowerShell)

```powershell
git clone <your-fork-or-the-repo-url> devrelay
cd devrelay
npm install

# 1. Offline demo: full PM -> developer -> reviewer cycle with mock agents (no AI calls)
npm run demo

# 2. Check which real providers are installed and signed in
npm run doctor

# 3. Start the dashboard (http://127.0.0.1:3210)
npm run build
npm start          # or: npm run dev
```

macOS/Linux: use the same commands in your shell.

### Connect the real CLIs (optional)

Each person installs and signs in to their own tools using the vendor's official flow:

```powershell
npm install -g @openai/codex
codex login                 # choose "Sign in with ChatGPT"

# Claude Code: install per https://code.claude.com/docs, then:
claude                      # sign in with your Claude account once, then exit
claude auth status          # should show "authMethod": "claude.ai"

npm run doctor              # both should show "automation allowed: true"
```

If a CLI is not on your `PATH`, point DevRelay at it in `.env.local` (see `.env.example`).

### Run a real cycle on a throwaway sample repo

```powershell
npm run demo -- --real
```

This creates a tiny sample library under `data/samples/` and runs the whole loop against it. Codex drafts the spec, Claude Code implements it in an isolated worktree, DevRelay runs `node --test`, and Codex reviews the result. It uses your own subscriptions' usage, and stops before any merge.

## Using it with your own projects

1. In the dashboard, click **Register project** and enter the absolute path to the **repository root**. DevRelay verifies it with git first. It never clones, and it never touches a repo you haven't registered.
2. Fill in goals, constraints and project instructions. Optionally import notes as Markdown or text (for example, a summary you exported from a ChatGPT conversation). DevRelay **cannot** read your ChatGPT history itself.
3. Set a test command (e.g. `npm test`) and tick *allow test execution* if you want DevRelay to verify tests itself.
4. Describe a feature or bug, and the PM drafts a spec.
5. Edit or approve the spec and **authorise execution**. The developer works on a new branch `devrelay/<slug>-<id>` in a worktree under `data/worktrees/`.
6. Read the reviewer's verdict and the captured diff, then merge it yourself if you agree.

There is a CLI for everything, too: `npm run relay -- help`. See [docs/REGISTERING-PROJECTS.md](docs/REGISTERING-PROJECTS.md).

## What is automatic and what needs you

| Step | Automatic? |
|---|---|
| PM drafts / redrafts the spec | ✅ when you submit a request or send feedback |
| Approving the spec | 🧑 always you |
| Authorising code changes (per task) | 🧑 always you |
| Creating the isolated worktree and branch | ✅ after authorisation (dirty main repo → asks you) |
| Developer implementation (`claude-cli`) | ✅ unattended `claude -p` with a restricted tool policy |
| Developer implementation (`claude-manual` fallback) | 🧑 you run Claude Code yourself; DevRelay ingests the result |
| Capturing the diff and running tests | ✅ (tests only if you enabled them) |
| Review and the revision loop | ✅ up to *max revisions*, then it stops and asks you |
| Merge / push / deploy / delete branches | ❌ never; you do this yourself |

## Providers and subscriptions

DevRelay's engine is provider-neutral. Roles are filled by adapters from a registry ([src/core/providers](src/core/providers)):

| Adapter | Roles | How it runs | Billing |
|---|---|---|---|
| `codex` | PM, reviewer | `codex exec --sandbox read-only --output-schema …` | your ChatGPT plan's Codex limits |
| `claude-cli` | PM, developer, reviewer | `claude -p --restricted --permission-mode acceptEdits --permission-prompts none …` | your Claude plan's limits |
| `claude-manual` | developer | you run Claude Code; DevRelay writes the task file and ingests `RESULT.json` | your Claude plan |
| `mock` | all | built-in, offline, deterministic | none |

API-key and pay-as-you-go environment variables (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, …) are **stripped** from every child process, and DevRelay refuses to run a CLI that reports API-key authentication. Read [docs/PROVIDERS.md](docs/PROVIDERS.md) for each vendor's authentication terms and how we interpret them. Check those terms for your own situation.

## Security model, in short

Read-only by default, explicit approval before writes, isolated worktrees, no shell (argv-only subprocesses), a localhost-only server with DNS-rebinding and CSRF guards, secret redaction, timeouts, output caps, a concurrency limit, process-tree kill on cancel, and no telemetry. Repository content is treated as untrusted. Details: [SECURITY.md](SECURITY.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, task lifecycle, data model
- [docs/PROVIDERS.md](docs/PROVIDERS.md): adapters, authentication and compliance notes, writing a new adapter
- [docs/REGISTERING-PROJECTS.md](docs/REGISTERING-PROJECTS.md): registering repos, settings, the CLI
- [docs/adr/](docs/adr): architecture decision records
- [CHANGELOG.md](CHANGELOG.md): release notes and known limitations
- [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md)

## Development

```powershell
npm run typecheck
npm run lint
npm test             # unit + mock-provider integration tests (no network)
npm run build
npm run verify       # all of the above
```

## License

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for trademark attributions.
