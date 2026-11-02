/**
 * Deterministic mock provider for tests, development and demos. Makes NO
 * network requests. Behaviour is controlled by markers in the feature request:
 *
 *   [mock:changes-once]        reviewer requests changes in round 0, approves afterwards
 *   [mock:always-changes]      reviewer always requests changes (exercises the revision limit)
 *   [mock:human]               reviewer returns HUMAN_DECISION_REQUIRED
 *   [mock:malformed:<role>]    the given role (pm|developer|reviewer) returns invalid JSON
 *   [mock:fail:<role>]         the given role fails like a crashed CLI
 *   [mock:usage-limit:<role>]  the given role hits a usage limit
 *   [mock:auth:<role>]         the given role is not authenticated
 *   [mock:slow]                every call waits ~until timeout/cancel (for cancellation tests)
 *   [mock:no-change]           developer claims success but changes nothing
 */
import fs from "node:fs";
import path from "node:path";
import { parseStructured } from "../schemas";
import { assertHubWorktree } from "../git";
import type { AgentOutcome, AgentRequest, StructuredAgent } from "./types";
import type { AgentRole } from "../schemas";

function has(meta: string, marker: string): boolean {
  return meta.includes(`[mock:${marker}]`);
}

function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const t = setTimeout(() => resolve(true), ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve(false);
    }, { once: true });
  });
}

export class MockAgent implements StructuredAgent {
  readonly id = "mock" as const;
  constructor(private readonly delayMs = 0) {}

  async run<T>(req: AgentRequest<T>): Promise<AgentOutcome<T>> {
    const started = Date.now();
    const r = req.meta.request;
    const role = req.role as AgentRole;
    const elapsed = () => Date.now() - started;

    if (has(r, "slow")) {
      const finished = await sleep(Math.min(req.timeoutMs, 60_000), req.signal);
      if (!finished) return { ok: false, errorKind: "cancelled", error: "Cancelled by user.", durationMs: elapsed() };
      return { ok: false, errorKind: "timeout", error: "Mock timed out.", durationMs: elapsed() };
    }
    if (this.delayMs && !(await sleep(this.delayMs, req.signal))) return { ok: false, errorKind: "cancelled", error: "Cancelled by user.", durationMs: elapsed() };
    if (has(r, `fail:${role}`)) return { ok: false, errorKind: "provider_error", error: "mock: CLI exited with code 1 (simulated crash)", durationMs: elapsed(), exitCode: 1 };
    if (has(r, `usage-limit:${role}`)) return { ok: false, errorKind: "usage_limit", error: "mock: You've hit your usage limit. Try again later.", durationMs: elapsed(), exitCode: 1 };
    if (has(r, `auth:${role}`)) return { ok: false, errorKind: "auth", error: "mock: Not logged in. Please log in.", durationMs: elapsed(), exitCode: 1 };

    let raw: string;
    if (has(r, `malformed:${role}`)) raw = '{"this is": "not the schema", ';
    else if (role === "pm") raw = JSON.stringify(this.spec(req));
    else if (role === "developer") raw = JSON.stringify(this.implement(req));
    else if (role === "reviewer") raw = JSON.stringify(this.review(req));
    else return { ok: false, errorKind: "validation", error: `mock: unsupported role ${role}`, durationMs: elapsed() };

    const parsed = parseStructured(req.schema, raw);
    if (!parsed.ok) return { ok: false, errorKind: "malformed_output", error: parsed.error, raw, durationMs: elapsed() };
    return { ok: true, value: parsed.value, raw, durationMs: elapsed(), usage: { inputTokens: req.prompt.length, outputTokens: raw.length } };
  }

  private spec<T>(req: AgentRequest<T>) {
    const clean = req.meta.request.replace(/\[mock:[^\]]+\]/g, "").trim();
    const firstLine = clean.split(/\r?\n/)[0] ?? "Untitled task";
    const isBug = /\b(bug|fix|broken|error|crash)\b/i.test(clean);
    const feedback = typeof req.meta.feedback === "string" && req.meta.feedback ? req.meta.feedback : null;
    return {
      title: firstLine.slice(0, 80) || "Untitled task",
      type: isBug ? "bug" : "feature",
      summary: `Mock PM specification for: ${clean.slice(0, 500)}${feedback ? `\n\nIncorporates human feedback: ${feedback}` : ""}`,
      userStory: `As a user, I want ${firstLine.toLowerCase()} so that the product improves.`,
      requirements: ["Implement the requested behaviour", "Keep changes minimal and isolated", "Add or update a test where practical"],
      acceptanceCriteria: [
        { id: "AC-1", description: "The requested change is implemented in the codebase.", verification: "Diff shows the change." },
        { id: "AC-2", description: "A note describing the change exists in devrelay-mock/.", verification: "File present in diff." },
      ],
      nonGoals: ["No unrelated refactoring"],
      tradeOffs: ["Mock spec: favours simplicity over completeness"],
      openQuestions: [],
      suggestedTestPlan: ["Run the project's test command"],
      riskLevel: "low",
    };
  }

  private implement<T>(req: AgentRequest<T>) {
    const changed: string[] = [];
    if (!has(req.meta.request, "no-change")) {
      if (req.access !== "workspace-write") throw new Error("mock developer requires workspace-write access");
      assertHubWorktree(req.cwd); // mock only ever writes inside a hub-created worktree
      const rel = path.join("devrelay-mock", `${req.meta.taskId}.md`);
      const abs = path.join(req.cwd, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, `# Mock implementation\n\nRound ${req.meta.round}: ${req.meta.request.replace(/\[mock:[^\]]+\]/g, "").trim().slice(0, 200)}\n`);
      changed.push(rel.replace(/\\/g, "/"));
    }
    return {
      status: "completed",
      summary: `Mock developer implemented round ${req.meta.round}.`,
      changedFiles: changed,
      testsRun: [{ command: "mock test", passed: true, summary: "1 passed (claimed by mock developer)" }],
      decisions: req.meta.round === 0 ? [{ title: "Mock notes location", decision: "Store mock change notes under devrelay-mock/", rationale: "Keeps demo changes isolated", alternativesConsidered: ["Project root"] }] : [],
      questions: [],
      responseToFeedback: req.meta.round > 0 ? "Addressed all reviewer feedback (mock)." : null,
    };
  }

  private review<T>(req: AgentRequest<T>) {
    const r = req.meta.request;
    const round = req.meta.round;
    const changedCount = Number(req.meta.changedFilesCount ?? 0);
    const base = { criteria: [] as Array<{ criterionId: string; status: string; evidence: string }>, concerns: [] as string[], questionsForHuman: [] as string[], requestedChanges: [] as string[] };
    if (changedCount === 0) {
      return { ...base, verdict: "CHANGES_REQUESTED", summary: "The diff is empty: the developer's claim of completion is not supported by any code change.", criteria: [{ criterionId: "AC-1", status: "not_met", evidence: "No files changed relative to base commit." }], requestedChanges: ["Implement the change; no diff was produced."] };
    }
    if (has(r, "human")) return { ...base, verdict: "HUMAN_DECISION_REQUIRED", summary: "Trade-off requires a product decision.", questionsForHuman: ["Should we accept the reduced scope?"] };
    if (has(r, "always-changes") || (has(r, "changes-once") && round === 0)) {
      return { ...base, verdict: "CHANGES_REQUESTED", summary: `Round ${round}: implementation incomplete.`, criteria: [{ criterionId: "AC-1", status: "met", evidence: "Diff present" }, { criterionId: "AC-2", status: "not_met", evidence: "Needs more detail" }], requestedChanges: ["Add more detail to the change note."] };
    }
    return { ...base, verdict: "APPROVED", summary: `Round ${round}: all acceptance criteria verified against the diff.`, criteria: [{ criterionId: "AC-1", status: "met", evidence: `${changedCount} file(s) changed` }, { criterionId: "AC-2", status: "met", evidence: "devrelay-mock note present" }] };
  }
}
