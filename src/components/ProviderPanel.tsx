"use client";

import Link from "next/link";
import type { StatusResponse } from "./types";
import { Card, Spinner, cx } from "./ui";

export function ProviderPanel({ status, compact }: { status: StatusResponse | null; compact?: boolean }) {
  if (!status) return <Card title="Providers"><Spinner label="Checking local CLIs…" /></Card>;
  const env = status.environment;
  return (
    <Card title="Providers" actions={compact ? <Link className="text-xs text-indigo-600 hover:underline" href="/providers">Details</Link> : undefined}>
      {env.billingEnvVars.length > 0 && (
        <p role="alert" className="mb-3 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
          Billing-risk variables set in this environment: <b>{env.billingEnvVars.join(", ")}</b>. DevRelay strips them from every child process so your CLI logins are used instead.
        </p>
      )}
      <ul className="space-y-2">
        {env.providers.map((p) => {
          const ok = p.installed && p.authenticated !== false && p.automationAllowed;
          return (
            <li key={p.id} className="text-sm">
              <div className="flex items-center gap-2">
                <span className={cx("h-2 w-2 rounded-full", ok ? "bg-emerald-500" : p.installed ? "bg-amber-500" : "bg-red-500")} aria-hidden />
                <span className="font-medium">{p.label}</span>
                <span className="ml-auto text-xs text-zinc-500">{!p.installed ? "not installed" : p.authenticated === false ? "not logged in" : ok ? "ready" : "blocked"}</span>
              </div>
              {!compact && (
                <div className="ml-4 mt-1 space-y-0.5 text-xs text-zinc-600 dark:text-zinc-400">
                  <div>version: {p.version ?? "—"} · auth: {p.authMethod ?? "—"} · automation: {p.automationAllowed ? "allowed" : "no"}</div>
                  {p.notes.map((n, i) => (
                    <div key={i}>• {n}</div>
                  ))}
                  {p.error && <div className="text-red-600">! {p.error}</div>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {status.recentErrors.length > 0 && !compact && (
        <div className="mt-4">
          <h3 className="mb-1 text-xs font-semibold uppercase text-zinc-500">Recent provider errors</h3>
          <ul className="space-y-1 text-xs">
            {status.recentErrors.map((e) => (
              <li key={e.id} className="text-red-700 dark:text-red-400">
                <span className="font-mono">{e.startedAt.slice(0, 19).replace("T", " ")}</span> {e.provider}/{e.role} [{e.errorKind ?? e.status}] {e.error?.slice(0, 200)}
                {e.taskId && (
                  <Link className="ml-1 underline" href={`/tasks/${e.taskId}`}>
                    task
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}