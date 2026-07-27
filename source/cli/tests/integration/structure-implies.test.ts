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

describe.skipIf(!distExists)('deterministic aspect implies cascade', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'yg-implies-'));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('implier and implied are both effective pairs — editing the subject file invalidates both', () => {
    // Layout: deterministic aspect 'structural' implies deterministic aspect
    // 'astrule'. Both become effective on node N (astrule reaches N only via the
    // implies edge). src/a.ts is N's mapped subject file for both pairs, so
    // editing it folds into both inputHashes — both pairs degrade to unverified
    // and need a re-fill.
    const ygg = path.join(root, '.yggdrasil');
    mkdirSync(path.join(ygg, 'aspects', 'structural'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'astrule'), { recursive: true });
    mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });

    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1;\n');
    writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
    writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      `name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - structural\n`,
    );
    // deterministic aspect with implies: [astrule]
    writeFileSync(
      path.join(ygg, 'aspects', 'structural', 'yg-aspect.yaml'),
      `name: Structural\ndescription: structure rule that reads src/a.ts\nreviewer:\n  type: deterministic\nimplies:\n  - astrule\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'structural', 'check.mjs'),
      `export function check(ctx) { ctx.fs.read('src/a.ts'); return []; }\n`,
    );
    // implied aspect — trivially passes
    writeFileSync(
      path.join(ygg, 'aspects', 'astrule', 'yg-aspect.yaml'),
      `name: AstRule\ndescription: deterministic rule that always passes\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'astrule', 'check.mjs'),
      `export function check(_ctx) { return []; }\n`,
    );

    // Initial fill — BOTH the implier and the implied pair are computed and filled.
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(0);
    // The header reports 2 deterministic pairs (structural + the implied astrule); goes to STDERR.
    expect(fill.stderr).toMatch(/2 deterministic/);

    // Mutate the subject file shared by both pairs.
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 2;\n');

    // Plain check: both pairs recompute to a mismatching hash → unverified (exit 1).
    const checkResult = run(['check'], root);
    expect(checkResult.status).toBe(1);
    expect(checkResult.stdout.toLowerCase()).toContain('unverified');
    expect(checkResult.stdout).toContain('structural');
    expect(checkResult.stdout).toContain('astrule');

    // Re-fill clears both (deterministic, free).
    const reFill = run(['check', '--approve'], root);
    expect(reFill.status).toBe(0);

    const checkClean = run(['check'], root);
    expect(checkClean.status).toBe(0);
  });

  // status_inherit propagation IS implemented in computeEffectiveAspectStatuses
  // (source/cli/src/core/graph/aspects.ts). An enforced implier with
  // status_inherit: strictest promotes the implied aspect's effective status to
  // enforced even when the implied aspect's own default is advisory — so an
  // implied-aspect refusal BLOCKS (yg check exit 1) instead of warning (exit 0).
  // (Deterministic aspects on both sides for hermetic CI — no LLM.)
  it('aspect implies another with status_inherit: strictest — the implied aspect is promoted to enforced and blocks', () => {
    const ygg = path.join(root, '.yggdrasil');
    mkdirSync(path.join(ygg, 'aspects', 'gate'), { recursive: true });
    mkdirSync(path.join(ygg, 'aspects', 'child'), { recursive: true });
    mkdirSync(path.join(ygg, 'model', 'N'), { recursive: true });
    mkdirSync(path.join(root, 'src'), { recursive: true });
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const x = 1; // BANNED\n');
    writeFileSync(path.join(ygg, 'yg-architecture.yaml'), YG_ARCH);
    writeFileSync(path.join(ygg, 'yg-config.yaml'), YG_CONFIG);
    // gate: enforced, always passes, implies child with strictest inheritance.
    writeFileSync(
      path.join(ygg, 'aspects', 'gate', 'yg-aspect.yaml'),
      'name: Gate\ndescription: gate\nreviewer:\n  type: deterministic\nstatus: enforced\nimplies:\n  - id: child\n    status_inherit: strictest\n',
    );
    writeFileSync(path.join(ygg, 'aspects', 'gate', 'check.mjs'), 'export function check() { return []; }\n');
    // child: advisory by its OWN default; flags the BANNED token.
    writeFileSync(
      path.join(ygg, 'aspects', 'child', 'yg-aspect.yaml'),
      'name: Child\ndescription: child\nreviewer:\n  type: deterministic\nstatus: advisory\n',
    );
    writeFileSync(
      path.join(ygg, 'aspects', 'child', 'check.mjs'),
      'export function check(ctx) {\n  const v = [];\n  for (const f of ctx.files) {\n    const lines = f.content.split("\\n");\n    lines.forEach((l, i) => { if (l.includes("BANNED")) v.push({ file: f.path, line: i + 1, column: 0, message: "banned token" }); });\n  }\n  return v;\n}\n',
    );
    writeFileSync(
      path.join(ygg, 'model', 'N', 'yg-node.yaml'),
      'name: N\ntype: service\ndescription: test\nmapping:\n  - src/a.ts\naspects:\n  - gate\n',
    );

    // child reaches N ONLY via the implies edge, and strictest inheritance
    // promotes it from its own advisory default to the implier's enforced status.
    const ctx = run(['context', '--node', 'N'], root);
    expect(ctx.status).toBe(0);
    expect(ctx.stdout).toContain('child [enforced]');

    // Because child is now ENFORCED (not advisory), its BANNED refusal BLOCKS:
    // check --approve records the refused verdict and exits 1 instead of leaving
    // a non-blocking advisory warning.
    const fill = run(['check', '--approve'], root);
    expect(fill.status).toBe(1);
    expect(fill.stdout + fill.stderr).toContain('child');

    // Plain check renders the cached enforced refusal and stays red (exit 1).
    const check = run(['check'], root);
    expect(check.status).toBe(1);
    expect(check.stdout).toContain('child');
  });
});
