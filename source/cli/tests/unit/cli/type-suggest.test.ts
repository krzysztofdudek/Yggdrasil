import { describe, it, expect, afterEach, vi } from 'vitest';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { typeSuggestCommand } from '../../../src/cli/type-suggest.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function setupProject(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'yg-ts-cli-'));
  dirs.push(root);
  const yggRoot = path.join(root, '.yggdrasil');
  await mkdir(path.join(yggRoot, 'model'), { recursive: true });
  await writeFile(path.join(yggRoot, 'yg-config.yaml'), 'version: "5.2.0"\n');
  await writeFile(
    path.join(yggRoot, 'yg-architecture.yaml'),
    [
      'node_types:',
      '  command:',
      '    description: CLI command handler',
      '    when:',
      '      path: "src/cli/*.ts"',
      '  service:',
      '    description: Service layer',
      '    when:',
      '      path: "src/services/**"',
      '  module:',
      '    description: Logical grouping (no when)',
    ].join('\n') + '\n',
  );
  // Create actual source files
  await mkdir(path.join(root, 'src', 'cli'), { recursive: true });
  await mkdir(path.join(root, 'src', 'misc'), { recursive: true });
  await writeFile(path.join(root, 'src', 'cli', 'log-add.ts'), '');
  await writeFile(path.join(root, 'src', 'misc', 'helper.ts'), '');
  return root;
}

async function captureOutput(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    chunks.push(String(s));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    chunks.push(args.map(String).join(' ') + '\n');
  });
  await fn();
  return chunks.join('');
}

describe('typeSuggestCommand', () => {
  it('reports matching types when file satisfies when predicate', async () => {
    const root = await setupProject();
    const output = await captureOutput(() =>
      typeSuggestCommand('src/cli/log-add.ts', root),
    );
    expect(output).toMatch(/Matching types/);
    expect(output).toMatch(/✓ command/);
  });

  it('reports closest types when no type matches', async () => {
    const root = await setupProject();
    const output = await captureOutput(() =>
      typeSuggestCommand('src/misc/helper.ts', root),
    );
    expect(output).toMatch(/No type.*when.*matches/);
    expect(output).toMatch(/Closest types/);
  });

  it('handles paths inside .yggdrasil/', async () => {
    const root = await setupProject();
    const output = await captureOutput(() =>
      typeSuggestCommand('.yggdrasil/model/foo/yg-node.yaml', root),
    );
    expect(output).toMatch(/inside .yggdrasil\//);
    expect(output).toMatch(/auto-exempt/);
  });

  it('handles non-existent files with path-only evaluation', async () => {
    const root = await setupProject();
    const output = await captureOutput(() =>
      typeSuggestCommand('src/cli/new-cmd.ts', root),
    );
    expect(output).toMatch(/File does not exist/);
    expect(output).toMatch(/evaluating path predicates only/);
  });

  it('surfaces a content-predicate type as unreadable for a file over the size limit, instead of silently non-matching', async () => {
    const root = await setupProject();
    await writeFile(
      path.join(root, '.yggdrasil', 'yg-architecture.yaml'),
      [
        'node_types:',
        '  command:',
        '    description: CLI command handler',
        '    when:',
        '      path: "src/cli/*.ts"',
        '  content-typed:',
        '    description: Classified by content',
        '    when:',
        '      content: "abc"',
      ].join('\n') + '\n',
    );
    await writeFile(
      path.join(root, 'src', 'misc', 'huge.ts'),
      Buffer.alloc(5 * 1024 * 1024 + 1, 0x61),
    );
    const output = await captureOutput(() =>
      typeSuggestCommand('src/misc/huge.ts', root),
    );
    expect(output).toMatch(/Could not be evaluated/);
    expect(output).toMatch(/content-typed/);
    expect(output).toMatch(/5MB/);
  });

  it('reports a coverage.excluded path as excluded from graph coverage, without classifying it', async () => {
    const root = await setupProject();
    await writeFile(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\ncoverage:\n  excluded:\n    - src/misc/\n',
    );
    const output = await captureOutput(() =>
      typeSuggestCommand('src/misc/helper.ts', root),
    );
    expect(output).toContain('is excluded from graph coverage by design');
    expect(output).not.toMatch(/Matching types/);
    expect(output).not.toMatch(/No type.*when.*matches/);
  });

  it('control: a sibling file OUTSIDE the excluded root still classifies normally — the guard does not silence classification generally', async () => {
    const root = await setupProject();
    await writeFile(
      path.join(root, '.yggdrasil', 'yg-config.yaml'),
      'version: "5.2.0"\ncoverage:\n  excluded:\n    - src/misc/\n',
    );
    const output = await captureOutput(() =>
      typeSuggestCommand('src/cli/log-add.ts', root),
    );
    expect(output).toMatch(/Matching types/);
    expect(output).toMatch(/✓ command/);
  });

  it('handles multiple matching types', async () => {
    const root = await setupProject();
    // Add a second type with overlapping when
    const arch = [
      'node_types:',
      '  command:',
      '    description: CLI command handler',
      '    when:',
      '      path: "src/**/*.ts"',
      '  handler:',
      '    description: Request handler',
      '    when:',
      '      path: "src/**/*.ts"',
    ].join('\n') + '\n';
    await writeFile(path.join(root, '.yggdrasil', 'yg-architecture.yaml'), arch);
    const output = await captureOutput(() =>
      typeSuggestCommand('src/cli/log-add.ts', root),
    );
    expect(output).toMatch(/Multiple types match/);
    expect(output).toMatch(/command/);
    expect(output).toMatch(/handler/);
  });
});
