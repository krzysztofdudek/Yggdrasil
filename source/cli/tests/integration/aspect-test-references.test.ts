import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CLI = join(__dirname, '..', '..', 'dist', 'bin.js');

// `yg aspect-test` replaces `yg approve --dry-run`. It is PER-ASPECT (the old
// dry-run iterated every aspect of a node in one shot; aspect-test runs exactly
// one aspect). For an LLM aspect, --dry-run prints the assembled prompt
// (including the <references> block) and makes no provider calls. For a
// deterministic aspect, --dry-run is rejected; the aspect simply runs live and
// the lock is never touched. These tests preserve the original subjects: a
// deterministic aspect is routed to a local run (never the prompt path), the
// <references> block carries reference content into the prompt, and the parent's
// own-file set honors the child carve-out (preview equals the eventual verdict).

const CONFIG = [
  'version: "5.1.0"',
  'reviewer:',
  '  default: standard',
  '  tiers:',
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config: { model: m, endpoint: http://x }',
].join('\n') + '\n';

const ARCH = [
  'node_types:',
  '  module:',
  '    description: m',
  '    when:',
  '      path: "**"',
  '  leaf:',
  '    description: l',
  '    parents: [module]',
  '    when:',
  '      path: "**"',
].join('\n') + '\n';

describe('integration — aspect-test (deterministic run + LLM prompt preview with references)', () => {
  const repos: string[] = [];
  afterEach(() => {
    while (repos.length > 0) rmSync(repos.pop()!, { recursive: true, force: true });
  });

  it('runs a deterministic aspect live (--node) and reports no violations — never a prompt', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-at-det-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'no-foo'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const ok = 1;\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'no-foo', 'yg-aspect.yaml'), [
      'name: NoFoo',
      'description: forbids identifier foo',
      'reviewer:',
      '  type: deterministic',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'no-foo', 'check.mjs'), 'export function check(ctx) {\n  return [];\n}\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), [
      'name: svc',
      'type: module',
      'mapping:',
      '  - src/svc.ts',
      'aspects:',
      '  - no-foo',
    ].join('\n') + '\n', 'utf-8');

    const result = spawnSync('node', [CLI, 'aspect-test', '--aspect', 'no-foo', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No violations.');
    // A deterministic aspect never produces a prompt.
    expect(result.stdout).not.toContain('<task>');
    expect(result.stdout).toContain('diagnostic only — lock unchanged');
  });

  it('--dry-run prints the <references> block in the captured LLM prompt preview', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-at-refs-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), [
      'name: A',
      'description: t',
      'reviewer: { type: llm }',
      'references:',
      '  - docs/codes.md',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), [
      'name: svc',
      'type: module',
      'mapping:',
      '  - src/svc.ts',
      'aspects:',
      '  - a',
    ].join('\n') + '\n', 'utf-8');

    const out = execFileSync('node', [CLI, 'aspect-test', '--aspect', 'a', '--node', 'svc', '--dry-run'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(out).toContain('<references>');
    expect(out).toContain('docs/codes.md');
    expect(out).toContain('CODE_1');
    expect(out).toContain('diagnostic only — lock unchanged');
  });

  it('each LLM aspect can be previewed on its own (per-aspect, not a single batch)', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-at-multi-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'a'), { recursive: true });
    mkdirSync(join(ygg, 'aspects', 'b'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'docs'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const x = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'docs', 'codes.md'), 'CODE_1\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'yg-aspect.yaml'), [
      'name: A',
      'description: first aspect',
      'reviewer: { type: llm }',
      'references:',
      '  - docs/codes.md',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'a', 'content.md'), '# A\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'yg-aspect.yaml'), [
      'name: B',
      'description: second aspect',
      'reviewer: { type: llm }',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'b', 'content.md'), '# B\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), [
      'name: svc',
      'type: module',
      'mapping:',
      '  - src/svc.ts',
      'aspects:',
      '  - a',
      '  - b',
    ].join('\n') + '\n', 'utf-8');

    // Aspect A's preview carries its reference content.
    const outA = execFileSync('node', [CLI, 'aspect-test', '--aspect', 'a', '--node', 'svc', '--dry-run'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(outA).toContain('aspect id="a"');
    expect(outA).toContain('docs/codes.md');
    expect(outA).toContain('CODE_1');

    // Aspect B previews independently (no references of its own).
    const outB = execFileSync('node', [CLI, 'aspect-test', '--aspect', 'b', '--node', 'svc', '--dry-run'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(outB).toContain('aspect id="b"');
    expect(outB).not.toContain('<references>');
  });

  it('a deterministic aspect on a node is routed to a local run, never the LLM prompt path', () => {
    const repo = mkdtempSync(join(tmpdir(), 'yg-at-structure-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'shape'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'svc.ts'), 'export const ok = 1;\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'shape', 'yg-aspect.yaml'), [
      'name: Shape',
      'description: a deterministic aspect',
      'reviewer:',
      '  type: deterministic',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'shape', 'check.mjs'), 'export function check(ctx) {\n  return [];\n}\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), [
      'name: svc',
      'type: module',
      'mapping:',
      '  - src/svc.ts',
      'aspects:',
      '  - shape',
    ].join('\n') + '\n', 'utf-8');

    const result = spawnSync('node', [CLI, 'aspect-test', '--aspect', 'shape', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No violations.');
    // No prompt scaffold is ever emitted for a deterministic aspect.
    expect(result.stdout).not.toContain('<task>');
    expect(result.stdout).not.toContain('<source-files>');
  });

  it('a deterministic aspect on a parent honors the child carve-out (run matches the verdict subject set)', () => {
    // A deterministic aspect on a PARENT that maps src/parent.ts AND src/child.ts,
    // with a CHILD node carving out src/child.ts. aspect-test --node runs the
    // SAME subject view yg check --approve would fill: the parent's own-file set
    // EXCLUDES the child-mapped path, so only src/parent.ts is reported.
    const repo = mkdtempSync(join(tmpdir(), 'yg-at-carveout-'));
    repos.push(repo);
    const ygg = join(repo, '.yggdrasil');
    mkdirSync(join(ygg, 'aspects', 'count'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc'), { recursive: true });
    mkdirSync(join(ygg, 'model', 'svc', 'child'), { recursive: true });
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'parent.ts'), 'export const p = 1;\n', 'utf-8');
    writeFileSync(join(repo, 'src', 'child.ts'), 'export const c = 1;\n', 'utf-8');
    writeFileSync(join(ygg, 'yg-config.yaml'), CONFIG, 'utf-8');
    writeFileSync(join(ygg, 'yg-architecture.yaml'), ARCH, 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'count', 'yg-aspect.yaml'), [
      'name: Count',
      'description: emits one violation per own file',
      'reviewer:',
      '  type: deterministic',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'aspects', 'count', 'check.mjs'),
      'export function check(ctx) {\n  return ctx.files.map(f => ({ file: f.path, line: 1, column: 0, message: \'seen \' + f.path }));\n}\n',
      'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'yg-node.yaml'), [
      'name: svc',
      'type: module',
      'mapping:',
      '  - src/parent.ts',
      '  - src/child.ts',
      'aspects:',
      '  - count',
    ].join('\n') + '\n', 'utf-8');
    writeFileSync(join(ygg, 'model', 'svc', 'child', 'yg-node.yaml'), [
      'name: child',
      'type: leaf',
      'mapping:',
      '  - src/child.ts',
    ].join('\n') + '\n', 'utf-8');

    const result = spawnSync('node', [CLI, 'aspect-test', '--aspect', 'count', '--node', 'svc'], {
      cwd: repo, encoding: 'utf-8',
    });
    // The parent's own file is reported...
    expect(result.stdout).toMatch(/seen src\/parent\.ts/);
    // ...and the child-mapped file is carved out (matches the real verdict subject).
    expect(result.stdout).not.toMatch(/seen src\/child\.ts/);
  });
});
