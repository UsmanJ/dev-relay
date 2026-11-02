/**
 * Claude Code adapters.
 *
 * DEFAULT: "claude-cli" — the hub runs the official, unmodified `claude` binary
 * in print mode (`claude -p`) inside an isolated worktree. Claude Code uses its
 * OWN stored login; the hub never reads, stores or passes any token.
 *
 * Compliance basis (verified 2026-11-02):
 *  - support.claude.com/en/articles/15036540: "when you're signed in with your
 *    Claude plan, the Claude Agent SDK and `claude -p` still draw from your
 *    subscription limits."
 *  - code.claude.com/docs/en/legal-and-compliance: third parties may not offer
 *    Claude.ai login or route OTHER users' requests through plan credentials, and
 *    may not collect/intermediate tokens — but this "does not prevent an end user
 *    from signing in to the unmodified Claude Code binary with their own Claude
 *    subscription". DevRelay is a personal, local, single-user tool.
 *  - Advertised plan limits assume "ordinary, individual usage"; the hub keeps
 *    runs user-initiated, bounded (revision limit, timeouts, concurrency) and
 *    never loops autonomously.
 *
 * Safety: `--restricted` (ignores user/project/local settings files from the
 * untrusted repo, confines file tools to the worktree, refuses bypassPermissions),
 * `--permission-mode acceptEdits`, `--permission-prompts none` (anything that would
 * prompt is denied), an explicit tool allow-list and NO --dangerously-skip-permissions.
 *
 * FALLBACK: "claude-manual" — the hub writes a task package and you run Claude
 * Code yourself, then ingest the result file. Set DEVRELAY_DISABLE_CLAUDE_CLI=1
 * to forbid automated invocation entirely.
 */
import { resolveCommand, runProcess, subscriptionEnv, type ResolvedCommand } from "../process";
import { parseStructured, toProviderJsonSchema } from "../schemas";
import { redact } from "../redact";
import { classifyProviderError } from "./classify";
import type { AgentOutcome, AgentRequest, ProviderStatus, StructuredAgent } from "./types";

export function resolveClaude(): ResolvedCommand | null {
  return resolveCommand(process.env.DEVRELAY_CLAUDE_BIN?.trim() || "claude");
}

export function claudeCliEnabled(): boolean {
  return process.env.DEVRELAY_DISABLE_CLAUDE_CLI !== "1";
}

const READ_TOOLS = ["Read", "Glob", "Grep"];
const WRITE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep"];
const GIT_RULES = ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)", "Bash(git add*)", "Bash(git commit*)"];

/** Build the exact argv for an automated developer run. Exported for tests. */
export function buildClaudeArgs(opts: { access: "read-only" | "workspace-write"; schemaJson: string; model?: string | null; testCommand?: string[] | null }): string[] {
  const write = opts.access === "workspace-write";
  const allowRules = write ? [...GIT_RULES] : ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)"];
  if (write && opts.testCommand?.length) {
    // Exact-prefix rule for the project's configured test command only.
    allowRules.push(`Bash(${opts.testCommand.join(" ").replace(/[()]/g, "")}*)`);
  }
  const args = [
    "-p",
    "--restricted",
    "--output-format",
    "json",
    "--json-schema",
    opts.schemaJson,
    "--permission-mode",
    write ? "acceptEdits" : "plan",
    "--permission-prompts",
    "none",
    "--tools",
    [...(write ? WRITE_TOOLS : READ_TOOLS), "Bash"].join(","),
    "--allowed-tools",
    ...allowRules,
    "--no-session-persistence",
  ];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

export class ClaudeCliAgent implements StructuredAgent {
  readonly id = "claude-cli" as const;

  async run<T>(req: AgentRequest<T>): Promise<AgentOutcome<T>> {
    const started = Date.now();
    if (!claudeCliEnabled()) {
      return { ok: false, errorKind: "permission", error: "Automated Claude invocation is disabled (DEVRELAY_DISABLE_CLAUDE_CLI=1). Use the manual handoff.", durationMs: 0 };
    }
    const cmd = resolveClaude();
    if (!cmd) return { ok: false, errorKind: "provider_unavailable", error: "Claude Code CLI not found on PATH.", durationMs: 0 };
    const testCommand = Array.isArray(req.meta.testCommand) ? (req.meta.testCommand as string[]) : null;
    const args = buildClaudeArgs({ access: req.access, schemaJson: JSON.stringify(toProviderJsonSchema(req.schema)), model: req.model, testCommand });
    const res = await runProcess({ command: cmd, args, cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, env: subscriptionEnv() });
    const durationMs = Date.now() - started;
    const stderr = redact(res.stderr).slice(-4000);
    if (res.cancelled) return { ok: false, errorKind: "cancelled", error: "Cancelled by user.", durationMs, stderr };
    if (res.timedOut) return { ok: false, errorKind: "timeout", error: `Claude timed out after ${Math.round(req.timeoutMs / 1000)}s.`, durationMs, stderr };
    if (res.spawnError) return { ok: false, errorKind: "provider_unavailable", error: res.spawnError, durationMs };
    return interpretClaudeEnvelope(res.stdout, res.exitCode, res.stderr, req.schema, durationMs);
  }
}

/** Parse `claude -p --output-format json` output. Exported for tests. */
export function interpretClaudeEnvelope<T>(stdout: string, exitCode: number | null, rawStderr: string, schema: import("zod").ZodType<T>, durationMs: number): AgentOutcome<T> {
  const stderr = redact(rawStderr).slice(-4000);
  let envelope: Record<string, unknown> | null = null;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    /* handled below */
  }
  if (exitCode !== 0 || !envelope || envelope.is_error === true || (envelope.subtype && envelope.subtype !== "success")) {
    const text = `${envelope?.result ?? ""} ${envelope?.subtype ?? ""} ${envelope?.api_error_status ?? ""}\n${rawStderr || (envelope ? "" : stdout)}`.trim();
    return { ok: false, errorKind: classifyProviderError(text), error: redact(text).slice(0, 2000) || `claude exited ${exitCode}`, durationMs, stderr, exitCode, raw: redact(stdout).slice(0, 2000) };
  }
  const structured = envelope.structured_output;
  const raw = structured !== undefined && structured !== null ? JSON.stringify(structured) : String(envelope.result ?? "");
  const parsed = parseStructured(schema, raw);
  if (!parsed.ok) return { ok: false, errorKind: "malformed_output", error: parsed.error, raw: redact(raw).slice(0, 4000), durationMs, stderr };
  const u = (envelope.usage ?? {}) as Record<string, number>;
  const denials = Array.isArray(envelope.permission_denials) ? envelope.permission_denials.length : 0;
  return {
    ok: true,
    value: parsed.value,
    raw,
    durationMs,
    stderr: denials ? `${denials} tool call(s) were denied by the permission policy.\n${stderr}` : stderr,
    usage: { inputTokens: u.input_tokens, cachedInputTokens: u.cache_read_input_tokens, outputTokens: u.output_tokens },
  };
}

/** Variables that would make CLIs bill an API account instead of the subscription. */
export const BILLING_ENV_VARS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

export function detectBillingEnvVars(env: Record<string, string | undefined> = process.env): string[] {
  return BILLING_ENV_VARS.filter((k) => (env[k] ?? "").trim() !== "");
}

/**
 * Uses `claude auth status --json` run with the SAME sanitised environment the
 * hub uses for real runs. Only non-identifying fields (loggedIn, authMethod,
 * subscriptionType) are kept — email/org are discarded.
 */
export async function claudeStatus(): Promise<ProviderStatus> {
  const status: ProviderStatus = { id: "claude-cli", label: "Claude Code CLI", installed: false, version: null, authenticated: null, authMethod: null, automationAllowed: false, notes: [] };
  const cmd = resolveClaude();
  if (!cmd) {
    status.notes.push("Claude Code not found on PATH. Install it and run `claude` once to sign in with your Claude plan.");
    return status;
  }
  status.installed = true;
  const cwd = process.cwd();
  const v = await runProcess({ command: cmd, args: ["--version"], cwd, timeoutMs: 30_000, env: subscriptionEnv() });
  status.version = v.stdout.trim() || null;
  const s = await runProcess({ command: cmd, args: ["auth", "status", "--json"], cwd, timeoutMs: 30_000, env: subscriptionEnv() });
  let method: string | undefined;
  try {
    const j = JSON.parse(s.stdout) as { loggedIn?: boolean; authMethod?: string; subscriptionType?: string; apiProvider?: string };
    status.authenticated = j.loggedIn === true;
    method = j.authMethod;
    status.authMethod = [j.authMethod, j.subscriptionType, j.apiProvider && j.apiProvider !== "firstParty" ? j.apiProvider : null].filter(Boolean).join(" / ") || null;
    if (j.apiProvider && j.apiProvider !== "firstParty") {
      status.notes.push(`Claude Code is configured for ${j.apiProvider} (billed by that provider). Automation blocked.`);
      method = "third-party";
    }
  } catch {
    status.authenticated = null;
    status.error = redact(s.stderr || s.stdout).slice(0, 300);
  }
  if (!claudeCliEnabled()) {
    status.notes.push("Automated invocation disabled by DEVRELAY_DISABLE_CLAUDE_CLI=1 — manual handoff only.");
  } else if (status.authenticated && method === "claude.ai") {
    status.automationAllowed = true;
    status.notes.push("Signed in with your Claude plan: automated `claude -p` runs draw from your subscription limits (no API billing).");
  } else if (status.authenticated) {
    status.notes.push(`Auth method "${method}" is not a Claude subscription login. Automation blocked to avoid API charges; run \`claude auth login\` with your Claude account.`);
  } else {
    status.notes.push("Not logged in. Run `claude` and sign in with your Claude plan.");
  }
  status.notes.push("Fallback: manual handoff (you run Claude Code yourself; the hub ingests the result).");
  return status;
}
