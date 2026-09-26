// =============================================================================
// Unit — a helper a rule's code imports is part of the rule's verdict.
//
// A `check.mjs` (or `companion.mjs`) can import a module beside it, or read a
// table shipped with it. Only the rule file's own bytes used to enter the rule
// hash, so an update that changed only a helper kept a stale pass on every warm
// cache. Every other file in the rule's directory now folds in — except what
// describes or tunes the rule rather than runs, and the drills it is measured
// against. And an aspect with NO such files hashes exactly as it always did, so
// upgrading re-opens nothing by itself.
//
// Three places the directory walk passes over can still hold code the rule
// runs: a dot-named module, a helper kept under drills/, and a module in a
// nested rule's directory. Dot-named code files are always folded (other
// dot-named files are an editor's or an operating system's and stay out); a
// file under drills/ or a nested rule joins only when the rule's code names it
// by a relative import, followed from module to module — so a drill case added
// to the corpus still re-opens nothing.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect } from '../../../src/io/aspect-parser.js';
import { ruleHashFor } from '../../../src/core/pair-inputs.js';
import { createHash } from 'node:crypto';
import type { AspectDef } from '../../../src/model/graph.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CHECK = "import { limit } from './lib/limit.mjs';\nexport function check() { return limit() > 0 ? [] : []; }\n";
/** The hash the rule file alone has always had (no CR in it, so no line-ending normalization applies). */
const BARE = createHash('sha256').update(CHECK, 'utf8').digest('hex');

function rule(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-support-'));
  dirs.push(root);
  const dir = path.join(root, 'r');
  for (const [rel, body] of Object.entries({
    'yg-aspect.yaml': 'name: R\nreviewer:\n  type: deterministic\n',
    'check.mjs': CHECK,
    ...files,
  })) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), body, 'utf-8');
  }
  return dir;
}

async function load(dir: string): Promise<AspectDef> {
  const r = await parseAspect(dir, path.join(dir, 'yg-aspect.yaml'), 'r');
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.aspect;
}

describe('the rule hash and the files beside the rule', () => {
  it('is the bare rule-file hash when there is nothing else — upgrading re-opens nothing by itself', async () => {
    const aspect = await load(rule({}));
    expect(aspect.supportFiles).toBeUndefined();
    expect(ruleHashFor(aspect, 'check.mjs')).toBe(BARE);
  });

  it('folds in a helper module, so changing only the helper changes the hash', async () => {
    const before = await load(rule({ 'lib/limit.mjs': 'export const limit = () => 1;\n' }));
    const after = await load(rule({ 'lib/limit.mjs': 'export const limit = () => 0;\n' }));
    expect(before.supportFiles?.map(([p]) => p)).toEqual(['lib/limit.mjs']);
    expect(ruleHashFor(before, 'check.mjs')).not.toBe(BARE);
    expect(ruleHashFor(before, 'check.mjs')).not.toBe(ruleHashFor(after, 'check.mjs'));
  });

  it('leaves out what describes or tunes the rule, and the cases it is drilled against', async () => {
    const aspect = await load(
      rule({
        'log.md': '# history\n',
        'provenance.json': '{}\n',
        'yg-aspect.adapt.yaml': '# mine\n',
        'yg-aspect.adapt.log.md': '# my history\n',
        'drills/violates-x/src/a.ts': 'x\n',
        '.hidden': 'x\n',
        'nested/yg-aspect.yaml': 'name: Nested\n',
        'nested/check.mjs': 'export function check() { return []; }\n',
      }),
    );
    expect(aspect.supportFiles).toBeUndefined();
    expect(ruleHashFor(aspect, 'check.mjs')).toBe(BARE);
  });

  it('folds in a dot-named module, but not a dot-named file that is not code', async () => {
    const plain = await load(rule({ '.DS_Store': 'finder\n', '.cache/notes.txt': 'x\n' }));
    expect(plain.supportFiles).toBeUndefined();
    const before = await load(rule({ '.shared.mjs': 'export const a = 1;\n', '.lib/deep.js': 'module.exports = 1;\n' }));
    const after = await load(rule({ '.shared.mjs': 'export const a = 2;\n', '.lib/deep.js': 'module.exports = 1;\n' }));
    expect(before.supportFiles?.map(([p]) => p)).toEqual(['.lib/deep.js', '.shared.mjs']);
    expect(ruleHashFor(before, 'check.mjs')).not.toBe(ruleHashFor(after, 'check.mjs'));
  });

  it('folds in a drills/ helper the check imports, followed through the modules it imports, and no drill case', async () => {
    const importing = "import { limit } from './drills/_lib/limit.mjs';\nexport function check() { return limit() > 0 ? [] : []; }\n";
    const files = (n: number): Record<string, string> => ({
      'check.mjs': importing,
      'drills/_lib/limit.mjs': "import { base } from '../_shared/base';\nexport const limit = () => base;\n",
      'drills/_shared/base.mjs': `export const base = ${n};\n`,
      'drills/violates-x/src/a.mjs': 'export const a = 1;\n',
    });
    const before = await load(rule(files(1)));
    const after = await load(rule(files(2)));
    expect(before.supportFiles?.map(([p]) => p)).toEqual(['drills/_lib/limit.mjs', 'drills/_shared/base.mjs']);
    expect(ruleHashFor(before, 'check.mjs')).not.toBe(ruleHashFor(after, 'check.mjs'));

    const withCase = await load(rule({ ...files(1), 'drills/satisfies-y/src/b.mjs': 'export const b = 1;\n' }));
    expect(ruleHashFor(withCase, 'check.mjs')).toBe(ruleHashFor(before, 'check.mjs'));
  });

  it('folds in a module in a nested rule\'s directory only when the enclosing rule imports it', async () => {
    const nested = {
      'nested/yg-aspect.yaml': 'name: Nested\n',
      'nested/check.mjs': 'export function check() { return []; }\n',
      'nested/shared.mjs': 'export const s = 1;\n',
    };
    const untouched = await load(rule(nested));
    expect(untouched.supportFiles).toBeUndefined();

    const importing = "import { s } from './nested/shared.mjs';\nexport function check() { return s ? [] : []; }\n";
    const aspect = await load(rule({ ...nested, 'check.mjs': importing }));
    expect(aspect.supportFiles?.map(([p]) => p)).toEqual(['nested/shared.mjs']);
  });

  it('ignores a specifier that leaves the rule directory, reaches into node_modules, or names no file', async () => {
    const importing = [
      "import a from '../outside.mjs';",
      "import b from './node_modules/pkg/index.mjs';",
      "import c from './missing.mjs';",
      "import d from '@scope/pkg';",
      'export function check() { return []; }',
      '',
    ].join('\n');
    const aspect = await load(rule({ 'check.mjs': importing, 'node_modules/pkg/index.mjs': 'export default 1;\n' }));
    expect(aspect.supportFiles).toBeUndefined();
  });

  it('folds a module only under its exact on-disk spelling, so every filesystem hashes the same', async () => {
    const importing = (spec: string) => `import { h } from '${spec}';\nexport function check() { return h ? [] : []; }\n`;
    const helper = { 'drills/_lib/helper.mjs': 'export const h = 1;\n' };
    const loose = await load(rule({ ...helper, 'check.mjs': importing('./drills/_lib/Helper.mjs') }));
    expect(loose.supportFiles).toBeUndefined();
    const exact = await load(rule({ ...helper, 'check.mjs': importing('./drills/_lib/helper.mjs') }));
    expect(exact.supportFiles?.map(([p]) => p)).toEqual(['drills/_lib/helper.mjs']);
  });

  it('leaves out dot-named code the repository ignores (.venv, .cache, .turbo)', async () => {
    const files = { '.cache/tool.mjs': 'export const t = 1;\n', '.lib/helper.mjs': 'export const h = 1;\n' };
    const unignored = await load(rule(files));
    expect(unignored.supportFiles?.map(([p]) => p)).toEqual(['.cache/tool.mjs', '.lib/helper.mjs']);
    const ignored = await load(rule({ ...files, '.gitignore': '.cache/\n' }));
    expect(ignored.supportFiles?.map(([p]) => p)).toEqual(['.lib/helper.mjs']);
  });
});
