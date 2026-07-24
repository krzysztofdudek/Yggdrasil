import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { cliVersion } from '../../../src/cli/cli-version.js';

// Independent read of source/cli/package.json — NOT via cliVersion() itself —
// so the test has an oracle that does not share the code path under test.
const OWN_PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'package.json');

describe('cliVersion', () => {
  it('returns the same version string as source/cli/package.json', () => {
    const pkg = JSON.parse(readFileSync(OWN_PACKAGE_JSON, 'utf-8')) as { version: string };
    expect(cliVersion()).toBe(pkg.version);
  });

  it('returns a non-empty semver-shaped string', () => {
    expect(cliVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
