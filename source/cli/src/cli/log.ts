import type { Command } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { loadGraphOrAbort, abortOnUnexpectedError } from './preamble.js';
import { findOwnerWithinOwnGraph } from './owner.js';
import { debugWrite } from '../utils/debug-log.js';
import { logAdd } from '../core/log/log-add.js';
import { logRead, type LogEntry } from '../core/log/log-read.js';
import { logMergeResolve, logMergeResolveAll, OPERATION_COMMANDS } from '../core/log/log-merge-resolve.js';
import { appendTypeLogEntry, readTypeLog, type TypeDecisions } from '../core/log/type-log.js';
import { addAspectLogEntry, readAspectLogCommand } from './log-aspect.js';
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
 *  - `--aspect <id>` — a rule's own history: why it exists, and every change of
 *    its status (`--status`). It replaced `yg aspects log`.
 */

/** The one log a command acts on. */
type LogTarget = { kind: 'node' | 'type' | 'aspect'; id: string };

/** The log the flags name, or a usage refusal when they name none or more than one. */
function targetOf(opts: { node?: string; type?: string; aspect?: string }, command: string): LogTarget {
  const named: LogTarget[] = [
    ...(opts.node !== undefined ? [{ kind: 'node' as const, id: opts.node.trim().replace(/\/$/, '') }] : []),
    ...(opts.type !== undefined ? [{ kind: 'type' as const, id: opts.type.trim() }] : []),
    ...(opts.aspect !== undefined ? [{ kind: 'aspect' as const, id: opts.aspect.trim() }] : []),
  ];
  if (named.length !== 1) {
    failAndExit({
      what: `yg log ${command} needs exactly one of --node, --type or --aspect`,
      why: 'Every log belongs to one thing: a node\'s log says why that component is the way it is, a type\'s log holds decisions about every node of the type, and a rule\'s log is that rule\'s own history.',
      next: `yg log ${command} --node <path>  (or --type <type>, or --aspect <id>)`,
    }, 'usage');
  }
  return named[0];
}

/** Refuse a flag that means something for one kind of log only, given for another. */
function onlyFor(target: LogTarget, kind: LogTarget['kind'], flags: Record<string, unknown>, command: string): void {
  if (target.kind === kind) return;
  const given = Object.entries(flags).filter(([, v]) => v !== undefined && v !== false).map(([k]) => k);
  if (given.length === 0) return;
  failAndExit({
    what: `${given.join(', ')} ${given.length === 1 ? 'applies' : 'apply'} only to --${kind}, not to --${target.kind}`,
    why: kind === 'aspect'
      ? 'A change of status is something only a rule has; a node\'s or a type\'s log has no status to record.'
      : 'Verification events are recorded per component and per file; only a node\'s log can be read beside them.',
    next: `yg log ${command} ${flagOf(target)} without ${given.join(', ')}`,
  }, 'usage');
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

interface AddOpts { node?: string; type?: string; aspect?: string; reason?: string; reasonFile?: string; supersedes?: string[]; adds?: boolean; status?: string; evidence?: string; by?: string }

/**
 * The decisions in force the writer of a type decision faced, one line each,
 * nearest type first: its datetime (what --supersedes takes) and the first
 * line of what it says.
 */
function renderInForce(typeId: string, inForce: readonly TypeDecisions[]): string {
  const lines = [`Decisions in force for type '${typeId}' and the types above it:`];
  for (const d of inForce) {
    for (const e of d.entries) {
      const first = e.body.split('\n').find((l) => l.trim() !== '' && !l.startsWith('### Supersedes: ')) ?? '';
      lines.push(`  ${d.typeId}  [${e.datetime}]  ${first.trim()}`);
    }
    if (d.unreadable !== undefined) lines.push(`  ${d.typeId}  (log unreadable: ${d.unreadable})`);
  }
  return `${lines.join('\n')}\n`;
}

async function addAction(opts: AddOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const target = targetOf(opts, 'add');
  onlyFor(target, 'aspect', { '--status': opts.status, '--evidence': opts.evidence, '--by': opts.by }, 'add');
  onlyFor(target, 'type', { '--adds': opts.adds }, 'add');
  if (opts.adds === true && (opts.supersedes ?? []).length > 0) {
    failAndExit({
      what: '--adds and --supersedes cannot both be given',
      why: '--adds says the new decision replaces none of those in force; --supersedes names the ones it replaces. One entry says one of the two.',
      next: `yg log add ${flagOf(target)} --reason '<the decision>' --supersedes <datetime>  (or --adds alone)`,
    }, 'usage');
  }
  const reasonText = await reasonTextOf(opts, target);
  const nowMs = entryClock();

  if (target.kind === 'aspect') {
    await addAspectLogEntry(graph, target.id, reasonText, { status: opts.status, evidence: opts.evidence, by: opts.by, supersedes: opts.supersedes, nowMs });
    return;
  }
  if (target.kind === 'type') {
    const result = await appendTypeLogEntry({ graph, typeId: target.id, reasonText, nowMs, supersedes: opts.supersedes, adds: opts.adds });
    if (result.inForce !== undefined && result.inForce.length > 0) writeOut(renderInForce(target.id, result.inForce));
    if (!result.ok) failAndExit(result.error);
    writeOut(paint.green(`Added log entry to ${result.logPath}\nTimestamp: ${result.datetime}\n`));
    return;
  }
  const result = await logAdd({ graph, nodePath: target.id, reasonText, nowMs, supersedes: opts.supersedes });
  if (!result.ok) failAndExit(result.error);
  writeOut(paint.green(`Added log entry to .yggdrasil/model/${result.nodePath}/log.md\nTimestamp: ${result.datetime}\n`));
}

interface ReadOpts { node?: string; type?: string; aspect?: string; top?: number; all?: boolean; withVerdicts?: boolean; json?: boolean }

async function readAction(opts: ReadOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const target = targetOf(opts, 'read');
  onlyFor(target, 'node', { '--with-verdicts': opts.withVerdicts }, 'read');
  if (target.kind === 'aspect') {
    await readAspectLogCommand(graph, target.id, opts);
    return;
  }
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

interface MergeResolveOpts { node?: string; type?: string; aspect?: string; ours?: string; theirs?: string; base?: string }

async function mergeResolveAction(opts: MergeResolveOpts): Promise<void> {
  const graph = await loadGraphOrAbort(process.cwd(), { tolerateInvalidConfig: true });
  const namesNone = opts.node === undefined && opts.type === undefined && opts.aspect === undefined;
  if (namesNone && opts.ours === undefined && opts.theirs === undefined && opts.base === undefined) {
    await mergeResolveAllAction(graph);
    return;
  }
  const target = targetOf(opts, 'merge-resolve');
  if (target.kind === 'aspect') {
    failAndExit({
      what: 'yg log merge-resolve reconciles a node\'s or a type\'s log, not a rule\'s',
      why: 'A rule\'s history keeps no append-only baseline for a merge to be verified against; after a merge, keep every entry of both sides in date order by hand.',
      next: 'yg log merge-resolve --node <path>  (or --type <type>)',
    }, 'usage');
  }
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

/**
 * `yg log merge-resolve` with no log named: the post-merge step. Every node and
 * type log the merge changed is reconciled and its baseline recorded — what a
 * merge driver, a function of one file, cannot do. Run by the post-merge hook
 * `yg init` installs, and by whatever merges branches for a loop (Jarl's
 * merger, Horde's landing) right after its merge. Exit 1 when any log failed;
 * the rest are reconciled all the same.
 */
async function mergeResolveAllAction(graph: Graph): Promise<void> {
  const repoRoot = path.dirname(graph.rootPath);
  const result = await logMergeResolveAll({ graph, repoRoot });
  if (result.merge === 'none') {
    writeOut('HEAD is not a merge commit and no merge is in progress — no log to reconcile.\n');
    return;
  }
  for (const r of result.resolved) {
    writeOut(paint.green(`${r.wroteUnion === true ? 'Wrote the union of both sides into' : 'Verified'} ${r.logPath}; baseline recorded.\n`));
  }
  const owed = result.resolved.filter((r) => r.entryOwed === true);
  if (result.failed.length > 0) {
    for (const f of result.failed) writeOut(`${f.logPath}: ${f.error.what}\n`);
    failAndExit({
      code: result.failed[0].error.code,
      what: `${count(result.failed.length, 'log')} the merge changed could not be reconciled (${result.failed.map((f) => f.logPath).join(', ')})`,
      why: `${result.failed[0].error.why}${result.resolved.length > 0 ? ` The other ${count(result.resolved.length, 'log')} were reconciled and their baselines recorded.` : ''}`,
      next: result.failed.map((f) => (f.error.code === 'log-merge-supersedes-conflict' ? f.error.next : `yg log merge-resolve ${f.target}`)).join('\n'),
    });
  }
  if (result.resolved.length === 0) {
    writeOut('The merge changed no node or type log — no baseline to record.\n');
    return;
  }
  const stage = 'git add .yggdrasil/yg-lock.logs.json .yggdrasil/yg-lock.types.json';
  const finish = result.merge === 'in-progress' ? `${stage}, then git commit` : `${stage}, then git commit (or git commit --amend on the merge commit, before it is pushed)`;
  if (owed.length > 0) {
    writeOut(`${next(owed.map((r) => `yg log add ${r.target} --reason '<why these changes were merged — ask the user>'`).join('\n'))}\n`);
    writeOut(`${thenStep(`${finish}, then yg check --approve`)}\n`);
  } else {
    writeOut(`${next(finish)}\n`);
  }
}

export function registerLogCommand(program: Command): void {
  const log = program
    .command('log')
    .description("Append-only logs: a node's business log (why it is the way it is), a node type's decision log, and a rule's own history");

  log
    .command('add')
    .description('Append a log entry to a node, a node type or a rule')
    .option('--node <path>', 'Node path (relative to .yggdrasil/model/, no model/ prefix)')
    .option('--type <type>', 'Node type (as yg-architecture.yaml names it): record a decision about every node of the type')
    .option('--aspect <id>', "Rule id: add to the rule's own history")
    .option('--reason <text>', 'Justification text (one of --reason or --reason-file required)')
    .option('--reason-file <path>', 'Read justification from a file (alternative to --reason)')
    .option(
      '--supersedes <datetime>',
      'the datetime of an earlier entry of the same log this one replaces (repeatable); both stay in the file',
      (v: string, prev: string[] = []) => [...prev, v.trim()],
    )
    .option('--adds', 'with --type: the new decision adds to those in force and replaces none (required, unless --supersedes, whenever any decision is in force for the type or a type above it)')
    .option('--status <status>', "with --aspect: record that the rule's status moved to this one (draft | advisory | enforced) — the rule's own file must already carry it")
    .option('--evidence <text>', 'with --aspect --status: what justified the change of status (required with --status)')
    .option('--by <who>', "with --aspect --status: who decided (default: 'the user')")
    .action(async (opts: AddOpts) => {
      try {
        await addAction(opts);
      } catch (error) {
        handleError(error);
      }
    });

  log
    .command('read')
    .description('Print log entries newest-first (a node: top 10 by default; a type: the decisions in force; a rule: its whole history)')
    .option('--node <path>', 'Node path (relative to .yggdrasil/model/)')
    .option('--type <type>', 'Node type (as yg-architecture.yaml names it)')
    .option('--aspect <id>', 'Rule id')
    .option('--top <n>', 'Limit to N newest entries (default for a node: 10)', (v) => parseInt(v, 10))
    .option('--all', 'Return all entries (cannot combine with --top); for a type, replaced decisions too')
    .option(
      '--with-verdicts',
      "interleave the node's verification events (local telemetry) with its log entries",
    )
    .option('--json', 'Print the entries as a JSON document (yg-log/1 for a node, yg-type-log/1 for a type, yg-aspect-log/1 for a rule)')
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
      'Reconcile log.md after a git merge: during a merge, rebase or cherry-pick stopped on a conflicted log.md (writes the union of both sides), on the merge commit, or with --ours/--theirs naming the two sides of a merge that left no merge commit. With no log named: every node and type log the merge at HEAD (or the merge in progress) changed, each baseline recorded — the step after a merge whose drivers merged the logs',
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
