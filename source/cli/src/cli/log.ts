import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { debugWrite } from '../utils/debug-log.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { logAdd } from '../core/log/log-add.js';
import { logRead } from '../core/log/log-read.js';
import { logMergeResolve } from '../core/log/log-merge-resolve.js';
import { toPosix } from '../utils/posix.js';
import { mappingEntryMatchesFile, normalizeMappingPath } from '../utils/mapping-path.js';
import { readVerdictEvents } from '../io/events-reader.js';
import type { VerdictEvent } from '../io/events-store.js';

/** True when a `file:` unit-key path is covered by one of the node's mapping entries. */
function fileInNodeMapping(filePath: string, mapping: string[]): boolean {
  const c = normalizeMappingPath(filePath);
  if (c === '') return false;
  return mapping.some((raw) => mappingEntryMatchesFile(raw, c));
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
          process.stderr.write(
            chalk.red(
              buildIssueMessage({
                what: 'Exactly one of --reason or --reason-file is required',
                why: 'Cannot provide both, cannot provide neither.',
                next: 'Pass --reason "<text>" OR --reason-file <path>.',
              }),
            ) + '\n',
          );
          process.exit(1);
        }

        let reasonText: string;
        if (opts.reasonFile !== undefined) {
          try {
            const s = await stat(opts.reasonFile);
            if (!s.isFile()) {
              process.stderr.write(
                chalk.red(
                  buildIssueMessage({
                    what: `--reason-file is not a regular file: ${opts.reasonFile}`,
                    why: 'Directory, device, socket, or named pipe is not a valid source for log entry body.',
                    next: 'Provide a path to a regular text file containing the justification.',
                  }),
                ) + '\n',
              );
              process.exit(1);
            }
          } catch (err) {
            const e = err as NodeJS.ErrnoException;
            if (e.code === 'ENOENT' || !e.code) {
              debugWrite(`[log] reason-file not found: ${e.message}`);
              process.stderr.write(
                chalk.red(
                  buildIssueMessage({
                    what: `Cannot stat --reason-file: ${e.message}`,
                    why: 'File must exist and be accessible.',
                    next: `Check path: ${opts.reasonFile}`,
                  }),
                ) + '\n',
              );
              process.exit(1);
            }
            throw err;
          }
          reasonText = await readFile(opts.reasonFile, 'utf-8');
        } else {
          reasonText = opts.reason!;
        }

        const nodePath = toPosix(opts.node.trim()).replace(/\/$/, '');
        const result = await logAdd({ graph, nodePath, reasonText, nowMs: Date.now() });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
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
    .action(async (opts: { node: string; top?: number; all?: boolean; withVerdicts?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const nodePath = toPosix(opts.node.trim()).replace(/\/$/, '');
        const result = await logRead({ graph, nodePath, top: opts.top, all: opts.all });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
          process.exit(1);
        }

        if (opts.withVerdicts) {
          // Interleave the node's own fill verdict events (local telemetry) with
          // its log entries, newest first. The events sidecar is read-only local
          // telemetry: a fill outcome for this node keyed either by the node
          // itself (node:<path>) or by one of its mapped subject files
          // (file:<p>). Only 'fill'-sourced events are shown here; other
          // diagnostic sources are out of scope for the log view.
          const nodeMeta = graph.nodes.get(nodePath);
          const mapping = nodeMeta?.meta.mapping ?? [];
          const nodeKey = `node:${nodePath}`;
          const evResult = readVerdictEvents(graph.rootPath);
          const matched = evResult.events.filter((e) => {
            if (e.source !== 'fill') return false;
            if (e.unitKey === nodeKey) return true;
            if (e.unitKey.startsWith('file:')) {
              return fileInNodeMapping(e.unitKey.slice('file:'.length), mapping);
            }
            return false;
          });

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
    .description('Reconcile log.md after a git merge (HEAD must be a merge commit)')
    .requiredOption('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .action(async (opts: { node: string }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const repoRoot = path.dirname(graph.rootPath);
        const nodePath = toPosix(opts.node.trim()).replace(/\/$/, '');
        const result = await logMergeResolve({ graph, nodePath, repoRoot });
        if (!result.ok) {
          process.stderr.write(chalk.red(buildIssueMessage(result.error)) + '\n');
          process.exit(1);
        }
        process.stdout.write(
          chalk.green(
            `Merge-resolve verified for .yggdrasil/model/${result.nodePath}/log.md\nLog baseline updated.\n`,
          ),
        );
      } catch (error) {
        handleError(error);
      }
    });
}
