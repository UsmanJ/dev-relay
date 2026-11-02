import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

const ts = (name: string) => text(name).notNull();

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  repoPath: text("repo_path").notNull(),
  githubUrl: text("github_url"),
  productGoals: text("product_goals").notNull().default(""),
  userRequirements: text("user_requirements").notNull().default(""),
  architecture: text("architecture").notNull().default(""),
  constraints: text("constraints").notNull().default(""),
  /** Human-written instructions. Kept separate from generated summaries. */
  instructions: text("instructions").notNull().default(""),
  /** Generated rolling summary of completed work (machine-written). */
  memorySummary: text("memory_summary").notNull().default(""),
  /** JSON: ProjectSettings */
  settings: text("settings").notNull(),
  pathVerifiedAt: text("path_verified_at"),
  createdAt: ts("created_at"),
  updatedAt: ts("updated_at"),
});

export const contextDocs = sqliteTable(
  "context_docs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    source: text("source").notNull(), // e.g. "upload:chatgpt-export.md"
    content: text("content").notNull(),
    includeInPrompts: integer("include_in_prompts", { mode: "boolean" }).notNull().default(true),
    createdAt: ts("created_at"),
  },
  (t) => [index("context_docs_project_idx").on(t.projectId)],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    title: text("title").notNull(),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull().default(""),
    source: text("source").notNull(), // developer | pm | human
    status: text("status").notNull().default("accepted"), // accepted | superseded
    createdAt: ts("created_at"),
  },
  (t) => [index("decisions_project_idx").on(t.projectId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    type: text("type").notNull(), // feature | bug | chore
    request: text("request").notNull(),
    status: text("status").notNull(),
    /** Set when the task is paused: the status it will resume into. */
    pausedFrom: text("paused_from"),
    /** JSON TaskSpecification (current, possibly human-edited). */
    spec: text("spec"),
    specApprovedAt: text("spec_approved_at"),
    revisionRound: integer("revision_round").notNull().default(0),
    maxRevisions: integer("max_revisions").notNull().default(2),
    autoAdvance: integer("auto_advance", { mode: "boolean" }).notNull().default(true),
    branch: text("branch"),
    baseRef: text("base_ref"),
    baseCommit: text("base_commit"),
    worktreePath: text("worktree_path"),
    lastError: text("last_error"),
    lastErrorKind: text("last_error_kind"),
    createdAt: ts("created_at"),
    updatedAt: ts("updated_at"),
  },
  (t) => [index("tasks_project_idx").on(t.projectId), index("tasks_status_idx").on(t.status)],
);

export const transitions = sqliteTable(
  "transitions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull().default(""),
    createdAt: ts("created_at"),
  },
  (t) => [index("transitions_task_idx").on(t.taskId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    kind: text("kind").notNull(),
    round: integer("round").notNull().default(0),
    body: text("body").notNull(),
    payload: text("payload"), // JSON
    refs: text("refs"), // JSON
    createdAt: ts("created_at"),
  },
  (t) => [index("messages_task_idx").on(t.taskId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").notNull().references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    status: text("status").notNull().default("pending"), // pending | approved | rejected
    decidedBy: text("decided_by"),
    note: text("note"),
    createdAt: ts("created_at"),
    decidedAt: text("decided_at"),
  },
  (t) => [index("approvals_task_idx").on(t.taskId)],
);

export const providerRuns = sqliteTable(
  "provider_runs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    projectId: text("project_id"),
    provider: text("provider").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull(), // running | succeeded | failed | cancelled | interrupted
    errorKind: text("error_kind"),
    error: text("error"),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    usage: text("usage"), // JSON
    stdoutExcerpt: text("stdout_excerpt"),
    stderrExcerpt: text("stderr_excerpt"),
    startedAt: ts("started_at"),
    finishedAt: text("finished_at"),
  },
  (t) => [index("runs_task_idx").on(t.taskId)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});
