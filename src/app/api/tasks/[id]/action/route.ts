import { z } from "zod";
import { body, handle } from "../../../_lib";
import * as repo from "@/core/repo";
import * as orch from "@/core/orchestrator";
import { LIMITS } from "@/core/config";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start") }),
  z.object({ action: z.literal("spec"), feedback: z.string().max(20_000).optional() }),
  z.object({ action: z.literal("update_spec"), spec: z.unknown() }),
  z.object({ action: z.literal("approve_spec"), authorizeExecution: z.boolean(), note: z.string().max(5_000).optional() }),
  z.object({ action: z.literal("authorize") }),
  z.object({ action: z.literal("approve_dirty") }),
  z.object({ action: z.literal("dispatch") }),
  z.object({ action: z.literal("ingest"), resultJson: z.string().max(500_000).optional() }),
  z.object({ action: z.literal("review") }),
  z.object({ action: z.literal("decide"), decision: z.enum(["approve_merge", "request_changes", "reject", "grant_revision", "accept", "respec", "rereview"]), note: z.string().max(10_000).optional() }),
  z.object({ action: z.literal("pause") }),
  z.object({ action: z.literal("resume") }),
  z.object({ action: z.literal("cancel"), note: z.string().max(2_000).optional() }),
  z.object({ action: z.literal("settings"), maxRevisions: z.number().int().min(0).max(LIMITS.maxRevisionsCeiling).optional(), autoAdvance: z.boolean().optional() }),
]);

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, async () => {
    const a = Action.parse(await body(req));
    switch (a.action) {
      case "start":
        return orch.advance(id);
      case "spec":
        return orch.startPm(id, { feedback: a.feedback });
      case "update_spec":
        return orch.updateSpec(id, a.spec);
      case "approve_spec":
        return orch.approveSpec(id, { authorizeExecution: a.authorizeExecution, note: a.note });
      case "authorize": {
        orch.authorizeExecution(id);
        const t = repo.getTask(id);
        return t.status === "spec_approved" || t.status === "changes_requested" ? orch.dispatchDev(id) : t;
      }
      case "approve_dirty":
        orch.approveDirtyTree(id);
        return orch.dispatchDev(id);
      case "dispatch":
        return orch.dispatchDev(id);
      case "ingest":
        return orch.ingestResult(id, a.resultJson);
      case "review":
        return orch.startReview(id);
      case "decide":
        return orch.humanDecision(id, a.decision, a.note);
      case "pause":
        return orch.pause(id);
      case "resume":
        return orch.resume(id);
      case "cancel":
        return orch.cancel(id, a.note);
      case "settings":
        return repo.patchTask(id, { ...(a.maxRevisions !== undefined ? { maxRevisions: a.maxRevisions } : {}), ...(a.autoAdvance !== undefined ? { autoAdvance: a.autoAdvance } : {}) });
    }
  });
}