// =============================================================================
// The golden output corpus — see tests/support/golden-corpus.ts for what each
// state is and how its output is normalised.
//
// Every state is rebuilt from scratch and its cases re-run; each case's text
// must equal the committed file under tests/fixtures/golden-corpus/. A change
// to what the CLI says therefore fails here until the corpus is regenerated —
// on purpose: the regenerated files are the reviewable record of the change.
//
// Regenerate: `npm run golden:update` (sets YG_GOLDEN_UPDATE=1, which writes
// the files instead of comparing, and removes a case file no state records any
// more).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GOLDEN_STATES, binPath, recordState } from '../support/golden-corpus.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.join(__dirname, '..', 'fixtures', 'golden-corpus');
const UPDATE = process.env.YG_GOLDEN_UPDATE === '1';

describe.skipIf(!existsSync(binPath()))('golden output corpus', () => {
  for (const state of GOLDEN_STATES) {
    it(`${state.name}: every case matches the committed corpus`, () => {
      const recorded = recordState(state);
      const dir = path.join(CORPUS, state.name);
      if (UPDATE) {
        mkdirSync(dir, { recursive: true });
        for (const f of readdirSync(dir)) {
          if (!recorded.has(f.replace(/\.txt$/, ''))) rmSync(path.join(dir, f));
        }
        for (const [name, text] of recorded) writeFileSync(path.join(dir, `${name}.txt`), text, 'utf-8');
        return;
      }
      for (const [name, text] of recorded) {
        const file = path.join(dir, `${name}.txt`);
        expect(existsSync(file), `missing corpus file ${state.name}/${name}.txt — run npm run golden:update`).toBe(true);
        expect(text, `${state.name}/${name}.txt differs — review the change, then npm run golden:update`).toBe(readFileSync(file, 'utf-8'));
      }
    }, 180_000);
  }
});

// A block that groups findings across nodes states their shared fact once:
// its heading and its why never carry the `<node>` placeholder (only a fix
// may, with `for each node above`), and never a path the placeholder's words
// were substituted into (`…/model/each node/yg-node.yaml` names no file).
describe('golden output corpus — grouped headings and whys', () => {
  it('no heading, why, JSON subject or JSON why in the corpus carries <node> or a path with "each node" in it', () => {
    const offending: string[] = [];
    for (const state of readdirSync(CORPUS)) {
      for (const f of readdirSync(path.join(CORPUS, state))) {
        const lines = readFileSync(path.join(CORPUS, state, f), 'utf-8').split('\n');
        lines.forEach((l, i) => {
          const said = /^(error|warning)\[|^ {2}why: /.test(l) || /^\s*"(subject|why)": /.test(l);
          if ((said && l.includes('<node>')) || /each node\/|\/each node|the node\//.test(l)) offending.push(`${state}/${f}:${i + 1}: ${l.trim()}`);
        });
      }
    }
    expect(offending).toEqual([]);
  });
});
