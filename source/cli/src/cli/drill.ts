import { Command } from 'commander';
import { registerDrillAddCommand } from './drill-add.js';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import { probeProvider, REVIEWER_DEBUG_HINT } from '../llm/provider.js';
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
  type DrillRunSetup,
} from '../core/drill-runner.js';
import type { AspectDef, Graph, LlmConfig } from '../model/graph.js';
import { fail, paint, writeErr, writeOut } from './output.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { IssueMessage } from '../model/validation.js';
import { formatDrillJson, DRILL_JSON_SCHEMA, type DrillJsonDocument } from '../formatters/drill-json.js';

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
      'pass / MISS / FALSE-ALARM / unrun / unsupported. Script rules run free; ' +
      'reviewer rules go through the real reviewer. The lock is never touched. Drills are ' +
      'regression fixtures for sharpening a rule, not a sensitivity/specificity measurement.',
    )
    .option('--aspect <id>', 'aspect id whose case corpus to drill')
    .option('--dir <path>', 'external holdout corpus directory (data only — case files, never imported)')
    .option('--case <glob>', 'run only case labels matching this glob (repo-relative POSIX)')
    .option('--corpus <label>', 'label recorded for this run (default: "dev", or the --dir basename)')
    .option(
      '--nodeless',
      'drill as a type-covered file: assemble every reviewer-rule case without a node — the prompt ' +
      'shape a file with no owning component receives from the real reviewer',
    )
    .option('--json', `Machine-readable output: one ${DRILL_JSON_SCHEMA} document on stdout (counts, per-case results, the corpus) instead of the case lines. Same exit codes.`)
    .action(async (opts) => {
      const projectRoot = process.cwd();
      const json = opts.json === true;
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        // --aspect is checked here rather than declared required, because this
        // command also carries subcommands of its own: a required option on the
        // parent is enforced before a subcommand is even reached, which would
        // make `yg drill add --aspect x` refuse the very flag it was given.
        if (typeof opts.aspect !== 'string' || opts.aspect.trim() === '') {
          fail({
              what: 'yg drill needs the rule whose case corpus to run.',
              why: 'A drill replays ONE rule over its own cases; without naming the rule there is no corpus to run and no rule to run it with.',
              next: 'List the rules with yg aspects, then run: yg drill --aspect <id>.',
            });
          process.exit(1);
          return;
        }

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          fail({
              what: `yg drill requires an aspect declared in .yggdrasil/aspects/ (got '${opts.aspect}').`,
              why: `yg drill runs an aspect's rule over its violates-*/satisfies-* case corpus.`,
              next: `List aspects with yg aspects, then retry with --aspect <id>.`,
            });
          process.exit(1);
          return;
        }

        if (aspect.reviewer.type === 'aggregate') {
          fail({
              what: `aspect '${aspect.id}' is a bundle (no rule source), so it has nothing to drill.`,
              why: `yg drill re-runs a script rule's check.mjs or a reviewer rule's content.md over a case corpus; a bundle only groups other aspects.`,
              next: `yg drill --aspect ${aspect.implies?.[0] ?? '<one of the rules it implies>'}  (drill one of the rules it bundles instead)`,
            });
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

        const where = typeof opts.dir === 'string' ? opts.dir : `.yggdrasil/aspects/${aspect.id}/drills/`;
        if (cases.length === 0) {
          if (json) {
            const src: 'dev' | 'holdout' = typeof opts.dir === 'string' ? 'holdout' : 'dev';
            const label = typeof opts.corpus === 'string' ? opts.corpus : src === 'holdout' ? path.basename(path.resolve(projectRoot, where)) : 'dev';
            writeOut(formatDrillJson(drillDocument(aspect.id, { label, source: src, path: where }, [], new Map(), 0)));
            return;
          }
          const filter = typeof opts.case === 'string' ? ` matching '${opts.case}'` : '';
          writeOut(
            `yg drill '${aspect.id}': no ${typeof opts.dir === 'string' ? 'holdout ' : ''}case corpus found under ${where}${filter} — nothing to run. Drills are regression fixtures, not a build gate.\n`,
          );
          return;
        }

        // Under --json the case lines are not printed: each result is kept (with
        // the runner's detail line) for the document, and the reviewer budget
        // line, which is a notice rather than a result, goes to stderr.
        const details = new Map<DrillResult, IssueMessage>();
        const sink: DrillSink | undefined = json
          ? {
              budget: (line) => writeErr(line + '\n'),
              caseResult: (result, detail) => { if (detail !== undefined) details.set(result, detail); },
            }
          : undefined;
        const setup = await buildDrillRun(graph, aspect, projectRoot, opts.nodeless === true, sink);
        if (!setup.ok) {
          fail(setup.error);
          process.exit(1);
          return;
        }
        const { ctx, deps } = setup;

        const summary = await runDrills(aspect, projectRoot, cases, ctx, deps);

        const src = cases[0].src;
        const corpus = cases[0].corpus;
        if (json) {
          writeOut(formatDrillJson(drillDocument(aspect.id, { label: corpus, source: src, path: where }, summary.results, details, summary.exitCode)));
        } else {
          writeOut(drillSummaryFooter(aspect.id, summary.counts, corpus, src) + '\n');
        }

        if (summary.exitCode !== 0) await exitAfterFlush(summary.exitCode);
      } catch (e: unknown) {
        debugWrite(`[drill] run failed: ${e instanceof Error ? e.message : String(e)}`);
        // A deterministic runner error already carries a fully-formed what/why/next.
        if (e instanceof AstRunnerError) {
          fail(e.messageData);
          await exitAfterFlush(1);
          return;
        }
        abortOnUnexpectedError(e, 'running drill');
      }
    });

  // The write side of the same corpus, registered here so both halves of
  // `yg drill` — running the cases, and taking one in — are found in one place.
  // `add` runs its new case through the same wiring as the corpus run; the
  // wiring is handed in rather than imported back from here, so the two
  // command files depend on each other in one direction only.
  registerDrillAddCommand(drill, buildDrillRun);
}

// ============================================================
// The machine form
// ============================================================

/**
 * Where a drill run's per-case output goes. The text form prints each result
 * as it lands; the JSON form keeps them for the one document it prints at the
 * end. The sidecar and telemetry lines are written either way.
 */
export interface DrillSink {
  budget(line: string): void;
  caseResult(result: DrillResult, detail: IssueMessage | undefined): void;
}

const TEXT_SINK: DrillSink = {
  budget: (line) => writeOut(line + '\n'),
  caseResult: (result, detail) => {
    renderCaseResult(result);
    if (detail !== undefined) writeOut(`${buildIssueMessage(detail).split('\n').map((l) => `    ${l}`).join('\n')}\n`);
  },
};

/** The yg-drill/1 document for one run. */
export function drillDocument(
  aspectId: string,
  corpus: DrillJsonDocument['corpus'],
  results: readonly DrillResult[],
  details: ReadonlyMap<DrillResult, IssueMessage>,
  exitCode: 0 | 1 | 2,
): DrillJsonDocument {
  const counts = { pass: 0, miss: 0, falseAlarm: 0, unrun: 0, unsupported: 0 };
  for (const r of results) {
    if (r.outcome === 'false-alarm') counts.falseAlarm++;
    else counts[r.outcome]++;
  }
  return {
    schema: DRILL_JSON_SCHEMA,
    aspect: aspectId,
    corpus,
    counts,
    total: results.length,
    cases: results.map((r) => ({
      case: r.case.caseLabel,
      expect: r.case.expect,
      got: r.got,
      outcome: r.outcome,
      kind: r.kind,
      caseHash: r.caseHash,
      ruleHash: r.ruleHash,
      tier: r.tier ?? null,
      votes: r.votes ?? null,
      detail: details.has(r) ? buildIssueMessage(details.get(r)!) : null,
    })),
    exitCode,
  };
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
        what: `No reviewer is configured for reviewer rule '${aspect.id}'.`,
        why: `A reviewer-rule drill runs the real reviewer, which needs a tier in .yggdrasil/yg-config.yaml.`,
        next: `Add a reviewer tier to .yggdrasil/yg-config.yaml (yg init --provider <name> --model <m>), then yg drill --aspect ${aspect.id} again.`,
      },
    };
  }
  const tierResult = selectTierForAspect(aspect, reviewer);
  if (!tierResult.ok) return { ok: false, error: tierResult.error };
  const { tier, tierName } = tierResult;

  const provider = createLlmProvider(tier);
  const probe = await probeProvider(provider, tier.provider);
  if (!probe.available) {
    debugWrite(`[drill] tier ${tierName} provider ${tier.provider} unavailable: ${probe.reason}`);
    return {
      ok: false,
      error: {
        what: `Reviewer provider '${tier.provider}' (tier '${tierName}') cannot run: ${probe.reason}.`,
        why: `A reviewer-rule drill cannot run without the configured reviewer. No provider calls were made.`,
        next: `Fix the cause above, then retry. ${REVIEWER_DEBUG_HINT}`,
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
  pass: paint.green('pass       '),
  miss: paint.red('MISS       '),
  'false-alarm': paint.red('FALSE-ALARM'),
  unrun: paint.yellow('unrun      '),
  unsupported: paint.dim('unsupported'),
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
  writeOut(
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
  sink: DrillSink = TEXT_SINK,
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
    runDet: async (caseFiles, seenAs) => {
      try {
        const r = await runAstAspect({
          aspectDir,
          aspectId: aspect.id,
          files: caseFiles.map((f, i) => ({ path: seenAs[i] ?? f, readFrom: f })),
          projectRoot,
          graphAccessTrap: true,
          ...(aspect.config !== undefined && { config: aspect.config }),
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
    onBudget: (line) => sink.budget(line),
    onCaseResult: (result, detail) => {
      sink.caseResult(result, detail);
      const ts = new Date().toISOString();
      appendDrillResult(yggRoot, toResultLine(result, ts));
      const event = toVerdictEvent(result, ts, judge);
      if (event !== null) appendVerdictEvent(yggRoot, event);
    },
  };

  return { ok: true, ctx, deps };
}
