// =============================================================================
// GUARD — the wording policy: an absolute about what the CLI does is backed.
//
// "Writes nothing", "fills nothing at all", "never calls the reviewer", "never
// blocks", "zero false positives by design": each such sentence the 2026-09-25
// surface audit checked was false at an edge the code handles differently, and
// an adopter builds on the promise exactly there. So an absolute about an
// effect of the CLI (absolute-wording.ts says which words) may stand on the
// docs site, the README, a knowledge topic, the agent manual or a schema
// reference only when something backs it:
//
//   - a claim test: the sentence carries a claim the register in
//     docs-claims.ts ties to a test that holds the CLI to it; or
//   - a review: absolute-wording-reviewed.ts records a phrase of the sentence
//     and why the absolute holds at every edge (the code that guarantees it).
//
// Otherwise the sentence says what is true instead ("records no verdict",
// "writes no committed file"). A review that no longer names any sentence is
// stale and fails too, so the list only holds what the pages say today.
//
// Hermetic & fast: reads the pages and imports the knowledge, manual and schema
// modules; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { KNOWLEDGE_TOPICS } from '../../../src/templates/knowledge/index.js';
import { AGENT_RULES_CONTENT } from '../../../src/templates/rules.js';
import { SCHEMA_TOPICS } from '../../../src/templates/schemas/index.js';
import { REPO_ROOT } from './issue-code-render.js';
import { absolutes, sentences } from './absolute-wording.js';
import { REVIEWED_ABSOLUTES } from './absolute-wording-reviewed.js';
import { DOCS_CLAIMS, flat } from './docs-claims.js';

/** Every surface the policy covers, by name, with its text. */
function surfaces(): Array<[string, string]> {
  const docs = path.join(REPO_ROOT, 'docs');
  return [
    ...readdirSync(docs).filter((f) => f.endsWith('.md')).map((f): [string, string] => [`docs/${f}`, readFileSync(path.join(docs, f), 'utf-8')]),
    ['README.md', readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf-8')],
    ...Object.entries(KNOWLEDGE_TOPICS).map(([name, t]): [string, string] => [`yg knowledge read ${name}`, t.content]),
    ['yg prime', AGENT_RULES_CONTENT],
    ...Object.entries(SCHEMA_TOPICS).map(([name, t]): [string, string] => [`yg schemas read ${name}`, t.content]),
  ];
}

/** Whether a sentence carries a claim the register ties to a test, or a reviewed phrase. */
function backed(sentence: string): boolean {
  return DOCS_CLAIMS.some((c) => sentence.includes(flat(c.quote)) || flat(c.quote).includes(sentence)) || REVIEWED_ABSOLUTES.some((r) => sentence.includes(r.phrase));
}

describe('an absolute about what the CLI does is backed by a claim test or a review', () => {
  it('every absolute on every surface is backed', () => {
    const unbacked = surfaces().flatMap(([where, text]) => absolutes(text).filter((s) => !backed(s)).map((s) => `  ${where}: ${s}`));
    expect(
      unbacked,
      `an absolute nothing backs — say what is true instead, tie it to a claim test (docs-claims.ts), or review it (absolute-wording-reviewed.ts):\n${unbacked.join('\n')}`,
    ).toEqual([]);
  });

  it('every review names a sentence the surfaces still carry, and says why', () => {
    const all = surfaces().flatMap(([, text]) => absolutes(text));
    for (const r of REVIEWED_ABSOLUTES) {
      expect(r.why.trim(), r.phrase).not.toBe('');
      expect(all.some((s) => s.includes(r.phrase)), `a stale review — no absolute on any surface reads: ${r.phrase}`).toBe(true);
    }
  });

  it('reads a hard-wrapped paragraph as sentences, leaves samples out, and catches a new absolute', () => {
    expect(sentences('The run records\nno verdict. It then stops.\n\n```text\nwrites nothing\n```\n')).toEqual(['The run records no verdict.', 'It then stops.']);
    expect(absolutes('Plain `yg check` writes nothing to the repository.').filter((s) => !backed(s))).toEqual(['Plain `yg check` writes nothing to the repository.']);
    expect(absolutes('Never invent a reason for a log entry.')).toEqual([]);
  });
});
