import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// MULTI-LEVEL / TRANSITIVE cascade + the `when` relation-atom MATRIX. Existing
// suites stop at a 2-level hierarchy and only gate `when` on calls/consumes_port
// (cli-channels: ch2/ch4 + status max; cli-channels-extended: ch2/ch4/ch5/ch7
// `when` with node/descendants/relations.calls; cli-conditional-when: own-channel
// `when`; cli-implies: status_inherit own-default with an advisory default only).
//
// This suite fills three gaps, ALL deterministic (zero LLM cost):
//   A. GRANDCHILD generations (3+ levels): a ch4 ancestor-TYPE default and a ch2
//      ancestor-NODE aspect declared 2 generations up still reach the leaf —
//      attribution names the actual carrying ancestor, enforcement follows.
//   B. The `when` relation-atom MATRIX never gated before: uses / extends /
//      implements / emits / listens `target_type`, each include AND exclude.
//   C. CROSS-CHANNEL AND-composition (an aspect's GLOBAL `when` AND an
//      attach-site `when` on the same path both apply), and status_inherit
//      own-default's DIVERGENCE from strictest (own-default anchors the implied
//      aspect to its OWN default regardless of the implier's status).
//
// HERMETIC: each test builds its graph in a fresh mkdtemp and rmSync's in a
// finally. The reviewer points at a guaranteed-dead loopback (port 1 never
// listens). No network, no clock/random in assertions, no committed fixture
// mutated. Harness duplicated from cli-deterministic-lifecycle.test.ts
// (self-contained).
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = path.join(__dirname, '../..');
const BIN_PATH = path.join(CLI_ROOT, 'dist', 'bin.js');

const distExists = existsSync(BIN_PATH);

// Port 1 never has a listener on any machine, so the LLM reviewer path is always
// unreachable with no reliance on a real endpoint being present or absent.
const DEAD_ENDPOINT = 'http://127.0.0.1:1';

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

const CONFIG = [
  'version: "5.2.0"',
  'quality:',
  '  max_direct_relations: 20',
  'reviewer:',
  '  default: standard',
  '  tiers:',
  '    standard:',
  '      provider: ollama',
  '      consensus: 1',
  '      config:',
  '        model: "qwen2.5-coder:0.5b"',
  `        endpoint: "${DEAD_ENDPOINT}"`,
  '',
].join('\n');

/**
 * Architecture for the multi-level graph: `module` is organizational (parent
 * only, no mapping), `service` is the classifying leaf type (maps src/**) and
 * may declare every relation type to another service so the relation-atom matrix
 * is reachable in BOTH the structural and the event families. `moduleAspects`
 * are spliced under the `module` type body (channel-4 ancestor-type defaults).
 *
 * Every `service` carries the benign `base-ok` channel-3 type default — a
 * zero-violation deterministic aspect. It guarantees every leaf has at least one
 * effective ENFORCED aspect, so `yg check --approve` can always record a verdict
 * even in the exclude scenarios where the aspect under test is `when`-filtered
 * out (a node with no effective enforced aspect would have nothing to fill).
 * It never contributes a violation, so it does not interfere with any assertion.
 */
function architecture(moduleAspects: string[]): string {
  return [
    'node_types:',
    '  module:',
    '    description: Organizational grouping — parent only, no file mapping.',
    '    log_required: false',
    ...moduleAspects.map((l) => `    ${l}`),
    '  service:',
    '    description: A leaf service mapping a single source file.',
    '    log_required: false',
    '    when:',
    '      path: "src/**"',
    '    parents: [module]',
    '    aspects:',
    '      - base-ok',
    '    relations:',
    '      uses: [service]',
    '      extends: [service]',
    '      implements: [service]',
    '      emits: [service]',
    '      listens: [service]',
    '',
  ].join('\n');
}

type NodeSpec = {
  /** path under model/, e.g. "root/sub/leaf" */
  pathUnder: string;
  type: string;
  /** raw aspect attach entries (already indented two spaces under `aspects:`) */
  aspects?: string[];
  /** raw relation block lines (already indented two spaces under `relations:`) */
  relations?: string[];
  /** repo-relative source file to map + its content (service leaves only) */
  source?: { file: string; content: string };
};

/**
 * Build a complete graph in a fresh temp dir. The architecture is supplied
 * verbatim so each test controls type-level (channel 3/4) defaults. Every node
 * spec becomes a model/<path>/yg-node.yaml; any `source` is written under the
 * repo root and added to that node's mapping.
 */
function buildGraph(
  label: string,
  archYaml: string,
  nodes: NodeSpec[],
  aspects: { id: string; status: string; literal?: string; yaml?: string }[],
): string {
  const dir = mkdtempSync(path.join(tmpdir(), `yg-mlvl-${label}-`));
  const ygRoot = path.join(dir, '.yggdrasil');
  mkdirSync(ygRoot, { recursive: true });
  writeFileSync(path.join(ygRoot, 'yg-config.yaml'), CONFIG, 'utf-8');
  writeFileSync(path.join(ygRoot, 'yg-architecture.yaml'), archYaml, 'utf-8');

  for (const n of nodes) {
    const nodeDir = path.join(ygRoot, 'model', ...n.pathUnder.split('/'));
    mkdirSync(nodeDir, { recursive: true });
    const lines = [
      `name: ${n.pathUnder.split('/').pop()}`,
      `description: Node ${n.pathUnder}.`,
      `type: ${n.type}`,
    ];
    if (n.aspects && n.aspects.length > 0) lines.push('aspects:', ...n.aspects);
    if (n.relations && n.relations.length > 0) lines.push('relations:', ...n.relations);
    if (n.source) {
      lines.push('mapping:', `  - ${n.source.file}`);
      const srcPath = path.join(dir, ...n.source.file.split('/'));
      mkdirSync(path.dirname(srcPath), { recursive: true });
      writeFileSync(srcPath, n.source.content, 'utf-8');
    }
    lines.push('');
    writeFileSync(path.join(nodeDir, 'yg-node.yaml'), lines.join('\n'), 'utf-8');
  }

  // Always materialize the benign `base-ok` channel-3 service-type default so
  // every leaf has a recordable ENFORCED aspect (see architecture() comment).
  const allAspects = [
    ...aspects,
    { id: 'base-ok', status: 'enforced' } as (typeof aspects)[number],
  ];
  for (const a of allAspects) {
    const aspectDir = path.join(ygRoot, 'aspects', a.id);
    mkdirSync(aspectDir, { recursive: true });
    writeFileSync(
      path.join(aspectDir, 'yg-aspect.yaml'),
      a.yaml ??
        [
          `name: ${a.id}`,
          `description: Deterministic aspect ${a.id}.`,
          'reviewer:',
          '  type: deterministic',
          `status: ${a.status}`,
          '',
        ].join('\n'),
      'utf-8',
    );
    // A literal-flagging check (arity-1 `ctx`, as the runner requires) when a
    // literal is given; otherwise a zero-violation check.
    const body = a.literal
      ? [
          'export function check(ctx) {',
          '  const violations = [];',
          '  for (const file of ctx.files) {',
          '    const lines = file.content.split("\\n");',
          '    for (let i = 0; i < lines.length; i++) {',
          `      if (lines[i].includes(${JSON.stringify(a.literal)})) {`,
          `        violations.push({ file: file.path, line: i + 1, column: 0, message: ${JSON.stringify(`${a.literal} token found.`)} });`,
          '      }',
          '    }',
          '  }',
          '  return violations;',
          '}',
          '',
        ]
      : ['export function check(ctx) {', '  return [];', '}', ''];
    writeFileSync(path.join(aspectDir, 'check.mjs'), body.join('\n'), 'utf-8');
  }
  return dir;
}

const srcFile = (dir: string, rel: string) => path.join(dir, ...rel.split('/'));
const plantBanned = (dir: string, rel: string) =>
  appendFileSync(srcFile(dir, rel), '\n// BANNED token here\n');

// The stable heading `yg context` prints for an effective aspect. Present iff
// the aspect is effective; wholly absent when `when` filters it out.
const EFF = (status: string) => `no-banned-word [${status}]`;

// A leaf service that maps a clean source file. The default banned-word aspect
// flags `BANNED`; the leaf body never contains it so a fresh approve is clean.
function leaf(pathUnder: string, extra: Partial<NodeSpec> = {}): NodeSpec {
  const fileName = pathUnder.replace(/\//g, '-');
  return {
    pathUnder,
    type: 'service',
    source: { file: `src/${fileName}.ts`, content: `export const x = 1;\n` },
    ...extra,
  };
}

const BANNED_ASPECT = (status: string) => ({
  id: 'no-banned-word',
  status,
  literal: 'BANNED',
});

describe.skipIf(!distExists)(
  'CLI E2E — multi-level transitive cascade + `when` relation-atom matrix',
  () => {
    // =====================================================================
    // GROUP A — GRANDCHILD generations. A ch4 ancestor-TYPE default and a ch2
    // ancestor-NODE aspect declared 2 generations above the leaf still reach
    // it. The attribution names the actual carrying ancestor, and enforcement
    // follows the inheritance across the extra generation.
    // =====================================================================

    it('A1: ch4 ancestor-TYPE default reaches a GRANDCHILD (module→module→service) — attributed to "parent (type: module)", enforced approve refuses', () => {
      const dir = buildGraph(
        'a1-ch4-grandchild',
        architecture(['aspects:', '  - no-banned-word']),
        [
          { pathUnder: 'root', type: 'module' },
          { pathUnder: 'root/sub', type: 'module' },
          leaf('root/sub/leaf'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        // The type-default declared on `module` reaches the leaf 2 levels down.
        const ctx = run(['context', '--node', 'root/sub/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));
        expect(ctx.stdout).toContain('Source: inherited from parent (type: module)');

        // Enforcement crosses the extra generation: clean passes, BANNED refuses.
        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-sub-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        expect(refused.all).toContain('no-banned-word');
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/sub/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/sub/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('A2: ch2 ancestor-NODE aspect declared on the GRANDPARENT reaches the leaf — attribution names the grandparent (not the immediate parent), enforced approve refuses', () => {
      const dir = buildGraph(
        'a2-ch2-grandchild',
        architecture([]),
        [
          // Aspect attached on the GRANDPARENT `root` node only.
          { pathUnder: 'root', type: 'module', aspects: ['  - no-banned-word'] },
          { pathUnder: 'root/sub', type: 'module' },
          leaf('root/sub/leaf'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        const ctx = run(['context', '--node', 'root/sub/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));
        // The label names the ACTUAL carrying ancestor — the grandparent `root`,
        // 2 levels up — not the immediate parent `root/sub`.
        expect(ctx.stdout).toContain("Source: inherited from parent 'root'");
        expect(ctx.stdout).not.toContain("inherited from parent 'root/sub'");

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-sub-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        expect(refused.all).toContain('no-banned-word');
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/sub/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/sub/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('A3: a ch2 aspect on the grandparent reaches EVERY descendant generation (the grandparent module node itself, the middle module, and the leaf)', () => {
      const dir = buildGraph(
        'a3-ch2-all-generations',
        architecture([]),
        [
          { pathUnder: 'root', type: 'module', aspects: ['  - no-banned-word'] },
          { pathUnder: 'root/sub', type: 'module' },
          leaf('root/sub/leaf'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        // Own declaration on the grandparent itself (channel 1 there).
        const onRoot = run(['context', '--node', 'root'], dir);
        expect(onRoot.stdout).toContain(EFF('enforced'));
        expect(onRoot.stdout).toContain('Source: own declaration');

        // Inherited one level down (the middle module).
        const onSub = run(['context', '--node', 'root/sub'], dir);
        expect(onSub.stdout).toContain(EFF('enforced'));
        expect(onSub.stdout).toContain("Source: inherited from parent 'root'");

        // Inherited two levels down (the leaf) — same carrying ancestor.
        const onLeaf = run(['context', '--node', 'root/sub/leaf'], dir);
        expect(onLeaf.stdout).toContain(EFF('enforced'));
        expect(onLeaf.stdout).toContain("Source: inherited from parent 'root'");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // =====================================================================
    // GROUP B — `when` relation-atom MATRIX. A ch2 attach on the grandparent
    // is gated on a `relations.<type>.target_type` atom evaluated against the
    // LEAF's OWN relations. Each relation type gets an include (the leaf
    // declares the relation → TRUE) and an exclude (the leaf does not → FALSE).
    // uses / extends / implements are structural; emits / listens are event
    // (paired with a sibling to satisfy the pairing check).
    // =====================================================================

    // --- B-structural: uses / extends / implements ---

    function structuralAtom(label: string, relType: string): string {
      // Leaf declares `<relType> -> sibling (service)`. ch2 attach gated on
      // that exact atom. Two service leaves: `peer` is the relation target.
      const dir = buildGraph(
        label,
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: [
              '  - id: no-banned-word',
              '    when:',
              '      relations:',
              `        ${relType}:`,
              '          target_type: service',
            ],
          },
          leaf('root/leaf', {
            relations: ['  - target: root/peer', `    type: ${relType}`],
          }),
          leaf('root/peer'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      return dir;
    }

    it('B1: `when: relations.uses.target_type=service` — TRUE on the leaf that USES a service → effective + enforced refuse', () => {
      const dir = structuralAtom('b1-uses', 'uses');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));
        expect(ctx.stdout).toContain("Source: inherited from parent 'root'");

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        expect(refused.all).toContain('no-banned-word');
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('B2: `when: relations.extends.target_type=service` — TRUE on the leaf that EXTENDS a service → effective + enforced refuse', () => {
      const dir = structuralAtom('b2-extends', 'extends');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('B3: `when: relations.implements.target_type=service` — TRUE on the leaf that IMPLEMENTS a service → effective + enforced refuse', () => {
      const dir = structuralAtom('b3-implements', 'implements');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('B4: structural atoms EXCLUDE — a leaf gated on `extends.target_type=service` that declares only a `uses` relation is filtered out; the SAME BANNED token approves clean', () => {
      // The leaf USES a service but the gate is on EXTENDS → the relation-type
      // filter sees no extends relation → predicate FALSE → aspect excluded.
      const dir = buildGraph(
        'b4-structural-exclude',
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: [
              '  - id: no-banned-word',
              '    when:',
              '      relations:',
              '        extends:',
              '          target_type: service',
            ],
          },
          leaf('root/leaf', {
            relations: ['  - target: root/peer', '    type: uses'],
          }),
          leaf('root/peer'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).not.toContain('no-banned-word');

        // The gate is real — a BANNED token that refuses when the atom is TRUE
        // (B2) fills clean here because the wrong relation type is present.
        plantBanned(dir, 'src/root-leaf.ts');
        const fill = run(['check', '--approve'], dir);
        expect(fill.status).toBe(0);
        expect(fill.stdout).toContain('yg check: PASS');
        // The gate excludes the rule from every node, so the BANNED token plants
        // no refusal. Attached yet effective on zero nodes, the rule is correctly
        // surfaced by the dead-attach linter as a non-blocking warning — PASS holds.
        expect(fill.all).not.toContain('— refused');
        expect(fill.all).toContain('aspect-effective-nowhere');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('B5: structural atom target_type MISMATCH excludes — `uses.target_type=module` is FALSE when the leaf uses a SERVICE (right relation type, wrong target type)', () => {
      const dir = buildGraph(
        'b5-target-type-mismatch',
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: [
              '  - id: no-banned-word',
              '    when:',
              '      relations:',
              '        uses:',
              '          target_type: module',
            ],
          },
          // The leaf uses a SERVICE peer, not a module → target_type mismatch.
          leaf('root/leaf', {
            relations: ['  - target: root/peer', '    type: uses'],
          }),
          leaf('root/peer'),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).not.toContain('no-banned-word');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // --- B-event: emits / listens (paired) ---

    it('B6: `when: relations.emits.target_type=service` — TRUE on the EMITTER (refuses), FALSE on the LISTENER which only listens (passes the same BANNED token)', () => {
      // leaf emits→peer, peer listens→leaf (paired). Gate on emits.target_type.
      const dir = buildGraph(
        'b6-emits',
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: [
              '  - id: no-banned-word',
              '    when:',
              '      relations:',
              '        emits:',
              '          target_type: service',
            ],
          },
          leaf('root/leaf', {
            relations: [
              '  - target: root/peer',
              '    type: emits',
              '    event_name: thing.happened',
            ],
          }),
          leaf('root/peer', {
            relations: [
              '  - target: root/leaf',
              '    type: listens',
              '    event_name: thing.happened',
            ],
          }),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        // The emitter declares an emits→service → predicate TRUE → effective.
        const onLeaf = run(['context', '--node', 'root/leaf'], dir);
        expect(onLeaf.status).toBe(0);
        expect(onLeaf.stdout).toContain(EFF('enforced'));

        // The listener has no emits relation → predicate FALSE → excluded.
        const onPeer = run(['context', '--node', 'root/peer'], dir);
        expect(onPeer.status).toBe(0);
        expect(onPeer.stdout).not.toContain('no-banned-word');

        // Enforcement follows: identical BANNED token refuses the emitter,
        // passes the listener. A clean repo-wide fill records both; planting
        // BANNED in BOTH sources then refuses ONLY the emitter (where the gated
        // aspect is effective) — the listener holds no no-banned-word pair.
        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        plantBanned(dir, 'src/root-peer.ts');

        const fill = run(['check', '--approve'], dir);
        expect(fill.status).toBe(1);
        // Fill-time line names the refused deterministic pair on the emitter leaf.
        expect(fill.all).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(fill.all).toContain('- root/leaf');
        // The listener is gated out — no no-banned-word pair is dispatched or
        // refused for it.
        expect(fill.all).not.toContain('[det] no-banned-word on node:root/peer');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('B7: `when: relations.listens.target_type=service` — the COMPLEMENT: TRUE on the LISTENER, FALSE on the EMITTER (mirror of B6)', () => {
      const dir = buildGraph(
        'b7-listens',
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: [
              '  - id: no-banned-word',
              '    when:',
              '      relations:',
              '        listens:',
              '          target_type: service',
            ],
          },
          leaf('root/leaf', {
            relations: [
              '  - target: root/peer',
              '    type: emits',
              '    event_name: thing.happened',
            ],
          }),
          leaf('root/peer', {
            relations: [
              '  - target: root/leaf',
              '    type: listens',
              '    event_name: thing.happened',
            ],
          }),
        ],
        [BANNED_ASPECT('enforced')],
      );
      try {
        // The listener declares listens→service → TRUE.
        const onPeer = run(['context', '--node', 'root/peer'], dir);
        expect(onPeer.status).toBe(0);
        expect(onPeer.stdout).toContain(EFF('enforced'));

        // The emitter has no listens relation → FALSE.
        const onLeaf = run(['context', '--node', 'root/leaf'], dir);
        expect(onLeaf.status).toBe(0);
        expect(onLeaf.stdout).not.toContain('no-banned-word');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // =====================================================================
    // GROUP C — CROSS-CHANNEL AND-composition. An aspect's GLOBAL `when` (on
    // its yg-aspect.yaml) AND a per-attach-site `when` (on the ch2 entry) both
    // gate the SAME channel path — they combine via AND. Both true → effective;
    // either false → excluded.
    // =====================================================================

    const GLOBAL_WHEN_YAML = (whenBlock: string[]) =>
      [
        'name: no-banned-word',
        'description: Deterministic aspect no-banned-word.',
        'reviewer:',
        '  type: deterministic',
        'status: enforced',
        'when:',
        ...whenBlock,
        '',
      ].join('\n');

    function crossChannel(
      label: string,
      globalWhen: string[],
      attachWhen: string[],
      leafRelations: string[],
    ): string {
      return buildGraph(
        label,
        architecture([]),
        [
          {
            pathUnder: 'root',
            type: 'module',
            aspects: ['  - id: no-banned-word', ...attachWhen],
          },
          leaf('root/leaf', { relations: leafRelations }),
          leaf('root/peer'),
        ],
        [
          {
            id: 'no-banned-word',
            status: 'enforced',
            literal: 'BANNED',
            yaml: GLOBAL_WHEN_YAML(globalWhen),
          },
        ],
      );
    }

    // Global when: node.has_mapping=true (TRUE for the mapped leaf).
    // Attach when: relations.uses.target_type=service (TRUE when leaf uses peer).
    const GLOBAL_HAS_MAPPING = ['  node:', '    has_mapping: true'];
    const ATTACH_USES_SERVICE = [
      '    when:',
      '      relations:',
      '        uses:',
      '          target_type: service',
    ];
    const LEAF_USES_PEER = ['  - target: root/peer', '    type: uses'];

    it('C1: global `when` AND attach-site `when` BOTH true → aspect effective and enforced (the AND-composition passes)', () => {
      const dir = crossChannel(
        'c1-both-true',
        GLOBAL_HAS_MAPPING,
        ATTACH_USES_SERVICE,
        LEAF_USES_PEER,
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain(EFF('enforced'));

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.all).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.all).toContain('- root/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('C2: global `when` FALSE, attach-site `when` true → AND fails → aspect EXCLUDED (BANNED approves clean)', () => {
      // Global when gated on has_port:charge — the leaf declares no port → FALSE.
      const dir = crossChannel(
        'c2-global-false',
        ['  node:', '    has_port: charge'],
        ATTACH_USES_SERVICE,
        LEAF_USES_PEER,
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).not.toContain('no-banned-word');

        plantBanned(dir, 'src/root-leaf.ts');
        const fill = run(['check', '--approve'], dir);
        expect(fill.status).toBe(0);
        expect(fill.stdout).toContain('yg check: PASS');
        // The AND-composition excludes the rule from every node, so the BANNED
        // token plants no refusal. Attached yet effective on zero nodes, the rule
        // is surfaced by the dead-attach linter as a non-blocking warning.
        expect(fill.all).not.toContain('— refused');
        expect(fill.all).toContain('aspect-effective-nowhere');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('C3: global `when` true, attach-site `when` FALSE → AND fails → aspect EXCLUDED (BANNED approves clean)', () => {
      // Attach when gated on uses.target_type=module, but the leaf uses a
      // SERVICE → attach-site FALSE even though global has_mapping is TRUE.
      const dir = crossChannel(
        'c3-attach-false',
        GLOBAL_HAS_MAPPING,
        [
          '    when:',
          '      relations:',
          '        uses:',
          '          target_type: module',
        ],
        LEAF_USES_PEER,
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).not.toContain('no-banned-word');

        plantBanned(dir, 'src/root-leaf.ts');
        const fill = run(['check', '--approve'], dir);
        expect(fill.status).toBe(0);
        expect(fill.stdout).toContain('yg check: PASS');
        // The AND-composition excludes the rule from every node, so the BANNED
        // token plants no refusal. Attached yet effective on zero nodes, the rule
        // is surfaced by the dead-attach linter as a non-blocking warning.
        expect(fill.all).not.toContain('— refused');
        expect(fill.all).toContain('aspect-effective-nowhere');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    // =====================================================================
    // GROUP D — status_inherit DIVERGENCE (own-default vs strictest). cli-implies
    // covers own-default anchoring an ADVISORY default in isolation; these pin
    // the BRANCH that distinguishes own-default from strictest: own-default
    // anchors the implied aspect to its OWN default REGARDLESS of the implier's
    // status — reaching enforced when the aspect's own default is enforced, and
    // staying advisory when the implier is enforced. strictest, by contrast,
    // promotes to the implier's status.
    // =====================================================================

    function impliesGraph(
      label: string,
      implierStatus: string,
      impliedDefault: string,
      inherit: string,
    ): string {
      const implierYaml = [
        'name: implier',
        'description: The implier.',
        'reviewer:',
        '  type: deterministic',
        `status: ${implierStatus}`,
        'implies:',
        '  - id: no-banned-word',
        `    status_inherit: ${inherit}`,
        '',
      ].join('\n');
      return buildGraph(
        label,
        architecture([]),
        [
          { pathUnder: 'root', type: 'module' },
          leaf('root/leaf', { aspects: ['  - implier'] }),
          leaf('root/peer'),
        ],
        [
          { id: 'implier', status: implierStatus, yaml: implierYaml },
          BANNED_ASPECT(impliedDefault),
        ],
      );
    }

    it('D1: own-default with an ENFORCED own-default under an ADVISORY implier → implied stays ENFORCED (own-default reads the aspect default, not the implier) and a violation BLOCKS', () => {
      // Implier advisory, implied own-default enforced, own-default inherit.
      // strictest would give max(advisory, enforced)=enforced too — so the
      // distinguishing claim here is that own-default reaches ENFORCED at all
      // (it is NOT hardcoded to a weaker status), and BLOCKS at approve.
      const dir = impliesGraph('d1-own-enforced', 'advisory', 'enforced', 'own-default');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain('no-banned-word [enforced]');
        expect(ctx.stdout).toContain("implied by 'implier'");

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        expect(refused.stdout).toContain('no-banned-word');
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.stderr).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.stdout).toContain('- root/leaf');
        // The implier itself (no BANNED rule of its own) is satisfied — its fill
        // pair is approved, only the implied aspect refused.
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('D2: DIVERGENCE — same ENFORCED implier + ADVISORY own-default: own-default keeps it ADVISORY (non-blocking warning), strictest promotes it to ENFORCED (blocks)', () => {
      // own-default branch: implied stays at its own advisory default.
      const own = impliesGraph('d2-own-advisory', 'enforced', 'advisory', 'own-default');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], own);
        expect(ctx.status).toBe(0);
        expect(ctx.stdout).toContain('no-banned-word [advisory]');

        plantBanned(own, 'src/root-leaf.ts');
        const fill = run(['check', '--approve'], own);
        // Advisory → recorded but NON-blocking → fill exits 0.
        expect(fill.status).toBe(0);
        expect(fill.all).toContain('no-banned-word');
        expect(fill.all).toContain('advisory');

        const check = run(['check'], own);
        expect(check.status).toBe(0);
        expect(check.all).toContain('advisory');
      } finally {
        rmSync(own, { recursive: true, force: true });
      }

      // strictest branch on the IDENTICAL configuration: implied promotes to the
      // implier's enforced status → the same violation now BLOCKS.
      const strict = impliesGraph('d2-strictest', 'enforced', 'advisory', 'strictest');
      try {
        const ctx = run(['context', '--node', 'root/leaf'], strict);
        expect(ctx.status).toBe(0);
        // strictest promotes the advisory default up to the implier's enforced.
        expect(ctx.stdout).toContain('no-banned-word [enforced]');

        expect(run(['check', '--approve'], strict).status).toBe(0);
        plantBanned(strict, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], strict);
        expect(refused.status).toBe(1);
        expect(refused.stdout).toContain('no-banned-word');
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.stderr).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.stdout).toContain('- root/leaf');
      } finally {
        rmSync(strict, { recursive: true, force: true });
      }
    });

    it('D3: own-default coexists with max() — the same implied aspect ALSO directly attached enforced on the node still maxes to ENFORCED despite an advisory own-default implies edge', () => {
      // own-default would anchor the implied aspect to its advisory default, but
      // a SECOND channel (the node's own enforced attach) raises the effective
      // status via max(). Proves own-default is a floor on the implies edge, not
      // a cap across channels.
      const implierYaml = [
        'name: implier',
        'description: The implier.',
        'reviewer:',
        '  type: deterministic',
        'status: enforced',
        'implies:',
        '  - id: no-banned-word',
        '    status_inherit: own-default',
        '',
      ].join('\n');
      const dir = buildGraph(
        'd3-own-default-max',
        architecture([]),
        [
          { pathUnder: 'root', type: 'module' },
          // The node attaches BOTH the implier AND no-banned-word directly
          // (channel 1) with an explicit enforced bump.
          leaf('root/leaf', {
            aspects: [
              '  - implier',
              '  - id: no-banned-word',
              '    status: enforced',
            ],
          }),
          leaf('root/peer'),
        ],
        [
          { id: 'implier', status: 'enforced', yaml: implierYaml },
          // Own default advisory — own-default inherit would keep the implies
          // contribution advisory, but the ch1 enforced attach wins via max().
          BANNED_ASPECT('advisory'),
        ],
      );
      try {
        const ctx = run(['context', '--node', 'root/leaf'], dir);
        expect(ctx.status).toBe(0);
        // max(advisory-via-own-default-implies, enforced-via-own-attach)=enforced.
        expect(ctx.stdout).toContain('no-banned-word [enforced]');
        // No downgrade error — raising via a second channel is always legal.
        expect(ctx.all).not.toContain('aspect-status-downgrade');

        expect(run(['check', '--approve'], dir).status).toBe(0);
        plantBanned(dir, 'src/root-leaf.ts');
        const refused = run(['check', '--approve'], dir);
        expect(refused.status).toBe(1);
        // Fill-time line names the refused deterministic pair on the leaf node.
        expect(refused.stderr).toContain('[det] no-banned-word on node:root/leaf — refused');
        // The grouped error body lists the node under the enforced group.
        expect(refused.stdout).toContain('- root/leaf');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
