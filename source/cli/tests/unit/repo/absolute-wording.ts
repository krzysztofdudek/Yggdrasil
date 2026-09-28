// The wording policy's reader: the absolute claims a surface makes about what
// the CLI does, sentence by sentence — shared by the guard that holds each one
// to a test or a review (absolute-wording.test.ts). Reads nothing and writes
// nothing.
//
// The policy is about one kind of absolute: a claim that a command or mode has
// no effect of some kind — "writes nothing", "fills nothing at all", "never
// calls the reviewer", "never blocks", "zero false positives by design", "only
// verifies". Each such sentence the 2026-09-25 surface audit checked was false
// at some edge the code handles differently (a gitignored cache written, a
// prompt-too-large that blocks), and the edge is where an adopter builds on
// the promise. Guidance that happens to use "never" or "only" ("never invent
// a reason") is an instruction, not a claim about the CLI, and is out of
// scope.

/** An absolute about an effect of the CLI. */
export const ABSOLUTE =
  /\bnothing at all\b|\b(?:writes|fills|records|changes|touches|modifies|costs|sends|reads|calls) nothing\b|\bnever (?:calls|writes|touches|modifies|sends|runs|reads|fills|records|changes|blocks|fails)\b|\bzero\b[^.]{0,40}\bby design\b|\bonly verifies\b|\bnothing is (?:written|recorded|filled|changed|sent)\b/i;

/**
 * The sentences of a markdown text, each on one line: fenced blocks are left
 * out (a sample prints what it prints), a hard-wrapped paragraph reads as one
 * line, and a paragraph splits at the end of each sentence.
 */
export function sentences(text: string): string[] {
  const kept: string[] = [];
  let fenced = false;
  for (const line of text.split('\n')) {
    if (/^\s*(?:`{3,}|~{3,})/.test(line)) {
      fenced = !fenced;
      kept.push('');
      continue;
    }
    kept.push(fenced ? '' : line);
  }
  return kept
    .join('\n')
    .split(/\n\s*\n/)
    .flatMap((para) => para.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+(?=[A-Z`*(])/))
    .filter((s) => s !== '');
}

/** The sentences of a text that make an absolute claim about the CLI. */
export function absolutes(text: string): string[] {
  return sentences(text).filter((s) => ABSOLUTE.test(s));
}

/** One reviewed absolute: a phrase of the sentence, and why the absolute holds without a qualifier. */
export interface ReviewedAbsolute {
  /** A phrase of the sentence as it reads on one line, specific enough to name only it. */
  phrase: string;
  /** Why the absolute is true at every edge: the code that guarantees it, or the test that holds it. */
  why: string;
}
