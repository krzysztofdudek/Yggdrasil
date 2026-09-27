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
  isDriftEntry,
  parseStatusEntry,
  statusLine,
} from '../core/log/aspect-status.js';
import {
  formatAspectLogJson,
  ASPECT_LOG_JSON_SCHEMA,
  type AspectLogJsonDocument,
  type AspectLogJsonEntry,
} from '../formatters/aspect-log-json.js';
import { parseRatification, ratificationLine, ruleVersion, typeLawReach } from '../core/log/type-law.js';
import type { AspectDef, Graph } from '../model/graph.js';
import { aspectNotFound, failAndExit, writeOut } from './output.js';

/**
 * `yg log add --aspect` / `yg log read --aspect` — a rule's own history,
 * written and read through the same command as every other log.
 *
 * A component has had this since the beginning: a log beside it holding why it
 * is the way it is. A rule had nothing, so a rule's history lived in commit
 * messages, or — worse — was written into the logs of every component the rule
 * happened to reach, scattering one rule's story across a dozen places that are
 * not about it.
 *
 * Same entry composer, same guards: a reason that says nothing is refused, text
 * that would destroy the entry boundary for later readers is refused, and a new
 * entry never carries a timestamp at or before the one before it.
 *
 * One thing is deliberately NOT here: changing a rule. `--status` RECORDS a
 * change of standing, and is refused unless the rule's own file already carries
 * the standing being claimed. The file stays the user's to edit; a log that
 * could claim a change nobody made would be worse than no log at all.
 */

/** The rule the entry is about, or a refusal naming how to find the right id. */
function resolveAspect(graph: Graph, id: string): AspectDef {
  const aspect = graph.aspects.find((a) => a.id === id);
  if (aspect === undefined) {
    failAndExit(aspectNotFound(id, "A log belongs to the rule it is about, so the rule has to exist before anything can be written to or read from its history."), 'aspect-not-found');
  }
  return aspect;
}

/** The status flags, which record a rule's change of standing and mean nothing on any other log. */
interface AspectStatusOpts {
  status?: string;
  evidence?: string;
  by?: string;
  /** Record that the user admitted the rule, as it stands now, on the node types it reaches. */
  ratify?: boolean;
}

/** Append an entry to a rule's log; with --status, one that records its change of standing. */
export async function addAspectLogEntry(
  graph: Graph,
  aspectId: string,
  reasonText: string,
  opts: AspectStatusOpts & { supersedes?: string[]; nowMs: number },
): Promise<void> {
  const aspect = resolveAspect(graph, aspectId);
  const opening = [
    ...(opts.ratify === true ? [ratificationPrefixFor(graph, aspect, opts.by)] : []),
    ...(opts.status !== undefined ? [await statusPrefixFor(graph, aspect, opts)] : []),
  ];
  const body = opening.length === 0 ? reasonText : `${opening.join('\n')}\n\n${reasonText}`;

  const result = await appendAspectLogEntry({
    yggRootPath: graph.rootPath,
    aspectId: aspect.id,
    reasonText: body,
    nowMs: opts.nowMs,
    supersedes: opts.supersedes,
  });
  if (!result.ok) failAndExit(result.error, result.error.code ?? 'command-error');

  writeOut(`Added a log entry to rule '${aspect.id}'.\nTimestamp: ${result.datetime}\n`);
}

/**
 * A rule's history, newest first — the whole of it by default, because the
 * rule history document is read by other tools that expect every entry unless
 * they ask for fewer. `--top N` keeps the newest N.
 */
export async function readAspectLogCommand(
  graph: Graph,
  aspectId: string,
  opts: { top?: number; all?: boolean; json?: boolean },
): Promise<void> {
  const aspect = resolveAspect(graph, aspectId);
  if (opts.top !== undefined && opts.all === true) {
    failAndExit({
      what: '--top and --all cannot both be given.',
      why: '--top asks for the newest few entries and --all for every one; the two answers differ.',
      next: `yg log read --aspect ${aspect.id} --all`,
    }, 'command-error');
  }
  if (opts.top !== undefined && (!Number.isInteger(opts.top) || opts.top <= 0)) {
    failAndExit({
      what: `--top '${opts.top}' is not a positive whole number of entries.`,
      why: 'The limit selects how many of the newest entries to show; zero or a fraction selects nothing anybody asked for.',
      next: `yg log read --aspect ${aspect.id} --top 5, or drop the flag to see the whole history.`,
    }, 'command-error');
  }

  const result = await readAspectLog(graph.rootPath, aspect.id, opts.top);
  if (!result.ok) failAndExit(result.error, 'command-error');

  if (opts.json === true) {
    writeOut(formatAspectLogJson(buildDocument(aspect, result.entries)));
    return;
  }
  writeOut(renderEntries(aspect, result.entries));
}

/**
 * The fixed opening line of a status entry — after checking that the change
 * being recorded is one the rule's file actually carries.
 *
 * The `from` is taken from the rule's own history rather than from a flag: the
 * caller cannot misremember it, and a rule whose standing was never recorded
 * reads as having come from the standing the tool would otherwise assume.
 */
async function statusPrefixFor(graph: Graph, aspect: AspectDef, opts: AspectStatusOpts): Promise<string> {
  const to = opts.status as string;
  if (!(ASPECT_STATUSES as readonly string[]).includes(to)) {
    failAndExit({
      what: `'${to}' is not a status a rule can have.`,
      why: `A rule stands at one of ${ASPECT_STATUSES.join(', ')} — draft enforces nothing, advisory reports without blocking, enforced refuses. Anything else names no authority at all.`,
      next: `Re-run with --status ${ASPECT_STATUSES.join(' | --status ')}.`,
    }, 'aspect-status-value-invalid');
  }

  const actual = currentStatus(aspect);
  if (actual !== to) {
    failAndExit({
      what: `Rule '${aspect.id}' stands at ${actual}, not ${to}.`,
      why: "This records a change; it does not make one. The rule's own file is yours to edit, and a history that claimed a change nobody made would be worse than no history at all.",
      next: `Set status: ${to} in .yggdrasil/aspects/${aspect.id}/yg-aspect.yaml, then record it here.`,
    }, 'aspect-status-not-standing');
  }

  if (opts.evidence === undefined || opts.evidence.trim() === '') {
    failAndExit({
      what: 'A change of status was recorded with no evidence.',
      why: "A rule's status is the whole of its authority, so what justified moving it is the part of the record that matters most a year later — and the part nobody can reconstruct.",
      next: 'Re-run with --evidence "<what justified it>", e.g. --evidence "two waves clean, no new violations".',
    }, 'aspect-status-evidence-missing');
  }

  const previous = await previousStatus(graph, aspect);
  if (previous === to) {
    failAndExit({
      what: `Rule '${aspect.id}' already stood at ${to} before this entry, so there is no change of status to record.`,
      why: "A status entry records a move from one status to another. Writing one where nothing moved would put a promotion into the rule's history that never happened.",
      next: `Record the note without --status (yg log add --aspect ${aspect.id} --reason "..."), or set a different status: in the rule's yg-aspect.yaml first and record that change.`,
    }, 'aspect-status-unchanged');
  }
  return statusLine({
    from: previous,
    to,
    by: opts.by?.trim() === undefined || opts.by?.trim() === '' ? 'the user' : opts.by.trim(),
    evidence: opts.evidence.trim(),
  });
}

/**
 * The opening line of a ratification — after checking there is type law to
 * admit and someone named who admitted it.
 *
 * The types and the version are read from the graph, never from a flag: the
 * entry admits exactly what stands now, so a caller cannot admit a version it
 * has not seen or a type the rule does not reach. Every type the rule reaches
 * is covered, advisory ones included — admitting a rule while it runs as advice
 * is what lets it be hardened to enforced afterwards without asking again.
 */
function ratificationPrefixFor(graph: Graph, aspect: AspectDef, by: string | undefined): string {
  const types = [...(typeLawReach(graph).get(aspect.id)?.keys() ?? [])].sort();
  if (types.length === 0) {
    failAndExit({
      what: `Rule '${aspect.id}' reaches no node type — no type lists it or implies it — so there is no type law to admit.`,
      why: 'A ratification records that the user admitted a rule on every file of the node types it reaches. Law raised on one component is the agent\'s own and needs none.',
      next: `Record the note without --ratify: yg log add --aspect ${aspect.id} --reason '<why>'.`,
    }, 'aspect-ratify-no-type');
  }
  if (by === undefined || by.trim() === '') {
    failAndExit({
      what: 'A ratification was recorded without naming who admitted the rule.',
      why: 'A ratification is the record of a person\'s consent to law over every file of a type; without a name it is an agent vouching for itself.',
      next: `Re-run with --by '<who admitted it>', e.g. yg log add --aspect ${aspect.id} --ratify --by 'Jane Doe' --reason '<what was admitted>'.`,
    }, 'aspect-ratify-by-missing');
  }
  return ratificationLine({ types, version: ruleVersion(aspect), by: by.trim() });
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
      if (parsed === null) continue;
      // The tool's own record of an edit made directly in the file carries no
      // evidence. Recording that change now is the person supplying it, so the
      // change runs from where the rule stood before that edit.
      return isDriftEntry(entry.body) ? parsed.from : parsed.to;
    }
  }
  try {
    const remembered = readLock(graph.rootPath).aspects?.[aspect.id]?.status;
    if (remembered !== undefined) return remembered;
  } catch (err) {
    // An unreadable lock is reported loudly by every command that depends on
    // it; here it costs only the better of two answers, so the entry is still
    // written with the honest one.
    debugWrite(`[log --aspect] lock unreadable while resolving the previous standing: ${err instanceof Error ? err.message : String(err)}`);
  }
  return 'an unrecorded status';
}

/** The document form: the rule, what it stands at now, and its entries newest first. */
function buildDocument(aspect: AspectDef, entries: readonly AspectLogEntry[]): AspectLogJsonDocument {
  const projected: AspectLogJsonEntry[] = entries.map((entry) => {
    const status = parseStatusEntry(entry.body);
    const item: AspectLogJsonEntry = { at: entry.datetime, body: entry.body };
    if (status !== null) item.status = status;
    const ratified = parseRatification(entry.body);
    if (ratified !== null) item.ratified = ratified;
    if (entry.supersedes.length > 0) item.supersedes = entry.supersedes;
    if (entry.supersededBy !== undefined) item.supersededBy = entry.supersededBy;
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
    const mark = entry.supersededBy !== undefined ? ` — superseded by ${entry.supersededBy}` : '';
    parts.push(`\n## [${entry.datetime}]${mark}\n${entry.body.trimEnd()}\n`);
  }
  return parts.join('');
}
