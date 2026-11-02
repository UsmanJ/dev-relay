"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";
import type { Project, ProjectSettings, Task } from "./types";
import { Button, Card, Empty, ErrorBanner, Field, inputCls, ROLE_STYLE, Spinner, StatusBadge, timeAgo, cx, useApi } from "./ui";

interface ProjectResponse {
  project: Project;
  tasks: Task[];
  decisions: Array<{ id: string; title: string; decision: string; rationale: string; source: string; taskId: string | null; createdAt: string }>;
  contextDocs: Array<{ id: string; title: string; source: string; content: string; size: number; includeInPrompts: boolean; createdAt: string }>;
  activity: Array<{ id: string; taskId: string; taskTitle: string; role: string; kind: string; body: string; createdAt: string }>;
}

const TABS = ["Tasks", "Context", "Memory", "Settings"] as const;

export function ProjectView({ id }: { id: string }) {
  const q = useApi<ProjectResponse>(`/api/projects/${id}`, (d) => (d?.tasks.some((t) => t.status.endsWith("_running")) ? 2000 : 8000));
  const [tab, setTab] = useState<(typeof TABS)[number]>("Tasks");
  if (q.loading) return <Spinner label="Loading project…" />;
  if (!q.data) return <ErrorBanner error={q.error ?? "Project not found"} />;
  const { project } = q.data;
  return (
    <div className="space-y-4">
      <div>
        <Link href="/" className="text-xs text-zinc-500 hover:underline">
          ← Projects
        </Link>
        <h1 className="text-xl font-semibold">{project.name}</h1>
        <div className="flex flex-wrap gap-x-4 text-xs text-zinc-500">
          <span className="font-mono">{project.repoPath}</span>
          {project.githubUrl && (
            <a className="text-indigo-600 hover:underline" href={project.githubUrl} target="_blank" rel="noreferrer">
              {project.githubUrl.replace("https://github.com/", "")}
            </a>
          )}
          <span>path verified {project.pathVerifiedAt ? timeAgo(project.pathVerifiedAt) : "never"}</span>
        </div>
        {project.description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{project.description}</p>}
      </div>
      <ErrorBanner error={q.error} onDismiss={() => q.setError(null)} />
      <div role="tablist" className="flex gap-1 border-b border-zinc-200 dark:border-zinc-800">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cx("-mb-px border-b-2 px-3 py-1.5 text-sm", tab === t ? "border-indigo-600 font-medium" : "border-transparent text-zinc-500 hover:text-zinc-800")}>
            {t}
          </button>
        ))}
      </div>
      {tab === "Tasks" && <TasksTab data={q.data} reload={q.reload} />}
      {tab === "Context" && <ContextTab data={q.data} reload={q.reload} />}
      {tab === "Memory" && <MemoryTab data={q.data} />}
      {tab === "Settings" && <SettingsTab project={project} reload={q.reload} />}
    </div>
  );
}

function TasksTab({ data, reload }: { data: ProjectResponse; reload: () => Promise<void> }) {
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [type, setType] = useState("feature");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await api<Task>(`/api/projects/${data.project.id}/tasks`, { body: { request, type } });
      setRequest("");
      await reload();
      router.push(`/tasks/${t.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Card title="New feature or bug">
          <form onSubmit={submit} className="space-y-2">
            <ErrorBanner error={error} onDismiss={() => setError(null)} />
            <label htmlFor="req" className="sr-only">
              Request
            </label>
            <textarea id="req" required minLength={5} rows={4} className={inputCls} value={request} onChange={(e) => setRequest(e.target.value)} placeholder="Describe what you want, as you would to a product manager…" />
            <div className="flex items-center gap-2">
              <select aria-label="Type" className={`${inputCls} w-auto`} value={type} onChange={(e) => setType(e.target.value)}>
                <option value="feature">Feature</option>
                <option value="bug">Bug</option>
                <option value="chore">Chore</option>
              </select>
              <Button variant="primary" type="submit" busy={busy} className="ml-auto">
                Send to PM ({data.project.settings.pmProvider})
              </Button>
            </div>
          </form>
        </Card>
        <Card title={`Backlog (${data.tasks.length})`}>
          {!data.tasks.length ? (
            <Empty>No tasks yet. Describe a feature above.</Empty>
          ) : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
              {data.tasks.map((t) => (
                <li key={t.id}>
                  <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 py-2 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
                    <StatusBadge status={t.status} />
                    <span className="flex-1 truncate text-sm">{t.title}</span>
                    <span className="text-xs text-zinc-500">
                      {t.type} · r{t.revisionRound}/{t.maxRevisions} · {timeAgo(t.updatedAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <Card title="Recent activity">
        {!data.activity.length ? (
          <Empty>Nothing yet.</Empty>
        ) : (
          <ul className="space-y-2">
            {data.activity.map((a) => (
              <li key={a.id} className={cx("border-l-4 py-1 pl-2 text-xs", ROLE_STYLE[a.role]?.cls)}>
                <div className="flex gap-1 text-zinc-500">
                  <b className="text-zinc-700 dark:text-zinc-300">{ROLE_STYLE[a.role]?.label ?? a.role}</b> · {a.kind.replace(/_/g, " ")} · {timeAgo(a.createdAt)}
                </div>
                <Link href={`/tasks/${a.taskId}`} className="hover:underline">
                  {a.taskTitle}
                </Link>
                <div className="line-clamp-2 text-zinc-600 dark:text-zinc-400">{a.body}</div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function ContextTab({ data, reload }: { data: ProjectResponse; reload: () => Promise<void> }) {
  const p = data.project;
  const [f, setF] = useState({ description: p.description, productGoals: p.productGoals, userRequirements: p.userRequirements, architecture: p.architecture, constraints: p.constraints, instructions: p.instructions });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [doc, setDoc] = useState({ title: "", content: "" });
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/projects/${p.id}`, { method: "PATCH", body: f });
      setMsg("Saved.");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 500_000) return setError("File too large (max 500 KB).");
    setDoc({ title: file.name, content: await file.text() });
  };
  const importDoc = async () => {
    setError(null);
    try {
      await api(`/api/projects/${p.id}/context`, { body: { ...doc, source: "upload" } });
      setDoc({ title: "", content: "" });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const field = (k: keyof typeof f, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <textarea rows={4} className={inputCls} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Project context (sent to agents)" actions={<Button variant="primary" onClick={save} busy={busy}>Save</Button>}>
        <ErrorBanner error={error} onDismiss={() => setError(null)} />
        {msg && <p className="mb-2 text-xs text-emerald-600">{msg}</p>}
        <div className="space-y-3">
          {field("description", "Description")}
          {field("productGoals", "Product goals")}
          {field("userRequirements", "User requirements")}
          {field("architecture", "Architecture")}
          {field("constraints", "Engineering constraints")}
          {field("instructions", "Project-specific instructions", "Written by you. Stored separately from machine-generated summaries.")}
        </div>
      </Card>
      <div className="space-y-4">
        <Card title="Import context (Markdown / text)">
          <p className="mb-2 text-xs text-zinc-500">
            DevRelay cannot read your ChatGPT conversations. Export or copy the relevant notes into a .md or .txt file and import it here. Imported text is treated as data, never as instructions, and obvious secrets are redacted.
          </p>
          <input type="file" accept=".md,.txt,.markdown,text/plain,text/markdown" onChange={onFile} className="mb-2 block text-sm" aria-label="Choose file" />
          <input className={`${inputCls} mb-2`} placeholder="Title" value={doc.title} onChange={(e) => setDoc({ ...doc, title: e.target.value })} aria-label="Document title" />
          <textarea rows={5} className={inputCls} placeholder="…or paste text" value={doc.content} onChange={(e) => setDoc({ ...doc, content: e.target.value })} aria-label="Document content" />
          <Button className="mt-2" onClick={importDoc} disabled={!doc.content.trim()}>
            Import
          </Button>
        </Card>
        <Card title={`Imported documents (${data.contextDocs.length})`}>
          {!data.contextDocs.length ? (
            <Empty>None yet.</Empty>
          ) : (
            <ul className="space-y-2">
              {data.contextDocs.map((d) => (
                <li key={d.id} className="rounded border border-zinc-200 p-2 text-sm dark:border-zinc-800">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{d.title}</span>
                    <span className="text-xs text-zinc-500">{(d.size / 1024).toFixed(1)} KB</span>
                    <label className="ml-auto flex items-center gap-1 text-xs">
                      <input type="checkbox" checked={d.includeInPrompts} onChange={async (e) => { await api(`/api/context/${d.id}`, { method: "PATCH", body: { includeInPrompts: e.target.checked } }); await reload(); }} />
                      include in prompts
                    </label>
                    <Button variant="ghost" className="px-1 py-0 text-xs" onClick={async () => { await api(`/api/context/${d.id}`, { method: "DELETE" }); await reload(); }} aria-label={`Delete ${d.title}`}>
                      Delete
                    </Button>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-zinc-500">{d.content}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

function MemoryTab({ data }: { data: ProjectResponse }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Technical decisions">
        {!data.decisions.length ? (
          <Empty>Decisions recorded by the developer are saved here when you approve a task. They are reused in later prompts.</Empty>
        ) : (
          <ul className="space-y-3">
            {data.decisions.map((d) => (
              <li key={d.id} className="text-sm">
                <div className="font-medium">{d.title}</div>
                <div className="text-zinc-700 dark:text-zinc-300">{d.decision}</div>
                {d.rationale && <div className="text-xs text-zinc-500">Why: {d.rationale}</div>}
                <div className="text-xs text-zinc-400">
                  {d.source} · {timeAgo(d.createdAt)}
                  {d.taskId && (
                    <>
                      {" · "}
                      <Link className="underline" href={`/tasks/${d.taskId}`}>
                        task
                      </Link>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Completed work summary (machine-generated)">
        {data.project.memorySummary ? <pre className="whitespace-pre-wrap text-xs">{data.project.memorySummary}</pre> : <Empty>Nothing completed yet.</Empty>}
      </Card>
    </div>
  );
}

function SettingsTab({ project, reload }: { project: Project; reload: () => Promise<void> }) {
  const [s, setS] = useState<ProjectSettings>(project.settings);
  const [testCmd, setTestCmd] = useState(project.settings.testCommand?.join(" ") ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api(`/api/projects/${project.id}`, { method: "PATCH", body: { settings: { ...s, testCommand: testCmd.trim() ? testCmd.trim().split(/\s+/) : null } } });
      setMsg("Settings saved.");
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const sel = (k: "pmProvider" | "devProvider" | "reviewProvider", opts: string[]) => (
    <select className={inputCls} value={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.value })}>
      {opts.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
  const num = (k: "maxRevisions" | "providerTimeoutMinutes" | "testTimeoutMinutes", min: number, max: number) => (
    <input type="number" min={min} max={max} className={inputCls} value={s[k]} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />
  );
  const check = (k: "allowTestExecution" | "allowDirtyRepo" | "autoAdvance", label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} />
      {label}
    </label>
  );
  return (
    <Card title="Roles, limits & permissions" actions={<Button variant="primary" onClick={save} busy={busy}>Save</Button>}>
      <ErrorBanner error={error} onDismiss={() => setError(null)} />
      {msg && <p className="mb-2 text-xs text-emerald-600">{msg}</p>}
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="PM provider">{sel("pmProvider", ["codex", "claude-cli", "mock"])}</Field>
        <Field label="Developer provider" hint="claude-manual = you run Claude Code yourself (default). claude-cli = automated; enable it once on the Providers page.">{sel("devProvider", ["claude-manual", "claude-cli", "mock"])}</Field>
        <Field label="Reviewer provider">{sel("reviewProvider", ["codex", "claude-cli", "mock"])}</Field>
        <Field label="Max revision rounds (default for new tasks)" hint="0–5. The reviewer↔developer loop stops here and asks you.">{num("maxRevisions", 0, 5)}</Field>
        <Field label="Provider timeout (minutes)">{num("providerTimeoutMinutes", 1, 60)}</Field>
        <Field label="Test timeout (minutes)">{num("testTimeoutMinutes", 1, 60)}</Field>
        <Field label="Test command" hint="Runs without a shell inside the task worktree, e.g. npm test">
          <input className={`${inputCls} font-mono`} value={testCmd} onChange={(e) => setTestCmd(e.target.value)} />
        </Field>
        <Field label="Base ref for new branches">
          <input className={`${inputCls} font-mono`} value={s.baseRef} onChange={(e) => setS({ ...s, baseRef: e.target.value })} />
        </Field>
        <Field label="Claude model (optional)" hint="e.g. sonnet. Blank = your Claude Code default">
          <input className={inputCls} value={s.claudeModel ?? ""} onChange={(e) => setS({ ...s, claudeModel: e.target.value || null })} />
        </Field>
        <Field label="Codex model (optional)" hint="Blank = your Codex default">
          <input className={inputCls} value={s.codexModel ?? ""} onChange={(e) => setS({ ...s, codexModel: e.target.value || null })} />
        </Field>
      </div>
      <div className="mt-4 space-y-2">
        {check("allowTestExecution", "Execution permission: allow DevRelay to run the test command in task worktrees")}
        {check("autoAdvance", "Auto-advance: after you approve, run developer → review → revision automatically (within the revision limit)")}
        {check("allowDirtyRepo", "Allow dispatch when the main repository has uncommitted changes (worktrees stay isolated)")}
      </div>
      <p className="mt-4 text-xs text-zinc-500">Code changes always need per-task authorisation. DevRelay never merges, pushes, deploys or deletes branches.</p>
    </Card>
  );
}
