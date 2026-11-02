"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "./api";
import { ProviderPanel } from "./ProviderPanel";
import type { Project, StatusResponse } from "./types";
import { Button, Card, Empty, ErrorBanner, Field, inputCls, Spinner, StatusBadge, useApi } from "./ui";

export function HomeView() {
  const projects = useApi<Project[]>("/api/projects", 5000);
  const status = useApi<StatusResponse>("/api/status", 30000);
  const [showForm, setShowForm] = useState(false);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-4">
        <div className="flex items-center">
          <h1 className="text-xl font-semibold">Projects</h1>
          <Button variant="primary" className="ml-auto" onClick={() => setShowForm((s) => !s)} aria-expanded={showForm}>
            {showForm ? "Close" : "Register project"}
          </Button>
        </div>
        {showForm && <ProjectForm onCreated={() => setShowForm(false)} />}
        <ErrorBanner error={projects.error} />
        {projects.loading ? (
          <Spinner label="Loading projects…" />
        ) : !projects.data?.length ? (
          <Empty>
            No projects yet. Register a local Git repository, or try the offline demo: <code className="mono">npm run demo</code>
          </Empty>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2">
            {projects.data.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="block rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-indigo-400 dark:border-zinc-800 dark:bg-zinc-900">
                  <div className="font-medium">{p.name}</div>
                  <div className="mt-0.5 truncate font-mono text-xs text-zinc-500" title={p.repoPath}>
                    {p.repoPath}
                  </div>
                  {p.description && <p className="mt-2 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">{p.description}</p>}
                  <div className="mt-3 flex flex-wrap gap-1">
                    {Object.entries(p.taskCounts ?? {}).map(([s, n]) => (
                      <span key={s} className="inline-flex items-center gap-1">
                        <StatusBadge status={s} />
                        <span className="text-xs text-zinc-500">{n}</span>
                      </span>
                    ))}
                    {!Object.keys(p.taskCounts ?? {}).length && <span className="text-xs text-zinc-500">No tasks yet</span>}
                  </div>
                  <div className="mt-2 text-xs text-zinc-500">
                    PM {p.settings.pmProvider} · Dev {p.settings.devProvider} · Review {p.settings.reviewProvider}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
      <aside className="space-y-4">
        <ProviderPanel status={status.data} compact />
        <Card title="How it works">
          <ol className="list-decimal space-y-1 pl-4 text-sm text-zinc-600 dark:text-zinc-400">
            <li>Describe a feature or bug.</li>
            <li>The PM agent drafts a spec with acceptance criteria.</li>
            <li>You edit and approve it, and authorise code changes.</li>
            <li>The developer agent works in an isolated git worktree.</li>
            <li>DevRelay captures the diff and runs your tests.</li>
            <li>The reviewer agent checks the evidence against the criteria.</li>
            <li>You decide. DevRelay never merges or pushes.</li>
          </ol>
        </Card>
      </aside>
    </div>
  );
}

function ProjectForm({ onCreated }: { onCreated: () => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", repoPath: "", githubUrl: "", description: "", productGoals: "", constraints: "", instructions: "", devProvider: "claude-cli", pmProvider: "codex", reviewProvider: "codex", testCommand: "", allowTestExecution: false });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const p = await api<Project>("/api/projects", {
        body: {
          name: f.name,
          repoPath: f.repoPath,
          githubUrl: f.githubUrl || null,
          description: f.description,
          productGoals: f.productGoals,
          constraints: f.constraints,
          instructions: f.instructions,
          settings: { pmProvider: f.pmProvider, devProvider: f.devProvider, reviewProvider: f.reviewProvider, testCommand: f.testCommand.trim() ? f.testCommand.trim().split(/\s+/) : null, allowTestExecution: f.allowTestExecution },
        },
      });
      onCreated();
      router.push(`/projects/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Register a local repository">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <ErrorBanner error={error} onDismiss={() => setError(null)} />
        </div>
        <Field label="Name *">
          <input required className={inputCls} value={f.name} onChange={set("name")} placeholder="My project" />
        </Field>
        <Field label="Local repository path *" hint="Absolute path to the repository root. It is verified with git before registering. Nothing is cloned or modified.">
          <input required className={`${inputCls} font-mono`} value={f.repoPath} onChange={set("repoPath")} placeholder="C:\path\to\repo" />
        </Field>
        <Field label="GitHub URL (optional)">
          <input className={inputCls} value={f.githubUrl} onChange={set("githubUrl")} placeholder="https://github.com/owner/repo" />
        </Field>
        <Field label="Description">
          <input className={inputCls} value={f.description} onChange={set("description")} />
        </Field>
        <Field label="Product goals">
          <textarea rows={3} className={inputCls} value={f.productGoals} onChange={set("productGoals")} />
        </Field>
        <Field label="Engineering constraints">
          <textarea rows={3} className={inputCls} value={f.constraints} onChange={set("constraints")} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Project instructions" hint="Written by you; included in every agent prompt. Kept separate from generated summaries.">
            <textarea rows={3} className={inputCls} value={f.instructions} onChange={set("instructions")} />
          </Field>
        </div>
        <Field label="PM provider">
          <select className={inputCls} value={f.pmProvider} onChange={set("pmProvider")}>
            <option value="codex">codex</option>
            <option value="claude-cli">claude-cli</option>
            <option value="mock">mock</option>
          </select>
        </Field>
        <Field label="Developer provider">
          <select className={inputCls} value={f.devProvider} onChange={set("devProvider")}>
            <option value="claude-cli">claude-cli (automated)</option>
            <option value="claude-manual">claude-manual (handoff)</option>
            <option value="mock">mock</option>
          </select>
        </Field>
        <Field label="Reviewer provider">
          <select className={inputCls} value={f.reviewProvider} onChange={set("reviewProvider")}>
            <option value="codex">codex</option>
            <option value="claude-cli">claude-cli</option>
            <option value="mock">mock</option>
          </select>
        </Field>
        <Field label="Test command (optional)" hint="Program and arguments, separated by spaces. Runs without a shell, e.g. npm test">
          <input className={`${inputCls} font-mono`} value={f.testCommand} onChange={set("testCommand")} placeholder="npm test" />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input type="checkbox" checked={f.allowTestExecution} onChange={set("allowTestExecution")} />
          Allow DevRelay to run the test command inside task worktrees
        </label>
        <div className="sm:col-span-2">
          <Button variant="primary" type="submit" busy={busy}>
            Verify &amp; register
          </Button>
        </div>
      </form>
    </Card>
  );
}
