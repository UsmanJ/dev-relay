#!/usr/bin/env bash
# DevRelay local verification for macOS / Linux.
#
# Runs the same checks as CI, plus an HTTP smoke test against the real
# dashboard server, in the current checkout. Writes a short pass/fail report
# you can paste into an issue or chat.
#
#   bash scripts/verify-local.sh           # offline only (default): no AI calls
#   bash scripts/verify-local.sh --real    # also: provider status + one real
#                                          # Codex -> Claude -> Codex cycle on a
#                                          # throwaway sample repo (uses YOUR plans)
#
# Safe by design: no sudo, no global installs, nothing outside this checkout
# except a temporary directory (deleted at the end unless --keep). Requires:
# Node.js 22 or 24, npm, git. Compatible with macOS's default bash 3.2.

set -u

REAL=0
KEEP=0
PORT=3210
for arg in "$@"; do
  case "$arg" in
    --real) REAL=1 ;;
    --keep) KEEP=1 ;;
    -h|--help) sed -n '2,17p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg (use --help)"; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.." || exit 2
ROOT="$(pwd)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/devrelay-verify.XXXXXX")"
LOGDIR="$WORK/logs"
mkdir -p "$LOGDIR"
REPORT="$ROOT/devrelay-verify-$(date +%Y%m%d-%H%M%S).txt"
SERVER_PID=""
RESULTS=""
FAILED=0

cleanup() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  if [ "$KEEP" -eq 0 ]; then rm -rf "$WORK"; else echo "Kept work dir: $WORK"; fi
}
trap cleanup EXIT INT TERM

logname() { echo "$LOGDIR/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '_').log"; }
say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
record() { RESULTS="${RESULTS}$(printf '%-34s %s' "$1" "$2")
"; }

# run_step "<label>" <command...>: runs with output to a log file, records PASS/FAIL
run_step() {
  label="$1"; shift
  log="$(logname "$label")"
  say "$label"
  start=$(date +%s)
  if "$@" >"$log" 2>&1; then
    record "$label" "PASS ($(( $(date +%s) - start ))s)"
    tail -n 3 "$log"
    return 0
  else
    record "$label" "FAIL (see report)"
    FAILED=1
    echo "---- last 40 lines of $label ----"
    tail -n 40 "$log"
    printf '\n---- %s (last 60 lines) ----\n' "$label" >>"$WORK/failures.txt"
    tail -n 60 "$log" >>"$WORK/failures.txt"
    return 1
  fi
}

# ---------------------------------------------------------------- environment
say "Environment"
OS="$(uname -s)"
if [ "$OS" = "Darwin" ]; then OSVER="macOS $(sw_vers -productVersion 2>/dev/null) ($(uname -m))"; else OSVER="$OS $(uname -r) ($(uname -m))"; fi
for tool in node npm git; do
  if ! command -v "$tool" >/dev/null 2>&1; then echo "Missing required tool: $tool"; exit 1; fi
done
NODEV="$(node -v)"; NPMV="$(npm -v)"; GITV="$(git --version | awk '{print $3}')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
echo "OS: $OSVER | node $NODEV | npm $NPMV | git $GITV | commit $SHA"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Node.js 22 or 24 is required (found $NODEV). Install from https://nodejs.org or via nvm, then re-run."
  exit 1
fi
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
  echo "Note: working tree has local changes; results reflect them."
fi

# Offline guards for every step except the optional --real section.
export DEVRELAY_OFFLINE=1
export DEVRELAY_DISABLE_CLAUDE_CLI=1
export NEXT_TELEMETRY_DISABLED=1
export DEVRELAY_DATA_DIR="$WORK/data"

# ---------------------------------------------------------------- CI-equivalent checks
run_step "npm ci" npm ci --no-audit --no-fund
run_step "typecheck" npm run typecheck
run_step "lint" npm run lint
run_step "unit + integration tests" npm test
run_step "production build" npm run build
run_step "offline demo (mock agents)" npm run demo

# ---------------------------------------------------------------- dashboard HTTP smoke
say "Dashboard HTTP smoke test"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  record "dashboard smoke test" "SKIPPED (port $PORT busy)"
  echo "Port $PORT is in use; stop whatever is using it and re-run to include this check."
else
  SAMPLE="$(npx --no-install tsx -e "import('./src/core/demo.ts').then(async m=>console.log(await m.createSampleRepo('smoke')))" 2>>"$LOGDIR/sample.log" | tail -n 1)"
  # Start the wrapper directly (not via npm) so one SIGTERM stops the whole server.
  node scripts/next.mjs start -H 127.0.0.1 -p "$PORT" >"$LOGDIR/server.log" 2>&1 &
  SERVER_PID=$!
  run_step "dashboard smoke test" node scripts/smoke-http.mjs "$SAMPLE" "http://127.0.0.1:$PORT"
  kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
fi

# ---------------------------------------------------------------- optional real providers
if [ "$REAL" -eq 1 ]; then
  say "Real providers (uses your own Codex / Claude Code logins and plan limits)"
  unset DEVRELAY_OFFLINE DEVRELAY_DISABLE_CLAUDE_CLI
  export DEVRELAY_DATA_DIR="$WORK/real-data"
  npm run doctor 2>&1 | tee "$LOGDIR/doctor.log" | sed -n '/\[/,$p'
  echo
  npm run relay -- claude-automation enable 2>/dev/null | sed -n '/Before enabling/,$p' | sed '/Not enabled/,$d'
  printf 'This applies only to the throwaway database in %s.\nType "yes" if all of the above is true and you want to run the real cycle: ' "$WORK"
  read -r answer
  if [ "$answer" = "yes" ]; then
    npm run relay -- claude-automation enable --i-acknowledge >/dev/null 2>&1
    run_step "real Codex->Claude->Codex demo" npm run demo -- --real
    grep -E "status:|Reviewer approved" "$(logname "real Codex->Claude->Codex demo")" 2>/dev/null
  else
    record "real Codex->Claude->Codex demo" "SKIPPED (not confirmed)"
  fi
fi

# ---------------------------------------------------------------- report
say "Summary"
{
  echo "DevRelay local verification"
  echo "date:    $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "commit:  $SHA"
  echo "system:  $OSVER"
  echo "tools:   node $NODEV, npm $NPMV, git $GITV"
  echo "mode:    $([ "$REAL" -eq 1 ] && echo 'offline + real providers' || echo 'offline only (no AI calls)')"
  echo
  printf '%s' "$RESULTS"
  if [ -f "$WORK/failures.txt" ]; then echo; echo "Failure details:"; cat "$WORK/failures.txt"; fi
} | sed -e "s#$HOME#~#g" >"$REPORT"
cat "$REPORT" | sed -n '1,20p'
echo
echo "Report written to: $REPORT"
echo "(Home-directory paths are replaced with ~. Review it before sharing.)"
[ "$FAILED" -eq 0 ] && echo "RESULT: ALL CHECKS PASSED" || echo "RESULT: SOME CHECKS FAILED"
exit "$FAILED"
