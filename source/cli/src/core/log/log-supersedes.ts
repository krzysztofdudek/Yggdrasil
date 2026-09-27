/**
 * source/cli/src/core/log/log-supersedes.ts — which entries of a log are still
 * in force.
 *
 * A log is append-only: nothing written into it is ever edited or removed. That
 * is right for a history, and wrong for a reader who only wants to know what
 * holds NOW — a decision taken in March and replaced in June would otherwise
 * read as two decisions that contradict each other. So an entry can name an
 * earlier entry of the same log that it replaces. Both stay in the file, byte
 * for byte; a reader that wants the decisions in force skips the replaced one,
 * and a reader that wants the history sees both, the older one marked.
 *
 * The reference is written into the new entry's own text, as its opening
 * lines, one per replaced entry — the same `### Supersedes:` heading the log
 * convention asked for by hand before `yg log add --supersedes` existed, so an
 * entry written that way reads exactly like one the flag wrote:
 *
 *     ## [2026-09-27T10:00:00.000Z]
 *     ### Supersedes: 2026-06-02T08:15:00.000Z
 *
 *     <the entry text>
 *
 * Kept in the text rather than anywhere beside it, so the file alone says what
 * replaced what — a clone, a merge and a `git log -p` all carry it, and the
 * append-only integrity hash covers it like every other byte of the entry.
 *
 * Pure: every function here takes entries or text and returns data.
 */

/** The opening of a line that names a replaced entry. */
const SUPERSEDES_PREFIX = '### Supersedes: ';

const STRICT_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,3}Z$/;

/**
 * The datetimes an entry body names as replaced: its leading `### Supersedes:`
 * lines, in order, up to the first line that is not one. A line whose value is
 * not a strict entry datetime ends the run — it is prose that happens to start
 * with the word, not a reference.
 */
function supersedesOf(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (!line.startsWith(SUPERSEDES_PREFIX)) break;
    const value = line.slice(SUPERSEDES_PREFIX.length).trim();
    if (!STRICT_DATETIME.test(value)) break;
    out.push(value);
  }
  return out;
}

/** The body an entry replacing `targets` carries: one line per target, a blank line, then the text. */
export function bodyWithSupersedes(targets: readonly string[], text: string): string {
  if (targets.length === 0) return text;
  return `${targets.map((t) => `${SUPERSEDES_PREFIX}${t}`).join('\n')}\n\n${text}`;
}

/** One entry with its standing in the log: what it replaces, and what replaced it. */
export interface EntryStanding {
  /** ISO 8601 UTC timestamp — the entry header, verbatim. */
  datetime: string;
  /** Everything under the header, verbatim (the `### Supersedes:` lines included). */
  body: string;
  /** The entries this one replaces, by datetime. Empty when it replaces none. */
  supersedes: string[];
  /** The datetime of the later entry that replaced this one; absent while it is in force. */
  supersededBy?: string;
}

/**
 * Every entry, in file order, with what it replaces and what replaced it. A
 * reference to a datetime the log does not hold replaces nothing: only an
 * entry that is really there can be taken out of force (a line written by hand
 * is not checked when it is written, so this is where it is held to that). An
 * entry can only replace one written before it. When two later entries
 * both name the same one, the earlier of them is the one that replaced it.
 */
export function withStanding(entries: ReadonlyArray<{ datetime: string; body: string }>): EntryStanding[] {
  const replacedBy = new Map<string, string>();
  const out: EntryStanding[] = entries.map((e) => ({ datetime: e.datetime, body: e.body, supersedes: supersedesOf(e.body) }));
  const seen = new Set<string>();
  for (const e of out) {
    for (const target of e.supersedes) {
      if (seen.has(target) && !replacedBy.has(target)) replacedBy.set(target, e.datetime);
    }
    seen.add(e.datetime);
  }
  for (const e of out) {
    const by = replacedBy.get(e.datetime);
    if (by !== undefined) e.supersededBy = by;
  }
  return out;
}

/**
 * Entries that more than one entry still in force claims to have replaced —
 * the shape a merge leaves when two branches each superseded the same
 * decision. One writer cannot produce it (a replaced entry cannot be replaced
 * again), so it is always two decisions that never saw each other, and which of
 * them holds is a question only a person can answer. Settled by an entry that
 * supersedes the competing successors, after which they are no longer in force.
 */
export function competingSuccessors(entries: readonly EntryStanding[]): Array<{ target: string; successors: string[] }> {
  const present = new Set(entries.map((e) => e.datetime));
  const byTarget = new Map<string, string[]>();
  for (const e of entries) {
    if (e.supersededBy !== undefined) continue;
    for (const target of e.supersedes) {
      if (!present.has(target) || target >= e.datetime) continue;
      byTarget.set(target, [...(byTarget.get(target) ?? []), e.datetime]);
    }
  }
  return [...byTarget].filter(([, s]) => s.length > 1).map(([target, successors]) => ({ target, successors }));
}

/**
 * Why an entry cannot replace the ones it names, or null when it can: every
 * target must be an entry already in this log, and one still in force — an
 * entry already replaced is replaced by the entry that replaced it, and naming
 * it a second time would leave two entries each claiming to be its successor.
 */
export function supersedesRefusal(
  existing: readonly EntryStanding[],
  targets: readonly string[],
): { code: 'log-supersedes-unknown' | 'log-supersedes-superseded'; target: string; by?: string } | null {
  const byDatetime = new Map(existing.map((e) => [e.datetime, e] as const));
  for (const target of targets) {
    const entry = byDatetime.get(target);
    if (entry === undefined) return { code: 'log-supersedes-unknown', target };
    if (entry.supersededBy !== undefined) return { code: 'log-supersedes-superseded', target, by: entry.supersededBy };
  }
  return null;
}
