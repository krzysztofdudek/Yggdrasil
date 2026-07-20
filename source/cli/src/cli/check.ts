// yg-suppress-disable(deterministic) presentational adaptation to terminal capabilities (TTY-aware truncation, color/emoji) and the inherent --approve LLM writer call; the verdict, counts, and exit code are invariant across environments, so these are not determinism violations of the check result
import { Command, Option } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog, writeFillDivergence } from '../io/debug-log-writer.js';
import { runCheck, runAttentionDump } from '../core/check.js';
import type { CheckIssue, CheckResult } from '../core/check.js';
import { runFill, FillGatingError } from '../core/fill.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { walkRepoFiles } from '../io/repo-scanner.js';
import { groupIssues, type IssueGroup, getIssueLabel, FULL_WHAT_CODES, issuePriorityRank } from './group-issues.js';
import type { YggConfig } from '../model/graph.js';

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
    // Hidden calibration instrument: print the raw per-file structural measurements grouped by
    // family, with the outliers marked, then exit 0. Writes nothing, makes no LLM calls.
    .addOption(new Option('--attention-dump', 'Calibration: print raw structural measurements (writes nothing, exit 0).').hideHelp())
    .action(async (opts: { approve?: boolean; onlyDeterministic?: boolean; dryRun?: boolean; top?: boolean | string; summary?: boolean; details?: boolean; aspect?: string; quiet?: boolean; attentionDump?: boolean }) => {
      try {
        const cwd = process.cwd();
        const graph = await loadGraphOrAbort(cwd, { tolerateInvalidConfig: true });
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = path.dirname(graph.rootPath);
        const gitFiles = await walkRepoFiles(projectRoot);

        // Hidden calibration instrument. Bypasses the normal report entirely: run the
        // read-only attention dump over warm shards, print it, exit 0. Writes nothing. It is
        // scoped to the same tracked, graph-governed file set the report path uses — the git
        // call stays in this CLI layer (core never shells out to git).
        if (opts.attentionDump) {
          const dump = await runAttentionDump(graph, gitFiles);
          process.stdout.write(dump);
          await exitAfterFlush(0);
          return;
        }

        // --top and --summary are READ-ONLY triage views over the plain check wall.
        // They are mutually exclusive with each other, and neither combines with
        // --approve (which has its own --dry-run cost preview). Reject the bad
        // combinations with guided errors before any work runs.
        const wantsTop = opts.top !== undefined;
        if (wantsTop && opts.summary) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: '--top and --summary cannot be combined.',
            why: 'Both are read-only triage VIEWS of the same `yg check` result — --top renders the N highest-priority blocks, --summary renders per-node counts only. Asking for both at once is ambiguous; pick one lens.',
            next: 'Run: yg check --top <n> (priority blocks), or yg check --summary (per-node counts).',
          })}`) + '\n');
          await exitAfterFlush(1);
          return;
        }
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

        // Fill path: runs when --approve is explicit OR when auto_approve in config
        // promotes bare `yg check` to a fill. Triage views always stay read-only.
        // --dry-run is a preview mode of fill: previews cost without writing.
        if (mode.approve) {
          // Banner: warn before spending on the LLM reviewer, but ONLY for
          // config-driven full auto-fill (not deterministic, not explicit --approve).
          const isConfigFull =
            isConfigDrivenFill && graph.config?.auto_approve === 'full';
          if (isConfigFull && !opts.dryRun) {
            process.stderr.write("auto-approve: full — bare 'yg check' will call the reviewer.\n");
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
              gitTrackedFiles: gitFiles,
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
              // Core count resolved in the CLI layer (engine stays deterministic);
              // deterministic checks run across this many worker threads.
              detConcurrency: Math.max(1, availableParallelism() - 1),
              write: isDryRun
                ? (s: string) => { process.stdout.write(s); }
                : isQuiet
                  ? () => {}
                  : (s: string) => { process.stderr.write(s); },
              isTTY: !isQuiet && (process.stderr.isTTY ?? false),
              emitIssue: (m) => { process.stderr.write(buildIssueMessage(m) + '\n'); },
              // Best-effort, synchronous io writer for the convergence sentinel's
              // evidence dump — wired here so the engine takes no core → io
              // dependency. It never throws into the fill.
              divergenceWrite: (text) => { writeFillDivergence(graph.rootPath, text); },
            });
            const autoFilled = isConfigDrivenFill && !opts.dryRun;
            process.stdout.write(formatOutput(fill.checkResult, { kind: 'full' }, autoFilled));
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
        const result = await runCheck(graph, gitFiles, {
          nowUtc: () => new Date(),
          writeFeatureIndex: true,
          now: () => new Date(),
        });
        process.stdout.write(formatOutput(result, view));

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

// ── Output formatting ──────────────────────────────────────

/** Code sets for grouping errors by category. STRUCTURAL_CODES and
 *  COMPLETENESS_CODES are shared with the check engine via core/check-codes.ts
 *  so the rendered grouping and the summary tally cannot drift apart. */
// `unmapped-files` renders through renderUnmappedBlock (count + file list).
// `mapping-path-missing` is NOT a coverage code: it carries a nodePath and
// structured messageData, so it falls through to the normal validation-error
// renderer (code + node path + what/why/next) — renderUnmappedBlock would
// otherwise drop both the code and the offending node path.
const COVERAGE_CODES = new Set(['unmapped-files']);

/**
 * Read-only render mode for `yg check`. Selected by --top / --summary; the
 * --approve path always uses `full`. EVERY view renders the same header with the
 * TRUE error/warning counts and keeps the single `Next:` line — only the body
 * (which issue blocks, if any, are rendered) changes. The exit code is computed
 * outside this function from the full issue set, so no view can read as green.
 *   - full    : header + every error/warning block grouped by (code, aspectId)
 *               + Next. Default view.
 *   - details : header + every error/warning block ungrouped (one block per
 *               issue, old per-pair style) + Next. Opposite of full.
 *   - top  n  : header + at most n highest-priority GROUPS in suggestedNext
 *               priority order + Next. Bare --top maps to n = 1 (the single
 *               suggested-next group); a subheader with TRUE count > 0 but no
 *               chosen groups is annotated, never left dangling.
 *   - summary : header + per-node aggregate counts + Next (no per-issue blocks).
 *   - aspect  : header + issue group for the named aspect only + Next.
 */
export type CheckView = { kind: 'full' } | { kind: 'top'; n: number } | { kind: 'summary' } | { kind: 'details' } | { kind: 'aspect'; id: string };

/**
 * Parse a raw --top value into a block count, or null on garbage.
 *   - undefined  → caller treats as absent (full view); tolerated → 0.
 *   - true       → bare `--top` (commander gives boolean true for an optional
 *                  arg supplied with no value) → 1 (the single suggested-next
 *                  group — the same group the `Next:` line draws from).
 *   - "<int≥1>"  → that integer (the number of GROUPS to render).
 *   - "0"        → null (guided error): an EXPLICIT `--top 0` is meaningless
 *                  garbage — it would render zero groups. For the single
 *                  suggested-next group, pass bare `--top` (which maps to 1).
 *   - NaN / negative / fractional / non-numeric → null (guided error).
 * NOTE: commander 15 yields boolean `true` (not a registered default) for a bare
 * `--top`, so the caller branches on `typeof opts.top`; this mirrors that here.
 */
export function resolveTopValue(raw: boolean | string | undefined): number | null {
  if (raw === undefined) return 0;
  if (raw === true) return 1; // bare --top → the single suggested-next group
  if (raw === false) return null; // not a shape commander produces here, but be explicit
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null; // rejects negatives, decimals, "abc", ""
  const n = parseInt(trimmed, 10);
  if (Number.isNaN(n) || n < 1) return null; // explicit "0" is garbage; bare --top (→ 1) is the single-group path
  return n;
}

/**
 * The `Next:` footer (and the `Next (this group):` triage line) normally shows
 * only the FIRST line of an issue's `next` — the actionable command, with the
 * trailing explanation trimmed. That assumes line 1 stands alone. It does not
 * for a heading-introduced list such as a refusal's `Three exits:\n  1. …\n
 * 2. …`, where line 1 is a bare heading and the actionable content is the lines
 * beneath it. Truncating there dead-ends the reader on `Next: Three exits:` with
 * nothing after the colon. Rule: a first line that ends in `:` is a heading, so
 * surface the WHOLE block; otherwise keep the terse first-line-only form.
 */
function nextPointer(next: string): string {
  const firstLine = next.split('\n')[0];
  return firstLine.trimEnd().endsWith(':') ? next : firstLine;
}

/**
 * When `result.suggestedNext` starts with `yg check --approve` AND there is at
 * least one error whose code is NOT `unverified` (i.e. refused/relation/
 * structural/etc.), returns a parenthetical annotating partial coverage:
 *   (fills <N> unverified; <K> errors remain — need code/graph fixes)
 * where N = count of error issues with code `unverified`, K = count of error
 * issues with code !== `unverified`. Otherwise returns ''.
 */
function residualAfterNext(result: CheckResult): string {
  if (!result.suggestedNext?.startsWith('yg check --approve')) return '';
  const errors = result.issues.filter(i => i.severity === 'error');
  const N = errors.filter(i => i.code === 'unverified').length;
  const K = errors.filter(i => i.code !== 'unverified').length;
  if (K === 0) return '';
  return `  (fills ${N} unverified; ${K} error${K === 1 ? '' : 's'} remain — need code/graph fixes)`;
}

export function formatOutput(result: CheckResult, view: CheckView = { kind: 'full' }, autoFilled = false, emoji = useEmoji): string {
  const errors = result.issues.filter(i => i.severity === 'error');
  const warnings = result.issues.filter(i => i.severity === 'warning');

  // isTTY controls node-list truncation inside groups (CAP_NODES per group).
  const opts = { isTTY: process.stdout.isTTY ?? false };

  // Header ALWAYS uses the full counts — in every view. Only the body changes.
  const header = renderHeader(result, errors.length, warnings.length, autoFilled, emoji);
  const sections: string[] = [header];

  if (view.kind === 'summary' || view.kind === 'top') {
    // Both triage views ALWAYS print the aggregate Errors(N)/Warnings(N)
    // subheaders with the TRUE totals — only the body beneath them changes
    // (per-node counts for summary; up-to-n priority blocks for top). This is
    // what stops a truncated view from reading as a clean build.
    const body = view.kind === 'summary'
      ? renderSummaryBody(errors, warnings)
      : renderTopBody(errors, warnings, view.n, opts);
    // A top-view section can carry a TRUE count > 0 while the slice chose none
    // of its groups; annotate it rather than leave the subheader dangling.
    // (Summary bodies are never empty when their count is > 0.)
    if (errors.length > 0) {
      sections.push('');
      const errPrefix = emoji ? '❌ ' : '';
      sections.push(chalk.red(`${errPrefix}Errors (${errors.length}):`));
      if (body.errorLines) {
        sections.push(body.errorLines);
      } else if (view.kind === 'top') {
        sections.push(topEmptySectionNote('error', view.n));
      }
    }
    if (warnings.length > 0) {
      sections.push('');
      const warnPrefix = emoji ? '⚠️ ' : '';
      sections.push(chalk.yellow(`${warnPrefix}Warnings (${warnings.length}):`));
      if (body.warningLines) {
        sections.push(body.warningLines);
      } else if (view.kind === 'top') {
        sections.push(topEmptySectionNote('warning', view.n));
      }
    }
  } else if (view.kind === 'aspect') {
    // --aspect <id>: drill-in view — show ONLY issues for the named aspect,
    // grouped, with the full node list (no truncation). The TRUE total error
    // count (N) stays visible in the header line so the user knows how much
    // of the total wall this aspect represents.
    const drillOpts = { isTTY: false }; // never truncate in drill-in
    const filtered = result.issues.filter(i => i.aspectId === view.id);
    const filteredErrors = filtered.filter(i => i.severity === 'error');
    const filteredWarnings = filtered.filter(i => i.severity === 'warning');
    const K = filteredErrors.length;
    const N = errors.length;
    // Verdict word mirrors renderHeader logic: FAIL if total errors > 0, else PASS.
    const verdictWord = errors.length > 0 ? chalk.red('FAIL') : chalk.green('PASS');
    // Emoji prefix mirrors renderHeader: same gate (chalk.level > 0) and same symbols.
    const aspectEmojiPrefix = emoji ? (errors.length > 0 ? '❌ ' : '✅ ') : '';
    // Replace the header already added with the aspect-scoped header line.
    sections[0] = `${aspectEmojiPrefix}${verdictWord}  (aspect '${view.id}' — ${K} of ${N} errors)`;
    if (filteredErrors.length > 0) {
      sections.push('');
      sections.push(renderErrorSection(filteredErrors, drillOpts));
    }
    if (filteredWarnings.length > 0) {
      sections.push('');
      sections.push(renderWarningSection(filteredWarnings, drillOpts));
    }
    // Next (this group): the first line of the highest-priority filtered issue's next.
    // Pick by the same priority cascade computeSuggestedNext and groupIssues use —
    // not raw emission order — so the drill-in pointer cannot disagree with the
    // global Next when a lower-priority issue happens to be emitted first. Stable
    // min-by: strict `<` keeps the first-encountered on equal rank.
    const combined = [...filteredErrors, ...filteredWarnings];
    const firstFiltered =
      combined.length > 0
        ? combined.reduce((best, cur) => (issuePriorityRank(cur) < issuePriorityRank(best) ? cur : best))
        : undefined;
    if (firstFiltered?.messageData.next) {
      const nextCmd = nextPointer(firstFiltered.messageData.next);
      sections.push('');
      sections.push(`Next (this group): ${nextCmd}`);
      sections.push('');
      return sections.join('\n');
    }
    // Empty filtered set (this aspect has zero issues THIS run): do NOT dead-end.
    // Fall through to the global `result.suggestedNext` block below so the agent
    // still gets a next step pointing at the rest of the wall (e.g. when other
    // errors remain). With no global suggestedNext (a clean run) nothing prints —
    // self-evidently done. The aspect-scoped header (0 of N) is already in place.
  } else if (view.kind === 'details') {
    // --details: ungrouped, one block per issue, grouped only by severity into
    // Errors(N): / Warnings(N): sections. Coverage issues still render via
    // renderUnmappedBlock. No (code,aspectId) collapsing.
    if (errors.length > 0) {
      sections.push('');
      const errPrefix = emoji ? '❌ ' : '';
      sections.push(chalk.red(`${errPrefix}Errors (${errors.length}):`));
      sections.push(renderDetailsSection(errors, 'error'));
    }
    if (warnings.length > 0) {
      sections.push('');
      const warnPrefix = emoji ? '⚠️ ' : '';
      sections.push(chalk.yellow(`${warnPrefix}Warnings (${warnings.length}):`));
      sections.push(renderDetailsSection(warnings, 'warning'));
    }
  } else {
    if (errors.length > 0) {
      sections.push('');
      sections.push(renderErrorSection(errors, opts, emoji));
    }
    if (warnings.length > 0) {
      sections.push('');
      sections.push(renderWarningSection(warnings, opts, emoji));
    }
  }

  if (result.suggestedNext) {
    // Render the Next line whenever computeSuggestedNext produced one — including a
    // warnings-only PASS, where it falls back to the first advisory aspect-violation
    // warning's `next`. A FULLY-GREEN run (no errors, no warnings) yields a null
    // suggestedNext and prints no Next line — a clean run is self-evidently done.
    // Show only the first line — the actionable command, without annotation text
    // — UNLESS that first line is a heading introducing a list (e.g. a refusal's
    // "Three exits:"), where the whole block IS the actionable content.
    const nextCmd = nextPointer(result.suggestedNext);
    // In the full view, annotate the Next line when --approve will only partially
    // clear errors (some refused/structural/relation errors remain after filling
    // unverified pairs). Triage views (top/summary) are already narrowed — they
    // do not annotate to avoid double-messaging.
    const residual = (view.kind === 'full' || view.kind === 'details') ? residualAfterNext(result) : '';
    sections.push('');
    sections.push(`Next: ${nextCmd}${residual}`);
  }

  sections.push('');
  return sections.join('\n');
}

// ── Details view: ungrouped, one block per issue ──────────

/**
 * Render every issue as an individual block (no (code,aspectId) collapsing).
 * Coverage issues (`unmapped-files` / `uncovered-advisory`) render via
 * `renderUnmappedBlock`; all others via `renderIssueBlock`. Produces a flat
 * list of blocks separated by blank lines, matching the spacing used in
 * the --top view.
 */
function renderDetailsSection(issues: CheckIssue[], mode: 'error' | 'warning'): string {
  const lines: string[] = [];
  for (const issue of issues) {
    lines.push('');
    if (issue.code === 'unmapped-files') {
      renderUnmappedBlock(issue, lines);
    } else if (issue.code === 'uncovered-advisory') {
      renderUnmappedBlock(issue, lines, 'uncovered');
    } else {
      renderIssueBlock(issue, lines, mode);
    }
  }
  return lines.join('\n');
}

// ── Top view: prioritized blocks ───────────────────────────

/** A triage-view body split by severity, so each block lands under its
 *  aggregate Errors(N)/Warnings(N) subheader (rendered by formatOutput). */
interface ViewBody { errorLines: string; warningLines: string }

/**
 * Render at most `n` highest-priority GROUPS in priority order (errors before
 * warnings), splitting the chosen groups by severity so each lands under its
 * aggregate Errors(N)/Warnings(N) subheader. Each group is rendered via
 * renderGroup so the node list, shared why/fix, and per-member detail all appear.
 * n <= 0 renders no groups (defensive — the CLI never produces n < 1: bare
 * --top maps to 1, explicit "0" is a guided error); formatOutput then
 * annotates each non-empty section via topEmptySectionNote.
 *
 * Priority is taken from the group's representative member (groupIssues already
 * sorts by representative priority). The combined list of error groups followed
 * by warning groups is sliced at n; sliced groups are then split by severity
 * for the two subheaders.
 */
function renderTopBody(errors: CheckIssue[], warnings: CheckIssue[], n: number, opts: { isTTY: boolean }): ViewBody {
  if (n <= 0) return { errorLines: '', warningLines: '' };
  // groupIssues returns groups sorted by representative priority within each
  // severity. Errors always outrank warnings, so combine errors first.
  const errorGroups = groupIssues(errors);
  const warningGroups = groupIssues(warnings);
  const allGroups = [...errorGroups, ...warningGroups];
  const chosenGroups = allGroups.slice(0, n);
  const chosenErrors = chosenGroups.filter(g => g.severity === 'error');
  const chosenWarnings = chosenGroups.filter(g => g.severity === 'warning');
  const renderOneGroup = (g: IssueGroup): string => {
    const lines: string[] = [];
    if (g.code === 'unmapped-files') {
      renderUnmappedBlock(g.members[0], lines);
    } else if (g.code === 'uncovered-advisory') {
      renderUnmappedBlock(g.members[0], lines, 'uncovered');
    } else {
      renderGroup(g, lines, opts);
    }
    return lines.join('\n');
  };
  // Lead each group block with a blank line (separating it from the subheader
  // and from the preceding block), matching the full-view spacing.
  const lead = (groups: IssueGroup[]): string => groups.map(g => `\n${renderOneGroup(g)}`).join('\n');
  return { errorLines: lead(chosenErrors), warningLines: lead(chosenWarnings) };
}

/**
 * Annotation beneath a --top subheader whose TRUE count is > 0 but whose slice
 * chose no groups of that severity (e.g. --top 1 where the top group is an
 * error, so no warning group made the slice). Indented FOUR spaces on purpose:
 * group blocks start at a two-space indent and block-counting parsers key on
 * that — the annotation must never register as a group block.
 */
function topEmptySectionNote(kind: 'error' | 'warning', n: number): string {
  return chalk.dim(`    (no ${kind} groups within --top ${n} — run yg check for the full list)`);
}

// ── Summary view: per-node aggregate counts ────────────────

/**
 * Render per-node aggregate counts only — no per-issue blocks, no Why:/Fix:
 * lines. Each node line reports its pair states split by reviewer kind plus a
 * refused tally; NON-PAIR errors (coverage / log / relation / structural — no
 * pairKind) are bucketed per node as "other" so the per-node totals reconcile
 * with the true header Errors(N)/Warnings(N) counts and are NEVER silently
 * dropped. Rows are split by severity so each lands under its aggregate
 * subheader; a node with both error and warning issues appears under both.
 */
function renderSummaryBody(errors: CheckIssue[], warnings: CheckIssue[]): ViewBody {
  return { errorLines: renderSummaryRows(errors), warningLines: renderSummaryRows(warnings) };
}

function renderSummaryRows(issues: CheckIssue[]): string {
  if (issues.length === 0) return '';

  interface NodeAgg {
    unverifiedDet: number;
    unverifiedLlm: number;
    refused: number;
    other: number;
  }
  const byNode = new Map<string, NodeAgg>();
  const agg = (node: string): NodeAgg => {
    let a = byNode.get(node);
    if (!a) {
      a = { unverifiedDet: 0, unverifiedLlm: 0, refused: 0, other: 0 };
      byNode.set(node, a);
    }
    return a;
  };

  for (const issue of issues) {
    const node = issue.nodePath ?? '(repo)';
    const a = agg(node);
    if (issue.code === 'unverified') {
      if (issue.pairKind === 'deterministic') a.unverifiedDet++;
      else if (issue.pairKind === 'llm') a.unverifiedLlm++;
      else a.other++; // unverified without a pairKind should not occur, but never drop it
    } else if (issue.code === 'aspect-violation-enforced' || issue.code === 'aspect-violation-advisory') {
      a.refused++;
    } else {
      // Non-pair errors/warnings (coverage / log / relation / structural /
      // unmapped / uncovered-advisory): bucket as "other" so totals reconcile.
      // Count by ISSUE OBJECT, not file count — the header Errors(N)/Warnings(N)
      // counts each aggregate coverage issue (e.g. one unmapped-files issue with
      // uncoveredCount=7) as ONE, so the per-node "other" bucket must too, or the
      // summary would over-count and not reconcile with the header.
      a.other += 1;
    }
  }

  const lines: string[] = [];
  for (const node of [...byNode.keys()].sort((x, y) => x.localeCompare(y, 'en'))) {
    const a = byNode.get(node)!;
    const unverified = a.unverifiedDet + a.unverifiedLlm;
    const parts: string[] = [];
    parts.push(`${unverified} unverified (${a.unverifiedDet} deterministic-free, ${a.unverifiedLlm} LLM)`);
    parts.push(`${a.refused} refused`);
    if (a.other > 0) parts.push(`${a.other} other`);
    lines.push(`  ${node}  ${parts.join(', ')}`);
  }
  return lines.join('\n');
}

// ── Emoji gate ─────────────────────────────────────────────

/**
 * Emoji decoration is gated on color support.  When chalk has no color
 * (NO_COLOR env var, non-color terminal, chalk.level === 0) the output is
 * byte-identical to the pre-emoji text — no leading character, no extra space.
 * Emoji is decoration only; verdict and severity are always readable as plain
 * text without it.
 *
 * Exported so tests can read the current gate value; the optional `useEmoji`
 * parameter on `formatOutput` allows tests to override it without mocking.
 */
export const useEmoji: boolean = chalk.level > 0;

// ── Header ─────────────────────────────────────────────────

function renderHeader(result: CheckResult, errorCount: number, warningCount: number, autoFilled = false, emoji = useEmoji): string {
  let verdict: string;
  if (errorCount > 0) {
    // auto-filled marker is a PASS qualifier only — never shown on FAIL.
    verdict = chalk.red('yg check: FAIL');
  } else if (autoFilled && warningCount > 0) {
    verdict = `${chalk.green('yg check: PASS')} (auto-filled, ${warningCount} warning${warningCount === 1 ? '' : 's'})`;
  } else if (autoFilled) {
    verdict = `${chalk.green('yg check: PASS')} (auto-filled)`;
  } else if (warningCount > 0) {
    verdict = `${chalk.green('yg check: PASS')} (${warningCount} warning${warningCount === 1 ? '' : 's'})`;
  } else {
    verdict = chalk.green('yg check: PASS');
  }

  const emojiPrefix = emoji ? (errorCount > 0 ? '❌ ' : '✅ ') : '';

  const metrics: string[] = [`${result.nodeCount} nodes`];

  if (result.totalFiles > 0) {
    const ratio = `${result.coveredFiles}/${result.totalFiles} files`;
    if (result.coveredFiles < result.totalFiles) {
      const pct = Math.round((result.coveredFiles / result.totalFiles) * 100);
      metrics.push(`${ratio} (${pct}%)`);
    } else {
      metrics.push(ratio);
    }
  }

  metrics.push(`${result.aspectCount} aspects`);
  metrics.push(`${result.flowCount} flows`);

  const verifiedTotal = result.verifiedDet + result.verifiedLlm;
  if (verifiedTotal > 0) {
    metrics.push(`${verifiedTotal} verified (${result.verifiedDet} deterministic, ${result.verifiedLlm} LLM)`);
  }

  if (result.draftSkipped > 0) {
    metrics.push(`${result.draftSkipped} draft`);
  }

  return `${emojiPrefix}${verdict}  ${metrics.join(' · ')}`;
}

// ── Error section ──────────────────────────────────────────

/** Maximum number of issue groups rendered before the overflow hint. */
const GROUP_CAP = 12;

/**
 * Render the Errors section using grouped blocks. Coverage issues
 * (`unmapped-files`) are separated out and rendered after the groups via
 * `renderUnmappedBlock`. All other errors are grouped with `groupIssues` and
 * rendered with `renderGroup`.
 *
 * Section sub-header:
 *   - M > 1 → `Errors (N) in M groups:` (N = total issues including coverage)
 *   - M === 1 (or zero non-coverage errors) → `Errors (N):`
 *
 * Group cap: at most GROUP_CAP (12) groups rendered; if more, an overflow hint
 * line is appended after the 12th.
 */
function renderErrorSection(errors: CheckIssue[], opts: { isTTY: boolean }, emoji = useEmoji): string {
  const unmapped = errors.filter(i => COVERAGE_CODES.has(i.code));
  const rest = errors.filter(i => !COVERAGE_CODES.has(i.code));
  const groups = groupIssues(rest);
  const M = groups.length;
  const N = errors.length;

  const errPrefix = emoji ? '❌ ' : '';
  const subheader = M > 1
    ? chalk.red(`${errPrefix}Errors (${N}) in ${M} groups:`)
    : chalk.red(`${errPrefix}Errors (${N}):`);
  const lines: string[] = [subheader];

  const shown = groups.slice(0, GROUP_CAP);
  for (const g of shown) {
    lines.push('');
    renderGroup(g, lines, opts);
  }
  if (groups.length > GROUP_CAP) {
    lines.push(`  ... in ${groups.length} groups — showing ${GROUP_CAP}; run yg check --top <n> or --aspect <id>`);
  }

  // Unmapped files — compact block with file list (unchanged)
  for (const issue of unmapped) {
    lines.push('');
    renderUnmappedBlock(issue, lines);
  }

  return lines.join('\n');
}

// ── Warning section ────────────────────────────────────────

/**
 * Render the Warnings section using grouped blocks. Coverage issues
 * (`uncovered-advisory`) are separated out and rendered after the groups via
 * `renderUnmappedBlock`. All other warnings are grouped with `groupIssues` and
 * rendered with `renderGroup`.
 *
 * Section sub-header:
 *   - M > 1 → `Warnings (N) in M groups:` (N = total warnings including coverage)
 *   - M === 1 (or zero non-coverage warnings) → `Warnings (N):`
 */
function renderWarningSection(warnings: CheckIssue[], opts: { isTTY: boolean }, emoji = useEmoji): string {
  const coverage = warnings.filter(i => i.code === 'uncovered-advisory');
  const rest = warnings.filter(i => i.code !== 'uncovered-advisory');
  const groups = groupIssues(rest);
  const M = groups.length;
  const N = warnings.length;

  const warnPrefix = emoji ? '⚠️ ' : '';
  const subheader = M > 1
    ? chalk.yellow(`${warnPrefix}Warnings (${N}) in ${M} groups:`)
    : chalk.yellow(`${warnPrefix}Warnings (${N}):`);
  const lines: string[] = [subheader];

  const shown = groups.slice(0, GROUP_CAP);
  for (const g of shown) {
    lines.push('');
    renderGroup(g, lines, opts);
  }
  if (groups.length > GROUP_CAP) {
    lines.push(`  ... in ${groups.length} groups — showing ${GROUP_CAP}; run yg check --top <n> or --aspect <id>`);
  }

  // Coverage warnings — compact block with file list (unchanged)
  for (const issue of coverage) {
    lines.push('');
    renderUnmappedBlock(issue, lines, 'uncovered');
  }

  return lines.join('\n');
}

// ── Per-issue block ────────────────────────────────────────

/**
/** Indent applied to continuation lines so they align under the block body. */
const BLOCK_INDENT = '            ';

/**
 * Render a single issue (non-cascade, non-unmapped) as a labelled block:
 *   <label>  <node-path>  <what summary>
 *            <…full what detail for refusal codes…>
 *            Why: <why>
 *            Fix: <next>
 * plus an (advisory — not blocking) note for advisory warnings.
 *
 * For refusal codes (FULL_WHAT_CODES) the complete multi-line `what` is shown:
 * the first line as the block header, every subsequent line indented under it —
 * this is where the reviewer reason / violation list lives. All other codes show
 * only line 1 (terse one-line format preserved for unverified / prompt-too-large
 * / structural issues).
 *
 * Accesses issue.messageData.{what,why,next} directly — the structured renderer
 * pattern permitted by the what-why-next aspect for CLI renderers that need
 * labelled output instead of the flat buildIssueMessage concatenation.
 */
function renderIssueBlock(issue: CheckIssue, lines: string[], mode: 'error' | 'warning'): void {
  const md = issue.messageData;
  const whatLines = md.what.split('\n');
  const label = getIssueLabel(issue);
  const nodePath = issue.nodePath ?? '';

  lines.push(`  ${label}  ${nodePath}  ${whatLines[0]}`);
  // Refusal codes: render the remaining `what` lines (reviewer reason /
  // violation list) indented under the header so the agent sees the full
  // refusal detail in plain `yg check`, not only via `yg aspect-test`.
  if (FULL_WHAT_CODES.has(issue.code)) {
    for (const extra of whatLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
  if (md.why) {
    lines.push(`${BLOCK_INDENT}Why: ${md.why}`);
  }
  if (md.next) {
    // Advisory warnings never block: advisory aspect violations AND advisory
    // unverified pairs (an unverified pair renders as a warning only when its
    // effective status is advisory) both carry the not-blocking hint.
    const isAdvisory =
      mode === 'warning' &&
      (issue.code === 'aspect-violation-advisory' || issue.code === 'unverified');
    const fixSuffix = isAdvisory ? '  (advisory — not blocking)' : '';
    // `next` may itself be multi-line (cached-refusal "three exits"); keep the
    // full instruction, suffixing only the first line with the advisory hint.
    const nextLines = md.next.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}${fixSuffix}`);
    for (const extra of nextLines.slice(1)) {
      lines.push(`${BLOCK_INDENT}${extra}`);
    }
  }
}

/**
 * Render unmapped-files error (or uncovered-advisory warning) as a compact block with file list.
 * Derives all rendered content from issue.messageData (what/why/next) as required
 * by the what-why-next aspect. The terse format uses the count from messageData.what
 * and lists files from issue.uncoveredFiles (the structured data parallel to what).
 */
function renderUnmappedBlock(issue: CheckIssue, lines: string[], label = 'unmapped'): void {
  const md = issue.messageData;
  const files = issue.uncoveredFiles ?? [];
  // Use the authoritative structured count; fall back to file list length only
  // if uncoveredCount was never set (should not happen in practice).
  const count = issue.uncoveredCount ?? files.length;
  const countLabel = String(count);
  lines.push(`  ${label} (${countLabel})`);
  // Show file list derived from messageData.what body lines (same data as uncoveredFiles).
  const shown = files.slice(0, 10);
  for (const f of shown) {
    lines.push(`            ${f}`);
  }
  if (files.length > 10) {
    lines.push(`            ... +${files.length - 10}`);
  }
  if (md.why) {
    lines.push(`            Why: ${md.why}`);
  }
  if (md.next) {
    lines.push(`            Fix: ${md.next.split('\n')[0]}`);
  }
}

// ── Grouped block render ───────────────────────────────────

const CAP_NODES = 12;

/** Jargon glosses: machine token first, human gloss in parentheses (parseable by tooling). */
const LABEL_GLOSS: Record<string, string> = { unverified: 'unverified (not yet reviewed)' };

function glossLabel(label: string): string { return LABEL_GLOSS[label] ?? label; }

/**
 * Render a single IssueGroup as a unified block:
 *   <glossLabel(label)>  <P> pairs  <M> nodes[  aspect '<id>']
 *   <sharedWhy>                         (only when `why` is shared across members)
 *   Fix: <sharedNext>                   (only when `next` is shared across members)
 *   - <node> (one per member; perMemberReason: includes first detail line from messageData.what)
 *       Why: <member why>              (only when group.divergentWhy)
 *       Fix: <member next>             (only when group.divergentNext)
 *   ... and K more (yg check --aspect <id>)  [TTY-only, when members > CAP_NODES]
 *
 * Divergence handling (Fix 4): when the members carry node-specific `next`
 * (and/or `why`) — `log-entry-missing`, `relation-undeclared-dependency`,
 * architecture errors — a SINGLE shared `Fix:`/`Why:` would name only the
 * alphabetically-first node and mislead the agent. In that case the shared line
 * is suppressed and each member's own command/rationale is rendered beneath its
 * bullet. Shared-fix groups (LLM refusals, unverified, …) keep the collapsed
 * single block.
 */
export function renderGroup(group: IssueGroup, lines: string[], opts: { isTTY: boolean }): void {
  const aspectSeg = group.aspectId ? `  aspect '${group.aspectId}'` : '';
  lines.push(`  ${glossLabel(group.label)}  ${group.pairCount} pairs  ${group.nodeCount} nodes${aspectSeg}`);
  // Shared why/fix render once ABOVE the member list — but only when they are
  // genuinely shared. A divergent why/next belongs per-member (below), so the
  // shared line is suppressed here to avoid naming only the first node.
  if (group.sharedWhy && !group.divergentWhy) lines.push(`${BLOCK_INDENT}${group.sharedWhy}`);
  if (group.sharedNext && !group.divergentNext) {
    const nextLines = group.sharedNext.split('\n');
    lines.push(`${BLOCK_INDENT}Fix: ${nextLines[0]}`);
    for (const extra of nextLines.slice(1)) lines.push(`${BLOCK_INDENT}${extra}`);
  }
  // Per-member why/fix continuation, emitted under each bullet when divergent.
  // Indented one level (two spaces) deeper than the bullet so it reads as a
  // child of that node, matching the perMemberReason `what`-tail indentation.
  const MEMBER_DETAIL_INDENT = `${BLOCK_INDENT}  `;
  const emitDivergentDetail = (m: CheckIssue): void => {
    if (group.divergentWhy && m.messageData.why) {
      lines.push(`${MEMBER_DETAIL_INDENT}Why: ${m.messageData.why.split('\n')[0]}`);
    }
    if (group.divergentNext && m.messageData.next) {
      const nextLines = m.messageData.next.split('\n');
      lines.push(`${MEMBER_DETAIL_INDENT}Fix: ${nextLines[0]}`);
      for (const extra of nextLines.slice(1)) lines.push(`${MEMBER_DETAIL_INDENT}${extra}`);
    }
  };
  const members = group.members;
  const truncate = opts.isTTY && members.length > CAP_NODES;
  const shown = truncate ? members.slice(0, CAP_NODES) : members;
  for (const m of shown) {
    const node = m.nodePath ?? '';
    if (group.perMemberReason) {
      // Full what tail: every line AFTER line 0 (line 0 is the generic
      // "Aspect X refused on UNIT" header already conveyed by the group header).
      // For LLM refusals line 1 is "Reviewer reason: ..."; for deterministic
      // refusals line 1 is "Violations:" and lines 2+ are the file:line entries.
      // Truncating to line 1 silently drops the actionable violation lines.
      const whatTail = m.messageData.what.split('\n').slice(1).map((l) => l.replace(/\s+$/, ''));
      if (whatTail.length === 0) {
        lines.push(`${BLOCK_INDENT}- ${node}`);
      } else {
        lines.push(`${BLOCK_INDENT}- ${node}  ${whatTail[0].trim()}`);
        for (const extra of whatTail.slice(1)) {
          lines.push(`${BLOCK_INDENT}  ${extra}`);   // continuation, indented one level under the node bullet
        }
      }
      // Divergent per-node why/fix (e.g. relation-undeclared-dependency, whose
      // `what` is the violation list AND whose `next` names the node's stanza).
      emitDivergentDetail(m);
    } else {
      // For code-only groups (e.g. `unverified`) group.aspectId is undefined
      // because the group spans multiple aspects. Annotate each member line
      // with the member's own aspectId so the agent can see which aspect is
      // unverified on each node without repeating the shared why+fix.
      const memberAspectSeg =
        group.aspectId === undefined && m.aspectId !== undefined
          ? `  aspect '${m.aspectId}'`
          : '';
      // For non-aspect structural/graph issues (e.g. when-predicate-invalid,
      // log-entry-missing) the member has no aspectId to annotate — instead
      // surface the first line of `what`, which carries the specific diagnostic
      // detail (e.g. "Invalid regex in content when:" or "No fresh log entry for
      // node '...'"). Without this, all members in the group look identical and
      // the agent cannot distinguish which node or predicate is broken.
      const whatSeg =
        !memberAspectSeg && m.messageData.what
          ? `  ${m.messageData.what.split('\n')[0]}`
          : '';
      lines.push(`${BLOCK_INDENT}- ${node}${memberAspectSeg || whatSeg}`);
      // Divergent per-node why/fix (e.g. log-entry-missing → `yg log add --node X`,
      // relation-target-forbidden → allow-list vs default-deny). Without this the
      // group would render only the first member's command/rationale.
      emitDivergentDetail(m);
    }
  }
  if (truncate) {
    const drill = group.aspectId ? ` (yg check --aspect ${group.aspectId})` : '';
    lines.push(`${BLOCK_INDENT}... and ${members.length - CAP_NODES} more${drill}`);
  }
}


