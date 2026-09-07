import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import {
  REVIEW_JSON_SCHEMA,
  VERDICTS_JSON_SCHEMA,
  formatReviewJson,
  formatVerdictsJson,
} from '../formatters/verdict-json.js';
import type {
  ReviewJsonDocument,
  ReviewJsonFile,
  VerdictsJsonDocument,
  VerdictsJsonEntry,
} from '../formatters/verdict-json.js';
import { readLock, writeLock, readDetLockAspectIds, LockInvalidError } from '../io/lock-store.js';
import { readTextFile } from '../io/graph-fs.js';
import type { LockFile, VerdictEntry, Verdict } from '../model/lock.js';
import { computeExpectedPairs } from '../core/pairs.js';
import type { ExpectedPair } from '../core/pairs.js';
import { verifyPairs } from '../core/verify-lock.js';
import { assembleReviewPackage } from '../core/review-package.js';
import type { AssembledReviewPackage } from '../core/review-package.js';
import { selectTierForAspect } from '../core/tier-selection.js';
import { buildPairPrompt, DEFAULT_MAX_PROMPT_CHARS } from '../llm/prompt.js';
import { projectRootFromGraph, resolveFileArg } from '../io/paths.js';
import { toPosixPath } from '../utils/posix.js';
import type { Graph, AspectDef } from '../model/graph.js';

/** The two words a judge decides in, and the lock tokens they map to. */
const VERDICT_WORDS: Record<string, Verdict> = { pass: 'approved', refused: 'refused' };

/** Write a guided error to stderr and exit 1. The only failure shape this command has. */
function refuse(what: string, why: string, next: string): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage({ what, why, next })}\n`));
  process.exit(1);
}

/** Read the lock, or refuse with the loader's own guided message. */
function readLockOrRefuse(graph: Graph): LockFile {
  try {
    return readLock(graph.rootPath);
  } catch (err) {
    if (err instanceof LockInvalidError) {
      debugWrite(`[verdict] readLock failed: ${err.message}`);
      process.stderr.write(chalk.red(`Error: ${buildIssueMessage(err.messageData)}\n`));
      process.exit(1);
    }
    throw err;
  }
}

/** The rule named by --aspect, or a refusal naming what exists. */
function resolveAspect(graph: Graph, aspectId: string): AspectDef {
  const aspect = graph.aspects.find((a) => a.id === aspectId);
  if (!aspect) {
    refuse(
      `No rule '${aspectId}' is defined in this graph.`,
      'A verdict is recorded against a rule the graph defines; there is nothing here to judge against.',
      'List the rules with: yg aspects',
    );
  }
  if (aspect.reviewer?.type !== 'llm') {
    const shape = aspect.reviewer?.type === 'aggregate'
      ? 'is a bundle of other rules and produces no verdict of its own'
      : 'runs as a local check';
    refuse(
      `Rule '${aspectId}' is not judged by a reviewer — it ${shape}.`,
      'This channel exists for a rule a judge reads and decides. A rule that runs as code is machine-only: its verdict is whatever running it produces, and a judgement recorded over that would be a claim about code nobody ran.',
      'Run it instead — free, no reviewer and no key: yg check --approve --only-deterministic',
    );
  }
  return aspect;
}

/** Resolve --node/--file into one target, or refuse. */
function resolveTarget(graph: Graph, options: { node?: string; file?: string }): { kind: 'node' | 'file'; path: string } {
  if (options.node && options.file) {
    refuse(
      'Conflicting options.',
      "'--node' and '--file' name two different units; a verdict belongs to exactly one.",
      'Use one or the other, not both.',
    );
  }
  // The command layer's own normalization for a --node value: trim, then drop a
  // trailing slash. Written out rather than routed through a path helper so this
  // command reads exactly like every other one that accepts --node.
  if (options.node) return { kind: 'node', path: options.node.trim().replace(/\/$/, '') };
  if (options.file) {
    const repoRoot = projectRootFromGraph(graph.rootPath);
    return { kind: 'file', path: toPosixPath(resolveFileArg(repoRoot, options.file)) };
  }
  refuse(
    'No unit specified.',
    'A review package and a verdict both belong to one (rule, unit) pair.',
    'Pass --file <path> for a per-file rule, or --node <path> for a whole-component one.',
  );
}

/** The one pending pair the target names, or a refusal explaining which units exist. */
async function resolvePair(
  graph: Graph,
  lock: LockFile,
  aspect: AspectDef,
  target: { kind: 'node' | 'file'; path: string },
): Promise<{ pair: ExpectedPair; state: 'unverified' | 'refused' }> {
  const { pairs } = await computeExpectedPairs(graph);
  const mine = pairs.filter((p) => p.aspectId === aspect.id && p.kind === 'llm');
  const wantedKey = target.kind === 'node' ? `node:${target.path}` : `file:${target.path}`;
  const pair = mine.find((p) => toPosixPath(p.unitKey) === wantedKey);
  if (!pair) {
    const units = mine.map((p) => toPosixPath(p.unitKey)).sort();
    refuse(
      `Rule '${aspect.id}' has no unit ${wantedKey}.`,
      units.length === 0
        ? 'The rule is effective on nothing in this graph, so there is no pair to judge.'
        : 'A verdict is recorded for one (rule, unit) pair, and this rule does not have that unit.',
      units.length === 0
        ? `Check where the rule attaches: yg impact --aspect ${aspect.id}`
        : `Use one of its units: ${units.slice(0, 8).join(', ')}${units.length > 8 ? `, and ${units.length - 8} more` : ''}.`,
    );
  }

  const [verified] = await verifyPairs(graph, lock, [pair]);
  const kind = verified.state.kind;
  if (kind === 'verified') {
    refuse(
      `Rule '${aspect.id}' on ${wantedKey} already holds a verdict for exactly these inputs.`,
      'Nothing is pending here: a verdict in force is re-proved by hashing, and recording a second one over it would replace a judgement that still applies with no evidence that anything changed.',
      'Change the code or the rule so the pair needs judging again, or pick a pair yg check reports as unverified or refused.',
    );
  }
  if (kind !== 'unverified' && kind !== 'refused') {
    const cause = kind === 'prompt-too-large'
      ? 'its review package is over the tier limit'
      : 'its companion hook could not resolve';
    refuse(
      `Rule '${aspect.id}' on ${wantedKey} cannot be assembled for review: ${cause}.`,
      'A judge must be given the same package a configured reviewer would receive. When that package cannot be built, there is nothing to hand over and nothing a verdict could bind to.',
      `See what blocks it: yg check --aspect ${aspect.id}`,
    );
  }
  return { pair, state: kind };
}

/** Assemble the package for a pair, or refuse with the assembly's own guided message. */
async function packageFor(
  graph: Graph,
  projectRoot: string,
  pair: ExpectedPair,
  aspect: AspectDef,
  tierName: string,
): Promise<AssembledReviewPackage> {
  const assembled = await assembleReviewPackage({ graph, projectRoot, pair, aspect, tierName });
  if (assembled.kind !== 'ok') {
    debugWrite(`[verdict] review package could not be assembled: ${assembled.why}`);
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage(assembled.messageData)}\n`));
    process.exit(1);
  }
  return assembled.pkg;
}

/** The tier a rule resolves to, or a refusal — the name is what the hash folds. */
function resolveTierName(graph: Graph, aspect: AspectDef): { name: string; consensus: number; maxPromptChars: number } {
  const reviewer = graph.config.reviewer;
  if (!reviewer) {
    refuse(
      'No reviewer is configured in .yggdrasil/yg-config.yaml.',
      "A review package names the tier its judgement is bound to — the tier's NAME is part of the verdict's identity, so a graph with no tiers has no identity to bind to. The judge itself is not needed: this channel exists precisely so a repository with no key can still record one.",
      'Add a reviewer tier to yg-config.yaml (a name, a provider and a model), then retry.',
    );
  }
  const resolved = selectTierForAspect(aspect, reviewer);
  if (!resolved.ok) {
    process.stderr.write(chalk.red(`Error: ${buildIssueMessage(resolved.error)}\n`));
    process.exit(1);
  }
  return {
    name: resolved.tierName,
    consensus: resolved.tier.consensus,
    maxPromptChars: resolved.tier.max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS,
  };
}

/** Aspect ids whose verdicts belong in the gitignored deterministic file. */
function deterministicAspectIds(graph: Graph): Set<string> {
  const ids = new Set<string>();
  for (const aspect of graph.aspects) {
    if (aspect.reviewer?.type === 'deterministic') ids.add(aspect.id);
  }
  // A verdict whose aspect no longer ships a local check would otherwise migrate
  // out of the gitignored file on this write; keep whatever that file already
  // holds classified where it already is.
  for (const id of readDetLockAspectIds(graph.rootPath)) ids.add(id);
  return ids;
}

export function registerVerdictCommand(program: Command): void {
  const verdict = program
    .command('verdict')
    .description('The external-judge channel: print the review package for one pending pair, record a judgement for it, or list what has been judged that way');

  verdict
    .command('package')
    .description(`Print the exact review package for one pending pair as a ${REVIEW_JSON_SCHEMA} document`)
    .requiredOption('--aspect <id>', 'Rule id (directory path under aspects/)')
    .option('--file <path>', 'Subject file — for a per-file rule')
    .option('--node <path>', 'Component path relative to .yggdrasil/model/ — for a whole-component rule')
    .action(async (options: { aspect: string; file?: string; node?: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = projectRootFromGraph(graph.rootPath);
        const aspect = resolveAspect(graph, options.aspect.trim());
        const target = resolveTarget(graph, options);
        const lock = readLockOrRefuse(graph);
        const { pair, state } = await resolvePair(graph, lock, aspect, target);
        const tier = resolveTierName(graph, aspect);
        const pkg = await packageFor(graph, projectRoot, pair, aspect, tier.name);

        const rulePath = toPosixPath(path.join('.yggdrasil', 'aspects', aspect.id, 'content.md'));
        const subjects: ReviewJsonFile[] = pkg.subjects.map((s) => ({ path: s.path, content: s.bytes.toString('utf8') }));
        const doc: ReviewJsonDocument = {
          schema: REVIEW_JSON_SCHEMA,
          aspect: {
            id: aspect.id,
            name: aspect.name,
            description: aspect.description ?? '',
            kind: 'llm',
            status: pair.status,
          },
          unit: target,
          node: pair.nodePath ?? null,
          state,
          rule: { path: rulePath, content: pkg.promptInput.aspect.content },
          references: pkg.referencesForPrompt.map((r) => ({ path: r.path, description: r.description, content: r.content })),
          companions: pkg.companions.map((c) => ({ path: c.path, content: c.content })),
          subjects,
          tier: {
            name: tier.name,
            consensus: tier.consensus,
            maxPromptChars: tier.maxPromptChars,
            promptChars: pkg.promptChars,
          },
          hashes: { pass: pkg.hashFor('approved'), refused: pkg.hashFor('refused') },
          prompt: buildPairPrompt(pkg.promptInput),
        };
        process.stdout.write(formatReviewJson(doc));
      } catch (error) {
        debugWrite(`[verdict] package failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'assembling the review package');
      }
    });

  verdict
    .command('record')
    .description('Record a judgement for one pending pair under a judge name, bound to the hash the package named')
    .requiredOption('--aspect <id>', 'Rule id (directory path under aspects/)')
    .option('--file <path>', 'Subject file — for a per-file rule')
    .option('--node <path>', 'Component path relative to .yggdrasil/model/ — for a whole-component rule')
    .requiredOption('--by <name>', 'Who judged — recorded with the verdict')
    .requiredOption('--verdict <pass|refused>', 'The judgement')
    .option('--report <text>', 'Violation report — required with a refusal')
    .option('--report-file <path>', 'Read the violation report from a file instead of the command line')
    .requiredOption('--hash <sha256>', 'The hash from the package, for the verdict being recorded')
    .action(async (options: {
      aspect: string; file?: string; node?: string; by: string;
      verdict: string; report?: string; reportFile?: string; hash: string;
    }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const projectRoot = projectRootFromGraph(graph.rootPath);

        const word = options.verdict.trim();
        const token = Object.prototype.hasOwnProperty.call(VERDICT_WORDS, word) ? VERDICT_WORDS[word] : undefined;
        if (token === undefined) {
          refuse(
            `'${word}' is not a verdict.`,
            'A judgement is one of two words: the code satisfies the rule, or it does not.',
            'Use --verdict pass or --verdict refused.',
          );
        }
        const judgeName = options.by.trim();
        if (judgeName === '') {
          refuse(
            'The judge name is empty.',
            'A recorded verdict carries who decided it; an empty name records a judgement nobody is accountable for.',
            'Pass --by <name>.',
          );
        }

        if (options.report !== undefined && options.reportFile !== undefined) {
          refuse(
            'Conflicting options.',
            "'--report' and '--report-file' both supply the violation report; only one of them can be it.",
            'Use one or the other, not both.',
          );
        }
        let report: string | undefined;
        if (options.reportFile !== undefined) {
          try {
            report = await readTextFile(path.resolve(projectRoot, options.reportFile));
          } catch (err) {
            debugWrite(`[verdict] report file unreadable: ${err instanceof Error ? err.message : String(err)}`);
            refuse(
              `The report file '${toPosixPath(options.reportFile)}' could not be read.`,
              'A refusal is only actionable if it says what is wrong; without the report there is nothing for the author to act on.',
              'Point --report-file at a readable file, or pass the report inline with --report.',
            );
          }
        } else if (options.report !== undefined) {
          report = options.report;
        }
        if (token === 'refused' && (report === undefined || report.trim() === '')) {
          refuse(
            'A refusal was recorded with no violation report.',
            'A refusal that does not say what is wrong leaves the author nothing to fix, and leaves the next reader unable to tell a real violation from a mistake.',
            'Pass --report "<what is wrong and where>", or --report-file <path>.',
          );
        }

        const aspect = resolveAspect(graph, options.aspect.trim());
        const target = resolveTarget(graph, options);
        const lock = readLockOrRefuse(graph);
        const { pair } = await resolvePair(graph, lock, aspect, target);
        const tier = resolveTierName(graph, aspect);
        const pkg = await packageFor(graph, projectRoot, pair, aspect, tier.name);

        const expected = pkg.hashFor(token);
        const given = options.hash.trim();
        if (given !== expected) {
          const unitFlag = target.kind === 'node' ? `--node ${target.path}` : `--file ${target.path}`;
          refuse(
            'The hash this verdict is bound to is not the hash of what is on disk now.',
            'A verdict is a judgement about exact content. The rule, the subject files, a reference or a companion has moved since the package was printed, so recording this judgement would attach it to code the judge never saw.',
            `Print the package again and judge what it now contains: yg verdict package --aspect ${aspect.id} ${unitFlag}`,
          );
        }

        const entry: VerdictEntry = {
          verdict: token,
          hash: expected,
          promptChars: pkg.promptChars,
          judge: { name: judgeName, provider: 'external' },
        };
        if (pkg.observations.length > 0) entry.touched = pkg.observations;
        if (token === 'refused') entry.reason = report;

        (lock.verdicts[aspect.id] ??= {})[toPosixPath(pair.unitKey)] = entry;
        await writeLock(graph.rootPath, lock, {
          scope: 'all',
          deterministicAspectIds: deterministicAspectIds(graph),
        });

        process.stdout.write(
          `Recorded: ${aspect.id} on ${toPosixPath(pair.unitKey)} — ${word}, judged by '${judgeName}'.\n` +
            `Bound to ${expected}. yg check re-proves it by hashing; no reviewer and no key are needed.\n`,
        );
      } catch (error) {
        debugWrite(`[verdict] record failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'recording the verdict');
      }
    });

  verdict
    .command('read')
    .description('List the verdicts recorded by a judge outside the configured reviewer, and whether each still holds')
    .option('--by <name>', 'Only this judge')
    .option('--json', `Machine-readable output: one ${VERDICTS_JSON_SCHEMA} document on stdout instead of the listing.`)
    .action(async (options: { by?: string; json?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd());
        initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
        const lock = readLockOrRefuse(graph);

        const recorded: Array<{ aspectId: string; unitKey: string; entry: VerdictEntry }> = [];
        for (const aspectId of Object.keys(lock.verdicts).sort()) {
          for (const unitKey of Object.keys(lock.verdicts[aspectId]).sort()) {
            const entry = lock.verdicts[aspectId][unitKey];
            if (entry.judge === undefined) continue;
            if (options.by !== undefined && entry.judge.name !== options.by.trim()) continue;
            recorded.push({ aspectId, unitKey, entry });
          }
        }

        // Whether a recorded verdict is still IN FORCE is the same question yg
        // check asks: re-derive the pair's hash from the tree and compare.
        // Reusing the project's own pair set means a verdict for a pair that no
        // longer exists reads as not in force, rather than silently as valid.
        const { pairs } = await computeExpectedPairs(graph);
        const verified = await verifyPairs(graph, lock, pairs);
        const inForce = new Set(
          verified
            .filter((vp) => vp.state.kind === 'verified' || vp.state.kind === 'refused')
            .map((vp) => `${vp.pair.aspectId} ${toPosixPath(vp.pair.unitKey)}`),
        );

        const entries: VerdictsJsonEntry[] = recorded.map(({ aspectId, unitKey, entry }) => {
          const isNodeUnit = unitKey.startsWith('node:');
          const row: VerdictsJsonEntry = {
            aspect: aspectId,
            unit: { kind: isNodeUnit ? 'node' : 'file', path: unitKey.slice(unitKey.indexOf(':') + 1) },
            verdict: entry.verdict === 'approved' ? 'pass' : 'refused',
            judge: entry.judge!.name,
            hash: entry.hash,
            inForce: inForce.has(`${aspectId} ${unitKey}`),
          };
          if (entry.reason !== undefined) row.report = entry.reason;
          return row;
        });

        if (options.json === true) {
          const doc: VerdictsJsonDocument = { schema: VERDICTS_JSON_SCHEMA, verdicts: entries };
          process.stdout.write(formatVerdictsJson(doc));
          return;
        }

        if (entries.length === 0) {
          process.stdout.write(
            options.by === undefined
              ? 'No verdict in this graph was recorded by a judge outside the configured reviewer.\n'
              : `No verdict in this graph was recorded by '${options.by.trim()}'.\n`,
          );
          return;
        }
        process.stdout.write(`Recorded by a judge outside the configured reviewer (${entries.length}):\n\n`);
        for (const row of entries) {
          const force = row.inForce ? '' : ' (no longer in force: the inputs moved)';
          process.stdout.write(
            `  ${row.aspect} on ${row.unit.kind}:${row.unit.path}\n` +
              `    ${row.verdict} — judged by '${row.judge}'${force}\n`,
          );
          if (row.report !== undefined) process.stdout.write(`    report: ${row.report}\n`);
        }
      } catch (error) {
        debugWrite(`[verdict] read failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'reading recorded verdicts');
      }
    });
}
