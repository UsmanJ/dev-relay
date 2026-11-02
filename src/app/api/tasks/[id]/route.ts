import { handle } from "../../_lib";
import * as repo from "@/core/repo";
import { activeJob } from "@/core/jobs";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, () => {
    const task = repo.getTask(id);
    return {
      task,
      project: repo.getProject(task.projectId),
      messages: repo.listMessages(id),
      transitions: repo.listTransitions(id),
      approvals: repo.listApprovals(id),
      runs: repo.listRuns(id),
      activeJob: activeJob(id),
    };
  });
}