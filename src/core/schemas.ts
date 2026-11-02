/**
 * Structured inter-agent protocol. Every message exchanged between the PM,
 * Developer and Reviewer roles is validated against these schemas before it
 * is persisted or acted upon. Malformed agent output is rejected, never
 * "best-effort" interpreted.
 *
 * LLM-facing schemas deliberately avoid optional properties (nullable is used
 * instead) because OpenAI structured outputs (codex --output-schema) require
 * every property to be listed in `required` with additionalProperties=false.
 */
import { z } from "zod";

const shortText = z.string().trim().min(1).max(2_000);
const longText = z.string().max(20_000);

export const AgentRole = z.enum(["pm", "developer", "reviewer", "human", "system"]);
export type AgentRole = z.infer<typeof AgentRole>;

export const AcceptanceCriterion = z.strictObject({
  id: z.string().regex(/^AC-\d{1,3}$/, "id must look like AC-1"),
  description: shortText,
  verification: z.string().max(2_000).describe("How a reviewer can verify this criterion (test, manual check, diff inspection)."),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const TechnicalQuestion = z.strictObject({
  id: z.string().regex(/^Q-\d{1,3}$/, "id must look like Q-1"),
  question: shortText,
  context: z.string().max(4_000),
  blocking: z.boolean().describe("True if work cannot sensibly proceed without an answer."),
  addressedTo: z.enum(["human", "pm", "developer"]),
});
export type TechnicalQuestion = z.infer<typeof TechnicalQuestion>;

export const TechnicalDecision = z.strictObject({
  title: shortText,
  decision: z.string().min(1).max(4_000),
  rationale: z.string().max(4_000),
  alternativesConsidered: z.array(z.string().max(1_000)).max(10),
});
export type TechnicalDecision = z.infer<typeof TechnicalDecision>;

export const TaskSpecification = z.strictObject({
  title: z.string().trim().min(3).max(200),
  type: z.enum(["feature", "bug", "chore"]),
  summary: z.string().min(1).max(4_000),
  userStory: z.string().max(2_000),
  requirements: z.array(shortText).min(1).max(30),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1).max(20),
  nonGoals: z.array(shortText).max(20),
  tradeOffs: z.array(shortText).max(20),
  openQuestions: z.array(TechnicalQuestion).max(20),
  suggestedTestPlan: z.array(shortText).max(20),
  riskLevel: z.enum(["low", "medium", "high"]),
});
export type TaskSpecification = z.infer<typeof TaskSpecification>;

export const TestRun = z.strictObject({
  command: z.string().max(500),
  passed: z.boolean(),
  summary: z.string().max(4_000),
});
export type TestRun = z.infer<typeof TestRun>;

/** What the Developer (Claude) reports back. Claims are evidence, not truth. */
export const ImplementationResult = z.strictObject({
  status: z.enum(["completed", "partial", "blocked"]),
  summary: z.string().min(1).max(8_000),
  changedFiles: z.array(z.string().max(500)).max(500),
  testsRun: z.array(TestRun).max(50),
  decisions: z.array(TechnicalDecision).max(20),
  questions: z.array(TechnicalQuestion).max(20),
  responseToFeedback: z.string().max(8_000).nullable().describe("When this is a revision: how each piece of reviewer feedback was addressed."),
});
export type ImplementationResult = z.infer<typeof ImplementationResult>;

export const CriterionVerdict = z.strictObject({
  criterionId: z.string().regex(/^AC-\d{1,3}$/),
  status: z.enum(["met", "not_met", "unverifiable"]),
  evidence: z.string().max(4_000),
});

export const ReviewVerdict = z.enum(["APPROVED", "CHANGES_REQUESTED", "HUMAN_DECISION_REQUIRED"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const ReviewResult = z.strictObject({
  verdict: ReviewVerdict,
  summary: z.string().min(1).max(8_000),
  criteria: z.array(CriterionVerdict).max(40),
  requestedChanges: z.array(shortText).max(30),
  concerns: z.array(shortText).max(30),
  questionsForHuman: z.array(shortText).max(20),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const ApprovalKind = z.enum(["spec", "execution", "dirty_tree", "merge", "decision"]);
export type ApprovalKind = z.infer<typeof ApprovalKind>;

export const ApprovalRequest = z.strictObject({
  kind: ApprovalKind,
  title: shortText,
  details: longText,
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

export const MessageKind = z.enum([
  "feature_request",
  "specification",
  "spec_feedback",
  "spec_approved",
  "dev_handoff",
  "implementation_result",
  "evidence",
  "review_result",
  "revision_request",
  "approval_request",
  "approval_decision",
  "question",
  "note",
  "error",
]);
export type MessageKind = z.infer<typeof MessageKind>;

export const AgentMessage = z.strictObject({
  taskId: z.string().min(1),
  role: AgentRole,
  provider: z.string().max(50),
  kind: MessageKind,
  round: z.number().int().min(0),
  body: z.string().max(50_000),
  payload: z.unknown().nullable(),
  refs: z
    .strictObject({
      branch: z.string().nullable(),
      commit: z.string().nullable(),
      worktree: z.string().nullable(),
      runId: z.string().nullable(),
    })
    .nullable(),
});
export type AgentMessage = z.infer<typeof AgentMessage>;

/** Convert a strict zod schema to a JSON schema acceptable to codex --output-schema. */
export function toProviderJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "output" }) as Record<string, unknown>;
  delete json.$schema;
  return enforceStrict(json) as Record<string, unknown>;
}

function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    // Keyword values that are not schemas but maps/arrays of schemas still need recursion.
    out[k] = enforceStrict(v);
  }
  // OpenAI strict mode does not accept these keywords.
  for (const unsupported of ["pattern", "format", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "default"]) {
    if (unsupported in out && typeof out[unsupported] !== "object") delete out[unsupported];
  }
  if (out.type === "object" && out.properties && typeof out.properties === "object") {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties as object);
  }
  // `unknown` payloads render as {} – not used in provider-facing schemas.
  return out;
}

/** Parse untrusted JSON text into a validated value, with a readable error. */
export function parseStructured<T>(schema: z.ZodType<T>, raw: string): { ok: true; value: T } | { ok: false; error: string } {
  const text = extractJson(raw);
  if (text === null) return { ok: false, error: "No JSON object found in agent output." };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `Agent output is not valid JSON: ${(e as Error).message}` };
  }
  const res = schema.safeParse(data);
  if (!res.success) {
    const issues = res.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `Agent output failed schema validation: ${issues}` };
  }
  return { ok: true, value: res.data };
}

/** Accepts raw JSON, or JSON wrapped in a single ```json fence. Nothing fuzzier. */
export function extractJson(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return trimmed;
  const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/m.exec(trimmed);
  if (fence?.[1]) return fence[1].trim();
  return null;
}
