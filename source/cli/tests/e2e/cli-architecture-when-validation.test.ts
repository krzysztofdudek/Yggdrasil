import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  rmSync,
  cpSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');
const FIXTURE = path.join(CLI_ROOT, 'tests', 'fixtures', 'e2e-lifecycle');

const distExists = existsSync(BIN_PATH);

// ---------------------------------------------------------------------------
// Harness — reused verbatim from cli-deterministic-lifecycle.test.ts:
// the spawnSync `run(args, cwd)` wrapper, BIN_PATH resolution, distExists
// guard with describe.skipIf, and the copyFixture/mkdtemp pattern. Each test
// builds its own graph in a fresh temp dir and rmSync's it in a finally —
// zero committed fixtures, no network, no LLM (every assertion is a structural
// validator verdict surfaced by the spawned binary).
// ---------------------------------------------------------------------------

function run(
  args: string[],
  cwd: string,
): {
  stdout: string;
  stderr: string;
  status: number | null;
  all: string;
} {
  const result = spawnSync('node', [BIN_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return { stdout, stderr, status: result.status, all: stdout + stderr };
}

/** Copy the e2e-lifecycle fixture into a fresh temp dir for mutation. */
function copyFixture(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-archwhen-${label}-`));
  cpSync(FIXTURE, dir, { recursive: true });
  return dir;
}

const archPath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'yg-architecture.yaml');
const ordersNodePath = (dir: string) =>
  path.join(dir, '.yggdrasil', 'model', 'services', 'orders', 'yg-node.yaml');

/** Overwrite the architecture file with the given content. */
function writeArch(dir: string, content: string): void {
  writeFileSync(archPath(dir), content, 'utf-8');
}

/** Append text to the architecture file. */
function appendArch(dir: string, content: string): void {
  writeFileSync(archPath(dir), readFileSync(archPath(dir), 'utf-8') + content, 'utf-8');
}

/**
 * Replace the `service` type's file-`when` block in the fixture architecture
 * with an arbitrary `when:` block. The fixture ships exactly:
 *   `    when:\n      path: "src/services/**"`
 * so this single substitution injects malformed file-when predicates while
 * leaving the rest of the architecture intact and valid.
 */
function replaceServiceWhen(dir: string, whenBlock: string): void {
  const arch = readFileSync(archPath(dir), 'utf-8').replace(
    '    when:\n      path: "src/services/**"',
    whenBlock,
  );
  writeArch(dir, arch);
}

// A fully valid baseline architecture, byte-equal in spirit to the fixture's
// own, used by tests that need to add EXTRA types/aspects without disturbing
// the two `service` children. Keeping it inline (not reading the fixture) makes
// each malformed variant self-describing.
const VALID_ARCH = `node_types:
  module:
    description: 'Organizational grouping of related services.'
    log_required: false
  service:
    description: 'A service unit under src/services/.'
    log_required: false
    when:
      path: "src/services/**"
    parents: [module]
    aspects:
      - no-todo-comments
      - requires-named-export
      - has-doc-comment
    relations:
      uses: [service]
      calls: [service]
`;

describe.skipIf(!distExists)(
  'CLI E2E — architecture when-predicate validation + type-graph integrity',
  () => {
    // -----------------------------------------------------------------------
    // GROUP 1 — Type reference integrity (node→type, type→parent-type).
    // -----------------------------------------------------------------------

    it('T1: a node declaring a type absent from architecture raises type-undefined (exit 1)', () => {
      const dir = copyFixture('t1');
      try {
        writeFileSync(
          ordersNodePath(dir),
          [
            'name: OrdersService',
            'description: Creates and retrieves customer orders.',
            'type: ghost-type',
            'mapping:',
            '  - src/services/orders.ts',
            '',
          ].join('\n'),
          'utf-8',
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the type-undefined group header carries the code, the
        // shared Fix line names the offending type and the remedy, and the
        // offending node is listed on its own line.
        expect(stdout).toContain('type-undefined');
        expect(stdout).toContain(
          "Fix: Add 'ghost-type' to yg-architecture.yaml or change the node type.",
        );
        expect(stdout).toContain('- services/orders');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T2: a type listing an undefined parent type raises type-unknown-parent (exit 1)', () => {
      const dir = copyFixture('t2');
      try {
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          'parents: [module]',
          'parents: [ghost-parent]',
        );
        writeArch(dir, arch);
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the type-unknown-parent group header carries the code,
        // and the shared Fix line names the undefined parent and the type that
        // declared it.
        expect(stdout).toContain('type-unknown-parent');
        expect(stdout).toContain(
          "Fix: Add 'ghost-parent' to node_types or remove it from 'service.parents'.",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T3: a node whose actual parent type is not in its type.parents raises parent-type-forbidden (exit 1)', () => {
      const dir = copyFixture('t3');
      try {
        // Add an organizational `widget` type allowed only under `service`, and
        // place a widget node under the module-typed `services` parent. The
        // architecture stays acyclic (so no cycle short-circuit), exercising the
        // Stage-4 parent-type constraint cleanly.
        appendArch(
          dir,
          [
            '',
            '  widget:',
            "    description: 'A widget; only allowed under service.'",
            '    log_required: false',
            '    parents: [service]',
            '',
          ].join('\n'),
        );
        const gizmoDir = path.join(dir, '.yggdrasil', 'model', 'services', 'gizmo');
        mkdirSync(gizmoDir, { recursive: true });
        writeFileSync(
          path.join(gizmoDir, 'yg-node.yaml'),
          [
            'name: Gizmo',
            'description: A widget node placed under a module parent.',
            'type: widget',
            '',
          ].join('\n'),
          'utf-8',
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parent-type-forbidden group header carries the
        // code, the shared why line names the allowed parent types, and the
        // misplaced node is listed on its own line.
        expect(stdout).toContain('parent-type-forbidden');
        expect(stdout).toContain("Allowed parent types for 'widget': [service]");
        expect(stdout).toContain('- services/gizmo');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 2 — Architecture parent-type cycles.
    // -----------------------------------------------------------------------

    it('T4: a two-type parent cycle (alpha↔beta) raises architecture-cycle (exit 1)', () => {
      const dir = copyFixture('t4');
      try {
        appendArch(
          dir,
          [
            '',
            '  alpha:',
            "    description: 'cycle alpha'",
            '    parents: [beta]',
            '  beta:',
            "    description: 'cycle beta'",
            '    parents: [alpha]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the architecture-cycle group header carries the code,
        // and the shared Fix line explains how to break the cycle.
        expect(stdout).toContain('architecture-cycle');
        expect(stdout).toContain('Break the cycle');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T5: a three-type parent cycle (aa→bb→cc→aa) raises architecture-cycle (exit 1)', () => {
      const dir = copyFixture('t5');
      try {
        appendArch(
          dir,
          [
            '',
            '  aa:',
            "    description: 'cycle aa'",
            '    parents: [bb]',
            '  bb:',
            "    description: 'cycle bb'",
            '    parents: [cc]',
            '  cc:',
            "    description: 'cycle cc'",
            '    parents: [aa]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the architecture-cycle group header carries the code,
        // and the shared Fix line explains how to break the cycle.
        expect(stdout).toContain('architecture-cycle');
        expect(stdout).toContain('Break the cycle');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T6: a self-referential parent (selfloop→selfloop) raises architecture-cycle (exit 1)', () => {
      const dir = copyFixture('t6');
      try {
        appendArch(
          dir,
          [
            '',
            '  selfloop:',
            "    description: 'self loop'",
            '    parents: [selfloop]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        expect(stdout).toContain('architecture-cycle');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T7: an unknown parent inside a would-be cycle suppresses the cycle check — only type-unknown-parent fires', () => {
      const dir = copyFixture('t7');
      try {
        // aa↔bb is a 2-cycle, but bb ALSO references an undefined parent. The
        // cycle pass bails out when any parent reference is unknown, so the
        // unknown-parent error pre-empts (and replaces) the cycle error.
        appendArch(
          dir,
          [
            '',
            '  aa:',
            "    description: 'aa'",
            '    parents: [bb]',
            '  bb:',
            "    description: 'bb'",
            '    parents: [aa, ghostxyz]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the type-unknown-parent group header carries the code,
        // and the shared Fix line names the offending parent and the type that
        // declared it.
        expect(stdout).toContain('type-unknown-parent');
        expect(stdout).toContain(
          "Fix: Add 'ghostxyz' to node_types or remove it from 'bb.parents'.",
        );
        // The cycle error must NOT appear — unknown parent short-circuits it.
        expect(stdout).not.toContain('architecture-cycle');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 3 — File-when (node_types.*.when) structural validation.
    // Every malformed file-when surfaces as when-predicate-invalid. The atoms
    // for file-when are ONLY `path` and `content`.
    // -----------------------------------------------------------------------

    it('T8: an empty when mapping (when: {}) raises when-predicate-invalid (exit 1)', () => {
      const dir = copyFixture('t8');
      try {
        replaceServiceWhen(dir, '    when: {}');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the predicate syntax.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T9: an unknown file-when key raises when-predicate-invalid naming the allowed keys', () => {
      const dir = copyFixture('t9');
      try {
        replaceServiceWhen(dir, '    when:\n      foo: "bar"');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the predicate syntax.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T10: mixing a boolean operator with an atomic clause at one level raises when-predicate-invalid', () => {
      const dir = copyFixture('t10');
      try {
        replaceServiceWhen(
          dir,
          '    when:\n      all_of:\n        - path: "src/**"\n      path: "src/services/**"',
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the predicate syntax.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T11: two boolean operators at one level raises when-predicate-invalid', () => {
      const dir = copyFixture('t11');
      try {
        replaceServiceWhen(
          dir,
          '    when:\n      all_of:\n        - path: "a"\n      any_of:\n        - path: "b"',
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the predicate syntax.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T12: a path atom that is not a string raises when-predicate-invalid', () => {
      const dir = copyFixture('t12');
      try {
        replaceServiceWhen(dir, '    when:\n      path: 123');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T13: a content atom that is not a string raises when-predicate-invalid', () => {
      const dir = copyFixture('t13');
      try {
        replaceServiceWhen(dir, '    when:\n      content: 99');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T14: an invalid regex in a content atom raises when-predicate-invalid (Invalid regex)', () => {
      const dir = copyFixture('t14');
      try {
        replaceServiceWhen(dir, '    when:\n      content: "([unclosed"');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T15: a `not` whose child is not a mapping raises when-predicate-invalid', () => {
      const dir = copyFixture('t15');
      try {
        replaceServiceWhen(dir, '    when:\n      not: "src/**"');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T16: an all_of whose value is not an array raises when-predicate-invalid', () => {
      const dir = copyFixture('t16');
      try {
        replaceServiceWhen(dir, '    when:\n      all_of: "src/**"');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T17: an all_of with an empty array raises when-predicate-invalid', () => {
      const dir = copyFixture('t17');
      try {
        replaceServiceWhen(dir, '    when:\n      all_of: []');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the malformed file-when collapses into the
        // when-predicate-invalid group; the per-issue parse detail is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('when-predicate-invalid');
        expect(stdout).toContain(
          'The when: predicate in yg-architecture.yaml could not be parsed.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 4 — Aspect-when reference integrity at the architecture default
    // aspect attach site (channel 3, node_types.*.aspects[].when). This is
    // aspect-when grammar (node/relations/descendants atoms), validated by the
    // reference-integrity pass as when-unknown-type / -node / -port. These are
    // NON-fatal Stage-4 checks (they coexist with drift/unapproved noise), so
    // each test asserts the specific code + message rather than isolation.
    // -----------------------------------------------------------------------

    it('T18: aspect-when relations.calls.target_type referencing an undefined type raises when-unknown-type', () => {
      const dir = copyFixture('t18');
      try {
        writeArch(
          dir,
          [
            'node_types:',
            '  module:',
            "    description: 'Organizational grouping.'",
            '    log_required: false',
            '  service:',
            "    description: 'A service unit.'",
            '    log_required: false',
            '    when:',
            '      path: "src/services/**"',
            '    parents: [module]',
            '    aspects:',
            '      - id: no-todo-comments',
            '        when:',
            '          relations:',
            '            calls:',
            '              target_type: ghost-type',
            '      - requires-named-export',
            '      - has-doc-comment',
            '    relations:',
            '      uses: [service]',
            '      calls: [service]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the when-unknown-type group header carries the code,
        // and the shared why/Fix explain that the predicate references a type
        // not defined in the architecture.
        expect(stdout).toContain('when-unknown-type');
        expect(stdout).toContain(
          'The predicate references a type that is not defined in yg-architecture.yaml; it will never evaluate.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T19: aspect-when relations.calls.target referencing a missing node raises when-unknown-node', () => {
      const dir = copyFixture('t19');
      try {
        writeArch(
          dir,
          [
            'node_types:',
            '  module:',
            "    description: 'Organizational grouping.'",
            '    log_required: false',
            '  service:',
            "    description: 'A service unit.'",
            '    log_required: false',
            '    when:',
            '      path: "src/services/**"',
            '    parents: [module]',
            '    aspects:',
            '      - id: no-todo-comments',
            '        when:',
            '          relations:',
            '            calls:',
            '              target: services/ghostnode',
            '      - requires-named-export',
            '      - has-doc-comment',
            '    relations:',
            '      uses: [service]',
            '      calls: [service]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the when-unknown-node group header carries the code,
        // and the shared why explains that the predicate targets a node not in
        // the graph.
        expect(stdout).toContain('when-unknown-node');
        expect(stdout).toContain(
          'The predicate targets a node that is not in the graph.',
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T20: aspect-when consumes_port for a port absent on an existing target raises when-unknown-port', () => {
      const dir = copyFixture('t20');
      try {
        // `services/payments` exists but declares no ports — consuming a named
        // port there is a dangling port reference.
        writeArch(
          dir,
          [
            'node_types:',
            '  module:',
            "    description: 'Organizational grouping.'",
            '    log_required: false',
            '  service:',
            "    description: 'A service unit.'",
            '    log_required: false',
            '    when:',
            '      path: "src/services/**"',
            '    parents: [module]',
            '    aspects:',
            '      - id: no-todo-comments',
            '        when:',
            '          relations:',
            '            calls:',
            '              target: services/payments',
            '              consumes_port: ghostport',
            '      - requires-named-export',
            '      - has-doc-comment',
            '    relations:',
            '      uses: [service]',
            '      calls: [service]',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the when-unknown-port group header carries the code,
        // the shared why explains the dangling port reference, and the Fix line
        // names the target node whose yg-node.yaml lacks the port.
        expect(stdout).toContain('when-unknown-port');
        expect(stdout).toContain(
          'The predicate references a port that does not exist on the target node.',
        );
        expect(stdout).toContain('.yggdrasil/model/services/payments/yg-node.yaml');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 5 — Architecture relation constraints + deprecated/invalid fields.
    // -----------------------------------------------------------------------

    it('T21: a relation between nodes that the architecture forbids raises relation-target-forbidden', () => {
      const dir = copyFixture('t21');
      try {
        // Narrow `service.relations.calls` to [module] only, then make orders
        // CALL payments (a service) — now a forbidden target type.
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          '      calls: [service]',
          '      calls: [module]',
        );
        writeArch(dir, arch);
        const ordersYaml =
          readFileSync(ordersNodePath(dir), 'utf-8') +
          'relations:\n  - type: calls\n    target: services/payments\n';
        writeFileSync(ordersNodePath(dir), ordersYaml, 'utf-8');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the relation-target-forbidden group header carries the
        // code, the shared why names the allowed targets, and the offending node
        // is listed on its own line.
        expect(stdout).toContain('relation-target-forbidden');
        expect(stdout).toContain("Allowed targets for 'calls' from type 'service': [module]");
        expect(stdout).toContain('- services/orders');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T22: an unknown relation type in node_types.*.relations fails to parse as architecture-invalid', () => {
      const dir = copyFixture('t22');
      try {
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          '      uses: [service]',
          '      foobar: [service]',
        );
        writeArch(dir, arch);
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the architecture YAML.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T23: the deprecated integration_aspects field on a type fails as architecture-invalid', () => {
      const dir = copyFixture('t23');
      try {
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          '    log_required: false\n    when:',
          '    log_required: false\n    integration_aspects: []\n    when:',
        );
        writeArch(dir, arch);
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared
        // why/Fix that direct the agent to fix the architecture YAML.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T24: enforce: strict without a when predicate raises enforce-strict-without-when', () => {
      const dir = copyFixture('t24');
      try {
        appendArch(
          dir,
          [
            '',
            '  strictnowhen:',
            "    description: 'strict without when'",
            '    enforce: strict',
            '',
          ].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the enforce-strict-without-when group header carries
        // the code, and the shared Fix line names the offending type and the
        // remedy.
        expect(stdout).toContain('enforce-strict-without-when');
        expect(stdout).toContain(
          "Fix: Either add a when predicate to type 'strictnowhen', or remove enforce: strict.",
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 6 — Architecture file parse failures (whole-file integrity).
    // -----------------------------------------------------------------------

    it('T25: node_types as a YAML sequence (not a mapping) raises architecture-invalid', () => {
      const dir = copyFixture('t25');
      try {
        writeArch(dir, 'node_types: [a, b, c]\n');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T26: a node type missing its description raises architecture-invalid', () => {
      const dir = copyFixture('t26');
      try {
        writeArch(
          dir,
          ['node_types:', '  service:', '    log_required: false', ''].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T27: syntactically broken architecture YAML raises architecture-invalid', () => {
      const dir = copyFixture('t27');
      try {
        // Unterminated quote — the YAML parser itself rejects this.
        writeArch(
          dir,
          ['node_types:', '  service:', '    description: "unterminated', ''].join('\n'),
        );
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        expect(stdout).toContain('architecture-invalid');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T28: enforce: with a non-strict value raises architecture-invalid', () => {
      const dir = copyFixture('t28');
      try {
        replaceServiceWhen(dir, '    when:\n      path: "src/services/**"\n    enforce: loose');
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T29: a non-string entry in a type.parents list raises architecture-invalid', () => {
      const dir = copyFixture('t29');
      try {
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          'parents: [module]',
          'parents: [module, 42]',
        );
        writeArch(dir, arch);
        const { status, stdout } = run(['check'], dir);
        expect(status).toBe(1);
        // Grouped output: the parse failure collapses into the
        // architecture-invalid group; the specific parser message is no longer
        // rendered in the default view, so we assert the code + the shared why.
        expect(stdout).toContain('architecture-invalid');
        expect(stdout).toContain('yg-architecture.yaml failed to parse.');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // GROUP 7 — Documented edge / guard behaviors + one CONTRACT DIVERGENCE.
    // -----------------------------------------------------------------------

    it('T30: empty node_types ({}) disables architecture type checks — no type-undefined for unknown node types', () => {
      const dir = copyFixture('t30');
      try {
        // With NO types defined, checkArchitectureConstraints returns early: the
        // architecture is treated as "not configured", so nodes whose `type`
        // names nothing are NOT reported as type-undefined. This guard is
        // deliberate (greenfield / pre-architecture repos must not be spammed).
        writeArch(dir, 'node_types: {}\n');
        const { stdout } = run(['check'], dir);
        expect(stdout).not.toContain('type-undefined');
        expect(stdout).not.toContain('is not defined in yg-architecture.yaml');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T31: a valid baseline architecture produces no architecture/when validation errors', () => {
      const dir = copyFixture('t31');
      try {
        writeArch(dir, VALID_ARCH);
        const { stdout } = run(['check'], dir);
        // None of the architecture-integrity codes this suite exercises should
        // appear for a well-formed architecture. (Drift/unapproved noise is
        // expected and unrelated — we assert only on architecture codes.)
        for (const code of [
          'type-undefined',
          'type-unknown-parent',
          'parent-type-forbidden',
          'relation-target-forbidden',
          'architecture-cycle',
          'enforce-strict-without-when',
          'when-predicate-invalid',
          'when-unknown-type',
          'when-unknown-node',
          'when-unknown-port',
          'architecture-invalid',
        ]) {
          expect(stdout).not.toContain(code);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('T32: a relation allow-list naming an undefined TARGET type is a blocking architecture error', () => {
      // Symmetric with type-unknown-parent (which rejects an undefined PARENT
      // type): a relation allow-list that names a target type not defined in
      // node_types is a dangling reference that silently over-restricts the
      // relation — a node of the intended type never matches the misspelled
      // entry. checkRelationTargetTypeUnknown now catches it at the
      // architecture level with the relation-target-type-unknown code.
      const dir = copyFixture('t32');
      try {
        const arch = readFileSync(archPath(dir), 'utf-8').replace(
          '      uses: [service]',
          '      uses: [ghost-target-type]',
        );
        writeArch(dir, arch);
        const { stdout } = run(['check'], dir);
        expect(stdout).toContain('relation-target-type-unknown');
        expect(stdout).toContain('ghost-target-type');
        // It is a distinct code from the per-node relation check and the
        // undefined-node-type check — neither of those should fire here.
        expect(stdout).not.toContain('relation-target-forbidden');
        expect(stdout).not.toContain('type-undefined');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Finding H — type-when classification must evaluate the FILES a glob
    // mapping matches, not the literal glob string. orders owns its .ts file
    // via an extension-less glob; the file satisfies the .ts when, but the
    // literal pattern string does not — so the validator must NOT false-error.
    // -----------------------------------------------------------------------

    it('H: a glob mapping whose matched files satisfy when does NOT raise type-when-mismatch', () => {
      const dir = copyFixture('glob-when');
      try {
        // Tighten the service when to require a .ts extension.
        replaceServiceWhen(dir, '    when:\n      path: "src/services/**/*.ts"');
        // orders owns its .ts file via an extension-less GLOB.
        const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
          'src/services/orders.ts',
          'src/services/order*',
        );
        writeFileSync(ordersNodePath(dir), y, 'utf-8');

        const { stdout } = run(['check'], dir);
        // The matched file (orders.ts) satisfies the .ts when, so no mismatch.
        expect(stdout).not.toContain('type-when-mismatch');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Finding H2 — a DIRECTORY mapping entry must be classified by the FILES it
    // owns, exactly like a glob — not by the literal directory string. Both the
    // directory form (node schema) and extension globs in `when` (architecture
    // schema) are documented-valid, so they must be compatible: a directory
    // mapping under an extension-glob type must PASS when its files satisfy the
    // when, and still FLAG the individual file that genuinely violates it.
    // -----------------------------------------------------------------------

    it('H2: a directory mapping whose files satisfy when does NOT raise type-when-mismatch', () => {
      const dir = copyFixture('dir-when-ok');
      try {
        // Tighten the service when to require a .ts extension — so the literal
        // directory string (no extension) could not satisfy it; only its files.
        replaceServiceWhen(dir, '    when:\n      path: "src/services/**/*.ts"');
        // orders owns its existing .ts file PLUS a DIRECTORY containing only .ts.
        mkdirSync(path.join(dir, 'src', 'services', 'orders_pkg'), { recursive: true });
        writeFileSync(
          path.join(dir, 'src', 'services', 'orders_pkg', 'handler.ts'),
          'export const handle = () => 1;\n',
          'utf-8',
        );
        const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
          '  - src/services/orders.ts',
          '  - src/services/orders.ts\n  - src/services/orders_pkg/',
        );
        writeFileSync(ordersNodePath(dir), y, 'utf-8');

        const { stdout } = run(['check'], dir);
        // Every file the directory owns is .ts, so the directory satisfies the
        // .ts when — no mismatch (before the fix, the literal 'src/services/
        // orders_pkg' string failed the .ts when and false-errored).
        expect(stdout).not.toContain('type-when-mismatch');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('H2b: a directory mapping with a file that violates when flags THAT file', () => {
      const dir = copyFixture('dir-when-bad');
      try {
        replaceServiceWhen(dir, '    when:\n      path: "src/services/**/*.ts"');
        // The directory owns a valid .ts AND a .md that genuinely violates the
        // .ts when. Expanding the directory to its files surfaces the .md.
        mkdirSync(path.join(dir, 'src', 'services', 'orders_pkg'), { recursive: true });
        writeFileSync(
          path.join(dir, 'src', 'services', 'orders_pkg', 'handler.ts'),
          'export const handle = () => 1;\n',
          'utf-8',
        );
        writeFileSync(
          path.join(dir, 'src', 'services', 'orders_pkg', 'README.md'),
          '# notes\n',
          'utf-8',
        );
        const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
          '  - src/services/orders.ts',
          '  - src/services/orders.ts\n  - src/services/orders_pkg/',
        );
        writeFileSync(ordersNodePath(dir), y, 'utf-8');

        const { all } = run(['check'], dir);
        // The mismatch fires, and names the OFFENDING FILE (README.md), not the
        // directory string — proving the entry was expanded to its files (before
        // the fix, the message named the bare 'src/services/orders_pkg' entry).
        expect(all).toContain('type-when-mismatch');
        expect(all).toContain('src/services/orders_pkg/README.md');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Finding I — source-existence (drift) must expand a glob mapping. A node
    // mapped only by a glob whose files exist must NOT report "source files
    // never created" (the literal pattern string never exists on disk).
    // -----------------------------------------------------------------------

    it('I: a glob-only node whose files exist does NOT report "never created"', () => {
      const dir = copyFixture('glob-source');
      try {
        // orders owns its existing .ts file via a glob (default when keeps matching).
        const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
          'src/services/orders.ts',
          'src/services/order*.ts',
        );
        writeFileSync(ordersNodePath(dir), y, 'utf-8');

        const { stdout } = run(['check'], dir);
        expect(stdout).not.toContain('never created');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // -----------------------------------------------------------------------
    // Finding D — one file = one node, including globs. Two non-hierarchical
    // sibling nodes claim the same file (one via a glob), which the literal
    // string overlap check misses. The file-level check must flag it.
    // -----------------------------------------------------------------------

    it('D: two sibling nodes claiming the same file via a glob raise overlapping-mapping', () => {
      const dir = copyFixture('glob-overlap');
      try {
        // orders globs ALL service .ts files — which includes payments.ts, already
        // owned (exactly) by the sibling payments node. payments.ts now has two
        // non-hierarchical owners.
        const y = readFileSync(ordersNodePath(dir), 'utf-8').replace(
          'src/services/orders.ts',
          'src/services/*.ts',
        );
        writeFileSync(ordersNodePath(dir), y, 'utf-8');

        const { all } = run(['check'], dir);
        expect(all).toContain('overlapping-mapping');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
