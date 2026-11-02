/**
 * Data access layer. All writes that change a task's status go through
 * `transitionTask`, which enforces the state machine inside a transaction and
 * records an audit row in `transitions`.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb, schema } from "./db/client";
import { AgentMessage, ApprovalKind, type TaskSpecification } from "./schemas";
import { assertTransition, isTaskStatus, type TaskStatus } from "./state";
import { HubError, newId, nowIso, safeJsonParse, truncate, type ErrorKind } from "./util";
import { redact } from "./redact";
import { verifyRepo } from "./git";
import { LIMITS } from "./config";

/* ----------------------------- Project settings ---------------------------- */

const ArgvSchema = z
  .array(z.string().min(1).max(500).refine((s) => !s.includes("\0"), "NUL byte"))
  .min(1)
  .max(30)
  .refine((a) => /^[A-Za-z0-9._\-\\/:]+$/.test(a[0]!), "Program must be a plain executable name or path (no shell syntax)");

export const ProjectSettings = z.object({
  pmProvider: z.string().regex(/^[a-z0-9-]{2,41}$/).default("codex"),
  /** Provider ids per role (see providers/registry.ts). Defaults: Codex PM/reviewer, automated Claude Code developer; "claude-manual" = human-in-the-loop fallback. */
  devProvider: z.string().regex(/^[a-z0-9-]{2,41}$/).default("claude-cli"),
  reviewProvider: z.string().regex(/^[a-z0-9-]{2,41}$/).default("codex"),
  maxRevisions: z.number().int().min(0).max(LIMITS.maxRevisionsCeiling).default(2),
  /** Optional model alias for Claude (e.g. "sonnet"); null = your Claude Code default. */
  claudeModel: z.string().max(100).regex(/^[A-Za-z0-9._:\[\]-]*$/).nullable().default(null),
  /** Execution permission: may the hub run the configured test command in task worktrees? */
  allowTestExecution: z.boolean().default(false),
  /** Test command as an argv array (no shell). e.g. ["npm","test"] */
  testCommand: ArgvSchema.nullable().default(null),
  /** Allow dispatch even if the main repo's working tree is dirty (worktree is still isolated). */
  allowDirtyRepo: z.boolean().default(false),
  providerTimeoutMinutes: z.number().int().min(1).max(60).default(15),
  testTimeoutMinutes: z.number().int().min(1).max(60).default(10),
  codexModel: z.string().max(100).regex(/^[A-Za-z0-9._:-]*$/).nullable().default(null),
  baseRef: z.string().regex(/^[A-Za-z0-9._/-]{1,200}$/).refine((s) => !s.startsWith("-")).default("HEAD"),
  autoAdvance: z.boolean().default(true),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const ProjectInput = z.object({
  name: z.string().trim().min(1).max(100),
  description: z.string().max(5_000).default(""),
  repoPath: z.string().trim().min(1).max(1_000),
  githubUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/, "Must be https://github.com/<owner>/<repo>")
    .nullable()
    .optional()
    .transform((v) => v || null),
  productGoals: z.string().max(20_000).default(""),
  userRequirements: z.string().max(20_000).default(""),
  architecture: z.string().max(20_000).default(""),
  constraints: z.string().max(20_000).default(""),
  instructions: z.string().max(20_000).default(""),
  settings: ProjectSettings.partial().default({}),
});
export type ProjectInput = z.input<typeof ProjectInput>;

export type Project = Omit<typeof schema.projects.$inferSelect, "settings"> & { settings: ProjectSettings };

function hydrateProject(row: typeof schema.projects.$inferSelect): Project {
  return { ...row, settings: ProjectSettings.parse(safeJsonParse(row.settings) ?? {}) };
}

export async function createProject(input: ProjectInput): Promise<Project> {
  const data = ProjectInput.parse(input);
  await verifyRepo(data.repoPath); // throws HubError if not a git repo root
  const db = getDb();
  if (db.select().from(schema.projects).where(eq(schema.projects.name, data.name)).get()) throw new HubError(`A project named "${data.name}" already exists.`, "conflict");
  const now = nowIso();
  const row = {
    id: newId("proj"),
    name: data.name,
    description: data.description,
    repoPath: data.repoPath,
    githubUrl: data.githubUrl ?? null,
    productGoals: data.productGoals,
    userRequirements: data.userRequirements,
    architecture: data.architecture,
    constraints: data.constraints,
    instructions: data.instructions,
    memorySummary: "",
    settings: JSON.stringify(ProjectSettings.parse(data.settings)),
    pathVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
  db.insert(schema.projects).values(row).run();
  return hydrateProject(row);
}

export const ProjectPatch = ProjectInput.omit({ settings: true, repoPath: true }).partial().extend({ settings: ProjectSettings.partial().optional(), repoPath: z.string().trim().min(1).max(1000).optional() });

export async function updateProject(id: string, patch: z.input<typeof ProjectPatch>): Promise<Project> {
  const p = getProject(id);
  const data = ProjectPatch.parse(patch);
  const db = getDb();
  const now = nowIso();
  const settings = data.settings ? ProjectSettings.parse({ ...p.settings, ...data.settings }) : p.settings;
  let pathVerifiedAt = p.pathVerifiedAt;
  if (data.repoPath && data.repoPath !== p.repoPath) {
    await verifyRepo(data.repoPath);
    pathVerifiedAt = now;
  }
  const { settings: _s, ...rest } = data;
  db.update(schema.projects)
    .set({ ...rest, githubUrl: data.githubUrl === undefined ? p.githubUrl : data.githubUrl, settings: JSON.stringify(settings), pathVerifiedAt, updatedAt: now })
    .where(eq(schema.projects.id, id))
    .run();
  return getProject(id);
}

export function getProject(id: string): Project {
  const row = getDb().select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!row) throw new HubError("Project not found", "not_found", 404);
  return hydrateProject(row);
}

export function findProjectByName(name: string): Project | null {
  const row = getDb().select().from(schema.projects).where(eq(schema.projects.name, name)).get();
  return row ? hydrateProject(row) : null;
}

export function listProjects(): Project[] {
  return getDb().select().from(schema.projects).orderBy(schema.projects.name).all().map(hydrateProject);
}

export function setProjectMemory(id: string, memorySummary: string): void {
  getDb().update(schema.projects).set({ memorySummary: truncate(memorySummary, 12_000), updatedAt: nowIso() }).where(eq(schema.projects.id, id)).run();
}

/* ------------------------------- Context docs ------------------------------ */

export function addContextDoc(projectId: string, title: string, content: string, source: string) {
  getProject(projectId);
  const t = z.string().trim().min(1).max(200).parse(title);
  if (content.length > 500_000) throw new HubError("Context document too large (max 500 KB).", "validation");
  const row = { id: newId("doc"), projectId, title: t, source: source.slice(0, 200), content: redact(content), includeInPrompts: true, createdAt: nowIso() };
  getDb().insert(schema.contextDocs).values(row).run();
  return row;
}

export function listContextDocs(projectId: string) {
  return getDb().select().from(schema.contextDocs).where(eq(schema.contextDocs.projectId, projectId)).orderBy(desc(schema.contextDocs.createdAt)).all();
}

export function setContextDocIncluded(id: string, include: boolean) {
  getDb().update(schema.contextDocs).set({ includeInPrompts: include }).where(eq(schema.contextDocs.id, id)).run();
}

export function deleteContextDoc(id: string) {
  getDb().delete(schema.contextDocs).where(eq(schema.contextDocs.id, id)).run();
}

/* -------------------------------- Decisions -------------------------------- */

export function addDecision(projectId: string, d: { title: string; decision: string; rationale?: string; taskId?: string | null; source: "developer" | "pm" | "human" }) {
  const row = { id: newId("dec"), projectId, taskId: d.taskId ?? null, title: d.title.slice(0, 300), decision: d.decision.slice(0, 4000), rationale: (d.rationale ?? "").slice(0, 4000), source: d.source, status: "accepted", createdAt: nowIso() };
  getDb().insert(schema.decisions).values(row).run();
  return row;
}

export function listDecisions(projectId: string, limit = 100) {
  return getDb().select().from(schema.decisions).where(and(eq(schema.decisions.projectId, projectId), eq(schema.decisions.status, "accepted"))).orderBy(desc(schema.decisions.createdAt)).limit(limit).all();
}

export function supersedeDecision(id: string) {
  getDb().update(schema.decisions).set({ status: "superseded" }).where(eq(schema.decisions.id, id)).run();
}

/* ---------------------------------- Tasks ---------------------------------- */

export type TaskRow = typeof schema.tasks.$inferSelect;
export type Task = Omit<TaskRow, "status" | "spec"> & { status: TaskStatus; spec: TaskSpecification | null };

function hydrateTask(row: TaskRow): Task {
  if (!isTaskStatus(row.status)) throw new HubError(`Corrupt task status: ${row.status}`, "internal");
  return { ...row, status: row.status, spec: safeJsonParse<TaskSpecification>(row.spec) };
}

export const TaskInput = z.object({
  request: z.string().trim().min(5, "Describe the feature or bug (at least a sentence).").max(20_000),
  type: z.enum(["feature", "bug", "chore"]).default("feature"),
  title: z.string().trim().max(200).optional(),
  maxRevisions: z.number().int().min(0).max(LIMITS.maxRevisionsCeiling).optional(),
  autoAdvance: z.boolean().optional(),
});

export function createTask(projectId: string, input: z.input<typeof TaskInput>): Task {
  const p = getProject(projectId);
  const data = TaskInput.parse(input);
  const now = nowIso();
  const title = data.title || data.request.replace(/\[mock:[^\]]+\]/g, "").trim().split(/\r?\n/)[0]!.slice(0, 120) || "Untitled";
  const row: TaskRow = {
    id: newId("task"),
    projectId,
    title,
    type: data.type,
    request: data.request,
    status: "draft",
    pausedFrom: null,
    spec: null,
    specApprovedAt: null,
    revisionRound: 0,
    maxRevisions: data.maxRevisions ?? p.settings.maxRevisions,
    autoAdvance: data.autoAdvance ?? p.settings.autoAdvance,
    branch: null,
    baseRef: null,
    baseCommit: null,
    worktreePath: null,
    lastError: null,
    lastErrorKind: null,
    createdAt: now,
    updatedAt: now,
  };
  const db = getDb();
  db.transaction((tx) => {
    tx.insert(schema.tasks).values(row).run();
    tx.insert(schema.transitions).values({ id: newId("tr"), taskId: row.id, fromStatus: null, toStatus: "draft", actor: "human", reason: "Task created", createdAt: now }).run();
  });
  addMessage({ taskId: row.id, role: "human", provider: "human", kind: "feature_request", round: 0, body: data.request, payload: null, refs: null });
  return hydrateTask(row);
}

export function getTask(id: string): Task {
  const row = getDb().select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!row) throw new HubError("Task not found", "not_found", 404);
  return hydrateTask(row);
}

export function listTasks(projectId?: string): Task[] {
  const db = getDb();
  const q = projectId ? db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)) : db.select().from(schema.tasks);
  return q.orderBy(desc(schema.tasks.updatedAt)).all().map(hydrateTask);
}

export function listTasksByStatus(statuses: TaskStatus[]): Task[] {
  return getDb().select().from(schema.tasks).where(inArray(schema.tasks.status, statuses)).all().map(hydrateTask);
}

type TaskPatch = Partial<Pick<TaskRow, "pausedFrom" | "specApprovedAt" | "revisionRound" | "maxRevisions" | "autoAdvance" | "branch" | "baseRef" | "baseCommit" | "worktreePath" | "lastError" | "lastErrorKind" | "title" | "type">> & { spec?: TaskSpecification | null };

/**
 * Atomically move a task to a new status. `expectedFrom` guards against races
 * (e.g. a cancel arriving while a provider run finishes).
 */
export function transitionTask(id: string, to: TaskStatus, actor: string, reason = "", patch: TaskPatch = {}, expectedFrom?: TaskStatus | TaskStatus[]): Task {
  const db = getDb();
  return db.transaction((tx) => {
    const row = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    if (!row) throw new HubError("Task not found", "not_found", 404);
    const from = row.status as TaskStatus;
    if (expectedFrom) {
      const allowed = Array.isArray(expectedFrom) ? expectedFrom : [expectedFrom];
      if (!allowed.includes(from)) throw new HubError(`Task is ${from}, expected ${allowed.join(" or ")}.`, "conflict", 409);
    }
    assertTransition(from, to);
    const now = nowIso();
    const { spec, ...rest } = patch;
    const set: Partial<TaskRow> = { ...rest, status: to, updatedAt: now };
    if (spec !== undefined) set.spec = spec === null ? null : JSON.stringify(spec);
    if (to !== "failed" && patch.lastError === undefined) {
      set.lastError = null;
      set.lastErrorKind = null;
    }
    tx.update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
    tx.insert(schema.transitions).values({ id: newId("tr"), taskId: id, fromStatus: from, toStatus: to, actor, reason: redact(reason).slice(0, 2000), createdAt: now }).run();
    const updated = tx.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get()!;
    return hydrateTask(updated);
  });
}

/** Update non-status fields (e.g. human edits to the spec while in spec_review). */
export function patchTask(id: string, patch: TaskPatch): Task {
  const { spec, ...rest } = patch;
  const set: Partial<TaskRow> = { ...rest, updatedAt: nowIso() };
  if (spec !== undefined) set.spec = spec === null ? null : JSON.stringify(spec);
  getDb().update(schema.tasks).set(set).where(eq(schema.tasks.id, id)).run();
  return getTask(id);
}

export function listTransitions(taskId: string) {
  return getDb().select().from(schema.transitions).where(eq(schema.transitions.taskId, taskId)).orderBy(schema.transitions.createdAt).all();
}

/* --------------------------------- Messages -------------------------------- */

export function addMessage(msg: z.input<typeof AgentMessage>) {
  const m = AgentMessage.parse(msg);
  const row = {
    id: newId("msg"),
    taskId: m.taskId,
    role: m.role,
    provider: m.provider,
    kind: m.kind,
    round: m.round,
    body: redact(m.body),
    payload: m.payload === null || m.payload === undefined ? null : redact(JSON.stringify(m.payload)),
    refs: m.refs ? JSON.stringify(m.refs) : null,
    createdAt: nowIso(),
  };
  getDb().insert(schema.messages).values(row).run();
  return row;
}

export function listMessages(taskId: string) {
  return getDb()
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.taskId, taskId))
    .orderBy(schema.messages.createdAt, schema.messages.id)
    .all()
    .map((m) => ({ ...m, payload: safeJsonParse(m.payload), refs: safeJsonParse(m.refs) }));
}

export function latestMessage(taskId: string, kind: string) {
  const row = getDb().select().from(schema.messages).where(and(eq(schema.messages.taskId, taskId), eq(schema.messages.kind, kind))).orderBy(desc(schema.messages.createdAt), desc(schema.messages.id)).limit(1).get();
  return row ? { ...row, payload: safeJsonParse(row.payload), refs: safeJsonParse(row.refs) } : null;
}

export function recentActivity(projectId: string, limit = 20) {
  const db = getDb();
  return db
    .select({ id: schema.messages.id, taskId: schema.messages.taskId, taskTitle: schema.tasks.title, role: schema.messages.role, kind: schema.messages.kind, body: schema.messages.body, createdAt: schema.messages.createdAt })
    .from(schema.messages)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.messages.taskId))
    .where(eq(schema.tasks.projectId, projectId))
    .orderBy(desc(schema.messages.createdAt))
    .limit(limit)
    .all()
    .map((r) => ({ ...r, body: truncate(r.body, 300) }));
}

/* --------------------------------- Approvals ------------------------------- */

export function createApproval(taskId: string, kind: z.infer<typeof ApprovalKind>, title: string, details: string) {
  const db = getDb();
  // One pending approval per kind per task.
  const existing = db.select().from(schema.approvals).where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.kind, kind), eq(schema.approvals.status, "pending"))).get();
  if (existing) return existing;
  const row = { id: newId("apr"), taskId, kind, title, details: redact(details), status: "pending", decidedBy: null, note: null, createdAt: nowIso(), decidedAt: null };
  db.insert(schema.approvals).values(row).run();
  return row;
}

export function decidePendingApprovals(taskId: string, kind: z.infer<typeof ApprovalKind>, approved: boolean, note?: string) {
  getDb()
    .update(schema.approvals)
    .set({ status: approved ? "approved" : "rejected", decidedBy: "human", note: note ?? null, decidedAt: nowIso() })
    .where(and(eq(schema.approvals.taskId, taskId), eq(schema.approvals.kind, kind), eq(schema.approvals.status, "pending")))
    .run();
}

export function listApprovals(taskId: string) {
  return getDb().select().from(schema.approvals).where(eq(schema.approvals.taskId, taskId)).orderBy(desc(schema.approvals.createdAt)).all();
}

/* ------------------------------- Provider runs ----------------------------- */

export function startRun(r: { taskId: string | null; projectId: string | null; provider: string; role: string }) {
  const row = { id: newId("run"), taskId: r.taskId, projectId: r.projectId, provider: r.provider, role: r.role, status: "running", errorKind: null, error: null, exitCode: null, durationMs: null, usage: null, stdoutExcerpt: null, stderrExcerpt: null, startedAt: nowIso(), finishedAt: null };
  getDb().insert(schema.providerRuns).values(row).run();
  return row.id;
}

export function finishRun(id: string, r: { status: "succeeded" | "failed" | "cancelled" | "interrupted"; errorKind?: ErrorKind | null; error?: string | null; exitCode?: number | null; durationMs?: number; usage?: unknown; stdout?: string; stderr?: string }) {
  getDb()
    .update(schema.providerRuns)
    .set({
      status: r.status,
      errorKind: r.errorKind ?? null,
      error: r.error ? redact(r.error).slice(0, 4000) : null,
      exitCode: r.exitCode ?? null,
      durationMs: r.durationMs ?? null,
      usage: r.usage ? JSON.stringify(r.usage) : null,
      stdoutExcerpt: r.stdout ? redact(truncate(r.stdout, LIMITS.excerptChars)) : null,
      stderrExcerpt: r.stderr ? redact(truncate(r.stderr, LIMITS.excerptChars)) : null,
      finishedAt: nowIso(),
    })
    .where(eq(schema.providerRuns.id, id))
    .run();
}

export function listRuns(taskId: string) {
  return getDb().select().from(schema.providerRuns).where(eq(schema.providerRuns.taskId, taskId)).orderBy(desc(schema.providerRuns.startedAt)).all();
}

export function recentProviderErrors(limit = 10) {
  return getDb().select().from(schema.providerRuns).where(inArray(schema.providerRuns.status, ["failed", "interrupted"])).orderBy(desc(schema.providerRuns.startedAt)).limit(limit).all();
}

/** On process start: any run still "running" was interrupted by a restart. */
export function markInterruptedRuns(): number {
  const res = getDb().update(schema.providerRuns).set({ status: "interrupted", error: "Hub process restarted during run", finishedAt: nowIso() }).where(eq(schema.providerRuns.status, "running")).run();
  return res.changes;
}
