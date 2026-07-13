import { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { debugWrite } from '../utils/debug-log.js';
import { runAstAspect, AstRunnerError } from '../ast/runner.js';
import { runStructureAspect, StructureRunnerError } from '../structure/runner.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import type { Violation as AstViolation } from '../ast/types.js';
import type { Violation as StructureViolation } from '../structure/types.js';
import { computeExpectedPairs, computeNodeMappedFiles } from '../core/pairs.js';
import { computeEffectiveAspects } from '../core/graph/aspects.js';
import { buildPairPrompt, PROMPT_FORMAT_REV } from '../llm/prompt.js';
import type { PromptReferenceInput, PromptFileInput, PromptCompanionInput, PromptSuppressedRangesInput } from '../llm/prompt.js';
import { appendVerdictEvent, type VerdictEvent } from '../io/events-store.js';
import { resolveSuppressedRangesForPrompt, SuppressMarkerError } from '../structure/index.js';
import { verifyWithConsensus } from '../llm/aspect-verifier.js';
import { createLlmProvider } from '../llm/index.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import { contentFor, nodeDescriptionFor } from '../core/pair-inputs.js';
import { readTextFile } from '../io/graph-fs.js';
import { toPosixPath } from '../utils/posix.js';
import { runCompanionHook } from '../structure/hook-loader.js';
import { resolveCompanionDescriptors } from '../core/companion-resolve.js';
import type { ExpectedPair } from '../core/pairs.js';
import type { AspectDef, LlmConfig } from '../model/graph.js';

/** Footer printed after every run (det, LLM, and --dry-run). */
const DIAGNOSTIC_FOOTER =
  'diagnostic only — lock unchanged; yg check judges the lock against your files, not this run\n';

/**
 * One-line verdict stamps ('yg aspect-test: <verdict>'). satisfied/refused is
 * the reviewer/lock vocabulary — deliberately NOT the 'yg check: PASS/FAIL'
 * build stamp, so a diagnostic never reads as the build going green.
 * Deterministic runs print the stamp LEADING (results complete before print);
 * LLM runs stream per-pair lines and print a trailing summary stamp.
 */
const DET_SATISFIED_STAMP = `yg aspect-test: ${chalk.green('satisfied')} — No violations.\n`;
function detRefusedStamp(count: number): string {
  return `yg aspect-test: ${chalk.red('refused')} — ${count} violation${count === 1 ? '' : 's'}\n`;
}

export function registerAspectTestCommand(program: Command): void {
  program
    .command('aspect-test')
    .description(
      'Run an aspect check without modifying the lock — against a graph node (--node) or ad-hoc files (--files, deterministic only). ' +
      'For LLM aspects, --dry-run prints the assembled prompt(s) without making any reviewer/LLM call. ' +
      'For companion aspects, --dry-run runs the companion hook live and prints resolved companion paths.',
    )
    .requiredOption('--aspect <id>', 'aspect id to run')
    .option('--node <path>', 'graph node to check (uses the node mapping and graph-aware ctx)')
    .option('--files <paths...>', 'ad-hoc source files to check (deterministic aspects only; no graph attachment)')
    .option('--check-determinism', 'run the check twice and fail if results differ (deterministic aspects only)')
    .option('--dry-run', 'for LLM aspects: print the assembled prompt(s) to stdout, make no reviewer/LLM call (companion hook runs live)')
    .option('--repeat <n>', 'for LLM aspects: re-run each unit N times (N >= 2) to measure how consistently the reviewer judges the same prompt (self-consistency, not correctness); not valid with --dry-run, --files, or deterministic aspects')
    .option('--tier <name>', 'run the same pairs under a named reviewer tier from the merged config (dry-fit before a model swap); diagnostic — no graph edits, no lock writes')
    .action(async (opts) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = graph.aspects.find((a) => a.id === opts.aspect);
        if (!aspect) {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: `Aspect '${opts.aspect}' not found.`,
              why: `yg aspect-test requires an aspect declared in .yggdrasil/aspects/.`,
              next: `Run 'yg aspects' to list available aspects, or check the spelling of '${opts.aspect}'.`,
            })}\n`);
          process.exit(1);
          return;
        }

        const hasNode = typeof opts.node === 'string';
        const hasFiles = Array.isArray(opts.files) && opts.files.length > 0;

        // ── --repeat validation (LLM stability measurement) ──────────────────
        // --repeat re-runs each unit N times with consensus FORCED to 1 per run,
        // measuring how consistently the reviewer judges the SAME prompt. It is
        // meaningless for deterministic checks (exactly reproducible), for
        // --dry-run (no reviewer call to repeat), and for --files (deterministic
        // only). Requires an integer of at least 2.
        let repeatN = 1;
        if (opts.repeat !== undefined) {
          const raw = String(opts.repeat).trim();
          const parsed = /^[0-9]+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
          if (!Number.isInteger(parsed) || parsed < 2) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--repeat must be an integer of at least 2 (got '${opts.repeat}').`,
                why: `--repeat re-runs each unit N times to measure how consistently the reviewer judges the same prompt; a value below 2 measures nothing.`,
                next: `Pass --repeat 2 (or higher) with an LLM aspect and --node.`,
              })}\n`);
            process.exit(1);
            return;
          }
          if (opts.dryRun) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--repeat cannot be combined with --dry-run.`,
                why: `--dry-run makes no reviewer call, so there is nothing to repeat — the two flags are mutually exclusive.`,
                next: `Drop --dry-run to run the reviewer N times, or drop --repeat to preview the prompt once.`,
              })}\n`);
            process.exit(1);
            return;
          }
          if (hasFiles) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--repeat cannot be combined with --files.`,
                why: `--repeat measures reviewer self-consistency, which applies only to LLM aspects; --files runs a deterministic check that returns the same result every time.`,
                next: `Use --repeat with an LLM aspect and --node <node-path>.`,
              })}\n`);
            process.exit(1);
            return;
          }
          if (aspect.reviewer.type !== 'llm') {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--repeat is not supported for ${aspect.reviewer.type} aspect '${opts.aspect}'.`,
                why: `A deterministic check is exactly reproducible — repeating it measures nothing. --repeat measures how consistently an LLM reviewer judges the same prompt.`,
                next: `Run --repeat against an LLM aspect (content.md), or use --check-determinism to re-run a deterministic aspect.`,
              })}\n`);
            process.exit(1);
            return;
          }
          repeatN = parsed;
        }

        // ── --tier validation (dry-fit under a named reviewer tier) ──────────
        // --tier re-runs the SAME LLM pairs under a named tier from the merged
        // config (yg-secrets included), overriding the aspect's declared/default
        // tier — the "does this survive under the model I'm about to switch to?"
        // probe. It is diagnostic: no graph edits, no lock writes. It mirrors
        // --repeat's guards (LLM aspect + --node only; never --files, never a
        // deterministic aspect) and MAY combine with --repeat (each of the N runs
        // then emits under the chosen tier). The tier NAME itself is resolved in
        // runLlmAspectTest (direct reviewer.tiers lookup, unknown-tier error).
        if (typeof opts.tier === 'string') {
          if (hasFiles) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--tier cannot be combined with --files.`,
                why: `--tier re-runs LLM pairs under a named reviewer tier, which requires graph context (node mapping, effective aspects); --files runs a deterministic check with no tier.`,
                next: `Use --tier with an LLM aspect and --node <node-path>.`,
              })}\n`);
            process.exit(1);
            return;
          }
          if (aspect.reviewer.type !== 'llm') {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--tier is not supported for ${aspect.reviewer.type} aspect '${opts.aspect}'.`,
                why: `A deterministic check runs locally with no reviewer tier — there is no tier to swap. --tier re-runs an LLM aspect under a named reviewer tier.`,
                next: `Run --tier against an LLM aspect (content.md) with --node, or drop --tier for a deterministic aspect.`,
              })}\n`);
            process.exit(1);
            return;
          }
        }

        // ── LLM aspect path ──────────────────────────────────────────────────
        if (aspect.reviewer.type === 'llm') {
          // --files is not supported for LLM aspects: they need graph context.
          if (hasFiles) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `--files cannot be used with LLM aspect '${opts.aspect}'.`,
                why: `LLM reviews require graph context (node mapping, effective aspects, tier config). Ad-hoc file lists have none of these.`,
                next: `Use --node <node-path> instead, or switch to a deterministic aspect for --files mode.`,
              })}\n`);
            process.exit(1);
            return;
          }
          if (!hasNode) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `Neither --node nor --files was provided for LLM aspect '${opts.aspect}'.`,
                why: `yg aspect-test runs in exactly one mode: --node (graph-scoped) or --files (ad-hoc, deterministic only).`,
                next: `Pass --node <node-path> to run an LLM aspect.`,
              })}\n`);
            process.exit(1);
            return;
          }

          const nodePath = (opts.node as string).trim().replace(/\/$/, '');
          const node = graph.nodes.get(nodePath);
          if (!node) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `Node '${nodePath}' not found.`,
                why: `--node requires an existing node path in the graph.`,
                next: `Run 'yg tree' to list nodes.`,
              })}\n`);
            process.exit(1);
            return;
          }

          const llmExit = await runLlmAspectTest(graph, projectRoot, aspect, nodePath, opts.dryRun ?? false, repeatN, typeof opts.tier === 'string' ? opts.tier : undefined);
          process.stdout.write(DIAGNOSTIC_FOOTER);
          // Refused or incomplete (fail-closed) units exit 1, per the documented
          // 'exit 1 on violations or refusals' contract.
          if (llmExit !== 0) await exitAfterFlush(llmExit);
          return;
        }

        // ── Deterministic aspect path ────────────────────────────────────────
        if (aspect.reviewer.type !== 'deterministic') {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: `Aspect '${opts.aspect}' has reviewer '${aspect.reviewer.type}', not 'deterministic' or 'llm'.`,
              why: `yg aspect-test supports deterministic aspects (check.mjs) and LLM aspects (content.md).`,
              next: `Pick an aspect with a supported reviewer type, or run 'yg aspects' to list available aspects.`,
            })}\n`);
          process.exit(1);
          return;
        }

        // --dry-run on a deterministic aspect is not meaningful.
        if (opts.dryRun) {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: `--dry-run is not supported for deterministic aspect '${opts.aspect}'.`,
              why: `Deterministic checks run locally without any provider calls — there is no prompt to print.`,
              next: `Remove --dry-run to run the deterministic check, or use --node / --files as normal.`,
            })}\n`);
          process.exit(1);
          return;
        }

        if (hasNode === hasFiles) {
          process.stderr.write(`Error: ${buildIssueMessage({
              what: hasNode
                ? `Both --node and --files were provided.`
                : `Neither --node nor --files was provided.`,
              why: `yg aspect-test runs in exactly one mode: --node (graph-scoped) or --files (ad-hoc).`,
              next: `Pass --node <node-path> to use the node's mapping, or --files <path...> for ad-hoc files — not both.`,
            })}\n`);
          process.exit(1);
          return;
        }

        const aspectDir = path.join('.yggdrasil', 'aspects', aspect.id);

        // --node: graph-scoped, matches real approve (always node-scoped). The
        // structure runner resolves the node's own mapping and graph-aware ctx.
        if (hasNode) {
          const nodePath = (opts.node as string).trim().replace(/\/$/, '');
          const node = graph.nodes.get(nodePath);
          if (!node) {
            process.stderr.write(`Error: ${buildIssueMessage({
                what: `Node '${nodePath}' not found.`,
                why: `--node requires an existing node path in the graph.`,
                next: `Run 'yg tree' to list nodes.`,
              })}\n`);
            process.exit(1);
            return;
          }
          // The ad-hoc run below is legitimately useful (test-before-attach), but
          // it runs against the node's files even when the aspect is NOT effective
          // on the node through any channel — silently printing a verdict yg check
          // will never produce (the LLM path says "No pairs" in the same case).
          // Restore the symmetry: if the aspect is not effective on this node,
          // print a one-line NOTE to stderr first. Effectiveness is the full
          // 7-channel cascade — NOT "a pair exists at this exact node": an aspect
          // attached to an organizational / fileless node (no own mapping) produces
          // no pair AT that node but is genuinely effective, its pairs materializing
          // at file-bearing descendants. computeEffectiveAspects returns the ids
          // effective on the node regardless of whether the node itself bears files,
          // and does not filter by status — a DRAFT aspect attached to its own node
          // still resolves as attached (status gates the lock/fill, never this
          // diagnostic). Exit code and verdict output are unchanged; if
          // classification fails (e.g. an incomplete graph in a unit harness), skip
          // the NOTE rather than block the diagnostic.
          try {
            const effective = computeEffectiveAspects(node, graph);
            const attached = effective.has(aspect.id);
            if (!attached) {
              process.stderr.write(
                `Note: aspect '${aspect.id}' is not attached to node '${nodePath}' — running the check ad-hoc against its files; yg check will not produce a verdict for this pair.\n`,
              );
            }
          } catch (e) {
            debugWrite(`[aspect-test] effectiveness precheck failed for ${aspect.id} on ${nodePath}: ${e instanceof Error ? e.message : String(e)}`);
          }
          // Return type is inferred from the runner (RunStructureAspectResult);
          // do not re-annotate it, so the shape stays in sync with the runner.
          const runOnce = () =>
            runStructureAspect({ aspectDir, aspectId: aspect.id, nodePath, graph, projectRoot });
          const result = await runOnce();
          if (opts.checkDeterminism) {
            const result2 = await runOnce();
            if (!determinismMatches(result.violations, result2.violations)) {
              writeNonDeterministicError(opts.aspect, result.violations, result2.violations);
              process.stdout.write(DIAGNOSTIC_FOOTER);
              await exitAfterFlush(1);
            }
          }
          if (result.violations.length === 0) {
            process.stdout.write(DET_SATISFIED_STAMP);
            process.stdout.write(DIAGNOSTIC_FOOTER);
            return;
          }
          process.stdout.write(detRefusedStamp(result.violations.length));
          printStructureViolations(result.violations);
          process.stdout.write(DIAGNOSTIC_FOOTER);
          await exitAfterFlush(1);
        }

        // --files: ad-hoc mode has no node and thus no approve equivalent; it
        // stays on the AST runner (a fileless structure path is out of scope).
        const filePaths = opts.files as string[];
        // Return type is inferred from the runner; do not re-annotate it.
        const runOnce = () =>
          runAstAspect({
            aspectDir,
            aspectId: aspect.id,
            files: filePaths.map((f) => ({ path: f })),
            projectRoot,
          });
        const result = await runOnce();
        if (opts.checkDeterminism) {
          const result2 = await runOnce();
          if (!determinismMatches(result.violations, result2.violations)) {
            writeNonDeterministicError(opts.aspect, result.violations, result2.violations);
            process.stdout.write(DIAGNOSTIC_FOOTER);
            await exitAfterFlush(1);
          }
        }
        if (result.violations.length === 0) {
          process.stdout.write(DET_SATISFIED_STAMP);
          process.stdout.write(DIAGNOSTIC_FOOTER);
          return;
        }
        process.stdout.write(detRefusedStamp(result.violations.length));
        printAstViolations(result.violations);
        process.stdout.write(DIAGNOSTIC_FOOTER);
        await exitAfterFlush(1);
      } catch (e: unknown) {
        debugWrite(`[aspect-test] run failed: ${e instanceof Error ? e.message : String(e)}`);
        // A deterministic runner error (StructureRunnerError / AstRunnerError)
        // already carries a fully-formed what/why/next in `messageData` — a
        // check.mjs that threw, returned the wrong shape, or failed to load. It
        // is a classified, actionable failure of the aspect under test, NOT an
        // unclassified CLI bug, so render its structured message and exit 1
        // instead of routing it through abortOnUnexpectedError's generic
        // "encountered an error it does not classify / file an issue" wrapper.
        // This also keeps --check-determinism clean: if either of the two runs
        // throws a runner error, the user sees the real cause, not a CLI-bug
        // message.
        if (e instanceof StructureRunnerError || e instanceof AstRunnerError) {
          process.stderr.write(`Error: ${buildIssueMessage(e.messageData)}\n`);
          await exitAfterFlush(1);
          return;
        }
        abortOnUnexpectedError(e, 'running aspect-test');
      }
    });
}

// ============================================================
// Companion resolution (diagnostic — lock never written, hook runs live)
// ============================================================

/**
 * Resolve companions for one pair in aspect-test / dry-run context.
 *
 * Runs the companion hook once (no A6 taint-retry guard — intentionally omitted
 * for a diagnostic tool: a tainted observation set is harmless here because we
 * never hash or write observations). Post-hook resolution is delegated to the
 * shared resolveCompanionDescriptors helper so --dry-run previews companions
 * identically to what --approve sends to the LLM, including the rich
 * allowed-reads NEXT message (relation source + owner node + exact YAML stanza).
 *
 * On hook failure (infra) returns { kind: 'infra' } — the caller prints a
 * buildIssueMessage and continues; it NEVER writes to the lock and NEVER throws.
 */
async function resolveCompanionsForTest(
  graph: import('../model/graph.js').Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
): Promise<
  | { kind: 'ok'; companions: PromptCompanionInput[] }
  | { kind: 'infra'; messageData: { what: string; why: string; next: string } }
> {
  const aspectDirAbs = path.join(projectRoot, '.yggdrasil', 'aspects', aspect.id);

  // subjectScope mirrors fill-llm: narrow iff the subject set is FEWER files
  // than the node's full mapping (per:file, or per:node with a scope.files filter).
  const fullMapping = await computeNodeMappedFiles(graph, pair.nodePath);
  const subjectScope = pair.subjectFiles.length < fullMapping.length ? pair.subjectFiles : undefined;

  // No A6 taint guard (diagnostic only — we never hash or write observations).
  const run = await runCompanionHook({
    aspectDir: aspectDirAbs,
    aspectId: aspect.id,
    nodePath: pair.nodePath,
    graph,
    projectRoot,
    subjectScope,
  });

  if (run.kind === 'infra') {
    return { kind: 'infra', messageData: run.messageData };
  }

  // Delegate post-hook resolution to the shared helper (same logic as fill-llm:
  // normalize, dedupe, sort, allowed-reads guard with rich NEXT, readFileBytes).
  const resolved = await resolveCompanionDescriptors(graph, projectRoot, pair, aspect, run.descriptors, run.observations);
  if (resolved.kind === 'infra') {
    return { kind: 'infra', messageData: resolved.messageData };
  }
  // observations are not needed by the diagnostic caller (never hashed/written).
  return { kind: 'ok', companions: resolved.companions };
}

// ============================================================
// LLM aspect test
// ============================================================

/**
 * Resolve yg-suppress line ranges for `aspectId` over the already-loaded subject
 * files, shaped for prompt injection so the diagnostic prompt matches the billed
 * one byte-for-byte. Routed through the structure adapter (the command already
 * declares `calls cli/structure`), keeping the engine/command suppress-resolution
 * paths identical. On a reasonless marker, prints a what/why/next and returns
 * `null` so the caller skips that pair (the live --approve path treats the same
 * marker as fail-closed infra).
 */
async function resolveSuppressedRangesForTest(
  files: PromptFileInput[],
  aspectId: string,
): Promise<PromptSuppressedRangesInput | null> {
  const subjects = files.map((f) => ({ path: f.path, bytes: Buffer.from(f.content, 'utf8') }));
  try {
    return await resolveSuppressedRangesForPrompt(subjects, aspectId);
  } catch (e) {
    if (e instanceof SuppressMarkerError) {
      const where = `${toPosixPath(e.file)}:${e.line}`;
      debugWrite(`[aspect-test] suppress marker missing reason for ${aspectId} at ${where}`);
      process.stderr.write(`Error: ${buildIssueMessage({
          what: `A yg-suppress marker at ${where} (subject of aspect '${aspectId}') is missing its required reason.`,
          why: `A reasonless suppress marker cannot be resolved into a line range, so the prompt's suppressed-line set is undefined. The live yg check --approve path treats this as a fail-closed infrastructure error.`,
          next: `Add a reason after the marker's closing parenthesis at ${where}, then retry.`,
        })}\n`);
      return null;
    }
    throw e;
  }
}

/**
 * Run (or dry-run) an LLM aspect against a graph node. Builds pair prompts via
 * computeExpectedPairs filtered to the given aspect+node, runs verifyWithConsensus
 * per prompt, and prints results. The lock is NEVER written. Returns the exit
 * code the caller should use: 1 when any unit is refused or could not be
 * verified (fail-closed), 0 otherwise.
 *
 * When `repeat >= 2` the run enters STABILITY mode: the prompt (and companions)
 * are built ONCE per unit, then the reviewer is called `repeat` times with
 * consensus FORCED to 1 per run. Each run is its own verdict (no aggregation, so
 * no losing-vote mislabeling); the per-unit `stability: k/N satisfied` line
 * reports how consistently the reviewer judged the same prompt — a variance
 * measure, NOT a correctness claim. Provider-error runs are excluded from the
 * k/N denominator and reported separately; a unit with any valid refused run is
 * refused, and a unit whose runs ALL erred is incomplete (fail closed).
 *
 * When `tierOverride` is a tier NAME, the reviewer runs under that tier from the
 * MERGED config (yg-secrets included) instead of the aspect's declared/default
 * tier — the "dry-fit before a model swap" probe. It is looked up DIRECTLY in
 * reviewer.tiers (never through selectTierForAspect, which would resolve the
 * aspect's own tier); an unknown name is a what/why/next error. --tier does ZERO
 * graph edits and ZERO lock writes; it only re-points which reviewer is called.
 *
 * Either mode records local diagnostic telemetry: one source:'diag' verdict-event
 * per reviewer RUN (one per repeat iteration; one per unit otherwise) is appended
 * to the gitignored events sidecar, tagged with the tier ACTUALLY used and the
 * resolved judge. Emission is best-effort — a failed append never fails the
 * diagnostic — and is NEVER a hash ingredient (the lock stays untouched).
 */
async function runLlmAspectTest(
  graph: import('../model/graph.js').Graph,
  projectRoot: string,
  aspect: import('../model/graph.js').AspectDef,
  nodePath: string,
  dryRun: boolean,
  repeat: number,
  tierOverride: string | undefined,
): Promise<0 | 1> {
  // Resolve the tier for this aspect.
  const reviewer = graph.config.reviewer;
  if (!reviewer) {
    process.stderr.write(`Error: ${buildIssueMessage({
        what: `No reviewer is configured for aspect '${aspect.id}'.`,
        why: `LLM aspects need a reviewer tier in .yggdrasil/yg-config.yaml.`,
        next: `Add a reviewer tier, then retry.`,
      })}\n`);
    process.exit(1);
    return 1;
  }
  let tier: LlmConfig;
  let tierName: string;
  if (tierOverride !== undefined) {
    // --tier: resolve the NAME directly against the merged tier map (yg-secrets
    // overlay already applied at parse time). This deliberately bypasses
    // selectTierForAspect — the whole point of --tier is to override the aspect's
    // declared/default tier with an arbitrary named one.
    const direct = reviewer.tiers[tierOverride];
    if (!direct) {
      const tierNames = Object.keys(reviewer.tiers);
      process.stderr.write(`Error: ${buildIssueMessage({
          what: `Tier '${tierOverride}' is not defined in .yggdrasil/yg-config.yaml.`,
          why: `--tier re-runs the same pairs under a named reviewer tier from the merged config (yg-secrets included); an unknown tier has no provider or model to call.`,
          next: `Use one of: ${tierNames.join(', ')}, or add the tier to yg-config.yaml (or yg-secrets).`,
        })}\n`);
      process.exit(1);
      return 1;
    }
    tier = direct;
    tierName = tierOverride;
  } else {
    const tierResult = selectTierForAspect(aspect, reviewer);
    if (!tierResult.ok) {
      process.stderr.write(`Error: ${buildIssueMessage(tierResult.error)}\n`);
      process.exit(1);
      return 1;
    }
    tier = tierResult.tier;
    tierName = tierResult.tierName;
  }

  // Compute the expected pairs filtered to this aspect+node. Drafts are
  // included: status gates the lock/fill, never this diagnostic — a draft
  // aspect runs here exactly like an enforced one.
  const { pairs } = await computeExpectedPairs(graph, { includeDraft: true });
  const myPairs = pairs.filter(
    (p) => p.aspectId === aspect.id && p.nodePath === nodePath && p.kind === 'llm',
  );

  if (myPairs.length === 0) {
    process.stdout.write(
      `No pairs for aspect '${aspect.id}' on node '${nodePath}' — the aspect has an empty subject set or does not apply to this node.\n`,
    );
    return 0;
  }

  // Load references once.
  const refInputs = aspect.references ?? [];
  const referencesForPrompt: PromptReferenceInput[] = [];
  for (const ref of refInputs) {
    const absRef = path.resolve(projectRoot, ref.path);
    let content: string;
    try {
      content = await readTextFile(absRef);
    } catch (e) {
      debugWrite(`[aspect-test] reference file read failed for ${absRef}: ${e instanceof Error ? e.message : String(e)}`);
      process.stderr.write(`Error: ${buildIssueMessage({
          what: `Reference '${toPosixPath(ref.path)}' for aspect '${aspect.id}' could not be read.`,
          why: `The file does not exist or is not readable.`,
          next: `Check the reference path in yg-aspect.yaml.`,
        })}\n`);
      process.exit(1);
      return 1;
    }
    referencesForPrompt.push({ path: ref.path, description: ref.description, content });
  }

  const nodeDescription = nodeDescriptionFor(graph, nodePath);
  const aspectContent = contentFor(aspect, 'content.md');

  if (!dryRun) {
    // Tier config already includes the yg-secrets overlay (applied at parse time).
    const mergedTier = tier;
    const provider = createLlmProvider(mergedTier);

    // Availability check.
    let available: boolean;
    try {
      available = await provider.isAvailable();
    } catch (e) {
      debugWrite(`[aspect-test] provider.isAvailable threw for tier ${tierName}: ${e instanceof Error ? e.message : String(e)}`);
      available = false;
    }
    if (!available) {
      process.stderr.write(`Error: ${buildIssueMessage({
          what: `Reviewer provider '${mergedTier.provider}' (tier '${tierName}') is unreachable.`,
          why: `The configured reviewer endpoint did not respond. No provider calls were made.`,
          next: `Check the provider endpoint, network, and credentials, then retry.`,
        })}\n`);
      process.exit(1);
      return 1;
    }

    // Diagnostic telemetry sidecar (source:'diag'): one line per reviewer RUN in
    // this diagnostic — a real verdict (approved/refused) or an infra no-verdict
    // outcome. `ts` is the CLI-boundary wall clock (this is a command, not an
    // engine file, so new Date() is fine here — mirrors cli/drill.ts). The line
    // carries the tier ACTUALLY used and the resolved judge so wave-4 analyses can
    // separate judge/model regimes. Best-effort: appendVerdictEvent swallows any
    // write failure by contract, so telemetry can never fail the diagnostic. NOT a
    // hash ingredient — aspect-test never writes the lock.
    const emitDiag = (
      unitKey: string,
      disposition: 'approved' | 'refused' | 'infra',
      votes?: { satisfied: number; total: number },
    ): void => {
      const event: VerdictEvent = {
        v: 1,
        ts: new Date().toISOString(),
        source: 'diag',
        aspectId: aspect.id,
        unitKey,
        kind: 'llm',
        disposition,
        tier: tierName,
        promptRev: PROMPT_FORMAT_REV,
        judge: { provider: tier.provider, model: String(tier.model) },
      };
      // votes accompany a real verdict only; an infra run cast no countable vote.
      if (votes !== undefined) event.votes = votes;
      appendVerdictEvent(graph.rootPath, event);
    };

    // Stability mode prints the total reviewer-call budget BEFORE the first
    // call (repeat N × units), so the cost is visible up front.
    if (repeat >= 2) {
      const units = myPairs.length;
      process.stdout.write(
        `repeat ${repeat} × ${units} unit${units === 1 ? '' : 's'} = ${repeat * units} reviewer calls\n`,
      );
    }

    // Per-pair verdict lines stream as results arrive; a one-line summary stamp
    // follows the loop. Skipped pairs (companion/suppress/reviewer infra) make
    // the run incomplete — fail closed.
    let refusedCount = 0;
    let skippedCount = 0;
    for (const pair of myPairs) {
      // Load subject files for this pair.
      const files: PromptFileInput[] = [];
      for (const rel of pair.subjectFiles) {
        let content: string;
        try {
          const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path.resolve(projectRoot, rel)));
          content = bytes.toString('utf8');
        } catch (e) {
          debugWrite(`[aspect-test] subject file read failed for ${rel} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
          content = '';
        }
        files.push({ path: rel, content });
      }

      // Resolve companions (live hook run, same resolution as --approve).
      let companions: PromptCompanionInput[] = [];
      if (aspect.hasCompanion === true) {
        const resolved = await resolveCompanionsForTest(graph, projectRoot, pair, aspect);
        if (resolved.kind === 'infra') {
          debugWrite(`[aspect-test] companion resolution failed for ${aspect.id} on ${pair.unitKey}: ${resolved.messageData.what}`);
          process.stderr.write(`Error: ${buildIssueMessage(resolved.messageData)}\n`);
          skippedCount++;
          continue;
        }
        companions = resolved.companions;
      }

      const suppressedRanges = await resolveSuppressedRangesForTest(files, aspect.id);
      if (suppressedRanges === null) {
        skippedCount++;
        continue;
      }

      const prompt = buildPairPrompt({
        aspect: { id: aspect.id, description: aspect.description ?? '', content: aspectContent },
        references: referencesForPrompt,
        nodePath,
        nodeDescription,
        files,
        companions,
        suppressedRanges,
        scope: aspect.scope,
      });

      if (repeat >= 2) {
        // ── Stability mode: N runs of the SAME prompt, consensus forced to 1 ──
        // Each run is its own verdict (no aggregation → no losing-vote
        // mislabeling). Provider-error runs are excluded from the k/N
        // denominator and reported separately; any valid refused run makes the
        // unit refused; a unit whose runs ALL erred is incomplete (fail closed).
        let satisfiedRuns = 0;
        let refusedRuns = 0;
        let providerErrorRuns = 0;
        for (let i = 1; i <= repeat; i++) {
          let response;
          try {
            ({ response } = await verifyWithConsensus(provider, prompt, 1));
          } catch (e) {
            debugWrite(`[aspect-test] reviewer threw for ${aspect.id} on ${pair.unitKey} run ${i}/${repeat}: ${e instanceof Error ? e.message : String(e)}`);
            providerErrorRuns++;
            emitDiag(pair.unitKey, 'infra');
            process.stdout.write(`${pair.unitKey} run ${i}/${repeat}: provider-error — reviewer threw: ${e instanceof Error ? e.message : String(e)}\n`);
            continue;
          }
          if (!response.satisfied && response.errorSource === 'provider') {
            debugWrite(`[aspect-test] provider error for ${aspect.id} on ${pair.unitKey} run ${i}/${repeat}: ${response.reason}`);
            providerErrorRuns++;
            emitDiag(pair.unitKey, 'infra');
            process.stdout.write(`${pair.unitKey} run ${i}/${repeat}: provider-error — ${response.reason}\n`);
            continue;
          }
          if (response.satisfied) satisfiedRuns++;
          else refusedRuns++;
          // Consensus is forced to 1 per run here, so each run casts exactly one
          // countable vote (votes.total: 1) — the raw self-consistency signal.
          emitDiag(pair.unitKey, response.satisfied ? 'approved' : 'refused', {
            satisfied: response.satisfied ? 1 : 0,
            total: 1,
          });
          const verdict = response.satisfied ? 'satisfied' : 'refused';
          process.stdout.write(`${pair.unitKey} run ${i}/${repeat}: ${verdict} — ${response.reason}\n`);
        }

        const validRuns = satisfiedRuns + refusedRuns;
        if (validRuns === 0) {
          // Every run erred — the unit was never actually judged. Fail closed.
          process.stdout.write(`  stability: not measured — all ${repeat} runs returned provider errors\n`);
          skippedCount++;
          continue;
        }
        // k/N is a self-CONSISTENCY figure (how often the same prompt drew a
        // 'satisfied' verdict), never a correctness score.
        const excludedNote = providerErrorRuns > 0
          ? ` (${providerErrorRuns} provider-error run${providerErrorRuns === 1 ? '' : 's'} excluded)`
          : '';
        process.stdout.write(`  stability: ${satisfiedRuns}/${validRuns} satisfied${excludedNote}\n`);
        if (refusedRuns > 0) refusedCount++;
        continue;
      }

      let response;
      let votes;
      try {
        ({ response, votes } = await verifyWithConsensus(provider, prompt, mergedTier.consensus ?? 1));
      } catch (e) {
        debugWrite(`[aspect-test] reviewer threw for ${aspect.id} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
        emitDiag(pair.unitKey, 'infra');
        process.stderr.write(`Error: ${buildIssueMessage({
            what: `Reviewer threw an error for aspect '${aspect.id}' on ${pair.unitKey}.`,
            why: `The reviewer returned an unparseable or errored response: ${e instanceof Error ? e.message : String(e)}`,
            next: `Check the reviewer configuration and retry.`,
          })}\n`);
        skippedCount++;
        continue;
      }

      // A provider-sourced failure (HTTP non-200 / unparseable body) is
      // infrastructure, NOT a code violation — every provider folds it into
      // { satisfied:false, errorSource:'provider' }. Mirror fill-llm.ts: treat it
      // as an UNVERIFIED unit (skipped → the 'incomplete' stamp + exit 1), never as
      // a code refusal. Rendering it as a 'refused' verdict would send an agent
      // editing code for a violation the reviewer never actually found.
      if (!response.satisfied && response.errorSource === 'provider') {
        debugWrite(`[aspect-test] provider error for ${aspect.id} on ${pair.unitKey}: ${response.reason}`);
        emitDiag(pair.unitKey, 'infra');
        process.stderr.write(`Error: ${buildIssueMessage({
            what: `Reviewer for aspect '${aspect.id}' on ${pair.unitKey} returned a provider error: ${response.reason}`,
            why: `A provider-sourced failure is infrastructure, not a code violation — the unit was not verified.`,
            next: `Check the provider endpoint, network, and credentials, then retry.`,
          })}\n`);
        skippedCount++;
        continue;
      }

      if (!response.satisfied) refusedCount++;
      // Record the real verdict with its full consensus vote split (how many of
      // the tier's independent passes were satisfied out of the total cast).
      emitDiag(pair.unitKey, response.satisfied ? 'approved' : 'refused', {
        satisfied: votes.filter((v) => v.satisfied).length,
        total: votes.length,
      });
      const verdict = response.satisfied ? 'satisfied' : 'refused';
      // Vote-split suffix — only when consensus > 1 actually cast multiple votes;
      // a consensus=1 aspect always wraps a single vote, so the line stays as-is.
      const voteSuffix = votes.length > 1
        ? ` [votes ${votes.filter((v) => v.satisfied).length}/${votes.length}]`
        : '';
      process.stdout.write(`${pair.unitKey}: ${verdict} — ${response.reason}${voteSuffix}\n`);
    }

    // Summary stamp — the caller prints the footer directly after it.
    const total = myPairs.length;
    if (skippedCount > 0) {
      process.stdout.write(`yg aspect-test: ${chalk.red('incomplete')} — ${skippedCount} of ${total} units could not be verified\n`);
      return 1;
    }
    if (refusedCount > 0) {
      process.stdout.write(`yg aspect-test: ${chalk.red('refused')} — ${refusedCount} of ${total} units refused\n`);
      return 1;
    }
    process.stdout.write(`yg aspect-test: ${chalk.green('satisfied')} — ${total} unit${total === 1 ? '' : 's'} satisfied\n`);
    return 0;
  } else {
    // --dry-run: print assembled prompt(s), no reviewer/LLM calls.
    // For companion aspects: runs the companion hook live (same resolution as --approve),
    // prints resolved companion paths/labels, then includes them in the prompt.
    process.stdout.write('yg aspect-test: dry-run — prompt preview only, no verdict\n');
    for (const pair of myPairs) {
      const files: PromptFileInput[] = [];
      for (const rel of pair.subjectFiles) {
        let content: string;
        try {
          const bytes = await import('node:fs/promises').then((fs) => fs.readFile(path.resolve(projectRoot, rel)));
          content = bytes.toString('utf8');
        } catch (e) {
          debugWrite(`[aspect-test] subject file read failed for ${rel} on ${pair.unitKey}: ${e instanceof Error ? e.message : String(e)}`);
          content = '';
        }
        files.push({ path: rel, content });
      }

      // Resolve companions (live hook run, same resolution as --approve).
      // On hook failure: print a what/why/next message and continue — never crash.
      let companions: PromptCompanionInput[] = [];
      if (aspect.hasCompanion === true) {
        const resolved = await resolveCompanionsForTest(graph, projectRoot, pair, aspect);
        if (resolved.kind === 'infra') {
          debugWrite(`[aspect-test] companion resolution failed for ${aspect.id} on ${pair.unitKey}: ${resolved.messageData.what}`);
          process.stderr.write(`Error: ${buildIssueMessage(resolved.messageData)}\n`);
          // Continue so the user sees the rest of the dry-run output (no reviewer calls made).
          continue;
        }
        companions = resolved.companions;
        // Print resolved companion paths/labels BEFORE the prompt for this unit.
        process.stdout.write(`--- companions for ${pair.unitKey} ---\n`);
        if (companions.length === 0) {
          process.stdout.write('  (none)\n');
        } else {
          for (const c of companions) {
            const labelSuffix = c.label !== undefined ? ` (${c.label})` : '';
            process.stdout.write(`  ${c.path}${labelSuffix}\n`);
          }
        }
      }

      const suppressedRanges = await resolveSuppressedRangesForTest(files, aspect.id);
      if (suppressedRanges === null) continue;

      const prompt = buildPairPrompt({
        aspect: { id: aspect.id, description: aspect.description ?? '', content: aspectContent },
        references: referencesForPrompt,
        nodePath,
        nodeDescription,
        files,
        companions,
        suppressedRanges,
        scope: aspect.scope,
      });

      process.stdout.write(`=== prompt for ${pair.unitKey} ===\n`);
      process.stdout.write(prompt + '\n');
    }
  }
  return 0;
}

// ============================================================
// Determinism check (shared by both deterministic modes)
// ============================================================

type AnyViolation = { file?: string; line?: number; column?: number; message: string };

function sortKey(v: AnyViolation): string {
  return `${v.file ?? '<graph>'}:${v.line ?? 0}:${v.column ?? 0}:${v.message}`;
}

function determinismMatches(a: AnyViolation[], b: AnyViolation[]): boolean {
  const sa = [...a].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const sb = [...b].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  return JSON.stringify(sa) === JSON.stringify(sb);
}

function writeNonDeterministicError(aspectId: string, run1: AnyViolation[], run2: AnyViolation[]): void {
  const sorted1 = [...run1].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  const sorted2 = [...run2].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  process.stderr.write(`Error: ${buildIssueMessage({
      what: `Deterministic aspect '${aspectId}' produced non-deterministic results.`,
      why: `Two consecutive runs returned different violations. This indicates the check.mjs has side effects or depends on non-deterministic state.`,
      next: `Review check.mjs to ensure it depends only on its inputs and produces stable output.`,
    })}\n`);
  process.stderr.write('Run 1:\n');
  process.stderr.write(JSON.stringify(sorted1, null, 2) + '\n');
  process.stderr.write('Run 2:\n');
  process.stderr.write(JSON.stringify(sorted2, null, 2) + '\n');
}

// ============================================================
// Renderers (kept separate: AST has required line, structure does not)
// ============================================================

function printAstViolations(violations: AstViolation[]): void {
  const byFile = new Map<string, AstViolation[]>();
  for (const v of violations) {
    if (!byFile.has(v.file)) byFile.set(v.file, []);
    byFile.get(v.file)!.push(v);
  }
  const entries = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, vs] of entries) {
    process.stdout.write(file + '\n');
    for (const v of vs.sort((a, b) => a.line - b.line)) {
      process.stdout.write(`  L${v.line}: ${v.message}\n`);
    }
  }
}

function printStructureViolations(violations: StructureViolation[]): void {
  const withFile: StructureViolation[] = [];
  const withoutFile: StructureViolation[] = [];
  for (const v of violations) {
    if (typeof v.file === 'string') withFile.push(v);
    else withoutFile.push(v);
  }
  for (const v of withoutFile) {
    process.stdout.write(`<graph>: ${v.message}\n`);
  }
  const byFile = new Map<string, StructureViolation[]>();
  for (const v of withFile) {
    if (!byFile.has(v.file!)) byFile.set(v.file!, []);
    byFile.get(v.file!)!.push(v);
  }
  const entries = [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [file, vs] of entries) {
    process.stdout.write(file + '\n');
    // Line-less violations sort as 0 (first) and render as a bare indented
    // message — no placeholder line number.
    for (const v of vs.sort((a, b) => (a.line ?? 0) - (b.line ?? 0))) {
      process.stdout.write(typeof v.line === 'number' ? `  L${v.line}: ${v.message}\n` : `  ${v.message}\n`);
    }
  }
}
