import type { z } from "zod";
import type { AgentRole } from "../schemas";
import type { ErrorKind } from "../util";

/** Built-in ids are "codex", "claude-cli", "claude-manual", "mock"; adapters may register more. */
export type ProviderId = string;

export type WorkflowRole = "pm" | "developer" | "reviewer";

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** local-cli: vendor CLI run locally with the user's own login. manual: human runs the tool. api: HTTP API adapter. */
  kind: "local-cli" | "manual" | "mock" | "api";
  /** own-login: user's own subscription/login via the vendor's official flow. api-metered: pay-per-use. */
  billing: "own-login" | "api-metered" | "none";
  roles: WorkflowRole[];
  /** May this provider be given workspace-write access (developer role)? */
  writeCapable: boolean;
  /** Returns null when the provider cannot be invoked automatically (manual / disabled). */
  create(): StructuredAgent | null;
  status(): Promise<ProviderStatus>;
}

export interface AgentRequestMeta {
  taskId: string;
  projectId: string;
  request: string;
  round: number;
  /** Mock-only scenario hints are derived from the request text. */
  [k: string]: unknown;
}

export interface AgentRequest<T> {
  role: AgentRole;
  prompt: string;
  schema: z.ZodType<T>;
  /** Directory the agent runs in (repo root for PM, worktree for dev/review). Always pre-validated. */
  cwd: string;
  timeoutMs: number;
  signal: AbortSignal;
  /** Read-only roles (PM, reviewer) must never be given write access. */
  access: "read-only" | "workspace-write";
  model?: string | null;
  meta: AgentRequestMeta;
}

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export type AgentOutcome<T> =
  | { ok: true; value: T; raw: string; usage?: ProviderUsage; durationMs: number; stderr?: string }
  | { ok: false; errorKind: ErrorKind; error: string; raw?: string; stderr?: string; durationMs: number; exitCode?: number | null };

export interface StructuredAgent {
  readonly id: ProviderId;
  run<T>(req: AgentRequest<T>): Promise<AgentOutcome<T>>;
}

export interface ProviderStatus {
  id: ProviderId;
  label: string;
  installed: boolean;
  version: string | null;
  authenticated: boolean | null;
  authMethod: string | null;
  /** Can DevRelay invoke this provider automatically right now? */
  automationAllowed: boolean;
  notes: string[];
  error?: string;
}
