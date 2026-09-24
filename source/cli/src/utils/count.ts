/**
 * A count and its noun, agreeing: `1 pair`, `2 pairs`, `0 pairs`.
 *
 * The one way a number of things is written anywhere in the CLI. It lives in
 * utils rather than in the command layer's output module (which re-exports
 * it), because the engine, the formatters, the relations subsystem and the
 * portal all write counted sentences too and may call utility but not the
 * command layer. Before it existed each of them hand-rolled the plural —
 * `${n} pair(s)`, `${n} file${n === 1 ? '' : 's'}`, or a bare `${n} nodes` that
 * read "1 nodes" — and the same fact read differently from place to place.
 */

/** `noun` or its plural, by `n`. The plural defaults to `noun + 's'`. */
export function plural(n: number, noun: string, pluralNoun = `${noun}s`): string {
  return n === 1 ? noun : pluralNoun;
}

/** `n` and its noun, agreeing: `1 pair`, `2 pairs`, `0 pairs`. */
export function count(n: number, noun: string, pluralNoun?: string): string {
  return `${n} ${plural(n, noun, pluralNoun)}`;
}
