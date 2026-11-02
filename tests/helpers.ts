import { afterAll, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb } from "../src/core/db/client";
import { createSampleRepo } from "../src/core/demo";
import * as repo from "../src/core/repo";
import { waitForIdle } from "../src/core/jobs";

/** Isolate each test file in its own temp data directory (DB, worktrees, handoffs). */
export function useTempDataDir(): { dir: () => string } {
  let dir = "";
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "devrelay-test-"));
    process.env.DEVRELAY_DATA_DIR = dir;
  });
  afterAll(() => {
    closeDb();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* Windows may hold handles briefly; temp dir is disposable */
    }
  });
  return { dir: () => dir };
}

export async function mockProject(settings: Partial<repo.ProjectSettings> = {}, name = `p-${Math.random().toString(36).slice(2, 8)}`) {
  const repoPath = await createSampleRepo();
  return repo.createProject({
    name,
    repoPath,
    settings: { pmProvider: "mock", devProvider: "mock", reviewProvider: "mock", testCommand: ["node", "--test"], allowTestExecution: true, maxRevisions: 2, ...settings },
  });
}

export async function settle(taskId: string) {
  await waitForIdle(taskId, 60_000);
  return repo.getTask(taskId);
}