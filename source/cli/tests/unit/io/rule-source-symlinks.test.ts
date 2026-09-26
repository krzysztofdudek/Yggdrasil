// Symbolic links in a rule's sources and references are refused, not followed.
//
// Before: a symlinked content.md made the aspect an enforced LLM rule (the
// presence check followed the link) while the artifact reader skipped it (a
// Dirent for a link is not isFile), so the reviewer saw an empty rule and
// approved; a symlinked check.mjs ran its target while hashing as nothing, so
// editing the target never invalidated a pass; a symlinked reference carried a
// file from outside the repository into the prompt.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { symlinkOnPath, ruleDirSymlinks } from '../../../src/io/artifact-reader.js';
import { checkAspectReferences } from '../../../src/core/checks/aspect-contracts.js';
import { STRUCTURAL_CODES, APPROVE_GATING_CODES } from '../../../src/core/check-codes.js';
import type { Graph } from '../../../src/model/graph.js';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A repository root with one aspect directory `.yggdrasil/aspects/<id>`. */
function repo(id: string): { root: string; aspectDir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-symlink-rule-'));
  roots.push(root);
  const aspectDir = path.join(root, '.yggdrasil', 'aspects', id);
  mkdirSync(aspectDir, { recursive: true });
  return { root, aspectDir };
}

function write(abs: string, content: string): void {
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

describe.skipIf(process.platform === 'win32')('rule sources that are symbolic links', () => {
  it('a symlinked content.md is refused with aspect-source-symlink, naming the link', async () => {
    const { root, aspectDir } = repo('sym-rule');
    write(path.join(root, 'docs/rule.md'), 'Never use eval.\n');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: SymRule\ndescription: "linked"\nstatus: enforced\n');
    symlinkSync('../../../docs/rule.md', path.join(aspectDir, 'content.md'));

    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'sym-rule', { projectRoot: root });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0].code).toBe('aspect-source-symlink');
    expect(res.errors[0].messageData.what).toContain('.yggdrasil/aspects/sym-rule/content.md');
  });

  it('a symlinked check.mjs is refused', async () => {
    const { root, aspectDir } = repo('sym-det');
    write(path.join(root, 'tools/det.mjs'), 'export function check() { return []; }\n');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: SymDet\ndescription: "linked"\nstatus: enforced\n');
    symlinkSync('../../../tools/det.mjs', path.join(aspectDir, 'check.mjs'));

    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'sym-det', { projectRoot: root });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.errors[0].code).toBe('aspect-source-symlink');
  });

  it('a symlinked helper the check imports is refused too — it is a verdict input like the check itself', async () => {
    const { root, aspectDir } = repo('helper');
    write(path.join(root, 'tools/shared.mjs'), 'export const x = 1;\n');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: Helper\ndescription: "helper"\nstatus: enforced\n');
    write(path.join(aspectDir, 'check.mjs'), "import { x } from './lib/shared.mjs';\nexport function check() { return []; }\n");
    mkdirSync(path.join(aspectDir, 'lib'));
    symlinkSync('../../../../tools/shared.mjs', path.join(aspectDir, 'lib', 'shared.mjs'));

    expect(ruleDirSymlinks(aspectDir)).toEqual(['lib/shared.mjs']);
    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'helper', { projectRoot: root });
    expect(res.ok).toBe(false);
  });

  it('a regular rule is untouched, and the drills/ corpus and dot entries are not examined', async () => {
    const { root, aspectDir } = repo('plain');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: Plain\ndescription: "plain"\nstatus: enforced\n');
    write(path.join(aspectDir, 'content.md'), 'A rule.\n');
    write(path.join(root, 'fixture.ts'), 'x');
    mkdirSync(path.join(aspectDir, 'drills'));
    symlinkSync('../../../../fixture.ts', path.join(aspectDir, 'drills', 'case.ts'));
    symlinkSync('../../../fixture.ts', path.join(aspectDir, '.scratch'));

    expect(ruleDirSymlinks(aspectDir)).toEqual([]);
    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'plain', { projectRoot: root });
    expect(res.ok).toBe(true);
  });

  it('a symlinked dot-named module is refused — dot-named code is part of the rule\'s hash, so it must be a regular file', async () => {
    const { root, aspectDir } = repo('dot-helper');
    write(path.join(root, 'tools/shared.mjs'), 'export const x = 1;\n');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: DotHelper\ndescription: "dot"\nstatus: enforced\n');
    write(path.join(aspectDir, 'check.mjs'), "import { x } from './.lib/shared.mjs';\nexport function check() { return []; }\n");
    mkdirSync(path.join(aspectDir, '.lib'));
    symlinkSync('../../../../tools/shared.mjs', path.join(aspectDir, '.lib', 'shared.mjs'));

    expect(ruleDirSymlinks(aspectDir)).toEqual(['.lib/shared.mjs']);
    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'dot-helper', { projectRoot: root });
    expect(res.ok).toBe(false);
  });

  // A link the rule's code NAMES is refused wherever it sits — never followed, so
  // nothing from outside the rule directory reaches the rule's hash.
  async function refusedFor(id: string, check: string, setup: (root: string, aspectDir: string) => void): Promise<string> {
    const { root, aspectDir } = repo(id);
    write(path.join(aspectDir, 'yg-aspect.yaml'), `name: ${id}\ndescription: "linked"\nstatus: enforced\n`);
    write(path.join(aspectDir, 'check.mjs'), `${check}\nexport function check() { return []; }\n`);
    setup(root, aspectDir);
    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), id, { projectRoot: root });
    expect(res.ok).toBe(false);
    if (res.ok) return '';
    expect(res.errors[0].code).toBe('aspect-source-symlink');
    return res.errors[0].messageData.what;
  }

  it('a drills/ file the check imports that is a link is refused, not followed', async () => {
    const what = await refusedFor('drill-link', "import { x } from './drills/_lib/shared.mjs';", (root, aspectDir) => {
      write(path.join(root, 'tools/shared.mjs'), 'export const x = 1;\n');
      mkdirSync(path.join(aspectDir, 'drills', '_lib'), { recursive: true });
      symlinkSync('../../../../../../tools/shared.mjs', path.join(aspectDir, 'drills', '_lib', 'shared.mjs'));
    });
    expect(what).toContain('.yggdrasil/aspects/drill-link/drills/_lib/shared.mjs');
  });

  it('a module reached through a linked dot-named directory is refused, naming the directory', async () => {
    const what = await refusedFor('dot-dir-link', "import { x } from './.lib/shared.mjs';", (root, aspectDir) => {
      write(path.join(root, 'tools/shared.mjs'), 'export const x = 1;\n');
      symlinkSync('../../../tools', path.join(aspectDir, '.lib'));
    });
    expect(what).toContain('.yggdrasil/aspects/dot-dir-link/.lib');
  });

  it('a linked data file the check reads by URL is refused', async () => {
    await refusedFor('data-link', "const table = new URL('./.table.json', import.meta.url);", (root, aspectDir) => {
      write(path.join(root, 'table.json'), '{}\n');
      symlinkSync('../../../table.json', path.join(aspectDir, '.table.json'));
    });
  });

  it('a link to an unreadable file is a finding, never a crash', async () => {
    await refusedFor('unreadable-link', "const s = new URL('./drills/s', import.meta.url);", (root, aspectDir) => {
      write(path.join(root, 'secret'), 'top secret\n');
      chmodSync(path.join(root, 'secret'), 0o000);
      mkdirSync(path.join(aspectDir, 'drills'));
      symlinkSync('../../../../secret', path.join(aspectDir, 'drills', 's'));
    });
  });

  it('an adaptation\'s companion: path that runs through a symlink is refused', async () => {
    const { root, aspectDir } = repo('adapted');
    write(path.join(aspectDir, 'yg-aspect.yaml'), 'name: Adapted\ndescription: "adapted"\nstatus: enforced\ncompanion: tools/linked/companion.mjs\n');
    write(path.join(aspectDir, 'content.md'), 'A rule.\n');
    write(path.join(root, 'elsewhere/companion.mjs'), 'export function companion() { return []; }\n');
    mkdirSync(path.join(root, 'tools'));
    symlinkSync('../elsewhere', path.join(root, 'tools', 'linked'));

    const res = await parseAspect(aspectDir, path.join(aspectDir, 'yg-aspect.yaml'), 'adapted', { projectRoot: root });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errors[0].code).toBe('aspect-source-symlink');
    expect(res.errors[0].messageData.what).toContain('tools/linked');
  });
});

describe.skipIf(process.platform === 'win32')('references that run through a symbolic link', () => {
  function graphWithReference(root: string, ref: string): Graph {
    return {
      config: {},
      architecture: { node_types: {} },
      nodes: new Map(),
      aspects: [{ id: 'a', name: 'a', reviewer: { type: 'llm' }, artifacts: [], references: [{ path: ref }] }],
      flows: [],
      rootPath: path.join(root, '.yggdrasil'),
    } as unknown as Graph;
  }

  it('a reference that is a link to a file outside the repository is a blocking error, and gates --approve', async () => {
    const { root } = repo('a');
    const outside = mkdtempSync(path.join(tmpdir(), 'yg-outside-'));
    roots.push(outside);
    write(path.join(outside, 'host-secret.txt'), 'HOST SECRET');
    mkdirSync(path.join(root, 'docs'));
    symlinkSync(path.join(outside, 'host-secret.txt'), path.join(root, 'docs', 'ref.md'));

    const issues = await checkAspectReferences(graphWithReference(root, 'docs/ref.md'));
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: 'error', code: 'aspect-reference-symlink' });
    expect(STRUCTURAL_CODES.has('aspect-reference-symlink')).toBe(true);
    expect(APPROVE_GATING_CODES.has('aspect-reference-symlink')).toBe(true);
  });

  it('a reference under a symlinked directory is refused; a real file is not', async () => {
    const { root } = repo('a');
    write(path.join(root, 'real/notes.md'), 'notes');
    symlinkSync('real', path.join(root, 'docs'));
    expect(symlinkOnPath(root, 'docs/notes.md')).toBe('docs');
    expect(symlinkOnPath(root, 'real/notes.md')).toBeNull();

    const refused = await checkAspectReferences(graphWithReference(root, 'docs/notes.md'));
    expect(refused.map((i) => i.code)).toEqual(['aspect-reference-symlink']);
    const accepted = await checkAspectReferences(graphWithReference(root, 'real/notes.md'));
    expect(accepted).toEqual([]);
  });
});
