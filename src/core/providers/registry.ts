/**
 * Provider registry. The orchestration engine only talks to `StructuredAgent`s
 * obtained from here; it has no knowledge of any specific vendor. New adapters
 * (other CLI agents, or API-backed providers) register a descriptor declaring
 * which roles they can fill, whether they can write code, and how they bill.
 *
 * Billing classes are kept deliberately separate:
 *   - "own-login"    local CLI authenticated by the user via the vendor's official flow
 *   - "api-metered"  pay-per-use API key (none shipped; must be explicitly opted into per project)
 *   - "none"         mock / manual
 */
import { CodexAgent, codexStatus } from "./codex";
import { ClaudeCliAgent, claudeStatus, claudeCliEnabled, detectBillingEnvVars } from "./claude";
import { MockAgent } from "./mock";
import type { ProviderDescriptor, ProviderStatus, StructuredAgent, WorkflowRole } from "./types";

type Registry = Map<string, ProviderDescriptor>;
const g = globalThis as unknown as { __devrelayProviders?: Registry; __devrelayAgentOverrides?: Map<string, StructuredAgent>; __devrelayStatusCache?: { at: number; value: ProviderStatus[] } };

const mockStatus = async (): Promise<ProviderStatus> => ({ id: "mock", label: "Mock (offline, deterministic)", installed: true, version: "built-in", authenticated: true, authMethod: "none", automationAllowed: true, notes: ["For tests and demos. Makes no network requests."] });

const BUILTINS: ProviderDescriptor[] = [
  {
    id: "codex",
    label: "OpenAI Codex CLI",
    kind: "local-cli",
    billing: "own-login",
    roles: ["pm", "reviewer"],
    writeCapable: false,
    create: () => new CodexAgent(),
    status: codexStatus,
  },
  {
    id: "claude-cli",
    label: "Claude Code CLI (automated, claude -p)",
    kind: "local-cli",
    billing: "own-login",
    roles: ["pm", "developer", "reviewer"],
    writeCapable: true,
    create: () => (claudeCliEnabled() ? new ClaudeCliAgent() : null),
    status: claudeStatus,
  },
  {
    id: "claude-manual",
    label: "Claude Code (manual handoff)",
    kind: "manual",
    billing: "none",
    roles: ["developer"],
    writeCapable: true,
    create: () => null,
    status: async () => ({ ...(await claudeStatus()), id: "claude-manual", label: "Claude Code (manual handoff)", automationAllowed: true, notes: ["You run Claude Code yourself in the task worktree; DevRelay writes the task file and ingests the result."] }),
  },
  {
    id: "mock",
    label: "Mock (offline)",
    kind: "mock",
    billing: "none",
    roles: ["pm", "developer", "reviewer"],
    writeCapable: true,
    create: () => new MockAgent(Number(process.env.DEVRELAY_MOCK_DELAY_MS ?? 0)),
    status: mockStatus,
  },
];

function registry(): Registry {
  if (!g.__devrelayProviders) {
    g.__devrelayProviders = new Map();
    for (const d of BUILTINS) g.__devrelayProviders.set(d.id, d);
  }
  return g.__devrelayProviders;
}

/** Register an additional provider adapter (plugins, future API adapters). */
export function registerProvider(desc: ProviderDescriptor): void {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(desc.id)) throw new Error(`Invalid provider id: ${desc.id}`);
  registry().set(desc.id, desc);
  g.__devrelayStatusCache = undefined;
}

export function listProviders(): ProviderDescriptor[] {
  return [...registry().values()];
}

export function getProvider(id: string): ProviderDescriptor | null {
  return registry().get(id) ?? null;
}

export function providersForRole(role: WorkflowRole): ProviderDescriptor[] {
  return listProviders().filter((d) => d.roles.includes(role) && (role !== "developer" || d.writeCapable));
}

export function isManualProvider(id: string): boolean {
  return getProvider(id)?.kind === "manual";
}

/** Test hook: replace an agent implementation. */
export function setAgentOverride(id: string, agent: StructuredAgent | undefined): void {
  g.__devrelayAgentOverrides ??= new Map();
  if (agent) g.__devrelayAgentOverrides.set(id, agent);
  else g.__devrelayAgentOverrides.delete(id);
  g.__devrelayStatusCache = undefined;
}

export function getAgent(id: string): StructuredAgent | null {
  const o = g.__devrelayAgentOverrides?.get(id);
  if (o) return o;
  return getProvider(id)?.create() ?? null;
}

export interface EnvironmentReport {
  providers: ProviderStatus[];
  billingEnvVars: string[];
  checkedAt: string;
}

/** Provider status, cached for 60s so the dashboard doesn't spawn CLIs on every render. */
export async function environmentReport(force = false): Promise<EnvironmentReport> {
  const c = g.__devrelayStatusCache;
  const billingEnvVars = detectBillingEnvVars();
  if (!force && c && Date.now() - c.at < 60_000) return { providers: c.value, billingEnvVars, checkedAt: new Date(c.at).toISOString() };
  const value = await Promise.all(
    listProviders().map((d) =>
      d.status().catch((e): ProviderStatus => ({ id: d.id, label: d.label, installed: false, version: null, authenticated: null, authMethod: null, automationAllowed: false, notes: [], error: String((e as Error)?.message ?? e) })),
    ),
  );
  const at = Date.now();
  g.__devrelayStatusCache = { at, value };
  return { providers: value, billingEnvVars, checkedAt: new Date(at).toISOString() };
}

export async function providerStatuses(force = false): Promise<ProviderStatus[]> {
  return (await environmentReport(force)).providers;
}

export type Usability = { ok: true } | { ok: false; kind: "auth" | "provider_unavailable" | "permission"; message: string };

/**
 * Pre-flight check before an automated run. Refuses providers that are unknown,
 * missing, logged out, metered, or authenticated in a way that could incur API charges.
 * (API-key env vars are also stripped from every child process.)
 */
export async function assertProviderUsable(id: string, role?: WorkflowRole): Promise<Usability> {
  if (g.__devrelayAgentOverrides?.has(id)) return { ok: true };
  const d = getProvider(id);
  if (!d) return { ok: false, kind: "provider_unavailable", message: `Unknown provider: ${id}` };
  if (role && !d.roles.includes(role)) return { ok: false, kind: "permission", message: `${d.label} cannot act as ${role}.` };
  if (d.billing === "api-metered" && process.env.DEVRELAY_ALLOW_METERED_PROVIDERS !== "1") return { ok: false, kind: "permission", message: `${d.label} is an API-metered provider. Metered providers are disabled (set DEVRELAY_ALLOW_METERED_PROVIDERS=1 to opt in).` };
  if (d.kind === "mock" || d.kind === "manual") return { ok: true };
  const s = (await providerStatuses()).find((x) => x.id === id);
  if (!s || !s.installed) return { ok: false, kind: "provider_unavailable", message: s?.notes.join(" ") || `${id} is not installed.` };
  if (s.authenticated === false) return { ok: false, kind: "auth", message: `${s.label} is not logged in. ${s.notes.join(" ")}` };
  if (!s.automationAllowed) return { ok: false, kind: "permission", message: s.notes.join(" ") || `${s.label} cannot be automated.` };
  return { ok: true };
}
