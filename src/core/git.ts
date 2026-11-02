/**
 * Git helpers. Read-mostly. The only write operation is `git worktree add -b`
 * (creating a NEW branch in a NEW directory under the hub's data dir).
 * Never: push, merge, rebase, reset, checkout of existing work, branch -d/-D,
 * worktree remove, clean, stash, tag or any force flag.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCommand, runProcess, type RunResult } from "./process";
import { HubError, truncate } from "./util";
import { worktreesRoot } from "./config";

const FORBIDDEN_SUBCOMMANDS = new Set(["push", "merge", "rebase", "reset", "clean", "stash", "tag", "checkout", "switch", "restore", "rm", "gc", "prune", "filter-branch", "commit", "am", "apply", "cherry-pick", "revert", "pull", "fetch", "clone", "remote", "config"]);

async function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<RunResult> {
  const cmd = resolveCommand("git");
  if (!cmd) throw new HubError("git was not found on PATH. Install Git for Windows.", "git");
  const sub = args[0] ?? "";
  if (FORBIDDEN_SUBCOMMANDS.has(sub)) throw new HubError(`Refusing forbidden git subcommand: ${sub}`, "permission");
  if (args.some((a) => a === "--force" || a === "-f" || a === "-D" || a === "--hard")) throw new HubError("Refusing destructive git flag", "permission");
  return runProcess({
    command: cmd,
    args: ["-c", "core.quotepath=false", "-c", "color.ui=never", ...args],
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    maxStdoutBytes: 16 * 1024 * 1024,
  });
}

async function gitOk(cwd: string, args: string[]): Promise<string> {
  const r = await git(cwd, args);
  if (r.spawnError) throw new HubError(`git failed to start: ${r.spawnError}`, "git");
  if (r.exitCode !== 0) throw new HubError(`git ${args[0]} failed: ${r.stderr.trim() || `exit ${r.exitCode}`}`, "git");
  return r.stdout;
}

export function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase() : resolved.replace(/\/+$/, "");
}

/**
 * Canonical path for comparisons: resolves symlinks, junctions, Windows 8.3 short
 * names (e.g. RUNNER~1) and macOS /var -> /private/var. Falls back to path.resolve
 * when the path does not exist.
 */
export function canonicalPath(p: string): string {
  try {
    return normalizePath(fs.realpathSync.native(p));
  } catch {
    return normalizePath(p);
  }
}

export interface RepoInfo {
  topLevel: string;
  branch: string | null;
  headCommit: string | null;
  dirty: boolean;
  dirtyFiles: string[];
}

/** Verify a path is an existing local Git repository root. Throws HubError otherwise. */
export async function verifyRepo(repoPath: string): Promise<RepoInfo> {
  if (!repoPath || !path.isAbsolute(repoPath)) throw new HubError("Repository path must be an absolute path.", "validation");
  if (!fs.existsSync(repoPath) || !fs.statSync(repoPath).isDirectory()) throw new HubError(`Directory does not exist: ${repoPath}`, "validation");
  const top = (await git(repoPath, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (!top) throw new HubError(`Not a Git repository: ${repoPath}`, "validation");
  if (canonicalPath(top) !== canonicalPath(repoPath)) {
    throw new HubError(`Path must be the repository root. Root is: ${path.resolve(top)}`, "validation");
  }
  const branchRes = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const headRes = await git(repoPath, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  const status = await statusPorcelain(repoPath);
  return {
    topLevel: path.resolve(top),
    branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() : null,
    headCommit: headRes.exitCode === 0 ? headRes.stdout.trim() : null,
    dirty: status.length > 0,
    dirtyFiles: status,
  };
}

export async function statusPorcelain(cwd: string): Promise<string[]> {
  const out = await gitOk(cwd, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  return out.split(/\r?\n/).filter(Boolean);
}

export const BRANCH_RE = /^devrelay\/[a-z0-9][a-z0-9._-]{0,80}$/;

export function branchNameFor(taskId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const short = taskId.replace(/^task_/, "").slice(-8);
  return `devrelay/${slug || "task"}-${short}`;
}

export interface WorktreeInfo {
  path: string;
  branch: string;
  baseRef: string;
  baseCommit: string;
}

/**
 * Create an isolated worktree on a NEW branch from `baseRef` (default: HEAD).
 * The destination is always inside the hub's data/worktrees directory.
 */
export async function createWorktree(repoPath: string, taskId: string, branch: string, baseRef = "HEAD"): Promise<WorktreeInfo> {
  if (!BRANCH_RE.test(branch)) throw new HubError(`Invalid branch name: ${branch}`, "validation");
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(baseRef) || baseRef.startsWith("-")) throw new HubError("Invalid base ref", "validation");
  const baseCommit = (await gitOk(repoPath, ["rev-parse", "--verify", `${baseRef}^{commit}`])).trim();
  const existing = await git(repoPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  if (existing.exitCode === 0) throw new HubError(`Branch already exists: ${branch}. Refusing to reuse it.`, "conflict");
  const dest = path.join(worktreesRoot(), taskId);
  if (fs.existsSync(dest)) throw new HubError(`Worktree directory already exists: ${dest}`, "conflict");
  await gitOk(repoPath, ["worktree", "add", "-b", branch, dest, baseCommit]);
  return { path: dest, branch, baseRef, baseCommit };
}

/** Ensure a worktree path is one the hub created (inside data/worktrees). */
export function assertHubWorktree(p: string): void {
  const root = canonicalPath(worktreesRoot());
  const np = canonicalPath(p);
  if (!np.startsWith(root + (process.platform === "win32" ? "\\" : "/"))) throw new HubError("Worktree path is outside the hub worktrees directory.", "permission");
}

export interface DiffSummary {
  baseCommit: string;
  headCommit: string | null;
  branch: string | null;
  commits: string[];
  stat: string;
  diff: string;
  untracked: Array<{ path: string; content: string }>;
  changedFiles: string[];
  uncommittedChanges: boolean;
}

/** Capture everything that changed in the worktree relative to baseCommit (committed + uncommitted + untracked). */
export async function captureDiff(cwd: string, baseCommit: string, maxChars = 400_000): Promise<DiffSummary> {
  if (!/^[0-9a-f]{7,64}$/i.test(baseCommit)) throw new HubError("Invalid base commit", "validation");
  const head = (await git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"])).stdout.trim() || null;
  const branch = (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim() || null;
  const commits = (await gitOk(cwd, ["log", "--oneline", "--no-decorate", `${baseCommit}..HEAD`])).split(/\r?\n/).filter(Boolean);
  const stat = await gitOk(cwd, ["diff", "--stat", baseCommit]);
  const diff = await gitOk(cwd, ["diff", "--no-ext-diff", baseCommit]);
  const names = (await gitOk(cwd, ["diff", "--name-only", baseCommit])).split(/\r?\n/).filter(Boolean);
  const status = await statusPorcelain(cwd);
  const untrackedPaths = (await gitOk(cwd, ["ls-files", "--others", "--exclude-standard"])).split(/\r?\n/).filter(Boolean);
  const untracked: DiffSummary["untracked"] = [];
  let budget = 100_000;
  for (const rel of untrackedPaths.slice(0, 200)) {
    const abs = path.join(cwd, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      if (st.size > 200_000 || budget <= 0) {
        untracked.push({ path: rel, content: `[not shown: ${st.size} bytes]` });
        continue;
      }
      const buf = fs.readFileSync(abs);
      const content = buf.includes(0) ? "[binary file]" : buf.toString("utf8");
      budget -= content.length;
      untracked.push({ path: rel, content });
    } catch {
      /* ignore unreadable */
    }
  }
  return {
    baseCommit,
    headCommit: head,
    branch,
    commits,
    stat: [stat.trim(), ...untrackedPaths.slice(0, 50).map((u) => ` ${u} | new file (untracked)`)].filter(Boolean).join("\n"),
    diff: truncate(diff, maxChars),
    untracked,
    changedFiles: [...new Set([...names, ...untrackedPaths])],
    uncommittedChanges: status.length > 0,
  };
}
