import { z } from "zod";
import { body, handle } from "../../_lib";
import { acknowledgeClaudeAutomation, claudeAckState, revokeClaudeAutomation } from "@/core/claudeAck";
import { invalidateProviderStatus } from "@/core/providers/registry";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  return handle(req, () => ({ ...claudeAckState(), disabledByEnv: process.env.DEVRELAY_DISABLE_CLAUDE_CLI === "1" }));
}

const Body = z.discriminatedUnion("action", [
  // `version` must echo the acknowledgement version the user was shown; `confirmed` must be literally true.
  z.object({ action: z.literal("acknowledge"), version: z.number().int(), confirmed: z.literal(true) }),
  z.object({ action: z.literal("revoke") }),
]);

export async function POST(req: Request) {
  return handle(req, async () => {
    const b = Body.parse(await body(req));
    const state = b.action === "acknowledge" ? acknowledgeClaudeAutomation(b.version) : revokeClaudeAutomation();
    invalidateProviderStatus();
    return state;
  });
}