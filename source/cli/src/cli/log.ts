import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { findOwnerWithinOwnGraph } from './owner.js';
import { debugWrite } from '../utils/debug-log.js';
import { logAdd } from '../core/log/log-add.js';
import { logRead } from '../core/log/log-read.js';
import { logMergeResolve, OPERATION_COMMANDS } from '../core/log/log-merge-resolve.js';
import { projectRootFromGraph } from '../io/paths.js';
import { readVerdictEvents } from '../io/events-reader.js';
import type { VerdictEvent } from '../io/events-store.js';
import type { Graph } from '../model/graph.js';
import { fail } from './output.js';

/**
 * True when `filePath` (a `file:` unit-key path) is REALLY owned by `nodePath` —
 * the same hierarchy-first, exclusion-aware answer `yg owner --file` gives, not a
 * raw textual "does this appear inside one of the node's mapping entries" check.
 * A directory-mapping ancestor's mapping entry textually contains every path
 * under a descendant node's own, more specific mapping too, and textual
 * containment has no idea a path is excluded — either one would misattribute a
 * verdict event to a node the graph does not actually consider its owner.
 */
async function verdictBelongsToNode(graph: Graph, projectRoot: string, filePath: string, nodePath: string): Promise<boolean> {
  const owner = await findOwnerWithinOwnGraph(graph, projectRoot, filePath);
  return owner.nodePath === nodePath;
}

/** One-line render of a fill verdict event for the interleaved --with-verdicts view. */
function renderVerdictEvent(event: VerdictEvent): string {
  let line = `  · [${event.ts}] ${event.disposition} — ${event.aspectId} on ${event.unitKey} [${event.kind}]`;
  if (event.disposition === 'refused' && typeof event.reason === 'string' && event.reason.length > 0) {
    line += `\n      ↳ ${event.reason.split('\n')[0]}`;
  }
  return chalk.dim(line) + '\n';
}

function handleError(error: unknown): never {
  debugWrite(`[log] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running log command');
}

/** Schema id of `yg log read --json`. */
export const LOG_JSON_SCHEMA = 'yg-log/1';

/**
 * `yg log read --json`: the node's entries, newest first, each with its
 * timestamp and body; with --with-verdicts also the fill events attributed to
 * the node, and whether that telemetry is local or shared.
 */
function writeLogJson(
  node: string,
  entries: Array<{ datetime: string; body: string }>,
  verdicts?: { events: VerdictEvent[]; gitTracked: boolean; since: string | null },
): void {
  const doc = {
    schema: LOG_JSON_SCHEMA,
    node,
    entries: entries.map((e) => ({ datetime: e.datetime, body: e.body })),
    ...(verdicts !== undefined
      ? { verdictEvents: { since: verdicts.since, sharedHistory: verdicts.gitTracked, events: verdicts.events } }
      : {}),
  };
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

export function registerLogCommand(program: Command): void {
  const log = program
    .command('log')
    .description('Per-node business log (append-only history of decisions and reasoning)');

  log
    .command('add')
    .description('Append a log entry to a node')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/, no model/ prefix)')
    .option('--reason <text>', 'Justification text (one of --reason or --reason-file required)')
    .option('--reason-file <path>', 'Read justification from a file (alternative to --reason)')
    .action(async (opts: { node: string; reason?: string; reasonFile?: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });

        if ((opts.reason !== undefined) === (opts.reasonFile !== undefined)) {
          fail({
                what: 'Exactly one of --reason or --reason-file is required',
                why: 'Cannot provide both, cannot provide neither.',
                next: 'Pass --reason "<text>" OR --reason-file <path>.',
              });
          process.exit(1);
        }

        let reasonText: string;
        if (opts.reasonFile !== undefined) {
          try {
            const s = await stat(opts.reasonFile);
            if (!s.isFile()) {
              fail({
                    what: `--reason-file is not a regular file: ${opts.reasonFile}`,
                    why: 'Directory, device, socket, or named pipe is not a valid source for log entry body.',
                    next: 'Provide a path to a regular text file containing the justification.',
                  });
              process.exit(1);
            }
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT' || !e.code) {
              debugWrite(`[log] reason-file not found: ${e.message}`);
              fail({
                    what: `Cannot stat --reason-file: ${e.message}`,
                    why: 'File must exist and be accessible.',
                    next: `Check path: ${opts.reasonFile}`,
                  });
              process.exit(1);
            }
            throw err;
          }
          reasonText = await readFile(opts.reasonFile, 'utf-8');
        } else {
          reasonText = opts.reason!;
        }

        const nodePath = opts.node.trim().replace(/\/$/, '');
        const result = await logAdd({ graph, nodePath, reasonText, nowMs: Date.now() });
        if (!result.ok) {
          fail(result.error);
          process.exit(1);
        }
        process.stdout.write(
          chalk.green(
            `Added log entry to .yggdrasil/model/${result.nodePath}/log.md\nTimestamp: ${result.datetime}\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('read')
    .description('Print log entries newest-first (default: top 10)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--top <n>', 'Limit to N newest entries (default 10)', (v) => parseInt(v, 10))
    .option('--all', 'Return all entries (cannot combine with --top)')
    .option(
      '--with-verdicts',
      "interleave the node's verification events (local telemetry) with its log entries",
    )
    .option('--json', 'Print the entries as a yg-log/1 JSON document')
    .action(async (opts: { node: string; top?: number; all?: boolean; withVerdicts?: boolean; json?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const nodePath = opts.node.trim().replace(/\/$/, '');
        const result = await logRead({ graph, nodePath, top: opts.top, all: opts.all });
        if (!result.ok) {
          fail(result.error);
          process.exit(1);
        }

        if (opts.withVerdicts) {
          // Interleave the node's own fill verdict events (local telemetry) with
          // its log entries, newest first. The events sidecar is read-only local
          // telemetry: a fill outcome for this node keyed either by the node
          // itself (node:<path>) or by one of its mapped subject files
          // (file:<p>). Only 'fill'-sourced events are shown here; other
          // diagnostic sources are out of scope for the log view. A `file:`
          // event is attributed by REAL ownership (hierarchy-first, exclusion-
          // aware — the same answer `yg owner --file` gives), never by whether
          // the path merely falls inside one of this node's mapping strings: a
          // directory-mapping ancestor's mapping text covers a descendant's own
          // file too, and text has no notion of an exclusion.
          const projectRoot = projectRootFromGraph(graph.rootPath);
          const nodeKey = `node:${nodePath}`;
          const evResult = readVerdictEvents(graph.rootPath);
          const ownershipCache = new Map<string, boolean>();
          const belongsHere = async (filePath: string): Promise<boolean> => {
            const cached = ownershipCache.get(filePath);
            if (cached !== undefined) return cached;
            const owns = await verdictBelongsToNode(graph, projectRoot, filePath, nodePath);
            ownershipCache.set(filePath, owns);
            return owns;
          };
          const matched: VerdictEvent[] = [];
          for (const e of evResult.events) {
            if (e.source !== 'fill') continue;
            if (e.unitKey === nodeKey) {
              matched.push(e);
              continue;
            }
            if (e.unitKey.startsWith('file:') && (await belongsHere(e.unitKey.slice('file:'.length)))) {
              matched.push(e);
            }
          }

          if (opts.json === true) {
            writeLogJson(nodePath, result.entries, { events: matched, gitTracked: evResult.gitTracked, since: evResult.firstTs ?? null });
            return;
          }
          // Honesty label: the sidecar is meant to be gitignored local telemetry.
          // If it is git-tracked it is shared history for the whole team — refuse
          // the "local" wording and say so plainly.
          const since = evResult.firstTs ?? '(no events recorded)';
          if (evResult.gitTracked) {
            process.stdout.write(
              chalk.yellow(
                `verification telemetry since ${since} — NOTE: the events sidecar is git-tracked, ` +
                  `so this is shared history, not local-only telemetry.\n`,
              ),
            );
          } else {
            process.stdout.write(chalk.dim(`local telemetry since ${since}\n`));
          }

          // Committed shared stream: when it contributed events, surface the
          // verbatim honesty label so the shared record is never mistaken for
          // complete — older CLIs write only locally and do not contribute.
          if (evResult.committedNote !== undefined) {
            process.stdout.write(
              chalk.dim(
                `includes ${evResult.committedCount} event(s) from the committed shared stream ` +
                  `(${evResult.committedNote})\n`,
              ),
            );
          }

          const items: Array<{ ts: string; text: string }> = [];
          for (const entry of result.entries) {
            items.push({ ts: entry.datetime, text: `## [${entry.datetime}]\n${entry.body}` });
          }
          for (const e of matched) {
            items.push({ ts: e.ts, text: renderVerdictEvent(e) });
          }
          // Newest first (same direction as plain `yg log read`).
          items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

          if (items.length === 0) {
            process.stdout.write('No log entries or verification events.\n');
            return;
          }
          for (const it of items) {
            process.stdout.write(it.text);
          }
          return;
        }

        if (opts.json === true) {
          writeLogJson(nodePath, result.entries);
          return;
        }
        if (result.entries.length === 0) {
          process.stdout.write('No log entries.\n');
          return;
        }
        for (const entry of result.entries) {
          process.stdout.write(`## [${entry.datetime}]\n${entry.body}`);
        }
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('merge-resolve')
    .description(
      'Reconcile log.md after a git merge: during a merge, rebase or cherry-pick stopped on a conflicted log.md (writes the union of both sides), on the merge commit, or with --ours/--theirs naming the two sides of a merge that left no merge commit',
    )
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--ours <ref>', 'one side of a merge that left no merge commit (with --theirs)')
    .option('--theirs <ref>', 'the other side of that merge (with --ours)')
    .option('--base <ref>', 'the commit whose log entries neither side may have lost (default: the merge base of --ours and --theirs)')
    .action(async (opts: { node: string; ours?: string; theirs?: string; base?: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        if ((opts.ours === undefined) !== (opts.theirs === undefined) || (opts.base !== undefined && opts.ours === undefined)) {
          fail({
                what: '--ours and --theirs go together, and --base only with them.',
                why: 'A merge has two sides; the merged log is verified against both, so naming one of them names no merge.',
                next: 'Pass both --ours <ref> and --theirs <ref> (and --base <ref> only to check against a commit other than their merge base), or none of them (during a merge, rebase or cherry-pick in progress, or on the merge commit).',
              });
          process.exit(1);
        }
        const repoRoot = path.dirname(graph.rootPath);
        const nodePath = opts.node.trim().replace(/\/$/, '');
        const sides =
          opts.ours !== undefined && opts.theirs !== undefined
            ? { ours: opts.ours, theirs: opts.theirs, ...(opts.base !== undefined ? { base: opts.base } : {}) }
            : undefined;
        const result = await logMergeResolve({ graph, nodePath, repoRoot, ...(sides !== undefined ? { sides } : {}) });
        if (!result.ok) {
          fail(result.error);
          process.exit(1);
        }
        process.stdout.write(
          chalk.green(
            result.wroteUnion === true
              ? `Merge-resolve wrote the union of both sides into .yggdrasil/model/${result.nodePath}/log.md and verified it.\nLog baseline updated.\n` +
                `Next: git add .yggdrasil/model/${result.nodePath}/log.md .yggdrasil/yg-lock.logs.json, finish the ${result.inProgress ?? 'merge'} (${OPERATION_COMMANDS[result.inProgress ?? 'merge'].finish}), then run yg check.\n`
              : `Merge-resolve verified for .yggdrasil/model/${result.nodePath}/log.md\nLog baseline updated.\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });
}
