#!/usr/bin/env bash

set -uo pipefail

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
    : # ok
  else
    FAILED+=("$label")
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
run_step "CLI: test (with coverage)" "$REPO_ROOT/source/cli" "npm run test:coverage"
run_step "CLI: coverage >= 90%" "$REPO_ROOT/source/cli" "node -e \"
const j = require('./coverage/coverage-summary.json');
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
run_step "Graph: check" "$REPO_ROOT" "node source/cli/dist/bin.js check --approve --only-deterministic"

if [ ${#FAILED[@]} -gt 0 ]; then
  echo ""
  echo "[repo-check] Failed: ${FAILED[*]}"
  exit 1
fi
echo "[repo-check] All checks passed"
