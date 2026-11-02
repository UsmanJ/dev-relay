import { describe, expect, it } from "vitest";
import { afterChangesRequested, assertTransition, canTransition, stableBefore, TASK_STATUSES, TERMINAL, TransitionError } from "../src/core/state";

describe("task state machine", () => {
  it("allows the happy path", () => {
    const path = ["draft", "pm_running", "spec_review", "spec_approved", "dev_running", "review_pending", "review_running", "awaiting_merge_approval", "completed"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it("rejects illegal jumps", () => {
    expect(canTransition("draft", "completed")).toBe(false);
    expect(canTransition("spec_review", "dev_running")).toBe(false); // spec must be approved first
    expect(canTransition("review_running", "completed")).toBe(false); // reviewer can never complete/merge
    expect(() => assertTransition("draft", "awaiting_merge_approval")).toThrow(TransitionError);
  });

  it("terminal states have no exits", () => {
    for (const t of TERMINAL) for (const s of TASK_STATUSES) expect(canTransition(t, s)).toBe(false);
  });

  it("only a human-driven state can reach completed", () => {
    const into = TASK_STATUSES.filter((s) => canTransition(s, "completed"));
    expect(into).toEqual(["awaiting_merge_approval"]);
  });

  it("running steps fall back to a retryable stable state", () => {
    expect(stableBefore("pm_running")).toBe("draft");
    expect(stableBefore("dev_running")).toBe("spec_approved");
    expect(stableBefore("review_running")).toBe("review_pending");
    expect(stableBefore("spec_review")).toBe("spec_review");
  });

  it("enforces the revision limit", () => {
    expect(afterChangesRequested(0, 2)).toBe("changes_requested");
    expect(afterChangesRequested(1, 2)).toBe("changes_requested");
    expect(afterChangesRequested(2, 2)).toBe("human_decision_required");
    expect(afterChangesRequested(0, 0)).toBe("human_decision_required");
  });
});