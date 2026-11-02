// HTTP smoke test against a running DevRelay server (mock providers only).
// Usage: node scripts/smoke-http.mjs <sample-repo-path> [baseUrl]
const repoPath = process.argv[2];
const base = process.argv[3] ?? "http://127.0.0.1:3210";
if (!repoPath) {
  console.error("usage: node scripts/smoke-http.mjs <git-repo-path> [baseUrl]");
  process.exit(2);
}
const H = { "content-type": "application/json", "x-devrelay": "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(path, body, method) {
  const res = await fetch(base + path, { method: method ?? (body ? "POST" : "GET"), headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${JSON.stringify(j)}`);
  return j;
}
const check = (cond, msg) => {
  if (!cond) throw new Error(`FAILED: ${msg}`);
  console.log(`ok - ${msg}`);
};

for (let i = 0; ; i++) {
  try {
    await fetch(base + "/api/status");
    break;
  } catch {
    if (i > 120) throw new Error("server did not start");
    await sleep(1000);
  }
}

// Security guards
let r = await fetch(base + "/api/projects", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(r.status === 403, "mutation without x-devrelay header is refused");
r = await fetch(base + "/api/projects", { method: "POST", headers: { ...H, origin: "https://evil.example" }, body: "{}" });
check(r.status === 403, "cross-origin mutation is refused");
// fetch() cannot override Host, so use node:http directly.
const { request } = await import("node:http");
const u = new URL(base);
const hostStatus = await new Promise((resolve, reject) => {
  const req = request({ host: u.hostname, port: u.port, path: "/api/status", headers: { host: "evil.example" } }, (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on("error", reject);
  req.end();
});
check(hostStatus === 403, "non-loopback Host header is refused (DNS rebinding)");

for (const page of ["/", "/providers"]) {
  const html = await (await fetch(base + page)).text();
  check(html.includes("DevRelay"), `page ${page} renders`);
}

const status = await call("/api/status");
check(Array.isArray(status.environment.providers) && status.providers.some((p) => p.id === "mock"), "provider status endpoint works");

const p = await call("/api/projects", { name: `HTTP smoke ${Date.now()}`, repoPath, settings: { pmProvider: "mock", devProvider: "mock", reviewProvider: "mock", testCommand: ["node", "--test"], allowTestExecution: true } });
check(p.id, "project registered via API");
const projPage = await (await fetch(`${base}/projects/${p.id}`)).text();
check(projPage.includes("DevRelay"), "project page renders");

let t = await call(`/api/projects/${p.id}/tasks`, { request: "Add multiply helper [mock:changes-once]" });
const wait = async (pred, label) => {
  for (let i = 0; i < 120; i++) {
    const d = await call(`/api/tasks/${t.id}`);
    if (pred(d)) return d;
    await sleep(500);
  }
  throw new Error(`timeout waiting for ${label}`);
};
let d = await wait((d) => d.task.status === "spec_review", "spec_review");
check(d.task.spec.acceptanceCriteria.length > 0, "PM spec drafted (spec_review)");
await call(`/api/tasks/${t.id}/action`, { action: "approve_spec", authorizeExecution: true });
d = await wait((d) => ["awaiting_merge_approval", "failed", "human_decision_required"].includes(d.task.status) && !d.activeJob, "review");
check(d.task.status === "awaiting_merge_approval", `reached awaiting_merge_approval after ${d.task.revisionRound} revision(s)`);
check(d.messages.some((m) => m.kind === "evidence"), "diff/test evidence captured");
const taskPage = await (await fetch(`${base}/tasks/${t.id}`)).text();
check(taskPage.includes("DevRelay"), "task page renders");
await call(`/api/tasks/${t.id}/action`, { action: "decide", decision: "approve_merge" });
d = await call(`/api/tasks/${t.id}`);
check(d.task.status === "completed", "human approval recorded (no merge performed)");

// Cancellation through the API
t = await call(`/api/projects/${p.id}/tasks`, { request: "Slow one [mock:slow]" });
await sleep(300);
await call(`/api/tasks/${t.id}/action`, { action: "cancel" });
d = await wait((d) => !d.activeJob, "cancel");
check(d.task.status === "cancelled", "running task cancelled via API");

// Validation errors are meaningful
r = await fetch(base + "/api/projects", { method: "POST", headers: H, body: JSON.stringify({ name: "bad", repoPath: "not/absolute" }) });
const j = await r.json();
check(r.status === 400 && /absolute/.test(j.error), "invalid repo path rejected with a clear message");
console.log("\nHTTP smoke test passed.");
