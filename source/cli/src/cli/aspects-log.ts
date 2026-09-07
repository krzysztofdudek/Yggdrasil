import type { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { buildIssueMessage } from '../formatters/message-builder.js';
import { debugWrite } from '../utils/debug-log.js';
import { readLock } from '../io/lock-store.js';
import {
  appendAspectLogEntry,
  readAspectLog,
  type AspectLogEntry,
} from '../core/log/aspect-log.js';
import {
  ASPECT_STATUSES,
  currentStatus,
  parseStatusEntry,
  statusLine,
} from '../core/log/aspect-status.js';
import {
  ASPECT_LOG_JSON_SCHEMA,
  formatAspectLogJson,
  type AspectLogJsonDocument,
  type AspectLogJsonEntry,
} from '../formatters/aspect-log-json.js';
import type { AspectDef, Graph } from '../model/graph.js';
import type { IssueMessage } from '../model/validation.js';

/**
 * `yg aspects log add` / `yg aspects log read` — a rule's own history, written
 * and read.
 *
 * A component has had this since the beginning: a log beside it holding why it
 * is the way it is. A rule had nothing, so a rule's history lived in commit
 * messages, or — worse — was written into the logs of every component the rule
 * happened to reach, scattering one rule's story across a dozen places that are
 * not about it.
 *
 * These are the exact counterparts of the component commands, on the same entry
 * composer, with the same guards: a reason that says nothing is refused, text
 * that would destroy the entry boundary for later readers is refused, and a new
 * entry never carries a timestamp at or before the one before it.
 *
 * One thing is deliberately NOT here: changing a rule. `--status` RECORDS a
 * change of standing, and is refused unless the rule's own file already carries
 * the standing being claimed. The file stays the user's to edit; a log that
 * could claim a change nobody made would be worse than no log at all.
 */
export function registerAspectsLogCommand(aspects: Command): void {
  const log = aspects.command('log').description("A rule's own history — why it exists, and every change of its standing");

  log
    .command('add')
    .description("Append an entry to a rule's log")
    .requiredOption('--aspect <id>', 'rule id whose log the entry joins')
    .option('--reason <text>', 'the entry text (one of --reason or --reason-file is required)')
    .option('--reason-file <path>', 'read the entry text from a file')
    .option(
      '--status <status>',
      `record that the rule's standing moved to this one (${ASPECT_STATUSES.join(' | ')}) — the rule's own file must already carry it`,
    )
    .option('--evidence <text>', 'what justified the change of standing (required with --status)')
    .option('--by <who>', "who decided — the reviewer, an outside judge, or a person (default: 'the user')")
    .action(async (opts: {
      aspect: string;
      reason?: string;
      reasonFile?: string;
      status?: string;
      evidence?: string;
      by?: string;
    }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const aspect = resolveAspect(graph, opts.aspect);

        const reasonText = await resolveReason(opts.reason, opts.reasonFile);
        const body = opts.status === undefined
          ? reasonText
          : `${await statusPrefixFor(graph, aspect, opts)}\n\n${reasonText}`;

        const result = await appendAspectLogEntry({
          yggRootPath: graph.rootPath,
          aspectId: aspect.id,
          reasonText: body,
          nowMs: Date.now(),
        });
        if (!result.ok) failWith(result.error);

        process.stdout.write(
          `Added a log entry to rule '${aspect.id}'.\nTimestamp: ${result.datetime}\n`,
        );
      } catch (error) {
        abortOnUnexpectedError(error, "adding a rule's log entry");
      }
    });

  log
    .command('read')
    .description("Print a rule's log entries newest-first")
    .requiredOption('--aspect <id>', 'rule id whose log to read')
    .option('--limit <n>', 'show only the N newest entries', (v) => parseInt(v, 10))
    .option('--json', `Machine-readable output: one ${ASPECT_LOG_JSON_SCHEMA} document on stdout instead of the entries.`)
    .action(async (opts: { aspect: string; limit?: number; json?: boolean }) => {
      try {
        const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
        const aspect = resolveAspect(graph, opts.aspect);

        if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit <= 0)) {
          failWith({
            what: `--limit '${opts.limit}' is not a positive whole number of entries.`,
            why: 'The limit selects how many of the newest entries to show; zero or a fraction selects nothing anybody asked for.',
            next: 'Re-run with --limit 5, or drop the flag to see the whole history.',
          });
        }

        const result = await readAspectLog(graph.rootPath, aspect.id, opts.limit);
        if (!result.ok) failWith(result.error);

        if (opts.json === true) {
          process.stdout.write(formatAspectLogJson(buildDocument(aspect, result.entries)));
          return;
        }
        process.stdout.write(renderEntries(aspect, result.entries));
      } catch (error) {
        abortOnUnexpectedError(error, "reading a rule's log");
      }
    });
}

/** Print a what / why / next block on stderr and exit non-zero. */
function failWith(msg: IssueMessage): never {
  process.stderr.write(chalk.red(`Error: ${buildIssueMessage(msg)}`) + '\n');
  process.exit(1);
}

/** The rule the entry is about, or a refusal naming how to find the right id. */
function resolveAspect(graph: Graph, id: string): AspectDef {
  const aspect = graph.aspects.find((a) => a.id === id);
  if (aspect === undefined) {
    failWith({
      what: `No rule '${id}' in this graph.`,
      why: "A log belongs to the rule it is about, so the rule has to exist before anything can be written to or read from its history.",
      next: 'List the rules with yg aspects, then re-run with --aspect <id>.',
    });
  }
  return aspect;
}

/** The entry text, from the flag or the file, with exactly one of them required. */
async function resolveReason(reason: string | undefined, reasonFile: string | undefined): Promise<string> {
  if (reason !== undefined && reasonFile !== undefined) {
    failWith({
      what: '--reason and --reason-file cannot both be given.',
      why: 'They are two ways to supply the same text; with both, the entry that would be written is whichever one the tool happened to prefer, and the caller cannot tell which.',
      next: 'Pass the text with --reason, or the file that holds it with --reason-file.',
    });
  }
  if (reason !== undefined) return reason;
  if (reasonFile === undefined) {
    failWith({
      what: 'The entry has no text.',
      why: "A log entry exists to say why something is the way it is; an entry with nothing in it records that something happened and hides what.",
      next: 'Re-run with --reason "<why>" or --reason-file <path>.',
    });
  }
  try {
    return await readFile(path.resolve(process.cwd(), reasonFile), 'utf-8');
  } catch (err) {
    debugWrite(`[aspects log] reason file unreadable: ${err instanceof Error ? err.message : String(err)}`);
    failWith({
      what: `The file '${reasonFile}' could not be read.`,
      why: 'It was named as the source of the entry text, so without it there is nothing to record.',
      next: 'Check the path, or pass the text directly with --reason "<why>".',
    });
  }
}

/**
 * The fixed opening line of a status entry — after checking that the change
 * being recorded is one the rule's file actually carries.
 *
 * The `from` is taken from the rule's own history rather than from a flag: the
 * caller cannot misremember it, and a rule whose standing was never recorded
 * reads as having come from the standing the tool would otherwise assume.
 */
async function statusPrefixFor(
  graph: Graph,
  aspect: AspectDef,
  opts: { status?: string; evidence?: string; by?: string },
): Promise<string> {
  const to = opts.status as string;
  if (!(ASPECT_STATUSES as readonly string[]).includes(to)) {
    failWith({
      what: `'${to}' is not a standing a rule can have.`,
      why: `A rule stands at one of ${ASPECT_STATUSES.join(', ')} — draft enforces nothing, advisory reports without blocking, enforced refuses. Anything else names no authority at all.`,
      next: `Re-run with --status ${ASPECT_STATUSES.join(' | --status ')}.`,
    });
  }

  const actual = currentStatus(aspect);
  if (actual !== to) {
    failWith({
      what: `Rule '${aspect.id}' stands at ${actual}, not ${to}.`,
      why: "This records a change; it does not make one. The rule's own file is yours to edit, and a history that claimed a change nobody made would be worse than no history at all.",
      next: `Set status: ${to} in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml, then record it here.`,
    });
  }

  if (opts.evidence === undefined || opts.evidence.trim() === '') {
    failWith({
      what: 'A change of standing was recorded with no evidence.',
      why: "A rule's standing is the whole of its authority, so what justified moving it is the part of the record that matters most a year later — and the part nobody can reconstruct.",
      next: 'Re-run with --evidence "<what justified it>", e.g. --evidence "two waves clean, no new violations".',
    });
  }

  const previous = await previousStatus(graph, aspect);
  return statusLine({
    from: previous,
    to,
    by: opts.by?.trim() === undefined || opts.by?.trim() === '' ? 'the user' : opts.by.trim(),
    evidence: opts.evidence.trim(),
  });
}

/**
 * Where the rule stood before this entry.
 *
 * Three sources, in order of how much they know: what the rule's own history
 * last recorded, then the standing the tool last saw (its memory of the rule,
 * kept beside the verdicts), and finally an admission that nobody knows. The
 * last is deliberately a phrase rather than a guess — assuming the default
 * would write a `from` that may never have been true, and a history that states
 * a standing nobody set is exactly the failure this whole thing exists to
 * prevent.
 */
async function previousStatus(graph: Graph, aspect: AspectDef): Promise<string> {
  const log = await readAspectLog(graph.rootPath, aspect.id);
  if (log.ok) {
    for (const entry of log.entries) {
      const parsed = parseStatusEntry(entry.body);
      if (parsed !== null) return parsed.to;
    }
  }
  try {
    const remembered = readLock(graph.rootPath).aspects?.[aspect.id]?.status;
    if (remembered !== undefined) return remembered;
  } catch (err) {
    // An unreadable lock is reported loudly by every command that depends on
    // it; here it costs only the better of two answers, so the entry is still
    // written with the honest one.
    debugWrite(`[aspects log] lock unreadable while resolving the previous standing: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 'an unrecorded standing';
}

/** The document form: the rule, what it stands at now, and its entries newest first. */
function buildDocument(aspect: AspectDef, entries: readonly AspectLogEntry[]): AspectLogJsonDocument {
  const projected: AspectLogJsonEntry[] = entries.map((entry) => {
    const status = parseStatusEntry(entry.body);
    const item: AspectLogJsonEntry = { at: entry.datetime, body: entry.body };
    if (status !== null) item.status = status;
    return item;
  });
  return {
    schema: ASPECT_LOG_JSON_SCHEMA,
    aspect: aspect.id,
    status: currentStatus(aspect),
    entries: projected,
  };
}

/** The reader's view: the same entries, as the log itself reads. */
function renderEntries(aspect: AspectDef, entries: readonly AspectLogEntry[]): string {
  if (entries.length === 0) {
    return `Rule '${aspect.id}' (${currentStatus(aspect)}) has no history recorded yet.\n`;
  }
  const parts = [`Rule '${aspect.id}' — stands at ${currentStatus(aspect)}, ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'} newest first.\n`];
  for (const entry of entries) {
    parts.push(`\n## [${entry.datetime}]\n${entry.body.trimEnd()}\n`);
  }
  return parts.join('');
}
