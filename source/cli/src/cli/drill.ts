import { Command } from 'commander';
import { registerDrillAddCommand } from './drill-add.js';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import { DEFAULT_MAX_PROMPT_CHARS, PROMPT_FORMAT_REV } from '../llm/prompt.js';
import { appendVerdictEvent, type VerdictEvent } from '../io/events-store.js';
import { appendDrillResult, type DrillResultLine } from '../io/drill-results-store.js';
import {
  discoverDrillCases,
  runDrills,
  drillSummaryFooter,
  type DrillResult,
  type DrillRunContext,
  type DrillDeps,
} from '../core/drill-runner.js';
import type { AspectDef, Graph, LlmConfig } from '../model/graph.js';

/**
 * `yg drill` — re-run an aspect's REAL reviewer over its per-aspect corpus of
 * `violates-*` (must be refused) / `satisfies-*` (must pass) case files, and
 * report pass / MISS / FALSE-ALARM / unrun / unsupported. Deterministic aspects
 * run locally and free; LLM aspects go through the production prompt path and
 * bill the reviewer. The lock is NEVER written — only the gitignored
 * `.drill-results.jsonl` sidecar, plus one drill verdict-event per LLM case.
 *
 * Drills are REGRESSION FIXTURES for sharpening a rule, NOT a sensitivity or
 * specificity measurement: the committed dev-set is visible to the author by
 * definition. Failure output shows only the corpus label + content hashes +
 * pass/fail — never the case source.
 */
export function registerDrillCommand(program: Command): void {
  const drill = program
    .command('drill')
    .description(
      "Re-run an aspect's rule over its violates-*/satisfies-* case corpus and report " +
      'pass / MISS / FALSE-ALARM / unrun / unsupported. Deterministic aspects run free; ' +
      'LLM aspects go through the real reviewer. The lock is never touched. Drills are ' +
      'regression fixtures for sharpening a rule, not a sensitivity/specificity measurement.',
    )
    .option('--aspect <id>', 'aspect id whose case corpus to drill')
    .option('--dir <path>', 'external holdout corpus directory (data only — case files, never imported)')
    .option('--case <glob>', 'run only case labels matching this glob (repo-relative POSIX)')
    .option('--corpus <label>', 'label recorded for this run (default: "dev", or the --dir basename)')
    .option(
      '--nodeless',
      'assemble every LLM case without a node — the prompt shape a file enforced by its ' +
      'architecture type alone, with no owning component, receives from the real reviewer',
    )
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        // --aspect is checked here rather than declared required, because this
        // command also carries subcommands of its own: a required option on the
        // parent is enforced before a subcommand is even reached, which would
        // make `yg drill add --aspect x` refuse the very flag it was given.
        if (typeof opts.aspect !== 'string' || opts.aspect.trim() === '') {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: 'yg drill needs the rule whose case corpus to run.',
              why: 'A drill replays ONE rule over its own cases; without naming the rule there is no corpus to run and no rule to run it with.',
              next: 'List the rules with yg aspects, then run: yg drill --aspect <id>.',
            })}\n`);
          process.exit(1);
          return;
        }

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: `yg drill requires an aspect declared in .yggdrasil/aspects/ (got '${opts.aspect}').`,
              why: `yg drill runs an aspect's rule over its violates-*/satisfies-* case corpus.`,
              next: `List aspects with yg aspects, then retry with --aspect <id>.`,
            })}\n`);
          process.exit(1);
          return;
        }

        if (aspect.reviewer.type === 'aggregate') {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: `aspect '${aspect.id}' is an aggregate (no rule source), so it has no reviewer to drill.`,
              why: `yg drill re-runs a deterministic check.mjs or an LLM content.md over a case corpus; an aggregate only bundles other aspects.`,
              next: `Drill one of its implied atomic aspects instead (each ships its own check.mjs or content.md).`,
            })}\n`);
          process.exit(1);
          return;
        }

        const cases = await discoverDrillCases({
          aspectId: aspect.id,
          projectRoot,
          dir: typeof opts.dir === 'string' ? opts.dir : undefined,
          caseGlob: typeof opts.case === 'string' ? opts.case : undefined,
          corpusLabel: typeof opts.corpus === 'string' ? opts.corpus : undefined,
        });

        if (cases.length === 0) {
          const where = typeof opts.dir === 'string' ? opts.dir : `.yggdrasil/aspects/${aspect.id}/drills/`;
          const filter = typeof opts.case === 'string' ? ` matching '${opts.case}'` : '';
          process.stdout.write(
            `yg drill '${aspect.id}': no ${typeof opts.dir === 'string' ? 'holdout ' : ''}case corpus found under ${where}${filter} — nothing to run. Drills are regression fixtures, not a build gate.\n`,
          );
          return;
        }

        const setup = await buildDrillRun(graph, aspect, projectRoot, opts.nodeless === true);
        if (!setup.ok) {
          process.stderr.write(`Error: ${buildIssueMessage(setup.error)}\n`);
          process.exit(1);
          return;
        }
        const { ctx, deps } = setup;

        const summary = await runDrills(aspect, projectRoot, cases, ctx, deps);

        const src = cases[0].src;
        const corpus = cases[0].corpus;
        process.stdout.write(drillSummaryFooter(aspect.id, summary.counts, corpus, src) + '\n');

        if (summary.exitCode !== 0) await exitAfterFlush(summary.exitCode);
      } catch (e: unknown) {
        debugWrite(`[drill] run failed: ${e instanceof Error ? e.message : String(e)}`);
        // A deterministic runner error already carries a fully-formed what/why/next.
        if (e instanceof AstRunnerError) {
          process.stderr.write(`Error: ${buildIssueMessage(e.messageData)}\n`);
          await exitAfterFlush(1);
          return;
        }
        abortOnUnexpectedError(e, 'running drill');
      }
    });

  // The write side of the same corpus, registered here so both halves of
  // `yg drill` — running the cases, and taking one in — are found in one place.
  registerDrillAddCommand(drill);
}

// ============================================================
// LLM setup
// ============================================================

type LlmSetup =
  | { ok: true; tier: LlmConfig; tierName: string; provider: ReturnType<typeof createLlmProvider> }
  | { ok: false; error: { what: string; why: string; next: string } };

/**
 * Resolve the tier + provider for an LLM drill, or a what/why/next error. Mirrors
 * the aspect-test setup: the tier config already carries the yg-secrets overlay
 * (applied at parse time), so the resolved provider is production-identical.
 */
async function resolveLlmSetup(
  graph: import('../model/graph.js').Graph,
  aspect: AspectDef,
): Promise<LlmSetup> {
  const reviewer = graph.config.reviewer;
  if (!reviewer) {
    return {
      ok: false,
      error: {
        what: `No reviewer is configured for LLM aspect '${aspect.id}'.`,
        why: `An LLM drill runs the real reviewer, which needs a tier in .yggdrasil/yg-config.yaml.`,
        next: `Add a reviewer tier, then retry.`,
      },
    };
  }
  const tierResult = selectTierForAspect(aspect, reviewer);
  if (!tierResult.ok) return { ok: false, error: tierResult.error };
  const { tier, tierName } = tierResult;

  const provider = createLlmProvider(tier);
  let available: boolean;
  try {
    available = await provider.isAvailable();
  } catch (e) {
    debugWrite(`[drill] provider.isAvailable threw for tier ${tierName}: ${e instanceof Error ? e.message : String(e)}`);
    available = false;
  }
  if (!available) {
    return {
      ok: false,
      error: {
        what: `Reviewer provider '${tier.provider}' (tier '${tierName}') is unreachable.`,
        why: `An LLM drill cannot run without the configured reviewer. No provider calls were made.`,
        next: `Check the provider endpoint, network, and credentials, then retry.`,
      },
    };
  }
  return { ok: true, tier, tierName, provider };
}

// ============================================================
// Rendering + sidecar line/event construction
// ============================================================

/** Short content-hash prefix for the honesty-frame per-case line (never the source). */
function short(hash: string): string {
  return hash.slice(0, 8);
}

const OUTCOME_LABEL: Record<DrillResult['outcome'], string> = {
  pass: chalk.green('pass       '),
  miss: chalk.red('MISS       '),
  'false-alarm': chalk.red('FALSE-ALARM'),
  unrun: chalk.yellow('unrun      '),
  unsupported: chalk.dim('unsupported'),
};

/**
 * Render one case result. HONESTY FRAME: the line carries the corpus label and
 * the content hashes and the pass/fail — NEVER the case source. A MISS/FALSE-ALARM
 * names the expected vs observed verdict so the maintainer knows which direction
 * the rule drifted, without the code ever being echoed.
 */
function renderCaseResult(result: DrillResult): void {
  const verdictPart =
    result.got === 'unrun' || result.got === 'unsupported'
      ? `expected ${result.case.expect}`
      : `expected ${result.case.expect}, got ${result.got}`;
  process.stdout.write(
    `${OUTCOME_LABEL[result.outcome]}  ${result.case.caseLabel}  [${verdictPart}]  (case ${short(result.caseHash)} · rule ${short(result.ruleHash)})\n`,
  );
}

/** Build the append-only drill-results line for one case. */
function toResultLine(result: DrillResult, ts: string): DrillResultLine {
  const line: DrillResultLine = {
    v: 1,
    ts,
    aspect: result.case.aspect,
    case: result.case.caseLabel,
    expect: result.case.expect,
    got: result.got,
    src: result.case.src,
    corpus: result.case.corpus,
    caseHash: result.caseHash,
    ruleHash: result.ruleHash,
    kind: result.kind,
  };
  if (result.tier !== undefined) line.tier = result.tier;
  if (result.votes !== undefined) line.votes = result.votes;
  return line;
}

/**
 * Build the verdict-event for an LLM drill case (source:'drill'), or null when no
 * event is due. Deterministic cases emit NO event (zero-churn keyless invariant).
 * An LLM case emits approved / refused / infra; a companion 'unsupported' case is
 * a capability gap that never ran the reviewer, so it too emits nothing.
 */
function toVerdictEvent(
  result: DrillResult,
  ts: string,
  judge: { provider: string; model: string } | undefined,
): VerdictEvent | null {
  if (result.kind !== 'llm') return null;
  const disposition: VerdictEvent['disposition'] | null =
    result.got === 'satisfied' ? 'approved' : result.got === 'refused' ? 'refused' : result.got === 'unrun' ? 'infra' : null;
  if (disposition === null) return null; // unsupported → no reviewer regime to record

  const event: VerdictEvent = {
    v: 1,
    ts,
    source: 'drill',
    aspectId: result.case.aspect,
    unitKey: `drill:${result.case.aspect}/${result.case.caseLabel}`,
    kind: 'llm',
    disposition,
  };
  if (result.tier !== undefined) {
    event.tier = result.tier;
    event.promptRev = PROMPT_FORMAT_REV;
  }
  if (judge !== undefined) event.judge = judge;
  // votes accompany a real verdict only; an infra case never cast a countable vote.
  if (result.votes !== undefined && disposition !== 'infra') event.votes = result.votes;
  return event;
}

// ============================================================
// Shared run setup — the ONE place a drill run is wired up
// ============================================================

/** A wired-up drill run: the context every case is dispatched under, and the
 *  two impure operations the engine calls back into. */
export type DrillRunSetup =
  | { ok: true; ctx: DrillRunContext; deps: DrillDeps }
  | { ok: false; error: { what: string; why: string; next: string } };

/**
 * Wire a drill run for one aspect.
 *
 * Both entry points that run a rule over cases — the whole corpus, and a single
 * case just taken from history — go through here, so a case added from real
 * history is measured under EXACTLY the conditions the corpus is measured
 * under: the same reviewer tier, the same prompt limit, the same graph-access
 * trap on a deterministic check, and the same sidecar and telemetry lines. A
 * second wiring would eventually judge the two differently and nobody would know
 * which run to believe.
 */
export async function buildDrillRun(
  graph: Graph,
  aspect: AspectDef,
  projectRoot: string,
  nodeless: boolean,
): Promise<DrillRunSetup> {
  // Deterministic aspects never review, so their consensus/tier/limit are
  // placeholders; LLM aspects resolve the real tier.
  let ctx: DrillRunContext = { consensus: 1, maxPromptChars: DEFAULT_MAX_PROMPT_CHARS };
  let provider: ReturnType<typeof createLlmProvider> | undefined;
  let judge: { provider: string; model: string } | undefined;

  if (aspect.reviewer.type === 'llm') {
    const setup = await resolveLlmSetup(graph, aspect);
    if (!setup.ok) return { ok: false, error: setup.error };
    ctx = {
      consensus: setup.tier.consensus ?? 1,
      tierName: setup.tierName,
      maxPromptChars: setup.tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS,
      nodeless,
    };
    provider = setup.provider;
    judge = { provider: setup.tier.provider, model: String(setup.tier.model) };
  }

  const yggRoot = graph.rootPath;
  const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);

  const deps: DrillDeps = {
    runDet: async (caseFiles) => {
      try {
        const r = await runAstAspect({
          aspectDir,
          aspectId: aspect.id,
          files: caseFiles.map((f) => ({ path: f })),
          projectRoot,
          graphAccessTrap: true,
        });
        return r.violations.length > 0 ? 'refused' : 'satisfied';
      } catch (e) {
        if (e instanceof AstRunnerError && e.code === 'AST_GRAPH_CTX_UNSUPPORTED') {
          debugWrite(`[drill] check '${aspect.id}' reads graph context — case recorded as unsupported (not scored): ${e.message}`);
          return 'unsupported';
        }
        debugWrite(`[drill] deterministic check for '${aspect.id}' could not evaluate a case: ${e instanceof Error ? e.message : String(e)}`);
        return 'unrun';
      }
    },
    reviewUnit: async (prompt, consensus) => {
      let response;
      let votes;
      try {
        ({ response, votes } = await verifyWithConsensus(provider!, prompt, consensus));
      } catch (e) {
        debugWrite(`[drill] reviewer threw for '${aspect.id}': ${e instanceof Error ? e.message : String(e)}`);
        return 'unrun';
      }
      // A provider-sourced failure is infrastructure, not a code verdict.
      if (!response.satisfied && response.errorSource === 'provider') {
        debugWrite(`[drill] provider error for '${aspect.id}': ${response.reason}`);
        return 'unrun';
      }
      return {
        satisfied: response.satisfied,
        votes: { satisfied: votes.filter((v) => v.satisfied).length, total: votes.length },
      };
    },
    onBudget: (line) => process.stdout.write(line + '\n'),
    onCaseResult: (result, detail) => {
      renderCaseResult(result);
      if (detail !== undefined) process.stdout.write(`    ${detail}\n`);
      const ts = new Date().toISOString();
      appendDrillResult(yggRoot, toResultLine(result, ts));
      const event = toVerdictEvent(result, ts, judge);
      if (event !== null) appendVerdictEvent(yggRoot, event);
    },
  };

  return { ok: true, ctx, deps };
}
