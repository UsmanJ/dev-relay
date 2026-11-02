"use client";

import Link from "next/link";
import { useState } from "react";
import { api } from "./api";
import type { Message, Project, Spec, Task } from "./types";
import { Button, Card, Empty, ErrorBanner, inputCls, ROLE_STYLE, Spinner, StatusBadge, timeAgo, cx, useApi } from "./ui";

interface TaskResponse {
  task: Task;
  project: Project;
  messages: Message[];
  transitions: Array<{ id: string; fromStatus: string | null; toStatus: string; actor: string; reason: string; createdAt: string }>;
  approvals: Array<{ id: string; kind: string; title: string; details: string; status: string; note: string | null; createdAt: string; decidedAt: string | null }>;
  runs: Array<{ id: string; provider: string; role: string; status: string; errorKind: string | null; error: string | null; durationMs: number | null; usage: string | null; startedAt: string }>;
  activeJob: { step: string; startedAt: number } | null;
}

interface Evidence {
  stat: string;
  changedFiles: string[];
  commits: string[];
  headCommit: string | null;
  uncommittedChanges: boolean;
  diff: string;
  untracked: Array<{ path: string; content: string }>;
  tests: { ranByHub: boolean; command: string | null; exitCode: number | null; passed: boolean | null; output: string; reason?: string };
}
interface Review {
  verdict: string;
  summary: string;
  criteria: Array<{ criterionId: string; status: string; evidence: string }>;
  requestedChanges: string[];
  concerns: string[];
  questionsForHuman: string[];
}
interface Impl {
  status: string;
  summary: string;
  changedFiles: string[];
  testsRun: Array<{ command: string; passed: boolean; summary: string }>;
  decisions: Array<{ title: string; decision: string }>;
  questions: Array<{ id: string; question: string; blocking: boolean }>;
  responseToFeedback: string | null;
}

const ERROR_HELP: Record<string, string> = {
  usage_limit: "A provider usage limit was reached. DevRelay stopped and will not retry automatically. Retry once your plan's limit resets.",
  auth: "A provider is not logged in. Sign in to the CLI using the vendor's official login (see Providers), then Retry.",
  malformed_output: "The agent returned output that failed schema validation. Retry, or adjust the request.",
  provider_unavailable: "A provider CLI is not installed or not on PATH. See the Providers page.",
  permission: "This action needs your permission (see the pending approvals), or the provider is blocked to avoid API charges.",
  timeout: "The step exceeded the configured timeout. Increase it in project settings, or Retry.",
};

export function TaskView({ id }: { id: string }) {
  const q = useApi<TaskResponse>(`/api/tasks/${id}`, (d) => (d?.activeJob || d?.task.status.endsWith("_running") ? 1500 : 6000));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(action);
    setError(null);
    try {
      await api(`/api/tasks/${id}/action`, { body: { action, ...extra } });
      await q.reload();
    } catch (e) {
      setError((e as Error).message);
      await q.reload();
    } finally {
      setBusy(null);
    }
  };

  if (q.loading) return <Spinner label="Loading task…" />;
  if (!q.data) return <ErrorBanner error={q.error ?? "Task not found"} />;
  const { task, project, messages, approvals, runs, transitions, activeJob } = q.data;
  const running = task.status.endsWith("_running");
  const terminal = ["completed", "rejected", "cancelled"].includes(task.status);
  const pending = approvals.filter((a) => a.status === "pending");
  const latest = (kind: string) => [...messages].reverse().find((m) => m.kind === kind);
  const evidence = latest("evidence")?.payload as Evidence | undefined;
  const review = latest("review_result")?.payload as Review | undefined;
  const impl = latest("implementation_result")?.payload as Impl | undefined;
  const handoff = task.status === "awaiting_dev_result" ? (latest("dev_handoff")?.payload as { command: string; resultPath: string; taskFile: string } | undefined) : undefined;

  return (
    <div className="space-y-4">
      <div>
        <Link href={`/projects/${project.id}`} className="text-xs text-zinc-500 hover:underline">
          ← {project.name}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>
        <div className="mt-1 flex flex-wrap gap-x-4 text-xs text-zinc-500">
          <span>{task.type}</span>
          <span>
            revision round {task.revisionRound}/{task.maxRevisions}
          </span>
          {task.branch && <span className="font-mono">branch {task.branch}</span>}
          {task.worktreePath && <span className="font-mono">worktree {task.worktreePath}</span>}
          <span className="font-mono">{task.id}</span>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Task controls">
        {["draft", "spec_approved", "changes_requested", "review_pending"].includes(task.status) && (
          <Button variant="primary" onClick={() => act("start")} busy={busy === "start"}>
            ▶ Start next step
          </Button>
        )}
        {task.status === "failed" && (
          <Button variant="primary" onClick={() => act("resume")} busy={busy === "resume"}>
            ↻ Retry
          </Button>
        )}
        {task.status === "paused" && (
          <Button variant="primary" onClick={() => act("resume")} busy={busy === "resume"}>
            ▶ Resume
          </Button>
        )}
        {!terminal && task.status !== "paused" && task.status !== "awaiting_merge_approval" && (
          <Button onClick={() => act("pause")} busy={busy === "pause"}>
            ❚❚ Pause
          </Button>
        )}
        {!terminal && (
          <Button variant="danger" onClick={() => act("cancel")} busy={busy === "cancel"}>
            ✕ Cancel
          </Button>
        )}
        {running && <Spinner label={`${activeJob?.step ?? "Agent"} running${activeJob ? ` · ${Math.round((Date.now() - activeJob.startedAt) / 1000)}s` : ""}`} />}
      </div>

      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {task.lastError && (
        <div role="alert" className={cx("rounded-md border px-3 py-2 text-sm", task.lastErrorKind === "usage_limit" ? "border-amber-400 bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200" : "border-red-300 bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300")}>
          <b>{task.lastErrorKind?.replace(/_/g, " ") ?? "error"}:</b> {task.lastError}
          {task.lastErrorKind && ERROR_HELP[task.lastErrorKind] && <div className="mt-1 text-xs opacity-80">{ERROR_HELP[task.lastErrorKind]}</div>}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {task.status === "spec_review" && task.spec && <SpecApproval task={task} act={act} busy={busy} />}
          {pending.some((a) => a.kind === "execution") && (task.status === "spec_approved" || task.status === "changes_requested") && (
            <ActionCard title="Authorise code changes">
              <p className="text-sm">The developer agent ({project.settings.devProvider}) will modify code in an isolated git worktree on a new branch. Nothing is merged or pushed.</p>
              <Button variant="primary" className="mt-2" onClick={() => act("authorize")} busy={busy === "authorize"}>
                Authorise &amp; dispatch
              </Button>
            </ActionCard>
          )}
          {pending.some((a) => a.kind === "dirty_tree") && (
            <ActionCard title="Main repository has uncommitted changes">
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs">{pending.find((a) => a.kind === "dirty_tree")?.details}</pre>
              <Button variant="primary" className="mt-2" onClick={() => act("approve_dirty")} busy={busy === "approve_dirty"}>
                Continue in an isolated worktree
              </Button>
            </ActionCard>
          )}
          {handoff && <ManualHandoff handoff={handoff} act={act} busy={busy} />}
          {task.status === "awaiting_merge_approval" && <MergeDecision task={task} project={project} act={act} busy={busy} />}
          {task.status === "human_decision_required" && <HumanDecision approvals={pending} act={act} busy={busy} />}

          {task.spec && task.status !== "spec_review" && <SpecView spec={task.spec} />}
          {(impl || evidence || review) && <Results impl={impl} evidence={evidence} review={review} />}
          <Timeline messages={messages} />
        </div>

        <aside className="space-y-4">
          <Card title="Approvals">
            {!approvals.length ? (
              <Empty>None yet.</Empty>
            ) : (
              <ul className="space-y-2 text-sm">
                {approvals.map((a) => (
                  <li key={a.id} className="flex items-start gap-2">
                    <span className={cx("mt-0.5 rounded px-1.5 text-xs", a.status === "pending" ? "bg-amber-100 text-amber-800" : a.status === "approved" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-600")}>{a.status}</span>
                    <span>
                      <span className="font-medium">{a.kind}</span>: {a.title}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <TaskSettings task={task} act={act} />
          <Card title="Provider runs">
            {!runs.length ? (
              <Empty>No agent runs yet.</Empty>
            ) : (
              <ul className="space-y-2 text-xs">
                {runs.map((r) => {
                  const u = r.usage ? (JSON.parse(r.usage) as { inputTokens?: number; outputTokens?: number }) : null;
                  return (
                    <li key={r.id}>
                      <div className="flex gap-1">
                        <b>{r.role}</b> · {r.provider} ·{" "}
                        <span className={r.status === "succeeded" ? "text-emerald-600" : r.status === "running" ? "text-sky-600" : "text-red-600"}>{r.status}</span>
                        <span className="ml-auto text-zinc-500">{r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : ""}</span>
                      </div>
                      {u && (
                        <div className="text-zinc-500">
                          tokens in {u.inputTokens ?? "?"} / out {u.outputTokens ?? "?"}
                        </div>
                      )}
                      {r.error && (
                        <div className="text-red-600">
                          [{r.errorKind}] {r.error.slice(0, 300)}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
          <Card title="Status history">
            <ol className="space-y-1 text-xs">
              {transitions.map((t) => (
                <li key={t.id}>
                  <span className="font-mono text-zinc-500">{t.createdAt.slice(11, 19)}</span> {t.fromStatus ?? "∅"} → <b>{t.toStatus}</b> <span className="text-zinc-500">({t.actor})</span>
                  {t.reason && <div className="pl-14 text-zinc-500">{t.reason.slice(0, 160)}</div>}
                </li>
              ))}
            </ol>
          </Card>
        </aside>
      </div>
    </div>
  );
}

type Act = (action: string, extra?: Record<string, unknown>) => Promise<void>;

function ActionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border-2 border-indigo-300 bg-indigo-50/50 p-4 dark:border-indigo-800 dark:bg-indigo-950/30" aria-label={title}>
      <h2 className="mb-2 font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function SpecApproval({ task, act, busy }: { task: Task; act: Act; busy: string | null }) {
  const [editing, setEditing] = useState(false);
  const [json, setJson] = useState(JSON.stringify(task.spec, null, 2));
  const [feedback, setFeedback] = useState("");
  const [authorize, setAuthorize] = useState(true);
  const [localErr, setLocalErr] = useState<string | null>(null);
  const saveEdit = async () => {
    let spec: unknown;
    try {
      spec = JSON.parse(json);
    } catch (e) {
      return setLocalErr(`Invalid JSON: ${(e as Error).message}`);
    }
    setLocalErr(null);
    await act("update_spec", { spec });
    setEditing(false);
  };
  return (
    <ActionCard title="Review the PM's specification">
      <ErrorBanner error={localErr} onDismiss={() => setLocalErr(null)} />
      {editing ? (
        <>
          <label htmlFor="specjson" className="text-xs text-zinc-500">
            Edit the specification (validated on save)
          </label>
          <textarea id="specjson" rows={22} className={`${inputCls} font-mono text-xs`} value={json} onChange={(e) => setJson(e.target.value)} />
          <div className="mt-2 flex gap-2">
            <Button variant="primary" onClick={saveEdit} busy={busy === "update_spec"}>
              Save edits
            </Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Discard
            </Button>
          </div>
        </>
      ) : (
        <>
          <SpecBody spec={task.spec!} />
          <div className="mt-4 space-y-3 border-t border-indigo-200 pt-3 dark:border-indigo-900">
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" checked={authorize} onChange={(e) => setAuthorize(e.target.checked)} className="mt-1" />
              <span>Also authorise the developer to modify code (isolated worktree, new branch). Nothing is merged or pushed.</span>
            </label>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => act("approve_spec", { authorizeExecution: authorize })} busy={busy === "approve_spec"}>
                ✓ Approve specification
              </Button>
              <Button onClick={() => { setJson(JSON.stringify(task.spec, null, 2)); setEditing(true); }}>Edit</Button>
              <Button variant="danger" onClick={() => act("decide", { decision: "reject" })} busy={busy === "decide"}>
                Reject task
              </Button>
            </div>
            <div>
              <label htmlFor="fb" className="text-sm font-medium">
                Answer questions or ask the PM to redraft
              </label>
              <textarea id="fb" rows={3} className={inputCls} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Q-1: use the existing settings page. Also drop the export feature." />
              <Button className="mt-1" disabled={!feedback.trim()} onClick={() => act("spec", { feedback }).then(() => setFeedback(""))} busy={busy === "spec"}>
                Send feedback &amp; redraft
              </Button>
            </div>
          </div>
        </>
      )}
    </ActionCard>
  );
}

function SpecBody({ spec }: { spec: Spec }) {
  const list = (title: string, items: string[]) =>
    items.length > 0 && (
      <div>
        <h3 className="mt-3 text-xs font-semibold uppercase text-zinc-500">{title}</h3>
        <ul className="list-disc pl-5 text-sm">
          {items.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </div>
    );
  return (
    <div>
      <div className="text-sm font-medium">
        {spec.title} <span className="text-xs font-normal text-zinc-500">· {spec.type} · risk {spec.riskLevel}</span>
      </div>
      <p className="mt-1 whitespace-pre-wrap text-sm">{spec.summary}</p>
      {spec.userStory && <p className="mt-1 text-sm italic text-zinc-600 dark:text-zinc-400">{spec.userStory}</p>}
      {list("Requirements", spec.requirements)}
      <h3 className="mt-3 text-xs font-semibold uppercase text-zinc-500">Acceptance criteria</h3>
      <ul className="space-y-1 text-sm">
        {spec.acceptanceCriteria.map((a) => (
          <li key={a.id}>
            <b className="font-mono text-xs">{a.id}</b> {a.description}
            {a.verification && <span className="text-xs text-zinc-500"> — verify: {a.verification}</span>}
          </li>
        ))}
      </ul>
      {list("Non-goals", spec.nonGoals)}
      {list("Trade-offs", spec.tradeOffs)}
      {spec.openQuestions.length > 0 && (
        <div>
          <h3 className="mt-3 text-xs font-semibold uppercase text-zinc-500">Open questions</h3>
          <ul className="space-y-1 text-sm">
            {spec.openQuestions.map((q) => (
              <li key={q.id}>
                <b className="font-mono text-xs">{q.id}</b> {q.blocking && <span className="rounded bg-orange-100 px-1 text-xs text-orange-800">blocking</span>} {q.question}
              </li>
            ))}
          </ul>
        </div>
      )}
      {list("Suggested test plan", spec.suggestedTestPlan)}
    </div>
  );
}

function SpecView({ spec }: { spec: Spec }) {
  const [open, setOpen] = useState(false);
  return (
    <Card title="Approved specification" actions={<Button variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? "Collapse" : "Expand"}</Button>}>
      {open ? <SpecBody spec={spec} /> : <p className="text-sm">{spec.title} · {spec.acceptanceCriteria.length} acceptance criteria</p>}
    </Card>
  );
}

function ManualHandoff({ handoff, act, busy }: { handoff: { command: string; resultPath: string; taskFile: string }; act: Act; busy: string | null }) {
  const [paste, setPaste] = useState("");
  return (
    <ActionCard title="Manual handoff: run Claude Code yourself">
      <p className="text-sm">Run this in PowerShell. It opens Claude Code in the task worktree with the task file.</p>
      <pre className="mt-2 overflow-x-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100">{handoff.command}</pre>
      <Button variant="ghost" className="mt-1 text-xs" onClick={() => navigator.clipboard?.writeText(handoff.command)}>
        Copy command
      </Button>
      <p className="mt-2 text-xs text-zinc-500">
        Claude writes its structured result to <code className="mono">{handoff.resultPath}</code>.
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => act("ingest")} busy={busy === "ingest"}>
          Ingest result file
        </Button>
      </div>
      <details className="mt-2 text-sm">
        <summary className="cursor-pointer">…or paste the result JSON</summary>
        <textarea rows={6} className={`${inputCls} mt-1 font-mono text-xs`} value={paste} onChange={(e) => setPaste(e.target.value)} aria-label="Result JSON" />
        <Button className="mt-1" disabled={!paste.trim()} onClick={() => act("ingest", { resultJson: paste })}>
          Ingest pasted JSON
        </Button>
      </details>
    </ActionCard>
  );
}

function MergeDecision({ task, project, act, busy }: { task: Task; project: Project; act: Act; busy: string | null }) {
  const [note, setNote] = useState("");
  return (
    <ActionCard title="Reviewer approved: your decision">
      <p className="text-sm">DevRelay will not merge. Inspect the branch, then merge it yourself if you agree:</p>
      <pre className="mt-2 overflow-x-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100">{`git -C "${project.repoPath}" diff ${task.baseCommit?.slice(0, 12)}...${task.branch}\ngit -C "${task.worktreePath}" status\ngit -C "${project.repoPath}" merge --no-ff ${task.branch}`}</pre>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => act("decide", { decision: "approve_merge", note })} busy={busy === "decide"}>
          ✓ Accept (I&apos;ll merge manually)
        </Button>
        <Button disabled={!note.trim()} onClick={() => act("decide", { decision: "request_changes", note })}>
          Request changes
        </Button>
        <Button variant="danger" onClick={() => act("decide", { decision: "reject", note })}>
          Reject
        </Button>
      </div>
      <label htmlFor="mnote" className="sr-only">
        Note
      </label>
      <textarea id="mnote" rows={2} className={`${inputCls} mt-2`} placeholder="Notes or requested changes…" value={note} onChange={(e) => setNote(e.target.value)} />
    </ActionCard>
  );
}

function HumanDecision({ approvals, act, busy }: { approvals: TaskResponse["approvals"]; act: Act; busy: string | null }) {
  const [note, setNote] = useState("");
  const d = approvals.find((a) => a.kind === "decision");
  return (
    <ActionCard title={d?.title ?? "Human decision required"}>
      {d?.details && <p className="whitespace-pre-wrap text-sm">{d.details}</p>}
      <textarea rows={2} className={`${inputCls} mt-2`} placeholder="Guidance for the developer / note…" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Decision note" />
      <div className="mt-2 flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => act("decide", { decision: "grant_revision", note })} busy={busy === "decide"}>
          Grant one more revision
        </Button>
        <Button onClick={() => act("decide", { decision: "accept", note })}>Accept as-is</Button>
        <Button onClick={() => act("decide", { decision: "rereview", note })}>Re-run review</Button>
        <Button onClick={() => act("decide", { decision: "respec", note })}>Back to spec</Button>
        <Button variant="danger" onClick={() => act("decide", { decision: "reject", note })}>
          Reject
        </Button>
      </div>
    </ActionCard>
  );
}

function Results({ impl, evidence, review }: { impl?: Impl; evidence?: Evidence; review?: Review }) {
  const [showDiff, setShowDiff] = useState(false);
  return (
    <Card title="Implementation & review">
      {review && (
        <div className="mb-4">
          <div className="flex items-center gap-2">
            <span className={cx("rounded px-2 py-0.5 text-xs font-bold", review.verdict === "APPROVED" ? "bg-emerald-600 text-white" : review.verdict === "CHANGES_REQUESTED" ? "bg-violet-600 text-white" : "bg-orange-500 text-white")}>{review.verdict}</span>
            <span className="text-sm">{review.summary}</span>
          </div>
          {review.criteria.length > 0 && (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-zinc-500">
                <tr>
                  <th className="w-16">AC</th>
                  <th className="w-24">Status</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {review.criteria.map((c) => (
                  <tr key={c.criterionId} className="border-t border-zinc-100 align-top dark:border-zinc-800">
                    <td className="py-1 font-mono">{c.criterionId}</td>
                    <td className={c.status === "met" ? "text-emerald-600" : c.status === "not_met" ? "text-red-600" : "text-amber-600"}>{c.status}</td>
                    <td>{c.evidence}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {review.requestedChanges.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm">
              {review.requestedChanges.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}
          {review.concerns.length > 0 && <p className="mt-1 text-xs text-amber-700">Concerns: {review.concerns.join("; ")}</p>}
        </div>
      )}
      {impl && (
        <div className="mb-4">
          <h3 className="text-xs font-semibold uppercase text-zinc-500">Developer report (claims)</h3>
          <p className="whitespace-pre-wrap text-sm">{impl.summary}</p>
          {impl.testsRun.length > 0 && <p className="mt-1 text-xs text-zinc-500">Claimed tests: {impl.testsRun.map((t) => `${t.command} → ${t.passed ? "pass" : "fail"}`).join("; ")}</p>}
          {impl.questions.length > 0 && <p className="mt-1 text-xs">Questions: {impl.questions.map((q) => q.question).join(" | ")}</p>}
        </div>
      )}
      {evidence && (
        <div>
          <h3 className="text-xs font-semibold uppercase text-zinc-500">Evidence captured by DevRelay</h3>
          <div className="mt-1 text-sm">
            Tests:{" "}
            {evidence.tests.ranByHub ? (
              <b className={evidence.tests.passed ? "text-emerald-600" : "text-red-600"}>
                {evidence.tests.passed ? "PASSED" : `FAILED (exit ${evidence.tests.exitCode})`}
              </b>
            ) : (
              <span className="text-zinc-500">not run ({evidence.tests.reason})</span>
            )}
            {evidence.tests.command && <code className="mono ml-2 text-xs">{evidence.tests.command}</code>}
          </div>
          <div className="text-xs text-zinc-500">
            {evidence.changedFiles.length} file(s) · {evidence.commits.length} commit(s){evidence.uncommittedChanges ? " · has uncommitted changes" : ""}
          </div>
          <pre className="mt-2 overflow-x-auto rounded bg-zinc-100 p-2 text-xs dark:bg-zinc-950">{evidence.stat || "(empty diff)"}</pre>
          {evidence.tests.output && (
            <details className="mt-2">
              <summary className="cursor-pointer text-xs">Test output</summary>
              <pre className="max-h-64 overflow-auto rounded bg-zinc-900 p-2 text-xs text-zinc-100">{evidence.tests.output}</pre>
            </details>
          )}
          <Button variant="ghost" className="mt-2 text-xs" onClick={() => setShowDiff((s) => !s)} aria-expanded={showDiff}>
            {showDiff ? "Hide diff" : "Show diff"}
          </Button>
          {showDiff && (
            <pre className="max-h-[32rem] overflow-auto rounded bg-zinc-900 p-2 text-xs leading-relaxed text-zinc-100">
              {(evidence.diff + evidence.untracked.map((u) => `\n+++ new file: ${u.path}\n${u.content}`).join("")).split("\n").map((l, i) => (
                <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "text-emerald-400" : l.startsWith("-") && !l.startsWith("---") ? "text-red-400" : l.startsWith("@@") ? "text-sky-400" : ""}>
                  {l}
                  {"\n"}
                </span>
              ))}
            </pre>
          )}
        </div>
      )}
    </Card>
  );
}

function Timeline({ messages }: { messages: Message[] }) {
  return (
    <Card title={`Agent conversation (${messages.length})`}>
      {!messages.length ? (
        <Empty>No messages yet.</Empty>
      ) : (
        <ol className="space-y-2">
          {messages.map((m) => {
            const r = ROLE_STYLE[m.role] ?? ROLE_STYLE.system!;
            return (
              <li key={m.id} className={cx("rounded border-l-4 p-2", r.cls)}>
                <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                  <b className="text-zinc-800 dark:text-zinc-200">{r.label}</b>
                  <span>{m.provider}</span>
                  <span>· {m.kind.replace(/_/g, " ")}</span>
                  <span>· round {m.round}</span>
                  {m.refs?.branch && <span className="font-mono">· {m.refs.branch}</span>}
                  {m.refs?.commit && <span className="font-mono">@{m.refs.commit.slice(0, 8)}</span>}
                  <time className="ml-auto" dateTime={m.createdAt} title={m.createdAt}>
                    {timeAgo(m.createdAt)}
                  </time>
                </div>
                <p className="mt-1 whitespace-pre-wrap text-sm">{m.body.length > 1500 ? `${m.body.slice(0, 1500)}…` : m.body}</p>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function TaskSettings({ task, act }: { task: Task; act: Act }) {
  const [max, setMax] = useState(task.maxRevisions);
  return (
    <Card title="Task settings">
      <label className="flex items-center gap-2 text-sm">
        Max revisions
        <input type="number" min={0} max={5} value={max} onChange={(e) => setMax(Number(e.target.value))} className={`${inputCls} w-16`} />
        <Button className="ml-auto" onClick={() => act("settings", { maxRevisions: max })}>
          Save
        </Button>
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={task.autoAdvance} onChange={(e) => act("settings", { autoAdvance: e.target.checked })} />
        Auto-advance between agents
      </label>
    </Card>
  );
}
