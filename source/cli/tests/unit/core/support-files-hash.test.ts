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
});
