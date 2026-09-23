import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { mkdtemp, cp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FULL_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project');
const BROKEN_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-broken-relation');

async function withFixtureCopy<T>(fixture: string, fn: (cwd: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), 'ygg-build-pipeline-'));
  await cp(fixture, root, { recursive: true });
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('context pipeline integration', () => {
  it('context --node writes context to stdout for valid node', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Source files');
      expect(result.stdout).toContain('orders/order-service');
      expect(result.stdout).toContain('After modifying source files');
    });
  });

  it('context --node is deterministic', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      const first = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(first.status).toBe(0);

      const second = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/order-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );
      expect(second.status).toBe(0);

      const stripVariableParts = (content: string) =>
        content
          .trim();

      expect(stripVariableParts(second.stdout)).toBe(stripVariableParts(first.stdout));
    });
  });

  it('context --node expands directory mapping to individual files', async () => {
    await withFixtureCopy(FULL_FIXTURE, async (cwd) => {
      // Create a directory with multiple files and a node that maps the directory
      const dirPath = path.join(cwd, 'src', 'payments');
      await mkdir(dirPath, { recursive: true });
      await writeFile(path.join(dirPath, 'payment.service.cs'), 'class PaymentService {}', 'utf-8');
      await writeFile(path.join(dirPath, 'payment.model.cs'), 'class PaymentModel {}', 'utf-8');
      await writeFile(path.join(dirPath, 'payment.validator.cs'), 'class PaymentValidator {}', 'utf-8');

      // Create a node with directory mapping
      const nodePath = path.join(cwd, '.yggdrasil', 'model', 'payments');
      await mkdir(nodePath, { recursive: true });
      await writeFile(path.join(nodePath, 'yg-node.yaml'), [
        'name: Payments',
        'description: Payment processing',
        'type: service',
        'mapping:',
        '  - src/payments/',
      ].join('\n'), 'utf-8');

      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'payments'],
        { cwd, encoding: 'utf-8' },
      );

      expect(result.status).toBe(0);
      // Should show 3 individual files, not just "src/payments"
      expect(result.stdout).toContain('Source files (3):');
      expect(result.stdout).toContain('src/payments/payment.service.cs');
      expect(result.stdout).toContain('src/payments/payment.model.cs');
      expect(result.stdout).toContain('src/payments/payment.validator.cs');
    });
  });

  /**
   * Cross-command consistency test: context, approve --dry-run, and check must all
   * agree on the mapped file set when a directory mapping contains gitignored files
   * at multiple directory levels (gitignored files are excluded everywhere).
   *
   * Fixture layout:
   *   src/svc/           — mapped directory
   *     a.cs, b.cs, c.cs — 3 source files
   *     sub/
   *       d.cs, e.cs     — 2 source files in subdirectory
   *       f.cs           — 1 more source file
   *       *.generated.cs — excluded by nested .gitignore
   *     dist/            — excluded by root .gitignore
   *       out.cs
   *     debug.log        — excluded by root .gitignore
   *
   * Expected: 7 files (a, b, c, d, e, f + sub/.gitignore). Gitignored files must NOT be counted.
   */
  it('all commands agree on file count with nested gitignore', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ygg-gitignore-count-'));
    try {
      // Source files
      const svcDir = path.join(root, 'src', 'svc');
      const subDir = path.join(svcDir, 'sub');
      const distDir = path.join(svcDir, 'dist');
      await mkdir(subDir, { recursive: true });
      await mkdir(distDir, { recursive: true });

      await writeFile(path.join(svcDir, 'a.cs'), 'class A {}', 'utf-8');
      await writeFile(path.join(svcDir, 'b.cs'), 'class B {}', 'utf-8');
      await writeFile(path.join(svcDir, 'c.cs'), 'class C {}', 'utf-8');
      await writeFile(path.join(subDir, 'd.cs'), 'class D {}', 'utf-8');
      await writeFile(path.join(subDir, 'e.cs'), 'class E {}', 'utf-8');
      await writeFile(path.join(subDir, 'f.cs'), 'class F {}', 'utf-8');

      // Gitignored files
      await writeFile(path.join(svcDir, 'debug.log'), 'log data', 'utf-8');
      await writeFile(path.join(distDir, 'out.cs'), 'compiled', 'utf-8');
      await writeFile(path.join(subDir, 'model.generated.cs'), 'generated', 'utf-8');
      await writeFile(path.join(subDir, 'dto.generated.cs'), 'generated', 'utf-8');

      // Root .gitignore
      await writeFile(path.join(root, '.gitignore'), 'dist/\n*.log\n', 'utf-8');
      // Nested .gitignore in sub/ — tests multi-level gitignore stacking
      await writeFile(path.join(subDir, '.gitignore'), '*.generated.cs\n', 'utf-8');

      // Graph structure
      const yggDir = path.join(root, '.yggdrasil');
      await mkdir(path.join(yggDir, 'model', 'svc'), { recursive: true });
      await mkdir(path.join(yggDir, 'aspects', 'code-style'), { recursive: true });

      await writeFile(path.join(yggDir, 'yg-config.yaml'), [
        'version: "6.0.0"', 'reviewer:',
        '  tiers:',
        '    default-tier:',
        '      provider: claude-code',
        '      consensus: 1',
        '      config:',
        '        model: haiku',
      ].join('\n'), 'utf-8');

      await writeFile(path.join(yggDir, 'yg-architecture.yaml'), [
        'node_types:',
        '  service:',
        '    description: Service unit',
        '    when:',
        '      path: "**"',
      ].join('\n'), 'utf-8');

      await writeFile(path.join(yggDir, 'aspects', 'code-style', 'yg-aspect.yaml'), [
        'name: Code Style',
        'description: Consistent code style',
        'reviewer:',
        '  type: llm',
      ].join('\n'), 'utf-8');
      await writeFile(path.join(yggDir, 'aspects', 'code-style', 'content.md'), [
        '# Code Style',
        'Follow consistent naming conventions.',
      ].join('\n'), 'utf-8');

      await writeFile(path.join(yggDir, 'model', 'svc', 'yg-node.yaml'), [
        'name: Service',
        'description: Main service',
        'type: service',
        'aspects:',
        '  - code-style',
        'mapping:',
        '  - src/svc/',
      ].join('\n'), 'utf-8');

      // 1. context --node: should show exactly 6 files
      const contextResult = spawnSync(
        'node', [BIN_PATH, 'context', '--node', 'svc'],
        { cwd: root, encoding: 'utf-8' },
      );
      expect(contextResult.status).toBe(0);
      expect(contextResult.stdout).toContain('Source files (7):');
      // Extract source file list (between "Source files" and next section)
      const contextSourceSection = contextResult.stdout.split('Source files')[1]?.split('Must satisfy')[0] ?? '';
      // Gitignored files must NOT appear in source file list
      expect(contextSourceSection).not.toContain('debug.log');
      expect(contextSourceSection).not.toContain('.generated.cs');
      expect(contextSourceSection).not.toContain('dist/out.cs');

      // 2. aspect-test --dry-run: the assembled LLM prompt must embed exactly the
      // same 7 source files (one <file path="..."> block each), with no
      // gitignored file. aspect-test replaces approve --dry-run.
      const dryRunResult = spawnSync(
        'node', [BIN_PATH, 'aspect-test', '--aspect', 'code-style', '--node', 'svc', '--dry-run'],
        { cwd: root, encoding: 'utf-8' },
      );
      expect(dryRunResult.status).toBe(0);
      const fileBlocks = dryRunResult.stdout.match(/<file path="[^"]+">/g) ?? [];
      expect(fileBlocks).toHaveLength(7);
      const dryRunFilePaths = fileBlocks.join('\n');
      expect(dryRunFilePaths).not.toContain('.log');
      expect(dryRunFilePaths).not.toContain('.generated.cs');
      expect(dryRunFilePaths).not.toContain('dist/out.cs');

      // 3. check: the per-tier prompt-size gate measures the assembled prompt over
      // the same gitignore-excluded file set used by context and dry-run. The tiny
      // fixture is well under any limit (and this config sets none), so it must not
      // fire — confirming cross-command consistency. (oversized-node is removed.)
      const checkResult = spawnSync(
        'node', [BIN_PATH, 'check'],
        { cwd: root, encoding: 'utf-8' },
      );
      expect(checkResult.stdout).not.toContain('prompt-too-large');
      expect(checkResult.stdout).not.toContain('oversized-node');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(root, { recursive: true, force: true });
    }
  });

  describe('subdirectory support', () => {
    // All commands work when CWD is a subdirectory of the project root.
    // --file is always relative to the repository root, not CWD.
    // --node paths are graph-level (unaffected by CWD).

    it('owner --file resolves repo-root-relative path from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src', 'orders');
        const result = spawnSync(
          'node', [BIN_PATH, 'owner', '--file', 'src/orders/order.service.ts'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        expect(result.stdout).toContain('src/orders/order.service.ts');
        expect(result.stdout).toContain('orders/order-service');
      });
    });

    it('context --file resolves repo-root-relative path from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src', 'orders');
        const result = spawnSync(
          'node', [BIN_PATH, 'context', '--file', 'src/orders/order.service.ts'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('orders/order-service');
        expect(result.stdout).toContain('src/orders/order.service.ts');
      });
    });

    it('impact --file resolves repo-root-relative path from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src', 'orders');
        const result = spawnSync(
          'node', [BIN_PATH, 'impact', '--file', 'src/orders/order.service.ts'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('orders/order-service');
      });
    });

    it('context --node works from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src', 'orders');
        const result = spawnSync(
          'node', [BIN_PATH, 'context', '--node', 'orders/order-service'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('orders/order-service');
        expect(result.stdout).toContain('Source files');
      });
    });

    it('check works from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src', 'orders');
        const result = spawnSync(
          'node', [BIN_PATH, 'check'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        // Should find .yggdrasil/ by walking up and report nodes
        expect(result.stdout).toContain('nodes');
        expect(result.stdout).toContain('aspects');
      });
    });

    it('aspect-test --dry-run works from subdirectory', async () => {
      await withFixtureCopy(FULL_FIXTURE, async (root) => {
        const subDir = path.join(root, 'src');
        // requires-audit is the LLM aspect on orders/order-service; --dry-run
        // assembles its prompt and makes no provider call. --node paths are
        // graph-level, so running from a subdirectory must still resolve the node.
        const result = spawnSync(
          'node', [BIN_PATH, 'aspect-test', '--aspect', 'requires-audit', '--node', 'orders/order-service', '--dry-run'],
          { cwd: subDir, encoding: 'utf-8' },
        );
        expect(result.status).toBe(0);
        expect(result.stdout).toContain('orders/order-service');
        expect(result.stdout).toContain('<source-files>');
      });
    });
  });

  it('context fails on broken relation with structural error message', async () => {
    await withFixtureCopy(BROKEN_FIXTURE, async (cwd) => {
      const result = spawnSync(
        'node',
        [BIN_PATH, 'context', '--node', 'orders/broken-service'],
        {
          cwd,
          encoding: 'utf-8',
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('build-context blocked by');
    });
  });
});
