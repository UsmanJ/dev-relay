/**
 * Orchestrator: drives a task through PM -> Developer -> Reviewer, with human
 * gates. Every automated step is user-initiated (or auto-advanced from a
 * user-initiated step), bounded by the revision limit, and stops immediately on
 * auth/usage-limit/validation errors or when a human decision is needed.
 *
 * Never merges, pushes or deploys.
 */
import fs from "node:fs";
import path from "node:path";
import { handoffDir, LIMITS } from "./config";
import { captureDiff, createWorktree, assertHubWorktree, branchNameFor, verifyRepo, type DiffSummary } from "./git";
import { cancelJob, startJob, track, activeJob, canStartJob } from "./jobs";
import { developerTaskMarkdown, pmPrompt, reviewerPrompt, type PromptContext, type TestEvidence } from "./prompts";
import { resolveCommand, runProcess, subscriptionEnv } from "./process";
import { assertProviderUsable, getAgent, isManualProvider } from "./providers/registry";
import type { AgentOutcome, ProviderId } from "./providers/types";
import { redact } from "./redact";
import * as repo from "./repo";
import { ImplementationResult, ReviewResult, TaskSpecification, parseStructured, toProviderJsonSchema, type AgentRole } from "./schemas";
import { afterChangesRequested, RUNNING, stableBefore, TERMINAL, type TaskStatus } from "./state";
import { HubError, truncate, type ErrorKind } from "./util";

/* --------------------------------- Helpers --------------------------------- */

function promptContext(projectId: string): PromptContext {
  const project = repo.getProject(projectId);
  return {
    project,
    decisions: repo.listDecisions(projectId, 15),
    contextDocs: repo.listContextDocs(projectId).filter((d) => d.includeInPrompts),
  };
}

function modelFor(p: repo.Project, provider: string): string | null {
  if (provider === "codex") return p.settings.codexModel;
  if (provider.startsWith("claude")) return p.settings.claudeModel;
  return null;
}

function timeoutMs(p: repo.Project): number {
  return Math.min(p.settings.providerTimeoutMinutes * 60_000, LIMITS.maxProviderTimeoutMs);
}

/** Move to failed, remembering which stable state a retry should return to. Ignores races with cancel/pause. */
function failTask(taskId: string, from: TaskStatus, kind: ErrorKind, error: string, role: AgentRole, provider: string) {
  const resumeTo = stableBefore(from);
  try {
    repo.transitionTask(taskId, "failed", "system", `${kind}: ${error}`, { lastError: redact(error).slice(0, 2000), lastErrorKind: kind, pausedFrom: resumeTo }, from);
  } catch (e) {
    if (e instanceof HubError && e.kind === "conflict") return; // task was cancelled/paused meanwhile
    throw e;
  }
  repo.addMessage({ taskId, role: "system", provider, kind: "error", round: repo.getTask(taskId).revisionRound, body: `${role} step failed (${kind}): ${error}`, payload: { kind, role }, refs: null });
}

/** Run a structured agent with run bookkeeping. */
async function runAgent<T>(opts: {
  task: repo.Task;
  role: AgentRole;
  provider: ProviderId;
  schema: import("zod").ZodType<T>;
  prompt: string;
  cwd: string;
  access: "read-only" | "workspace-write";
  signal: AbortSignal;
  meta?: Record<string, unknown>;
  model?: string | null;
}): Promise<{ outcome: AgentOutcome<T>; runId: string }> {
  const project = repo.getProject(opts.task.projectId);
  const runId = repo.startRun({ taskId: opts.task.id, projectId: project.id, provider: opts.provider, role: opts.role });
  const usable = await assertProviderUsable(opts.provider, opts.role === "pm" || opts.role === "developer" || opts.role === "reviewer" ? opts.role : undefined);
  if (!usable.ok) {
    repo.finishRun(runId, { status: "failed", errorKind: usable.kind, error: usable.message, durationMs: 0 });
    return { outcome: { ok: false, errorKind: usable.kind, error: usable.message, durationMs: 0 }, runId };
  }
  const agent = getAgent(opts.provider);
  if (!agent) {
    const error = `Provider ${opts.provider} cannot be invoked automatically.`;
    repo.finishRun(runId, { status: "failed", errorKind: "permission", error, durationMs: 0 });
    return { outcome: { ok: false, errorKind: "permission", error, durationMs: 0 }, runId };
  }
  let outcome: AgentOutcome<T>;
  try {
    outcome = await agent.run({
      role: opts.role,
      prompt: opts.prompt,
      schema: opts.schema,
      cwd: opts.cwd,
      timeoutMs: timeoutMs(project),
      signal: opts.signal,
      access: opts.access,
      model: opts.model ?? null,
      meta: { taskId: opts.task.id, projectId: project.id, request: opts.task.request, round: opts.task.revisionRound, ...opts.meta },
    });
  } catch (e) {
    outcome = { ok: false, errorKind: "internal", error: (e as Error).message, durationMs: 0 };
  }
  repo.finishRun(runId, {
    status: outcome.ok ? "succeeded" : outcome.errorKind === "cancelled" ? "cancelled" : "failed",
    errorKind: outcome.ok ? null : outcome.errorKind,
    error: outcome.ok ? null : outcome.error,
    exitCode: outcome.ok ? 0 : (outcome.exitCode ?? null),
    durationMs: outcome.durationMs,
    usage: outcome.ok ? outcome.usage : undefined,
    stdout: outcome.raw,
    stderr: outcome.stderr,
  });
  return { outcome, runId };
}

/** Kick off the next automatic step (if any) as tracked background work. */
function assertCanStart(taskId: string) {
  const c = canStartJob(taskId);
  if (!c.ok) throw new HubError(c.reason, "conflict", 409);
}

function chain(taskId: string, fn: () => Promise<unknown> | unknown) {
  track(
    taskId,
    (async () => {
      try {
        // Let the job that triggered this chain finish and unregister first.
        for (let i = 0; activeJob(taskId) && i < 500; i++) await new Promise((r) => setTimeout(r, 10));
        await fn();
      } catch (e) {
        const t = repo.getTask(taskId);
        if (!TERMINAL.has(t.status) && t.status !== "failed" && t.status !== "paused") {
          repo.addMessage({ taskId, role: "system", provider: "hub", kind: "error", round: t.revisionRound, body: `Automatic next step did not start: ${(e as Error).message}`, payload: null, refs: null });
        }
      }
    })(),
  ).catch(() => undefined);
}

/* ------------------------------------ PM ----------------------------------- */

/** Ask the PM to draft (or redraft with feedback) the specification. */
export function startPm(taskId: string, opts: { feedback?: string | null } = {}): repo.Task {
  const task = repo.getTask(taskId);
  const project = repo.getProject(task.projectId);
  assertCanStart(taskId);
  if (opts.feedback) repo.addMessage({ taskId, role: "human", provider: "human", kind: "spec_feedback", round: task.revisionRound, body: opts.feedback, payload: null, refs: null });
  const t = repo.transitionTask(taskId, "pm_running", "human", opts.feedback ? "Regenerate spec with feedback" : "Draft specification", {}, ["draft", "spec_review"]);
  startJob(taskId, "pm", async (signal) => {
    const prompt = pmPrompt(promptContext(project.id), task.request, { previousSpec: task.spec, feedback: opts.feedback ?? null });
    const { outcome, runId } = await runAgent({ task: t, role: "pm", provider: project.settings.pmProvider, schema: TaskSpecification, prompt, cwd: project.repoPath, access: "read-only", signal, meta: { feedback: opts.feedback ?? null }, model: modelFor(project, project.settings.pmProvider) });
    if (!outcome.ok) {
      if (outcome.errorKind !== "cancelled") failTask(taskId, "pm_running", outcome.errorKind, outcome.error, "pm", project.settings.pmProvider);
      return;
    }
    const spec = outcome.value;
    try {
      repo.transitionTask(taskId, "spec_review", "pm", "Specification drafted", { spec, title: spec.title, type: spec.type }, "pm_running");
    } catch (e) {
      if (e instanceof HubError && e.kind === "conflict") return;
      throw e;
    }
    repo.addMessage({ taskId, role: "pm", provider: project.settings.pmProvider, kind: "specification", round: t.revisionRound, body: spec.summary, payload: spec, refs: { branch: null, commit: null, worktree: null, runId } });
    const blocking = spec.openQuestions.filter((q) => q.blocking);
    repo.createApproval(taskId, "spec", "Approve the PM specification", blocking.length ? `The PM raised ${blocking.length} blocking question(s). Answer them via feedback, or approve if you accept the assumptions.` : "Review, edit if needed, and approve to hand off to the developer.");
  });
  return repo.getTask(taskId);
}

/** Human edits to the spec while it awaits approval. */
export function updateSpec(taskId: string, spec: unknown): repo.Task {
  const task = repo.getTask(taskId);
  if (task.status !== "spec_review") throw new HubError("The specification can only be edited while awaiting approval.", "conflict", 409);
  const parsed = TaskSpecification.safeParse(spec);
  if (!parsed.success) throw new HubError(`Invalid specification: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "validation");
  repo.addMessage({ taskId, role: "human", provider: "human", kind: "note", round: task.revisionRound, body: "Specification edited by human.", payload: parsed.data, refs: null });
  return repo.patchTask(taskId, { spec: parsed.data, title: parsed.data.title, type: parsed.data.type });
}

/**
 * Approve the spec. `authorizeExecution` is the explicit permission for the
 * developer agent to modify code (in an isolated worktree on a new branch).
 */
export function approveSpec(taskId: string, opts: { authorizeExecution: boolean; note?: string }): repo.Task {
  const task = repo.getTask(taskId);
  if (!task.spec) throw new HubError("No specification to approve.", "validation");
  const t = repo.transitionTask(taskId, "spec_approved", "human", opts.note || "Specification approved", { specApprovedAt: new Date().toISOString() }, "spec_review");
  repo.decidePendingApprovals(taskId, "spec", true, opts.note);
  repo.addMessage({ taskId, role: "human", provider: "human", kind: "spec_approved", round: t.revisionRound, body: opts.note || "Specification approved.", payload: { authorizeExecution: opts.authorizeExecution }, refs: null });
  if (opts.authorizeExecution) authorizeExecution(taskId);
  else repo.createApproval(taskId, "execution", "Authorise the developer to modify code", "The developer agent will work in an isolated git worktree on a new branch. Nothing is merged or pushed.");
  if (opts.authorizeExecution && t.autoAdvance) chain(taskId, () => dispatchDev(taskId));
  return repo.getTask(taskId);
}

export function authorizeExecution(taskId: string, note?: string): void {
  const task = repo.getTask(taskId);
  repo.createApproval(taskId, "execution", "Authorise the developer to modify code", "Isolated worktree on a new branch. Nothing is merged or pushed.");
  repo.decidePendingApprovals(taskId, "execution", true, note);
  repo.addMessage({ taskId, role: "human", provider: "human", kind: "approval_decision", round: task.revisionRound, body: "Execution authorised: developer may modify code in an isolated worktree.", payload: { kind: "execution", approved: true }, refs: null });
}

function executionAuthorised(taskId: string): boolean {
  return repo.listApprovals(taskId).some((a) => a.kind === "execution" && a.status === "approved");
}

function dirtyTreeApproved(taskId: string): boolean {
  return repo.listApprovals(taskId).some((a) => a.kind === "dirty_tree" && a.status === "approved");
}

/* -------------------------------- Developer -------------------------------- */

/** Ensure the task has its isolated worktree, creating it (after safety checks) if needed. */
async function ensureWorktree(task: repo.Task, project: repo.Project): Promise<repo.Task> {
  if (task.worktreePath && fs.existsSync(task.worktreePath)) {
    assertHubWorktree(task.worktreePath);
    return task;
  }
  const info = await verifyRepo(project.repoPath);
  if (info.dirty && !project.settings.allowDirtyRepo && !dirtyTreeApproved(task.id)) {
    repo.createApproval(task.id, "dirty_tree", "Main repository has uncommitted changes", `The registered repository has ${info.dirtyFiles.length} uncommitted change(s). The developer works in a separate worktree from ${project.settings.baseRef} and will not touch them, but uncommitted work will NOT be included. Approve to continue.\n\n${info.dirtyFiles.slice(0, 20).join("\n")}`);
    throw new HubError("Main repository working tree is dirty. Approve the 'dirty tree' request to continue.", "permission", 409);
  }
  if (!info.headCommit) throw new HubError("Repository has no commits yet; create an initial commit first.", "git");
  const branch = branchNameFor(task.id, task.title);
  const wt = await createWorktree(project.repoPath, task.id, branch, project.settings.baseRef);
  repo.addMessage({ taskId: task.id, role: "system", provider: "git", kind: "note", round: task.revisionRound, body: `Created isolated worktree on new branch ${wt.branch} from ${wt.baseRef} (${wt.baseCommit.slice(0, 10)}).`, payload: wt, refs: { branch: wt.branch, commit: wt.baseCommit, worktree: wt.path, runId: null } });
  return repo.patchTask(task.id, { worktreePath: wt.path, branch: wt.branch, baseRef: wt.baseRef, baseCommit: wt.baseCommit });
}

function latestReview(taskId: string): ReviewResult | null {
  const m = repo.latestMessage(taskId, "review_result") ?? repo.latestMessage(taskId, "revision_request");
  const r = ReviewResult.safeParse(m?.payload);
  return r.success ? r.data : null;
}

function latestImplementation(taskId: string): ImplementationResult | null {
  const r = ImplementationResult.safeParse(repo.latestMessage(taskId, "implementation_result")?.payload);
  return r.success ? r.data : null;
}

/**
 * Hand the approved spec (or reviewer feedback) to the developer.
 * Requires explicit execution authorisation.
 */
export async function dispatchDev(taskId: string): Promise<repo.Task> {
  let task = repo.getTask(taskId);
  const project = repo.getProject(task.projectId);
  if (task.status !== "spec_approved" && task.status !== "changes_requested") throw new HubError(`Cannot dispatch to developer from status ${task.status}.`, "conflict", 409);
  if (!task.spec) throw new HubError("Task has no approved specification.", "validation");
  if (!executionAuthorised(taskId)) {
    repo.createApproval(taskId, "execution", "Authorise the developer to modify code", "Isolated worktree on a new branch. Nothing is merged or pushed.");
    throw new HubError("Execution has not been authorised for this task.", "permission", 403);
  }
  if (!isManualProvider(project.settings.devProvider)) assertCanStart(taskId);
  const from = task.status;
  const isRevision = from === "changes_requested";
  try {
    task = await ensureWorktree(task, project);
  } catch (e) {
    if (e instanceof HubError && e.kind === "permission") throw e;
    failTask(taskId, from, e instanceof HubError ? e.kind : "git", (e as Error).message, "developer", "git");
    throw e;
  }
  const round = isRevision ? task.revisionRound + 1 : task.revisionRound;
  const feedback = isRevision ? latestReview(taskId) : null;
  const previous = isRevision ? latestImplementation(taskId) : null;
  const ctx = promptContext(project.id);
  const dir = handoffDir(taskId);
  const roundDir = path.join(dir, `round-${round}`);
  fs.mkdirSync(roundDir, { recursive: true });
  const resultPath = path.join(roundDir, "RESULT.json");
  const schemaPath = path.join(roundDir, "result.schema.json");
  fs.writeFileSync(schemaPath, JSON.stringify(toProviderJsonSchema(ImplementationResult), null, 2));
  const spec = task.spec;
  if (!spec) throw new HubError("Task has no approved specification.", "validation");
  const markdown = developerTaskMarkdown({ ctx, taskId, spec, round, branch: task.branch, worktreePath: task.worktreePath!, resultPath, schemaPath, feedback, previousResult: previous, testCommand: project.settings.testCommand });
  fs.writeFileSync(path.join(roundDir, "TASK.md"), markdown);
  const refs = { branch: task.branch, commit: task.baseCommit, worktree: task.worktreePath, runId: null };

  if (isManualProvider(project.settings.devProvider)) {
    const t = repo.transitionTask(taskId, "awaiting_dev_result", "system", isRevision ? `Revision round ${round} handed off (manual)` : "Handed off to developer (manual)", { revisionRound: round }, from);
    const command = `cd "${task.worktreePath}"; claude --add-dir "${roundDir}" "Read ${path.join(roundDir, "TASK.md")} and complete the task. Write the result JSON exactly where it says."`;
    repo.addMessage({ taskId, role: "system", provider: "claude-manual", kind: "dev_handoff", round, body: `Manual Claude Code handoff ready. Run in PowerShell:\n\n${command}\n\nThen click "Ingest result" (or run: npm run relay -- task ingest ${taskId}).`, payload: { taskFile: path.join(roundDir, "TASK.md"), resultPath, schemaPath, command }, refs });
    return t;
  }

  // Automated developer (claude-cli or mock).
  const t = repo.transitionTask(taskId, "dev_running", "system", isRevision ? `Revision round ${round} started` : "Developer started", { revisionRound: round }, from);
  repo.addMessage({ taskId, role: "system", provider: project.settings.devProvider, kind: "dev_handoff", round, body: `Task package sent to developer (${project.settings.devProvider}) in worktree ${task.worktreePath}.`, payload: { taskFile: path.join(roundDir, "TASK.md") }, refs });
  try {
    startJob(taskId, "developer", async (signal) => {
      const prompt = `${markdown}\n\nIMPORTANT: Instead of writing RESULT.json, return the result as your final structured output (it is validated against the same schema).`;
      const { outcome, runId } = await runAgent({ task: t, role: "developer", provider: project.settings.devProvider, schema: ImplementationResult, prompt, cwd: t.worktreePath!, access: "workspace-write", signal, meta: { testCommand: project.settings.testCommand }, model: modelFor(project, project.settings.devProvider) });
      if (!outcome.ok) {
        if (outcome.errorKind !== "cancelled") failTask(taskId, "dev_running", outcome.errorKind, outcome.error, "developer", project.settings.devProvider);
        return;
      }
      fs.writeFileSync(resultPath, JSON.stringify(outcome.value, null, 2));
      await afterImplementation(taskId, "dev_running", outcome.value, project.settings.devProvider, runId, signal);
    });
  } catch (e) {
    failTask(taskId, "dev_running", e instanceof HubError ? e.kind : "internal", (e as Error).message, "developer", project.settings.devProvider);
    throw e;
  }
  return repo.getTask(taskId);
}

/** Manual mode: ingest the developer's RESULT.json (or pasted JSON). */
export async function ingestResult(taskId: string, rawJson?: string): Promise<repo.Task> {
  const task = repo.getTask(taskId);
  if (task.status !== "awaiting_dev_result") throw new HubError(`Task is not awaiting a developer result (status: ${task.status}).`, "conflict", 409);
  let raw = rawJson;
  if (!raw) {
    const p = path.join(handoffDir(taskId), `round-${task.revisionRound}`, "RESULT.json");
    if (!fs.existsSync(p)) throw new HubError(`No result file yet at ${p}. Run Claude Code with the handoff command first.`, "validation");
    raw = fs.readFileSync(p, "utf8");
  }
  const parsed = parseStructured(ImplementationResult, raw);
  if (!parsed.ok) {
    repo.addMessage({ taskId, role: "system", provider: "claude-manual", kind: "error", round: task.revisionRound, body: `Developer result rejected: ${parsed.error}`, payload: null, refs: null });
    throw new HubError(parsed.error, "malformed_output");
  }
  const controller = new AbortController();
  await afterImplementation(taskId, "awaiting_dev_result", parsed.value, "claude-manual", null, controller.signal);
  return repo.getTask(taskId);
}

/** Run the project's test command (argv, no shell) inside the worktree, if permitted. */
async function runTests(project: repo.Project, cwd: string, signal: AbortSignal): Promise<TestEvidence> {
  const argv = project.settings.testCommand;
  if (!argv) return { ranByHub: false, command: null, exitCode: null, passed: null, output: "", reason: "no test command configured" };
  if (!project.settings.allowTestExecution) return { ranByHub: false, command: argv.join(" "), exitCode: null, passed: null, output: "", reason: "test execution not permitted in project settings" };
  assertHubWorktree(cwd);
  const cmd = resolveCommand(argv[0]!);
  if (!cmd) return { ranByHub: false, command: argv.join(" "), exitCode: null, passed: null, output: "", reason: `test program not found: ${argv[0]}` };
  const res = await runProcess({ command: cmd, args: argv.slice(1), cwd, signal, timeoutMs: project.settings.testTimeoutMinutes * 60_000, env: { ...subscriptionEnv(), CI: "1" }, maxStdoutBytes: 2 * 1024 * 1024 });
  const output = redact(truncate(`${res.stdout}\n${res.stderr}`.trim(), 20_000));
  if (res.cancelled) return { ranByHub: false, command: argv.join(" "), exitCode: null, passed: null, output, reason: "cancelled" };
  return { ranByHub: true, command: argv.join(" "), exitCode: res.exitCode, passed: res.exitCode === 0 && !res.timedOut, output: res.timedOut ? `TIMED OUT\n${output}` : output };
}

async function collectEvidence(taskId: string, signal: AbortSignal): Promise<{ diff: DiffSummary; tests: TestEvidence }> {
  const task = repo.getTask(taskId);
  const project = repo.getProject(task.projectId);
  if (!task.worktreePath || !task.baseCommit) throw new HubError("Task has no worktree.", "git");
  assertHubWorktree(task.worktreePath);
  const diff = await captureDiff(task.worktreePath, task.baseCommit);
  const tests = await runTests(project, task.worktreePath, signal);
  return { diff, tests };
}

async function afterImplementation(taskId: string, from: TaskStatus, result: ImplementationResult, provider: string, runId: string | null, signal: AbortSignal) {
  const task = repo.getTask(taskId);
  const refs = { branch: task.branch, commit: null, worktree: task.worktreePath, runId };
  repo.addMessage({ taskId, role: "developer", provider, kind: "implementation_result", round: task.revisionRound, body: result.summary, payload: result, refs });
  let evidence: { diff: DiffSummary; tests: TestEvidence };
  try {
    evidence = await collectEvidence(taskId, signal);
  } catch (e) {
    failTask(taskId, from, e instanceof HubError ? e.kind : "git", (e as Error).message, "developer", "git");
    return;
  }
  const { diff, tests } = evidence;
  repo.addMessage({
    taskId,
    role: "system",
    provider: "hub",
    kind: "evidence",
    round: task.revisionRound,
    body: `Diff: ${diff.changedFiles.length} file(s) changed, ${diff.commits.length} commit(s). Tests: ${tests.ranByHub ? (tests.passed ? "PASSED" : `FAILED (exit ${tests.exitCode})`) : `not run by hub (${tests.reason})`}.`,
    payload: { stat: diff.stat, changedFiles: diff.changedFiles, commits: diff.commits, headCommit: diff.headCommit, uncommittedChanges: diff.uncommittedChanges, diff: truncate(diff.diff, 60_000), untracked: diff.untracked.map((u) => ({ path: u.path, content: truncate(u.content, 4000) })), tests },
    refs: { ...refs, commit: diff.headCommit },
  });

  if (result.status === "blocked" || result.questions.some((q) => q.blocking && q.addressedTo === "human")) {
    try {
      repo.transitionTask(taskId, "human_decision_required", "developer", "Developer is blocked or raised blocking questions", {}, from);
    } catch (e) {
      if (e instanceof HubError && e.kind === "conflict") return;
      throw e;
    }
    repo.createApproval(taskId, "decision", "Developer needs a decision", result.questions.map((q) => `${q.id}: ${q.question}`).join("\n") || result.summary);
    return;
  }
  let t: repo.Task;
  try {
    t = repo.transitionTask(taskId, "review_pending", "developer", "Implementation submitted", {}, from);
  } catch (e) {
    if (e instanceof HubError && e.kind === "conflict") return;
    throw e;
  }
  if (t.autoAdvance) chain(taskId, () => startReview(taskId));
}

/* --------------------------------- Reviewer -------------------------------- */

export function startReview(taskId: string): repo.Task {
  const task = repo.getTask(taskId);
  const project = repo.getProject(task.projectId);
  if (!task.spec) throw new HubError("Task has no specification.", "validation");
  const result = latestImplementation(taskId);
  if (!result) throw new HubError("No implementation result to review.", "validation");
  assertCanStart(taskId);
  const t = repo.transitionTask(taskId, "review_running", "system", `Review round ${task.revisionRound}`, {}, "review_pending");
  startJob(taskId, "reviewer", async (signal) => {
    let evidence: { diff: DiffSummary; tests: TestEvidence };
    try {
      // Re-capture the diff at review time; reuse the hub's test evidence from ingestion.
      const diff = await captureDiff(t.worktreePath!, t.baseCommit!);
      const ev = repo.latestMessage(taskId, "evidence")?.payload as { tests?: TestEvidence } | null;
      evidence = { diff, tests: ev?.tests ?? { ranByHub: false, command: null, exitCode: null, passed: null, output: "", reason: "no evidence recorded" } };
    } catch (e) {
      failTask(taskId, "review_running", "git", (e as Error).message, "reviewer", "git");
      return;
    }
    const prompt = reviewerPrompt(promptContext(project.id), { spec: t.spec!, result, diff: evidence.diff, tests: evidence.tests, round: t.revisionRound, maxRevisions: t.maxRevisions });
    const { outcome, runId } = await runAgent({ task: t, role: "reviewer", provider: project.settings.reviewProvider, schema: ReviewResult, prompt, cwd: t.worktreePath!, access: "read-only", signal, meta: { changedFilesCount: evidence.diff.changedFiles.length }, model: modelFor(project, project.settings.pmProvider) });
    if (!outcome.ok) {
      if (outcome.errorKind !== "cancelled") failTask(taskId, "review_running", outcome.errorKind, outcome.error, "reviewer", project.settings.reviewProvider);
      return;
    }
    applyReview(taskId, outcome.value, project.settings.reviewProvider, runId);
  });
  return repo.getTask(taskId);
}

function applyReview(taskId: string, review: ReviewResult, provider: string, runId: string) {
  const task = repo.getTask(taskId);
  const refs = { branch: task.branch, commit: null, worktree: task.worktreePath, runId };
  // Defence in depth: an APPROVED verdict with unmet criteria is not accepted as approval.
  let verdict = review.verdict;
  if (verdict === "APPROVED" && review.criteria.some((c) => c.status === "not_met")) verdict = "HUMAN_DECISION_REQUIRED";
  repo.addMessage({ taskId, role: "reviewer", provider, kind: "review_result", round: task.revisionRound, body: `${review.verdict}${verdict !== review.verdict ? ` (downgraded to ${verdict}: unmet criteria)` : ""}: ${review.summary}`, payload: review, refs });

  const go = (to: TaskStatus, reason: string) => {
    try {
      return repo.transitionTask(taskId, to, "reviewer", reason, {}, "review_running");
    } catch (e) {
      if (e instanceof HubError && e.kind === "conflict") return null;
      throw e;
    }
  };

  if (verdict === "APPROVED") {
    if (!go("awaiting_merge_approval", "Reviewer approved")) return;
    repo.createApproval(taskId, "merge", "Reviewer approved — your merge decision", `Branch ${task.branch} in worktree ${task.worktreePath}. The hub will NOT merge. Review the diff and merge manually if you agree.`);
    return;
  }
  if (verdict === "CHANGES_REQUESTED") {
    const next = afterChangesRequested(task.revisionRound, task.maxRevisions);
    if (next === "human_decision_required") {
      if (!go("human_decision_required", `Revision limit reached (${task.maxRevisions})`)) return;
      repo.createApproval(taskId, "decision", "Revision limit reached", `The reviewer still requests changes after ${task.revisionRound} revision round(s) (limit ${task.maxRevisions}). Grant another round, accept as-is, re-spec, or reject.`);
      return;
    }
    const t = go("changes_requested", "Reviewer requested changes");
    if (!t) return;
    repo.addMessage({ taskId, role: "reviewer", provider, kind: "revision_request", round: task.revisionRound, body: review.requestedChanges.map((c) => `- ${c}`).join("\n") || review.summary, payload: review, refs });
    if (t.autoAdvance) chain(taskId, () => dispatchDev(taskId));
    return;
  }
  if (!go("human_decision_required", "Reviewer requires a human decision")) return;
  repo.createApproval(taskId, "decision", "Reviewer requires your decision", [review.summary, ...review.questionsForHuman].join("\n"));
}

/* ------------------------------ Human decisions ---------------------------- */

export type HumanAction = "approve_merge" | "request_changes" | "reject" | "grant_revision" | "accept" | "respec" | "rereview";

export function humanDecision(taskId: string, action: HumanAction, note?: string): repo.Task {
  const task = repo.getTask(taskId);
  const msg = (body: string) => repo.addMessage({ taskId, role: "human", provider: "human", kind: "approval_decision", round: task.revisionRound, body, payload: { action, note: note ?? null }, refs: null });

  switch (action) {
    case "approve_merge": {
      const t = repo.transitionTask(taskId, "completed", "human", note || "Approved for merge", {}, "awaiting_merge_approval");
      repo.decidePendingApprovals(taskId, "merge", true, note);
      msg(`Approved. Merge manually when ready:\n\ngit -C "${repo.getProject(task.projectId).repoPath}" merge --no-ff ${task.branch}\n\nThe hub never merges, pushes or deletes branches/worktrees.`);
      recordCompletion(t);
      return t;
    }
    case "request_changes": {
      if (!note?.trim()) throw new HubError("Describe the changes you want.", "validation");
      const t = repo.transitionTask(taskId, "changes_requested", "human", "Human requested changes", task.revisionRound >= task.maxRevisions ? { maxRevisions: task.revisionRound + 1 } : {}, ["awaiting_merge_approval", "human_decision_required"]);
      repo.decidePendingApprovals(taskId, "merge", false, note);
      repo.decidePendingApprovals(taskId, "decision", false, note);
      const review: ReviewResult = { verdict: "CHANGES_REQUESTED", summary: `Human feedback: ${note}`, criteria: [], requestedChanges: [note.slice(0, 2000)], concerns: [], questionsForHuman: [] };
      repo.addMessage({ taskId, role: "human", provider: "human", kind: "revision_request", round: task.revisionRound, body: note, payload: review, refs: null });
      if (t.autoAdvance && executionAuthorised(taskId)) chain(taskId, () => dispatchDev(taskId));
      return t;
    }
    case "grant_revision": {
      const t = repo.transitionTask(taskId, "changes_requested", "human", "Human granted another revision round", { maxRevisions: Math.min(Math.max(task.maxRevisions, task.revisionRound + 1), LIMITS.maxRevisionsCeiling + 5) }, "human_decision_required");
      repo.decidePendingApprovals(taskId, "decision", true, note);
      msg(`Granted another revision round.${note ? ` Note: ${note}` : ""}`);
      if (note) repo.addMessage({ taskId, role: "human", provider: "human", kind: "revision_request", round: task.revisionRound, body: note, payload: { verdict: "CHANGES_REQUESTED", summary: `Human guidance: ${note}`, criteria: [], requestedChanges: [note.slice(0, 2000)], concerns: [], questionsForHuman: [] }, refs: null });
      if (t.autoAdvance && executionAuthorised(taskId)) chain(taskId, () => dispatchDev(taskId));
      return t;
    }
    case "accept": {
      const t = repo.transitionTask(taskId, "awaiting_merge_approval", "human", note || "Human accepted despite reviewer concerns", {}, "human_decision_required");
      repo.decidePendingApprovals(taskId, "decision", true, note);
      repo.createApproval(taskId, "merge", "Your merge decision", `Branch ${task.branch}. The hub will NOT merge.`);
      msg("Accepted for merge decision.");
      return t;
    }
    case "respec": {
      const t = repo.transitionTask(taskId, "spec_review", "human", "Back to specification", {}, "human_decision_required");
      repo.decidePendingApprovals(taskId, "decision", true, note);
      repo.createApproval(taskId, "spec", "Re-approve the specification", note ?? "");
      msg(`Returned to specification.${note ? ` ${note}` : ""}`);
      return t;
    }
    case "rereview": {
      const t = repo.transitionTask(taskId, "review_pending", "human", "Re-run review", {}, "human_decision_required");
      msg("Requested a fresh review.");
      if (t.autoAdvance) chain(taskId, () => startReview(taskId));
      return t;
    }
    case "reject": {
      const t = repo.transitionTask(taskId, "rejected", "human", note || "Rejected", {}, ["spec_review", "awaiting_merge_approval", "human_decision_required"]);
      for (const k of ["spec", "merge", "decision", "execution"] as const) repo.decidePendingApprovals(taskId, k, false, note);
      msg(`Rejected.${note ? ` ${note}` : ""} Branch and worktree are left in place for you to inspect or delete manually.`);
      return t;
    }
  }
}

function recordCompletion(task: repo.Task) {
  const impl = latestImplementation(task.id);
  for (const d of impl?.decisions ?? []) repo.addDecision(task.projectId, { title: d.title, decision: d.decision, rationale: d.rationale, taskId: task.id, source: "developer" });
  const project = repo.getProject(task.projectId);
  const line = `- ${new Date().toISOString().slice(0, 10)} [${task.type}] ${task.title} (branch ${task.branch}): ${truncate(impl?.summary ?? "", 300).replace(/\s+/g, " ")}`;
  repo.setProjectMemory(project.id, `${project.memorySummary}\n${line}`.trim());
}

/* ------------------------- Pause / resume / cancel ------------------------- */

export function pause(taskId: string): repo.Task {
  const task = repo.getTask(taskId);
  if (TERMINAL.has(task.status) || task.status === "paused") throw new HubError(`Cannot pause a task that is ${task.status}.`, "conflict", 409);
  const resumeTo = stableBefore(task.status);
  const t = repo.transitionTask(taskId, "paused", "human", RUNNING.has(task.status) ? "Paused (running step stopped)" : "Paused", { pausedFrom: resumeTo });
  if (RUNNING.has(task.status)) cancelJob(taskId);
  return t;
}

/** Resume a paused task, or retry a failed one: return to the stable state and re-run its automatic step. */
export async function resume(taskId: string): Promise<repo.Task> {
  const task = repo.getTask(taskId);
  if (task.status !== "paused" && task.status !== "failed") throw new HubError(`Task is ${task.status}; nothing to resume.`, "conflict", 409);
  if (activeJob(taskId)) throw new HubError("A step is still shutting down; try again in a moment.", "conflict", 409);
  const target = (task.pausedFrom as TaskStatus | null) ?? "draft";
  const t = repo.transitionTask(taskId, target, "human", task.status === "failed" ? "Retry" : "Resume", { pausedFrom: null, lastError: null, lastErrorKind: null }, task.status);
  switch (target) {
    case "draft":
      return startPm(taskId);
    case "spec_approved":
    case "changes_requested":
      if (executionAuthorised(taskId)) return dispatchDev(taskId);
      return t;
    case "review_pending":
      return startReview(taskId);
    default:
      return t;
  }
}

export function cancel(taskId: string, note?: string): repo.Task {
  const task = repo.getTask(taskId);
  if (TERMINAL.has(task.status)) throw new HubError(`Task is already ${task.status}.`, "conflict", 409);
  const t = repo.transitionTask(taskId, "cancelled", "human", note || "Cancelled");
  cancelJob(taskId);
  for (const k of ["spec", "merge", "decision", "execution", "dirty_tree"] as const) repo.decidePendingApprovals(taskId, k, false, "cancelled");
  repo.addMessage({ taskId, role: "human", provider: "human", kind: "note", round: task.revisionRound, body: `Task cancelled.${task.worktreePath ? ` Worktree left in place: ${task.worktreePath}` : ""}`, payload: null, refs: null });
  return t;
}

export function approveDirtyTree(taskId: string, note?: string) {
  repo.decidePendingApprovals(taskId, "dirty_tree", true, note);
}

/** On startup: tasks stuck in running states were interrupted by a restart. */
export function recoverInterrupted(): number {
  repo.markInterruptedRuns();
  let n = 0;
  for (const t of repo.listTasksByStatus(["pm_running", "dev_running", "review_running"])) {
    if (activeJob(t.id)) continue;
    failTask(t.id, t.status, "internal", "Interrupted: the hub process stopped while this step was running. Retry to continue.", "system", "hub");
    n++;
  }
  return n;
}

/** Run the step appropriate for the task's current state ("Start" button). */
export async function advance(taskId: string): Promise<repo.Task> {
  const t = repo.getTask(taskId);
  switch (t.status) {
    case "draft":
      return startPm(taskId);
    case "spec_approved":
    case "changes_requested":
      return dispatchDev(taskId);
    case "review_pending":
      return startReview(taskId);
    case "awaiting_dev_result":
      return ingestResult(taskId);
    case "paused":
    case "failed":
      return resume(taskId);
    default:
      throw new HubError(`Nothing to start: task is ${t.status}.`, "conflict", 409);
  }
}
