# Contributing to Yggdrasil

Two things worth knowing before you start.

**This repo runs its own tool on itself.** The graph under `.yggdrasil/` governs this codebase, so `yg check` is a real gate on your change, not a formality. If it refuses something, read the rule it names before you work around it: either the code is wrong or the rule is, and both are fixable.

**Negative results are welcome.** If you measure something and it comes out against the tool, that is a contribution. Open an issue with what you ran and what you got.

Questions? Email <me@chrisdudek.com>.

## Prerequisites

- Node.js 22+
- npm 10+
- Git

## Development Setup

### Option A: Dev Container (recommended)

1. Open the repository in VS Code / Cursor
2. When prompted, click "Reopen in Container"
3. Wait for the container to build (first time takes ~2 minutes)
4. The CLI will be available as `yg` globally

### Option B: Local

```bash
cd source/cli
npm install
npm run build
npm link    # makes `yg` available globally
```

## Development Workflow

1. Create a feature branch: `git checkout -b feature/my-change`
2. Make changes — update the graph (`.yggdrasil/`) and/or code as needed
3. Run tests: `cd source/cli && npm test`
4. Run linter: `npm run lint`
5. Build: `npm run build`
6. Submit a PR against `main`

### Updating rules or templates

After modifying `source/cli/src/templates/` (the agent operating manual, the committed digest, knowledge topics, schemas), rebuild the CLI and then refresh this repo's own generated artifacts from repository root:

```bash
cd source/cli && npm run build && cd ../..
node source/cli/dist/bin.js init --upgrade
```

`yg init --upgrade` is the flag-explicit form; the interactive menu's "Refresh agent rules" option does the same thing. Never run `yg init` from a subdirectory — always from repository root. The marker-delimited digest block in `AGENTS.md` is generated: edit `templates/digest.ts`, never the block itself, or `repo-check.sh` fails the commit.

## Repository Quality Check (recommended before PR)

Run the unified repository validation from root:

```bash
scripts/repo-check.sh
```

VS Code task equivalent:

- `Repo: Check All` (defined in `Yggdrasil.code-workspace`)

This flow is fail-fast and covers CLI typecheck/lint/build/test, docs build, markdown lint, and `yg check`.

## The `scripts/` directory

`scripts/repo-check.sh` is the quality gate above. Everything else in there is a
**measurement instrument for this repository**, and none of it is — or is meant to
become — a `yg` command. They all share the same invariants, stated in each file's
own header: read-only, no dependencies, they never write the lock or any graph
file, and they have no effect on any exit code, verdict, issue, or suggested next
step. Two make reviewer calls, and only through `yg aspect-test`, which never
writes the lock.

The split is deliberate, and each of these has a design decision placing it here
rather than in the CLI. The product answers "does this code satisfy the rules?"
These answer "are the rules any good?" — a question about the enforcement layer
itself, asked over local telemetry, git history, and a drill corpus that exist only
here. Shipping them as commands would hand adopters instruments that measure a
repository they do not have.

The promotion rule is the one the design states: **a script becomes a command on
demonstrated need, not on elapsed time.** Where a measurement did generalize, it
shipped as a command — the drill corpus, the external holdout corpus,
`yg aspect-test --repeat` and `--tier`, the rule-health ledger, the dead-attach
linter, `yg structure`, and `yg simulate` all began as questions in the same design
chapter as the scripts below and ended up in the product because they hold for any
repository. So a script sitting here is not a queue position. Do not mechanize one
because it has been around a while; mechanize it when you can point at the need.

Three of them are wired into something:

| Script | Wired into |
| --- | --- |
| `lock-history-audit.mjs` | CI. Replays the committed lock's history looking for a verdict that flipped while its input hash stayed identical — the signature of a hand-edited verdict. |
| `family-without-law.mjs` | The attention feed. It mines clusters of near-identical files that share no narrow rule and writes candidates to a gitignored file that `yg advise` reads as a nomination. It never creates a rule. |
| `mcnemar.mjs`, `metamorphic.mjs` | The docs. Both are cited in the [model-swap protocol](docs/model-swap-protocol.md) as reference implementations adopters can copy. |

The rest are local-only calibration: `judge-stability.mjs` (how often the reviewer
disagrees with itself on identical input), `cusum.mjs` (a per-rule change-point
detector over refusal telemetry), `displacement.mjs` (after one rule is sharpened,
does the pressure resurface in its siblings), `decision-load.mjs` (the arrival rate
of decision-shaped events in git history against a capacity proxy),
`escape-scan.mjs` (fix-shaped commits against nodes that were green at the time — a
seed for the incident ledger), and `spectral-headroom.mjs` (how much tighter the
dependency graph's natural module boundary is than the shipped directory layout).

One is a **record of a decision not to build**: `confidence-experiment.mjs` carries
a `RESULT — NEGATIVE (NO-BUILD)` banner and the measurement behind it. Read it
before proposing a judge-confidence channel; it states the exact condition under
which the question becomes worth reopening.

If you add an instrument here, put the same header on it — what it measures, what
it never touches, and what its result means — and say plainly whether the result
was positive or negative. An instrument with no stated conclusion invites someone
to re-run it and read the noise as a finding.

## Pull Request Guidelines

- Include tests for new functionality
- Update documentation if behavior changes
- Keep PRs focused — one feature/fix per PR
- Ensure CI passes before requesting review

## Code Style

- TypeScript strict mode
- ESM modules (`import`/`export`, not `require`)
- Prettier for formatting (runs on save if configured)
- ESLint for static analysis

## AI Contribution Disclosure

If you used AI tools to generate code for your contribution, please note this in the PR description. This is not a restriction — just transparency.

## Architecture

See [docs/](docs/) for the adopter-facing guides and reference.

The CLI's own architecture is not written up in prose — it lives in the graph
under [`.yggdrasil/`](.yggdrasil/), which is the enforced source of truth. Read it
with the tool rather than by opening YAML: `yg tree` for the component hierarchy,
`yg aspects` for the rules, `yg flows` for the command-level processes, and
`yg context --file <path>` for the rules in force on any file you are about to
edit. `yg portal` renders the same picture in a browser.

### Dogfooding

Yggdrasil uses its own mechanism — the `.yggdrasil/` directory at the project root holds the architecture graph with aspects that enforce rules on the CLI's own source code. The agent rules file (installed by `yg init`) instructs the agent how to work with the graph.
