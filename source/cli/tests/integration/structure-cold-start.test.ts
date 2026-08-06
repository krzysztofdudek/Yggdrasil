import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
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

function layoutBase(root: string): void {
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'aspects', 's'), { recursive: true });
  mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
  writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
  writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
}

describe.skipIf(!distExists)('structure cold start + baseline migration', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-coldstart-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('cold start: never-approved structure aspect — yg impact --file identifies the owning node', () => {
    layoutBase(root);
    const ygg = path.join(root, '.yggdrasil');

    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - s\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 's', 'yg-aspect.yaml'),
      `name: S\ndescription: structure rule that reads src/a.ts\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 's', 'check.mjs'),
      `export function check(ctx) { ctx.fs.read('src/a.ts'); return []; }\n`,
    );

    // Never approved — no baseline / no checkTouchedFiles.
    // yg impact --file must identify N as owner of src/a.ts via the mapping,
    // even without a checkTouchedFiles baseline (cold-start pessimistic fallback
    // = the mapping itself is the minimum set that can be tracked).
    const result = run(['impact', '--file', 'src/a.ts'], root);
    // Either exit 0 (found owner) or shows N in output
    expect(result.stdout).toContain('N');
  });

  it('typed baseline with no checkTouched (cold start for the structure aspect) — no crash', () => {
    // Pre-seed a TYPED baseline (schemaVersion present) whose identity records no
    // per-aspect checkTouched set — the legitimate cold-start case for a newly
    // attached deterministic aspect. After attaching the aspect, yg check must
    // not crash on the absent read-set; it surfaces drift (aspect-newly-active or
    // source-drift) and reports the pair as unverified — plain yg check reports it,
    // and yg check --approve fills it. It must NOT throw or
    // produce an unformatted stack trace.
    layoutBase(root);
    const ygg = path.join(root, '.yggdrasil');

    // Write the node with NO aspects initially
    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects: []\n`,
    );

    // Pre-seed a typed baseline whose identity has no aspect read-sets.
    mkdirSync(path.join(ygg, '.drift-state'), { recursive: true });
    const baseline = {
      schemaVersion: 1,
      hash: 'cafebabe',
      files: { 'src/a.ts': 'deadbeef' },
      identity: { ownSubset: 'o', ports: {}, aspects: {} },
      aspectVerdicts: {},
    };
    writeFileSync(
      path.join(ygg, '.drift-state', 'N.json'),
      JSON.stringify(baseline, null, 2),
    );

    // Now attach a structure aspect — simulates adding a structure aspect after the
    // baseline was recorded with an older CLI version
    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - s\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 's', 'yg-aspect.yaml'),
      `name: S\ndescription: structure rule\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 's', 'check.mjs'),
      `export function check(ctx) { return []; }\n`,
    );

    // yg check must not crash — it should surface a recoverable state
    // (drift or aspect-newly-active) reporting the pair as unverified, which
    // yg check --approve fills.
    const checkResult = run(['check'], root);
    // Should exit 1 (drift or newly-active), NOT crash with an unhandled exception
    expect(checkResult.status).toBe(1);
    // The output must not contain a raw stack trace
    expect(checkResult.stdout).not.toContain('TypeError:');
    expect(checkResult.stderr).not.toContain('TypeError:');
    // Should point the user toward approve
    expect(checkResult.stdout.toLowerCase() + checkResult.stderr.toLowerCase()).toMatch(/approve/);
  });
});
