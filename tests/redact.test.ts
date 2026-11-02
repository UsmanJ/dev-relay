import { describe, expect, it } from "vitest";
import { redact } from "../src/core/redact";

describe("redact", () => {
  it("removes common secret formats", () => {
    const input = [
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "anthropic sk-ant-api03-ABCDEFGHIJKLMNOP",
      "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz.123",
      "postgres://user:hunter2@db.example.com/x",
      "DB_PASSWORD: s3cr3tvalue",
      "AKIAABCDEFGHIJKLMNOP",
    ].join("\n");
    const out = redact(input);
    for (const secret of ["abcdefghijklmnopqrstuvwxyz123456", "ABCDEFGHIJKLMNOP", "ghp_abcdef", "hunter2", "s3cr3tvalue", "AKIAABCDEFGHIJKLMNOP"]) expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED");
  });

  it("leaves ordinary text alone", () => {
    expect(redact("export function add(a, b) { return a + b; }")).toBe("export function add(a, b) { return a + b; }");
  });
});