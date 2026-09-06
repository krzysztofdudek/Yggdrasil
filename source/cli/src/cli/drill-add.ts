import type { Command } from 'commander';
import chalk from 'chalk';
import path from 'node:path';

import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { exitAfterFlush } from './exit-after-flush.js';
import { buildDrillRun } from './drill.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { readFileAtCommit } from '../utils/git-introspect.js';
import { toPosixPath } from '../utils/posix.js';
import {
  caseLabelFor,
  caseLogEntry,
  duplicateOf,
  parseCaseSpec,
} from '../core/drill-add.js';
import { discoverDrillCases, runDrills } from '../core/drill-runner.js';
import {
  readCorpusFiles,
  removeCorpusCase,
  writeCorpusCase,
} from '../io/drill-corpus-store.js';
import { appendAspectLogEntry } from '../core/log/aspect-log.js';
import type { AspectDef, Graph } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';

/**
 * `yg drill add` — take a file as it stood at a named commit into a rule's case
 * corpus, then immediately run the rule over it and say whether it catches it.
 *
 * The doctrine this serves: production is the corpus. The most valuable case a
 * rule can hold is the code that actually got past it, and the moment worth
 * capturing it is the moment somebody finds it. So the command does the whole
 * act in one step — read the code out of history, file it under the corpus's own
 * convention with its origin in the name, measure the rule against it, and
 * record what happened in the rule's log.
 *
 * A rule that does NOT catch its own escape is reported as exactly that, with a
 * non-zero exit, AND THE CASE STAYS. That is not a failure of the command: a
 * corpus that only ever accepts cases a rule already passes is a corpus that can
 * never tell anybody anything. The case sits there, red, until the rule is
 * sharpened enough to catch it.
 *
 * Nothing is written when the file is not there at that commit, when the same
 * bytes are already a case, or when the rule cannot be exercised at all — and a
 * case that turns out to be unmeasurable is taken back out, because an
 * unmeasurable fixture in a corpus is worse than no fixture.
 */
export function registerDrillAddCommand(drill: Command): void {
  drill
    .command('add')
    .description(
      "Take a file as it stood at a commit into a rule's case corpus, run the rule over it, and report whether the rule catches it",
    )
    .requiredOption('--aspect <id>', 'aspect id whose case corpus the case joins')
    .requiredOption(
      '--violates <path@commit>',
      'file at a commit the rule MUST refuse (the code that got past it)',
    )
    .option(
      '--satisfies <path@commit>',
      'file at a commit the rule MUST pass, added alongside (e.g. the fix)',
    )
    .option('--why <text>', 'why this case belongs in the corpus (recorded in the rule\'s log)')
    .action(async (opts: { aspect: string; violates: string; satisfies?: string; why?: string }) => {
      const projectRoot = process.cwd();
      try {
        const graph = await loadGraphOrAbort(projectRoot);

        const aspect = resolveAspect(graph, opts.aspect);
        if ('error' in aspect) failWith(aspect.error);

        const why = typeof opts.why === 'string' && opts.why.trim() !== '' ? opts.why.trim() : null;

        // Both specs are parsed and read BEFORE anything is written, so a
        // mistake in the second one cannot leave the first one half-added.
        const wanted: Array<{ expect: 'violates' | 'satisfies'; spec: string }> = [
          { expect: 'violates', spec: opts.violates },
        ];
        if (typeof opts.satisfies === 'string') {
          wanted.push({ expect: 'satisfies', spec: opts.satisfies });
        }

        const corpus = await readCorpusFiles(graph.rootPath, aspect.def.id);
        const planned: Array<{
          expect: 'violates' | 'satisfies';
          caseLabel: string;
          filePath: string;
          filename: string;
          content: string;
          commitSha: string;
          commitDay: string;
        }> = [];

        for (const { expect, spec } of wanted) {
          const flag = `--${expect}`;
          const parsed = parseCaseSpec(spec, flag);
          if (!parsed.ok) failWith(parsed.error);

          const at = await readFileAtCommit(projectRoot, parsed.ref, parsed.filePath);
          if (at.kind === 'no-such-commit') {
            failWith({
              what: `${flag}: this repository has no commit '${parsed.ref}'.`,
              why: 'The case is the code as it really stood somewhere in this history; a commit the repository does not have names no such code.',
              next: 'Check the commit with git log, then re-run with a commit this repository contains. A shallow clone may simply not have it yet.',
            });
          }
          if (at.kind === 'not-at-commit') {
            failWith({
              what: `${flag}: '${toPosixPath(parsed.filePath)}' is not in commit ${parsed.ref}.`,
              why: 'A case is taken from the file as it stood at that commit. If the path was not there — not yet added, already deleted, or renamed since — there is nothing to take, and adding anything else would put code in the corpus that never existed at the commit it claims.',
              next: 'Check the path at that commit with git ls-tree, then re-run with the path as it was named there.',
            });
          }
          if (at.content.trim() === '') {
            failWith({
              what: `${flag}: '${toPosixPath(parsed.filePath)}' is empty at commit ${at.commitSha.slice(0, 7)}.`,
              why: 'An empty case measures nothing: every rule passes it, so it can never catch a regression and only inflates the corpus count people read as coverage.',
              next: 'Pick the commit where the file actually carried the code in question.',
            });
          }
          if (at.content.includes(String.fromCharCode(0))) {
            failWith({
              what: `${flag}: '${toPosixPath(parsed.filePath)}' is not text at commit ${at.commitSha.slice(0, 7)}.`,
              why: 'A case is source a rule reads; binary content cannot be reviewed by either kind of rule and would sit in the corpus permanently unrunnable.',
              next: 'Add a source file instead.',
            });
          }

          const already = duplicateOf(at.content, corpus);
          if (already !== null) {
            failWith({
              what: `${flag}: this exact content is already the case '${already.caseLabel}'.`,
              why: "Two copies of one case measure nothing new — the rule's behaviour on those bytes is already recorded — while the corpus count, which people read as coverage, goes up.",
              next: `Run yg drill --aspect ${aspect.def.id} --case '${already.caseLabel}/**' to see what that case already reports, or add the code from a different commit where it genuinely differs.`,
            });
          }

          const filename = path.posix.basename(toPosixPath(parsed.filePath));
          planned.push({
            expect,
            caseLabel: caseLabelFor({
              expect,
              filePath: toPosixPath(parsed.filePath),
              commitDate: at.commitDay,
              commitSha: at.commitSha,
            }),
            filePath: toPosixPath(parsed.filePath),
            filename,
            content: at.content,
            commitSha: at.commitSha,
            commitDay: at.commitDay,
          });
        }

        // Two specs that resolve to the same case name would overwrite each
        // other, so they are one case, not two.
        if (planned.length === 2 && planned[0].caseLabel === planned[1].caseLabel) {
          failWith({
            what: `--violates and --satisfies name the same case, '${planned[0].caseLabel}'.`,
            why: 'The case name is the file, the day and the commit it came from. Two specs that agree on all three are one piece of code, and one piece of code cannot be both what the rule must refuse and what it must pass.',
            next: 'Give the two flags different files or different commits, or add just one of them.',
          });
        }

        for (const plan of planned) {
          await writeCorpusCase(
            graph.rootPath,
            aspect.def.id,
            plan.caseLabel,
            plan.filename,
            plan.content,
          );
          process.stdout.write(
            `Added ${plan.caseLabel} from ${plan.filePath} at ${plan.commitSha.slice(0, 7)} (${plan.commitDay}).\n`,
          );
        }

        // Measure the new cases under EXACTLY the conditions the whole corpus is
        // measured under — same wiring, same sidecar, same telemetry.
        const labels = new Set(planned.map((p) => p.caseLabel));
        const cases = (
          await discoverDrillCases({ aspectId: aspect.def.id, projectRoot })
        ).filter((c) => labels.has(c.caseLabel.split('/')[0]));

        const setup = await buildDrillRun(graph, aspect.def, projectRoot, false);
        if (!setup.ok) {
          await undo(graph, aspect.def, planned);
          failWith(setup.error);
        }

        const summary = await runDrills(aspect.def, projectRoot, cases, setup.ctx, setup.deps);

        const unmeasured = summary.results.filter(
          (r) => r.got === 'unrun' || r.got === 'unsupported',
        );
        if (unmeasured.length > 0) {
          await undo(graph, aspect.def, planned);
          failWith({
            what: `The rule '${aspect.def.id}' could not be run over the case.`,
            why: 'A rule that reads the whole graph, or one whose reviewer is unavailable, cannot be exercised over case files alone — so nothing was measured. A case nobody can measure would sit in the corpus forever, never passing and never failing.',
            next: `Run yg drill --aspect ${aspect.def.id} to see the same limit across the corpus. Nothing was added.`,
          });
        }

        const now = Date.now();
        for (const plan of planned) {
          const result = summary.results.find((r) => r.case.caseLabel.split('/')[0] === plan.caseLabel);
          const caught = result?.got === 'refused';
          const entry = await appendAspectLogEntry({
            yggRootPath: graph.rootPath,
            aspectId: aspect.def.id,
            reasonText: caseLogEntry({
              caseLabel: plan.caseLabel,
              filePath: plan.filePath,
              commitSha: plan.commitSha,
              commitDate: plan.commitDay,
              expect: plan.expect,
              caught,
              why,
            }),
            nowMs: now,
          });
          if (!entry.ok) failWith(entry.error);
        }

        const missed = summary.results.filter((r) => r.outcome === 'miss' || r.outcome === 'false-alarm');
        if (missed.length > 0) {
          const first = missed[0];
          process.stderr.write(
            `Error: ${buildIssueMessage({
              what: `The rule '${aspect.def.id}' does not catch '${first.case.caseLabel}': it expected ${first.case.expect} and got ${first.got}.`,
              why: 'This is real code that the rule let through. The case is now in the corpus and stays there — that is the point of adding it — and it will keep failing until the rule is sharpened enough to catch it.',
              next: `Sharpen the rule in .yggdrasil/aspects/${aspect.def.id}/, then re-run yg drill --aspect ${aspect.def.id}. Changing an LLM rule's text re-reviews every place it applies; check yg impact --aspect ${aspect.def.id} first.`,
            })}\n`,
          );
          await exitAfterFlush(1);
          return;
        }

        process.stdout.write(
          chalk.green(
            `The rule '${aspect.def.id}' behaves as expected on ${planned.length === 1 ? 'the new case' : 'both new cases'}. Recorded in the rule's log.\n`,
          ),
        );
      } catch (e: unknown) {
        debugWrite(`[drill add] failed: ${e instanceof Error ? e.message : String(e)}`);
        abortOnUnexpectedError(e, 'adding a drill case');
      }
    });
}

/** Print a what / why / next block on stderr and exit non-zero. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

/** Resolve the rule the case is for, or the reason it cannot be resolved. */
function resolveAspect(graph: Graph, id: string): { def: AspectDef } | { error: IssueMessage } {
  const def = graph.aspects.find((a) => a.id === id);
  if (def === undefined) {
    return {
      error: {
        what: `No rule '${id}' in this graph.`,
        why: 'A case belongs to the rule it exercises, so the rule has to exist before code can be filed under it.',
        next: 'List the rules with yg aspects, then re-run with --aspect <id>.',
      },
    };
  }
  if (def.reviewer.type === 'aggregate') {
    return {
      error: {
        what: `The rule '${id}' only bundles other rules, so it has nothing to run over a case.`,
        why: 'An aggregate carries no rule source of its own — no check and no prose — so a case filed under it could never be judged.',
        next: `Add the case to one of the rules it bundles instead: ${(def.implies ?? []).join(', ') || 'see yg aspects'}.`,
      },
    };
  }
  return { def };
}

/** Take back out every case this run just wrote. */
async function undo(
  graph: Graph,
  aspect: AspectDef,
  planned: ReadonlyArray<{ caseLabel: string }>,
): Promise<void> {
  for (const plan of planned) {
    await removeCorpusCase(graph.rootPath, aspect.id, plan.caseLabel);
  }
}
