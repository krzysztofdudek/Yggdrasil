/**
 * scripts/dead-exports.mjs — repo-check's dead-export gate. Spawned for real,
 * against small fixture packages (src/ + tests/ + tsconfig.check.json), and
 * once against this package itself, which must be clean.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../scripts/dead-exports.mjs');
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function pkg(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-dead-exports-'));
  dirs.push(root);
  const all: Record<string, string> = {
    'tsconfig.check.json': JSON.stringify({
      compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, noEmit: true, skipLibCheck: true, types: [] },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    }),
    ...files,
  };
  for (const [rel, content] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
  }
  return root;
}
const run = (root: string, ...flags: string[]) => spawnSync('node', [SCRIPT, root, ...flags], { encoding: 'utf-8' });
const json = (root: string) => JSON.parse(run(root, '--json').stdout) as {
  dead: { file: string; name: string }[];
  testOnly: { file: string; name: string }[];
  stale: { key: string; why: string }[];
};

describe('scripts/dead-exports.mjs', () => {
  it('passes when every exported value is read by another source file, however it is reached', () => {
    const root = pkg({
      'src/a.ts': "export const named = 1;\nexport function viaNamespace(): number { return 2; }\nexport class ViaDynamic {}\nexport const viaTypeQuery = { n: 3 };\n",
      'src/b.ts': "import { named } from './a.js';\nimport * as a from './a.js';\nexport async function use(): Promise<number> {\n  const { ViaDynamic } = await import('./a.js');\n  const t: typeof import('./a.js').viaTypeQuery = { n: 4 };\n  return named + a.viaNamespace() + t.n + (new ViaDynamic() ? 1 : 0);\n}\n",
      'src/c.ts': "import { use } from './b.js';\nvoid use();\n",
    });
    const r = run(root);
    expect(r.stderr).toBe('');
    expect(r.stdout).toMatch(/^dead-exports: \d+ exports checked \(0 test seams on the allowlist\), none unused$/m);
    expect(r.status).toBe(0);
  });

  it('refuses a value only its own file reads, and one only a test reads; an interface is not judged', () => {
    const root = pkg({
      'src/a.ts': "export const own = 1;\nexport const seam = 2;\nexport interface Shape { n: number }\nexport function used(s: Shape): number { return own + s.n; }\n",
      'src/b.ts': "import { used } from './a.js';\nvoid used({ n: 1 });\n",
      'tests/a.test.ts': "import { seam } from '../src/a.js';\nvoid seam;\n",
    });
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('src/a.ts:1  own  exported, but no other file uses it');
    expect(r.stdout).toContain('src/a.ts:2  seam  exported, but only tests use it');
    expect(r.stdout).toMatch(/^error\[dead-export\]/m);
    expect(r.stdout).toMatch(/^why: /m);
    expect(r.stdout).toMatch(/^next: /m);
    const j = json(root);
    expect(j.dead.map((e) => e.name)).toEqual(['own']);
    expect(j.testOnly.map((e) => e.name)).toEqual(['seam']);
  });

  it('accepts a test seam on the allowlist, and reports an allowlist entry that no longer earns its place', () => {
    const root = pkg({
      'src/a.ts': "export const seam = 2;\nexport const nowUsed = 3;\n",
      'src/b.ts': "import { nowUsed } from './a.js';\nvoid nowUsed;\n",
      'tests/a.test.ts': "import { seam } from '../src/a.js';\nvoid seam;\n",
      'scripts/dead-exports-allowlist.json': JSON.stringify({ groups: [{ reason: 'fixture', exports: ['src/a.ts#seam', 'src/a.ts#nowUsed', 'src/a.ts#gone'] }] }),
    });
    const j = json(root);
    expect(j.dead).toEqual([]);
    expect(j.testOnly).toEqual([]);
    expect(j.stale).toEqual([
      { key: 'src/a.ts#nowUsed', why: 'another source file uses it now' },
      { key: 'src/a.ts#gone', why: 'is no longer an export of that file' },
    ]);
    expect(run(root).status).toBe(1);
  });

  it('this package is clean', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf-8' });
    expect(r.stdout).toMatch(/none unused$/m);
    expect(r.status).toBe(0);
  }, 60_000);
});
