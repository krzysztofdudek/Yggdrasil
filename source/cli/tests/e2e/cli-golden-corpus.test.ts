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
