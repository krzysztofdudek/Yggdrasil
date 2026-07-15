/**
 * Tests for scope: block parsing in aspect-parser.
 *
 * Covered:
 *   - absent scope → AspectDef.scope undefined
 *   - {per: file} parses
 *   - {per: node, files: {path: 'src/**'}} parses with predicate
 *   - files accepts all_of/any_of/not combinators with path+content atoms
 *   - invalid per value → aspect-scope-invalid
 *   - missing per with files present → aspect-scope-invalid
 *   - unknown key in scope → aspect-scope-invalid
 *   - scope on aggregate aspect → aspect-scope-on-aggregate
 *   - node atom in scope.files → aspect-scope-invalid with cross-hint text
 *   - path atom in aspect when: → error with cross-hint text
 *   - a valid existing aspect (no scope) parses exactly as before (regression guard)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseAspect, type ParseAspectResult } from '../../../src/io/aspect-parser.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDir(name: string): { root: string; aspectDir: string; yamlPath: string } {
  const root = mkdtempSync(path.join(tmpdir(), `yg-scope-test-${name}-`));
  const aspectDir = path.join(root, 'aspect');
  mkdirSync(aspectDir, { recursive: true });
  const yamlPath = path.join(aspectDir, 'yg-aspect.yaml');
  return { root, aspectDir, yamlPath };
}

/** Minimal LLM aspect (has content.md) */
function writeLlm(yamlPath: string, extra: string = ''): void {
  writeFileSync(
    yamlPath,
    `name: TestAspect\ndescription: test\nreviewer:\n  type: llm\n${extra}`,
  );
  writeFileSync(path.join(path.dirname(yamlPath), 'content.md'), '# rule\nsome rule.');
}

/** Minimal deterministic aspect (has check.mjs) */
function writeDet(yamlPath: string, extra: string = ''): void {
  writeFileSync(
    yamlPath,
    `name: TestAspect\ndescription: test\nreviewer:\n  type: deterministic\n${extra}`,
  );
  writeFileSync(path.join(path.dirname(yamlPath), 'check.mjs'), 'export function check() { return []; }');
}

/** Aggregate aspect (no rule files, has implies) */
function writeAggregate(yamlPath: string, extra: string = ''): void {
  writeFileSync(
    yamlPath,
    `name: Bundle\ndescription: test\nimplies:\n  - rule-a\n${extra}`,
  );
}

function assertOk(r: ParseAspectResult) {
  expect(r.ok).toBe(true);
  if (!r.ok) throw new Error(`Expected ok, got errors: ${JSON.stringify(r.errors)}`);
  return r.aspect;
}

function assertFail(r: ParseAspectResult) {
  expect(r.ok).toBe(false);
  if (r.ok) throw new Error('Expected failure, got ok');
  return r.errors;
}

// ── cleanup ───────────────────────────────────────────────────────────────────

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function alloc(name: string) {
  const ctx = makeDir(name);
  roots.push(ctx.root);
  return ctx;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('aspect-parser scope: absent', () => {
  it('absent scope → AspectDef.scope is undefined', async () => {
    const { aspectDir, yamlPath } = alloc('absent');
    writeLlm(yamlPath);
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope).toBeUndefined();
  });

  it('regression: a valid LLM aspect without scope parses identically to before', async () => {
    const { aspectDir, yamlPath } = alloc('regression');
    writeLlm(yamlPath, 'status: enforced\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope).toBeUndefined();
    expect(aspect.name).toBe('TestAspect');
    expect(aspect.reviewer.type).toBe('llm');
    expect(aspect.status).toBe('enforced');
  });
});

describe('aspect-parser scope: happy paths', () => {
  it('{per: file} parses and scope.per is "file"', async () => {
    const { aspectDir, yamlPath } = alloc('per-file');
    writeLlm(yamlPath, 'scope:\n  per: file\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope).toBeDefined();
    expect(aspect.scope!.per).toBe('file');
    expect(aspect.scope!.files).toBeUndefined();
  });

  it('{per: node} parses and scope.per is "node"', async () => {
    const { aspectDir, yamlPath } = alloc('per-node');
    writeLlm(yamlPath, 'scope:\n  per: node\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.per).toBe('node');
  });

  it('{per: node, files: {path: "src/**"}} parses with predicate', async () => {
    const { aspectDir, yamlPath } = alloc('per-node-files');
    writeLlm(yamlPath, 'scope:\n  per: node\n  files:\n    path: "src/**"\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.per).toBe('node');
    expect(aspect.scope!.files).toEqual({ path: 'src/**' });
  });

  it('{per: file, files: {path: "src/**"}} also parses', async () => {
    const { aspectDir, yamlPath } = alloc('per-file-files');
    writeLlm(yamlPath, 'scope:\n  per: file\n  files:\n    path: "src/**/*.ts"\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.per).toBe('file');
    expect(aspect.scope!.files).toEqual({ path: 'src/**/*.ts' });
  });

  it('files: all_of with path + content atoms parses', async () => {
    const { aspectDir, yamlPath } = alloc('all-of');
    writeLlm(yamlPath, [
      'scope:',
      '  per: file',
      '  files:',
      '    all_of:',
      '      - path: "src/**"',
      '      - not:',
      '          path: "**/*.test.ts"',
    ].join('\n') + '\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.files).toEqual({
      all_of: [
        { path: 'src/**' },
        { not: { path: '**/*.test.ts' } },
      ],
    });
  });

  it('files: any_of combinator parses', async () => {
    const { aspectDir, yamlPath } = alloc('any-of');
    writeLlm(yamlPath, [
      'scope:',
      '  per: node',
      '  files:',
      '    any_of:',
      '      - path: "src/**/*.ts"',
      '      - content: "handler"',
    ].join('\n') + '\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.files).toEqual({
      any_of: [{ path: 'src/**/*.ts' }, { content: 'handler' }],
    });
  });

  it('files: not combinator with path parses', async () => {
    const { aspectDir, yamlPath } = alloc('not');
    writeLlm(yamlPath, [
      'scope:',
      '  per: node',
      '  files:',
      '    not:',
      '      path: "**/*.test.ts"',
    ].join('\n') + '\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.files).toEqual({ not: { path: '**/*.test.ts' } });
  });

  it('scope works on a deterministic aspect too', async () => {
    const { aspectDir, yamlPath } = alloc('det-scope');
    writeDet(yamlPath, 'scope:\n  per: file\n  files:\n    path: "src/**"\n');
    const aspect = assertOk(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(aspect.scope!.per).toBe('file');
    expect(aspect.scope!.files).toEqual({ path: 'src/**' });
  });
});

describe('aspect-parser scope: error paths', () => {
  it('invalid per value → aspect-scope-invalid mentioning node|file', async () => {
    const { aspectDir, yamlPath } = alloc('bad-per');
    writeLlm(yamlPath, 'scope:\n  per: aspect\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
    const msg = errors.find(e => e.code === 'aspect-scope-invalid')!.messageData;
    expect(msg.what).toContain('aspect');
    // message must mention the allowed values
    expect(JSON.stringify(msg)).toMatch(/node|file/);
  });

  it('missing per with files present → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('missing-per');
    writeLlm(yamlPath, 'scope:\n  files:\n    path: "src/**"\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('scope with no per and no files → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('empty-scope');
    writeLlm(yamlPath, 'scope: {}\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('unknown key in scope → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('unknown-key');
    writeLlm(yamlPath, 'scope:\n  per: file\n  filter: "**/*.ts"\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('scope on aggregate aspect → aspect-scope-on-aggregate', async () => {
    const { aspectDir, yamlPath } = alloc('aggregate-scope');
    writeAggregate(yamlPath, 'scope:\n  per: file\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'bundle'));
    expect(errors.some(e => e.code === 'aspect-scope-on-aggregate')).toBe(true);
  });

  it('node atom in scope.files → aspect-scope-invalid with cross-hint text', async () => {
    const { aspectDir, yamlPath } = alloc('node-in-files');
    writeLlm(yamlPath, 'scope:\n  per: file\n  files:\n    node:\n      type: service\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
    const errMsg = JSON.stringify(errors.find(e => e.code === 'aspect-scope-invalid'));
    // cross-hint must mention that node is a node atom and direct to when:
    expect(errMsg).toMatch(/node atom/);
    expect(errMsg).toMatch(/when:/);
  });

  it('relations atom in scope.files → aspect-scope-invalid with cross-hint text', async () => {
    const { aspectDir, yamlPath } = alloc('relations-in-files');
    writeLlm(yamlPath, [
      'scope:',
      '  per: file',
      '  files:',
      '    relations:',
      '      calls:',
      '        target_type: service',
    ].join('\n') + '\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
    const errMsg = JSON.stringify(errors.find(e => e.code === 'aspect-scope-invalid'));
    expect(errMsg).toMatch(/node atom/);
    expect(errMsg).toMatch(/when:/);
  });

  it('descendants atom in scope.files → aspect-scope-invalid with cross-hint text', async () => {
    const { aspectDir, yamlPath } = alloc('descendants-in-files');
    writeLlm(yamlPath, [
      'scope:',
      '  per: file',
      '  files:',
      '    descendants:',
      '      type: handler',
    ].join('\n') + '\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
    const errMsg = JSON.stringify(errors.find(e => e.code === 'aspect-scope-invalid'));
    expect(errMsg).toMatch(/node atom/);
    expect(errMsg).toMatch(/when:/);
  });

  it('scope is not a mapping → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('scope-not-mapping');
    writeLlm(yamlPath, 'scope: file\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('per: "File" (capitalized) → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('per-capitalized');
    writeLlm(yamlPath, 'scope:\n  per: File\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('files: {} (empty mapping) → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('files-empty-mapping');
    writeLlm(yamlPath, 'scope:\n  per: file\n  files: {}\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('scope: null → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('scope-null');
    writeLlm(yamlPath, 'scope: ~\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('scope: [] (array) → aspect-scope-invalid', async () => {
    const { aspectDir, yamlPath } = alloc('scope-array');
    writeLlm(yamlPath, 'scope:\n  - per: file\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
  });

  it('nested node-family atom in all_of → aspect-scope-invalid with cross-hint', async () => {
    const { aspectDir, yamlPath } = alloc('nested-node-in-all-of');
    writeLlm(yamlPath, [
      'scope:',
      '  per: file',
      '  files:',
      '    all_of:',
      '      - path: "src/**"',
      '      - node:',
      '          type: service',
    ].join('\n') + '\n');
    const errors = assertFail(await parseAspect(aspectDir, yamlPath, 'test'));
    expect(errors.some(e => e.code === 'aspect-scope-invalid')).toBe(true);
    const errMsg = JSON.stringify(errors.find(e => e.code === 'aspect-scope-invalid'));
    expect(errMsg).toMatch(/node atom/);
  });
});

describe('aspect-parser cross-hint B: path/content in aspect when:', () => {
  // A malformed aspect-level when: must return a structured {ok:false} parse
  // error (code aspect-when-invalid), NOT throw. A throw here escapes parseAspect
  // and is swallowed by the loader, silently dropping the aspect into a clean PASS
  // over unenforced code — the exact defect this contract closes.
  async function expectWhenInvalid(aspectDir: string, yamlPath: string): Promise<string> {
    const result = await parseAspect(aspectDir, yamlPath, 'test');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors[0].code).toBe('aspect-when-invalid');
    return result.errors[0].messageData.what;
  }

  it('path atom in aspect when: → aspect-when-invalid with cross-hint mentioning scope.files', async () => {
    const { aspectDir, yamlPath } = alloc('path-in-when');
    writeLlm(yamlPath, ['when:', '  path: "src/**"'].join('\n') + '\n');
    expect(await expectWhenInvalid(aspectDir, yamlPath)).toMatch(/scope\.files/);
  });

  it('content atom in aspect when: → aspect-when-invalid with cross-hint mentioning scope.files', async () => {
    const { aspectDir, yamlPath } = alloc('content-in-when');
    writeLlm(yamlPath, ['when:', '  content: "handler"'].join('\n') + '\n');
    expect(await expectWhenInvalid(aspectDir, yamlPath)).toMatch(/scope\.files/);
  });

  it('path atom in aspect when: → error message contains "file atom"', async () => {
    const { aspectDir, yamlPath } = alloc('path-in-when-2');
    writeLlm(yamlPath, ['when:', '  path: "src/**"'].join('\n') + '\n');
    expect(await expectWhenInvalid(aspectDir, yamlPath)).toMatch(/file atom/);
  });

  it('content atom in aspect when: → error message contains "file atom"', async () => {
    const { aspectDir, yamlPath } = alloc('content-in-when-2');
    writeLlm(yamlPath, ['when:', '  content: "handler"'].join('\n') + '\n');
    expect(await expectWhenInvalid(aspectDir, yamlPath)).toMatch(/file atom/);
  });

  it('empty node clause in aspect when: → aspect-when-invalid (not silent drop)', async () => {
    const { aspectDir, yamlPath } = alloc('empty-node-in-when');
    writeLlm(yamlPath, ['when:', '  node: {}'].join('\n') + '\n');
    expect(await expectWhenInvalid(aspectDir, yamlPath)).toMatch(/node|type|has_/i);
  });

  it('malformed when: on an implies edge → aspect-when-invalid (not silent drop)', async () => {
    const { aspectDir, yamlPath } = alloc('implies-edge-bad-when');
    writeLlm(yamlPath, [
      'implies:',
      '  - id: other',
      '    when:',
      '      path: "src/**"',
    ].join('\n') + '\n');
    const result = await parseAspect(aspectDir, yamlPath, 'test');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errors[0].code).toBe('aspect-when-invalid');
    expect(result.errors[0].messageData.what).toMatch(/implies\[0\]/);
  });
});
