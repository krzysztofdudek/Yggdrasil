// yg-suppress-disable(deterministic) the inherent --approve LLM writer call; the verdict, counts, and exit code are invariant across environments, so this is not a determinism violation of the check result
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog, writeFillDivergence } from '../io/debug-log-writer.js';
import { runCheck, runAttentionDump } from '../core/check.js';
import type { CheckResult } from '../core/check.js';
import { runFill, FillGatingError } from '../core/fill.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import path from 'node:path';
import { detConcurrencyForThisMachine } from './det-concurrency.js';
import { sweepStaleTempFiles } from '../io/atomic-write.js';
import { walkRepoFiles, listGitTrackedFiles, countMappedButExcludedFiles } from '../io/repo-scanner.js';
import type { YggConfig, Graph } from '../model/graph.js';
import { readRulesArtifacts } from './rules-artifacts.js';
import { formatOutput, type CheckView, resolveTopValue } from './check-render-views.js';
import { CHECK_JSON_SCHEMA, formatCheckJson } from '../formatters/check-json.js';
import { buildCheckJson } from '../core/check-json.js';
import { resolveChangeScope } from './progressive-scope-resolve.js';

/**
 * Resolve the effective approve mode from explicit CLI flags and graph config.
 *
 * Precedence (highest to lowest):
 *   1. Explicit `--no-approve` (opts.approve === false) → always read-only.
 *   2. Explicit `--only-deterministic` (implies approve) → approve + det.
 *   3. Explicit `--approve` (opts.approve === true) → approve, det from flag.
 *   4. No explicit approve flag → from config.auto_approve:
 *        'deterministic' → approve + det
 *        'full'          → approve, not det
 *        false/undefined → read-only (today's default behavior)
 */
export function resolveApproveMode(
  opts: { approve?: boolean; onlyDeterministic?: boolean },
  config: YggConfig | undefined,
): { approve: boolean; onlyDeterministic: boolean } {
  // EXPLICIT --no-approve always wins — even over config.
  if (opts.approve === false) {
    return { approve: false, onlyDeterministic: false };
  }

  // EXPLICIT --only-deterministic implies approve (regardless of config).
  if (opts.onlyDeterministic === true) {
    return { approve: true, onlyDeterministic: true };
  }

  // EXPLICIT --approve with no --only-deterministic.
  if (opts.approve === true) {
    return { approve: true, onlyDeterministic: false };
  }

  // No explicit approve flag — fall back to config.auto_approve.
  const autoApprove = config?.auto_approve;
  if (autoApprove === 'deterministic') {
    return { approve: true, onlyDeterministic: true };
  }
  if (autoApprove === 'full') {
    return { approve: true, onlyDeterministic: false };
  }

  // false / undefined → read-only (today's default behavior).
  return { approve: false, onlyDeterministic: false };
}

/**
 * Correct `CheckResult.nodeOwnedFiles`/`excludedFiles` in place before the
 * header renders. `runCheck`'s own split decides "node-owned" by whether a
 * mapping entry TEXTUALLY matches a file — the same test `scanUncoveredFiles`
 * uses to decide "covered" — so a file a directory or glob entry sweeps in
 * but the graph excludes (a nested project's own boundary, or a
 * `coverage.excluded` root) is counted node-owned even though nothing
 * enforces it: no pair, no fingerprint contribution, no rule ever runs on it.
 * Moving that count out of node-owned and into excluded here is the ONE
 * place an adopter reading the header sees the truth `yg context --node` and
 * `yg owner --file` already report for the same files. The scan below (`countMappedButExcludedFiles`)
 * is skipped only when the flag-gated split isn't even rendered (`result.typeLevel` false) or there
 * is nothing to count (`result.totalFiles === 0`) — on every OTHER flag-on run it always runs,
 * whether or not it finds anything to move; only the correction that follows it (moving the count
 * from `nodeOwnedFiles` into `excludedFiles`) is skipped when the count comes back zero. Cheap
 * either way — `findNestedProjectRoots` is memoised per root and `walkRepoFiles` already warmed it
 * earlier in the same command.
 */
async function applyHonestCoverageSplit(result: CheckResult, graph: Graph, coverageVisibleFiles: string[]): Promise<void> {
  if (!result.typeLevel || result.totalFiles === 0) return;
  const mappedExcluded = await countMappedButExcludedFiles(graph, coverageVisibleFiles);
  if (mappedExcluded === 0) return;
  result.nodeOwnedFiles = (result.nodeOwnedFiles ?? 0) - mappedExcluded;
  result.excludedFiles = (result.excludedFiles ?? 0) + mappedExcluded;
}

export function registerCheckCommand(program: Command): void {
  program
    .command('check')
    .description('Unified graph gate — verification, coverage, completeness')
    .option('--approve', 'Fill every unverified pair (deterministic first, then LLM), then report')
    .option('--no-approve', 'Force read-only mode even when auto_approve is configured (overrides config)')
    .option('--only-deterministic', 'With --approve: fill ONLY deterministic pairs (keyless, free); committed locks stay untouched. For CI and pre-commit.')
    .option('--dry-run', 'With --approve: free cost preview — print the budget + per-node/per-aspect breakdown, then exit 0 WITHOUT writing anything or calling the reviewer.')
    .option('--top [n]', 'Read-only triage: print only the N highest-priority issue blocks (bare --top = just the single suggested-next group). Header counts + exit code stay TRUE.')
    .option('--summary', 'Read-only triage: print per-node counts only (no per-issue blocks). Header counts + exit code stay TRUE.')
    .option('--details', 'Read-only: ungrouped, one block per issue (full per-pair detail). Opposite of the default grouped view.')
    .option('--aspect <id>', "Read-only: drill into one rule — show only that aspect's issues, grouped, with the full per-node detail.")
    .option('-q, --quiet', 'Suppress --approve progress on stderr (only the final report + exit code). No-op with a plain read; with --dry-run the budget preview still prints (--dry-run wins).')
    // Asks for the whole project to be answered for, regardless of what it
    // measures a change against — the explicit "prove everything" invocation a
    // CI integration leg and a maintainer audit both want. It is the ONE flag
    // that only ever tightens the gate: it can turn an inherited finding back
    // into a blocking one, never the reverse, so it is safe to hand to anyone.
    .option('--full', 'Answer for the whole project, ignoring any configured reference branch.')
    .option('--json', `Machine-readable output: one ${CHECK_JSON_SCHEMA} document on stdout instead of the text report. Same work, same exit code, always the TRUE whole-run counts.`)
    // Hidden calibration instrument: print the raw per-file structural measurements grouped by
    // family, with the outliers marked, then exit 0. Writes nothing, makes no LLM calls.
    .addOption(new Option('--attention-dump', 'Calibration: print raw structural measurements (writes nothing, exit 0).').hideHelp())
    .action(async (opts: { approve?: boolean; onlyDeterministic?: boolean; dryRun?: boolean; top?: boolean | string; summary?: boolean; details?: boolean; aspect?: string; quiet?: boolean; full?: boolean; json?: boolean; attentionDump?: boolean }) => {
      try {
        const asJson = opts.json === true;
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = path.dirname(graph.rootPath);
        // Clear any half-finished atomic write a previously KILLED run left beside
        // the locks — an out-of-memory abort or a SIGKILL skips the writer's own
        // cleanup, so the temp survives and reads as untracked repository noise.
        // Best-effort and silent; see sweepStaleTempFiles for how narrowly it is
        // scoped so it can never touch a file that is not one of ours.
        await sweepStaleTempFiles(graph.rootPath, () => Date.now());
        const repoFiles = await walkRepoFiles(projectRoot);
        // Tracked-file list for the anomaly check below; null (no git) skips it.
        const tracked = listGitTrackedFiles(projectRoot);

        // Hidden calibration instrument. Bypasses the normal report entirely: run the
        // read-only attention dump over warm shards, print it, exit 0. Writes nothing. It is
        // scoped to the same coverage-visible, graph-governed file set the report path uses —
        // the disk walk (`walkRepoFiles`) stays in this CLI layer; core only ever consumes
        // the list handed to it, never walks the filesystem or shells out to git itself.
        if (opts.attentionDump) {
          const dump = await runAttentionDump(graph, repoFiles);
          process.stdout.write(dump);
          await exitAfterFlush(0);
          return;
        }

        // --top and --summary are READ-ONLY triage views over the plain check wall.
        // They are mutually exclusive with each other, and neither combines with
        // --approve (which has its own --dry-run cost preview). Reject the bad
        // combinations with guided errors before any work runs.
        const wantsTop = opts.top !== undefined;
        // --json is not a narrower view, it is a DIFFERENT one: the document
        // always carries the whole run. The four text-view selectors exist to
        // shorten a wall of prose, and there is no wall here to shorten — a
        // narrowed document would read as a smaller problem rather than a
        // smaller rendering, which is exactly the false-green the triage views
        // are themselves written to avoid.
        if (asJson && (wantsTop || opts.summary || opts.details || opts.aspect !== undefined)) {
          const viewFlag = wantsTop ? '--top' : opts.summary ? '--summary' : opts.details ? '--details' : '--aspect';
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `${viewFlag} cannot be combined with --json.`,
            why: `${viewFlag} narrows the TEXT report — fewer blocks, same counts. --json emits one machine document that always carries the whole run, so there is nothing for a narrowing flag to narrow, and a document trimmed to a few findings would read as a smaller problem instead of a smaller rendering.`,
            next: `Run: yg check --json (the whole run as a document), or yg check ${viewFlag}${opts.aspect !== undefined ? ' <id>' : wantsTop ? ' <n>' : ''} (the narrowed text view).`,
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        if (wantsTop && opts.summary) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--top and --summary cannot be combined.',
            why: 'Both are read-only triage VIEWS of the same `yg check` result — --top renders the N highest-priority blocks, --summary renders per-node counts only. Asking for both at once is ambiguous; pick one lens.',
            next: 'Run: yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        // This refusal is also why the type-coverage block's counts-only line
        // (--top / --summary) can never name a "cannot run" pair's SPECIFIC
        // reason: that fact only ever exists inside a --approve run's own
        // in-process fill→check handoff (core/fill.ts), so a view that can
        // never combine with --approve can never carry it either — see
        // check-render-header.ts's unverifiedInstanceTotal, which still shows
        // the plain "no confirmed verdict" COUNT here (that fact costs
        // nothing extra: result.issues already has it regardless of view).
        if ((wantsTop || opts.summary) && opts.approve) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `${wantsTop ? '--top' : '--summary'} cannot be combined with --approve.`,
            why: '--top and --summary triage the READ-ONLY check wall (they narrow the output of plain `yg check`, which writes nothing). --approve is the writer path; its own free cost preview is --dry-run. Mixing a read-only triage view with the writer is contradictory.',
            next: `Run: yg check ${wantsTop ? '--top <n>' : '--summary'} (read-only triage), or yg check --approve --dry-run (preview the writer's cost).`,
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        // --only-deterministic is a FILL flag (it implies --approve). The
        // read-only triage views (--top / --summary / --details / --aspect) would
        // each be force-read-only by the isTriageView override below, SILENTLY
        // dropping the requested deterministic fill — the user would believe they
        // filled the deterministic pairs when they did not. Reject the
        // contradiction outright rather than running a read-only check. (The
        // --no-approve + --only-deterministic mutex below covers the explicit
        // read-only flag; this covers the implicit read-only of a triage view.)
        if (opts.onlyDeterministic && (wantsTop || opts.summary || opts.details || opts.aspect !== undefined)) {
          const viewFlag = wantsTop ? '--top' : opts.summary ? '--summary' : opts.details ? '--details' : '--aspect';
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `${viewFlag} cannot be combined with --only-deterministic.`,
            why: `${viewFlag} is a READ-ONLY view of the plain \`yg check\` result (it narrows output and writes nothing). --only-deterministic is a FILL flag (it implies --approve, writing the deterministic verdict cache). Mixing a read-only view with the writer would silently drop the fill — the deterministic pairs would NOT be filled.`,
            next: `Run: yg check ${viewFlag}${opts.aspect !== undefined ? ' <id>' : wantsTop ? ' <n>' : ''} (read-only view), or yg check --approve --only-deterministic (deterministic fill).`,
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        if (opts.details && (wantsTop || opts.summary)) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--details cannot be combined with --top or --summary.',
            why: '--details, --top, and --summary are all mutually exclusive read-only views of the same `yg check` result — each presents the issue set through a different lens. Asking for more than one at once is ambiguous; pick one.',
            next: 'Run: yg check --details (ungrouped per-issue), yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        if (opts.details && opts.approve) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--details cannot be combined with --approve.',
            why: '--details is a read-only view of the plain `yg check` result (it writes nothing). --approve is the writer path. Mixing a read-only view with the writer is contradictory.',
            next: 'Run: yg check --details (read-only ungrouped view), or yg check --approve (fill unverified pairs).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        if (opts.approve === false && opts.onlyDeterministic) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--no-approve cannot be combined with --only-deterministic.',
            why: '--no-approve forces a read-only check (no fill); --only-deterministic asks for a deterministic FILL. The two are contradictory.',
            next: 'Run: yg check --no-approve (read-only), or yg check --approve --only-deterministic (deterministic fill).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
        if (opts.aspect !== undefined) {
          // --aspect is a read-only drill-in view and cannot combine with writer or other views.
          if (opts.approve) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: '--aspect cannot be combined with --approve.',
              why: '--aspect is a read-only drill-in view (it writes nothing). --approve is the writer path. Mixing a read-only view with the writer is contradictory.',
              next: 'Run: yg check --aspect <id> (read-only drill-in), or yg check --approve (fill unverified pairs).',
            })}`) + '\n');
            await exitAfterFlush(1);
            return;
          }
          if (wantsTop || opts.summary || opts.details) {
            const conflicting = wantsTop ? '--top' : opts.summary ? '--summary' : '--details';
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `--aspect cannot be combined with ${conflicting}.`,
              why: '--aspect, --top, --summary, and --details are all mutually exclusive read-only views of the same `yg check` result. Asking for more than one at once is ambiguous; pick one.',
              next: `Run: yg check --aspect <id> (drill-in view), or yg check ${conflicting} (that view alone).`,
            })}`) + '\n');
            await exitAfterFlush(1);
            return;
          }
          // Validate the drill-in target against the REAL aspect ids in the graph.
          // An unknown / mistyped id would otherwise render a misleading "0 of N
          // errors" FAIL that looks like the rule merely has no issues this run —
          // sending the agent chasing a nonexistent aspect. Name the unknown id
          // explicitly and (when the set is small enough) list the real ones.
          const knownAspectIds = (graph.aspects ?? []).map((a) => a.id);
          if (!knownAspectIds.includes(opts.aspect)) {
            const idList = knownAspectIds.slice().sort((a, b) => a.localeCompare(b, 'en'));
            const known =
              idList.length === 0
                ? 'The graph defines no aspects.'
                : idList.length <= 30
                  ? `Known aspect ids: ${idList.join(', ')}.`
                  : `The graph defines ${idList.length} aspects.`;
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `Unknown aspect '${opts.aspect}'.`,
              why: `--aspect drills into ONE rule by its aspect id, but '${opts.aspect}' is not an aspect defined in this graph — so the filter would match nothing and render a misleading "0 of N errors" view. ${known}`,
              next: 'Run: yg aspects (list every aspect id), then yg check --aspect <id> with a real id; or yg check (full wall).',
            })}`) + '\n');
            await exitAfterFlush(1);
            return;
          }
        }

        // Resolve the read-only triage view. undefined --top = absent (full view);
        // a numeric/garbage --top is validated here (a NaN/negative/0-as-garbage
        // value is a guided error, never a silent full dump).
        let view: CheckView = { kind: 'full' };
        if (opts.aspect !== undefined) {
          view = { kind: 'aspect', id: opts.aspect };
        } else if (opts.details) {
          view = { kind: 'details' };
        } else if (opts.summary) {
          view = { kind: 'summary' };
        } else if (wantsTop) {
          const n = resolveTopValue(opts.top);
          if (n === null) {
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `--top expects a non-negative whole number; got "${String(opts.top)}".`,
              why: '--top N prints the N highest-priority issue blocks. A negative, fractional, or non-numeric value is meaningless, and printing the full wall instead would silently hide that the flag was ignored — masking the very output you tried to narrow.',
              next: 'Run: yg check --top 5 (top 5 blocks), yg check --top (the single suggested-next group), or yg check (full output).',
            })}`) + '\n');
            await exitAfterFlush(1);
            return;
          }
          view = { kind: 'top', n };
        }

        // Resolve the effective approve mode. Triage views (--top / --summary /
        // --details / --aspect) are READ-ONLY and must NOT trigger a fill even
        // when auto_approve is configured — force read-only when any view is selected.
        const isTriageView = wantsTop || opts.summary || opts.details || opts.aspect !== undefined;
        const mode = isTriageView
          ? { approve: false, onlyDeterministic: false }
          : resolveApproveMode(opts, graph.config);

        // --dry-run is a preview MODE of --approve, not a standalone alias for the
        // plain read. Without an effective approve mode it is a usage error: steer
        // the agent to the intended command rather than silently behaving like `yg check`.
        if (opts.dryRun && !mode.approve) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--dry-run requires --approve.',
            why: '--dry-run previews what `yg check --approve` would fill (the reviewer-call budget and per-node breakdown) without writing or calling the reviewer; it is a mode of --approve, not a variant of the plain read. Plain `yg check` is already a free, no-write read.',
            next: 'Run: yg check --approve --dry-run (cost preview), or yg check (plain read).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }

        // autoFilled is true when the fill was driven by config (auto_approve),
        // NOT by an explicit --approve / --only-deterministic flag. Used to mark
        // the PASS header as (auto-filled) so agents can distinguish config-driven
        // fills from user-requested ones.
        const isConfigDrivenFill =
          mode.approve &&
          opts.approve === undefined &&
          opts.onlyDeterministic !== true;

        // What this run is accountable for — resolved ONCE, for both paths below.
        // Inert unless the project committed a reference branch to measure
        // changes against: with none it resolves before any git process runs, and
        // both paths are byte-for-byte what this command always produced. A
        // project that DID name one and whose change could not be measured gets
        // the same whole-project gate plus a notice saying so — never a silently
        // empty scope, which would downgrade every finding in the report AND
        // leave every rule outside it unreviewed.
        const decision = await resolveChangeScope({
          graph,
          projectRoot,
          coverageVisibleFiles: repoFiles,
          fullFlag: opts.full === true,
        });
        // One print site for both notices a measured run can owe: the refusal to
        // guess at a scope, and the measurement that succeeded and still reached
        // the whole project. Two sites would let the second drift out of the
        // what/why/next shape the first established, which is the shape every
        // other whole-project outcome is already reported in.
        const scopeNotice =
          decision.kind === 'unmeasurable' ? decision.notice
          : decision.kind === 'scoped' ? decision.notice
          : undefined;
        if (scopeNotice !== undefined) {
          process.stderr.write(chalk.yellow(`Notice: ${buildIssueMessage(scopeNotice)}`) + '\n');
        }
        const changeScope =
          decision.kind === 'scoped'
            ? {
                burn: decision.burn,
                referenceName: decision.referenceName,
                blobOidByPath: decision.blobOidByPath,
              }
            : undefined;

        // Fill path: runs when --approve is explicit OR when auto_approve in config
        // promotes bare `yg check` to a fill. Triage views always stay read-only.
        // --dry-run is a preview mode of fill: previews cost without writing.
        if (mode.approve) {
          // Banner: warn before spending on the LLM reviewer, but ONLY for
          // config-driven full auto-fill (not deterministic, not explicit --approve).
          // Under a measured change it can promise less: the reviewer is called
          // for what the change is accountable for and nothing else, which on a
          // branch that reached no reviewer-backed rule is nothing at all.
          const isConfigFull =
            isConfigDrivenFill && graph.config?.auto_approve === 'full';
          if (isConfigFull && !opts.dryRun) {
            process.stderr.write(
              changeScope !== undefined
                ? "auto-approve: full — bare 'yg check' will call the reviewer for anything your change is accountable for.\n"
                : "auto-approve: full — bare 'yg check' will call the reviewer.\n",
            );
          }

          try {
            // The CLI layer owns formatting: fill.ts (an engine module) emits
            // structured diagnostics; we render them here via buildIssueMessage.
            //
            // Stream split: STDOUT carries ONLY the final check report
            // (formatOutput below). Everything emitted during the fill goes to
            // STDERR so that a caller capturing stdout gets a clean, parseable
            // report without interspersed progress or diagnostic lines.
            //
            // Exception: --dry-run's budget breakdown is itself the command's
            // deliverable output (not progress), so its write sink stays on
            // STDOUT. Real fills (dryRun=false) route write to STDERR.
            // --quiet suppresses the progress stream (write → no-op) for a REAL
            // fill only. --dry-run WINS over --quiet: the budget preview is the
            // command's primary deliverable, never progress, so it always reaches
            // STDOUT even when --quiet is also set — otherwise `--approve
            // --dry-run --quiet` would silently drop the entire budget. The
            // emitIssue sink (errors/warnings) is NOT affected by --quiet.
            // --quiet is meaningful only with a REAL fill; with a plain read it
            // is a harmless no-op (no progress to suppress).
            const isDryRun = opts.dryRun ?? false;
            const isQuiet = opts.quiet ?? false;
            const fill = await runFill(graph, {
              coverageVisibleFiles: repoFiles,
              trackedFiles: tracked, // mirrors reviewNowUtc/rulesArtifacts below
              onlyDeterministic: mode.onlyDeterministic,
              dryRun: isDryRun,
              // Maintain the silent feature-field index on the REAL post-fill report (the
              // `--approve` reporting path); the fill returns before that report on --dry-run,
              // so a cost preview writes nothing. Injected clock for the index's generatedAt.
              writeFeatureIndex: true,
              featureIndexNow: () => new Date(),
              // Injected UTC clock for the review-cadence check (spec RZ-18), so
              // `yg check --approve` surfaces the same aspect-review-overdue warnings
              // the plain `yg check` path does (runCheck below). Core has no Date.now
              // of its own; read-only, never gates the fill.
              reviewNowUtc: () => new Date(),
              // Injected snapshot for the committed-digest staleness gate, threaded on
              // exactly the same seam as reviewNowUtc so `yg check --approve` surfaces
              // the same digest-drift warning the plain `yg check` path does. Without
              // it the identical repo printed one fewer warning under --approve. Core
              // reads no files itself; read-only, never gates the fill.
              rulesArtifacts: await readRulesArtifacts(projectRoot),
              // Worker ceiling resolved in the CLI layer (engine stays
              // deterministic): cores AND this machine's memory, since every
              // worker carries its own copy of the graph and its own ASTs. See
              // cli/det-concurrency.ts.
              detConcurrency: detConcurrencyForThisMachine(),
              // The dry-run budget preview is the command's RESULT on that path,
              // so it goes to stdout — except under --json, where stdout carries
              // the document alone and the preview joins the progress on stderr.
              write: isDryRun && !asJson
                ? (s: string) => { process.stdout.write(s); }
                : isQuiet
                  ? () => {}
                  : (s: string) => { process.stderr.write(s); },
              isTTY: !isQuiet && (process.stderr.isTTY ?? false),
              // Width for the single rewritten progress line, so it stays one
              // line instead of wrapping into a new row on every redraw.
              columns: process.stderr.columns,
              emitIssue: (m) => { process.stderr.write(buildIssueMessage(m) + '\n'); },
              // The measurement above, or undefined for a run answering for the
              // whole project. Present, it narrows the reviewer work this run
              // pays for to the change's own obligations — the free
              // deterministic half and the mandatory-log gate stay
              // whole-project — and the report it prints afterwards gates on
              // exactly what a plain read of the same tree gates on.
              changeScope: changeScope,
              // Best-effort, synchronous io writer for the convergence sentinel's
              // evidence dump — wired here so the engine takes no core → io
              // dependency. It never throws into the fill.
              divergenceWrite: (text) => { writeFillDivergence(graph.rootPath, text); },
            });
            const autoFilled = isConfigDrivenFill && !opts.dryRun;
            await applyHonestCoverageSplit(fill.checkResult, graph, repoFiles);
            process.stdout.write(
              asJson
                ? formatCheckJson(buildCheckJson(fill.checkResult))
                : formatOutput(fill.checkResult, { kind: 'full' }, autoFilled),
            );
            // A dry-run is a cost preview only — it never writes and must never fail
            // the build for unverified/refused pairs it merely previewed. Exit 0 always.
            if (opts.dryRun) {
              await exitAfterFlush(0);
              return;
            }
            // Route EVERY exit through exitAfterFlush — a clean run too — so its
            // drain + unref'd force-exit backstop always runs. The fill stage opens
            // LLM-provider handles (undici keep-alive sockets, per-request
            // AbortSignal timers); without the forced exit a CLEAN --approve would
            // fall through to a bare return and rely on the event loop draining,
            // hanging indefinitely on any lingering handle after the report printed.
            const hasErrors = fill.checkResult.issues.some(i => i.severity === 'error');
            await exitAfterFlush(hasErrors ? 1 : 0);
            return;
          } catch (err) {
            if (err instanceof FillGatingError) {
              // The structural gate already printed the gating details.
              debugWrite(`[check] fill aborted by structural gate: ${err instanceof Error ? err.message : String(err)}`);
              await exitAfterFlush(1);
              return;
            }
            throw err;
          }
        }

        // Supply the injected UTC clock so the review-cadence check (spec RZ-18)
        // runs at the CLI boundary. Core has no Date.now of its own; without this
        // the overdue warning is skipped. It is read-only — never writes the lock
        // or gates the fill above.
        //
        // The read-only report path that maintains the silent feature-field index:
        // writeFeatureIndex:true with an injected clock for the index's generatedAt stamp.
        // The `--approve` fill path also maintains it — via runFill's real post-fill report
        // (which passes the same flag into its own runCheck) — so both `yg check` and
        // `yg check --approve` keep the index current. Only --dry-run (returns before the
        // fill's report) and the internal fill/portal re-checks stay byproduct-free.
        const result = await runCheck(graph, repoFiles, {
          nowUtc: () => new Date(),
          writeFeatureIndex: true,
          now: () => new Date(),
          trackedFiles: tracked,
          rulesArtifacts: await readRulesArtifacts(projectRoot),
          // The measurement above, or undefined for a run answering for the
          // whole project. Absent, every finding keeps the code and severity it
          // always had; present, a finding this change is not accountable for
          // becomes its non-blocking counterpart — still named, still counted.
          changeScope: changeScope,
        });
        await applyHonestCoverageSplit(result, graph, repoFiles);
        process.stdout.write(asJson ? formatCheckJson(buildCheckJson(result)) : formatOutput(result, view));

        // Exit code is derived from the FULL issue set, OUTSIDE formatOutput and
        // independent of the chosen view — a truncated --top/--summary render must
        // never read as a clean build over errors it merely declined to print.
        // Same as the --approve path: always route the exit through exitAfterFlush
        // so drain + the force-exit backstop run uniformly (plain check opens no
        // reviewer handles, but keeping one exit path means the guarantee can't
        // regress in one branch while holding in the other).
        const hasErrors = result.issues.some(i => i.severity === 'error');
        await exitAfterFlush(hasErrors ? 1 : 0);
      } catch (error) {
        debugWrite(`[check] error: ${(error as Error).message}`);
        abortOnUnexpectedError(error, 'running check');
      }
    });
}

