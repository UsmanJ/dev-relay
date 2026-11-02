import { handle } from "../_lib";
import { environmentReport, listProviders } from "@/core/providers/registry";
import { activeJobs } from "@/core/jobs";
import { recentProviderErrors } from "@/core/repo";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("refresh") === "1";
  return handle(req, async () => ({
    environment: await environmentReport(force),
    providers: listProviders().map((p) => ({ id: p.id, label: p.label, kind: p.kind, billing: p.billing, roles: p.roles, writeCapable: p.writeCapable })),
    activeJobs: activeJobs(),
    recentErrors: recentProviderErrors(10),
  }));
}