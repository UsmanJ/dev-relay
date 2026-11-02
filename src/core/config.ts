import path from "node:path";
import fs from "node:fs";

/** Root directory for all local runtime data (DB, handoffs, worktrees, logs). Git-ignored. */
export function dataDir(): string {
  const dir = process.env.DEVRELAY_DATA_DIR?.trim() || path.join(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(dataDir(), "hub.db");
}

export function handoffDir(taskId: string): string {
  if (!/^[a-z0-9_-]+$/i.test(taskId)) throw new Error("Invalid task id");
  const dir = path.join(dataDir(), "handoffs", taskId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function worktreesRoot(): string {
  const dir = path.join(dataDir(), "worktrees");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function migrationsDir(): string {
  return path.join(process.cwd(), "drizzle");
}

/** Hard safety limits. Not user-configurable above these ceilings. */
export const LIMITS = {
  maxConcurrentJobs: 2,
  maxStdoutBytes: 4 * 1024 * 1024,
  maxStderrBytes: 1 * 1024 * 1024,
  defaultProviderTimeoutMs: 15 * 60 * 1000,
  maxProviderTimeoutMs: 60 * 60 * 1000,
  defaultTestTimeoutMs: 10 * 60 * 1000,
  maxDiffCharsForPrompt: 120_000,
  maxContextDocCharsForPrompt: 20_000,
  maxRevisionsCeiling: 5,
  excerptChars: 4_000,
} as const;