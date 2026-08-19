import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRootsIndex, parseAndExtractAll } from '../../../src/roots/pipeline.js';
import { assertGoldenBundleEquivalence } from '../../support/roots-golden.js';
import { withBuiltGolden } from '../helpers/roots-golden-fixture.js';
import { defaultRootsConfig } from '../helpers/roots-config.js';
import { buildPythonGoldenSpec } from '../../fixtures/roots/golden/python/spec.js';

// ---------------------------------------------------------------------------
// tests/unit/roots/golden-python.test.ts — the Python golden, deliberately
// ROLE-RICH (see tests/fixtures/roots/golden/python/spec.ts's own header):
// the one golden `tests/unit/roots/golden-controls.test.ts`'s NULL CONTROL
// runs against, because it produces genuine role-conditioned FACTS for a
// shuffled-label null to meaningfully destroy — a role-free golden's null
// control would report the same "0 accepted role conventions" whether or
// not the shuffle actually ran.
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE_PATH = path.join(__dirname, '../../fixtures/roots/golden/python/python.bundle');

describe('golden: python — builder spec <-> committed bundle equivalence', () => {
  it('the committed bundle still matches what the builder spec produces', () => {
    expect(() => assertGoldenBundleEquivalence(buildPythonGoldenSpec(), BUNDLE_PATH)).not.toThrow();
  });
});

describe('golden: python — MUST-mine / MUST-NOT-mine (design §13.2)', () => {
  it('clears spec §6.8\'s 300-scope floor with real margin (480 raw scopes: 60 packages * 2 files * (1 type + 2 method + 1 file) = 480, a 60% margin over the 300 floor)', async () => {
    const config = await defaultRootsConfig();
    await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const { rawScopes } = await parseAndExtractAll(repoRoot, config);
      expect(rawScopes.length).toBe(480);
    });
  });

  it('mines ROLE-CONDITIONED conventions the partition average does not state: auto.call:db.execute is `true` for the find_by_id/save_record roles and `false` for the validate_input/process_request roles, while `_all:method`\'s own auto.call:db.execute never appears at all (the exact 50/50 partition-wide split spec §9.4a\'s baseline is built to stay silent on)', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      return result.body.partitions.flatMap((p) => p.facts);
    });

    const roleConditioned = facts.filter((f) => f.surface === 'auto.call:db.execute' && f.appliesKind === 'method' && f.roleKey !== '_all' && !f.roleKey.startsWith('d['));
    // Four roles carry this surface (find_by_id, save_record — expected
    // true; validate_input, process_request — expected false): every one
    // of them is a real, ACCEPTED role-conditioned fact.
    expect(roleConditioned.length).toBe(4);
    expect(roleConditioned.some((f) => f.expected === 'true')).toBe(true);
    expect(roleConditioned.some((f) => f.expected === 'false')).toBe(true);

    // The partition-wide `_all` cell sees the identical surface at an exact
    // 50/50 split (two of four method roles call it, two don't) and never
    // accepts it — the role-conditioned-vs-partition-average contrast this
    // golden exists to demonstrate.
    expect(facts.some((f) => f.surface === 'auto.call:db.execute' && f.roleKey === '_all')).toBe(false);
  });

  it('MUST-NOT-mine: the deliberate 50/50 arity split (find_by_id/validate_input take 2 params, save_record/process_request take 1 — 120/120 at `_all:method`) never mines an auto.arity fact', async () => {
    const config = await defaultRootsConfig();
    const facts = await withBuiltGolden(buildPythonGoldenSpec(), async (repoRoot) => {
      const result = await runRootsIndex(repoRoot, config, []);
      return result.body.partitions.flatMap((p) => p.facts);
    });
    expect(facts.some((f) => f.surface === 'auto.arity')).toBe(false);
  });
});
