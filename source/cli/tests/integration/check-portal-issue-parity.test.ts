/**
 * `yg check` and the portal report one check, so they state the same findings.
 *
 * A warning the command line added to its report AFTER the check ran — the
 * reason-less `yg-suppress` marker was one — reached `yg check` and never the
 * portal worklist, and the gate itself depended on the portal's facade to find
 * it. The warning is now the check's own, from an injected scan every surface
 * hands it. On a real fixture carrying such a marker, the codes `yg check
 * --json` reports equal the codes the portal worklist lists, and no command
 * module reaches into the portal facade's own modules for the suppression scan.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPortalData } from '../../src/portal/extract.js';
import { copyFixtureTree } from '../support/fixture-copy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../fixtures/portal-basic');
const SRC = path.resolve(__dirname, '../../src');
const BIN_PATH = path.resolve(__dirname, '../../dist/bin.js');

function env(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' };
  for (const k of ['FORCE_COLOR', 'CI', 'GITHUB_ACTIONS']) delete e[k];
  return e;
}

describe.skipIf(!existsSync(BIN_PATH))('yg check and the portal worklist state the same findings', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'yg-check-portal-'));
    copyFixtureTree(FIXTURE, dir);
    // A waiver with no reason in a mapped source: it waives nothing, and both surfaces must say so.
    const file = path.join(dir, 'src/users/users.service.ts');
    writeFileSync(file, `// yg-suppress(no-todo-comments)\n${readFileSync(file, 'utf-8')}`);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the codes yg check --json reports are the codes the portal worklist lists, the reason-less marker included', async () => {
    const out = spawnSync('node', [BIN_PATH, 'check', '--json', '--no-approve'], { cwd: dir, encoding: 'utf-8', timeout: 90_000, env: env() });
    const doc = JSON.parse(out.stdout) as { issues: Array<{ code: string }> };
    const checkCodes = [...new Set(doc.issues.map((i) => i.code))].sort();

    const data = await extractPortalData(dir, { writeEnabled: false });
    const portalCodes = [...new Set([...data.worklist.map((g) => g.code), ...data.worklistCoverage.map((c) => c.code)])].sort();

    expect(checkCodes).toContain('suppress-marker-missing-reason');
    expect(portalCodes).toEqual(checkCodes);
  }, 120_000);

  it('no command module imports the suppression scan from the portal facade', () => {
    const offenders = readdirSync(path.join(SRC, 'cli'))
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /from '\.\.\/portal\/api\/suppress-(?:scan|eligibility|coverage|format)\.js'/.test(readFileSync(path.join(SRC, 'cli', f), 'utf-8')));
    expect(offenders).toEqual([]);
  });

  it('the gate imports nothing from the portal at all', () => {
    const check = readFileSync(path.join(SRC, 'cli/check.ts'), 'utf-8');
    expect(check).not.toMatch(/from '\.\.\/portal\//);
  });
});
