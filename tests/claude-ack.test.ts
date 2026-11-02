import { describe, expect, it } from "vitest";
import { useTempDataDir } from "./helpers";
import { acknowledgeClaudeAutomation, claudeAckState, CLAUDE_ACK_VERSION, revokeClaudeAutomation } from "../src/core/claudeAck";
import { assertProviderUsable, environmentReport, offlineMode } from "../src/core/providers/registry";
import { ClaudeCliAgent } from "../src/core/providers/claude";
import { ImplementationResult } from "../src/core/schemas";
import { ProjectSettings } from "../src/core/repo";

useTempDataDir();

function setEnv(k: string, v: string | undefined) {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) setEnv(k, v);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(saved)) setEnv(k, v);
  });
}

describe("public defaults", () => {
  it("new projects default to the manual Claude handoff", () => {
    expect(ProjectSettings.parse({}).devProvider).toBe("claude-manual");
    expect(ProjectSettings.parse({}).pmProvider).toBe("codex");
  });

  it("the test environment is offline", () => {
    expect(offlineMode()).toBe(true);
  });
});

describe("one-time acknowledgement for automated Claude execution", () => {
  it("is not acknowledged by default", () => {
    expect(claudeAckState()).toMatchObject({ acknowledged: false, version: null, currentVersion: CLAUDE_ACK_VERSION });
    expect(claudeAckState().statements.length).toBeGreaterThanOrEqual(4);
  });

  it("blocks claude-cli before any CLI is spawned when not acknowledged", async () => {
    await withEnv({ DEVRELAY_OFFLINE: undefined, DEVRELAY_DISABLE_CLAUDE_CLI: undefined }, async () => {
      const u = await assertProviderUsable("claude-cli", "developer");
      expect(u.ok).toBe(false);
      if (!u.ok) expect(u.message).toMatch(/acknowledgement/);
      // The adapter itself refuses too (defence in depth), without spawning anything.
      const r = await new ClaudeCliAgent().run({ role: "developer", prompt: "x", schema: ImplementationResult, cwd: process.cwd(), timeoutMs: 1000, signal: new AbortController().signal, access: "workspace-write", meta: { taskId: "t", projectId: "p", request: "r", round: 0 } });
      expect(r.ok === false && r.errorKind).toBe("permission");
      expect(r.ok === false && r.error).toMatch(/acknowledgement/);
    });
  });

  it("rejects a stale acknowledgement version, records and revokes the current one", () => {
    expect(() => acknowledgeClaudeAutomation(CLAUDE_ACK_VERSION + 1)).toThrow(/changed/);
    const s = acknowledgeClaudeAutomation(CLAUDE_ACK_VERSION);
    expect(s.acknowledged).toBe(true);
    expect(s.acknowledgedAt).toBeTruthy();
    expect(revokeClaudeAutomation().acknowledged).toBe(false);
  });

  it("an acknowledgement never overrides the environment kill-switch or offline mode", async () => {
    acknowledgeClaudeAutomation(CLAUDE_ACK_VERSION);
    try {
      const offline = await assertProviderUsable("claude-cli", "developer");
      expect(offline.ok).toBe(false); // DEVRELAY_OFFLINE=1 in tests
      await withEnv({ DEVRELAY_OFFLINE: undefined, DEVRELAY_DISABLE_CLAUDE_CLI: "1" }, async () => {
        const disabled = await assertProviderUsable("claude-cli", "developer");
        expect(disabled.ok).toBe(false);
        if (!disabled.ok) expect(disabled.message).toMatch(/DISABLE_CLAUDE_CLI/);
      });
    } finally {
      revokeClaudeAutomation();
    }
  });
});

describe("offline mode (CI)", () => {
  it("never invokes provider CLIs, even for status", async () => {
    const r = await environmentReport(true);
    for (const p of r.providers.filter((x) => x.id === "codex" || x.id === "claude-cli")) {
      expect(p.installed).toBe(false);
      expect(p.automationAllowed).toBe(false);
      expect(p.notes.join(" ")).toMatch(/DEVRELAY_OFFLINE/);
    }
    expect((await assertProviderUsable("codex", "pm")).ok).toBe(false);
    expect((await assertProviderUsable("mock", "pm")).ok).toBe(true);
    expect((await assertProviderUsable("claude-manual", "developer")).ok).toBe(true);
  });
});