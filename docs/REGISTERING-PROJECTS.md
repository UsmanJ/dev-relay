# Registering projects

DevRelay works only with repositories you register explicitly. It never clones anything, never guesses paths, and never touches a repo that isn't registered.

## Requirements for a project

- A local Git repository with at least one commit.
- The **absolute path to the repository root**. A subfolder or a relative path is rejected.
- Optional: a GitHub URL (`https://github.com/<owner>/<repo>`), used only as a link.

## Dashboard

**Projects → Register project.** Fill in the name and path. DevRelay runs `git rev-parse --show-toplevel` to verify the path before saving. Then use the project tabs:

- **Context:** description, product goals, user requirements, architecture, engineering constraints, and project-specific instructions. Your instructions are stored separately from DevRelay's machine-generated summary. You can also import Markdown or text notes here, for example an export of an earlier ChatGPT discussion. DevRelay cannot sync private ChatGPT conversations, so you have to export or copy them yourself.
- **Settings:** the provider for each role, max revision rounds, timeouts, test command, execution permissions, base ref and model aliases.
- **Memory:** decisions captured from accepted tasks, and the completed-work summary.

## CLI

```powershell
npm run relay -- project add --name "My App" --repo "C:\code\my-app" --github https://github.com/owner/my-app `
  --test-cmd "npm test" --allow-tests
npm run relay -- project list
npm run relay -- project set "My App" maxRevisions=1 devProvider=claude-manual
npm run relay -- project import "My App" .\notes\product-brief.md --title "Product brief"

npm run relay -- task new "My App" "Users can export their data as CSV from the settings page"
npm run relay -- task list "My App"
npm run relay -- task spec <taskId>                      # PM drafts the spec
npm run relay -- task spec <taskId> --feedback "Q-1: CSV only, no Excel"
npm run relay -- task approve <taskId> --authorize-execution   # dev → review → revisions run automatically
npm run relay -- task show <taskId>
npm run relay -- task decide <taskId> approve_merge      # records your decision; you merge manually
```

To run a whole cycle in one command, stopping at spec approval unless you pass `--yes`:

```powershell
npm run relay -- run "My App" "Fix the crash when the profile photo is missing"
```

## Settings reference

| Setting | Default | Notes |
|---|---|---|
| `pmProvider` / `devProvider` / `reviewProvider` | `codex` / `claude-manual` / `codex` | any registered adapter that supports the role |
| `maxRevisions` | 2 | 0–5; the loop stops and asks you after this many rounds |
| `allowTestExecution` | false | lets DevRelay run `testCommand` in task worktrees |
| `testCommand` | none | argv, e.g. `npm test`; no shell syntax allowed |
| `allowDirtyRepo` | false | if false, a dirty main working tree needs per-task approval |
| `autoAdvance` | true | after approval, chain developer → review → revisions automatically |
| `baseRef` | `HEAD` | where new task branches start |
| `providerTimeoutMinutes` / `testTimeoutMinutes` | 15 / 10 | hard ceiling 60 |
| `claudeModel` / `codexModel` | none | optional model alias passed to the CLI |

## Where things live

Everything is under `data/` (or `DEVRELAY_DATA_DIR`), and all of it is git-ignored:

- `data/hub.db`: SQLite database
- `data/worktrees/<taskId>`: isolated worktree for each task (branch `devrelay/<slug>-<id>`)
- `data/handoffs/<taskId>/round-N/`: `TASK.md`, `result.schema.json` and `RESULT.json`
- `data/samples/`: sample repos created by `npm run demo`

DevRelay never deletes worktrees or branches. When you have finished with a task:

```powershell
git -C "C:\code\my-app" worktree remove "<worktree path>"
git -C "C:\code\my-app" branch -d devrelay/<branch>
```
