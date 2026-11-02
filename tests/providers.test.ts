import { describe, expect, it } from "vitest";
import { buildClaudeArgs, detectBillingEnvVars, interpretClaudeEnvelope } from "../src/core/providers/claude";
import { summariseCodexEvents } from "../src/core/providers/codex";
import { classifyProviderError } from "../src/core/providers/classify";
import { assertProviderUsable, providersForRole, registerProvider, getProvider } from "../src/core/providers/registry";
import { ImplementationResult } from "../src/core/schemas";

const impl = { status: "completed", summary: "done", changedFiles: ["a.js"], testsRun: [], decisions: [], questions: [], responseToFeedback: null };

describe("Claude CLI adapter", () => {
  it("never bypasses permissions and always runs restricted", () => {
    for (const access of ["read-only", "workspace-write"] as const) {
      const args = buildClaudeArgs({ access, schemaJson: "{}", testCommand: ["npm", "test"] });
      expect(args.join(" ")).not.toMatch(/dangerously|bypassPermissions/);
      expect(args).toContain("--restricted");
      expect(args).toContain("-p");
      expect(args[args.indexOf("--permission-prompts") + 1]).toBe("none");
    }
    expect(buildClaudeArgs({ access: "read-only", schemaJson: "{}" })[buildClaudeArgs({ access: "read-only", schemaJson: "{}" }).indexOf("--permission-mode") + 1]).toBe("plan");
    const w = buildClaudeArgs({ access: "workspace-write", schemaJson: "{}", testCommand: ["npm", "test"] });
    expect(w).toContain("Bash(npm test*)");
    expect(w).not.toContain("Bash(*)");
  });

  it("reads structured_output from the JSON envelope", () => {
    const env = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "", structured_output: impl, usage: { input_tokens: 3, output_tokens: 4 }, permission_denials: [] });
    const r = interpretClaudeEnvelope(env, 0, "", ImplementationResult, 10);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.summary).toBe("done");
  });

  it("classifies usage-limit and auth failures", () => {
    const limit = interpretClaudeEnvelope(JSON.stringify({ is_error: true, result: "Claude usage limit reached. Your limit will reset at 5pm" }), 1, "", ImplementationResult, 1);
    expect(limit.ok === false && limit.errorKind).toBe("usage_limit");
    const auth = interpretClaudeEnvelope("", 1, "Not logged in · Please run /login", ImplementationResult, 1);
    expect(auth.ok === false && auth.errorKind).toBe("auth");
  });

  it("rejects malformed structured output", () => {
    const r = interpretClaudeEnvelope(JSON.stringify({ subtype: "success", is_error: false, structured_output: { status: "nope" } }), 0, "", ImplementationResult, 1);
    expect(r.ok === false && r.errorKind).toBe("malformed_output");
  });

  it("detects billing-risk environment variables", () => {
    expect(detectBillingEnvVars({ ANTHROPIC_API_KEY: "x", PATH: "y" })).toEqual(["ANTHROPIC_API_KEY"]);
    expect(detectBillingEnvVars({ OPENAI_API_KEY: "  " })).toEqual([]);
  });
});

describe("Codex adapter", () => {
  it("summarises JSONL events, usage and errors", () => {
    const s = summariseCodexEvents(
      [
        '{"type":"thread.started","thread_id":"t1"}',
        '{"type":"turn.completed","usage":{"input_tokens":10,"cached_input_tokens":2,"output_tokens":5,"reasoning_output_tokens":1}}',
        "not json",
        '{"type":"error","message":"You\'ve hit your usage limit"}',
      ].join("\n"),
    );
    expect(s.threadId).toBe("t1");
    expect(s.usage?.inputTokens).toBe(10);
    expect(classifyProviderError(s.errors.join(" "))).toBe("usage_limit");
  });
});

describe("provider registry", () => {
  it("is role/capability based", () => {
    expect(providersForRole("developer").map((p) => p.id)).not.toContain("codex");
    expect(providersForRole("pm").map((p) => p.id)).toContain("codex");
  });

  it("accepts new adapters and blocks metered ones by default", async () => {
    registerProvider({ id: "example-api", label: "Example API", kind: "api", billing: "api-metered", roles: ["pm"], writeCapable: false, create: () => null, status: async () => ({ id: "example-api", label: "x", installed: true, version: null, authenticated: true, authMethod: "api-key", automationAllowed: true, notes: [] }) });
    expect(getProvider("example-api")).not.toBeNull();
    const u = await assertProviderUsable("example-api", "pm");
    expect(u.ok).toBe(false);
    expect(await assertProviderUsable("mock", "developer")).toEqual({ ok: true });
    expect((await assertProviderUsable("codex", "developer")).ok).toBe(false);
  });
});