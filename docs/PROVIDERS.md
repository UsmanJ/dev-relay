# Providers, authentication and compliance

DevRelay never implements its own login to any AI service. Every provider is a tool **you** install and sign in to through the vendor's official flow. DevRelay only spawns that tool's unmodified binary on your machine.

> This document records how DevRelay's maintainers read each vendor's public terms on **2026-11-02**. It is not legal advice. Terms change, so check the linked sources for your own situation (personal vs. team plans, employer policies, etc.).

## Billing classes (kept separate by design)

| Class | Meaning | Shipped adapters |
|---|---|---|
| `own-login` | A local CLI signed in by the user, with usage counted against the user's own plan | `codex`, `claude-cli` |
| `none` | No AI usage, or the human runs the tool | `mock`, `claude-manual` |
| `api-metered` | Pay-per-use API keys | *none shipped*; blocked unless `DEVRELAY_ALLOW_METERED_PROVIDERS=1` |

Hosted or multi-user deployments are **out of scope** for the `own-login` adapters (see "Not permitted" below). Any future API-backed or hosted integration must be a separate adapter in the `api-metered` class, with its own documentation.

### Guards against accidental charges

- These variables are removed from every child process environment: `OPENAI_API_KEY`, `CODEX_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`. `npm run doctor` and the Providers page warn if any billing-related variable is set, including `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX` and `CLAUDE_CODE_USE_FOUNDRY`.
- Before automating, DevRelay asks each CLI for its auth status **in the same sanitised environment**. Codex must report a ChatGPT login, and Claude Code must report `authMethod: "claude.ai"` with the `firstParty` provider. Any other result blocks automation.
- DevRelay never reads credential files such as `~/.codex/auth.json` or `~/.claude`. It only runs `codex login status` and `claude auth status --json`, and it discards identifying fields like email and organisation.

## OpenAI Codex CLI (`codex`)

- **Install:** `npm install -g @openai/codex`, then `codex login` and choose *Sign in with ChatGPT*.
- **Invocation:** `codex exec --json --sandbox read-only --ephemeral --color never -C <dir> --output-schema <file> -o <file> [-m model] -`, with the prompt on stdin. Flags were validated against `codex exec --help` for codex-cli 0.166.0 and against the [non-interactive mode docs](https://developers.openai.com/codex/noninteractive).
- **Roles:** PM and reviewer only. The adapter refuses `workspace-write`.
- **Terms as we read them:** Codex is included with ChatGPT plans, with plan-dependent usage limits ([help article](https://help.openai.com/en/articles/11369540-codex)). `codex exec` reuses the saved CLI login by default. OpenAI recommends API keys for CI and shared automation. DevRelay runs Codex only on the user's own machine, for steps the user started, so it is not a CI or shared service.
- **Never** substitute the OpenAI API CLI or an API key for the ChatGPT-authenticated Codex CLI.

## Claude Code (`claude-cli`, `claude-manual`)

- **Install:** see <https://code.claude.com/docs>. Run `claude` once and sign in with your Claude account.
- **Automated mode (`claude-cli`, default developer):**
  ```
  claude -p --restricted --output-format json --json-schema <schema>
         --permission-mode acceptEdits --permission-prompts none
         --tools Read,Edit,Write,Glob,Grep,Bash
         --allowed-tools "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)"
                         "Bash(git add*)" "Bash(git commit*)" "Bash(<your test command>*)"
         --no-session-persistence [--model <alias>]
  ```
  The prompt is sent on stdin and the working directory is the task worktree. `--restricted` ignores settings files from the (untrusted) repository and from user/local settings, confines file tools to the working directory, and refuses `bypassPermissions`. Any tool call that would need a permission prompt is denied. DevRelay **never** passes `--dangerously-skip-permissions`. For read-only roles it uses `--permission-mode plan` with only read tools.
- **Verified on:** Claude Code 2.1.316 on Windows 11 with a Pro subscription (claude.ai OAuth). The JSON envelope's `structured_output` field carries the validated result.
- **Terms as we read them:**
  - [Use the Claude Agent SDK with your Claude plan](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan): "when you're signed in with your Claude plan, the Claude Agent SDK and `claude -p` still draw from your subscription limits."
  - [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance): OAuth is for subscribers' "ordinary use of Claude Code and other native Anthropic applications". Third-party developers may not offer Claude.ai login in their own apps, route requests through Free/Pro/Max/Ultra credentials *on behalf of their users*, or collect or intermediate Claude.ai credentials. This "does not prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". Advertised plan limits "assume ordinary, individual usage of Claude Code and the Agent SDK".
  - **Our interpretation:** a single developer running DevRelay locally, which spawns *their own* unmodified `claude` binary signed in with *their own* plan, is ordinary individual use. DevRelay never handles tokens. Runs are user-initiated and bounded by revision limits, timeouts and a concurrency cap.
- **Manual fallback (`claude-manual`):** DevRelay writes `TASK.md` plus a result schema, and shows a command such as `cd "<worktree>"; claude --add-dir "<handoff dir>" "Read …TASK.md and complete the task"`. You run Claude Code interactively, then click **Ingest result**. Use this mode if your plan, employer or jurisdiction calls for a human at the keyboard, or set `DEVRELAY_DISABLE_CLAUDE_CLI=1` to forbid automated runs entirely.

### Not permitted (do not build this on top of DevRelay)

- Hosting DevRelay for other people, so that *their* tasks run on *your* subscription, or the reverse.
- Collecting, copying, proxying or injecting OAuth or session tokens.
- Modifying the vendor binaries, or scraping the ChatGPT or Claude web apps.
- Retrying to get around rate or usage limits. DevRelay stops and reports `usage_limit`.

## Mock (`mock`)

This adapter is deterministic, offline and used by the tests and `npm run demo`. Markers in the request text control it, for example `[mock:changes-once]`, `[mock:always-changes]`, `[mock:human]`, `[mock:malformed:pm]`, `[mock:fail:developer]`, `[mock:usage-limit:reviewer]`, `[mock:auth:pm]`, `[mock:slow]` and `[mock:no-change]`. See [src/core/providers/mock.ts](../src/core/providers/mock.ts).

## Writing a new adapter

1. Implement `StructuredAgent.run(req)` ([types.ts](../src/core/providers/types.ts)). Take `req.prompt`, `req.cwd`, `req.access`, `req.signal` and `req.timeoutMs`, and return `{ ok: true, value }` validated with `req.schema`, or `{ ok: false, errorKind, error }`.
2. Use `runProcess` from `src/core/process.ts`. It never uses a shell, applies timeouts and output caps, and kills the process tree on cancel. Pass `subscriptionEnv()` as the environment if the tool should use its own login.
3. Classify failures with `classifyProviderError` so usage limits and auth errors stop the workflow.
4. Register a `ProviderDescriptor` in `registry.ts`, or call `registerProvider()` with `roles`, `writeCapable`, `billing` and a `status()` that asks the tool itself whether it is installed and authenticated, without reading credential files.
5. Add tests, using `tests/providers.test.ts` as a template, and document the vendor's terms here.
