import type { Command } from 'commander';
import chalk from 'chalk';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { buildNominations, type Nomination } from '../core/advise-nominations.js';
import { appendDecision, type AdviseDecision } from '../io/advise-decisions-store.js';
import { isValidReviewByDate } from '../io/aspect-parser.js';
import type { Graph } from '../model/graph.js';

function handleError(error: unknown): never {
  debugWrite(`[advise] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running advise command');
}

/** Emit a blocking what/why/next error to stderr and exit(1) — nothing is written. */
function failWith(msg: { what: string; why: string; next: string }): never {
  process.stderr.write(chalk.red(buildIssueMessage(msg)) + '\n');
  process.exit(1);
}

/**
 * Resolve an attention-item id against the current LIVE nominations, or fail with
 * a what/why/next error that names the known ids. Resolving at ack time captures
 * the nomination's CURRENT evidence snapshot, so the decision binds to exactly the
 * evidence the item carries now.
 */
function resolveNominationOrFail(graph: Graph, id: string, todayUtc: Date): Nomination {
  const noms = buildNominations(graph, { todayUtc });
  const nomination = noms.find((n) => n.id === id);
  if (nomination === undefined) {
    const knownIds = noms.map((n) => n.id);
    failWith({
      what: `No current attention item has id '${id}'.`,
      why:
        knownIds.length > 0
          ? 'A dismiss or defer must name a live attention item, but this id matches none of the current items.'
          : 'There are no current attention items, so there is nothing to dismiss or defer.',
      next:
        knownIds.length > 0
          ? `Name one of the current ids: ${knownIds.join(', ')}.`
          : "Run 'yg check' to see the current state — no item needs acting on right now.",
    });
  }
  return nomination;
}

/** Reject an empty (or whitespace-only) reason before anything is written. */
function requireNonEmptyReason(reason: string, action: 'dismiss' | 'defer'): void {
  if (reason.trim() !== '') return;
  failWith({
    what: `A ${action} needs a non-empty --reason.`,
    why: 'Each recorded decision is committed precedent, so it must carry a human-signed justification; an empty reason records nothing meaningful.',
    next: `Re-run with --reason "<why you are choosing to ${action} this item>".`,
  });
}

/** Append one decision to the committed register and print a success line. */
async function recordDecision(
  graph: Graph,
  decision: AdviseDecision,
  summary: string,
): Promise<void> {
  await appendDecision(graph.rootPath, decision);
  process.stdout.write(chalk.green(`${summary}\n`));
}

export function registerAdviseCommand(program: Command): void {
  const advise = program
    .command('advise')
    .description('Act on the current attention items — dismiss or defer them with a signed reason');

  advise
    .command('dismiss')
    .description('Dismiss an attention item (hidden until its underlying evidence changes)')
    .argument('<id>', 'Attention-item id to dismiss')
    .requiredOption('--reason <text>', 'Human-signed justification (mandatory)')
    .action(async (id: string, opts: { reason: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        requireNonEmptyReason(opts.reason, 'dismiss');
        const now = new Date();
        const nomination = resolveNominationOrFail(graph, id, now);
        const decision: AdviseDecision = {
          v: 1,
          ts: now.toISOString(),
          id: nomination.id,
          action: 'dismiss',
          evidenceHash: nomination.evidenceHash,
          reason: opts.reason,
        };
        await recordDecision(
          graph,
          decision,
          `Dismissed '${nomination.id}'. It stays hidden until its underlying evidence changes.`,
        );
      } catch (error) {
        handleError(error);
      }
    });

  advise
    .command('defer')
    .description('Defer an attention item until a date, then it returns to the feed')
    .argument('<id>', 'Attention-item id to defer')
    .requiredOption('--until <date>', 'Bare ISO date (YYYY-MM-DD) to hide the item until')
    .requiredOption('--reason <text>', 'Human-signed justification (mandatory)')
    .action(async (id: string, opts: { until: string; reason: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        requireNonEmptyReason(opts.reason, 'defer');
        if (!isValidReviewByDate(opts.until)) {
          failWith({
            what: `--until '${opts.until}' is not a valid calendar date.`,
            why: 'A defer window is a bare ISO calendar day (YYYY-MM-DD); a mis-shaped or impossible date has no defined return point.',
            next: 'Re-run with --until in YYYY-MM-DD form, e.g. --until 2027-01-31.',
          });
        }
        const now = new Date();
        const nomination = resolveNominationOrFail(graph, id, now);
        const decision: AdviseDecision = {
          v: 1,
          ts: now.toISOString(),
          id: nomination.id,
          action: 'defer',
          evidenceHash: nomination.evidenceHash,
          until: opts.until,
          reason: opts.reason,
        };
        await recordDecision(
          graph,
          decision,
          `Deferred '${nomination.id}' until ${opts.until}. It returns to the feed on or after that date.`,
        );
      } catch (error) {
        handleError(error);
      }
    });
}
