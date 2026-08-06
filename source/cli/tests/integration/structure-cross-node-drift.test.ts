import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readLock as readUnifiedLock } from '../../src/io/lock-store.js';

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

// 'service' type has NO relations: map, so 'uses' is an unconstrained relation
// type — the validator skips architecture-relation enforcement for it. This lets
// node N declare a `uses` relation to node B without an explicit allow-list.
const YG_ARCH = `node_types:
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
 * Lay out a repo with two nodes:
 *   - B: owns src/b.ts (no aspects).
 *   - N: owns src/a.ts, declares `uses -> B`, carries an ENFORCED deterministic
 *     aspect `reads-b` that reaches B cross-node via ctx.graph.node('B') and
 *     READS B's mapped file content. The cross-node content read records src/b.ts
 *     in the (reads-b, node:N) lock entry's `touched` map — so editing src/b.ts
 *     invalidates N's verdict (it becomes unverified). (Reading a graph file's
 *     `.content` folds a read: observation; merely listing `.files`/`.path` does
 *     not — that is the invalidation-width contract.)
 */
function layout(root: string): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'aspects', 'reads-b'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'B'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);

  writeFileSync(
    path.join(ygg, 'model', 'B', 'yg-node.yaml'),
    `name: B\ntype: service\ndescription: file owner\nmapping:\n  - src/b.ts\n`,
  );
  writeFileSync(
    path.join(ygg, 'model', 'N', 'yg-node.yaml'),
    `name: N\ntype: service\ndescription: dependent node\nmapping:\n  - src/a.ts\nrelations:\n  - target: B\n    type: uses\naspects:\n  - reads-b\n`,
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'reads-b', 'yg-aspect.yaml'),
    `name: ReadsB\ndescription: reads node B's file cross-node\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
  );
  // Reaching B via ctx.graph.node('B') records a graph:B observation (B's
  // yg-node.yaml); READING each of B's files' `.content` additionally records a
  // read:src/b.ts observation (B's mapped file content) in N's lock entry's
  // `touched` map — this is the cross-node content observation under test.
  writeFileSync(
    path.join(ygg, 'aspects', 'reads-b', 'check.mjs'),
    `export function check(ctx) {\n  const b = ctx.graph.node('B');\n  if (b) { for (const f of b.files) void f.content; }\n  return [];\n}\n`,
  );
}

function readLock(root: string): {
  verdicts: Record<string, Record<string, { verdict: string; hash: string; touched?: Array<[string, string]> }>>;
} {
  // The 5.1.0 lock is a three-file triad; readUnifiedLock merges them back into
  // the unified { version, verdicts, nodes } shape. The `reads-b` aspect is
  // deterministic, so its verdicts live in the gitignored det file — the merge
  // surfaces them here just as the legacy single yg-lock.json once did.
  return readUnifiedLock(path.join(root, '.yggdrasil')) as ReturnType<typeof readLock>;
}

describe.skipIf(!distExists)('deterministic aspect cross-node invalidation + impact', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-xnode-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('editing a cross-node file observed by a deterministic aspect invalidates the dependent node', () => {
    layout(root);

    // Fill the whole repo (deterministic, free).
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(0);

    // N's (reads-b) lock entry must record src/b.ts under `touched` as a
    // read:src/b.ts observation — proof the cross-node read participates in N's
    // verification inputs.
    const lock = readLock(root);
    const entry = lock.verdicts['reads-b']?.['node:N'];
    expect(entry).toBeDefined();
    expect(entry!.verdict).toBe('approved');
    const touchedKeys = (entry!.touched ?? []).map(([k]) => k);
    expect(touchedKeys).toContain('read:src/b.ts');
    // src/b.ts is owned by B, not N — it is NOT a subject file of N, only an
    // out-of-subject observation. (B's own entry, if any, would carry it as a
    // subject; N carries it only as `touched`.)

    // Clean check after fill.
    const checkClean = run(['check'], root);
    expect(checkClean.status).toBe(0);

    // Edit B's file — N observes it cross-node, so N's verdict must invalidate.
    writeFileSync(path.join(root, 'src', 'b.ts'), 'export const b = 2;\n');

    const checkDrift = run(['check'], root);
    expect(checkDrift.status).toBe(1);
    expect(checkDrift.stdout.toLowerCase()).toContain('unverified');
    expect(checkDrift.stdout).toContain('N');

    // Re-fill → re-verifies N's deterministic pair (free) and clears it.
    const reFill = run(['check', '--approve'], root);
    expect(reFill.status).toBe(0);

    const checkAfter = run(['check'], root);
    expect(checkAfter.status).toBe(0);
  });

  it('yg impact --file on a cross-node-observed file names the dependent node', () => {
    layout(root);

    // Fill so N's lock entry records src/b.ts as a cross-node observation.
    expect(run(['check', '--approve'], root).status).toBe(0);

    const impact = run(['impact', '--file', 'src/b.ts'], root);
    // src/b.ts is owned by B AND observed cross-node by N's deterministic aspect.
    // The deterministic-observation section (sourced from the lock's `touched`
    // maps) must name N — not report "Blast radius: 0".
    expect(impact.stdout).toContain('N');
    expect(impact.stdout).not.toMatch(/Blast radius:\s*0\b/);
  });
});
