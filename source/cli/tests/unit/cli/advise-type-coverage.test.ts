/**
 * `yg advise`'s decorative-rule demotion signal (T1) is corroborated in part by
 * a "shrinking attach set" check: an aspect is flagged only when the CURRENT
 * expected-pair universe no longer contains a unit it was fill-verified on in
 * the past. That universe comes from computeExpectedPairs — which, with
 * coverage.type_level on, includes a file enforced by its architecture type
 * alone (no owning component). Before this file's fix, `yg advise` computed
 * that universe with no type-coverage classification threaded in at all, so a
 * file-only aspect's unit could never appear in the CURRENT set even though the
 * file is still very much covered — a false "shrinking" reading, and a false
 * decorative-rule nomination.
 *
 * Real on-disk fixture (a fresh, minimal project — deliberately NOT the shared
 * sample-project fixture, so no unrelated aspect's own telemetry adds noise to
 * the exposure/shrinking counts this test reads), real spawned binary, real
 * verdict-event telemetry seeded via the exact JSONL shape core/io/events-store.ts
 * writes (mirrors tests/e2e/cli-aspects-health.test.ts's own `approvedFills`
 * convention for the same signal).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const distExists = existsSync(BIN_PATH);

function run(args: string[], cwd: string): { stdout: string; stderr: string; status: number | null } {
  const r = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status };
}

/**
 * A project with exactly two attachments of type `leaf`: the real node `n1`
 * (mapping src/n1-file.ts) and, uncovered by any node, src/leaf.ts — matched
 * by the type itself when coverage.type_level is on. Both inherit `leaf-rule`
 * (LLM, scope: per: file) from the type. `leaf-rule` has NEVER been refused
 * anywhere, at 20 recorded exposures — enough to clear the decorative-rule
 * exposure floor — all of them on the FILE-LEVEL unit (file:src/leaf.ts), the
 * one a component-only universe can never see.
 */
function buildFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'yg-advise-typecov-'));
  const ygg = path.join(root, '.yggdrasil');
  mkdirSync(path.join(ygg, 'model', 'n1'), { recursive: true });
  mkdirSync(path.join(ygg, 'aspects', 'leaf-rule'), { recursive: true });
  mkdirSync(path.join(root, 'src'), { recursive: true });

  writeFileSync(
    path.join(ygg, 'yg-config.yaml'),
    'reviewer:\n  tiers:\n    standard:\n      provider: ollama\n      consensus: 1\n      config:\n        model: llama3\n        temperature: 0\n' +
      'coverage:\n  type_level: true\n',
  );
  writeFileSync(
    path.join(ygg, 'yg-architecture.yaml'),
    'node_types:\n  leaf:\n    description: a leaf-typed attachment\n    when:\n      path: "src/leaf.ts"\n    aspects:\n      - leaf-rule\n',
  );
  writeFileSync(
    path.join(ygg, 'model', 'n1', 'yg-node.yaml'),
    'name: n1\ntype: leaf\ndescription: the one real node of type leaf\nmapping:\n  - src/n1-file.ts\n',
  );
  writeFileSync(
    path.join(ygg, 'aspects', 'leaf-rule', 'yg-aspect.yaml'),
    'name: leaf-rule\ndescription: an LLM rule attached to the leaf type\nreviewer:\n  type: llm\nstatus: enforced\nscope:\n  per: file\n',
  );
  writeFileSync(path.join(root, 'src', 'n1-file.ts'), 'export const n1 = 1;\n');
  writeFileSync(path.join(root, 'src', 'leaf.ts'), 'export const leaf = 1;\n');

  // 20 approved (never refused) fill events for leaf-rule, all on the
  // FILE-LEVEL unit — distinct hashes so each counts as its own exposure.
  const events = Array.from({ length: 20 }, (_, i) => ({
    v: 1,
    ts: '2026-07-01T00:00:00.000Z',
    source: 'fill',
    aspectId: 'leaf-rule',
    unitKey: 'file:src/leaf.ts',
    kind: 'llm',
    disposition: 'approved',
    hash: `h-${i}`,
  }));
  writeFileSync(
    path.join(ygg, '.yg-events.jsonl'),
    events.map((e) => JSON.stringify(e)).join('\n') + '\n',
  );

  return root;
}

describe.skipIf(!distExists)('yg advise — type-level coverage threading (decorative-rule shrinking signal)', () => {
  it('does NOT nominate a file-only rule as decorative+shrinking when the file is still covered by its type', () => {
    const dir = buildFixture();
    try {
      const result = run(['advise'], dir);
      expect(result.status).toBe(0);
      // Without threading, `file:src/leaf.ts` never appears in the CURRENT
      // expected-pair universe `yg advise` computes, so its 20-exposure, 0-catch
      // history reads as a shrunk attach set — a false decorative-rule
      // nomination. With real classification threaded in, the file is still
      // recognized as covered, so no such item appears.
      expect(result.stdout).not.toContain('decorative-rule:leaf-rule');
      expect(result.stdout).not.toContain("Rule 'leaf-rule' is enforceable but has never been refused");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
