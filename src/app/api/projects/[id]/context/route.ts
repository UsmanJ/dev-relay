import { body, handle } from "../../../_lib";
import * as repo from "@/core/repo";
import { HubError } from "@/core/util";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  return handle(req, async () => {
    const b = await body(req);
    if (typeof b.content !== "string" || !b.content.trim()) throw new HubError("Content is empty.", "validation");
    return repo.addContextDoc(id, String(b.title ?? "Imported notes"), b.content, String(b.source ?? "upload"));
  });
}