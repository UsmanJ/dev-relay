/**
 * Safe subprocess execution.
 *
 *  - Never uses a shell (`shell: false`), so arguments are passed verbatim and
 *    cannot be interpreted as shell syntax. User input is never a command line.
 *  - npm-style `.cmd` shims on Windows are resolved to the real executable or
 *    JS entry point, because Node refuses to spawn .cmd/.bat without a shell.
 *  - Enforces timeout, stdout/stderr byte caps and cancellation via AbortSignal.
 *  - On cancellation/timeout the whole child process tree is terminated.
 */
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { LIMITS } from "./config";

export interface ResolvedCommand {
  file: string;
  /** Arguments that must precede user arguments (e.g. the JS entry for node). */
  prefixArgs: string[];
  displayName: string;
}

const isWin = process.platform === "win32";

function pathDirs(): string[] {
  const p = process.env.PATH ?? process.env.Path ?? "";
  return p.split(path.delimiter).filter(Boolean);
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Find `name` on PATH. Returns absolute path of the first match. */
export function which(name: string): string | null {
  if (path.isAbsolute(name)) return fileExists(name) ? name : null;
  const exts = isWin ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  for (const dir of pathDirs()) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (fileExists(candidate)) return candidate;
    }
  }
  return null;
}

/** Parse an npm-generated .cmd shim to find what it actually runs. */
export function parseCmdShim(shimPath: string): ResolvedCommand | null {
  let text: string;
  try {
    text = fs.readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(shimPath);
  const base = path.basename(shimPath).toLowerCase();

  // npm / npx shims shipped with Node itself.
  if (base === "npm.cmd" || base === "npx.cmd") {
    const cli = path.join(dir, "node_modules", "npm", "bin", base === "npm.cmd" ? "npm-cli.js" : "npx-cli.js");
    if (fileExists(cli)) return { file: process.execPath, prefixArgs: [cli], displayName: base.replace(".cmd", "") };
  }

  // Standard cmd-shim output: "%dp0%\node_modules\pkg\bin\x.js" or "...\x.exe"
  const matches = [...text.matchAll(/"%(?:~)?dp0%?\\([^"]+)"/gi)].map((m) => m[1]!).filter((m) => !/node\.exe$/i.test(m));
  const target = matches.at(-1);
  if (!target) return null;
  // Shim paths use Windows separators; normalise so parsing is deterministic on any OS.
  const abs = path.resolve(dir, ...target.split(/[\\/]+/));
  if (!fileExists(abs)) return null;
  if (/\.(c|m)?js$/i.test(abs)) return { file: process.execPath, prefixArgs: [abs], displayName: path.basename(shimPath) };
  if (/\.exe$/i.test(abs)) return { file: abs, prefixArgs: [], displayName: path.basename(shimPath) };
  return null;
}

/**
 * Resolve a program name (or absolute path) to something spawnable without a shell.
 * Returns null if not found or not safely resolvable.
 */
export function resolveCommand(nameOrPath: string): ResolvedCommand | null {
  if (!nameOrPath || /[\0\r\n]/.test(nameOrPath)) return null;
  // `node` resolves to the running Node binary for consistency.
  if (nameOrPath === "node") return { file: process.execPath, prefixArgs: [], displayName: "node" };
  const found = which(nameOrPath);
  if (!found) return null;
  if (isWin && /\.(cmd|bat)$/i.test(found)) return parseCmdShim(found);
  if (/\.(c|m)?js$/i.test(found)) return { file: process.execPath, prefixArgs: [found], displayName: path.basename(found) };
  return { file: found, prefixArgs: [], displayName: path.basename(found) };
}

export interface RunOptions {
  command: ResolvedCommand;
  args: string[];
  cwd: string;
  input?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  onStdoutLine?: (line: string) => void;
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTruncated: boolean;
  durationMs: number;
  spawnError?: string;
}

export function validateArgs(args: unknown[]): string[] {
  return args.map((a, i) => {
    if (typeof a !== "string") throw new Error(`Argument ${i} is not a string`);
    if (a.includes("\0")) throw new Error(`Argument ${i} contains a NUL byte`);
    if (a.length > 100_000) throw new Error(`Argument ${i} is too long`);
    return a;
  });
}

/** Kill a process and all of its descendants. */
export function killTree(pid: number): void {
  if (isWin) {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    execFile(taskkill, ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* gone */
      }
    }, 3000).unref();
  }
}

export function runProcess(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs ?? LIMITS.defaultProviderTimeoutMs, LIMITS.maxProviderTimeoutMs);
  const maxOut = opts.maxStdoutBytes ?? LIMITS.maxStdoutBytes;
  const maxErr = opts.maxStderrBytes ?? LIMITS.maxStderrBytes;
  return new Promise((resolve) => {
    // Validation inside the executor so bad input rejects the promise rather than throwing synchronously.
    const args = [...opts.command.prefixArgs, ...validateArgs(opts.args)];
    if (!fs.existsSync(opts.cwd) || !fs.statSync(opts.cwd).isDirectory()) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: false, stdoutTruncated: false, durationMs: 0, spawnError: `Working directory does not exist: ${opts.cwd}` });
      return;
    }
    if (opts.signal?.aborted) {
      resolve({ exitCode: null, stdout: "", stderr: "", timedOut: false, cancelled: true, stdoutTruncated: false, durationMs: 0 });
      return;
    }

    const child = spawn(opts.command.file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: !isWin, // own process group on POSIX so we can kill the tree
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let outBytes = 0;
    let errBytes = 0;
    let stdoutTruncated = false;
    let timedOut = false;
    let cancelled = false;
    let lineBuf = "";
    let settled = false;

    const stop = () => {
      if (child.pid && child.exitCode === null) killTree(child.pid);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      stop();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      const bytes = Buffer.byteLength(chunk);
      if (outBytes + bytes > maxOut) {
        stdoutTruncated = true;
        stdout += chunk.slice(0, Math.max(0, maxOut - outBytes));
        outBytes = maxOut;
        stop();
        return;
      }
      outBytes += bytes;
      stdout += chunk;
      if (opts.onStdoutLine) {
        lineBuf += chunk;
        let idx: number;
        while ((idx = lineBuf.indexOf("\n")) >= 0) {
          const line = lineBuf.slice(0, idx).replace(/\r$/, "");
          lineBuf = lineBuf.slice(idx + 1);
          if (line) opts.onStdoutLine(line);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (errBytes >= maxErr) return;
      errBytes += Buffer.byteLength(chunk);
      stderr += chunk;
    });

    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, timedOut, cancelled, stdoutTruncated, durationMs: Date.now() - started, spawnError });
    };

    child.on("error", (err) => finish(null, err.message));
    child.on("close", (code) => finish(code));

    child.stdin.on("error", () => undefined); // child may exit before reading stdin
    if (opts.input !== undefined) child.stdin.end(opts.input, "utf8");
    else child.stdin.end();
  });
}

/** Environment for provider CLIs: strips API-key variables so subscription login is used, never pay-as-you-go keys. */
export function subscriptionEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[k];
  env.NO_COLOR = "1";
  return env;
}
