import path from 'node:path';
import { Command } from 'commander';
import chalk from 'chalk';
import { abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { initDebugLog, debugWrite } from '../utils/debug-log.js';
import { appendToDebugLog } from '../io/debug-log-writer.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { loadGraph } from '../core/graph-loader.js';
import { validate } from '../core/validator.js';
import { runFill, FillGatingError } from '../core/fill.js';
import { logAdd } from '../core/log/log-add.js';
import { walkRepoFiles, listGitTrackedFiles } from '../io/repo-scanner.js';
import { detConcurrencyForThisMachine } from './det-concurrency.js';
import { ensureGitattributes, ensureYggdrasilGitignore } from './init-scaffold.js';
import { readRulesArtifacts } from './rules-artifacts.js';
import type { Graph } from '../model/graph.js';
import {
  GRAPH_DIR,
  countRulesByStatus,
  describeExistingGraph,
  graphDirExists,
  installGraph,
  looksLikeGraph,
  readExistingViolations,
  readProvenance,
  resolveProposal,
  rootComponentPath,
  type ExistingViolations,
  type ProposalProvenance,
} from './adopt-transaction.js';

/**
 * `yg adopt <proposal-dir>` — the acceptance transaction.
 *
 * A repository does not drift into being governed; someone decides it is. Until
 * now there was no way to record that decision: a proposed graph was moved into
 * place by hand, nothing checked that it would even load, nothing baselined the
 * free verdicts, nothing said how much of the code already here the new rules
 * refuse, and nothing anywhere carried WHO accepted WHAT. This command is that
 * missing signature — one step that either accepts a whole graph or leaves the
 * repository exactly as it found it.
 */

/**
 * The blocking findings that cannot honestly be answered while the proposed
 * graph still sits in a staging directory. Every one of them is about the FILES
 * a graph names, and those files live in the repository, not beside the
 * proposal — so asking here would refuse every proposal ever written, for a
 * reason that says nothing about the proposal.
 *
 * They are DEFERRED, never skipped: each runs in full the moment the graph is
 * in place, and a failure there rolls the whole acceptance back. Being generous
 * with this list is therefore safe in the one direction that matters — it can
 * delay a refusal, never lose one.
 */
const DEFERRED_UNTIL_IN_PLACE = new Set<string>([
  'mapping-path-missing',
  'mapping-escapes-repo',
  'file-mapping-gitignored',
  'file-mapping-excluded',
  'file-duplicate-mapping',
  'file-unreadable',
  'overlapping-mapping',
  'aspect-reference-broken',
  'type-when-mismatch',
  'type-strict-orphan',
  'type-strict-misplaced',
  'strict-overlap-conflict',
  'high-fan-out',
]);

/** One `Label  value` line of the summary, aligned so the report reads as a table. */
function row(label: string, value: string): string {
  return `  ${label.padEnd(16)}${value}`;
}

/** `N thing` / `N things` — the plural rule every count in this report goes through. */
function count(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** What the proposal says about its own origin, or a plain statement that it says nothing. */
function describeOrigin(provenance: ProposalProvenance | undefined): string {
  if (provenance === undefined) return 'hand-written — the proposal records no origin of its own';
  const parts: string[] = [provenance.mined ? 'mined from this repository by Grain' : 'generated'];
  if (provenance.schema !== undefined) parts.push(`(${provenance.schema})`);
  if (provenance.asOf !== undefined) parts.push(`taken at ${provenance.asOf.slice(0, 12)}`);
  if (provenance.files !== undefined) parts.push(`over ${count(provenance.files, 'file')}`);
  return parts.join(' ');
}

/** The already-broken block: how much of the code that is already here the new rules refuse today. */
function describeExistingViolations(violations: ExistingViolations): string[] {
  if (violations.measured === 0) {
    return [row('Already broken', 'not measured — this proposal records no per-rule count')];
  }
  if (violations.total === 0) {
    return [row('Already broken', `nothing — every measured rule holds across all ${count(violations.measured, 'rule')} today`)];
  }
  const lines = [
    row('Already broken', `${count(violations.total, 'site')} the new rules refuse in the code that is already here`),
  ];
  for (const entry of violations.byAspect.slice(0, 8)) {
    lines.push(`${' '.repeat(18)}${entry.aspectId}  ${entry.count}`);
  }
  if (violations.byAspect.length > 8) {
    lines.push(`${' '.repeat(18)}... and ${violations.byAspect.length - 8} more rules`);
  }
  return lines;
}

/** Whether a rule blocks the build on day one, or only warns until a change reaches it. */
function describeBlocking(graph: Graph): string {
  const reference = graph.config.progressive?.reference;
  return reference === undefined
    ? 'every rule blocks everywhere from the first run — nothing measures changes against a branch'
    : `only what a change reaches, measured against '${reference}'; everything else is reported as a warning`;
}

/** The graph half of the report, shared by the preview and the real acceptance. */
function graphRows(graph: Graph, provenance: ProposalProvenance | undefined, violations: ExistingViolations): string[] {
  const rules = countRulesByStatus(graph);
  return [
    row('Graph', `${count(graph.nodes.size, 'component')} · ${count(graph.aspects.length, 'rule')} (${rules.enforced} enforced, ${rules.advisory} advisory, ${rules.draft} draft) · ${count(graph.flows.length, 'flow')}`),
    row('Origin', describeOrigin(provenance)),
    ...describeExistingViolations(violations),
    row('Blocks on', describeBlocking(graph)),
  ];
}

/** The prose an acceptance is recorded as, in the component log. Self-contained by construction. */
function acceptanceEntry(graph: Graph, provenance: ProposalProvenance | undefined): string {
  const rules = countRulesByStatus(graph);
  const origin = provenance?.mined === true
    ? 'It was mined from this repository\'s own code and history by Grain'
    : 'It was written outside this repository and brought in whole';
  const taken = provenance?.asOf !== undefined ? `, from the state of the code at ${provenance.asOf}` : '';
  return [
    `This repository's architecture graph was accepted as a whole on this date: ${count(graph.nodes.size, 'component')} and ${count(graph.aspects.length, 'rule')} — ${rules.enforced} enforced, ${rules.advisory} advisory, ${rules.draft} still draft. ${origin}${taken}, so every rule in it describes how this code is already usually written rather than a standard imported from elsewhere.`,
    '',
    'What that means for anyone reading this later: the rules were not authored one at a time as the code grew, and they were not chosen individually. They arrived together, in one decision, and the enforced ones earned that status from measured practice rather than from a check that the repository is clean today. A rule here can therefore refuse code that predates it, and that is expected rather than a defect — the count of such places was known and accepted at this moment. A rule that turns out to describe an accident rather than an intention should be removed or demoted rather than worked around, and doing so is a smaller decision than this one was.',
  ].join('\n');
}

export function registerAdoptCommand(program: Command): void {
  program
    .command('adopt')
    .argument('<proposal-dir>', 'Directory holding the proposed graph — a staging directory containing .yggdrasil/, or that directory itself')
    .description('Accept a proposed architecture graph into this repository, baseline it, and record who accepted what')
    .option('--replace', 'Accept over a graph this repository already has. The existing one is moved aside, never deleted.')
    .option('--dry-run', 'Report everything the acceptance would do and change nothing.')
    .action(async (proposalDir: string, opts: { replace?: boolean; dryRun?: boolean }) => {
      try {
        const repoRoot = process.cwd();
        const dryRun = opts.dryRun === true;

        // ── The proposal itself ────────────────────────────────────────────
        const proposal = await resolveProposal(proposalDir);
        if (proposal === null || !(await looksLikeGraph(proposal.graphDir))) {
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `'${proposalDir}' does not hold a proposed graph.`,
            why: `A proposal is a directory containing a ${GRAPH_DIR}/ tree with a yg-config.yaml and a yg-architecture.yaml in it — the staging directory a generator writes, or that inner directory on its own. Nothing of that shape is at this path, and guessing further would risk accepting something that is not a graph at all.`,
            next: `Pass the directory a generator wrote (Grain writes ${GRAPH_DIR}-proposal/ at the repository root by default), or the ${GRAPH_DIR}/ directory inside it.`,
          })}\n`));
          await exitAfterFlush(1);
          return;
        }

        // ── Never merge silently over a graph that is already here ─────────
        const destination = path.join(repoRoot, GRAPH_DIR);
        const hasExisting = await graphDirExists(destination);
        if (hasExisting && opts.replace !== true) {
          const existing = await describeExistingGraph(destination);
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `This repository already has a graph: ${count(existing.components, 'component')}, ${count(existing.rules, 'rule')}, ${count(existing.flows, 'flow')}${existing.hasRecordedVerdicts ? ', with verdicts already recorded against it' : ''}.`,
            why: 'Accepting a proposal REPLACES the whole graph; the two are never merged, because a rule taken from one graph and a component taken from another have never been checked against each other and the result would be a body of law nobody wrote. Doing that silently would discard work with no record that it happened.',
            next: `Re-run with --replace to accept over it — the existing graph is moved aside under ${GRAPH_DIR}.replaced-<timestamp>/ and nothing is deleted. To compare first, run: yg adopt ${proposalDir} --dry-run`,
          })}\n`));
          await exitAfterFlush(1);
          return;
        }

        // ── Does it load, with the same loader `yg check` uses? ────────────
        let proposed: Graph;
        try {
          proposed = await loadGraph(proposal.root);
        } catch (err) {
          debugWrite(`[adopt] proposal failed to load: ${err instanceof Error ? err.message : String(err)}`);
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `The proposed graph could not be read: ${err instanceof Error ? err.message : String(err)}`,
            why: 'A graph that does not load cannot be checked against anything, so accepting it would leave this repository with a gate that refuses every run for a reason no rule is responsible for. The same reader that would run on every check was used here, so this is exactly what would have happened afterwards.',
            next: 'Fix the proposal at its source and regenerate it, or repair the file the message names, then run yg adopt again.',
          })}\n`));
          await exitAfterFlush(1);
          return;
        }

        // ── Does it hold together? ─────────────────────────────────────────
        const preflight = await validate(proposed, 'all');
        const blocking = preflight.issues.filter(
          (i) => i.severity === 'error' && !DEFERRED_UNTIL_IN_PLACE.has(i.code ?? ''),
        );
        if (blocking.length > 0) {
          const codes = [...new Set(blocking.map((i) => i.code ?? 'unknown'))].sort();
          const detail = blocking
            .slice(0, 10)
            .map((i) => `  ${i.code ?? ''} ${i.nodePath ?? ''} ${buildIssueMessage(i.messageData).split('\n')[0]}`)
            .join('\n');
          process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
            what: `The proposed graph does not hold together — ${count(blocking.length, 'blocking problem')} across ${count(codes.length, 'kind')}: ${codes.join(', ')}.\n${detail}${blocking.length > 10 ? `\n  ... and ${blocking.length - 10} more` : ''}`,
            why: 'These are the same problems that block every check, and they are about the graph itself rather than about any code. Accepting it would hand this repository a gate that is red before a single line is written, so nothing was moved.',
            next: 'Fix them where the proposal is generated and produce it again, then run yg adopt on the new one.',
          })}\n`));
          await exitAfterFlush(1);
          return;
        }

        const provenance = await readProvenance(proposal);
        const violations = await readExistingViolations(proposal.graphDir);

        // ── A preview writes nothing at all ────────────────────────────────
        if (dryRun) {
          const lines = [
            chalk.green(`yg adopt: would accept  ${proposalDir} → ${GRAPH_DIR}/`),
            '',
            ...graphRows(proposed, provenance, violations),
            row('Baseline', 'every rule that runs locally would be recorded now, at no cost and with no key'),
            row('Recorded as', `an entry in the log of '${rootComponentPath(proposed) ?? '(no component to record it against)'}'`),
          ];
          if (hasExisting) {
            lines.push(row('Existing graph', `moved aside under ${GRAPH_DIR}.replaced-<timestamp>/, never deleted`));
          }
          lines.push('', 'Nothing was written. Re-run without --dry-run to accept.', '');
          process.stdout.write(lines.join('\n'));
          await exitAfterFlush(0);
          return;
        }

        // ── Move it into place, as one transaction ─────────────────────────
        const transaction = await installGraph(repoRoot, proposal, () => new Date());
        let graph: Graph;
        try {
          graph = await loadGraph(repoRoot, { tolerateInvalidConfig: true });
          initDebugLog(graph.rootPath, graph.config.debug ?? false, appendToDebugLog);
          const inPlace = await validate(graph, 'all');
          const stillBlocking = inPlace.issues.filter((i) => i.severity === 'error');
          if (stillBlocking.length > 0) {
            await transaction.rollback();
            const codes = [...new Set(stillBlocking.map((i) => i.code ?? 'unknown'))].sort();
            const detail = stillBlocking
              .slice(0, 10)
              .map((i) => `  ${i.code ?? ''} ${i.nodePath ?? ''} ${buildIssueMessage(i.messageData).split('\n')[0]}`)
              .join('\n');
            process.stderr.write(chalk.red(`Error: ${buildIssueMessage({
              what: `In this repository the proposed graph does not hold together — ${count(stillBlocking.length, 'blocking problem')} across ${count(codes.length, 'kind')}: ${codes.join(', ')}.\n${detail}${stillBlocking.length > 10 ? `\n  ... and ${stillBlocking.length - 10} more` : ''}`,
              why: 'The graph reads correctly on its own but does not fit the code it was handed: these problems are about files it names and cannot find, or references it cannot resolve here. A gate in that state refuses every run for a reason no rule owns. Nothing was kept — the repository is exactly as it was.',
              next: 'Regenerate the proposal against this repository at its current state, then run yg adopt on the new one.',
            })}\n`));
            await exitAfterFlush(1);
            return;
          }
        } catch (err) {
          await transaction.rollback();
          throw err;
        }

        // ── Make the graph's own local state ignorable ─────────────────────
        // A proposal ships the committed graph and nothing else, so without this
        // the very first check writes its local verdict cache into a repository
        // that has never been told to ignore it — the acceptance would hand
        // someone an untracked file to wonder about. Both are idempotent and
        // both are exactly what a fresh setup writes.
        await ensureYggdrasilGitignore(graph.rootPath);
        await ensureGitattributes(repoRoot);

        // ── Record who accepted what ───────────────────────────────────────
        // Written BEFORE the baseline run, so the same run that records the
        // verdicts also records this entry as the log's starting point. Written
        // after, it would sit past the baseline the graph was closed over on its
        // very first day.
        const componentPath = rootComponentPath(graph);
        let recordedAs: string;
        if (componentPath === undefined) {
          recordedAs = 'nowhere — this graph declares no component to record it against';
        } else {
          const entry = await logAdd({
            graph,
            nodePath: componentPath,
            reasonText: acceptanceEntry(graph, provenance),
            nowMs: Date.now(),
          });
          recordedAs = entry.ok
            ? `an entry in the log of '${componentPath}'`
            : `not recorded — ${entry.error.what}`;
        }

        // ── Baseline every verdict that costs nothing ──────────────────────
        const projectRoot = path.dirname(graph.rootPath);
        const repoFiles = await walkRepoFiles(projectRoot);
        let recorded: string;
        try {
          const fill = await runFill(graph, {
            coverageVisibleFiles: repoFiles,
            trackedFiles: listGitTrackedFiles(projectRoot),
            onlyDeterministic: true,
            reviewNowUtc: () => new Date(),
            rulesArtifacts: await readRulesArtifacts(projectRoot),
            detConcurrency: detConcurrencyForThisMachine(),
            write: () => {},
            isTTY: false,
            // Whatever the baseline run has to say about this graph goes to the
            // error stream, so the summary on stdout stays one clean report.
            emitIssue: (m) => { process.stderr.write(`${buildIssueMessage(m)}\n`); },
          });
          const result = fill.checkResult;
          // A refusal IS a recorded verdict — it is cached and re-rendered like
          // any other — so counting only the satisfied ones would understate
          // what the baseline actually captured, and would read as a smaller
          // number than the "already broken" line right above it. This run
          // answers for the whole project and passes no change scope, so no
          // finding here can be an outside twin.
          const refused = result.issues.filter(
            (i) => i.pairKind === 'deterministic'
              && (i.code === 'aspect-violation-enforced' || i.code === 'aspect-violation-advisory'),
          ).length;
          const tail = refused > 0 ? ` — ${refused} of ${refused === 1 ? 'them a refusal' : 'them refusals'}` : '';
          recorded = `${count(result.verifiedDet + refused, 'verdict')} recorded locally, at no cost and with no key${tail}`;
        } catch (err) {
          if (!(err instanceof FillGatingError)) {
            await transaction.rollback();
            throw err;
          }
          // The graph is sound and stays accepted — it simply asks for something
          // of the person before it will record anything. Saying so beats
          // undoing an acceptance that was never the problem.
          debugWrite(`[adopt] baseline withheld by the fill gate: ${err.message}`);
          recorded = 'none yet — this graph asks for a written justification per component before it records anything; each one is named on the error stream';
        }

        const summary = [
          chalk.green(`yg adopt: accepted  ${proposalDir} → ${GRAPH_DIR}/`),
          '',
          ...graphRows(graph, provenance, violations),
          row('Baseline', recorded),
          row('Recorded as', recordedAs),
        ];
        if (transaction.movedAsideTo !== undefined) {
          summary.push(row('Previous graph', `kept at ${path.basename(transaction.movedAsideTo)}/ — delete it once you are satisfied`));
        }
        summary.push('', 'Next: yg check', '');
        process.stdout.write(summary.join('\n'));
        await exitAfterFlush(0);
      } catch (error) {
        debugWrite(`[adopt] acceptance failed: ${error instanceof Error ? error.message : String(error)}`);
        abortOnUnexpectedError(error, 'accepting a proposed graph');
      }
    });
}
