// =============================================================================
// Integration — the pre-publish check against real marketplaces on disk.
//
// The unit suite builds its trees in a temp directory and asserts one rule at a
// time. This one runs the same function over COMMITTED fixtures — the positive
// one that `yg pack` already installs from, and seven negatives that each carry
// exactly one fault. The isolation is the point: a fixture with two faults could
// pass this suite while the check that was supposed to catch the second one was
// broken.
//
//   1     the positive fixture — nothing refused
//   2-8   one negative fixture each — exactly one refusal, and its own code
//   9     the seven codes are seven different codes
// =============================================================================

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkMarketplace } from '../../src/core/marketplace-check.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const BAD = path.join(FIXTURES, 'marketplace-bad');

/** Every negative fixture, with the one code it exists to produce. */
const FAULTS: ReadonlyArray<readonly [string, string]> = [
  ['entry-without-dir', 'marketplace-entry-missing'],
  ['dir-without-entry', 'marketplace-dir-unlisted'],
  ['implies-escapes', 'package-implies-escapes'],
  ['config-undeclared', 'package-config-undeclared'],
  ['scope-literal-root', 'package-scope-literal-root'],
  ['review-by-present', 'package-review-by-present'],
  ['no-drills', 'package-drills-missing'],
];

describe('the pre-publish check over committed marketplaces', () => {
  it('1: the marketplace yg pack installs from is refused nothing', async () => {
    const result = await checkMarketplace(path.join(FIXTURES, 'marketplace-demo'));
    expect(result.errors).toEqual([]);
    // ONE warning, and it is the fixture saying what it was built to say. That
    // marketplace declares a setting its rule deliberately never reads, to prove
    // elsewhere that changing an unread setting re-opens no verdict. Read from
    // here, that same fact IS the declared-but-never-read warning — so the
    // fixture is not a counter-example to the rule, it is an instance of it.
    expect(result.warnings.map((w) => w.code)).toEqual(['package-config-unused']);
    expect(result.warnings[0].messageData.what).toContain('label');
  });

  for (const [index, [fixture, code]] of FAULTS.entries()) {
    it(`${index + 2}: ${fixture} is refused with ${code}, and nothing else`, async () => {
      const result = await checkMarketplace(path.join(BAD, fixture));
      expect(result.errors.map((e) => e.code)).toEqual([code]);
      expect(result.warnings).toEqual([]);
    });
  }

  it('9: the seven fixtures exercise seven distinct codes', () => {
    const codes = FAULTS.map(([, code]) => code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
