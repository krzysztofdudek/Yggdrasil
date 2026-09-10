import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Docs also have a contract, and for the port vocabulary (6.0.0's `default`/`portNames`
// rewrite) most of it is machine-checkable. Scenarios 1-3 and 7 read repository files
// directly via node:fs; scenarios 4-6 spawn the built binary from the repo root, exactly
// like docs-internal-links.test.ts:28-31 — so the whole file stays e2e (not a unit test)
// and keeps the standard distExists skip.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, '../../../..');
const BIN_PATH = path.join(REPO_ROOT, 'source', 'cli', 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function read(relPath: string): string {
  return readFileSync(path.join(REPO_ROOT, relPath), 'utf-8');
}

function runCli(args: string[]): { stdout: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd: REPO_ROOT, encoding: 'utf-8' });
  return { stdout: (r.stdout ?? '') + (r.stderr ?? ''), status: r.status };
}

/** Every .md file under docs/, excluding VitePress internals — mirrors docs-internal-links.test.ts's walker. */
function allDocsMarkdownFiles(): string[] {
  const docsDir = path.join(REPO_ROOT, 'docs');
  const out: string[] = [];
  (function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.vitepress') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) out.push(full);
    }
  })(docsDir);
  return out;
}

const REMOVED_CODES = [
  'port-missing-consumes',
  'consumes-without-ports',
  'port-contract-changed',
  'port-contract-unrecorded',
  'port-test-missing',
];

// The only two places the literal word `consumes` may still appear in these three
// pages: the `consumes_port` when-predicate atom (a predicate name, not the retired
// field), and one changelog-style sentence noting that `consumes:` still works as a
// deprecated alias for `portNames:`. The list is explicit, not an approximate regex.
const ALLOWED_CONSUMES_SNIPPETS = [
  'consumes_port',
  '(`consumes:` still works, as a deprecated alias for `portNames:`.)',
];

const VOCABULARY_PAGES = ['docs/relations-flows-ports.md', 'docs/the-lock.md', 'docs/showcase.md'];

describe.skipIf(!distExists)('docs port vocabulary — 6.0.0 default/portNames rewrite', () => {
  it('1: the three rewritten pages say `consumes` only in the two allowed places', () => {
    for (const rel of VOCABULARY_PAGES) {
      let content = read(rel);
      for (const snippet of ALLOWED_CONSUMES_SNIPPETS) {
        content = content.split(snippet).join('');
      }
      expect(content, `${rel} still contains 'consumes' outside the allowed exceptions`).not.toContain('consumes');
    }
  });

  it('2: no page under docs/ mentions a removed port error code', () => {
    const files = allDocsMarkdownFiles();
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const content = readFileSync(file, 'utf-8');
      for (const code of REMOVED_CODES) {
        expect(content, `${path.relative(REPO_ROOT, file)} still mentions removed code '${code}'`).not.toContain(
          code,
        );
      }
    }
  });

  it('3: relations-flows-ports.md documents port-names-empty', () => {
    const content = read('docs/relations-flows-ports.md');
    expect(content).toContain('port-names-empty');
  });

  it('4: `yg knowledge read ports-and-relations` matches the current schema', () => {
    const { status, stdout } = runCli(['knowledge', 'read', 'ports-and-relations']);
    expect(status).toBe(0);
    for (const code of REMOVED_CODES) {
      expect(stdout, `knowledge topic still mentions removed code '${code}'`).not.toContain(code);
    }
    expect(stdout).not.toContain('version:');
    expect(stdout).not.toContain('test:');
    expect(stdout).toContain('portNames');
    expect(stdout).toContain('default');
  });

  it('5: `yg knowledge read verification-and-lock` drops the retired ports lock section', () => {
    const { status, stdout } = runCli(['knowledge', 'read', 'verification-and-lock']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('nodes.<path>.ports');
  });

  it('6: `yg schemas read node` uses portNames, not consumes, as the relation field', () => {
    const { status, stdout } = runCli(['schemas', 'read', 'node']);
    expect(status).toBe(0);
    expect(stdout).not.toContain('consumes:');
    expect(stdout).toContain('portNames');
  });

  it('7: every port-* code in check-codes.ts appears in the relations-flows-ports.md table, and vice versa', () => {
    // `port-names-empty` is a documented, deliberate exception: it is a parse-time
    // YAML validation error raised in node-parser.ts, not a check-codes.ts entry (that
    // registry covers architecture-gate/verdict codes only). Scenario 3 above pins its
    // presence in the docs table directly; it is excluded here so this assertion stays
    // meaningful instead of failing on a code that was never meant to be in check-codes.ts.
    const DOCUMENTED_NON_CHECK_CODE_EXCEPTIONS = new Set(['port-names-empty']);

    const checkCodesSource = read('source/cli/src/core/check-codes.ts');
    const codesInSource = new Set<string>();
    for (const m of checkCodesSource.matchAll(/'(port-[a-z-]+)'/g)) codesInSource.add(m[1]);

    const docsTable = read('docs/relations-flows-ports.md');
    const codesInDocs = new Set<string>();
    for (const m of docsTable.matchAll(/`(port-[a-z-]+)`/g)) codesInDocs.add(m[1]);
    for (const excluded of DOCUMENTED_NON_CHECK_CODE_EXCEPTIONS) codesInDocs.delete(excluded);

    const missingFromDocs = [...codesInSource].filter((c) => !codesInDocs.has(c)).sort();
    const missingFromSource = [...codesInDocs].filter((c) => !codesInSource.has(c)).sort();

    expect(missingFromDocs, `in check-codes.ts but not documented: ${missingFromDocs.join(', ')}`).toEqual([]);
    expect(
      missingFromSource,
      `documented in relations-flows-ports.md but not in check-codes.ts: ${missingFromSource.join(', ')}`,
    ).toEqual([]);
  });
});
