/**
 * verdict-response corpus runner — the reviewer-reply analog of the relation
 * catalogue runner (in @chrisdudek/runes). Its SOLE input is the reference catalogue
 * `reference/llm-aspect-verdict-responses/<id>.md`: each doc is ONE raw reviewer
 * reply (the `## Input` fence, verbatim) plus its asserted parse outcome
 * (`## Expect`). Drive parseAspectResponse over every case — add a `.md`, get a
 * test. The generic reference/doc-shape + reference/layout aspects keep the docs
 * well-shaped; this runner keeps them true.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAspectResponse } from '../../../src/llm/cli-base.js';

const CATALOGUE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../reference/llm-aspect-verdict-responses',
);

interface CaseDoc {
  id: string;
  expectation: 'verdict' | 'infra' | 'undefined';
  input: string;
  expect: Record<string, string>;
}

function field(frontmatter: string, key: string): string {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(frontmatter);
  return m ? m[1].trim() : '';
}

function parseCase(file: string): CaseDoc {
  const content = readFileSync(file, 'utf8');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(content);
  if (!fm) throw new Error(`${file}: missing frontmatter`);
  const frontmatter = fm[1];

  // The `## Input` fence is 4 backticks so a reply that itself contains a
  // ```json fence embeds cleanly. Content is verbatim (parseAspectResponse trims).
  const inputMatch = /##\s*Input\s*\n+````[a-zA-Z]*\n([\s\S]*?)````/.exec(content);
  if (!inputMatch) throw new Error(`${file}: missing 4-backtick Input fence`);

  const expectBlock = content.slice(content.indexOf('## Expect') + '## Expect'.length);
  const expectMap: Record<string, string> = {};
  for (const line of expectBlock.split('\n')) {
    const m = /^-\s*([a-z_]+)\s*:\s*(.+)$/.exec(line.trim());
    if (m) expectMap[m[1]] = m[2].trim();
  }

  return {
    id: field(frontmatter, 'id'),
    expectation: field(frontmatter, 'expectation') as CaseDoc['expectation'],
    input: inputMatch[1],
    expect: expectMap,
  };
}

const docs = readdirSync(CATALOGUE)
  .filter((f) => f.endsWith('.md'))
  .sort()
  .map((f) => parseCase(path.join(CATALOGUE, f)));

describe('parseAspectResponse — reference/llm-aspect-verdict-responses catalogue', () => {
  it('the catalogue is non-empty (a deleted catalogue must not silently pass)', () => {
    expect(docs.length).toBeGreaterThan(0);
  });

  for (const doc of docs) {
    it(`${doc.id}`, () => {
      const out = parseAspectResponse(doc.input);

      if (doc.expectation === 'undefined' || doc.expect.result === 'undefined') {
        expect(out, `${doc.id}: expected undefined`).toBeUndefined();
        return;
      }

      expect(out, `${doc.id}: expected a parsed result`).toBeDefined();
      if (doc.expect.error_source) expect(out!.errorSource).toBe(doc.expect.error_source);
      if (doc.expect.satisfied) expect(out!.satisfied).toBe(doc.expect.satisfied === 'true');
      if (doc.expect.reason_includes) expect(out!.reason).toContain(doc.expect.reason_includes);
    });
  }
});
