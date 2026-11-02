import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mockProject, settle, useTempDataDir } from "./helpers";
import * as repo from "../src/core/repo";
import * as orch from "../src/core/orchestrator";
import { setAgentOverride } from "../src/core/providers/registry";
import { MockAgent } from "../src/core/providers/mock";
import { captureDiff, createWorktree, verifyRepo } from "../src/core/git";
import { HubError } from "../src/core/util";
import type { StructuredAgent } from "../src/core/providers/types";

useTempDataDir();

async function toSpecReview(projectSettings: Partial<repo.ProjectSettings>, request: string, taskOpts: { maxRevisions?: number; autoAdvance?: boolean } = {}) {
  const p = await mockProject(projectSettings);
  const t = repo.createTask(p.id, { request, ...taskOpts });
  orch.startPm(t.id);
  const after = await settle(t.id);
  return { p, t: after };
}

describe("end-to-end with mock agents (no external AI requests)", () => {
  it("runs PM -> dev -> review -> approval and stops before merge", async () => {
    const { p, t } = await toSpecReview({}, "Add a multiply helper with a test");
    expect(t.status).toBe("spec_review");
    expect(t.spec?.acceptanceCriteria.length).toBeGreaterThan(0);
    orch.approveSpec(t.id, { authorizeExecution: true });
    const done = await settle(t.id);
    expect(done.status).toBe("awaiting_merge_approval");
    expect(done.branch).toMatch(/^devrelay\//);
    expect(done.worktreePath).toContain(path.join("worktrees", t.id));

    // The main repository is untouched; the change lives only in the worktree.
    const main = await verifyRepo(p.repoPath);
    expect(main.dirty).toBe(false);
    expect(main.branch).toBe("main");
    const diff = await captureDiff(done.worktreePath!, done.baseCommit!);
    expect(diff.changedFiles.some((f) => f.startsWith("devrelay-mock/"))).toBe(true);

    const kinds = repo.listMessages(t.id).map((m) => m.kind);
    expect(kinds).toEqual(expect.arrayContaining(["feature_request", "specification", "spec_approved", "dev_handoff", "implementation_result", "evidence", "review_result"]));
    const evidence = repo.latestMessage(t.id, "evidence")!.payload as { tests: { ranByHub: boolean; passed: boolean } };
    expect(evidence.tests).toMatchObject({ ranByHub: true, passed: true });
    expect(repo.listApprovals(t.id).find((a) => a.kind === "merge")?.status).toBe("pending");

    const completed = orch.humanDecision(t.id, "approve_merge");
    expect(completed.status).toBe("completed");
    // Still not merged: main branch HEAD unchanged.
    expect((await verifyRepo(p.repoPath)).headCommit).toBe(main.headCommit);
    // Decisions captured into project memory.
    expect(repo.listDecisions(p.id).length).toBeGreaterThan(0);
    expect(repo.getProject(p.id).memorySummary).toContain(done.title);
    // Every status change is audited.
    expect(repo.listTransitions(t.id).length).toBeGreaterThanOrEqual(8);
  });

  it("performs one revision round when the reviewer requests changes", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:changes-once]");
    orch.approveSpec(t.id, { authorizeExecution: true });
    const done = await settle(t.id);
    expect(done.status).toBe("awaiting_merge_approval");
    expect(done.revisionRound).toBe(1);
    const verdicts = repo.listMessages(t.id).filter((m) => m.kind === "review_result").map((m) => (m.payload as { verdict: string }).verdict);
    expect(verdicts).toEqual(["CHANGES_REQUESTED", "APPROVED"]);
  });

  it("stops at the revision limit and asks the human (no infinite loop)", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:always-changes]", { maxRevisions: 2 });
    orch.approveSpec(t.id, { authorizeExecution: true });
    const stopped = await settle(t.id);
    expect(stopped.status).toBe("human_decision_required");
    expect(stopped.revisionRound).toBe(2);
    expect(repo.listMessages(t.id).filter((m) => m.kind === "review_result")).toHaveLength(3);
    expect(repo.listApprovals(t.id).some((a) => a.kind === "decision" && a.status === "pending")).toBe(true);

    // Human grants exactly one more round; it stops again afterwards.
    orch.humanDecision(t.id, "grant_revision", "Try once more");
    const again = await settle(t.id);
    expect(again.status).toBe("human_decision_required");
    expect(again.revisionRound).toBe(3);
  });

  it("respects maxRevisions = 0", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:always-changes]", { maxRevisions: 0 });
    orch.approveSpec(t.id, { authorizeExecution: true });
    const stopped = await settle(t.id);
    expect(stopped.status).toBe("human_decision_required");
    expect(stopped.revisionRound).toBe(0);
  });

  it("routes HUMAN_DECISION_REQUIRED to the human", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:human]");
    orch.approveSpec(t.id, { authorizeExecution: true });
    expect((await settle(t.id)).status).toBe("human_decision_required");
    expect(orch.humanDecision(t.id, "accept").status).toBe("awaiting_merge_approval");
  });

  it("does not trust a developer that claims success with no diff", async () => {
    const { t } = await toSpecReview({ maxRevisions: 0 }, "Feature [mock:no-change]");
    orch.approveSpec(t.id, { authorizeExecution: true });
    const done = await settle(t.id);
    const review = repo.latestMessage(t.id, "review_result")!.payload as { verdict: string };
    expect(review.verdict).toBe("CHANGES_REQUESTED");
    expect(done.status).toBe("human_decision_required");
  });

  it("downgrades an APPROVED verdict that contradicts its own criteria", async () => {
    const lying: StructuredAgent = {
      id: "mock",
      async run(req) {
        if (req.role !== "reviewer") return new MockAgent().run(req);
        const value = { verdict: "APPROVED", summary: "lgtm", criteria: [{ criterionId: "AC-1", status: "not_met", evidence: "missing" }], requestedChanges: [], concerns: [], questionsForHuman: [] };
        return { ok: true, value: req.schema.parse(value), raw: JSON.stringify(value), durationMs: 1 };
      },
    };
    setAgentOverride("mock", lying);
    try {
      const { t } = await toSpecReview({}, "Feature");
      orch.approveSpec(t.id, { authorizeExecution: true });
      expect((await settle(t.id)).status).toBe("human_decision_required");
    } finally {
      setAgentOverride("mock", undefined);
    }
  });
});

describe("approvals and safety gates", () => {
  it("requires explicit execution authorisation before code is modified", async () => {
    const { t } = await toSpecReview({}, "Feature");
    orch.approveSpec(t.id, { authorizeExecution: false });
    const s = await settle(t.id);
    expect(s.status).toBe("spec_approved");
    expect(s.worktreePath).toBeNull();
    await expect(orch.dispatchDev(t.id)).rejects.toThrow(/not been authorised/);
    orch.authorizeExecution(t.id);
    await orch.dispatchDev(t.id);
    expect((await settle(t.id)).status).toBe("awaiting_merge_approval");
  });

  it("requires approval when the main repo is dirty", async () => {
    const { p, t } = await toSpecReview({}, "Feature");
    fs.writeFileSync(path.join(p.repoPath, "uncommitted.txt"), "wip");
    orch.approveSpec(t.id, { authorizeExecution: false });
    orch.authorizeExecution(t.id);
    await expect(orch.dispatchDev(t.id)).rejects.toThrow(/dirty/);
    expect(repo.listApprovals(t.id).some((a) => a.kind === "dirty_tree" && a.status === "pending")).toBe(true);
    orch.approveDirtyTree(t.id);
    await orch.dispatchDev(t.id);
    expect((await settle(t.id)).status).toBe("awaiting_merge_approval");
    expect(fs.readFileSync(path.join(p.repoPath, "uncommitted.txt"), "utf8")).toBe("wip"); // untouched
  });

  it("only registers verified git repository roots", async () => {
    const p = await mockProject();
    await expect(repo.createProject({ name: "sub", repoPath: path.join(p.repoPath, "src") })).rejects.toThrow(/repository root/);
    await expect(repo.createProject({ name: "rel", repoPath: "relative/path" })).rejects.toThrow(/absolute/);
    await expect(repo.createProject({ name: "missing", repoPath: path.join(p.repoPath, "nope") })).rejects.toThrow(/does not exist/);
  });

  it("refuses to reuse an existing branch and validates branch names", async () => {
    const p = await mockProject();
    await expect(createWorktree(p.repoPath, "task_x", "main")).rejects.toThrow(/Invalid branch/);
    await createWorktree(p.repoPath, "task_y1", "devrelay/dup");
    await expect(createWorktree(p.repoPath, "task_y2", "devrelay/dup")).rejects.toThrow(/already exists/);
  });

  it("rejects test commands containing shell syntax", async () => {
    await expect(mockProject({ testCommand: ["npm test && curl evil"] })).rejects.toThrow();
  });
});

describe("failures, malformed output and cancellation", () => {
  it("fails the step on malformed PM output and allows retry", async () => {
    const p = await mockProject();
    const t = repo.createTask(p.id, { request: "Feature [mock:malformed:pm]" });
    orch.startPm(t.id);
    const failed = await settle(t.id);
    expect(failed.status).toBe("failed");
    expect(failed.lastErrorKind).toBe("malformed_output");
    expect(failed.pausedFrom).toBe("draft");
    expect(repo.listRuns(t.id)[0]?.status).toBe("failed");
  });

  it("stops immediately on usage limits (no automatic retry)", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:usage-limit:reviewer]");
    orch.approveSpec(t.id, { authorizeExecution: true });
    const s = await settle(t.id);
    expect(s.status).toBe("failed");
    expect(s.lastErrorKind).toBe("usage_limit");
    expect(repo.listRuns(t.id).filter((r) => r.role === "reviewer")).toHaveLength(1);
  });

  it("stops on authentication failure", async () => {
    const p = await mockProject();
    const t = repo.createTask(p.id, { request: "Feature [mock:auth:pm]" });
    orch.startPm(t.id);
    expect((await settle(t.id)).lastErrorKind).toBe("auth");
  });

  it("handles a crashed developer CLI and retries from the stable state", async () => {
    const { t } = await toSpecReview({}, "Feature [mock:fail:developer]");
    orch.approveSpec(t.id, { authorizeExecution: true });
    const s = await settle(t.id);
    expect(s.status).toBe("failed");
    expect(s.lastErrorKind).toBe("provider_error");
    expect(s.pausedFrom).toBe("spec_approved");
    await orch.resume(t.id); // retry: still fails deterministically, but goes through the same path
    expect((await settle(t.id)).status).toBe("failed");
  });

  it("cancels a running step and kills the job", async () => {
    const p = await mockProject();
    const t = repo.createTask(p.id, { request: "Feature [mock:slow]" });
    orch.startPm(t.id);
    await new Promise((r) => setTimeout(r, 100));
    expect(repo.getTask(t.id).status).toBe("pm_running");
    orch.cancel(t.id);
    const s = await settle(t.id);
    expect(s.status).toBe("cancelled");
    expect(repo.listRuns(t.id)[0]?.status).toBe("cancelled");
  });

  it("pauses a running step and resumes it", async () => {
    setAgentOverride("mock", new MockAgent(400));
    try {
      const p = await mockProject();
      const t = repo.createTask(p.id, { request: "Feature" });
      orch.startPm(t.id);
      await new Promise((r) => setTimeout(r, 50));
      orch.pause(t.id);
      const paused = await settle(t.id);
      expect(paused.status).toBe("paused");
      expect(paused.pausedFrom).toBe("draft");
      await orch.resume(t.id);
      expect((await settle(t.id)).status).toBe("spec_review");
    } finally {
      setAgentOverride("mock", undefined);
    }
  });

  it("marks steps interrupted by a restart as failed and retryable", async () => {
    const p = await mockProject();
    const t = repo.createTask(p.id, { request: "Feature" });
    repo.transitionTask(t.id, "pm_running", "test", "simulate crash");
    expect(orch.recoverInterrupted()).toBeGreaterThanOrEqual(1);
    expect(repo.getTask(t.id)).toMatchObject({ status: "failed", pausedFrom: "draft" });
  });
});

describe("manual developer handoff (fallback mode)", () => {
  it("writes a task package and ingests a valid result", async () => {
    const { t } = await toSpecReview({ devProvider: "claude-manual" }, "Feature");
    orch.approveSpec(t.id, { authorizeExecution: true });
    const waiting = await settle(t.id);
    expect(waiting.status).toBe("awaiting_dev_result");
    const handoff = repo.latestMessage(t.id, "dev_handoff")!.payload as { taskFile: string; resultPath: string; command: string };
    expect(fs.readFileSync(handoff.taskFile, "utf8")).toContain("Acceptance criteria");
    expect(handoff.command).toMatch(/^cd "/);
    expect(handoff.command).not.toMatch(/dangerously/);

    // Malformed result is rejected, task stays waiting.
    await expect(orch.ingestResult(t.id, '{"status":"completed"}')).rejects.toThrow(HubError);
    expect(repo.getTask(t.id).status).toBe("awaiting_dev_result");

    // Simulate the developer's work in the worktree + RESULT.json.
    fs.writeFileSync(path.join(waiting.worktreePath!, "feature.js"), "export const x = 1;\n");
    fs.writeFileSync(handoff.resultPath, JSON.stringify({ status: "completed", summary: "Added feature.js", changedFiles: ["feature.js"], testsRun: [], decisions: [], questions: [], responseToFeedback: null }));
    await orch.ingestResult(t.id);
    const done = await settle(t.id);
    expect(done.status).toBe("awaiting_merge_approval");
  });
});
