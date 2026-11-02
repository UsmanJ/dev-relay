/**
 * Codex CLI adapter (OpenAI). Uses the documented non-interactive mode:
 *
 *   codex exec --json --sandbox read-only --ephemeral --color never
 *              -C <dir> --output-schema <file> -o <file> [-m model] -
 *
 * with the prompt on stdin. Authentication is whatever the user configured with
 * `codex login` (ChatGPT sign-in). API-key environment variables are stripped
 * from the child environment so the hub can never silently bill an API key.
 * Flags were validated against codex-cli 0.166.0 `codex exec --help`.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCommand, runProcess, subscriptionEnv, type ResolvedCommand } from "../process";
import { dataDir } from "../config";
import { parseStructured, toProviderJsonSchema } from "../schemas";
import { newId } from "../util";
import { redact } from "../redact";
import { classifyProviderError } from "./classify";
import type { AgentOutcome, AgentRequest, ProviderStatus, ProviderUsage, StructuredAgent } from "./types";

export function resolveCodex(): ResolvedCommand | null {
  return resolveCommand(process.env.DEVRELAY_CODEX_BIN?.trim() || "codex");
}

interface CodexEventSummary {
  usage?: ProviderUsage;
  errors: string[];
  threadId?: string;
}

/** Parse the JSONL event stream (`thread.started`, `turn.completed`, `turn.failed`, `error`, `item.*`). */
export function summariseCodexEvents(stdout: string): CodexEventSummary {
  const summary: CodexEventSummary = { errors: [] };
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const type = String(ev.type ?? "");
    if (type === "thread.started" && typeof ev.thread_id === "string") summary.threadId = ev.thread_id;
    if (type === "turn.completed" && ev.usage && typeof ev.usage === "object") {
      const u = ev.usage as Record<string, number>;
      summary.usage = {
        inputTokens: u.input_tokens,
        cachedInputTokens: u.cached_input_tokens,
        outputTokens: u.output_tokens,
        reasoningTokens: u.reasoning_output_tokens,
      };
    }
    if (type === "turn.failed" || type === "error") {
      const err = (ev.error ?? ev.message ?? ev) as unknown;
      summary.errors.push(typeof err === "string" ? err : JSON.stringify(err));
    }
  }
  return summary;
}

export class CodexAgent implements StructuredAgent {
  readonly id = "codex" as const;

  async run<T>(req: AgentRequest<T>): Promise<AgentOutcome<T>> {
    const started = Date.now();
    if (req.access !== "read-only") {
      return { ok: false, errorKind: "permission", error: "The Codex adapter is only used for read-only roles (PM, reviewer).", durationMs: 0 };
    }
    const cmd = resolveCodex();
    if (!cmd) {
      return { ok: false, errorKind: "provider_unavailable", error: "Codex CLI not found. Install with: npm install -g @openai/codex, then run: codex login", durationMs: 0 };
    }
    const tmp = path.join(dataDir(), "tmp", newId("codex"));
    fs.mkdirSync(tmp, { recursive: true });
    const schemaFile = path.join(tmp, "schema.json");
    const outFile = path.join(tmp, "last-message.json");
    fs.writeFileSync(schemaFile, JSON.stringify(toProviderJsonSchema(req.schema), null, 2));

    const args = ["exec", "--json", "--sandbox", "read-only", "--ephemeral", "--color", "never", "-C", req.cwd, "--output-schema", schemaFile, "-o", outFile];
    if (req.model) args.push("-m", req.model);
    args.push("-");

    try {
      const res = await runProcess({ command: cmd, args, cwd: req.cwd, input: req.prompt, timeoutMs: req.timeoutMs, signal: req.signal, env: subscriptionEnv() });
      const events = summariseCodexEvents(res.stdout);
      const stderr = redact(res.stderr).slice(-4000);
      const durationMs = Date.now() - started;
      if (res.cancelled) return { ok: false, errorKind: "cancelled", error: "Cancelled by user.", durationMs, stderr };
      if (res.timedOut) return { ok: false, errorKind: "timeout", error: `Codex timed out after ${Math.round(req.timeoutMs / 1000)}s.`, durationMs, stderr };
      if (res.spawnError) return { ok: false, errorKind: "provider_unavailable", error: `Failed to start Codex: ${res.spawnError}`, durationMs };
      if (res.stdoutTruncated) return { ok: false, errorKind: "provider_error", error: "Codex output exceeded the size limit.", durationMs, stderr };

      const errorText = [...events.errors, res.exitCode !== 0 ? res.stderr : ""].join("\n").trim();
      if (res.exitCode !== 0 || events.errors.length > 0) {
        return { ok: false, errorKind: classifyProviderError(errorText), error: redact(errorText).slice(0, 2000) || `Codex exited with code ${res.exitCode}`, durationMs, stderr, exitCode: res.exitCode };
      }
      const raw = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : "";
      const parsed = parseStructured(req.schema, raw);
      if (!parsed.ok) return { ok: false, errorKind: "malformed_output", error: parsed.error, raw: redact(raw).slice(0, 4000), durationMs, stderr };
      return { ok: true, value: parsed.value, raw, usage: events.usage, durationMs, stderr };
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/** Detect installation & login without reading credential files (asks the CLI itself). */
export async function codexStatus(): Promise<ProviderStatus> {
  const status: ProviderStatus = { id: "codex", label: "Codex CLI (OpenAI)", installed: false, version: null, authenticated: null, authMethod: null, automationAllowed: false, notes: [] };
  const cmd = resolveCodex();
  if (!cmd) {
    status.notes.push("Not found on PATH. Install: npm install -g @openai/codex  — then: codex login (choose 'Sign in with ChatGPT').");
    return status;
  }
  status.installed = true;
  const cwd = process.cwd();
  const v = await runProcess({ command: cmd, args: ["--version"], cwd, timeoutMs: 30_000, env: subscriptionEnv() });
  status.version = v.stdout.trim() || null;
  const s = await runProcess({ command: cmd, args: ["login", "status"], cwd, timeoutMs: 30_000, env: subscriptionEnv() });
  const text = `${s.stdout}\n${s.stderr}`.trim();
  if (s.exitCode === 0 && /chatgpt/i.test(text)) {
    status.authenticated = true;
    status.authMethod = "chatgpt";
    status.automationAllowed = true;
    status.notes.push("Signed in with ChatGPT: runs count against your ChatGPT plan's Codex usage limits. No API billing.");
  } else if (s.exitCode === 0 && /api key/i.test(text)) {
    status.authenticated = true;
    status.authMethod = "api-key";
    status.automationAllowed = false;
    status.notes.push("Codex is logged in with an API key (pay-as-you-go). DevRelay refuses to run it to avoid extra cost. Run `codex logout` then `codex login` with ChatGPT.");
  } else {
    status.authenticated = false;
    status.notes.push("Not logged in. Run: codex login");
  }
  status.error = s.exitCode === 0 ? undefined : redact(text).slice(0, 500);
  return status;
}
