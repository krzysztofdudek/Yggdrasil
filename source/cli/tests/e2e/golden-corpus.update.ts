// =============================================================================
// NOT A TEST — the developer command that rewrites the golden output corpus.
//
// The guard, tests/e2e/cli-golden-corpus.test.ts, re-runs every state and fails
// when a case's text differs from its committed file under
// tests/fixtures/golden-corpus/; it only reads. This module is where those files
// are written: `npm run golden:update` in source/cli runs it through
// vitest.update.config.ts (the only config that collects *.update.ts; `npm test`
// never runs it) and then runs the guard against what it wrote. Each state's
// directory ends up holding exactly the cases the state records: a case file no
// state records any more is removed. It records from the built CLI
// (dist/bin.js), so build first.
//
// The sibling of tests/unit/repo/generated-files.update.ts, which holds the
// other generated-file steps.
// =============================================================================

import { it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GOLDEN_CORPUS_DIR, GOLDEN_STATES, binPath, recordState } from '../support/golden-corpus.js';

it('golden:update', () => {
  if (!existsSync(binPath())) throw new Error(`${binPath()} does not exist — run npm run build first`);
  for (const state of GOLDEN_STATES) {
    const recorded = recordState(state);
    const dir = path.join(GOLDEN_CORPUS_DIR, state.name);
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) {
      if (!recorded.has(f.replace(/\.txt$/, ''))) rmSync(path.join(dir, f));
    }
    for (const [name, text] of recorded) writeFileSync(path.join(dir, `${name}.txt`), text, 'utf-8');
  }
}, 180_000 * GOLDEN_STATES.length);
