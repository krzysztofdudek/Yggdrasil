/**
 * source/cli/src/core/log/type-log.ts — a node type's own decision log.
 *
 * A node's log says why that one component is the way it is. Some decisions are
 * not about one component: "every handler validates its input at the boundary,
 * not in the service" is true of every node of the type, and an agent about to
 * touch any of them has to know it. Written into one node's log it reaches
 * nobody else; written into all of them it drifts. So a type keeps a log of its
 * own, for explicit decisions about the whole area the type stands for.
 *
 * Where it lives: `.yggdrasil/types/<type>/log.md`. Every other subject keeps
 * its log in a directory named for it, under a folder named for its kind —
 * `model/<node>/log.md`, `aspects/<rule>/log.md` — and a type gets the same: a
 * type is declared in the single `yg-architecture.yaml`, which cannot hold a log
 * without every decision becoming an edit of the architecture (and every
 * architecture edit a merge conflict with every decision). One file per type
 * also keeps two branches that record decisions about different types from ever
 * touching the same file. Nothing under `types/` is part of the graph: the loader
 * never reads it, coverage never counts it, and no verdict folds it in.
 *
 * It is held to what a node's log is held to — the same entry composer, the same
 * append-only baseline (in the committed `yg-lock.types.json`), the
 * same format and conflict checks in `yg check`, the same `yg log merge-resolve`.
 * The one difference is WHEN the baseline moves: a type has no verdicts, so there
 * is no closure to record it at; it is recorded by the add itself, after checking
 * that the history it is about to extend is still the one last recorded.
 *
 * It is never required. No type can demand an entry, and an entry invalidates no
 * verdict.
 */

import path from 'node:path';

import type { Graph } from '../../model/graph.js';
import type { CodedIssueMessage } from '../../model/validation.js';
import type { LockTypeEntry } from '../../model/lock.js';
import { readLogSafe, statLogFile, withLogWriteLock, writeLogFile } from '../../io/log-store.js';
import { readTypeLock, writeTypeLock, LockInvalidError } from '../../io/lock-store.js';
import { parseLog } from '../parsing/log-parser.js';
import { validateFormat, logHasConflictMarkers } from '../log-format.js';
import { validateAppendOnly, restoreLogStep } from '../log-integrity.js';
import { walkTypeParentChain } from '../type-effective.js';
import { composeLogEntry } from './log-entry.js';
import { computeLogBaselineFromContent } from './log-gate.js';
import { withStanding, type EntryStanding } from './log-supersedes.js';
import { debugWrite } from '../../utils/debug-log.js';

/** The directory under `.yggdrasil/` that holds the type logs, one directory per type. */
export const TYPE_LOGS_DIR = 'types';

/**
 * True when a type id can name a directory of its own: one path segment, not
 * hidden, no separator. Type ids are YAML keys and may in principle be anything;
 * one that is not a plain segment gets no log rather than a path that climbs out
 * of `types/` or nests inside another type's directory.
 */
export function typeLogNameUsable(typeId: string): boolean {
  return typeId !== '' && !typeId.startsWith('.') && !/[/\\\0]/.test(typeId);
}

/** The type log's path relative to the project root, in POSIX form (what messages show). */
export function typeLogRelPath(typeId: string): string {
  return `.yggdrasil/${TYPE_LOGS_DIR}/${typeId}/log.md`;
}

/** Absolute path of a type's log. */
function typeLogAbsPath(yggRootPath: string, typeId: string): string {
  return path.join(yggRootPath, TYPE_LOGS_DIR, typeId, 'log.md');
}

/** Own-key lookup: a bare bracket read would find `constructor` on every architecture. */
function typeExists(graph: Graph, typeId: string): boolean {
  return Object.prototype.hasOwnProperty.call(graph.architecture.node_types, typeId);
}

/**
 * The refusal for a `--type` that names nothing loggable, or null when the type
 * exists and can have a log.
 */
export function typeLogTargetRefusal(graph: Graph, typeId: string): CodedIssueMessage | null {
  if (!typeExists(graph, typeId)) {
    return {
      code: 'type-not-found',
      what: `node type '${typeId}' is not defined in yg-architecture.yaml`,
      why: 'A type log records decisions about the nodes of one type, so the type has to exist before anything can be written to or read from its log.',
      next: 'yg impact --type <type> names a type the architecture defines; read .yggdrasil/yg-architecture.yaml for the list.',
    };
  }
  if (!typeLogNameUsable(typeId)) {
    return {
      code: 'command-error',
      what: `node type '${typeId}' cannot have a log: its name is not a single path segment`,
      why: `A type log lives in a directory named after the type (${typeLogRelPath('<type>')}); a name with a path separator, or one starting with a dot, would put it somewhere else.`,
      next: 'Rename the type in yg-architecture.yaml to letters, digits, dots, dashes and underscores.',
    };
  }
  return null;
}

/**
 * The outcome of an add. Both sides carry `inForce`: the decisions in force
 * for the type and the types above it that the writer faced — before the entry
 * on a refusal, the ones it was added beside on success — so the command can
 * put them in front of whoever writes the next one.
 */
export type TypeLogAddResult =
  | { ok: true; datetime: string; logPath: string; inForce: TypeDecisions[] }
  | { ok: false; error: CodedIssueMessage; inForce?: TypeDecisions[] };

/**
 * Append one entry to a type's log and record the new baseline.
 *
 * Before appending, the log is checked against the baseline recorded last time:
 * an add moves the baseline forward, so appending to a log whose recorded
 * history was rewritten (or is still conflict-markered after a merge) would
 * record the rewrite as the new truth. Such a log is refused with the code
 * `yg check` reports it under, and the same fix.
 */
export async function appendTypeLogEntry(input: {
  graph: Graph;
  typeId: string;
  reasonText: string;
  nowMs: number;
  supersedes?: readonly string[];
  /**
   * The writer's answer to the decisions already in force: true means "this
   * adds to them, it replaces none". Required, like `supersedes`, whenever any
   * decision is in force for the type or a type above it.
   */
  adds?: boolean;
}): Promise<TypeLogAddResult> {
  const { graph, typeId } = input;
  const refused = typeLogTargetRefusal(graph, typeId);
  if (refused !== null) return { ok: false, error: refused };

  const logAbs = typeLogAbsPath(graph.rootPath, typeId);
  const logRel = typeLogRelPath(typeId);
  const stats = await statLogFile(logAbs);
  if (stats !== null && (stats.isSymbolicLink || stats.hardLinkCount > 1)) {
    return {
      ok: false,
      error: {
        code: 'command-error',
        what: `${logRel} is ${stats.isSymbolicLink ? 'a symbolic link' : 'hard-linked (st_nlink > 1)'}`,
        why: 'The log is replaced by an atomic rename, so a link would either receive the append somewhere other than where the log is read, or be broken by it — and its integrity baseline would describe a file that is not the one read.',
        next: `Replace ${logRel} with a regular file of its own, then re-run.`,
      },
    };
  }

  const locked = await withLogWriteLock(graph.rootPath, async (): Promise<TypeLogAddResult> => {
    let baselines: Record<string, LockTypeEntry>;
    try {
      baselines = readTypeLock(graph.rootPath);
    } catch (err) {
      if (err instanceof LockInvalidError) {
        debugWrite(`[type-log] appendTypeLogEntry: lock unreadable for type ${typeId}: ${err.message}`);
        return { ok: false, error: { ...err.messageData, code: 'lock-invalid' } };
      }
      throw err;
    }
    const existing = await readLogSafe(logAbs);
    const unsettled = unsettledLogRefusal(existing, baselines[typeId]?.log, typeId, logRel);
    if (unsettled !== null) return { ok: false, error: unsettled };

    // A decision written without having seen the ones already in force is how
    // two contradicting decisions both end up "in force". So whenever any is —
    // on this type or a type above it — the writer has to say what the new one
    // does to them: replace some (--supersedes) or add beside them (--adds).
    const inForce = (await typeDecisionCascade(graph, typeId)).filter((d) => d.entries.length > 0);
    const choseSupersedes = (input.supersedes ?? []).length > 0;
    if (inForce.length > 0 && !choseSupersedes && input.adds !== true) {
      const count = inForce.reduce((n, d) => n + d.entries.length, 0);
      return {
        ok: false,
        inForce,
        error: {
          code: 'type-log-choice-missing',
          what: `${count} decision${count === 1 ? ' is' : 's are'} already in force for type '${typeId}' and the types above it, and the new entry says nothing about ${count === 1 ? 'it' : 'them'}`,
          why: 'A decision written without regard to the ones in force can contradict one of them while both keep reading as in force; the writer, who has just seen them listed, is the one who knows whether the new decision replaces one or adds to them.',
          next: `yg log add --type ${typeId} --reason '<the decision>' --supersedes <datetime of the entry it replaces>  (or --adds when it replaces none)`,
        },
      };
    }

    const composed = composeLogEntry(existing, input.reasonText, input.nowMs, { supersedes: input.supersedes });
    if (!composed.ok) return { ok: false, error: { ...composed.error, code: composed.error.code ?? 'command-error' } };
    await writeLogFile(logAbs, composed.content);

    const baseline = computeLogBaselineFromContent(composed.content);
    if (baseline !== undefined) {
      // Only the type baselines' own file is written: a fill running beside
      // this add never writes that file, so neither write can undo the other.
      await writeTypeLock(graph.rootPath, { ...baselines, [typeId]: { log: baseline } });
    }
    return { ok: true, datetime: composed.datetime, logPath: logRel, inForce };
  });
  return locked.ok ? locked.value : { ok: false, error: { ...locked.error, code: 'command-error' } };
}

/** Why an existing type log may not be extended, or null when it may. */
function unsettledLogRefusal(
  content: string,
  baseline: { last_entry_datetime: string; prefix_hash: string } | undefined,
  typeId: string,
  logRel: string,
): CodedIssueMessage | null {
  if (content !== '' && logHasConflictMarkers(content)) {
    return {
      code: 'log-conflict',
      what: `${logRel} still contains git conflict markers`,
      why: 'Adding an entry records the log as it stands as its new baseline, so the merge that left the markers has to be reconciled first.',
      next: `yg log merge-resolve --type ${typeId}`,
    };
  }
  if (baseline !== undefined) {
    const check = validateAppendOnly(content, baseline.last_entry_datetime, baseline.prefix_hash);
    if (!check.ok) {
      return {
        code: 'log-integrity',
        what: `${logRel} no longer holds the history last recorded for it (${check.reason})`,
        why: 'Adding an entry moves the recorded baseline forward, so appending now would record a rewritten or truncated history as the truth.',
        next: `After a merge, yg log merge-resolve --type ${typeId}. Otherwise: ${restoreLogStep(logRel, '.yggdrasil/yg-lock.types.json')}`,
      };
    }
  }
  if (content !== '') {
    const violations = validateFormat(content);
    if (violations.length > 0) {
      return {
        code: 'log-format',
        what: `${logRel} format violation at line ${violations[0].line}: ${violations[0].reason}`,
        why: violations[0].detail,
        next: `Fix ${logRel} (or restore it from git) and re-run.`,
      };
    }
  }
  return null;
}

export type TypeLogReadResult =
  | { ok: true; entries: EntryStanding[] }
  | { ok: false; error: CodedIssueMessage };

/**
 * A type's log, every entry with its standing, oldest first. A type nobody has
 * written a decision for reads as no entries. A log whose format is broken is
 * refused rather than half-read.
 */
export async function readTypeLog(graph: Graph, typeId: string): Promise<TypeLogReadResult> {
  const refused = typeLogTargetRefusal(graph, typeId);
  if (refused !== null) return { ok: false, error: refused };
  const content = await readLogSafe(typeLogAbsPath(graph.rootPath, typeId));
  if (content === '') return { ok: true, entries: [] };
  const violations = validateFormat(content);
  if (violations.length > 0) {
    const logRel = typeLogRelPath(typeId);
    return {
      ok: false,
      error: {
        code: 'log-format',
        what: `${logRel} format violation at line ${violations[0].line}: ${violations[0].reason}`,
        why: violations[0].detail,
        next: `Fix ${logRel} (or restore it from git) and retry.`,
      },
    };
  }
  return { ok: true, entries: withStanding(parseLog(content)) };
}

/** The decisions in force for one type, as the context of a node of that type carries them. */
export interface TypeDecisions {
  typeId: string;
  /** Its log's entries that no later entry replaced, oldest first. */
  entries: EntryStanding[];
  /** Set when the log exists but cannot be read entry by entry (broken format). */
  unreadable?: string;
}

/**
 * The decisions in force for a type AND for every type above it — the reader
 * `yg context` uses to put area decisions in front of an agent. A decision
 * recorded on a type holds for the whole subtree of types below it, so the
 * cascade follows the type's implicit parent chain (`parents:` naming exactly
 * one type, the same chain rules are inherited along), nearest type first. A
 * type with nothing in force is left out; a log that does not parse is reported
 * as unreadable rather than silently skipped or thrown.
 */
export async function typeDecisionCascade(graph: Graph, typeId: string): Promise<TypeDecisions[]> {
  if (!typeExists(graph, typeId)) return [];
  const out: TypeDecisions[] = [];
  for (const id of [typeId, ...walkTypeParentChain(graph, typeId).chainTypeIds]) {
    if (!typeLogNameUsable(id)) continue;
    const read = await readTypeLog(graph, id);
    if (!read.ok) {
      out.push({ typeId: id, entries: [], unreadable: read.error.what });
      continue;
    }
    const inForce = read.entries.filter((e) => e.supersededBy === undefined);
    if (inForce.length > 0) out.push({ typeId: id, entries: inForce });
  }
  return out;
}
