"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api";

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(" ");
}

export function Card({ title, actions, children, className }: { title?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-lg border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900", className)}>
      {(title || actions) && (
        <div className="mb-3 flex items-center gap-2">
          {title && <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">{title}</h2>}
          <div className="ml-auto flex gap-2">{actions}</div>
        </div>
      )}
      {children}
    </section>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger" | "ghost"; busy?: boolean };
export function Button({ variant = "secondary", busy, className, children, disabled, ...rest }: BtnProps) {
  const styles = {
    primary: "bg-indigo-600 text-white hover:bg-indigo-500 disabled:bg-indigo-300",
    secondary: "border border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-800 dark:hover:bg-zinc-700",
    danger: "border border-red-300 bg-white text-red-700 hover:bg-red-50 dark:border-red-800 dark:bg-zinc-800 dark:text-red-400",
    ghost: "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800",
  }[variant];
  return (
    <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} className={cx("inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-60", styles, className)}>
      {busy && <Spinner />}
      {children}
    </button>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span role="status" className="inline-flex items-center gap-2">
      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden />
      {label ? <span className="text-sm">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export function ErrorBanner({ error, onDismiss }: { error: string | null; onDismiss?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="mb-3 flex items-start gap-2 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-300">
      <span className="flex-1 whitespace-pre-wrap">{error}</span>
      {onDismiss && (
        <button onClick={onDismiss} aria-label="Dismiss error" className="text-red-600">
          ×
        </button>
      )}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-zinc-300 p-4 text-center text-sm text-zinc-500 dark:border-zinc-700">{children}</p>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  pm_running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  dev_running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  review_running: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  spec_review: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  awaiting_dev_result: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  awaiting_merge_approval: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  human_decision_required: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  changes_requested: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  spec_approved: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  review_pending: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  completed: "bg-emerald-600 text-white",
  failed: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  paused: "bg-zinc-200 text-zinc-800 dark:bg-zinc-700 dark:text-zinc-200",
  cancelled: "bg-zinc-200 text-zinc-500 line-through dark:bg-zinc-800",
  rejected: "bg-zinc-200 text-zinc-500 dark:bg-zinc-800",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pm_running: "PM drafting",
  spec_review: "Spec awaiting approval",
  spec_approved: "Spec approved",
  dev_running: "Developer running",
  awaiting_dev_result: "Awaiting dev result",
  review_pending: "Ready for review",
  review_running: "Reviewer running",
  changes_requested: "Changes requested",
  awaiting_merge_approval: "Approved · your merge call",
  human_decision_required: "Decision needed",
  completed: "Completed",
  rejected: "Rejected",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
};

export function StatusBadge({ status }: { status: string }) {
  const running = status.endsWith("_running");
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium", STATUS_COLORS[status] ?? STATUS_COLORS.draft)}>
      {running && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const ROLE_STYLE: Record<string, { label: string; cls: string }> = {
  pm: { label: "PM", cls: "border-l-sky-500 bg-sky-50/60 dark:bg-sky-950/30" },
  developer: { label: "Developer", cls: "border-l-violet-500 bg-violet-50/60 dark:bg-violet-950/30" },
  reviewer: { label: "Reviewer", cls: "border-l-emerald-500 bg-emerald-50/60 dark:bg-emerald-950/30" },
  human: { label: "You", cls: "border-l-amber-500 bg-amber-50/60 dark:bg-amber-950/30" },
  system: { label: "DevRelay", cls: "border-l-zinc-400 bg-zinc-50 dark:bg-zinc-900" },
};

/** Fetch JSON with optional polling. */
export function useApi<T>(path: string | null, pollMs?: number | ((data: T | null) => number | undefined)) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const dataRef = useRef<T | null>(null);
  const reload = useCallback(async () => {
    if (!path) return;
    try {
      const d = await api<T>(path);
      dataRef.current = d;
      setData(d);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    const loop = async () => {
      await reload();
      if (stopped) return;
      const ms = typeof pollMs === "function" ? pollMs(dataRef.current) : pollMs;
      if (ms) timer = setTimeout(loop, ms);
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [reload, pollMs]);
  return { data, error, loading, reload, setError };
}

export function timeAgo(iso: string) {
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}