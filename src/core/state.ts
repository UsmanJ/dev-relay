/**
 * Task lifecycle state machine. Every status change goes through
 * `assertTransition`, so illegal jumps (e.g. draft -> completed) are impossible.
 */
export const TASK_STATUSES = [
  "draft",
  "pm_running",
  "spec_review",
  "spec_approved",
  "dev_running",
  "awaiting_dev_result",
  "review_pending",
  "review_running",
  "changes_requested",
  "awaiting_merge_approval",
  "human_decision_required",
  "completed",
  "rejected",
  "failed",
  "paused",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL: ReadonlySet<TaskStatus> = new Set(["completed", "rejected", "cancelled"]);
export const RUNNING: ReadonlySet<TaskStatus> = new Set(["pm_running", "dev_running", "review_running"]);
/** States where the next step is waiting on a human. */
export const AWAITING_HUMAN: ReadonlySet<TaskStatus> = new Set([
  "spec_review",
  "awaiting_dev_result",
  "awaiting_merge_approval",
  "human_decision_required",
  "failed",
  "paused",
]);

/** The stable state a running step returns to on pause / failure (so it can be retried). */
export function stableBefore(status: TaskStatus): TaskStatus {
  switch (status) {
    case "pm_running":
      return "draft";
    case "dev_running":
      return "spec_approved";
    case "review_running":
      return "review_pending";
    default:
      return status;
  }
}

const RESUMABLE: TaskStatus[] = [
  "draft",
  "spec_review",
  "spec_approved",
  "awaiting_dev_result",
  "review_pending",
  "changes_requested",
  "awaiting_merge_approval",
  "human_decision_required",
];

const T: Record<TaskStatus, TaskStatus[]> = {
  draft: ["pm_running", "spec_review", "paused", "cancelled"],
  pm_running: ["spec_review", "failed", "paused", "cancelled"],
  spec_review: ["pm_running", "spec_approved", "paused", "cancelled", "rejected"],
  spec_approved: ["dev_running", "awaiting_dev_result", "failed", "paused", "cancelled"],
  dev_running: ["review_pending", "human_decision_required", "failed", "paused", "cancelled"],
  awaiting_dev_result: ["review_pending", "human_decision_required", "spec_approved", "changes_requested", "paused", "cancelled"],
  review_pending: ["review_running", "awaiting_merge_approval", "paused", "cancelled"],
  review_running: ["awaiting_merge_approval", "changes_requested", "human_decision_required", "failed", "paused", "cancelled"],
  changes_requested: ["dev_running", "awaiting_dev_result", "human_decision_required", "failed", "paused", "cancelled"],
  awaiting_merge_approval: ["completed", "changes_requested", "rejected", "cancelled"],
  human_decision_required: ["changes_requested", "spec_review", "review_pending", "awaiting_merge_approval", "rejected", "cancelled", "paused"],
  failed: [...RESUMABLE, "cancelled"],
  paused: [...RESUMABLE, "cancelled"],
  completed: [],
  rejected: [],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return T[from]?.includes(to) ?? false;
}

export class TransitionError extends Error {
  constructor(
    public readonly from: TaskStatus,
    public readonly to: TaskStatus,
  ) {
    super(`Illegal task transition: ${from} -> ${to}`);
    this.name = "TransitionError";
  }
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}

export function isTaskStatus(s: string): s is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(s);
}

/** Decide what happens after a CHANGES_REQUESTED review, honouring the revision limit. */
export function afterChangesRequested(revisionRound: number, maxRevisions: number): "changes_requested" | "human_decision_required" {
  return revisionRound < maxRevisions ? "changes_requested" : "human_decision_required";
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
  draft: "Draft",
  pm_running: "PM drafting spec",
  spec_review: "Spec awaiting approval",
  spec_approved: "Spec approved",
  dev_running: "Developer running",
  awaiting_dev_result: "Awaiting developer result",
  review_pending: "Ready for review",
  review_running: "Reviewer running",
  changes_requested: "Changes requested",
  awaiting_merge_approval: "Approved – awaiting your merge decision",
  human_decision_required: "Human decision required",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};
