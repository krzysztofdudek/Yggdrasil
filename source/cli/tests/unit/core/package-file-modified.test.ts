// =============================================================================
// Unit — the rail that keeps a copied rule a copy.
//
// Three things are refused, and one is deliberately never looked at:
//
//   1. a recorded file whose content moved
//   2. a recorded file that is gone
//   3. a file among the copies that no installed package recorded  ← the one with teeth
//   4. the repository's own yg-aspect.adapt.yaml — never recorded, never judged
//
// Plus the two empty states, which must cost nothing and say nothing: no
// packages installed, and no packages directory at all.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkPackageFilesModified, PACKAGE_FILE_MODIFIED } from '../../../src/core/checks/packages.js';
import { hashFile } from '../../../src/io/hash.js';
import type { Graph } from '../../../src/model/graph.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const INSTALL = 'acme/law/demo';
const RULE_REL = `packages/${INSTALL}/rule-a/check.mjs`;
const RULE_BODY = 'export function check() { return []; }\n';

/** Only the two fields this check reads. */
function graphAt(root: string): Graph {
  return { rootPath: join(root, '.yggdrasil') } as unknown as Graph;
}

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'yg-pkg-rail-'));
  tempDirs.push(root);
  mkdirSync(join(root, '.yggdrasil'), { recursive: true });
  return root;
}

/** Write the copied rule and return the sha the record should carry. */
async function installRule(root: string, body = RULE_BODY): Promise<string> {
  const abs = join(root, '.yggdrasil', 'aspects', ...RULE_REL.split('/'));
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, body, 'utf-8');
  return hashFile(abs);
}

function writeLock(root: string, files: Record<string, string>): void {
  const entries = Object.entries(files)
    .map(([p, h]) => `      ${JSON.stringify(p)}: ${JSON.stringify(h)}`)
    .join('\n');
  writeFileSync(
    join(root, '.yggdrasil', 'yg-packages.yaml'),
    `schema: yg-packages/1
packages:
  demo:
    source: https://example.test/acme/law.git
    package: ${INSTALL}
    version: 0.1.0
    installed_at: 2026-09-10T00:00:00.000Z
    files:
${entries === '' ? '' : `${entries}\n`}`.replace(/files:\n$/, 'files: {}\n'),
    'utf-8',
  );
}

describe('checking an installed package against what it published', () => {
  it('says nothing when every recorded file is what it was', async () => {
    const root = newRepo();
    writeLock(root, { [RULE_REL]: await installRule(root) });
    expect(await checkPackageFilesModified(graphAt(root))).toEqual([]);
  });

  it('refuses an edited file, naming it and pointing at the adaptation', async () => {
    const root = newRepo();
    const sha = await installRule(root);
    writeLock(root, { [RULE_REL]: sha });
    await installRule(root, `${RULE_BODY}// mine\n`);

    const issues = await checkPackageFilesModified(graphAt(root));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe(PACKAGE_FILE_MODIFIED);
    expect(issues[0].severity).toBe('error');
    // The two literals an agent needs: which file, and where to put the change.
    expect(issues[0].messageData.what).toContain(`.yggdrasil/aspects/${RULE_REL}`);
    expect(issues[0].messageData.next).toContain('yg-aspect.adapt.yaml');
  });

  it('refuses a recorded file that is gone, with a different message', async () => {
    const root = newRepo();
    writeLock(root, { [RULE_REL]: 'a'.repeat(64) });

    const issues = await checkPackageFilesModified(graphAt(root));
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain('is missing');
    expect(issues[0].messageData.what).toContain(RULE_REL);
  });

  it('refuses a file no installed package put there', async () => {
    // The case with teeth: dropping your own rule script beside someone else's is
    // how a rule nobody agreed to would wear a package's name.
    const root = newRepo();
    writeLock(root, { [RULE_REL]: await installRule(root) });
    const smuggled = join(root, '.yggdrasil', 'aspects', 'packages', ...INSTALL.split('/'), 'rule-a', 'extra.mjs');
    writeFileSync(smuggled, 'export function check() { return []; }\n', 'utf-8');

    const issues = await checkPackageFilesModified(graphAt(root));
    expect(issues).toHaveLength(1);
    expect(issues[0].messageData.what).toContain('extra.mjs');
    expect(issues[0].messageData.what).toContain('no installed package put it there');
  });

  it("never objects to the repository's own adaptation, however much it changed", async () => {
    // It is the one place a repository is MEANT to write. Objecting to it would
    // leave nowhere to adapt a rule at all.
    const root = newRepo();
    writeLock(root, { [RULE_REL]: await installRule(root) });
    writeFileSync(
      join(root, '.yggdrasil', 'aspects', 'packages', ...INSTALL.split('/'), 'rule-a', 'yg-aspect.adapt.yaml'),
      'status: advisory\nconfig:\n  threshold: 40\n',
      'utf-8',
    );
    expect(await checkPackageFilesModified(graphAt(root))).toEqual([]);
  });

  it('says nothing when nothing is installed', async () => {
    const root = newRepo();
    writeFileSync(join(root, '.yggdrasil', 'yg-packages.yaml'), 'schema: yg-packages/1\npackages: {}\n', 'utf-8');
    expect(await checkPackageFilesModified(graphAt(root))).toEqual([]);
  });

  it('says nothing in a repository that never had a package', async () => {
    // Both sides of the comparison are empty: no record, no directory.
    expect(await checkPackageFilesModified(graphAt(newRepo()))).toEqual([]);
  });

  it('blocks when the record itself cannot be read', async () => {
    // Reading a corrupted record as "nothing installed" would silently stop
    // checking every copied rule in the repository.
    const root = newRepo();
    writeFileSync(join(root, '.yggdrasil', 'yg-packages.yaml'), 'schema: yg-packages/99\npackages: {}\n', 'utf-8');
    const issues = await checkPackageFilesModified(graphAt(root));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe(PACKAGE_FILE_MODIFIED);
    expect(issues[0].messageData.why).toContain('no installed rule can be checked');
  });

  it('reports in the same order twice over, whatever the directory walk did', async () => {
    const root = newRepo();
    const sha = await installRule(root);
    writeLock(root, { [RULE_REL]: sha, [`packages/${INSTALL}/rule-b/content.md`]: 'b'.repeat(64) });
    await installRule(root, `${RULE_BODY}// mine\n`);

    const first = (await checkPackageFilesModified(graphAt(root))).map((i) => i.messageData.what);
    const second = (await checkPackageFilesModified(graphAt(root))).map((i) => i.messageData.what);
    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
  });
});
