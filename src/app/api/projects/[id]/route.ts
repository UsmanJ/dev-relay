import { body, handle } from "../../_lib";
import * as repo from "@/core/repo";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, () => ({
    project: repo.getProject(id),
    tasks: repo.listTasks(id).map(({ spec: _s, ...t }) => t),
    decisions: repo.listDecisions(id, 50),
    contextDocs: repo.listContextDocs(id).map((d) => ({ ...d, content: d.content.slice(0, 500), size: d.content.length })),
    activity: repo.recentActivity(id, 25),
  }));
}

export async function PATCH(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, async () => repo.updateProject(id, await body(req)));
}