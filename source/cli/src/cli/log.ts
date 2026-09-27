import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { findOwnerWithinOwnGraph } from './owner.js';
import { debugWrite } from '../utils/debug-log.js';
import { logAdd } from '../core/log/log-add.js';
import { logRead, type LogEntry } from '../core/log/log-read.js';
import { logMergeResolve, OPERATION_COMMANDS } from '../core/log/log-merge-resolve.js';
import { appendTypeLogEntry, readTypeLog } from '../core/log/type-log.js';
import { projectRootFromGraph } from '../io/paths.js';
import { readVerdictEvents } from '../io/events-reader.js';
import type { VerdictEvent } from '../io/events-store.js';
import type { Graph } from '../model/graph.js';
import { count, paint, writeOut, next, thenStep, failAndExit } from './output.js';

/**
 * `yg log` — the append-only logs this tool keeps, written, read and reconciled
 * after a merge. Each command names exactly one log:
 *
 *  - `--node <path>` — a component's log: WHY it is the way it is. A node type
 *    may require an entry for every source change (`log_required`).
 *  - `--type <type>` — a node type's decision log: explicit decisions about the
 *    whole area the type stands for, carried into the context of every node of
 *    it. Never required.
 */

/** The one log a command acts on. */
type LogTarget = { kind: 'node'; id: string } | { kind: 'type'; id: string };

/** The log the flags name, or a usage refusal when they name none or more than one. */
function targetOf(opts: { node?: string; type?: string }, command: string): LogTarget {
  const named = [
    ...(opts.node !== undefined ? [{ kind: 'node' as const, id: opts.node.trim().replace(/\/$/, '') }] : []),
    ...(opts.type !== undefined ? [{ kind: 'type' as const, id: opts.type.trim() }] : []),
  ];
  if (named.length !== 1) {
    failAndExit({
      what: `yg log ${command} needs exactly one of --node or --type`,
      why: 'Every log belongs to one thing: a node\'s log says why that component is the way it is, a type\'s log holds decisions about every node of the type.',
      next: `yg log ${command} --node <path>  (or --type <type>)`,
    }, 'usage');
  }
  return named[0];
}

/**
 * The moment the entry is written, read ONCE at the command boundary and handed
 * to the core as an input, exactly like the entry text: the core keeps no clock
 * of its own, so given the same text, log and moment it writes the same bytes.
 * An entry's header records when the decision was written down — the one input
 * of `yg log add` no flag can supply.
 */
function entryClock(): number {
  return Date.now();
}

/** How a message names the target on the command line. */
const flagOf = (t: LogTarget): string => `--${t.kind} ${t.id}`;

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
  return paint.dim(line) + '\n';
}

function handleError(error: unknown): never {
  debugWrite(`[log] command failed: ${(error as Error).message}`);
  abortOnUnexpectedError(error, 'running log command');
}

/** Schema id of `yg log read --node --json`. */
const LOG_JSON_SCHEMA = 'yg-log/1';
/** Schema id of `yg log read --type --json`. */
const TYPE_LOG_JSON_SCHEMA = 'yg-type-log/1';

/** One entry of a `yg-log/1` or `yg-type-log/1` document. */
interface LogJsonEntry {
  /** ISO 8601 UTC timestamp — the entry header, verbatim. */
  datetime: string;
  /** Everything under that header, verbatim. */
  body: string;
  /** Present when the entry replaces earlier entries of the log: their datetimes. */
  supersedes?: string[];
  /** Present when a later entry replaced this one: that entry's datetime. */
  supersededBy?: string;
}

/** The document form of one entry: the two standing fields only where they say something. */
function toJsonEntry(e: LogEntry): LogJsonEntry {
  return {
    datetime: e.datetime,
    body: e.body,
    ...(e.supersedes.length > 0 ? { supersedes: e.supersedes } : {}),
    ...(e.supersededBy !== undefined ? { supersededBy: e.supersededBy } : {}),
  };
}

/** The entry as text: its header, marked when a later entry replaced it, then its body. */
function renderEntry(e: LogEntry): string {
  const mark = e.supersededBy !== undefined ? ` — superseded by ${e.supersededBy}` : '';
  return `## [${e.datetime}]${mark}\n${e.body}`;
}

/** `yg log read --node --json` (yg-log/1). */
export interface LogJsonDocument {
  schema: typeof LOG_JSON_SCHEMA;
  /** The node, as its path under model/. */
  node: string;
  /** Its log entries, newest first. */
  entries: LogJsonEntry[];
  /** Present with --with-verdicts: the fill events attributed to the node. */
  verdictEvents?: {
    /** The earliest event considered, or null for the whole history. */
    since: string | null;
    /** Whether the event stream is committed (shared with the team) rather than local. */
    sharedHistory: boolean;
    events: VerdictEvent[];
  };
}

/** `yg log read --type --json` (yg-type-log/1). */
export interface TypeLogJsonDocument {
  schema: typeof TYPE_LOG_JSON_SCHEMA;
  /** The node type, as yg-architecture.yaml names it. */
  type: string;
  /** True when the entries are the decisions in force only (the default); false with --all. */
  inForceOnly: boolean;
  /** Its entries, newest first. */
  entries: LogJsonEntry[];
}

/**
 * `yg log read --json`: the node's entries, newest first, each with its
 * timestamp and body; with --with-verdicts also the fill events attributed to
 * the node, and whether that telemetry is local or shared.
 */
function writeLogJson(
  node: string,
  entries: LogEntry[],
  verdicts?: { events: VerdictEvent[]; gitTracked: boolean; since: string | null },
): void {
  const doc: LogJsonDocument = {
    schema: LOG_JSON_SCHEMA,
    node,
    entries: entries.map(toJsonEntry),
    ...(verdicts !== undefined
      ? { verdictEvents: { since: verdicts.since, sharedHistory: verdicts.gitTracked, events: verdicts.events } }
      : {}),
  };
  writeOut(`${JSON.stringify(doc, null, 2)}\n`);
}

/** The entry text, from exactly one of --reason and --reason-file. */
async function reasonTextOf(opts: { reason?: string; reasonFile?: string }, target: LogTarget): Promise<string> {
  if ((opts.reason !== undefined) === (opts.reasonFile !== undefined)) {
    failAndExit({
      what: 'yg log add needs exactly one of --reason or --reason-file',
      why: 'An entry has one text: given on the command line, or read from a file.',
      next: `yg log add ${flagOf(target)} --reason '<why this change was made>'`,
    }, 'usage');
  }
  if (opts.reasonFile === undefined) return opts.reason as string;
  try {
    const s = await stat(opts.reasonFile);
    if (!s.isFile()) {
      failAndExit({
        what: `--reason-file is not a regular file: ${opts.reasonFile}`,
        why: 'Directory, device, socket, or named pipe is not a valid source for log entry body.',
        next: `yg log add ${flagOf(target)} --reason-file <a text file with the justification>`,
      }, 'command-error');
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT' || !e.code) {
      debugWrite(`[log] reason-file not found: ${e.message}`);
      failAndExit({
        what: `Cannot stat --reason-file: ${e.message}`,
        why: 'File must exist and be accessible.',
        next: `Check path: ${opts.reasonFile}`,
      }, 'command-error');
    }
    throw err;
  }
  return await readFile(opts.reasonFile, 'utf-8');
}

interface AddOpts { node?: string; type?: string; reason?: string; reasonFile?: string; supersedes?: string[] }

async function addAction(opts: AddOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const target = targetOf(opts, 'add');
  const reasonText = await reasonTextOf(opts, target);
  const nowMs = entryClock();

  if (target.kind === 'type') {
    const result = await appendTypeLogEntry({ graph, typeId: target.id, reasonText, nowMs, supersedes: opts.supersedes });
    if (!result.ok) failAndExit(result.error);
    writeOut(paint.green(`Added log entry to ${result.logPath}\nTimestamp: ${result.datetime}\n`));
    return;
  }
  const result = await logAdd({ graph, nodePath: target.id, reasonText, nowMs, supersedes: opts.supersedes });
  if (!result.ok) failAndExit(result.error);
  writeOut(paint.green(`Added log entry to .yggdrasil/model/${result.nodePath}/log.md\nTimestamp: ${result.datetime}\n`));
}

interface ReadOpts { node?: string; type?: string; top?: number; all?: boolean; withVerdicts?: boolean; json?: boolean }

async function readAction(opts: ReadOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const target = targetOf(opts, 'read');
  if (target.kind === 'type') {
    await readTypeAction(graph, target.id, opts);
    return;
  }
  const nodePath = target.id;
  const result = await logRead({ graph, nodePath, top: opts.top, all: opts.all });
  if (!result.ok) failAndExit(result.error);

  if (opts.withVerdicts) {
    await readWithVerdicts(graph, nodePath, result.entries, opts.json === true);
    return;
  }
  if (opts.json === true) {
    writeLogJson(nodePath, result.entries);
    return;
  }
  if (result.entries.length === 0) {
    writeOut('No log entries.\n');
    return;
  }
  for (const entry of result.entries) {
    writeOut(renderEntry(entry));
  }
}

/**
 * A type's decisions: by default the ones in force — every entry no later
 * entry replaced, newest first, all of them (a decision is not "old news" the
 * way a node's tenth entry is); `--all` adds the replaced ones, marked; `--top`
 * keeps the newest N of whichever set was asked for.
 */
async function readTypeAction(graph: Graph, typeId: string, opts: ReadOpts): Promise<void> {
  if (opts.withVerdicts) {
    failAndExit({
      what: '--with-verdicts reads a node\'s verification events; a type has none',
      why: 'Verdicts are recorded per component and per file; a node type\'s log holds decisions, which no fill judges.',
      next: `yg log read --type ${typeId}`,
    }, 'usage');
  }
  if (opts.top !== undefined && opts.all === true) {
    failAndExit({ what: 'Cannot combine --top with --all', why: '--all overrides --top; provide one or the other.', next: `yg log read --type ${typeId} --all` }, 'command-error');
  }
  if (opts.top !== undefined && (!Number.isInteger(opts.top) || opts.top <= 0)) {
    failAndExit({ what: `Invalid --top value: ${opts.top}`, why: '--top must be a positive integer.', next: `yg log read --type ${typeId} --top 10` }, 'command-error');
  }
  const result = await readTypeLog(graph, typeId);
  if (!result.ok) failAndExit(result.error);

  const inForceOnly = opts.all !== true;
  const chosen = (inForceOnly ? result.entries.filter((e) => e.supersededBy === undefined) : result.entries).reverse();
  const entries = opts.top !== undefined ? chosen.slice(0, opts.top) : chosen;

  if (opts.json === true) {
    const doc: TypeLogJsonDocument = { schema: TYPE_LOG_JSON_SCHEMA, type: typeId, inForceOnly, entries: entries.map(toJsonEntry) };
    writeOut(`${JSON.stringify(doc, null, 2)}\n`);
    return;
  }
  if (entries.length === 0) {
    writeOut(result.entries.length === 0 ? 'No log entries.\n' : 'No decisions in force (yg log read --type ' + typeId + ' --all shows the replaced ones).\n');
    return;
  }
  for (const entry of entries) {
    writeOut(renderEntry(entry));
  }
}

/**
 * Interleave the node's own fill verdict events (local telemetry) with its log
 * entries, newest first. The events sidecar is read-only local telemetry: a
 * fill outcome for this node keyed either by the node itself (node:<path>) or
 * by one of its mapped subject files (file:<p>). Only 'fill'-sourced events are
 * shown here; other diagnostic sources are out of scope for the log view. A
 * `file:` event is attributed by REAL ownership (hierarchy-first, exclusion-
 * aware — the same answer `yg owner --file` gives), never by whether the path
 * merely falls inside one of this node's mapping strings: a directory-mapping
 * ancestor's mapping text covers a descendant's own file too, and text has no
 * notion of an exclusion.
 */
async function readWithVerdicts(graph: Graph, nodePath: string, entries: LogEntry[], json: boolean): Promise<void> {
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

  if (json) {
    writeLogJson(nodePath, entries, { events: matched, gitTracked: evResult.gitTracked, since: evResult.firstTs ?? null });
    return;
  }
  // Honesty label: the sidecar is meant to be gitignored local telemetry.
  // If it is git-tracked it is shared history for the whole team — refuse
  // the "local" wording and say so plainly.
  const since = evResult.firstTs ?? '(no events recorded)';
  if (evResult.gitTracked) {
    writeOut(
      paint.yellow(
        `verification telemetry since ${since} — the events sidecar is git-tracked, ` +
          `so this is shared history, not local-only telemetry.\n`,
      ),
    );
  } else {
    writeOut(paint.dim(`local telemetry since ${since}\n`));
  }

  // Committed shared stream: when it contributed events, surface the
  // verbatim honesty label so the shared record is never mistaken for
  // complete — older CLIs write only locally and do not contribute.
  if (evResult.committedNote !== undefined) {
    writeOut(
      paint.dim(
        `includes ${count(evResult.committedCount, 'event')} from the committed shared stream ` +
          `(${evResult.committedNote})\n`,
      ),
    );
  }

  const items: Array<{ ts: string; text: string }> = [];
  for (const entry of entries) {
    items.push({ ts: entry.datetime, text: renderEntry(entry) });
  }
  for (const e of matched) {
    items.push({ ts: e.ts, text: renderVerdictEvent(e) });
  }
  // Newest first (same direction as plain `yg log read`).
  items.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  if (items.length === 0) {
    writeOut('No log entries or verification events.\n');
    return;
  }
  for (const it of items) {
    writeOut(it.text);
  }
}

interface MergeResolveOpts { node?: string; type?: string; ours?: string; theirs?: string; base?: string }

async function mergeResolveAction(opts: MergeResolveOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const target = targetOf(opts, 'merge-resolve');
  if ((opts.ours === undefined) !== (opts.theirs === undefined) || (opts.base !== undefined && opts.ours === undefined)) {
    failAndExit({
      what: '--ours and --theirs go together, and --base only with them.',
      why: 'A merge has two sides; the merged log is verified against both, so naming one of them names no merge.',
      next: `yg log merge-resolve ${flagOf(target)} --ours <ref> --theirs <ref>  (add --base <ref> only to check against a commit other than their merge base; pass none of the three during a merge, rebase or cherry-pick, or on the merge commit)`,
    }, 'usage');
  }
  const repoRoot = path.dirname(graph.rootPath);
  const sides =
    opts.ours !== undefined && opts.theirs !== undefined
      ? { ours: opts.ours, theirs: opts.theirs, ...(opts.base !== undefined ? { base: opts.base } : {}) }
      : undefined;
  const result = await logMergeResolve({
    graph,
    repoRoot,
    ...(target.kind === 'node' ? { nodePath: target.id } : { typeId: target.id }),
    ...(sides !== undefined ? { sides } : {}),
  });
  if (!result.ok) failAndExit(result.error);
  writeOut(
    paint.green(
      result.wroteUnion === true
        ? `Merge-resolve wrote the union of both sides into ${result.logPath} and verified it.\nLog baseline updated.\n`
        : `Merge-resolve verified for ${result.logPath}\nLog baseline updated.\n`,
    ),
  );
  // A merge that brought the other side's code into the component owes
  // an entry of its own, and only whoever merged knows why: the entry
  // comes first, so the merge (or the commit after it) carries it.
  const owed = result.entryOwed === true
    ? `yg log add ${result.target} --reason '<why these changes were merged — ask the user>'`
    : undefined;
  if (result.wroteUnion === true) {
    const op = result.inProgress ?? 'merge';
    const stage = `git add ${result.logPath} .yggdrasil/yg-lock.logs.json`;
    const finish = `${OPERATION_COMMANDS[op].finish}, then yg check${owed !== undefined ? ' --approve' : ''}`;
    writeOut(`${next(owed ?? stage)}\n`);
    writeOut(`${thenStep(owed !== undefined ? `${stage}, ${finish}` : finish)}\n`);
  } else if (owed !== undefined) {
    writeOut(`${next(owed)}\n`);
    writeOut(`${thenStep('yg check --approve')}\n`);
  }
}

export function registerLogCommand(program: Command): void {
  const log = program
    .command('log')
    .description("Append-only logs: a node's business log (why it is the way it is) and a node type's decision log");

  log
    .command('add')
    .description('Append a log entry to a node or a node type')
    .option('--node <path>', 'Node path (relative to .yggdrasil/model/, no model/ prefix)')
    .option('--type <type>', 'Node type (as yg-architecture.yaml names it): record a decision about every node of the type')
    .option('--reason <text>', 'Justification text (one of --reason or --reason-file required)')
    .option('--reason-file <path>', 'Read justification from a file (alternative to --reason)')
    .option(
      '--supersedes <datetime>',
      'the datetime of an earlier entry of the same log this one replaces (repeatable); both stay in the file',
      (v: string, prev: string[] = []) => [...prev, v.trim()],
    )
    .action(async (opts: AddOpts) => {
      try {
        await addAction(opts);
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('read')
    .description('Print log entries newest-first (a node: top 10 by default; a type: the decisions in force)')
    .option('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--type <type>', 'Node type (as yg-architecture.yaml names it)')
    .option('--top <n>', 'Limit to N newest entries (default for a node: 10)', (v) => parseInt(v, 10))
    .option('--all', 'Return all entries (cannot combine with --top); for a type, replaced decisions too')
    .option(
      '--with-verdicts',
      "interleave the node's verification events (local telemetry) with its log entries",
    )
    .option('--json', 'Print the entries as a JSON document (yg-log/1 for a node, yg-type-log/1 for a type)')
    .action(async (opts: ReadOpts) => {
      try {
        await readAction(opts);
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('merge-resolve')
    .description(
      'Reconcile log.md after a git merge: during a merge, rebase or cherry-pick stopped on a conflicted log.md (writes the union of both sides), on the merge commit, or with --ours/--theirs naming the two sides of a merge that left no merge commit',
    )
    .option('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--type <type>', 'Node type whose decision log to reconcile')
    .option('--ours <ref>', 'one side of a merge that left no merge commit (with --theirs)')
    .option('--theirs <ref>', 'the other side of that merge (with --ours)')
    .option('--base <ref>', 'the commit whose log entries neither side may have lost (default: the merge base of --ours and --theirs)')
    .action(async (opts: MergeResolveOpts) => {
      try {
        await mergeResolveAction(opts);
      } catch (error) {
        handleError(error);
      }
    });
}
