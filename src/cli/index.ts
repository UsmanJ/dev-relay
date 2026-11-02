#!/usr/bin/env node
/**
 * DevRelay CLI. Usage: npm run relay -- <command> [args]
 * Run `npm run relay -- help` for the command list.
 */
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import * as repo from "../core/repo";
import * as orch from "../core/orchestrator";
import { waitForIdle } from "../core/jobs";
import { environmentReport } from "../core/providers/registry";
import { createSampleRepo } from "../core/demo";
import { STATUS_LABEL } from "../core/state";
import { HubError } from "../core/util";
import { closeDb } from "../core/db/client";

// Same optional local config files Next.js reads (never committed).
for (const f of [".env.local", ".env"]) {
  try {
    process.loadEnvFile(f);
  } catch {
    /* absent */
  }
}

const HELP = `DevRelay CLI

  doctor                                   Provider install/auth status and billing-risk env vars
  project add --name N --repo PATH [--github URL] [--description D]
              [--pm codex|mock] [--dev claude-cli|claude-manual|mock] [--review codex|mock]
              [--test-cmd "npm test"] [--allow-tests] [--max-revisions 2]
  project list
  project show <project>
  project set <project> key=value ...      e.g. devProvider=claude-manual maxRevisions=1 allowTestExecution=true
  project import <project> <file.md> [--title T]   Import ChatGPT notes / docs as project context
  task new <project> "<request>" [--type feature|bug|chore] [--max-revisions N] [--manual-steps]
  task list [<project>]
  task show <task>
  task spec <task> [--feedback "..."]     Run the PM (Codex) to draft / redraft the spec
  task approve <task> [--authorize-execution] [--note "..."]
  task authorize <task>                   Authorise the developer to modify code (isolated worktree)
  task approve-dirty <task>               Allow dispatch although the main repo has uncommitted changes
  task dispatch <task>                    Send to developer (automated Claude or manual handoff)
  task ingest <task> [--file result.json] Manual mode: ingest Claude's RESULT.json
  task review <task>                      Run the reviewer (Codex)
  task decide <task> <approve_merge|request_changes|grant_revision|accept|respec|rereview|reject> [--note "..."]
  task pause|resume|retry|cancel <task>
  run <project> "<request>" [--yes]       Whole cycle. Without --yes it stops at spec approval.
  demo [--real]                           Full cycle on a fresh sample repo. Default: mock agents (offline).
                                          --real uses Codex (PM/review) + Claude Code (developer) via your subscriptions.
`;

function out(s = "") {
  process.stdout.write(s + "\n");
}

function resolveProject(ref: string | undefined): repo.Project {
  if (!ref) throw new HubError("Project id or name required", "validation");
  return repo.findProjectByName(ref) ?? repo.getProject(ref);
}

function printTask(id: string, verbose = false) {
  const t = repo.getTask(id);
  out(`\n■ ${t.title}  [${t.id}]`);
  out(`  status: ${STATUS_LABEL[t.status]} (${t.status})   round ${t.revisionRound}/${t.maxRevisions}${t.branch ? `   branch ${t.branch}` : ""}`);
  if (t.lastError) out(`  last error (${t.lastErrorKind}): ${t.lastError}`);
  const pending = repo.listApprovals(id).filter((a) => a.status === "pending");
  for (const a of pending) out(`  ⚑ pending approval [${a.kind}]: ${a.title}`);
  if (verbose) {
    out("\n  Timeline:");
    for (const m of repo.listMessages(id)) {
      const body = m.body.replace(/\s+/g, " ").slice(0, verbose ? 220 : 120);
      out(`   ${m.createdAt.slice(11, 19)}  ${m.role.padEnd(9)} ${m.kind.padEnd(22)} r${m.round}  ${body}`);
    }
  }
}

async function waitAndPrint(id: string, verbose = true) {
  await waitForIdle(id);
  printTask(id, verbose);
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, sub, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: cmd === "project" || cmd === "task" ? rest : argv.slice(1),
    allowPositionals: true,
    options: {
      name: { type: "string" },
      repo: { type: "string" },
      github: { type: "string" },
      description: { type: "string" },
      pm: { type: "string" },
      dev: { type: "string" },
      review: { type: "string" },
      "test-cmd": { type: "string" },
      "allow-tests": { type: "boolean" },
      "max-revisions": { type: "string" },
      type: { type: "string" },
      title: { type: "string" },
      feedback: { type: "string" },
      note: { type: "string" },
      file: { type: "string" },
      "authorize-execution": { type: "boolean" },
      "manual-steps": { type: "boolean" },
      yes: { type: "boolean" },
      real: { type: "boolean" },
    },
  });

  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
      out(HELP);
      return;

    case "doctor": {
      const r = await environmentReport(true);
      for (const p of r.providers) {
        out(`\n${p.label} [${p.id}]`);
        out(`  installed: ${p.installed}${p.version ? ` (${p.version})` : ""}   authenticated: ${p.authenticated}   method: ${p.authMethod ?? "-"}   automation allowed: ${p.automationAllowed}`);
        for (const n of p.notes) out(`  - ${n}`);
        if (p.error) out(`  ! ${p.error}`);
      }
      out("");
      if (r.billingEnvVars.length) out(`⚠ Billing-risk environment variables set: ${r.billingEnvVars.join(", ")}. The hub strips them from every child process, but other tools may use them.`);
      else out("✓ No API-key / pay-as-you-go environment variables detected.");
      return;
    }

    case "project": {
      if (sub === "add") {
        const settings: Partial<repo.ProjectSettings> = {};
        if (values.pm) settings.pmProvider = values.pm as repo.ProjectSettings["pmProvider"];
        if (values.dev) settings.devProvider = values.dev as repo.ProjectSettings["devProvider"];
        if (values.review) settings.reviewProvider = values.review as repo.ProjectSettings["reviewProvider"];
        if (values["test-cmd"]) settings.testCommand = values["test-cmd"].trim().split(/\s+/);
        if (values["allow-tests"]) settings.allowTestExecution = true;
        if (values["max-revisions"]) settings.maxRevisions = Number(values["max-revisions"]);
        const p = await repo.createProject({ name: values.name ?? "", repoPath: values.repo ?? "", githubUrl: values.github ?? null, description: values.description ?? "", settings });
        out(`Registered project ${p.name} [${p.id}] → ${p.repoPath} (verified git repository root)`);
        return;
      }
      if (sub === "list") {
        const ps = repo.listProjects();
        if (!ps.length) out("No projects registered. Use: npm run relay -- project add --name X --repo C:\\path\\to\\repo");
        for (const p of ps) out(`${p.id}  ${p.name.padEnd(20)} ${p.repoPath}   pm=${p.settings.pmProvider} dev=${p.settings.devProvider} review=${p.settings.reviewProvider}`);
        return;
      }
      if (sub === "show") {
        const p = resolveProject(positionals[0]);
        out(JSON.stringify({ ...p, memorySummary: p.memorySummary.slice(0, 2000) }, null, 2));
        out(`\nTasks:`);
        for (const t of repo.listTasks(p.id)) out(`  ${t.id}  ${t.status.padEnd(24)} ${t.title}`);
        return;
      }
      if (sub === "set") {
        const p = resolveProject(positionals[0]);
        const patch: Record<string, unknown> = {};
        for (const kv of positionals.slice(1)) {
          const i = kv.indexOf("=");
          if (i < 1) throw new HubError(`Expected key=value, got ${kv}`, "validation");
          const k = kv.slice(0, i);
          const v = kv.slice(i + 1);
          patch[k] = v === "true" ? true : v === "false" ? false : v === "null" ? null : /^\d+$/.test(v) ? Number(v) : k === "testCommand" ? v.split(/\s+/) : v;
        }
        const u = await repo.updateProject(p.id, { settings: patch as Partial<repo.ProjectSettings> });
        out(JSON.stringify(u.settings, null, 2));
        return;
      }
      if (sub === "import") {
        const p = resolveProject(positionals[0]);
        const file = positionals[1];
        if (!file || !fs.existsSync(file)) throw new HubError("File not found", "validation");
        const doc = repo.addContextDoc(p.id, values.title ?? path.basename(file), fs.readFileSync(file, "utf8"), `file:${path.basename(file)}`);
        out(`Imported "${doc.title}" (${doc.content.length} chars) into ${p.name}.`);
        return;
      }
      break;
    }

    case "task": {
      if (sub === "new") {
        const p = resolveProject(positionals[0]);
        const t = repo.createTask(p.id, { request: positionals[1] ?? "", type: (values.type as "feature") ?? "feature", maxRevisions: values["max-revisions"] ? Number(values["max-revisions"]) : undefined, autoAdvance: values["manual-steps"] ? false : undefined });
        out(`Created task ${t.id}: ${t.title}`);
        return;
      }
      if (sub === "list") {
        const ts = repo.listTasks(positionals[0] ? resolveProject(positionals[0]).id : undefined);
        for (const t of ts) out(`${t.id}  ${t.status.padEnd(24)} r${t.revisionRound}/${t.maxRevisions}  ${t.title}`);
        if (!ts.length) out("No tasks.");
        return;
      }
      const id = positionals[0];
      if (!id) throw new HubError("Task id required", "validation");
      switch (sub) {
        case "show":
          printTask(id, true);
          return;
        case "spec":
          orch.startPm(id, { feedback: values.feedback });
          return waitAndPrint(id);
        case "approve":
          orch.approveSpec(id, { authorizeExecution: !!values["authorize-execution"], note: values.note });
          return waitAndPrint(id);
        case "authorize":
          orch.authorizeExecution(id, values.note);
          out("Execution authorised.");
          return;
        case "approve-dirty":
          orch.approveDirtyTree(id, values.note);
          out("Dirty-tree dispatch approved.");
          return;
        case "dispatch":
          await orch.dispatchDev(id);
          return waitAndPrint(id);
        case "ingest":
          await orch.ingestResult(id, values.file ? fs.readFileSync(values.file, "utf8") : undefined);
          return waitAndPrint(id);
        case "review":
          orch.startReview(id);
          return waitAndPrint(id);
        case "decide":
          orch.humanDecision(id, positionals[1] as orch.HumanAction, values.note);
          return waitAndPrint(id);
        case "pause":
          orch.pause(id);
          return waitAndPrint(id, false);
        case "resume":
        case "retry":
          await orch.resume(id);
          return waitAndPrint(id);
        case "cancel":
          orch.cancel(id, values.note);
          return waitAndPrint(id, false);
      }
      break;
    }

    case "run": {
      const p = resolveProject(positionals[0]);
      await runCycle(p, positionals[1] ?? "", !!values.yes);
      return;
    }

    case "demo": {
      const real = !!values.real;
      out(real ? "Creating sample repo for a REAL cycle (Codex PM/review + Claude Code developer, via your subscriptions)…" : "Creating sample repo for an offline MOCK cycle…");
      const repoPath = await createSampleRepo();
      const p = await repo.createProject({
        name: `${real ? "Sample (real)" : "Sample (mock)"} ${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
        repoPath,
        description: "Tiny JavaScript math library used to demonstrate DevRelay safely.",
        productGoals: "Provide small, well-tested arithmetic helpers.",
        constraints: "Plain ES modules, no dependencies. Tests use node:test (run with `node --test`).",
        instructions: "Keep changes minimal. Every new function needs a test.",
        settings: real
          ? { pmProvider: "codex", devProvider: "claude-cli", reviewProvider: "codex", testCommand: ["node", "--test"], allowTestExecution: true, maxRevisions: 2 }
          : { pmProvider: "mock", devProvider: "mock", reviewProvider: "mock", testCommand: ["node", "--test"], allowTestExecution: true, maxRevisions: 2 },
      });
      out(`Registered ${p.name} → ${repoPath}`);
      const request = real
        ? "Add a multiply(a, b) function to src/math.js and a node:test test for it in test/math.test.js. Keep the existing add function unchanged."
        : "Add a multiply(a, b) helper with a test [mock:changes-once]";
      await runCycle(p, request, true);
      return;
    }
  }
  out(HELP);
  process.exitCode = 1;
}

async function runCycle(p: repo.Project, request: string, yes: boolean) {
  const t = repo.createTask(p.id, { request });
  out(`\n[1/4] PM (${p.settings.pmProvider}) drafting specification for task ${t.id}…`);
  orch.startPm(t.id);
  await waitForIdle(t.id);
  let cur = repo.getTask(t.id);
  if (cur.status !== "spec_review") return printTask(t.id, true);
  out(`\nSpecification: ${cur.spec!.title}`);
  for (const a of cur.spec!.acceptanceCriteria) out(`  ${a.id}: ${a.description}`);
  for (const q of cur.spec!.openQuestions) out(`  ? ${q.id}${q.blocking ? " (blocking)" : ""}: ${q.question}`);
  if (!yes) {
    out(`\nStopped for your approval. Approve with:\n  npm run relay -- task approve ${t.id} --authorize-execution`);
    return;
  }
  out(`\n[2/4] Approving spec and authorising code changes in an isolated worktree (--yes)…`);
  out(`[3/4] Developer (${p.settings.devProvider}) → [4/4] Reviewer (${p.settings.reviewProvider}), up to ${cur.maxRevisions} revision round(s)…`);
  orch.approveSpec(t.id, { authorizeExecution: true, note: "Approved via CLI --yes" });
  await waitForIdle(t.id);
  printTask(t.id, true);
  cur = repo.getTask(t.id);
  if (cur.status === "awaiting_merge_approval") {
    out(`\n✔ Reviewer approved. Nothing has been merged. Inspect the branch:`);
    out(`  git -C "${cur.worktreePath}" log --oneline -5`);
    out(`  git -C "${p.repoPath}" diff ${cur.baseCommit?.slice(0, 12)}...${cur.branch}   (committed changes)`);
    out(`  git -C "${cur.worktreePath}" status   (uncommitted changes, if any)`);
    out(`Record your decision with: npm run relay -- task decide ${t.id} approve_merge`);
  } else if (cur.status === "awaiting_dev_result") {
    out(`\nManual handoff: follow the command in the timeline above, then: npm run relay -- task ingest ${t.id}`);
  }
}

main()
  .catch((e) => {
    const kind = e instanceof HubError ? ` (${e.kind})` : "";
    process.stderr.write(`Error${kind}: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
