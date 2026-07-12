#!/usr/bin/env bash
set -uo pipefail

run_step() {
  echo "[repo-check] $1"
  eval "$2"
}

run_step "CLI: typecheck" "npm run typecheck"
run_step "CLI: build" "npm run build"
run_step "CLI: test (with coverage)" "npm run test:coverage"
run_step "Docs: build" "cd docs && npm run build"
run_step "Markdownlint" "npx markdownlint-cli2 \"**/*.md\""
run_step "Graph: check" "node source/cli/dist/bin.js check --approve --only-deterministic"

echo "[repo-check] All checks passed"
