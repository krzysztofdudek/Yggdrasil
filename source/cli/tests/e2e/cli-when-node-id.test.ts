// =============================================================================
// CLI E2E — `when: node.id` and `not:` — excluding one named child from a
// parent-attached deterministic aspect, without removing the child from the
// parent, and proving the pair hash never sees the `when` clause (Y3).
//
// A hand-authored minimal graph is scaffolded per scenario (parent + two
// children, `parent`/`parent/a`/`parent/b`), matching the sample-project-ports
// fixture's own module/consumer/provider layout but built entirely in code —
// no new committed fixture. The single aspect (`audit`) is deterministic
// (`check.mjs` always returns `[]`), so no scenario ever calls a reviewer:
// fully hermetic, no network, no clock, no randomness.
//
//    1. `when: { not: { node: { id: <A> } } }` on the parent's own aspect →
//       `yg context` excludes A, includes B and the parent itself
//    2. `yg check --approve --only-deterministic` → exactly the pairs implied
//       by scenario 1 (parent + B; A carries no pair), then `yg check` exit 0
//    3. editing ONLY the `when` id (exclude B instead of A) → no pair goes
//       `stale`; the pair that left the expected set (B) disappears, the pair
//       that joined (A) is `unverified`, and the pair that stayed (parent)
//       keeps the exact same hash — the Y3 claim, shown by execution
//    4. for contrast: editing the rule's OWN content (`check.mjs`) invalidates
//       every existing pair (`stale`) — same graph, opposite outcome
//    5. `node: { id: [<A>, <B>] } }` → effective on exactly those two
//    6. `node: { id: '<missing>' }` → `yg check` exit 1, `when-unknown-node`
//       naming the missing path and the attach-site context
//    7. `node: { id: [] }` → exit 1, message names `id` and the owning file
//    8. `node: { id: '<parent>' }` on the parent's own attach → effective only
//       on the parent, not on either child (exact match, not subtree)
//    9. a node id containing unicode → matches literally
//   10. broken YAML (tab indentation) inside a `when:` block → exit 1, a
//       structured `yaml-invalid` refusal naming the offending file. Placed in
//       `yg-node.yaml` (the attach site `node.id` actually lives in) rather
//       than `yg-aspect.yaml`: a raw YAML syntax error in a NODE file is
//       wrapped into a structured refusal, but the same syntax error in an
//       ASPECT file today escapes as an unclassified "file a bug" abort (the
//       node-parser catches `parseYaml` throws the way the flow-parser does;
//       the aspect-parser does not) — logged separately as a dogfood finding,
//       out of scope for this feature.
//   11. `yg context --node <A> --json` → `aspects` omits the excluded aspect,
//       and the document carries no `dropped` key at all — `dropped` is
//       type-governed-FILE-only (formatters/context-json.ts:83), so its
//       silence for a `--node` target is the documented contract, not a gap.
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const PORTS_FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'sample-project-ports');
// A parseable yg-config.yaml, copied verbatim — `yg check` requires one and
// its content is irrelevant here (the one aspect is deterministic).
const FIXTURE_CONFIG = path.join(PORTS_FIXTURE, '.yggdrasil', 'yg-config.yaml');

const distExists = existsSync(BIN_PATH);

function run(
  args: string[],
  cwd: string,
): { stdout: string; stderr: string; status: number | null; all: string } {
  const result = spawnSync('node', [BIN_PATH, ...args], { cwd, encoding: 'utf-8' });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

const writeFile = (dir: string, rel: string, content: string): void => {
  const abs = path.join(dir, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, 'utf-8');
};

interface CheckJsonPair {
  aspect: string;
  unit: { kind: string; path: string };
  verdict: string;
  hash: string | null;
}
interface CheckJsonDoc {
  exit: { code: number };
  pairs: CheckJsonPair[];
}

function checkJson(dir: string): CheckJsonDoc {
  const r = run(['check', '--json'], dir);
  return JSON.parse(r.stdout) as CheckJsonDoc;
}

function findPair(doc: CheckJsonDoc, aspect: string, unitPath: string): CheckJsonPair | undefined {
  return doc.pairs.find((p) => p.aspect === aspect && p.unit.path === unitPath);
}

interface ContextJsonDoc {
  aspects: Array<{ id: string }>;
  dropped?: Array<{ id: string; reason: string }>;
}

function contextJson(dir: string, node: string): ContextJsonDoc {
  const r = run(['context', '--node', node, '--json'], dir);
  return JSON.parse(r.stdout) as ContextJsonDoc;
}

/**
 * Scaffold a fresh temp dir with a hand-authored parent + two-children graph:
 * `parent`, `parent/a`, `parent/b` — all mapped, all type `unit` (the single
 * architecture type, `when: path: "**"` so every file is coverable). The
 * `audit` aspect is deterministic and attached to the parent's OWN aspect list
 * (channel 1) with the given `when` predicate (already indented as a `when:`
 * block body, e.g. `'    when:\n      not:\n        node:\n          id: parent/a\n'`).
 * Passing `undefined` omits `when` entirely (the no-op control case).
 */
function scaffoldFamily(label: string, whenBlock: string | undefined, childAId = 'a'): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-whenid-${label}-`));
  cpSync(FIXTURE_CONFIG, path.join(dir, '.yggdrasil', 'yg-config.yaml'));
  writeFile(
    dir,
    '.yggdrasil/yg-architecture.yaml',
    `node_types:\n  unit:\n    description: 'A unit node — used for parent and children alike in this fixture.'\n    log_required: false\n    when:\n      path: "**"\n`,
  );
  const attach = whenBlock ? `aspects:\n  - id: audit\n${whenBlock}` : `aspects:\n  - audit\n`;
  writeFile(
    dir,
    '.yggdrasil/model/parent/yg-node.yaml',
    `name: Parent\ndescription: The parent node; carries the audit aspect.\ntype: unit\n${attach}mapping:\n  - src/parent/index.ts\n`,
  );
  writeFile(
    dir,
    `.yggdrasil/model/parent/${childAId}/yg-node.yaml`,
    `name: ChildA\ndescription: Child A.\ntype: unit\nmapping:\n  - src/parent/a.ts\n`,
  );
  writeFile(
    dir,
    '.yggdrasil/model/parent/b/yg-node.yaml',
    `name: ChildB\ndescription: Child B.\ntype: unit\nmapping:\n  - src/parent/b.ts\n`,
  );
  writeFile(
    dir,
    '.yggdrasil/aspects/audit/yg-aspect.yaml',
    `name: Audit\ndescription: Deterministic marker aspect used to prove when node.id exclusion.\nreviewer:\n  type: deterministic\nstatus: enforced\n`,
  );
  writeFile(
    dir,
    '.yggdrasil/aspects/audit/check.mjs',
    `export function check(ctx) {\n  void ctx;\n  return [];\n}\n`,
  );
  writeFile(dir, 'src/parent/index.ts', 'export const index = 1;\n');
  writeFile(dir, 'src/parent/a.ts', 'export const a = 1;\n');
  writeFile(dir, 'src/parent/b.ts', 'export const b = 1;\n');
  return dir;
}

const NOT_A_WHEN = '    when:\n      not:\n        node:\n          id: parent/a\n';

describe.skipIf(!distExists)('CLI E2E — when: node.id and not:', () => {
  // --- Scenario 1: exclusion by id, effective everywhere else ---

  it('1: not:{node:{id:<A>}} excludes A, keeps B and the parent effective', () => {
    const dir = scaffoldFamily('s1', NOT_A_WHEN);
    try {
      const a = run(['context', '--node', 'parent/a'], dir);
      expect(a.status).toBe(0);
      expect(a.all).not.toContain('audit');

      const b = run(['context', '--node', 'parent/b'], dir);
      expect(b.status).toBe(0);
      expect(b.all).toContain('audit');
      expect(b.all).toContain('Must satisfy');

      const p = run(['context', '--node', 'parent'], dir);
      expect(p.status).toBe(0);
      expect(p.all).toContain('audit');
      expect(p.all).toContain('Must satisfy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 2: approve fills exactly the pairs the exclusion implies ---

  it('2: --approve --only-deterministic fills exactly {parent, parent/b}; then plain check is exit 0', () => {
    const dir = scaffoldFamily('s2', NOT_A_WHEN);
    try {
      const approve = run(['check', '--approve', '--only-deterministic'], dir);
      expect(approve.status).toBe(0);

      const doc = checkJson(dir);
      // A carries no pair at all: it never became an expected pair because the
      // `when` excluded it before pair expansion ever considers it.
      expect(findPair(doc, 'audit', 'parent/a')).toBeUndefined();
      expect(findPair(doc, 'audit', 'parent')?.verdict).toBe('approved');
      expect(findPair(doc, 'audit', 'parent/b')?.verdict).toBe('approved');
      expect(doc.pairs.filter((p) => p.aspect === 'audit')).toHaveLength(2);

      const check = run(['check'], dir);
      expect(check.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 3 & 4, side by side: a `when` edit vs. a rule-content edit ---
  // Scenario 3 is the pair-hash-exclusion claim (Y3) shown by execution: editing
  // ONLY the `when` clause changes which pairs are EXPECTED, but never touches
  // the hash of a pair that stays expected. Scenario 4 is the contrast: editing
  // the rule's own content invalidates every pair that already existed.

  it('3: editing only the when id — no pair goes stale, and the surviving (parent) pair keeps its hash', () => {
    const dir = scaffoldFamily('s3', NOT_A_WHEN);
    try {
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
      const before = checkJson(dir);
      const parentHashBefore = findPair(before, 'audit', 'parent')?.hash;
      expect(parentHashBefore).toMatch(/^[0-9a-f]{64}$/);

      // Flip the excluded child from A to B — a pure `when` edit, nothing else.
      const nodeYaml = path.join(dir, '.yggdrasil', 'model', 'parent', 'yg-node.yaml');
      writeFileSync(nodeYaml, readFileSync(nodeYaml, 'utf-8').replace('id: parent/a', 'id: parent/b'), 'utf-8');

      const after = checkJson(dir);
      const pairs = after.pairs.filter((p) => p.aspect === 'audit');

      // No pair anywhere is `stale` — a `when` edit is not a hash-relevant edit.
      expect(pairs.some((p) => p.verdict === 'stale')).toBe(false);

      // B left the expected set entirely — it just disappears, it does not
      // linger as stale or refused.
      expect(findPair(after, 'audit', 'parent/b')).toBeUndefined();

      // A joined the expected set fresh — `unverified` (never judged), not stale.
      expect(findPair(after, 'audit', 'parent/a')?.verdict).toBe('unverified');
      expect(findPair(after, 'audit', 'parent/a')?.hash).toBeNull();

      // The parent's own pair was effective before AND after (its own-channel
      // `when` is evaluated against the parent itself, which is never the
      // excluded child either way) — it stayed in the expected set, and its
      // hash is byte-identical: the `when` edit never reached it.
      const parentAfter = findPair(after, 'audit', 'parent');
      expect(parentAfter?.verdict).toBe('approved');
      expect(parentAfter?.hash).toBe(parentHashBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('4: for contrast, editing the rule content (check.mjs) invalidates every existing pair (stale)', () => {
    const dir = scaffoldFamily('s4', NOT_A_WHEN);
    try {
      expect(run(['check', '--approve', '--only-deterministic'], dir).status).toBe(0);
      const before = checkJson(dir);
      const parentHashBefore = findPair(before, 'audit', 'parent')?.hash;

      // One extra space — a one-byte-shaped edit to the rule's OWN content.
      writeFile(
        dir,
        '.yggdrasil/aspects/audit/check.mjs',
        `export function check(ctx) {\n  void ctx;\n  return [ ];\n}\n`,
      );

      const after = checkJson(dir);
      expect(findPair(after, 'audit', 'parent')?.verdict).toBe('stale');
      expect(findPair(after, 'audit', 'parent/b')?.verdict).toBe('stale');
      // `hash` reports the RECORDED verdict's bound hash, unchanged until the
      // next approve re-fills it — `stale` itself, not a hash diff here, is
      // what proves check.mjs's bytes now disagree with what was approved.
      expect(findPair(after, 'audit', 'parent')?.hash).toBe(parentHashBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 5: a list matches exactly its entries ---

  it('5: node.id: [A, B] is effective on exactly those two, not on the parent', () => {
    const whenBlock = '    when:\n      node:\n        id: ["parent/a", "parent/b"]\n';
    const dir = scaffoldFamily('s5', whenBlock);
    try {
      expect(run(['context', '--node', 'parent/a'], dir).all).toContain('Must satisfy');
      expect(run(['context', '--node', 'parent/b'], dir).all).toContain('Must satisfy');
      const p = run(['context', '--node', 'parent'], dir);
      expect(p.status).toBe(0);
      expect(p.all).not.toContain('Must satisfy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 6: an unknown id is a structured, blocking reference error ---

  it('6: node.id naming a node that does not exist → exit 1, when-unknown-node names the path and the attach context', () => {
    const whenBlock = '    when:\n      node:\n        id: nie/ma\n';
    const dir = scaffoldFamily('s6', whenBlock);
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('when-unknown-node');
      expect(check.all).toContain('nie/ma');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 7: an empty id list is refused (it looks like a filter but excludes nothing) ---

  it('7: node.id: [] → exit 1, message names id and the owning aspect file', () => {
    const whenBlock = '    when:\n      node:\n        id: []\n';
    const dir = scaffoldFamily('s7', whenBlock);
    try {
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('id');
      expect(check.all).toContain('yg-node.yaml');
      expect(check.all).toContain('parent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 8: exact match, never a subtree match ---

  it('8: node.id: <parent> on the parent\'s own attach is effective only on the parent, not on either child', () => {
    const whenBlock = '    when:\n      node:\n        id: parent\n';
    const dir = scaffoldFamily('s8', whenBlock);
    try {
      expect(run(['context', '--node', 'parent'], dir).all).toContain('Must satisfy');
      expect(run(['context', '--node', 'parent/a'], dir).all).not.toContain('Must satisfy');
      expect(run(['context', '--node', 'parent/b'], dir).all).not.toContain('Must satisfy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 9: unicode in the id matches literally ---

  it('9: a node id containing unicode matches literally', () => {
    const childId = 'usługi płatności';
    const whenBlock = `    when:\n      node:\n        id: "parent/${childId}"\n`;
    const dir = scaffoldFamily('s9', whenBlock, childId);
    try {
      expect(run(['context', '--node', `parent/${childId}`], dir).all).toContain('Must satisfy');
      expect(run(['context', '--node', 'parent/b'], dir).all).not.toContain('Must satisfy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 10: broken YAML in the when-carrying file refuses, naming the file ---
  // Placed in yg-node.yaml, not yg-aspect.yaml — see the file-header note above:
  // the node-parser wraps a raw YAML syntax error into a structured refusal
  // naming the file; the aspect-parser (as of this writing) does not, and lets
  // it escape as an unclassified abort instead. Logged as a dogfood finding.

  it('10: tab-indented (invalid) YAML inside a node\'s when: block → exit 1, refusal names the file', () => {
    const dir = scaffoldFamily('s10', undefined);
    try {
      const nodeYaml = path.join(dir, '.yggdrasil', 'model', 'parent', 'yg-node.yaml');
      writeFileSync(
        nodeYaml,
        'name: Parent\ndescription: broken.\ntype: unit\naspects:\n  - id: audit\n    when:\n\t\tnode:\n\t\t  id: parent/a\nmapping:\n  - src/parent/index.ts\n',
        'utf-8',
      );
      const check = run(['check'], dir);
      expect(check.status).toBe(1);
      expect(check.all).toContain('yaml-invalid');
      expect(check.all).toContain('yg-node.yaml');
      expect(check.all).toContain('parent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --- Scenario 11: yg context --json — the excluded child carries no trace of the aspect ---

  it("11: yg context --node <A> --json omits the excluded aspect and carries no `dropped` key", () => {
    const dir = scaffoldFamily('s11', NOT_A_WHEN);
    try {
      const doc = contextJson(dir, 'parent/a');
      expect(doc.aspects.some((a) => a.id === 'audit')).toBe(false);
      // `dropped` is documented as type-governed-FILE-only (formatters/context-
      // json.ts:83) — a `--node` target never populates it, so its total
      // absence here is the contract, not a missing feature.
      expect(doc.dropped).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
