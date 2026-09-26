/**
 * source/cli/src/utils/known-keys.ts — the one reading of "a key this block does
 * not know", shared by every graph and configuration file parser.
 *
 * A key the schema does not declare is almost always a typo (`relation` for
 * `relations`, `stauts` for `status`), and a parser that ignored it would drop
 * whatever the key was meant to set without a word — an intended rule, relation
 * or setting quietly out of effect while the check still passes. So every block
 * of every file names the keys it accepts, and each parser refuses any other one
 * through this module, with the nearest accepted key when there is a plausible
 * one.
 *
 * Pure: no IO, no parser state. Each parser keeps its own list of accepted keys
 * beside the code that reads them.
 */

/**
 * Edit distance between two key names, counting an insertion, a deletion, a
 * substitution or a swap of two adjacent characters as one edit (optimal string
 * alignment) — so `modle` is one edit from `model`, as a reader would count it.
 * Small inputs only (key names).
 */
export function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/**
 * The accepted key `key` is plausibly a typo of, or undefined when none is close
 * enough: at most a third of the key's length away, and never more than three
 * edits. Compared case-insensitively, so `Relations` still points at `relations`.
 */
export function closestKnownKey(key: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const candidate of known) {
    const d = editDistance(key.toLowerCase(), candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best !== undefined && bestDistance <= Math.min(3, Math.max(1, Math.floor(key.length / 3))) ? best : undefined;
}

/**
 * One key a block does not accept: the accepted key it is plausibly a typo of,
 * or — for a key an earlier release read and this one no longer does — what
 * became of it.
 */
export interface UnknownKey {
  key: string;
  suggestion?: string;
  retired?: string;
}

/**
 * Keys an earlier release accepted in a block and this one does not, each with
 * what became of it. A graph upgraded from that release can still carry them;
 * naming the retirement tells its owner to delete the line, where a did-you-mean
 * would send them looking for a typo.
 */
export type RetiredKeys = Readonly<Record<string, string>>;

/** Every key of `block` that is not in `known`, in the order the file wrote them. */
export function findUnknownKeys(block: Record<string, unknown>, known: readonly string[], retired: RetiredKeys = {}): UnknownKey[] {
  const found: UnknownKey[] = [];
  for (const key of Object.keys(block)) {
    if (known.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(retired, key)) {
      found.push({ key, retired: retired[key] });
      continue;
    }
    const suggestion = closestKnownKey(key, known);
    found.push({ key, ...(suggestion !== undefined && { suggestion }) });
  }
  return found;
}

/**
 * One sentence naming the unknown keys of `where`, each with its did-you-mean,
 * why they are refused, and the keys that are accepted — the text a parser puts
 * in the error it raises. `where` names the block (`node_types.service`,
 * `relations[0]`, …); an empty string means the top level of the file.
 */
export function describeUnknownKeys(where: string, unknown: readonly UnknownKey[], known: readonly string[]): string {
  const named = unknown
    .map((u) =>
      u.retired !== undefined
        ? `'${u.key}' (${u.retired} — delete it)`
        : u.suggestion !== undefined
          ? `'${u.key}' (did you mean '${u.suggestion}'?)`
          : `'${u.key}'`,
    )
    .join(', ');
  const noun = unknown.length === 1 ? 'key' : 'keys';
  const scope = where === '' ? '' : ` in ${where}`;
  return (
    `unknown ${noun} ${named}${scope}. ` +
    `A key the schema does not know would be ignored, so whatever it was meant to set would silently not be in effect. ` +
    `Accepted keys: ${known.join(', ')}.`
  );
}
