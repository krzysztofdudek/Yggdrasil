#!/usr/bin/env bash

set -uo pipefail

# The test step spawns the built CLI and asserts on its stdout/stderr BYTES —
# exact "Errors (N):" headers, a literal unwrapped "✓" glyph, no stray ANSI escape
# codes. FORCE_COLOR is a Node/chalk convention that OVERRIDES TTY auto-detection,
# so a spawned child writing to a pipe (which would normally disable color) still
# emits color codes when the invoking shell exports FORCE_COLOR — turning a clean
# tree into a false-red gate failure that has nothing to do with the code under
# test. Force it off here so the gate's outcome depends only on the code, never on
# the calling shell's environment.
export FORCE_COLOR=0

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
FAILED=()

run_step() {
  local label="$1"
  local cwd="$2"
  local command="$3"

  echo "[repo-check] $label"
  if (
    cd "$cwd"
    eval "$command"
  ); then
    return 0
  else
    FAILED+=("$label")
    return 1
  fi
}

run_step "CLI: typecheck" "$REPO_ROOT/source/cli" "npm run typecheck"
# The portal Playwright e2e specs run page.evaluate() in a real browser (DOM lib) and use
# bundler module resolution, so they are type-checked against their own tsconfig (the shipped-CLI
# typecheck above excludes them). Playwright's runner strips types via esbuild, so this is the
# real type bar on the specs.
run_step "CLI: typecheck (portal e2e)" "$REPO_ROOT/source/cli" "npm run typecheck:e2e"
run_step "CLI: lint" "$REPO_ROOT/source/cli" "npm run lint"
run_step "CLI: build" "$REPO_ROOT/source/cli" "npm run build"
# Guard (D4): the spawned-binary E2E suites self-skip via describe.skipIf(!distExists).
# If the build silently produced no dist/bin.js they would ALL no-op and the test
# run would go green over zero E2E coverage. Fail loudly here instead.
run_step "CLI: built binary present (E2E guard)" "$REPO_ROOT/source/cli" "test -f dist/bin.js || { echo 'dist/bin.js missing after build — E2E suites would silently skip'; exit 1; }"
run_step "CLI: pack-smoke (A2)" "$REPO_ROOT/source/cli" "node scripts/pack-smoke.mjs"
# Build the deterministic-verdict cache BEFORE the test run. The portal integration
# tests assert count-parity against the real repo's filled lock (e.g. an advisory
# deterministic refusal must tally as a warning). Those deterministic verdicts live in
# the gitignored .yg-lock.deterministic.json, which is absent in a fresh checkout (CI or
# a clean clone) — so without this the portal pairs read `unverified` and the parity
# assertions fail. This is the free, keyless rebuild (no reviewer, writes only the
# gitignored cache); the final "Graph: check" step below re-hashes it as the closing gate.
run_step "Graph: deterministic cache (test prerequisite)" "$REPO_ROOT" "node source/cli/dist/bin.js check --approve --only-deterministic"
if run_step "CLI: test (with coverage)" "$REPO_ROOT/source/cli" "npm run test:coverage"; then
  run_step "CLI: coverage >= 90%" "$REPO_ROOT/source/cli" "node -e \"
const fs = require('fs');
const summaryPath = './coverage/coverage-summary.json';
let reason = null;
let j = null;
if (!fs.existsSync(summaryPath)) {
  reason = 'the file does not exist';
} else {
  try {
    j = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch (e) {
    reason = 'the file exists but is not valid JSON (' + e.message + ')';
  }
  if (!reason) {
    const t = j && j.total;
    const need = ['lines', 'statements', 'functions', 'branches'];
    const missing = !t || need.some(function (k) { return !t[k] || typeof t[k].pct !== 'number'; });
    if (missing) {
      reason = 'the file exists and parses but is missing the total.{lines,statements,functions,branches}.pct fields this assertion reads';
    }
  }
}
if (reason) {
  console.error('WHAT: coverage/coverage-summary.json is missing or unreadable -- ' + reason + '.');
  console.error('WHY: this is NOT a coverage threshold miss. The test step above reported success, so this step cannot tell whether coverage actually regressed -- only that the report it needs is not usable. Likely causes: a coverage reporter misconfigured, json-summary dropped from the reporter list, coverage/ cleaned between steps, or a --coverage flag lost from the npm script.');
  console.error('NEXT: run npm run test:coverage directly and confirm coverage/coverage-summary.json is written with a valid total.{lines,statements,functions,branches}.pct shape; fix the reporter configuration, then re-run.');
  process.exit(1);
}
const t = j.total;
const lines = t.lines.pct;
const stmts = t.statements.pct;
const funcs = t.functions.pct;
const br = t.branches.pct;
if (lines < 90 || stmts < 90 || funcs < 90 || br < 90) {
  console.error('Coverage below 90%: lines=' + lines + '%, statements=' + stmts + '%, functions=' + funcs + '%, branches=' + br + '%');
  process.exit(1);
}
console.log('Coverage OK: lines=' + lines + '%, statements=' + stmts + '%, functions=' + funcs + '%, branches=' + br + '%');
\""
else
  # WHAT: the test run above failed, so coverage-summary.json was never produced (or
  # reflects a partial run cut short by the failure) — either way it is not a complete,
  # trustworthy report of coverage.
  # WHY: evaluating the threshold against that file would misreport a test failure as a
  # coverage regression — a maintainer reading the failure line could spend real time
  # chasing a coverage drop that never happened.
  # NEXT: fix the failing test(s) named in "CLI: test (with coverage)" above, then re-run;
  # coverage is only meaningful once the test step itself passes.
  echo "[repo-check] CLI: coverage >= 90%"
  echo "[repo-check] SKIPPED — cannot evaluate: CLI: test (with coverage) failed above, so coverage-summary.json is missing or incomplete. This is not a coverage threshold miss; fix the failing test(s) first."
  FAILED+=("CLI: coverage >= 90% (skipped — no usable coverage data, see CLI: test (with coverage))")
fi
# Guard: the AST-extraction-cache false-green audit (warm, then cache-on vs cache-off,
# asserting per-file facts AND violationsByNode deep-equal over a C# global-using +
# global-using-alias corpus) is the standing proof that the cache never serves a stale
# relation verdict. The full suite above already runs it, but name it as an explicit step
# so the proof fails LOUDLY if the test is ever renamed or skipped out of the suite —
# the same defence as the E2E binary guard above.
run_step "Relations: AST-cache false-green audit" "$REPO_ROOT/source/cli" "npx vitest run tests/unit/relations/ast-cache-audit.test.ts"
# Portal Playwright + Chromium e2e — the §3a surface/transition coverage gate. Drives the REAL
# `yg portal` output of real fixture projects through the public CLI in a real browser, and the
# two enforcing aspects (portal/every-surface-has-e2e, portal/every-spec-uses-playwright-chromium)
# refuse the suite if a surface loses its spec or a spec stops being a real Chromium test. The
# Chromium browser is rebuildable, not committed; if it is missing we fail LOUDLY with the install
# command (never a silent skip that would go green over zero browser coverage — same defence as the
# E2E binary guard above). Requires the dist/bin.js built in the build step.
run_step "Portal: e2e Chromium present (guard)" "$REPO_ROOT/source/cli" "npx playwright install chromium --dry-run >/dev/null 2>&1 && node -e \"const{chromium}=require('@playwright/test');const p=chromium.executablePath();require('fs').accessSync(p);\" || { echo 'Chromium for Playwright is not installed — the portal e2e would silently skip. Run: (cd source/cli && npx playwright install --with-deps chromium)'; exit 1; }"
run_step "Portal: e2e (Playwright + Chromium)" "$REPO_ROOT/source/cli" "npm run test:e2e:portal"
run_step "Docs: build" "$REPO_ROOT/docs" "npm run build"
run_step "Markdown: lint" "$REPO_ROOT" "npx markdownlint-cli2 \"**/*.md\" \".markdownlint-cli2.jsonc\""
# Digest freshness (hard gate in THIS repo; yg check's gate is warning-only).
# Compares the sha256 anchor committed in each project root's agent-rules
# artifacts against the canonical digest of the CLI built above.
# Hash-comparison ONLY — examples/failing is red by design, so this loop must
# never shell out to `yg check` inside an example.
#
# Three properties this step depends on, all asserted rather than assumed:
#   1. The loop iterates project ROOTS (every directory holding a .yggdrasil/),
#      not the AGENTS.md files that happen to exist. A glob over existing files
#      never visits an example whose installer was never run — the single case
#      the gate most needs to catch for a newly added example — and the loop
#      would exit 0 over it.
#   2. `canon` is validated to be a 64-char hex sha256 BEFORE any comparison.
#      If `prime --digest` ever stops emitting a sha256= field, canon is empty,
#      and an anchorless AGENTS.md would then compare empty-to-empty and pass —
#      the gate would silently stop gating.
#   3. BOTH anchored artifacts are inspected at each root — AGENTS.md and
#      .clinerules/yggdrasil.md. Checking only the first left the second gated
#      by nothing here, so this hard gate inspected strictly less than the
#      warning-level one in `yg check`, which compares both.
run_step "Rules: digest freshness (root + examples)" "$REPO_ROOT" "
  canon=\$(node source/cli/dist/bin.js prime --digest | sed -n 's/.*sha256=\\([0-9a-f]*\\).*/\\1/p' | head -1)
  if ! printf '%s' \"\$canon\" | grep -Eq '^[0-9a-f]{64}\$'; then
    echo '[digest] Could not read a canonical sha256 digest from: node source/cli/dist/bin.js prime --digest'
    echo '[digest] WHY: every committed anchor is compared against this hash. With no hash to compare against, a file carrying no anchor would compare empty-to-empty and pass — the gate would report green while checking nothing.'
    echo '[digest] NEXT: rebuild the CLI ((cd source/cli && npm run build)), then re-run: node source/cli/dist/bin.js prime --digest'
    exit 1
  fi
  verify_file() {
    root=\"\$1\"
    f=\"\$root/\$2\"
    if [ ! -f \"\$f\" ]; then
      echo \"[digest] \$f does not exist — this project root carries no agent-rules install.\"
      echo '[digest] WHY: a directory with a .yggdrasil/ graph but a missing agent-rules artifact leaves the agents that read it with no rules at all; it is the exact state a newly added example lands in when the installer was never run there.'
      echo \"[digest] NEXT: (cd \$root && node \\\"\$PWD/source/cli/dist/bin.js\\\" init --upgrade)\"
      return 1
    fi
    got=\$(sed -n 's/.*yggdrasil:digest cli=[^ ]* sha256=\\([0-9a-f]*\\).*/\\1/p' \"\$f\" | head -1)
    if [ \"\$got\" != \"\$canon\" ]; then
      echo \"[digest] \$f is stale or missing its anchor.\"
      echo '[digest] WHY: agents follow the committed digest; a stale one contradicts the installed CLI.'
      echo \"[digest] NEXT: (cd \$root && node \\\"\$PWD/source/cli/dist/bin.js\\\" init --upgrade)\"
      return 1
    fi
    return 0
  }
  verify_one() {
    rc=0
    verify_file \"\$1\" AGENTS.md || rc=1
    verify_file \"\$1\" .clinerules/yggdrasil.md || rc=1
    return \$rc
  }
  fail=0
  verify_one . || fail=1
  for d in examples/*/; do
    [ -d \"\$d.yggdrasil\" ] || continue
    verify_one \"\${d%/}\" || fail=1
  done
  exit \$fail
"
run_step "Graph: check" "$REPO_ROOT" "node source/cli/dist/bin.js check --approve --only-deterministic"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "[repo-check] Failed: ${FAILED[*]}"
  exit 1
fi
echo "[repo-check] All checks passed"
