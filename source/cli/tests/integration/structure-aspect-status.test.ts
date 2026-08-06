import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'dist', 'bin.js');
const distExists = existsSync(BIN);

const YG_CONFIG = `version: "5.2.0"
quality:
  max_direct_relations: 10
reviewer:
  default: standard
  tiers:
    standard:
      provider: ollama
      consensus: 1
      config: { model: m, endpoint: http://x }
`;

const YG_ARCH = `node_types:
  module:
    description: Logical grouping
    log_required: false
  service:
    description: Discrete service unit
    log_required: false
    when:
      path: "**"
`;

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [BIN, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

/**
 * Layout a minimal repo with a deterministic aspect set to the given status.
 * The aspect check returns a violation (no README in mapping) intentionally
 * so we can verify how different statuses render the refusal.
 */
function layout(root: string, aspectStatus: 'draft' | 'advisory' | 'enforced'): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'aspects', 'has-readme'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\naspects:\n  - has-readme\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'has-readme', 'yg-aspect.yaml'),
    `name: HasReadme\ndescription: own mapping must include a README\nreviewer:\n  type: deterministic\nstatus: ${aspectStatus}\n`,
  );
  // check.mjs returns a violation: no README found in the node's own files
  writeFileSync(
    path.join(ygg, 'aspects', 'has-readme', 'check.mjs'),
    `export function check(ctx) {
  if (!ctx.files.some(f => /readme/i.test(f.path))) {
    return [{ message: 'no README in own mapping' }];
  }
  return [];
}\n`,
  );
}

interface Lock {
  verdicts: Record<string, Record<string, { verdict: string; hash: string }>>;
  nodes: Record<string, { source?: string }>;
}

// The 5.1.0 lock is a three-file triad under .yggdrasil/. The legacy single
// yg-lock.json is no longer written. has-readme is a deterministic aspect, so
// its verdicts land in the gitignored .yg-lock.deterministic.json; the nodes
// section lands in yg-lock.logs.json; LLM verdicts in yg-lock.nondeterministic.json.
// Merge whatever files exist into the unified shape (each file is independently
// optional — an absent file contributes empty state), mirroring readLock() in
// src/io/lock-store.ts.
const TRIAD_FILES = [
  'yg-lock.nondeterministic.json',
  'yg-lock.logs.json',
  '.yg-lock.deterministic.json',
];

function anyTriadFileExists(root: string): boolean {
  return TRIAD_FILES.some((f) => existsSync(path.join(root, '.yggdrasil', f)));
}

function readLock(root: string): Lock {
  const merged: Lock = { verdicts: {}, nodes: {} };
  for (const fileName of TRIAD_FILES) {
    const filePath = path.join(root, '.yggdrasil', fileName);
    if (!existsSync(filePath)) continue;
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Partial<Lock>;
    Object.assign(merged.verdicts, parsed.verdicts ?? {});
    Object.assign(merged.nodes, parsed.nodes ?? {});
  }
  return merged;
}

function setStatus(root: string, status: 'draft' | 'advisory' | 'enforced'): void {
  const aspectYamlPath = path.join(root, '.yggdrasil', 'aspects', 'has-readme', 'yg-aspect.yaml');
  const yaml = readFileSync(aspectYamlPath, 'utf-8').replace(/^status: .*/m, `status: ${status}`);
  writeFileSync(aspectYamlPath, yaml);
}

describe.skipIf(!distExists)('deterministic aspect-status integration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-status-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('draft: aspect produces no pair — no lock verdict entry, check passes', () => {
    layout(root, 'draft');
    // A draft aspect is removed from the expected-pair set entirely: --approve
    // computes no pair for it and the lock holds no entry. check passes (exit 0).
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(0);

    const check = run(['check'], root);
    expect(check.status).toBe(0);

    if (anyTriadFileExists(root)) {
      const lock = readLock(root);
      expect(lock.verdicts['has-readme']).toBeUndefined();
    }
  });

  it('advisory: refusal renders as a non-blocking warning, yg check exits 0', () => {
    layout(root, 'advisory');
    // Fill records the refused verdict (advisory refusals are still cached).
    expect(run(['check', '--approve'], root).status).toBe(0);

    const lock = readLock(root);
    expect(lock.verdicts['has-readme']?.['node:N']?.verdict).toBe('refused');

    const checkResult = run(['check'], root);
    // Advisory refusals render as warnings — check passes (exit 0).
    expect(checkResult.status).toBe(0);
    expect(checkResult.stdout.toLowerCase()).toMatch(/warn|advisory/);
  });

  it('enforced: refusal blocks yg check (exit 1)', () => {
    layout(root, 'enforced');
    // Fill records the refused verdict; an enforced refusal makes --approve exit 1.
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(1);

    const lock = readLock(root);
    expect(lock.verdicts['has-readme']?.['node:N']?.verdict).toBe('refused');

    const checkResult = run(['check'], root);
    // Enforced refusals block check.
    expect(checkResult.status).toBe(1);
    expect(checkResult.stdout).toContain('has-readme');
  });

  it('verdict survives an enforced → draft → enforced status round-trip — no re-fill, hash unchanged', () => {
    // Create a passing enforced verdict by adding a README so the aspect holds.
    layout(root, 'enforced');
    writeFileSync(path.join(root, 'src', 'README.md'), 'readme\n');
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\n  - src/README.md\naspects:\n  - has-readme\n`,
    );
    expect(run(['check', '--approve'], root).status).toBe(0);
    const hash0 = readLock(root).verdicts['has-readme']['node:N'].hash;

    // Round-trip the status. Status is a rendering concern only — excluded from
    // the inputHash (spec §3.1) — so the stored verdict stays valid throughout.
    for (const status of ['draft', 'enforced'] as const) {
      setStatus(root, status);
      // A plain check must NOT need a re-fill: the verdict is still valid.
      expect(run(['check'], root).status).toBe(0);
    }

    const hashN = readLock(root).verdicts['has-readme']['node:N'].hash;
    // The canonical inputHash is unchanged by status churn (source untouched).
    expect(hashN).toBe(hash0);
  });

  it('verdict survives a flip to draft and back — the entry is retained, not pruned', () => {
    // Create a passing enforced verdict with a README.
    layout(root, 'enforced');
    writeFileSync(path.join(root, 'src', 'README.md'), 'readme\n');
    writeFileSync(
      path.join(root, '.yggdrasil', 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test node\nmapping:\n  - src/a.ts\n  - src/README.md\naspects:\n  - has-readme\n`,
    );
    expect(run(['check', '--approve'], root).status).toBe(0);
    const entryBefore = readLock(root).verdicts['has-readme']?.['node:N'];
    expect(entryBefore).toBeDefined();

    // Flip to draft and run --approve. GC must NOT prune the draft pair's entry
    // (GC ignores status — spec §3.2), so the verdict survives the round-trip.
    setStatus(root, 'draft');
    expect(run(['check', '--approve'], root).status).toBe(0);
    const entryDraft = readLock(root).verdicts['has-readme']?.['node:N'];
    expect(entryDraft).toEqual(entryBefore);

    // Flip back to enforced — the retained verdict is still valid, check stays green.
    setStatus(root, 'enforced');
    expect(run(['check'], root).status).toBe(0);
  });
});
