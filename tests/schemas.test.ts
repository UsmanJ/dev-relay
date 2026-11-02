import { describe, expect, it } from "vitest";
import { extractJson, ImplementationResult, parseStructured, ReviewResult, TaskSpecification, toProviderJsonSchema, AgentMessage } from "../src/core/schemas";

const spec = {
  title: "Add multiply",
  type: "feature",
  summary: "Add multiply.",
  userStory: "",
  requirements: ["multiply(a,b)"],
  acceptanceCriteria: [{ id: "AC-1", description: "exists", verification: "test" }],
  nonGoals: [],
  tradeOffs: [],
  openQuestions: [],
  suggestedTestPlan: [],
  riskLevel: "low",
};

describe("schemas", () => {
  it("accepts a valid TaskSpecification", () => {
    expect(TaskSpecification.safeParse(spec).success).toBe(true);
  });

  it("rejects missing acceptance criteria and bad ids", () => {
    expect(TaskSpecification.safeParse({ ...spec, acceptanceCriteria: [] }).success).toBe(false);
    expect(TaskSpecification.safeParse({ ...spec, acceptanceCriteria: [{ id: "1", description: "x", verification: "" }] }).success).toBe(false);
  });

  it("rejects unknown properties (strict)", () => {
    expect(TaskSpecification.safeParse({ ...spec, sneaky: true }).success).toBe(false);
  });

  it("validates review verdicts", () => {
    const base = { summary: "ok", criteria: [], requestedChanges: [], concerns: [], questionsForHuman: [] };
    expect(ReviewResult.safeParse({ ...base, verdict: "APPROVED" }).success).toBe(true);
    expect(ReviewResult.safeParse({ ...base, verdict: "LGTM" }).success).toBe(false);
  });

  it("parseStructured reports malformed output clearly", () => {
    expect(parseStructured(ImplementationResult, "not json at all")).toMatchObject({ ok: false });
    const r = parseStructured(ImplementationResult, '{"status":"done"}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/schema validation/);
    const bad = parseStructured(ImplementationResult, '{"status": ');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/not valid JSON/);
  });

  it("extractJson accepts raw or single fenced JSON only", () => {
    expect(extractJson('{"a":1}')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson("Here you go: {\"a\":1}")).toBeNull();
  });

  it("provider JSON schema is strict (all objects closed, all properties required)", () => {
    const walk = (n: unknown): void => {
      if (Array.isArray(n)) return n.forEach(walk);
      if (!n || typeof n !== "object") return;
      const o = n as Record<string, unknown>;
      if (o.type === "object" && o.properties) {
        expect(o.additionalProperties).toBe(false);
        expect(new Set(o.required as string[])).toEqual(new Set(Object.keys(o.properties as object)));
      }
      Object.values(o).forEach(walk);
    };
    for (const s of [TaskSpecification, ImplementationResult, ReviewResult]) walk(toProviderJsonSchema(s));
  });

  it("AgentMessage requires a known role and kind", () => {
    const m = { taskId: "t", role: "pm", provider: "mock", kind: "specification", round: 0, body: "x", payload: null, refs: null };
    expect(AgentMessage.safeParse(m).success).toBe(true);
    expect(AgentMessage.safeParse({ ...m, role: "ceo" }).success).toBe(false);
    expect(AgentMessage.safeParse({ ...m, kind: "merge_now" }).success).toBe(false);
  });
});