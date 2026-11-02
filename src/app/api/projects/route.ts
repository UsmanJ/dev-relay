import { body, handle } from "../_lib";
import * as repo from "@/core/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(req, () => repo.listProjects().map((p) => ({ ...p, taskCounts: countByStatus(p.id) })));
}

export async function POST(req: Request) {
  return handle(req, async () => repo.createProject((await body(req)) as repo.ProjectInput));
}

function countByStatus(projectId: string) {
  const counts: Record<string, number> = {};
  for (const t of repo.listTasks(projectId)) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return counts;
}