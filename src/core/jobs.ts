/**
 * In-process job tracking. One active provider job per task, a global cap on
 * concurrent provider jobs, cancellation via AbortController (which kills the
 * child process tree), and `waitForIdle` so the CLI/tests can await a whole
 * auto-advancing chain of steps.
 */
import { LIMITS } from "./config";
import { HubError } from "./util";

interface ActiveJob {
  taskId: string;
  step: string;
  controller: AbortController;
  startedAt: number;
}

interface JobState {
  active: Map<string, ActiveJob>;
  pending: Map<string, Set<Promise<unknown>>>;
}

const g = globalThis as unknown as { __devrelayJobs?: JobState };
function state(): JobState {
  g.__devrelayJobs ??= { active: new Map(), pending: new Map() };
  return g.__devrelayJobs;
}

/** Track any async work belonging to a task so waitForIdle can await it. */
export function track<T>(taskId: string, p: Promise<T>): Promise<T> {
  const s = state();
  let set = s.pending.get(taskId);
  if (!set) {
    set = new Set();
    s.pending.set(taskId, set);
  }
  set.add(p);
  const done = () => {
    set!.delete(p);
    if (set!.size === 0) s.pending.delete(taskId);
  };
  p.then(done, done);
  return p;
}

/**
 * Register a provider job synchronously (so state + job registration are atomic
 * from the caller's perspective) and run `body` in the background.
 */
export function startJob(taskId: string, step: string, body: (signal: AbortSignal) => Promise<void>): void {
  const s = state();
  if (s.active.has(taskId)) throw new HubError(`A job (${s.active.get(taskId)!.step}) is already running for this task.`, "conflict", 409);
  if (s.active.size >= LIMITS.maxConcurrentJobs) throw new HubError(`Too many concurrent jobs (max ${LIMITS.maxConcurrentJobs}). Wait for a running task to finish.`, "conflict", 429);
  const controller = new AbortController();
  s.active.set(taskId, { taskId, step, controller, startedAt: Date.now() });
  const p = (async () => {
    try {
      await body(controller.signal);
    } finally {
      s.active.delete(taskId);
    }
  })();
  track(taskId, p).catch(() => undefined);
}

export function canStartJob(taskId: string): { ok: true } | { ok: false; reason: string } {
  const s = state();
  if (s.active.has(taskId)) return { ok: false, reason: "A job is already running for this task." };
  if (s.active.size >= LIMITS.maxConcurrentJobs) return { ok: false, reason: `Too many concurrent jobs (max ${LIMITS.maxConcurrentJobs}).` };
  return { ok: true };
}

export function cancelJob(taskId: string): boolean {
  const j = state().active.get(taskId);
  if (!j) return false;
  j.controller.abort();
  return true;
}

export function activeJob(taskId: string): { step: string; startedAt: number } | null {
  const j = state().active.get(taskId);
  return j ? { step: j.step, startedAt: j.startedAt } : null;
}

export function activeJobs(): Array<{ taskId: string; step: string; startedAt: number }> {
  return [...state().active.values()].map((j) => ({ taskId: j.taskId, step: j.step, startedAt: j.startedAt }));
}

/** Wait until the task has no running job and no pending chained work. */
export async function waitForIdle(taskId: string, timeoutMs = 3_600_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const set = state().pending.get(taskId);
    if (!set || set.size === 0) {
      await new Promise((r) => setImmediate(r));
      const again = state().pending.get(taskId);
      if (!again || again.size === 0) return;
      continue;
    }
    if (Date.now() > deadline) throw new HubError("Timed out waiting for task to become idle", "timeout");
    await Promise.allSettled([...set]);
  }
}
