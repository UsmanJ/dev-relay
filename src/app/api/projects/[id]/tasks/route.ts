import { body, handle } from "../../../_lib";
import * as repo from "@/core/repo";
import * as orch from "@/core/orchestrator";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, async () => {
    const b = await body(req);
    const task = repo.createTask(id, b as Parameters<typeof repo.createTask>[1]);
    if (b.startPm !== false) orch.startPm(task.id);
    return repo.getTask(task.id);
  });
}