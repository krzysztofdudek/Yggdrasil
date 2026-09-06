// =============================================================================
// CLI E2E — the standing line `yg check` prints when NOTHING is required to be
// covered, driven through the real built binary.
//
// With no path named under `coverage.required`, a file no component owns can
// never fail a check — only ever be listed. That is the shipped default (a
// fresh project and a mined proposal both start there) and its consequence is
// invisible: the uncovered files are reported either way, and only their
// severity differs. Severity is the one thing a reader cannot see from a list.
//
// The line is a statement of fact, not a finding: never counted, never
// blocking, and absent the moment either half of the state stops being true —
// a required root is named, or nothing is left uncovered.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

const tempDirs: string[] = [];

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const OPENING = 'Nothing is required to be covered';

/**
 * A minimal real project: one component owning one file, and — unless
 * `looseFiles` says otherwise — two files nothing owns. The architecture type
 * classifies exactly the owned file, so the loose ones are uncovered by every
 * tier at once, which is the state under test.
 */
function makeProject(label: string, opts: { required: string[]; looseFiles?: number }): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-cov-slider-${label}-`));
  tempDirs.push(dir);
  const w = (rel: string, content: string): void => {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  };
  w(
    '.yggdrasil/yg-architecture.yaml',
    "node_types:\n  service:\n    description: 'unit'\n    log_required: false\n    when:\n      path: \"src/owned.ts\"\n",
  );
  const required = opts.required.length === 0
    ? ' []'
    : `\n${opts.required.map((r) => `    - ${r}`).join('\n')}`;
  w('.yggdrasil/yg-config.yaml', `version: "5.2.0"\ncoverage:\n  required:${required}\n  excluded: []\n`);
  w(
    '.yggdrasil/model/owned/yg-node.yaml',
    "name: Owned\ntype: service\ndescription: 'the one mapped component'\naspects: []\nmapping:\n  - src/owned.ts\n",
  );
  w('src/owned.ts', 'export const owned = 1;\n');
  for (let i = 0; i < (opts.looseFiles ?? 2); i++) w(`src/loose-${i}.ts`, `export const loose${i} = ${i};\n`);
  return dir;
}

describe.skipIf(!distExists)('CLI E2E — nothing required to be covered', () => {
  it('says an uncovered file can never fail, and names the setting that changes that', () => {
    const dir = makeProject('empty', { required: [] });
    const { status, stdout } = run(['check'], dir);
    expect(status).toBe(0); // uncovered files are warnings here, by definition
    expect(stdout).toContain(
      `${OPENING}, so the 2 uncovered files this run lists can never fail a check — only ever be listed.`,
    );
    expect(stdout).toContain('Name a path under coverage.required in .yggdrasil/yg-config.yaml');
    // A statement of fact, not a finding: the two warnings counted are the
    // uncovered-files one it qualifies and the fixture's own missing digest —
    // the line itself adds nothing to that total.
    expect(stdout).toContain('Warnings (2)');
  });

  it('agrees with itself about the count, in the singular too', () => {
    const dir = makeProject('one', { required: [], looseFiles: 1 });
    const { stdout } = run(['check'], dir);
    expect(stdout).toContain(`${OPENING}, so the 1 uncovered file this run lists can never fail a check`);
  });

  it('says nothing once a root IS required', () => {
    const dir = makeProject('required', { required: ['src/'] });
    const { stdout } = run(['check'], dir);
    expect(stdout).toContain('yg check:');
    expect(stdout).not.toContain(OPENING);
  });

  it('says nothing when there is nothing uncovered to say it about', () => {
    const dir = makeProject('clean', { required: [], looseFiles: 0 });
    const { status, stdout } = run(['check'], dir);
    expect(status).toBe(0);
    expect(stdout).not.toContain(OPENING);
  });

  it('appears in the narrowed views too — it is not part of the issue wall they trim', () => {
    const dir = makeProject('views', { required: [] });
    expect(run(['check', '--summary'], dir).stdout).toContain(OPENING);
    expect(run(['check', '--details'], dir).stdout).toContain(OPENING);
  });
});
