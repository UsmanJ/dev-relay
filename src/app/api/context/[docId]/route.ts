import { body, handle } from "../../_lib";
import * as repo from "@/core/repo";

export const dynamic = "force-dynamic";
type Ctx = { params: Promise<{ docId: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const { docId } = await ctx.params;
  return handle(req, async () => {
    repo.setContextDocIncluded(docId, (await body(req)).includeInPrompts === true);
    return { ok: true };
  });
}

export async function DELETE(req: Request, ctx: Ctx) {
  const { docId } = await ctx.params;
  return handle(req, () => {
    repo.deleteContextDoc(docId);
    return { ok: true };
  });
}