// =============================================================================
// GUARD — every invariant the docs sell names the test that holds the CLI to it.
//
// The docs state invariants a reader builds on ("a package the check passes is
// one that installs", "`--approve` refuses to run over a conflicted log"). An
// invariant nothing tests is a promise that drifts: the 2026-09-25 surface
// audit found every one of these broken at some edge. The register in
// docs-claims.ts ties each to the sentence stating it and to its tests; this
// guard fails when the sentence is gone from its page, when a test is gone,
// or when a test no longer cites the sentence it protects in a
// `// Claim (docs/…): "…"` comment.
//
// Hermetic & fast: reads files; spawns nothing.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { CLI_ROOT, REPO_ROOT } from './issue-code-render.js';
import { AUDITED_INVARIANTS, DOCS_CLAIMS, flat } from './docs-claims.js';

const TESTS = path.join(CLI_ROOT, 'tests');

describe('every invariant the docs sell is held by a named test that cites it', () => {
  it('the register names each claim once, and covers every invariant the audit listed', () => {
    const ids = DOCS_CLAIMS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(AUDITED_INVARIANTS.filter((id) => !ids.includes(id))).toEqual([]);
  });

  for (const claim of DOCS_CLAIMS) {
    it(`${claim.id}: the sentence is on ${claim.page}, and each test exists and cites it`, () => {
      expect(flat(readFileSync(path.join(REPO_ROOT, claim.page), 'utf-8')), `${claim.page} no longer says: ${claim.quote}`).toContain(flat(claim.quote));
      expect(claim.tests.length).toBeGreaterThan(0);
      for (const t of claim.tests) {
        const file = path.join(TESTS, t.file);
        expect(existsSync(file), `${t.file} does not exist`).toBe(true);
        const text = readFileSync(file, 'utf-8');
        const at = text.indexOf(t.title);
        expect(at, `${t.file} has no test titled: ${t.title}`).toBeGreaterThan(-1);
        const citation = `// Claim (${claim.page}): "${claim.quote}"`;
        const cited = text.lastIndexOf(citation, at);
        expect(cited, `${t.file} does not cite, above "${t.title}":\n${citation}`).toBeGreaterThan(-1);
        // The citation belongs to this test: no other test opens between the two.
        expect(/\n\s*(?:it|test|describe)(?:\.each\([^)]*\))?\(/.test(text.slice(cited, text.lastIndexOf('\n', at))), `${t.file}: the citation above "${t.title}" is separated from it by another test`).toBe(false);
      }
    });
  }
});
