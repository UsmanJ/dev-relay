/**
 * Creates a small, self-contained sample Git repository (a tiny JS math
 * library with node:test tests) used to demonstrate a full cycle safely.
 * It lives under the hub's data directory and is never one of your real repos.
 */
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./config";
import { resolveCommand, runProcess } from "./process";
import { HubError } from "./util";

export async function createSampleRepo(name = "sample-calc"): Promise<string> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new HubError("Invalid sample repo name", "validation");
  const root = path.join(dataDir(), "samples", `${name}-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, version: "1.0.0", private: true, type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(root, "src", "math.js"), "export function add(a, b) {\n  return a + b;\n}\n");
  fs.writeFileSync(
    path.join(root, "test", "math.test.js"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.js";\n\ntest("add", () => {\n  assert.equal(add(2, 3), 5);\n});\n',
  );
  fs.writeFileSync(path.join(root, "README.md"), `# ${name}\n\nTiny sample library used by DevRelay demos.\n`);
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
  const git = resolveCommand("git");
  if (!git) throw new HubError("git not found", "git");
  const env = { ...process.env, GIT_AUTHOR_NAME: "DevRelay demo", GIT_AUTHOR_EMAIL: "demo@localhost", GIT_COMMITTER_NAME: "DevRelay demo", GIT_COMMITTER_EMAIL: "demo@localhost" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "Initial sample library"]]) {
    const r = await runProcess({ command: git, args, cwd: root, env, timeoutMs: 30_000 });
    if (r.exitCode !== 0) throw new HubError(`git ${args[0]} failed: ${r.stderr}`, "git");
  }
  return root;
}
