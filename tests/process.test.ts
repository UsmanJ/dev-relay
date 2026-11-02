import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCmdShim, resolveCommand, runProcess, subscriptionEnv } from "../src/core/process";

const node = resolveCommand("node")!;
const cwd = process.cwd();

describe("runProcess (no shell)", () => {
  it("passes shell metacharacters literally", async () => {
    const r = await runProcess({ command: node, args: ["-e", "console.log(JSON.stringify(process.argv.slice(1)))", "a & echo pwned", "$(whoami)", "|", ";rm -rf /"], cwd });
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(["a & echo pwned", "$(whoami)", "|", ";rm -rf /"]);
  });

  it("feeds stdin", async () => {
    const r = await runProcess({ command: node, args: ["-e", "process.stdin.pipe(process.stdout)"], cwd, input: "hello" });
    expect(r.stdout).toBe("hello");
  });

  it("enforces timeouts and kills the process", async () => {
    const r = await runProcess({ command: node, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(15_000);
  });

  it("cancels via AbortSignal", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await runProcess({ command: node, args: ["-e", "setTimeout(()=>{}, 60000)"], cwd, signal: ac.signal });
    expect(r.cancelled).toBe(true);
  });

  it("caps stdout size", async () => {
    const r = await runProcess({ command: node, args: ["-e", "process.stdout.write('x'.repeat(200000))"], cwd, maxStdoutBytes: 1000 });
    expect(r.stdoutTruncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
  });

  it("refuses NUL bytes in arguments", async () => {
    await expect(runProcess({ command: node, args: ["a\0b"], cwd })).rejects.toThrow(/NUL/);
  });

  it("reports a missing working directory", async () => {
    const r = await runProcess({ command: node, args: ["-v"], cwd: path.join(os.tmpdir(), "does-not-exist-devrelay") });
    expect(r.spawnError).toMatch(/does not exist/);
  });

  it("strips API-key variables from child environments", () => {
    process.env.ANTHROPIC_API_KEY = "x";
    process.env.OPENAI_API_KEY = "y";
    const env = subscriptionEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
  });
});

describe("Windows .cmd shim resolution", () => {
  it("parses an npm cmd-shim pointing at a JS entry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devrelay-shim-"));
    fs.mkdirSync(path.join(dir, "node_modules", "tool", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "tool", "bin", "tool.js"), "");
    fs.writeFileSync(path.join(dir, "tool.cmd"), '@ECHO off\r\nSET dp0=%~dp0\r\n"%_prog%"  "%dp0%\\node_modules\\tool\\bin\\tool.js" %*\r\n');
    const r = parseCmdShim(path.join(dir, "tool.cmd"));
    expect(r?.file).toBe(process.execPath);
    expect(r?.prefixArgs[0]).toMatch(/tool\.js$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("parses a shim pointing at a native exe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devrelay-shim-"));
    fs.mkdirSync(path.join(dir, "node_modules", "x", "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "node_modules", "x", "bin", "x.exe"), "");
    fs.writeFileSync(path.join(dir, "x.cmd"), '"%dp0%\\node_modules\\x\\bin\\x.exe"   %*\r\n');
    expect(parseCmdShim(path.join(dir, "x.cmd"))?.file).toMatch(/x\.exe$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});